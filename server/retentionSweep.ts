import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import type { AppConfig, LiveSession, Project, RetentionPreview, StaffProfile, Task } from '../shared/model';
import { encodeProjectDir } from './adapters/claude/paths';
import { codexRolloutMissing, rolloutStat } from './adapters/codex/rollout';
import { forgetSessions, readConfig, RetentionError, setRetentionDeleteEnabledAt } from './config';
import { retainedSessionIds } from './retention';
import { pruneRegistry, readSessionRegistry, removeFromRegistry, REGISTRY_FILE, type RegisteredSession } from './sessionsRegistry';
import { readTasksStrict } from './tasks';
import { writeAtomic } from './staff/store';

// Exclusão da retenção: apaga só conversas que o Claudio’s Club lançou, paradas além de `deleteAfterDays`. Roda só com a
// exclusão confirmada no navegador (`retentionDeleteEnabledAt`). Nunca toca em conversa do usuário fora do Club.
//
// Regra de segurança: toda leitura que PROTEGE (fichas, tarefas, ao vivo, em turno, despertadores, rollouts, config) é estrita.
// Falha numa leitura de proteção = o projeto inteiro sai da varredura (fichas/tarefas) ou a varredura aborta (o resto).
// Nunca se segue com a proteção vazia.

const DAY_MS = 86_400_000;
/** Id de conversa do Club (UUID). O `codex delete --force` também exige UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Um projeto com as fichas e a proteção já lidas (ver loadScopes). */
interface Scope {
  project: Project;
  staff: StaffProfile[];
  /** Conversas que não saem: a última de cada ficha e as de tarefa não concluída (ver retention.ts). */
  keep: Set<string>;
}

interface Pool {
  engine: 'claude' | 'codex';
  projectPath: string;
  cwd: string;
  /** O cwd veio do registro ou da ficha (sessão nova). Sem ele (ficha antiga) não se sabe onde está o transcript. */
  cwdKnown: boolean;
  staffId: string | null;
  createdAt: number;
  scope: Scope;
}

export interface Candidate {
  sessionId: string;
  engine: 'claude' | 'codex';
  projectPath: string;
  cwd: string;
  staffId: string | null;
  lastActivity: number;
  bytes: number;
}

export interface RetentionDeps {
  /** ~/.claude (os testes trocam). */
  claudeHome: string;
  /** ~/.myco/run (threadId do Codex e rollouts). */
  runDir: string;
  /** Arquivos (padrão: ~/.myco). Os testes trocam. */
  configFile?: string;
  registryFile?: string;
  /** Arquivo com o horário da última varredura (em MYCO_HOME); sem ele, não se guarda. */
  lastRunFile?: string;
  now?: () => number;
  projects: () => Promise<Project[]>;
  /** Fichas do projeto, lendo todas: lança se alguma não lê (ver listProjectStaffStrict). */
  staffOf: (project: Project) => Promise<StaffProfile[]>;
  /** Tarefas do projeto, lendo tudo (padrão readTasksStrict). Lança se não lê. */
  tasksOf?: (projectPath: string) => Promise<Task[]>;
  liveSessions: () => Promise<LiveSession[]>;
  /** Em turno (inclui mensagem na fila e conversas abertas ociosas) e com despertador/auto-continue pendente. Lança se não lê. */
  busy: () => Promise<Set<string>>;
  codex: { deleteThread: (threadId: string) => Promise<boolean> };
  /** Tira a conversa da ficha (store.dropStaffSessions). */
  dropStaffSession: (projectPath: string, staffId: string, sessionId: string) => Promise<boolean>;
  log?: (line: string) => void;
}

export interface SweepResult {
  ran: boolean;
  /** Por que não rodou (desligada, outra varredura em curso) ou parou (desligada no meio). */
  reason?: string;
  /** Abortou por leitura de proteção que falhou: nada mais foi apagado. */
  aborted?: string;
  deleted: { claude: string[]; codex: string[] };
  /** Não apagadas (falha do Codex, pasta recusada): a referência fica para o próximo ciclo. */
  failed: string[];
  /** Saíram da lista ao revalidar (voltaram a ter atividade, entraram em turno…). */
  skipped: number;
  /** Referências de conversas cujo arquivo já não existe que foram tiradas (ficha, config, registro). */
  pruned: number;
}

/** Caminho recusado (fora de ~/.claude/projects, link). Não apaga nada dessa conversa. */
class Refused extends Error {}

