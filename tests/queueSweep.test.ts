import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskService } from '../server/tasks';
import type { StaffProfile, UsageStopHit } from '../shared/model';
import { removeTemp } from './support/tmp';

// Nenhum card esquecido em "a fazer" (t-d74d52): o que não tem nada que o segure entra na fila do responsável sozinho, pela varredura do `tick`
// (que também roda na subida). Ocupado, espera a vez; livre, começa. Aguardar, dependência pendente, dúvida aberta, sem responsável e "tirar da fila"
// de propósito ficam como estão.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-sweep-'));
});
afterAll(() => removeTemp(root));

const ana = { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile;

/** Ana com a fila vazia. `state.busy`: ela está numa conversa. `state.working`: conversas dela trabalhando agora. `state.fail`: erro ao abrir conversa. */
async function club(dirName: string) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  const state = { busy: false, working: new Set<string>(), fail: null as Error | null, stop: null as UsageStopHit | null, sent: [] as string[], sentTo: [] as Array<{ session: string; text: string }> };
  let n = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
    send: async (_p, _s, text) => {
      if (state.fail) throw state.fail;
      state.sent.push(/\[Tarefa "(.+?)"\]/.exec(text)![1]!);
      return `s-${++n}`;
    },
    sendTo: async (_p, session, _s, text) => {
      state.sentTo.push({ session, text });
      return session;
    },
    branchFor: async () => null,
    isWorking: () => state.busy,
    isSessionWorking: (session) => state.working.has(session),
    stopHit: async () => state.stop,
    apiUrl: 'http://127.0.0.1:4848',
  });
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  /** Um card em "a fazer", fora da fila (como `create` o deixa). */
  const make = async (title: string, extra: Record<string, unknown> = {}) => (await svc.create('p', { title, staffId: 'ana-1', ...extra }))!;
  /** Muda o arquivo por fora (o estado em que o card ficou). */
  const edit = async (id: string, fn: (t: Record<string, any>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all.find((t) => t.id === id)!);
    await fs.writeFile(file, JSON.stringify(all));
  };
  return { svc, state, get, make, edit, list };
}

describe('varredura de "a fazer"', () => {
  it('card livre, fora da fila, com o responsável livre: entra na fila e começa no mesmo tick', async () => {
    const b = await club('livre');
    const t = await b.make('Esquecido');
    expect(await b.get(t.id)).toMatchObject({ status: 'todo', sessionId: null });
    expect((await b.get(t.id)).queuedAt ?? null).toBeNull();
    await b.svc.tick();
    expect(b.state.sent).toEqual(['Esquecido']);
    const after = await b.get(t.id);
    expect(after).toMatchObject({ status: 'doing', sessionId: 's-1', queuedAt: null });
    expect(after.history.some((h) => h.note?.startsWith('em a fazer fora da fila: entrou na fila'))).toBe(true);
  });

  it('responsável ocupado: entra na fila e espera a vez (não está empacado); quando ele libera, começa', async () => {
    const b = await club('ocupado');
    b.state.busy = true;
    const t = await b.make('Na fila');
    await b.svc.tick();
    expect(b.state.sent).toEqual([]);
    expect(await b.get(t.id)).toMatchObject({ status: 'todo', queuedAt: expect.any(String), sessionId: null });
    await b.svc.tick(); // segue esperando, sem entrar de novo nem gastar nota
    expect((await b.get(t.id)).history.filter((h) => h.note?.startsWith('em a fazer fora da fila'))).toHaveLength(1);
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sent).toEqual(['Na fila']);
    expect(await b.get(t.id)).toMatchObject({ status: 'doing', queuedAt: null });
  });

  it('a ordem da fila é a da varredura (a mais antiga do quadro primeiro) e só uma tarefa por vez por funcionário', async () => {
    const b = await club('ordem');
    const a = await b.make('A');
    const c = await b.make('B');
    await b.svc.tick();
    // A abre a conversa dela; B espera, porque a Ana passa a ter uma conversa trabalhando.
    b.state.busy = true;
    await b.svc.tick();
    expect(b.state.sent).toEqual(['A']);
    expect(await b.get(a.id)).toMatchObject({ status: 'doing' });
    expect(await b.get(c.id)).toMatchObject({ status: 'todo', queuedAt: expect.any(String) });
  });

  it('desbloqueado (a dependência ficou pronta) começa; enquanto a dependência está pendente, não entra na fila', async () => {
    const b = await club('deps');
    const base = await b.make('Base', { start: false }); // Aguardar: ninguém começa
    const x = await b.make('Depende', { blockedBy: [base.id] });
    await b.svc.tick();
    expect(b.state.sent).toEqual([]);
    expect(await b.get(x.id)).toMatchObject({ status: 'todo' });
    expect((await b.get(x.id)).queuedAt ?? null).toBeNull();
    await b.svc.update('p', base.id, { status: 'done' });
    await b.svc.tick();
    expect(b.state.sent).toEqual(['Depende']);
    expect(await b.get(x.id)).toMatchObject({ status: 'doing' });
  });

  it('não começa: em Aguardar, com dúvida aberta, sem responsável e o que você tirou da fila de propósito', async () => {
    const b = await club('nao-comeca');
    const waiting = await b.make('Aguardando', { start: false });
    const doubt = await b.make('Com dúvida');
    await b.edit(doubt.id, (t) => (t.question = { id: 'q-1', source: 'text', text: 'DÚVIDA: x?', status: 'open', askedAt: new Date().toISOString() }));
    const nobody = await b.make('Sem responsável', { staffId: null });
    const off = await b.make('Tirada da fila');
    await b.svc.update('p', off.id, { queued: false });
    await b.svc.tick();
    await b.svc.tick();
    expect(b.state.sent).toEqual([]);
    for (const t of [waiting, doubt, nobody, off]) {
      const now = await b.get(t.id);
      expect(now.queuedAt ?? null).toBeNull();
      expect(now.sessionId).toBeNull();
    }
    expect((await b.get(waiting.id)).status).toBe('waiting');
    expect(await b.get(off.id)).toMatchObject({ status: 'todo', unqueued: true });
  });

  it('"Começar" depois de "tirar da fila" vale: a marca sai e o card anda como qualquer outro', async () => {
    const b = await club('comecar');
    const t = await b.make('Tirada');
    await b.svc.update('p', t.id, { queued: false });
    await b.svc.tick();
    expect(b.state.sent).toEqual([]);
    await b.svc.start('p', t.id);
    expect(b.state.sent).toEqual(['Tirada']);
    expect(await b.get(t.id)).toMatchObject({ status: 'doing' });
    expect((await b.get(t.id)).unqueued).toBeUndefined();
  });

  it('reabrir uma cancelada não a começa sozinha (continua sendo escolha sua)', async () => {
    const b = await club('reabrir');
    const t = await b.make('Cancelada');
    await b.svc.cancel('p', t.id, { by: 'user' });
    await b.svc.reopen('p', t.id);
    await b.svc.tick();
    expect(b.state.sent).toEqual([]);
    expect(await b.get(t.id)).toMatchObject({ status: 'todo', queuedAt: null, unqueued: true });
  });

  it('a partida que falha por motivo dela fica na fila com backoff: o tick não repete o erro a cada rodada', async () => {
    const b = await club('falha');
    const t = await b.make('Quebrada');
    b.state.fail = new Error('a worktree dela não abriu');
    await b.svc.tick();
    await b.svc.tick();
    await b.svc.tick();
    expect(await b.get(t.id)).toMatchObject({ status: 'todo', queuedAt: expect.any(String), startRetry: { attempts: 1, lastError: 'a worktree dela não abriu' } });
  });

  it('no máximo 5 cards entram na fila por rodada (um reinício com muitos esquecidos não os põe todos juntos)', async () => {
    const b = await club('teto');
    b.state.busy = true;
    for (let i = 0; i < 7; i++) await b.make(`C${i}`);
    await b.svc.tick();
    expect((await b.list()).filter((t) => t.queuedAt)).toHaveLength(5);
    await b.svc.tick();
    expect((await b.list()).filter((t) => t.queuedAt)).toHaveLength(7);
  });
});

