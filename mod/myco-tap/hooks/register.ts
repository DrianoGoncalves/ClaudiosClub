import type { EngineInterface, Register } from 'claude-code'

// O MyCo roda fora do Claude Code e não enxerga os limites da conta: só a API de mods os tem.
// Este mod grava, a cada medição, os limites (5h/7d) e o custo da sessão em ~/.myco/,
// onde o servidor do MyCo só lê. Não desenha nada.

type Limit = { kind: string; percentUsed: number; resetsAt?: string }
type Cost = { usd: number }

export type UsageFile = {
  updatedAt: string
  sessionId: string
  limits: { kind: string; percentUsed: number; resetsAt: string | null }[]
}

export type SessionFile = UsageFile & { cwd: string; costUsd: number | null }

export const toLimits = (rows: readonly Limit[]): UsageFile['limits'] =>
  rows.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt ?? null }))

/** Junta caminhos com a barra que o diretório já usa (Windows ou não). */
export const join = (dir: string, name: string): string => {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}

async function mycoHome($: EngineInterface): Promise<string | null> {
  const override = await $.env.get('MYCO_HOME')
  if (override) return override
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? join(home, '.myco') : null
}

async function save($: EngineInterface, rateLimits: readonly Limit[], cost: Cost | undefined) {
  const dir = await mycoHome($)
  if (!dir) return
  const [sessionId, cwd, now] = await Promise.all([$.session.id(), $.session.cwd(), $.clock.now()])
  const limits = toLimits(rateLimits)
  const updatedAt = new Date(now).toISOString()

  // Os limites são da conta: qualquer sessão atualiza. Vazio (antes da 1ª resposta, ou fora
  // da assinatura) não apaga a leitura boa que outra sessão gravou.
  if (limits.length) {
    const usage: UsageFile = { updatedAt, sessionId, limits }
    await $.fs.write(join(dir, 'usage.json'), JSON.stringify(usage, null, 2) + '\n')
  }
  const session: SessionFile = { updatedAt, sessionId, cwd, limits, costUsd: cost?.usd ?? null }
  await $.fs.write(join(join(dir, 'sessions'), `${sessionId}.json`), JSON.stringify(session, null, 2) + '\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      const usage = await $.session.usage()
      await save($, usage.rateLimits, usage.cost)
    } catch {
      // gravar é um extra: nunca atrapalha o início da sessão
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('rateLimits') || e.changed.includes('cost')) {
      try {
        await save($, e.rateLimits, e.cost)
      } catch {
        // idem
      }
    }
    return result
  })
}