let sweeping = false;

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
/** `child` está dentro de `root` (ou é a própria pasta). */
function inside(child: string, root: string): boolean {
  const c = norm(path.resolve(child));
  const r = norm(path.resolve(root));
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** Entradas de uma pasta de transcripts de subagent (ausente = vazia). */
const entriesOf = (dir: string): Promise<Dirent[]> => fs.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);

/** Última atividade e tamanho de um transcript do Claude (só `stat`): o `.jsonl`, a pasta `<id>/subagents` e os arquivos dela. */
async function claudeActivity(claudeHome: string, cwd: string, id: string): Promise<{ last: number; bytes: number } | null> {
  const dir = path.join(claudeHome, 'projects', encodeProjectDir(path.resolve(cwd)));
  const st = await fs.stat(path.join(dir, `${id}.jsonl`)).catch(() => null);
  if (!st) return null;
  let last = st.mtimeMs;
  let bytes = st.size;
  const sub = path.join(dir, id, 'subagents');
  const subStat = await fs.stat(sub).catch(() => null);
  if (subStat) last = Math.max(last, subStat.mtimeMs);
  for (const e of await entriesOf(sub)) {
    if (!e.isFile()) continue;
    const f = await fs.stat(path.join(sub, e.name)).catch(() => null);
    if (f) {
      last = Math.max(last, f.mtimeMs);
      bytes += f.size;
    }
  }
  return { last, bytes };
}

/** O transcript do Claude sumiu? Leitura estrita: erro que não é "não existe" LANÇA (é leitura de proteção). */
async function claudeGone(claudeHome: string, cwd: string, id: string): Promise<boolean> {
  const file = path.join(claudeHome, 'projects', encodeProjectDir(path.resolve(cwd)), `${id}.jsonl`);
  const st = await fs.stat(file).then(
    (s) => s,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    },
  );
  return st === null;
}

/** Atividade atual de um candidato (stat de novo). Null = sumiu, ou (Codex) sem rollout/threadId. */
async function currentActivity(
  deps: RetentionDeps,
  c: Pick<Candidate, 'engine' | 'cwd' | 'sessionId'>,
  registryFile: string,
): Promise<{ last: number; bytes: number; threadId: string | null } | null> {
  if (c.engine === 'claude') {
    const a = await claudeActivity(deps.claudeHome, c.cwd, c.sessionId);
    return a ? { ...a, threadId: null } : null;
  }
  const st = await rolloutStat(deps.runDir, c.sessionId, registryFile);
  return st ? { last: st.mtime.getTime(), bytes: st.size, threadId: st.threadId } : null;
}

/**
 * Projetos com fichas e tarefas lidas por inteiro. Projeto em que qualquer leitura falha sai da varredura (o log diz qual e por quê):
 * sem as fichas e as tarefas dele, a proteção estaria incompleta.
 */
async function loadScopes(deps: RetentionDeps): Promise<{ scopes: Scope[]; skipped: string[] }> {
  const scopes: Scope[] = [];
  const skipped: string[] = [];
  for (const project of (await deps.projects()).filter((p) => p.exists)) {
    try {
      const staff = await deps.staffOf(project);
      const tasks = await (deps.tasksOf ?? readTasksStrict)(project.path);
      scopes.push({ project, staff, keep: retainedSessionIds(staff, tasks) });
    } catch (err) {
      skipped.push(project.name);
      deps.log?.(`[retencao] projeto ${project.id} pulado: não consegui ler fichas ou tarefas (${msg(err)})`);
    }
  }
  return { scopes, skipped };
}

/**
 * As conversas que a varredura considera: o registro e as fichas. Entrada do registro com ficha que não carregou fica de fora
 * (não dá para saber se é a última dela); entrada de projeto pulado também.
 */
function poolOf(scopes: Scope[], registry: Map<string, RegisteredSession>): Map<string, Pool> {
  const scopeOf = (projectPath: string) => scopes.find((s) => norm(path.resolve(s.project.path)) === norm(path.resolve(projectPath)));
  const pool = new Map<string, Pool>();
  for (const [id, e] of registry) {
    const scope = scopeOf(e.projectPath);
    if (!scope) continue;
    if (e.staffId && !scope.staff.some((s) => s.id === e.staffId)) continue;
    pool.set(id, { engine: e.engine, projectPath: scope.project.path, cwd: e.cwd, cwdKnown: true, staffId: e.staffId ?? null, createdAt: Date.parse(e.createdAt), scope });
  }
  for (const scope of scopes) {
    for (const s of scope.staff) {
      for (const entry of s.sessions) {
        if (pool.has(entry.id)) continue;
        const engine = (entry.fallback?.engine ?? s.engine) === 'codex' ? 'codex' : 'claude';
        pool.set(entry.id, {
          engine,
          projectPath: scope.project.path,
          cwd: entry.cwd ?? scope.project.path,
          cwdKnown: entry.cwd !== undefined,
          staffId: s.id,
          createdAt: Date.parse(entry.startedAt),
          scope,
        });
      }
    }
  }
  return pool;
}