describe('a fazer com a conversa que o card já teve (arrastado de volta)', () => {
  /** O card começou (conversa s-1), foi entregue e você o arrastou de volta para "a fazer". */
  async function voltou(dirName: string) {
    const b = await club(dirName);
    const t = await b.make('Refazer', { description: 'Refaça a tela.' });
    await b.svc.start('p', t.id);
    expect(await b.get(t.id)).toMatchObject({ status: 'doing', sessionId: 's-1' });
    await b.edit(t.id, (x) => {
      x.status = 'todo';
      x.queuedAt = null;
    });
    return { b, id: t.id };
  }

  it('conversa parada: o card entra na fila e a vez dele retoma essa conversa (sem abrir outra), e ele vai para fazendo', async () => {
    const { b, id } = await voltou('volta-parada');
    await b.svc.tick();
    expect(b.state.sent).toEqual(['Refazer']); // só a abertura de antes: nenhuma conversa nova
    expect(b.state.sentTo).toHaveLength(1);
    expect(b.state.sentTo[0]).toMatchObject({ session: 's-1' });
    expect(b.state.sentTo[0]!.text).toContain('voltou para "A fazer"');
    expect(b.state.sentTo[0]!.text).toContain('Refaça a tela.');
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'doing', sessionId: 's-1', queuedAt: null });
    expect(t.history.at(-1)?.note).toContain('retomada na fila');
  });

  it('conversa trabalhando agora (o ajuste guardado já foi para ela): o card só volta para fazendo, sem mandar nada', async () => {
    const { b, id } = await voltou('volta-trabalhando');
    b.state.working.add('s-1');
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'doing', sessionId: 's-1' });
  });

  it('a linha de parada do consumo segura a retomada: o card fica na fila, sem mandar nada', async () => {
    const { b, id } = await voltou('volta-consumo');
    b.state.stop = { kind: 'five_hour', percentUsed: 97, limit: 95, resetsAt: null };
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'todo', queuedAt: expect.any(String), sessionId: 's-1' });
    b.state.stop = null;
    await b.svc.tick();
    expect(b.state.sentTo).toHaveLength(1);
    expect(await b.get(id)).toMatchObject({ status: 'doing' });
  });
});

