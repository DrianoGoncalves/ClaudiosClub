import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskConflictError, TaskForbiddenError, TaskService } from '../server/tasks';
import type { StaffProfile, Task } from '../shared/model';

// Mensagem guardada (t-f13ed2): o dono responde com o funcionário ocupado e a pergunta sai da caixa; e "Excluir" o ajuste guardado
// (`TaskService.discardHeld`), só pelo dono, sem correr com a entrega e sem apagar a resposta a uma dúvida.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-held-discard-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const people: Record<string, StaffProfile> = {
  'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
};

/** Um ajuste comum, uma resposta a pergunta por opções (`ask`) e uma resposta à dúvida escalada (`doubt`): os três jeitos de ficar guardado. */
const IMG = 'data:image/png;base64,AAAA';
const commonHeld = (now: string) => ({ id: 'h-comum', at: now, text: 'corrija o botão', images: [IMG], reason: 'espera a Ana' });
const askHeld = (now: string) => ({ id: 'h-ask', at: now, text: 'Resposta à sua dúvida: sim', reason: 'espera a Ana', ask: { requestId: 'q1', answers: { a: 'sim' }, by: 'user' }, doubt: true });
const doubtHeld = (now: string) => ({ id: 'h-doubt', at: now, text: 'Resposta do usuário à sua dúvida: pode', reason: 'espera a Ana', doubt: true });

/** `busy`: a Ana está fazendo a B (a A guarda o ajuste); sem ele ela está livre e a entrega manda. */
async function board(dirName: string, opts: { busy?: boolean; held?: (now: string) => unknown[] } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  const now = new Date().toISOString();
  const base = { description: '', plan: null, branch: null, pr: null, createdAt: now, updatedAt: now, history: [] as unknown[] };
  const held = opts.held ? opts.held(now) : [commonHeld(now)];
  await fs.writeFile(
    file,
    JSON.stringify([
      { ...base, id: 't-a', title: 'A', status: 'review', staffId: 'ana-1', sessionId: 'ana-work', held },
      ...(opts.busy ? [{ ...base, id: 't-b', title: 'B', status: 'doing', staffId: 'ana-1', sessionId: 'ana-b' }] : []),
    ]),
  );
  const h = {
    delivered: [] as Array<{ sessionId: string; text: string }>,
    sendToCalls: 0,
    dismissed: [] as string[],
    /** O `sendTo` espera por isso (a entrega parada no meio do envio, com a vez do funcionário na mão). */
    gate: null as null | Promise<void>,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId) => `${staffId}-novo`,
    branchFor: async () => null,
    isWorking: () => false,
    sendTo: async (_p, sessionId, _s, text) => {
      h.sendToCalls++;
      await h.gate;
      h.delivered.push({ sessionId, text });
      return sessionId;
    },
    notify: async () => {},
    lastText: () => null,
    dismissQuestion: (sessionId) => void h.dismissed.push(sessionId),
    apiUrl: 'http://127.0.0.1:4848',
  });
  const get = async (id: string) => ((await svc.list('p'))!).find((t) => t.id === id) as Task;
  const raw = () => fs.readFile(file, 'utf8');
  return { ...h, h, svc, get, raw };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