const aliveIds = (live: LiveSession[]) => new Set(live.filter((l) => l.alive).map((l) => l.sessionId));

/** Candidatos: velhos (criação e atividade antes do corte), fora do ao vivo, do turno e da proteção. */
async function candidatesOf(deps: RetentionDeps, pool: Map<string, Pool>, cutoff: number, registryFile: string): Promise<Candidate[]> {
  const alive = aliveIds(await deps.liveSessions());
  const busy = await deps.busy();
  const out: Candidate[] = [];
  for (const [id, c] of pool) {
    // A atividade nunca é anterior à criação: criada depois do corte, não é candidata (NaN também não passa).
    if (!(c.createdAt < cutoff)) continue;
    if (alive.has(id) || busy.has(id) || c.scope.keep.has(id)) continue;
    if (c.engine === 'claude') {
      const a = await claudeActivity(deps.claudeHome, c.cwd, id);
      if (!a || a.last >= cutoff) continue;
      out.push({ sessionId: id, engine: 'claude', projectPath: c.projectPath, cwd: c.cwd, staffId: c.staffId, lastActivity: a.last, bytes: a.bytes });
    } else {
      // Só aqui o Codex é lido (depois de todos os filtros): sem candidato Codex, o CLI não é chamado.
      const st = await rolloutStat(deps.runDir, id, registryFile);
      // O CLI só apaga por UUID; threadId fora disso é pulado (nunca adivinhar).
      if (!st || st.mtime.getTime() >= cutoff || !UUID.test(st.threadId)) continue;
      out.push({ sessionId: id, engine: 'codex', projectPath: c.projectPath, cwd: c.cwd, staffId: c.staffId, lastActivity: st.mtime.getTime(), bytes: st.size });
    }
  }
  return out;
}

/**
 * Apaga o transcript do Claude: primeiro a pasta `<id>/` (subagents, título), por último o `<id>.jsonl`. Só dentro de
 * ~/.claude/projects e sem seguir link.
 */
async function deleteClaudeTranscript(claudeHome: string, c: Pick<Candidate, 'sessionId' | 'cwd'>): Promise<void> {
  if (!UUID.test(c.sessionId)) throw new Refused('id fora do formato');
  const root = path.join(claudeHome, 'projects');
  const rootReal = await fs.realpath(root).catch(() => null);
  if (!rootReal) return; // sem pasta de projetos, não há transcript a apagar
  const dir = path.join(root, encodeProjectDir(path.resolve(c.cwd)));
  const dirStat = await fs.lstat(dir).catch(() => null);
  if (!dirStat) return; // a pasta do projeto já não existe: a conversa também não
  if (dirStat.isSymbolicLink()) throw new Refused('pasta do projeto é link: não apago fora de ~/.claude/projects');
  const dirReal = await fs.realpath(dir);
  if (!inside(dirReal, rootReal)) throw new Refused('pasta do projeto fica fora de ~/.claude/projects');
  const folder = path.join(dir, c.sessionId);
  const jsonl = path.join(dir, `${c.sessionId}.jsonl`);
  for (const t of [folder, jsonl]) {
    const st = await fs.lstat(t).catch(() => null);
    if (st?.isSymbolicLink()) throw new Refused('transcript é link: não apago');
  }
  await fs.rm(folder, { recursive: true, force: true });
  await fs.rm(jsonl, { force: true });
}

/** Tira a conversa da ficha, do config e do registro. Falha na ficha: loga e NÃO tira as outras referências (próximo ciclo). */
async function dropRefs(deps: RetentionDeps, id: string, staffId: string | null, projectPath: string, registryFile: string): Promise<boolean> {
  if (staffId) {
    try {
      await deps.dropStaffSession(projectPath, staffId, id);
    } catch (err) {
      deps.log?.(`[retencao] ${id}: não consegui tirar da ficha ${staffId} (${msg(err)}); a referência fica para o próximo ciclo`);
      return false;
    }
  }
  await forgetSessions([id], deps.configFile);
  await removeFromRegistry([id], registryFile);
  return true;
}

