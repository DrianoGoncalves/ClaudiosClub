import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const LIMITS = [
  { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-26T15:00:00.000Z' },
  { kind: 'seven_day', percentUsed: 61 },
]

const CONTEXT = { window: 200000, tokens: 1000, percent: 1 }

function engine(on: On, rateLimits = LIMITS) {
  // Nada fica abaixo do plugin: estes hooks fazem o papel do engine.
  const writes: { path: string; text: string }[] = []
  mock.env(on, { USERPROFILE: 'C:\\Users\\ana' })
  mock.clock(on, { now: Date.parse('2026-10-26T12:00:00.000Z') })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'abc' }))
  on('session.cwd', () => ({ value: 'C:\\www\\a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: CONTEXT, rateLimits, cost: { usd: 1.5 } } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  return writes
}

test('no início da sessão grava os limites da conta e o custo da sessão', async ($, on) => {
  const writes = engine(on)
  await $.session.start({ cwd: 'C:\\www\\a', surface: null, isInteractive: false })

  const usage = writes.find(w => w.path === 'C:\\Users\\ana\\.myco\\usage.json')
  expect(JSON.parse(usage!.text)).toEqual({
    updatedAt: '2026-10-26T12:00:00.000Z',
    sessionId: 'abc',
    limits: [
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-26T15:00:00.000Z' },
      { kind: 'seven_day', percentUsed: 61, resetsAt: null },
    ],
  })
  const session = writes.find(w => w.path === 'C:\\Users\\ana\\.myco\\sessions\\abc.json')
  expect(JSON.parse(session!.text)).toMatchObject({ sessionId: 'abc', cwd: 'C:\\www\\a', costUsd: 1.5 })
})

test('a cada medição com custo novo, atualiza a sessão', async ($, on) => {
  const writes = engine(on)
  await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, cost: { usd: 2.25 }, changed: ['cost'] })

  const session = writes.find(w => w.path.endsWith('sessions\\abc.json'))
  expect(JSON.parse(session!.text).costUsd).toBe(2.25)
})

test('medição só de contexto não grava nada', async ($, on) => {
  const writes = engine(on)
  await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, cost: { usd: 2 }, changed: ['context'] })
  expect(writes).toHaveLength(0)
})

test('sem limites (fora da assinatura) não sobrescreve o usage.json', async ($, on) => {
  const writes = engine(on, [])
  await $.session.start({ cwd: 'C:\\www\\a', surface: null, isInteractive: false })
  expect(writes.map(w => w.path)).toEqual(['C:\\Users\\ana\\.myco\\sessions\\abc.json'])
})