describe('o dono responde e a mensagem fica guardada: a pergunta sai da caixa', () => {
  it('mensagem do dono (byOwner) guardada tira a pergunta da conversa da caixa', async () => {
    const b = await board('hold-dono', { busy: true, held: () => [] });
    const reason = await b.svc.hold('ana-work', { text: 'pode apagar', byOwner: true });
    expect(reason).toContain('espera Ana terminar');
    expect((await b.get('t-a')).held).toHaveLength(1); // guardou
    expect(b.dismissed).toEqual(['ana-work']);
  });

  it('guardada vinda de funcionário (sem byOwner) não tira a pergunta', async () => {
    const b = await board('hold-func', { busy: true, held: () => [] });
    expect(await b.svc.hold('ana-work', { text: 'ajuste do gestor', origin: 'de Giovana' })).toContain('espera Ana terminar');
    expect((await b.get('t-a')).held).toHaveLength(1);
    expect(b.dismissed).toEqual([]);
  });

  it('o dono mandou mas não ficou guardada (funcionário livre, vai direto): quem limpa é o envio, não o hold', async () => {
    const b = await board('hold-livre', { held: () => [] });
    expect(await b.svc.hold('ana-work', { text: 'pode apagar', byOwner: true })).toBeNull();
    expect(b.dismissed).toEqual([]);
  });

  it('a rota de envio só passa byOwner quando o pedido é do navegador (nunca do corpo), e o index liga a dep ao chats.dismissQuestion', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    // Fora do navegador a mensagem é de outro funcionário: `auto` (espera o projeto pausado ser retomado, ver tests/projectPause.test.ts).
    expect(src).toContain('tasks.hold(b.sessionId, { text: b.text, images: b.images, origin, ...(fromBrowser ? { byOwner: true as const } : { auto: true as const }) })');
    expect(src).toContain('dismissQuestion: (sid) => void chats.dismissQuestion(sid)');
  });
});