/**
 * Uma varredura de exclusão. Não roda se a exclusão não estiver confirmada no navegador (`retentionDeleteEnabledAt`) ou se
 * `deleteAfterDays` for 0. Só uma por vez no processo: a chamada que chega durante outra volta com `reason`.
 */
export async function runRetentionSweep(deps: RetentionDeps): Promise<SweepResult> {
  const result: SweepResult = { ran: false, deleted: { claude: [], codex: [] }, failed: [], skipped: 0, pruned: 0 };
  if (sweeping) return { ...result, reason: 'já há uma varredura em curso' };
  sweeping = true;
  try {
    const cfg = await readConfig(deps.configFile);
    if (cfg.deleteAfterDays <= 0 || !cfg.retentionDeleteEnabledAt) return { ...result, reason: 'exclusão desligada' };
    result.ran = true;
    const registryFile = deps.registryFile ?? REGISTRY_FILE;
    const now = (deps.now ?? Date.now)();
    const cutoff = now - cfg.deleteAfterDays * DAY_MS;
    const { scopes } = await loadScopes(deps);
    const pool = poolOf(scopes, await readSessionRegistry(registryFile));
    const found = (await candidatesOf(deps, pool, cutoff, registryFile)).sort((a, b) => a.lastActivity - b.lastActivity);

    const handled = new Set<string>();
    let stopped = false;
    for (const c of found) {
      // Revalida logo antes de cada exclusão: exclusão desligada no meio, ao vivo, em turno, e a atividade (stat) de novo.
      const cfgNow = await readConfig(deps.configFile);
      if (cfgNow.deleteAfterDays <= 0 || !cfgNow.retentionDeleteEnabledAt) {
        result.reason = 'exclusão desligada no meio da varredura';
        stopped = true;
        break;
      }
      const cutoffNow = now - cfgNow.deleteAfterDays * DAY_MS;
      const alive = aliveIds(await deps.liveSessions());
      const busy = await deps.busy();
      const id = c.sessionId;
      const fresh = await currentActivity(deps, c, registryFile);
      if (alive.has(id) || busy.has(id) || !fresh || fresh.last >= cutoffNow) {
        result.skipped++;
        continue;
      }
      try {
        if (c.engine === 'codex') {
          if (!(await deps.codex.deleteThread(fresh.threadId!))) {
            result.failed.push(id);
            continue; // referências mantidas: o próximo ciclo tenta de novo
          }
        } else {
          await deleteClaudeTranscript(deps.claudeHome, c);
        }
      } catch (err) {
        result.failed.push(id);
        deps.log?.(`[retencao] ${c.engine} ${id} não apagada: ${msg(err)}`);
        continue;
      }
      // Logo depois do apagar e antes de tirar as referências: quem lê o log vê o que saiu.
      deps.log?.(`[retencao] apagada: ${c.engine} ${id}`);
      handled.add(id);
      await dropRefs(deps, id, c.staffId, c.projectPath, registryFile);
      result.deleted[c.engine].push(id);
    }

    if (!stopped) {
      // Sobras só para conversa que NÃO está ao vivo nem em turno agora (uma conversa aberta sem arquivo ainda não é sobra).
      const aliveNow = aliveIds(await deps.liveSessions());
      const busyNow = await deps.busy();
      // Só vira "sumiu" com o cwd conhecido: sem ele (ficha antiga, possível worktree) não dá para provar que o transcript não existe.
      const isSobra = (id: string, c: Pick<Pool, 'createdAt' | 'scope' | 'cwdKnown'>) =>
        !handled.has(id) && c.cwdKnown && c.createdAt < cutoff && !c.scope.keep.has(id) && !aliveNow.has(id) && !busyNow.has(id);
      // Sobras: conversa antiga cujo arquivo já sumiu (o Claude Code apaga pelo cleanupPeriodDays) e referências que ficaram para trás.
      for (const [id, c] of pool) {
        if (!isSobra(id, c)) continue;
        const gone = c.engine === 'claude' ? await claudeGone(deps.claudeHome, c.cwd, id) : await codexRolloutMissing(deps.runDir, id, registryFile);
        if (gone && (await dropRefs(deps, id, c.staffId, c.projectPath, registryFile))) result.pruned++;
      }
      // Registro: o que ainda sobrou de conversa de projeto lido, antiga e sem arquivo sai do registro.
      const rest = await pruneRegistry(
        async (id, e) => {
          const c = pool.get(id);
          if (!c || !isSobra(id, { createdAt: Date.parse(e.createdAt), scope: c.scope, cwdKnown: c.cwdKnown })) return false;
          return c.engine === 'claude' ? claudeGone(deps.claudeHome, e.cwd, id) : codexRolloutMissing(deps.runDir, id, registryFile);
        },
        registryFile,
      );
      result.pruned += rest.length;
    }

    const n = result.deleted.claude.length + result.deleted.codex.length;
    deps.log?.(`[retencao] ${n} conversa(s) apagada(s) (claude ${result.deleted.claude.length}, codex ${result.deleted.codex.length}); falharam: ${result.failed.length}; podadas: ${result.pruned}`);
    return result;
  } catch (err) {
    // Leitura de proteção que falhou (despertador, ao vivo, config, registro): nada mais é apagado nesta varredura.
    result.aborted = msg(err);
    deps.log?.(`[retencao] varredura abortada, nada mais apagado: ${result.aborted}`);
    return result;
  } finally {
    sweeping = false;
    // Guarda a hora de uma varredura que rodou (mesmo que tenha abortado): reinícios não zeram a cadência das 12 h.
    if (result.ran && deps.lastRunFile) await stampRetentionRun(deps.lastRunFile, (deps.now ?? Date.now)()).catch(() => undefined);
  }
}

