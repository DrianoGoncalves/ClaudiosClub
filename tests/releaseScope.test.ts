import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskConflictError, TaskService } from '../server/tasks';
import type { StaffProfile } from '../shared/model';
import { tempDirs } from './support/tmp';

// A trava da versão aberta no TaskService (ver server/release.ts): só as tarefas do escopo saem da fila, começam sem ser pelo dono e mesclam; as de fora esperam
// a versão ser preparada. O "Começar" do dono passa, como na pausa.

const tmp = tempDirs();

const ANA = { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as unknown as StaffProfile;

async function club(name: string) {
  const dir = await tmp(`myco-rscope-${name}-`);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const h = { opened: [] as Array<{ text: string; session: string }>, busy: false, n: 0, scope: null as { version: string; ids: ReadonlySet<string> } | null };
  const svc = new TaskService({
    projectPath: async (id) => (id === 'p' ? dir : null),
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? ANA : null),
    send: async (_project, _staffId, text) => {
      const session = `ana-${++h.n}`;
      h.opened.push({ text, session });
      h.busy = true;
      return session;
    },
    sendTo: async (_p, session) => session,
    branchFor: async () => null,
    isWorking: () => h.busy,
    notify: async () => {},
    lastText: () => null,
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    readLimit: async () => null,
    settleLimit: async () => {},
    assertRunnable: async () => {},
    cancelContinue: async () => null,
    stopSession: () => {},
    snapshot: async (_p, sid) => ({ sessionId: sid, history: [], live: null }) as never,
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
    releaseScope: async () => h.scope,
  });
  const add = async (title: string) => (await svc.create('p', { title, staffId: 'ana-1', start: false }))!;
  const get = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
  const opened = (title: string) => h.opened.some((o) => o.text.includes(`[Tarefa "${title}"]`));
  return { svc, h, add, get, opened };
}

describe('versão aberta: a trava da fila, do início e da mescla', () => {
  it('a de fora entra na fila com a nota e não começa; a do escopo começa; com a versão preparada, a de fora anda', async () => {
    const c = await club('fila');
    const fora = await c.add('Fora');
    const dentro = await c.add('Dentro');
    c.h.scope = { version: '9.9.9', ids: new Set([dentro.id]) };
    await c.svc.start('p', fora.id);
    expect(await c.get(fora.id)).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });
    expect((await c.get(fora.id)).history.at(-1)?.note).toMatch(/fora da versão 9\.9\.9/);
    expect(c.opened('Fora')).toBe(false);
    await c.svc.start('p', dentro.id);
    expect(c.opened('Dentro')).toBe(true);
    // A Ana fica livre: a fila não pega a de fora enquanto a versão está aberta.
    c.h.busy = false;
    await c.svc.update('p', dentro.id, { status: 'review' });
    await c.svc.kickStaff('p', 'ana-1');
    await c.svc.tick();
    expect(c.opened('Fora')).toBe(false);
    // Preparada (escopo null): a fila anda.
    c.h.scope = null;
    await c.svc.kickStaff('p', 'ana-1');
    expect(c.opened('Fora')).toBe(true);
  });

  it('o "Começar" do dono abre a de fora mesmo com a versão aberta', async () => {
    const c = await club('dono');
    const fora = await c.add('Fora do dono');
    c.h.scope = { version: '9.9.9', ids: new Set() };
    const started = (await c.svc.start('p', fora.id, false, { byOwner: true }))!;
    expect(started).toMatchObject({ status: 'doing', sessionId: expect.any(String) });
  });

  it('mesclar uma tarefa de fora é recusado (409) antes de tocar no git', async () => {
    const c = await club('mescla');
    const fora = await c.add('Fora da mescla');
    c.h.scope = { version: '9.9.9', ids: new Set() };
    await expect(c.svc.merge('p', fora.id, false, true)).rejects.toBeInstanceOf(TaskConflictError);
    await expect(c.svc.merge('p', fora.id, false, true)).rejects.toThrow(/versão 9\.9\.9 está aberta/);
  });
});