describe('excluir o ajuste guardado (discardHeld)', () => {
  it('remove o ajuste (e as imagens dele), anota no histórico e devolve a tarefa', async () => {
    const b = await board('discard-ok', { busy: true });
    expect(await b.raw()).toContain(IMG);
    const out = await b.svc.discardHeld('p', 't-a', 'h-comum', true);
    expect(out?.held ?? []).toEqual([]);
    const t = await b.get('t-a');
    expect(t.held ?? []).toEqual([]);
    expect(t.history.at(-1)).toMatchObject({ by: 'auto', note: 'ajuste guardado excluído por você' });
    expect(await b.raw()).not.toContain(IMG); // as imagens eram data URL no tasks.json: saíram junto
    expect(b.delivered).toEqual([]);
    expect(b.h.sendToCalls).toBe(0);
  });

  it('só tira o escolhido: os outros ajustes seguem guardados', async () => {
    const b = await board('discard-um', { busy: true, held: (now) => [commonHeld(now), { ...commonHeld(now), id: 'h-outro', text: 'e o menu' }] });
    await b.svc.discardHeld('p', 't-a', 'h-comum', true);
    expect((await b.get('t-a')).held?.map((m) => m.id)).toEqual(['h-outro']);
  });

  it('sem fromBrowser dá 403 (antes de ler a tarefa) e não mexe em nada', async () => {
    const b = await board('discard-403', { busy: true });
    const before = await b.raw();
    await expect(b.svc.discardHeld('p', 't-a', 'h-comum', false)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(b.svc.discardHeld('p', 't-nao-existe', 'h-comum', false)).rejects.toBeInstanceOf(TaskForbiddenError); // nem 404 vaza a quem não é a tela
    expect(await b.raw()).toBe(before);
  });

  it('tarefa que não existe: null (404)', async () => {
    const b = await board('discard-404', { busy: true });
    expect(await b.svc.discardHeld('p', 't-nao-existe', 'h-comum', true)).toBeNull();
  });

  it('id que não está (mais) guardado: 409 com texto claro, e o que sobrou fica', async () => {
    const b = await board('discard-409', { busy: true });
    await expect(b.svc.discardHeld('p', 't-a', 'h-nao-existe', true)).rejects.toBeInstanceOf(TaskConflictError);
    await expect(b.svc.discardHeld('p', 't-a', 'h-nao-existe', true)).rejects.toThrow('já não está guardado');
    await b.svc.discardHeld('p', 't-a', 'h-comum', true);
    await expect(b.svc.discardHeld('p', 't-a', 'h-comum', true)).rejects.toThrow('já não está guardado'); // o 2º clique
    expect((await b.get('t-a')).history.filter((h) => h.note === 'ajuste guardado excluído por você')).toHaveLength(1);
  });

  it('resposta a dúvida (ask ou doubt) não se exclui: 409 e a mensagem segue guardada', async () => {
    const b = await board('discard-doubt', { busy: true, held: (now) => [askHeld(now), doubtHeld(now), commonHeld(now)] });
    for (const id of ['h-ask', 'h-doubt']) {
      await expect(b.svc.discardHeld('p', 't-a', id, true)).rejects.toBeInstanceOf(TaskConflictError);
      await expect(b.svc.discardHeld('p', 't-a', id, true)).rejects.toThrow('resposta a uma dúvida');
    }
    expect((await b.get('t-a')).held?.map((m) => m.id)).toEqual(['h-ask', 'h-doubt', 'h-comum']);
    await b.svc.discardHeld('p', 't-a', 'h-comum', true); // o comum do mesmo card sai
    expect((await b.get('t-a')).held?.map((m) => m.id)).toEqual(['h-ask', 'h-doubt']);
  });

  it('não corre com a entrega: descartar espera a vez dele; se o envio já tirou, 409 e a mensagem foi UMA vez', async () => {
    const b = await board('discard-lock');
    let release!: () => void;
    b.h.gate = new Promise<void>((r) => (release = r));
    const kick = b.svc.kickStaff('p', 'ana-1');
    await until(() => b.h.sendToCalls === 1); // a entrega está no meio do envio, com a vez do funcionário
    const discard = b.svc.discardHeld('p', 't-a', 'h-comum', true);
    let settled = false;
    void discard.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(settled).toBe(false); // esperando a vez, não passou por cima do envio
    release();
    await kick;
    await expect(discard).rejects.toBeInstanceOf(TaskConflictError);
    expect(b.delivered).toEqual([{ sessionId: 'ana-work', text: 'corrija o botão' }]);
    expect((await b.get('t-a')).held ?? []).toEqual([]);
  });

  it('excluído antes da entrega: a entrega que vem depois não manda nada', async () => {
    const b = await board('discard-antes');
    await b.svc.discardHeld('p', 't-a', 'h-comum', true);
    await b.svc.kickStaff('p', 'ana-1');
    expect(b.h.sendToCalls).toBe(0);
    expect(b.delivered).toEqual([]);
  });

  it('a rota: sem corpo, só `fromBrowser` autoriza, o id vem do caminho, e o 403/409 saem no mapa de erros', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    const route = /\/tasks\/\$\{ID\}\/held\/\$\{ID\}\/discard\$`\),([\s\S]*?)\n  \],/.exec(src)![1]!;
    expect(route).toContain('({ params: [id, taskId, heldId], fromBrowser })');
    expect(route).toContain('tasks.discardHeld(id!, taskId!, heldId!, fromBrowser)');
    expect(route).not.toContain('body');
    expect(src).toMatch(/err instanceof TaskConflictError\) return send\(res, 409/);
    expect(src).toMatch(/err instanceof TaskForbiddenError\) return send\(res, 403/);
  });
});

describe('heldItems: contrato para a tela', () => {
  it('devolve heldTaskId e heldDiscardable (false para ask/doubt) e mantém os campos de antes', async () => {
    const b = await board('items', { busy: true, held: (now) => [commonHeld(now), askHeld(now), doubtHeld(now)] });
    const items = await b.svc.heldItems('ana-work');
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ kind: 'user', id: 'h:h-comum', text: 'corrija o botão', at: expect.any(String), held: 'espera a Ana', images: 1, heldTaskId: 't-a', heldDiscardable: true });
    expect(items[1]).toMatchObject({ id: 'h:h-ask', held: 'espera a Ana', heldTaskId: 't-a', heldDiscardable: false });
    expect(items[2]).toMatchObject({ id: 'h:h-doubt', heldTaskId: 't-a', heldDiscardable: false });
  });
});
