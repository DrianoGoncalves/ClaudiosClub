import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeProjectDir } from '../server/adapters/claude/paths';
import { readConfig, RetentionError, setArchived, setRetentionDeleteEnabledAt, updateConfig } from '../server/config';
import { retainedSessionIds } from '../server/retention';
import { attachThreadId, readSessionRegistry, recordSession } from '../server/sessionsRegistry';
import { AutoContinue } from '../server/chat/autoContinue';
import { listProjectStaffStrict } from '../server/staff/store';
import { lastRetentionRun, nextRetentionDelay, retentionPreview, runRetentionSweep, setRetentionDeletion, type RetentionDeps } from '../server/retentionSweep';
import type { LiveSession, Project, StaffProfile, Task } from '../shared/model';

// Exclusão da retenção (etapa 2). Tudo em pastas temporárias: ~/.claude e ~/.codex reais não são lidos nem escritos.
// O Codex é um mock (`deleteThread`); o ~/.codex do teste é uma pasta temporária via CODEX_HOME.

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * DAY);
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const codexUid = (n: number) => `019e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let root: string;
let prevCodexHome: string | undefined;
let n = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-retention-del-'));
  prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
});
afterAll(async () => {
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  await fs.rm(root, { recursive: true, force: true });
});

const task = (sessionId: string, status: string) => ({ status, sessionId, review: null, deploy: null, question: undefined }) as unknown as Task;

async function setup(name: string, o: { deleteAfterDays?: number; enabled?: boolean; tasks?: Task[]; live?: string[]; busy?: string[]; staff?: unknown[] } = {}) {
  const dir = path.join(root, `${name}-${n++}`);
  const claudeHome = path.join(dir, 'claude');
  const projectPath = path.join(dir, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  const registryFile = path.join(dir, 'sessions-registry.json');
  const runDir = path.join(dir, 'run'); // sem codex-thread.json: o threadId vem do registro
  await updateConfig({ archiveAfterDays: 7, deleteAfterDays: o.deleteAfterDays ?? 30 }, configFile);
  if (o.enabled) await setRetentionDeleteEnabledAt('2026-11-01T00:00:00.000Z', configFile);
  const dropped: string[] = [];
  const codex = { deleteThread: vi.fn(async (_threadId: string) => true) };
  const deps: RetentionDeps = {
    claudeHome,
    runDir,
    configFile,
    registryFile,
    now: () => NOW,
    projects: async () => [{ id: 'p1', path: projectPath, name: 'proj', exists: true } as unknown as Project],
    // Sem `staff` no cenário: as fichas são lidas do disco (leitura estrita, como em produção). Com `staff`: fichas fixas.
    staffOf: o.staff ? async () => o.staff as StaffProfile[] : (p) => listProjectStaffStrict(p.path, p.id),
    // Sem `tasks` no cenário: tasks.json do disco, lido estrito.
    ...(o.tasks ? { tasksOf: async () => o.tasks as Task[] } : {}),
    liveSessions: async () => (o.live ?? []).map((sessionId) => ({ sessionId, alive: true }) as unknown as LiveSession),
    busy: async () => new Set(o.busy ?? []),
    codex,
    dropStaffSession: async (_p, _s, sid) => {
      dropped.push(sid);
      return true;
    },
    log: () => {},
  };
  return { dir, claudeHome, projectPath, configFile, registryFile, runDir, deps, codex, dropped };
}
type S = Awaited<ReturnType<typeof setup>>;

/** Transcript do Claude da conversa, com a atividade `days` atrás (no lugar que o Claude Code usa). */
async function transcript(s: S, id: string, days: number) {
  const dir = path.join(s.claudeHome, 'projects', encodeProjectDir(path.resolve(s.projectPath)));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(file, '{"type":"user"}\n');
  await fs.utimes(file, ago(days), ago(days));
  return file;
}
const here = (s: S, id: string) => path.join(s.claudeHome, 'projects', encodeProjectDir(path.resolve(s.projectPath)), `${id}.jsonl`);
const exists = (file: string) => fs.access(file).then(() => true, () => false);

/** Conversa no registro do Club, lançada `days` atrás. */
async function register(s: S, id: string, days: number, staffId?: string) {
  await recordSession({ sessionId: id, engine: 'claude', projectPath: s.projectPath, cwd: s.projectPath, staffId, at: ago(days) }, s.registryFile);
}

/** Rollout do Codex (no ~/.codex temporário), com a atividade `days` atrás. */
async function codexRollout(threadId: string, days: number) {
  const day = path.join(process.env.CODEX_HOME!, 'sessions', '2026', '09', '01');
  await fs.mkdir(day, { recursive: true });
  const file = path.join(day, `rollout-2026-09-01T00-00-00-${threadId}.jsonl`);
  await fs.writeFile(file, '{}\n');
  await fs.utimes(file, ago(days), ago(days));
  return file;
}

const staffWith = (sessions: Array<{ id: string; days: number }>) =>
  [{ id: 'ana', projectId: 'p1', engine: 'claude', sessions: sessions.map((x) => ({ id: x.id, startedAt: ago(x.days).toISOString() })) }];

describe('exclusão: só o que o Club lançou, do jeito certo', () => {
  it('apaga conversas do Club paradas além do prazo; avulsa fora do registro, ao vivo, em turno, protegida, tarefa aberta e recente ficam', async () => {
    const s = await setup('a', {
      enabled: true,
      live: [uid(4)],
      busy: [uid(5)],
      tasks: [task(uid(7), 'doing')],
      staff: staffWith([{ id: uid(2), days: 40 }, { id: uid(6), days: 40 }]), // uid(6) é a última da ficha: protegida
    });
    await register(s, uid(1), 50); // registrada, velha: apaga
    await transcript(s, uid(1), 50);
    await transcript(s, uid(2), 40); // da ficha (não está no registro): apaga
    await transcript(s, uid(3), 60); // avulsa, fora do registro e da ficha: intocada
    for (const id of [4, 5, 7]) {
      await register(s, uid(id), 50);
      await transcript(s, uid(id), 50);
    }
    await transcript(s, uid(6), 40);
    await register(s, uid(8), 2); // recente
    await transcript(s, uid(8), 2);
    await setArchived({ kind: 'session', id: uid(1), archived: true }, s.configFile);

    const r = await runRetentionSweep(s.deps);
    expect(r.ran).toBe(true);
    expect([...r.deleted.claude].sort()).toEqual([uid(1), uid(2)].sort());
    expect(await exists(here(s, uid(1)))).toBe(false);
    expect(await exists(here(s, uid(2)))).toBe(false);
    for (const id of [3, 4, 5, 6, 7, 8]) expect(await exists(here(s, uid(id))), `uid ${id}`).toBe(true);
    expect(s.dropped).toEqual([uid(2)]); // saiu da ficha
    expect([...(await readSessionRegistry(s.registryFile)).keys()].sort()).toEqual([uid(4), uid(5), uid(7), uid(8)].sort());
    expect((await readConfig(s.configFile)).archived.sessions).not.toContain(uid(1)); // saiu do arquivado
  });

  it('sem a confirmação no navegador (ou com 0 dias), a varredura não apaga nada', async () => {
    const off = await setup('off');
    await register(off, uid(1), 50);
    await transcript(off, uid(1), 50);
    const r1 = await runRetentionSweep(off.deps);
    expect(r1).toMatchObject({ ran: false, reason: 'exclusão desligada' });
    expect(await exists(here(off, uid(1)))).toBe(true);

    const zero = await setup('zero', { enabled: true, deleteAfterDays: 0 });
    await register(zero, uid(1), 50);
    await transcript(zero, uid(1), 50);
    expect((await runRetentionSweep(zero.deps)).ran).toBe(false);
    expect(await exists(here(zero, uid(1)))).toBe(true);
  });

  it('o Codex sem candidatos não é chamado (nem o rollout é lido)', async () => {
    const s = await setup('codex-none', { enabled: true, busy: [uid(61)] });
    await recordSession({ sessionId: uid(60), engine: 'codex', projectPath: s.projectPath, cwd: s.projectPath, at: ago(2) }, s.registryFile); // recente
    await recordSession({ sessionId: uid(61), engine: 'codex', projectPath: s.projectPath, cwd: s.projectPath, at: ago(50) }, s.registryFile); // velha, mas em turno
    await attachThreadId(uid(61), codexUid(61), s.registryFile);
    await codexRollout(codexUid(61), 50);
    const r = await runRetentionSweep(s.deps);
    expect(r.deleted.codex).toEqual([]);
    expect(s.codex.deleteThread).not.toHaveBeenCalled();
  });

  it('Codex com candidato: o CLI apaga com o threadId; falha mantém a referência para o próximo ciclo', async () => {
    const s = await setup('codex', { enabled: true });
    await recordSession({ sessionId: uid(11), engine: 'codex', projectPath: s.projectPath, cwd: s.projectPath, at: ago(50) }, s.registryFile);
    await attachThreadId(uid(11), codexUid(11), s.registryFile);
    await codexRollout(codexUid(11), 50);
    s.codex.deleteThread.mockResolvedValueOnce(false); // primeiro ciclo: o CLI falha

    const falhou = await runRetentionSweep(s.deps);
    expect(falhou.failed).toEqual([uid(11)]);
    expect(falhou.deleted.codex).toEqual([]);
    expect((await readSessionRegistry(s.registryFile)).has(uid(11))).toBe(true);
    expect(s.codex.deleteThread).toHaveBeenCalledWith(codexUid(11));

    const deu = await runRetentionSweep(s.deps); // próximo ciclo: o CLI apaga
    expect(deu.deleted.codex).toEqual([uid(11)]);
    expect((await readSessionRegistry(s.registryFile)).has(uid(11))).toBe(false);
  });

  it('Codex com threadId que não é UUID (o CLI não apaga assim): pula, sem chamar o CLI', async () => {
    const s = await setup('codex-threadid', { enabled: true });
    await recordSession({ sessionId: uid(12), engine: 'codex', projectPath: s.projectPath, cwd: s.projectPath, at: ago(50) }, s.registryFile);
    await attachThreadId(uid(12), 'thread-nao-uuid', s.registryFile);
    await codexRollout('thread-nao-uuid', 50);
    const r = await runRetentionSweep(s.deps);
    expect(r.deleted.codex).toEqual([]);
    expect(s.codex.deleteThread).not.toHaveBeenCalled();
  });

  it('pasta do projeto que é link para fora de ~/.claude/projects: recusa, e o arquivo de fora fica', async () => {
    const s = await setup('link', { enabled: true });
    const outside = path.join(s.dir, 'fora');
    await fs.mkdir(outside, { recursive: true });
    const outFile = path.join(outside, `${uid(20)}.jsonl`);
    await fs.writeFile(outFile, '{}\n');
    await fs.utimes(outFile, ago(50), ago(50));
    await fs.mkdir(path.join(s.claudeHome, 'projects'), { recursive: true });
    await fs.symlink(outside, path.join(s.claudeHome, 'projects', encodeProjectDir(path.resolve(s.projectPath))), 'junction');
    await register(s, uid(20), 50);

    const r = await runRetentionSweep(s.deps);
    expect(r.failed).toEqual([uid(20)]);
    expect(r.deleted.claude).toEqual([]);
    expect(await exists(outFile)).toBe(true);
    expect((await readSessionRegistry(s.registryFile)).has(uid(20))).toBe(true);
  });

  it('varreduras sobrepostas: a segunda não roda enquanto a primeira apaga', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atDrop = new Promise<void>((r) => (reached = r));
    const s = await setup('overlap', { enabled: true, staff: staffWith([{ id: uid(30), days: 40 }, { id: uid(31), days: 35 }]) });
    await transcript(s, uid(30), 40); // a última da ficha (uid 31) fica
    await transcript(s, uid(31), 35);
    s.deps.dropStaffSession = async () => {
      reached();
      await gate;
      return true;
    };
    const first = runRetentionSweep(s.deps);
    await atDrop;
    const second = await runRetentionSweep(s.deps);
    expect(second).toMatchObject({ ran: false, reason: 'já há uma varredura em curso' });
    release();
    expect((await first).deleted.claude).toEqual([uid(30)]);
  });

  it('revalida antes de apagar: a conversa que ganhou atividade desde o cálculo fica', async () => {
    const s = await setup('reval', { enabled: true });
    await register(s, uid(40), 50);
    const file = await transcript(s, uid(40), 50);
    let calls = 0;
    s.deps.liveSessions = async () => {
      calls++;
      if (calls === 2) await fs.utimes(file, new Date(NOW), new Date(NOW)); // a conversa volta a ser usada
      return [];
    };
    const r = await runRetentionSweep(s.deps);
    expect(r.deleted.claude).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(await exists(file)).toBe(true);
  });

  it('poda do registro a conversa cujo transcript já sumiu (antiga); a recente sem arquivo fica', async () => {
    const s = await setup('prune', { enabled: true });
    await register(s, uid(50), 50); // sem arquivo, antiga: poda
    await register(s, uid(51), 2); // sem arquivo, recente: fica (pode estar começando)
    const r = await runRetentionSweep(s.deps);
    expect(r.pruned).toBe(1);
    expect([...(await readSessionRegistry(s.registryFile)).keys()]).toEqual([uid(51)]);
  });

  it('a retenção nunca apaga a última sessão de cada ficha (função pura, usada pela varredura)', () => {
    const kept = retainedSessionIds(
      [{ sessions: [{ id: 'antiga' }, { id: 'ultima' }] }] as unknown as Array<Pick<StaffProfile, 'sessions'>>,
      [task('t', 'review')] as unknown as Task[],
    );
    expect(kept.has('ultima')).toBe(true);
    expect(kept.has('t')).toBe(true);
  });
});

describe('prévia e ligar/desligar a exclusão', () => {
  it('prévia: conta o que seria apagado, sem apagar nada e sem chamar o Codex', async () => {
    const s = await setup('prev', { enabled: true });
    await register(s, uid(1), 50);
    await transcript(s, uid(1), 50);
    const p = await retentionPreview(s.deps);
    expect(p).toMatchObject({ deleteAfterDays: 30, enabledAt: '2026-11-01T00:00:00.000Z', claude: { count: 1 }, codex: { count: 0, bytes: 0 } });
    expect(p.claude.bytes).toBeGreaterThan(0);
    expect(p.oldest).not.toBeNull();
    expect(await exists(here(s, uid(1)))).toBe(true);
    expect(s.codex.deleteThread).not.toHaveBeenCalled();
  });

  it('ligar a exclusão: só do navegador e com dias para apagar; desligar é sempre permitido', async () => {
    const s = await setup('enable');
    await expect(setRetentionDeletion(true, { fromBrowser: false, configFile: s.configFile })).rejects.toBeInstanceOf(RetentionError);
    expect((await readConfig(s.configFile)).retentionDeleteEnabledAt).toBeNull();

    const on = await setRetentionDeletion(true, { fromBrowser: true, configFile: s.configFile, now: () => NOW });
    expect(on.retentionDeleteEnabledAt).toBe(new Date(NOW).toISOString());
    expect((await setRetentionDeletion(false, { fromBrowser: false, configFile: s.configFile })).retentionDeleteEnabledAt).toBeNull();

    await updateConfig({ deleteAfterDays: 0 }, s.configFile);
    await expect(setRetentionDeletion(true, { fromBrowser: true, configFile: s.configFile })).rejects.toThrow('ajuste os dias');
  });

  it('diminuir os dias para apagar zera a confirmação; aumentar não', async () => {
    const s = await setup('dec', { enabled: true }); // apagar em 30 dias, ligada
    expect((await updateConfig({ deleteAfterDays: 60 }, s.configFile)).retentionDeleteEnabledAt).not.toBeNull();
    expect((await updateConfig({ deleteAfterDays: 20 }, s.configFile)).retentionDeleteEnabledAt).toBeNull();
  });
});

describe('proteção que não pode falhar em silêncio (revisão da exclusão)', () => {
  it('tasks.json ilegível: o projeto inteiro sai da varredura; nada dele é apagado', async () => {
    const s = await setup('tasks-ruim', { enabled: true });
    await fs.mkdir(path.join(s.projectPath, '.myco'), { recursive: true });
    await fs.writeFile(path.join(s.projectPath, '.myco', 'tasks.json'), '{ruim');
    await register(s, uid(1), 50);
    await transcript(s, uid(1), 50);
    const logs: string[] = [];
    s.deps.log = (l) => logs.push(l);
    const r = await runRetentionSweep(s.deps);
    expect(r.deleted.claude).toEqual([]);
    expect(await exists(here(s, uid(1)))).toBe(true);
    expect(logs.some((l) => l.includes('pulado'))).toBe(true);
  });

  it('ficha ilegível no disco: o projeto sai da varredura', async () => {
    const s = await setup('ficha-ruim', { enabled: true });
    await fs.mkdir(path.join(s.projectPath, '.myco', 'staff'), { recursive: true });
    await fs.writeFile(path.join(s.projectPath, '.myco', 'staff', 'ana.json'), '{ruim');
    await register(s, uid(1), 50);
    await transcript(s, uid(1), 50);
    const r = await runRetentionSweep(s.deps);
    expect(r.deleted.claude).toEqual([]);
    expect(await exists(here(s, uid(1)))).toBe(true);
  });

  it('entrada do registro com ficha que não carregou: fica (não dá para saber se é a última da ficha)', async () => {
    const s = await setup('ficha-sumiu', { enabled: true, staff: [] });
    await recordSession({ sessionId: uid(1), engine: 'claude', projectPath: s.projectPath, cwd: s.projectPath, staffId: 'ana', at: ago(50) }, s.registryFile);
    await transcript(s, uid(1), 50);
    const r = await runRetentionSweep(s.deps);
    expect(r.deleted.claude).toEqual([]);
    expect(await exists(here(s, uid(1)))).toBe(true);
  });

  it('tarefa com status desconhecido conta como não concluída: a conversa dela fica', async () => {
    const s = await setup('status-novo', { enabled: true, tasks: [task(uid(1), 'em-status-futuro')] });
    await register(s, uid(1), 50);
    await transcript(s, uid(1), 50);
    const r = await runRetentionSweep(s.deps);
    expect(r.deleted.claude).toEqual([]);
    expect(await exists(here(s, uid(1)))).toBe(true);
  });

  it('conversa da troca de motor (fromSession) e a do gestor que pediu a tarefa (requestedSession) ficam', () => {
    const t = {
      status: 'doing',
      sessionId: null,
      review: null,
      deploy: null,
      question: undefined,
      fallback: { from: 'claude', at: 0, reason: 'limit-start', engine: 'codex', model: 'gpt', fromSession: uid(1) },
      requestedSession: uid(2),
    } as unknown as Task;
    const kept = retainedSessionIds([], [t]);
    expect(kept.has(uid(1))).toBe(true);
    expect(kept.has(uid(2))).toBe(true);
  });

  it('despertador ou auto-continue ilegível aborta a varredura: nada é apagado', async () => {
    const s = await setup('pendencia-ruim', { enabled: true });
    await register(s, uid(1), 50);
    await transcript(s, uid(1), 50);
    s.deps.busy = async () => {
      throw new Error('wakeups.json ilegível');
    };
    const r = await runRetentionSweep(s.deps);
    expect(r.aborted).toContain('wakeups.json ilegível');
    expect(r.deleted.claude).toEqual([]);
    expect(await exists(here(s, uid(1)))).toBe(true);
  });

  it('a leitura estrita das pendências: arquivo ilegível LANÇA e não é quarentenado; arquivo válido dá os ids', async () => {
    const dir = path.join(root, `pend-${n++}`);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'wakeups.json');
    const ac = new AutoContinue({ file, enabled: async () => true, stopHit: async () => null, knownResets: async () => [], send: async () => {}, log: () => {} });
    await fs.writeFile(file, '{ruim');
    await expect(ac.sessionIdsStrict()).rejects.toThrow();
    expect(await exists(file)).toBe(true); // não foi para .bad
    expect(await exists(`${file}.bad`)).toBe(false);
    await fs.writeFile(file, JSON.stringify({ pending: [{ projectId: 'p', sessionId: uid(9), staffId: null, at: ago(1).toISOString(), resetsAt: ago(0).toISOString() }] }));
    expect(await ac.sessionIdsStrict()).toEqual([uid(9)]);
  });

  it('subagent com atividade recente protege a conversa mesmo com o .jsonl antigo', async () => {
    const s = await setup('subagent', { enabled: true });
    await register(s, uid(1), 50);
    await transcript(s, uid(1), 50);
    const sub = path.join(path.dirname(here(s, uid(1))), uid(1), 'subagents');
    await fs.mkdir(sub, { recursive: true });
    const agent = path.join(sub, 'agent-1.jsonl');
    await fs.writeFile(agent, '{}\n');
    await fs.utimes(agent, ago(1), ago(1));
    const r = await runRetentionSweep(s.deps);
    expect(r.deleted.claude).toEqual([]);
    expect(await exists(here(s, uid(1)))).toBe(true);
    expect(await exists(agent)).toBe(true);
  });

  it('desligar a exclusão no meio da varredura para antes da próxima conversa', async () => {
    const s = await setup('desliga-meio', { enabled: true, staff: staffWith([{ id: uid(1), days: 50 }, { id: uid(9), days: 1 }]) });
    await recordSession({ sessionId: uid(1), engine: 'claude', projectPath: s.projectPath, cwd: s.projectPath, staffId: 'ana', at: ago(50) }, s.registryFile);
    await transcript(s, uid(1), 50);
    await register(s, uid(2), 40);
    await transcript(s, uid(2), 40);
    // Ao tirar a primeira da ficha, o dono desliga a exclusão (o que acontece na vida real no meio do ciclo).
    s.deps.dropStaffSession = async () => {
      await setRetentionDeletion(false, { fromBrowser: false, configFile: s.configFile });
      return true;
    };
    const r = await runRetentionSweep(s.deps);
    expect(r.deleted.claude).toEqual([uid(1)]);
    expect(r.reason).toContain('no meio');
    expect(await exists(here(s, uid(2)))).toBe(true);
  });

  it('apagada: loga antes de tirar as referências; falha ao tirar da ficha não some com a referência (próximo ciclo tira)', async () => {
    const s = await setup('log-falha', { enabled: true, staff: staffWith([{ id: uid(1), days: 50 }, { id: uid(9), days: 1 }]) });
    await recordSession({ sessionId: uid(1), engine: 'claude', projectPath: s.projectPath, cwd: s.projectPath, staffId: 'ana', at: ago(50) }, s.registryFile);
    await transcript(s, uid(1), 50);
    const logs: string[] = [];
    s.deps.log = (l) => logs.push(l);
    let fail = true;
    s.deps.dropStaffSession = async () => {
      if (fail) {
        fail = false;
        throw new Error('ficha travada');
      }
      return true;
    };
    const r1 = await runRetentionSweep(s.deps);
    expect(r1.deleted.claude).toEqual([uid(1)]);
    const apagada = logs.findIndex((l) => l.includes(`apagada: claude ${uid(1)}`));
    const ficha = logs.findIndex((l) => l.includes('não consegui tirar da ficha'));
    expect(apagada).toBeGreaterThanOrEqual(0);
    expect(ficha).toBeGreaterThan(apagada);
    expect((await readSessionRegistry(s.registryFile)).has(uid(1))).toBe(true); // a referência ficou

    const r2 = await runRetentionSweep(s.deps); // próximo ciclo: a sobra é tirada
    expect(r2.pruned).toBe(1);
    expect((await readSessionRegistry(s.registryFile)).has(uid(1))).toBe(false);
  });

  it('codex: entrada cujo rollout sumiu é podada do registro; a com rollout (em turno) fica', async () => {
    const s = await setup('codex-poda', { enabled: true, busy: [uid(71)] });
    await recordSession({ sessionId: uid(70), engine: 'codex', projectPath: s.projectPath, cwd: s.projectPath, at: ago(50) }, s.registryFile);
    await attachThreadId(uid(70), codexUid(70), s.registryFile); // sem rollout
    await recordSession({ sessionId: uid(71), engine: 'codex', projectPath: s.projectPath, cwd: s.projectPath, at: ago(50) }, s.registryFile);
    await attachThreadId(uid(71), codexUid(71), s.registryFile);
    await codexRollout(codexUid(71), 50);
    const r = await runRetentionSweep(s.deps);
    expect(r.pruned).toBe(1);
    expect([...(await readSessionRegistry(s.registryFile)).keys()]).toEqual([uid(71)]);
    expect(s.codex.deleteThread).not.toHaveBeenCalled();
  });
});

describe('ajustes finais da revisão', () => {
  it('sobra sem cwd conhecido (ficha antiga, possível worktree) não sai da ficha, do config nem do registro', async () => {
    const s = await setup('sem-cwd', { enabled: true, staff: staffWith([{ id: uid(80), days: 50 }, { id: uid(9), days: 1 }]) });
    const r = await runRetentionSweep(s.deps);
    expect(r.pruned).toBe(0);
    expect(s.dropped).toEqual([]);
  });

  it('com cwd conhecido (registro), a sobra sai do registro', async () => {
    const s = await setup('com-cwd', { enabled: true });
    await register(s, uid(81), 50); // registro com cwd, sem arquivo
    const r = await runRetentionSweep(s.deps);
    expect(r.pruned).toBe(1);
    expect((await readSessionRegistry(s.registryFile)).has(uid(81))).toBe(false);
  });

  it('prévia: lista os projetos pulados por ficha ou tarefa ilegível', async () => {
    const ok = await setup('prev-ok', { enabled: true });
    expect((await retentionPreview(ok.deps)).skipped).toEqual([]);
    const bad = await setup('prev-bad', { enabled: true });
    await fs.mkdir(path.join(bad.projectPath, '.myco'), { recursive: true });
    await fs.writeFile(path.join(bad.projectPath, '.myco', 'tasks.json'), '{ruim');
    expect((await retentionPreview(bad.deps)).skipped).toEqual(['proj']);
  });

  it('a última varredura fica guardada; no boot, espera o que falta das 12 h (piso de 5 min)', async () => {
    const s = await setup('stamp', { enabled: true });
    const file = path.join(s.dir, 'retention-last-run.json');
    s.deps.lastRunFile = file;
    expect(await lastRetentionRun(file)).toBeNull();
    expect((await runRetentionSweep(s.deps)).ran).toBe(true);
    expect(await lastRetentionRun(file)).toBe(NOW);
    const H = 3_600_000;
    const MIN5 = 5 * 60_000;
    expect(nextRetentionDelay(null, NOW, 12 * H, MIN5)).toBe(MIN5); // nunca rodou: já (com o piso)
    expect(nextRetentionDelay(NOW - H, NOW, 12 * H, MIN5)).toBe(11 * H); // reiniciou 1 h depois: faltam 11 h
    expect(nextRetentionDelay(NOW - 13 * H, NOW, 12 * H, MIN5)).toBe(MIN5); // já passou: piso de 5 min
  });
});
