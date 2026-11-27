import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// O Claudio’s Club no Linux com systemd do usuário: cada parte num escopo próprio (`systemd-run --user --scope`).
// Em 27/11/2026 o systemd-oomd (que mata a FOLHA de cgroup mais pesada de app.slice quando a pressão de memória passa de 50% por 20 s) matou o
// escopo único do Club: vigia, servidor e todas as conversas, 234 processos de uma vez, e ninguém religou. Dividido, a folha mais pesada é uma conversa:
//   - o vigia (scripts/daemon.ts) sobe com ManagedOOMPreference=omit: o oomd nunca o escolhe por pressão de memória (por swap ele só respeita o
//     marcador em cgroup de root: aí o `omit` não vale; o vigia e o servidor são pequenos e raramente são o maior uso de swap);
//   - o servidor, com `avoid` (só se não houver outro candidato): se mesmo assim cair, o vigia o religa em segundos;
//   - cada conversa, no seu: `app-claudios-chat-<casa>-<hora>-<sessão>`.
// `OOMPolicy=continue` nos dois primeiros: sem ele, o kernel matar UM processo do escopo faz o systemd parar o escopo inteiro (padrão `stop`).
// `--scope` dá exec no comando (mesmo PID, mesma pasta, mesmo ambiente) e acha o programa pelo PATH de quem chama. Em Windows e macOS não há oomd nem
// cgroup: nada disto liga lá (o sistema mata por processo, e o vigia já religa o servidor).

export type OomPreference = 'omit' | 'avoid';

export interface ScopeSpec {
  /** Nome da unidade, sem o `.scope`. */
  unit: string;
  description: string;
  /** `--quiet` some com a linha "Running as unit: …" do stderr. As conversas não o usam: a linha é o aviso de que o escopo nasceu (ver `splitScopeMarker`). */
  quiet?: boolean;
  /** Como o oomd trata este escopo (ver o comentário do arquivo). */
  oom?: OomPreference;
  /** `OOMPolicy=continue`: o kernel matar um processo do escopo não derruba o resto dele. */
  keepOnOom?: boolean;
}

/** Os argumentos do `systemd-run` (até o `--`, sem ele). */
export function systemdRunArgs(spec: ScopeSpec): string[] {
  return [
    '--user',
    '--scope',
    ...(spec.quiet === false ? [] : ['--quiet']),
    '--collect',
    '--slice=app.slice',
    `--unit=${spec.unit}`,
    `--description=${spec.description}`,
    ...(spec.oom ? [`--property=ManagedOOMPreference=${spec.oom}`] : []),
    ...(spec.keepOnOom ? ['--property=OOMPolicy=continue'] : []),
  ];
}

/** O comando embrulhado no escopo. Só no Linux; fora dele (ou sem `enabled`) devolve o comando como veio. */
export function scopeCommand(cmd: string, args: string[], spec: ScopeSpec, opts: { platform?: NodeJS.Platform; enabled?: boolean } = {}): { cmd: string; args: string[] } {
  if ((opts.platform ?? process.platform) !== 'linux' || opts.enabled === false) return { cmd, args };
  return { cmd: 'systemd-run', args: [...systemdRunArgs(spec), '--', cmd, ...args] };
}

/** Quem pediu o escopo: a pasta de dados (MYCO_HOME) em seis letras. Duas instâncias do Club (a real e uma cópia de teste) dividem o gerenciador do usuário. */
export function homeTag(home: string): string {
  return createHash('sha1').update(path.resolve(home)).digest('hex').slice(0, 6);
}

/** A etiqueta desta instância (a mesma no servidor e no `daily`). */
export const HOME_TAG = homeTag(process.env.MYCO_HOME ?? path.join(os.homedir(), '.myco'));

const CHAT_UNIT = /^app-claudios-chat-([0-9a-f]{6})-([0-9a-z]+)-([0-9A-Za-z]*)\.scope$/;