/** Quando a última varredura rodou (ms desde 1970), ou null se nunca (arquivo ausente ou estragado). */
export async function lastRetentionRun(file: string): Promise<number | null> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const at = Date.parse((JSON.parse(raw) as { at?: unknown }).at as string);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

async function stampRetentionRun(file: string, at: number): Promise<void> {
  await writeAtomic(file, JSON.stringify({ at: new Date(at).toISOString() }) + '\n');
}

/**
 * Quanto esperar até a próxima varredura, contado do boot: `period` desde a última (ou já, se nunca rodou), com piso de `minDelay`
 * (o resume das conversas abertas acaba antes). Reinício frequente não zera a cadência, porque a hora da última fica guardada.
 */
export function nextRetentionDelay(last: number | null, now: number, period: number, minDelay: number): number {
  if (last === null) return minDelay;
  return Math.max(minDelay, last + period - now);
}

/** A prévia: o que a varredura apagaria agora, sem apagar nada. Os dias e a confirmação vêm do config. */
export async function retentionPreview(deps: RetentionDeps): Promise<RetentionPreview> {
  const cfg = await readConfig(deps.configFile);
  let found: Candidate[] = [];
  let skipped: string[] = [];
  if (cfg.deleteAfterDays > 0) {
    const registryFile = deps.registryFile ?? REGISTRY_FILE;
    const now = (deps.now ?? Date.now)();
    const { scopes, skipped: pulados } = await loadScopes(deps);
    const pool = poolOf(scopes, await readSessionRegistry(registryFile));
    found = await candidatesOf(deps, pool, now - cfg.deleteAfterDays * DAY_MS, registryFile);
    skipped = pulados;
  }
  const sum = (engine: 'claude' | 'codex') => {
    const xs = found.filter((c) => c.engine === engine);
    return { count: xs.length, bytes: xs.reduce((n, c) => n + c.bytes, 0) };
  };
  const oldest = found.length ? new Date(Math.min(...found.map((c) => c.lastActivity))).toISOString() : null;
  return { deleteAfterDays: cfg.deleteAfterDays, enabledAt: cfg.retentionDeleteEnabledAt, claude: sum('claude'), codex: sum('codex'), oldest, skipped };
}

/**
 * Liga ou desliga a exclusão. Ligar só vem do navegador (`fromBrowser`: quem tem o MYCO_TOKEN, como os agentes, não liga) e
 * exige dias para apagar > 0. Desligar é sempre permitido.
 */
export async function setRetentionDeletion(enabled: boolean, opts: { fromBrowser: boolean; configFile?: string; now?: () => number }): Promise<AppConfig> {
  if (!enabled) return setRetentionDeleteEnabledAt(null, opts.configFile);
  if (!opts.fromBrowser) throw new RetentionError('a exclusão só é ligada pelo Claudio’s Club, no navegador');
  const cfg = await readConfig(opts.configFile);
  if (cfg.deleteAfterDays <= 0) throw new RetentionError('ajuste os dias para apagar antes de ligar a exclusão (0 = desligado)');
  return setRetentionDeleteEnabledAt(new Date((opts.now ?? Date.now)()).toISOString(), opts.configFile);
}
