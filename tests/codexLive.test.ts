import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountUsage, LiveSession, Project } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { ChatManager } from '../server/chat/manager';
import { StaffService, type StaffServiceOptions } from '../server/staff/service';

// A conversa do Codex entra no "live" do quadro (o Codex não grava ~/.claude/sessions): trabalhando vira busy, ociosa vira idle,
// e o que o adapter do Claude já lista não entra de novo. Fakes no estilo de tests/engineOverride.test.ts.

/** Cada `spawn` devolve um processo falso novo: `emit` simula o stdout, `close` o fim da execução. */
function fakeProcs() {
  const runs: Array<{ emit: (ev: object) => void; close: (code?: number) => void; child: EventEmitter }> = [];
  const spawnImpl = (_cmd: string, _args: string[]) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 5252 + runs.length });
    stdin.on('data', () => {});
    runs.push({
      emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'),
      close: (code = 0) => void child.emit('close', code),
      child,
    });
    return child as never;
  };
  return { runs, spawnImpl, last: () => runs[runs.length - 1]! };
}
type FakeProcs = ReturnType<typeof fakeProcs>;

let root: string;
let projectPath: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codexlive-'));
  projectPath = path.join(root, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const project = (): Project => ({
  id: 'proj-id',
  path: projectPath,
  name: 'proj',
  exists: true,
  worktreeOf: null,
  hasClaudeMd: false,
  agentCount: 0,
  skillCount: 0,
  sessionCount: 0,
  lastActivityAt: null,
});
const adapter = { listProjects: async () => [project()] } as unknown as ToolAdapter;
const noUsage = async (): Promise<AccountUsage> => ({ tapInstalled: true, limits: [], updatedAt: null });
const service = (over: Partial<StaffServiceOptions> = {}) =>
  new StaffService(adapter, { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'http://127.0.0.1:4848', readUsage: noUsage, codexEnabled: async () => true, ...over });

const base = { role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', launch: false };
const SECUNDARIO = { engine: 'codex', model: 'gpt-6-sol' } as const;

const tick = () => new Promise((r) => setTimeout(r, 15));

/** O turno do Codex acaba e a execução sai (como o `codex exec` faz); o processo da conversa fica aberto. */
async function acabaTurno(run: FakeProcs['runs'][number]) {
  run.emit({ type: 'thread.started', thread_id: 'abcdef12-3456' });
  run.emit({ type: 'turn.completed', usage: {} });
  await tick();
  run.close(0);
  await tick();
}

function managerWith(svc: StaffService, f: FakeProcs) {
  return new ChatManager({
    transcriptsDir: root,
    usageFile: path.join(root, 'usage-codexlive.json'),
    listLive: async () => [],
    resolve: (projectId, sessionId, staffId, forkFrom, engineOverride) => svc.chatSpawn(projectId, sessionId, staffId, forkFrom, engineOverride),
    spawnImpl: f.spawnImpl,
  });
}

/** Uma sessão viva do adapter do Claude (o que o `listLiveSessions` devolveria). */
const claudeLive = (sessionId: string): LiveSession => ({
  sessionId,
  pid: 4242,
  cwd: projectPath,
  name: null,
  status: 'busy',
  alive: true,
  entrypoint: 'cli',
  kind: null,
  startedAt: null,
  statusUpdatedAt: null,
});

describe('conversa do Codex no live do quadro (codexLive)', () => {
  it('conversa do Codex trabalhando aparece como busy, com o processo da execução e a pasta da ficha', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Live Codex', engine: 'codex', model: 'gpt-6-sol' }, true))!.profile;
    const f = fakeProcs();
    const m = managerWith(svc, f);
    const cid = await m.send('proj-id', null, p.id, 'oi');
    await tick();
    expect(m.codexLive([])).toEqual([
      { sessionId: cid, pid: 5252, cwd: projectPath, name: null, status: 'busy', alive: true, entrypoint: null, kind: null, startedAt: expect.any(String), statusUpdatedAt: expect.any(String) },
    ]);
    expect(m.isWorking(cid)).toBe(true);
    await acabaTurno(f.last());
    await m.stopAll();
  });

  it('conversa do Codex ociosa aparece como idle (não busy), e some quando a conversa fecha', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Live Ociosa', engine: 'codex', model: 'gpt-6-sol' }, true))!.profile;
    const f = fakeProcs();
    const m = managerWith(svc, f);
    const cid = await m.send('proj-id', null, p.id, 'oi');
    await tick();
    await acabaTurno(f.last());
    expect(m.isWorking(cid)).toBe(false);
    expect(m.codexLive([])).toMatchObject([{ sessionId: cid, status: 'idle', alive: true, pid: 0 }]);
    await m.stopAll();
    expect(m.codexLive([])).toEqual([]);
  });

  it('secundário no Codex de uma ficha Claude entra também; a conversa do Claude não entra', async () => {
    const svc = service();
    const pClaude = (await svc.hire('proj-id', { ...base, name: 'Live Claude', model: 'sonnet' }, true))!.profile;
    const pOverride = (await svc.hire('proj-id', { ...base, name: 'Live Override', model: 'sonnet' }, true))!.profile;
    const f = fakeProcs();
    const m = managerWith(svc, f);
    await m.send('proj-id', null, pClaude.id, 'oi');
    await tick();
    const cidCodex = await m.send('proj-id', null, pOverride.id, 'oi', undefined, [], [], false, undefined, SECUNDARIO);
    await tick();
    expect(m.codexLive([]).map((s) => s.sessionId)).toEqual([cidCodex]);
    f.runs[0]!.child.emit('exit', 0);
    await acabaTurno(f.runs[1]!);
    await m.stopAll();
  });

  it('não duplica: a sessão que o adapter do Claude já lista (pelo id) fica de fora do que o codexLive devolve', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Live Dedupe', engine: 'codex', model: 'gpt-6-sol' }, true))!.profile;
    const f = fakeProcs();
    const m = managerWith(svc, f);
    const cid = await m.send('proj-id', null, p.id, 'oi');
    await tick();
    expect(m.codexLive([claudeLive(cid)])).toEqual([]);
    expect(m.codexLive([claudeLive('outra-sessao')])).toHaveLength(1);
    await acabaTurno(f.last());
    await m.stopAll();
  });
});