/** Nome do escopo de uma conversa: etiqueta da casa, hora do lançamento (base 36: quem sobrou de um servidor anterior é achado pela hora) e o começo do id da sessão. */
export function chatUnit(tag: string, sessionId: string, stamp = Date.now()): string {
  return `app-claudios-chat-${tag}-${stamp.toString(36)}-${sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`;
}

/** Desmonta o nome de uma unidade de conversa; null se não for uma. */
export function parseChatUnit(unit: string): { tag: string; stamp: number; session: string } | null {
  const m = CHAT_UNIT.exec(unit);
  return m ? { tag: m[1]!, stamp: parseInt(m[2]!, 36), session: m[3]! } : null;
}

const MARKER = /^Running (?:scope )?as unit: .*(?:\r?\n|$)/m;

/**
 * O `systemd-run` (sem `--quiet`) escreve "Running as unit: <unidade>; invocation ID: …" no stderr DEPOIS de criar o escopo e ANTES de dar exec no
 * comando; falhando, escreve "Failed to …" e sai com 1, sem rodar nada. A linha é o único sinal de que o processo vai rodar dentro do escopo (a
 * escrita mudou de "Running scope as unit" para "Running as unit" entre versões: as duas valem). Devolve o texto sem ela, para o stderr do
 * claude não a trazer.
 */
export function splitScopeMarker(text: string): { marker: boolean; text: string } {
  return MARKER.test(text) ? { marker: true, text: text.replace(MARKER, '') } : { marker: false, text };
}

