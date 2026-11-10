import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { ChatManager } from '../server/chat/manager';
import { TaskService } from '../server/tasks';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-busy-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('“trabalhando” é por projeto: o mesmo staffId em dois projetos não se bloqueia', () => {
  it('uma conversa trabalhando no projeto p1 não segura a tarefa do mesmo funcionário no p2', async () => {
    // Claude falso: o turno de "ana" no p1 fica aberto (sem "result") até o teste mandar o fim.
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 4343, kill: () => {} });
    const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const chats = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage-busy.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => ({ sessionId: sid ?? 's-p1', cwd: '.', args: [] }),
      spawnImpl: () => proc as never,
    });
    await chats.send('p1', null, 'ana', 'Oi');
    emit({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
    emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Trabalhando' }] } });
    await settle();

    expect(chats.staffWorking('p1', 'ana')).toBe(true);
    expect(chats.staffWorking('p2', 'ana')).toBe(false);
    expect(chats.workingSession('p1', 'ana')).toBe('s-p1');
    expect(chats.workingSession('p2', 'ana')).toBeNull();

    // A mesma ficha, no p2: a tarefa começa agora, sem fila.
    const dirs: Record<'p1' | 'p2', string> = { p1: path.join(root, 'p1'), p2: path.join(root, 'p2') };
    for (const d of Object.values(dirs)) await fs.mkdir(path.join(d, '.myco'), { recursive: true });
    const ana = { id: 'ana', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const enviados: string[] = [];
    const svc = new TaskService({
      projectPath: async (id) => (id === 'p1' || id === 'p2' ? dirs[id] : null),
      projectIds: async () => ['p1', 'p2'],
      readProfile: async (_p, id) => (id === 'ana' ? ana : null),
      send: async (projectId) => (enviados.push(projectId), `s-${projectId}-novo`),
      branchFor: async () => null,
      isWorking: (projectId, staffId, except) => chats.staffWorking(projectId, staffId, except),
    });
    const noP1 = (await svc.create('p1', { title: 'Tarefa no p1', staffId: 'ana' }))!;
    const noP2 = (await svc.create('p2', { title: 'Tarefa no p2', staffId: 'ana' }))!;

    expect(await svc.start('p2', noP2.id)).toMatchObject({ status: 'doing', sessionId: 's-p2-novo' });
    expect(enviados).toEqual(['p2']);

    // No p1 a Ana está trabalhando de fato: a tarefa nova entra na fila e não abre conversa.
    expect(await svc.start('p1', noP1.id)).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });
    expect(enviados).toEqual(['p2']);

    // Fim do turno no p1: a conversa deixa de trabalhar.
    emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'Pronto.' });
    await settle();
    expect(chats.staffWorking('p1', 'ana')).toBe(false);
  });
});