/** Pode usar o escopo? Liga só com `MYCO_CONV_SCOPE=1` (o vigia põe quando ele mesmo está num escopo) e depois de uma sonda bem-sucedida, repetida de tempos em tempos. */
export class ScopeSupport {
  private ok = false;
  private probing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly o: {
      enabled: boolean;
      probe: () => Promise<boolean>;
      intervalMs?: number;
      log?: (line: string) => void;
    },
  ) {}

  get usable(): boolean {
    return this.o.enabled && this.ok;
  }

  /** Primeira sonda agora e as seguintes a cada `intervalMs` (5 min). Sem `enabled`, não faz nada. */
  start(): void {
    if (!this.o.enabled || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.o.intervalMs ?? 5 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Uma sonda por vez; o resultado vale até a próxima. */
  async refresh(): Promise<void> {
    if (!this.o.enabled || this.probing) return;
    this.probing = true;
    try {
      const ok = await this.o.probe().catch(() => false);
      if (ok !== this.ok) this.o.log?.(ok ? 'escopo por conversa: ligado' : 'escopo por conversa: o systemd-run não respondeu; as conversas abrem sem escopo');
      this.ok = ok;
    } finally {
      this.probing = false;
    }
  }

  /** Um lançamento com escopo falhou: as próximas conversas abrem sem ele até a próxima sonda dar certo. */
  fail(reason: string): void {
    if (this.ok) this.o.log?.(`escopo por conversa desligado até a próxima sonda: ${reason}`);
    this.ok = false;
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
}
/** Roda um comando e devolve a saída; nunca rejeita (falha = code null). Os testes trocam. */
export type ScopeRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export const runCommand: ScopeRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : null) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

/** O systemd-run cria um escopo de verdade agora? (descartável, `true` dentro dele; qualquer falha ou demora = não) */
export async function probeScope(run: ScopeRunner = runCommand): Promise<boolean> {
  const spec: ScopeSpec = { unit: `app-claudios-sonda-${process.pid}-${Date.now().toString(36)}`, description: "Claudio's Club: sonda" };
  const c = scopeCommand('true', [], spec, { platform: 'linux' });
  return (await run(c.cmd, c.args, 5_000)).code === 0;
}

/** O estado desta instância: liga só com `MYCO_CONV_SCOPE=1` (o vigia põe quando ele mesmo está no escopo dele). */
export const conversationScopes = new ScopeSupport({
  enabled: process.platform === 'linux' && process.env.MYCO_CONV_SCOPE === '1',
  probe: () => probeScope(),
  log: (line) => console.log(`[chat] ${line}`),
});

/** O `claude` desta conversa embrulhado no escopo dela. */
export function conversationCommand(cmd: string, args: string[], sessionId: string, now = Date.now(), tag = HOME_TAG): { cmd: string; args: string[]; unit: string } {
  const unit = chatUnit(tag, sessionId, now);
  const c = scopeCommand(cmd, args, { unit, description: "Claudio's Club: conversa", quiet: false }, { platform: 'linux' });
  return { ...c, unit };
}

/** Os escopos de conversa desta casa que ainda existem. Sem systemctl (ou sem gerenciador do usuário), nenhum. */
export async function listChatScopes(tag = HOME_TAG, run: ScopeRunner = runCommand): Promise<string[]> {
  if (process.platform !== 'linux' && run === runCommand) return [];
  const r = await run('systemctl', ['--user', 'list-units', '--type=scope', '--all', '--plain', '--no-legend', '--no-pager', `app-claudios-chat-${tag}-*.scope`], 8_000);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((u) => parseChatUnit(u)?.tag === tag);
}

export interface ReapOptions {
  tag?: string;
  /** Só os lançados antes desta hora (epoch ms): o servidor que acabou de subir não encerra as conversas que ele mesmo abriu. Sem ele, todos. */
  olderThan?: number;
  /** Quanto esperar o SIGTERM antes do SIGKILL. */
  graceMs?: number;
  run?: ScopeRunner;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Encerra os escopos de conversa que sobraram (o servidor que os abriu morreu ou está saindo): SIGTERM, espera, SIGKILL no que ficou. Sem isto, uma
 * conversa sem dono seguiria o turno (gastando e rodando ferramentas) e a retomada abriria outro `claude` na mesma sessão: dois processos no mesmo
 * jsonl. Devolve as unidades que encontrou. Nunca lança.
 */
export async function reapChatScopes(o: ReapOptions = {}): Promise<string[]> {
  const tag = o.tag ?? HOME_TAG;
  const run = o.run ?? runCommand;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const mine = (units: string[]) =>
    units.filter((u) => {
      const p = parseChatUnit(u);
      return !!p && p.tag === tag && (o.olderThan === undefined || p.stamp < o.olderThan);
    });
  try {
    const found = mine(await listChatScopes(tag, run));
    if (!found.length) return [];
    const kill = (signal: string, units: string[]) => run('systemctl', ['--user', 'kill', `--signal=${signal}`, ...units], 8_000);
    await kill('SIGTERM', found);
    let left = found;
    for (let waited = 0; waited < (o.graceMs ?? 5_000) && left.length; waited += 250) {
      await sleep(250);
      const alive = new Set(await listChatScopes(tag, run));
      left = left.filter((u) => alive.has(u));
    }
    if (left.length) await kill('SIGKILL', left);
    o.log?.(`${found.length} conversa(s) sem servidor encerrada(s) (${found.join(', ')})${left.length ? `; ${left.length} só saiu(íram) com SIGKILL` : ''}`);
    return found;
  } catch (err) {
    o.log?.(`não consegui encerrar os escopos de conversa que sobraram: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** O escopo `.scope` em que este processo está agora (Linux, cgroup v2), ou null. */
export function currentScope(file = '/proc/self/cgroup'): string | null {
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('0::'));
    const last = line?.slice(3).split('/').pop() ?? '';
    return last.endsWith('.scope') ? last : null;
  } catch {
    return null;
  }
}

/** Este processo já está num escopo do Claudio’s Club (o do vigia, `app-claudios-<hora>.scope`, ou o do servidor)? */
export function inClubScope(scope = currentScope()): boolean {
  return !!scope && /^app-claudios-(?:\d+|server-\d+)\.scope$/.test(scope);
}
