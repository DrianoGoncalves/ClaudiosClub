import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskService } from '../server/tasks';
import type { StaffProfile, TurnCapHit } from '../shared/model';

// Conversa de tarefa que morre no meio volta sozinha (t-f89dcd), o caso da t-2f3ff3: o card ficou em "a fazer" (queuedAt null, sessionId preenchido)
// enquanto o ajuste guardado levava a conversa a trabalhar por fora do status; ela morreu e nada a retomava.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-dead-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const ana = { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile;

/**
 * Ana com a fila vazia. `state.busy`: ela está numa conversa (qualquer). `state.working`: as conversas que trabalham agora (as dela mortas = fora do conjunto).
 * `state.cap`: o motivo guardado da parada (`turnCap`); `state.cut`: o que a checagem do transcript acha (`restartCut`).
 */
async function club(dirName: string) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  const state = {
    busy: false,
    working: new Set<string>(),
    /** Falha o envio cujo texto tem isto (o ajuste, sem derrubar a retomada). */
    failOn: null as string | null,
    cap: null as TurnCapHit | null,
    cut: null as TurnCapHit | Error | null,
    gate: null as { ok: false; reason: string } | null,
    sentTo: [] as Array<{ session: string; text: string }>,
    cutAsked: [] as string[],
  };
  let n = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
    send: async () => `s-${++n}`,
    sendTo: async (_p, session, _s, text) => {
      if (state.failOn && text.includes(state.failOn)) throw new Error('a conversa está fechando');
      state.sentTo.push({ session, text });
      return session;
    },
    branchFor: async () => null,
    isWorking: () => state.busy,
    isSessionWorking: (session) => state.working.has(session),
    turnCap: () => state.cap,
    restartCut: async (_p, session) => {
      state.cutAsked.push(session);
      if (state.cut instanceof Error) throw state.cut;
      return state.cut;
    },
    resourceGate: async () => state.gate ?? { ok: true, release: () => {} },
    stopHit: async () => null,
    apiUrl: 'http://127.0.0.1:4848',
  });
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  const edit = async (id: string, fn: (t: Record<string, any>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all.find((t) => t.id === id)!);
    await fs.writeFile(file, JSON.stringify(all));
  };
  /** O card como a t-2f3ff3 ficou: em "a fazer", sem fila, com a conversa s-1 (que já trabalhou) e o que o `extra` disser. */
  const stuck = async (title: string, extra: Record<string, unknown> = {}) => {
    const t = (await svc.create('p', { title, staffId: 'ana-1', description: 'Revise a tela.' }))!;
    await svc.start('p', t.id); // abre a conversa s-1
    await edit(t.id, (x) => {
      x.status = 'todo';
      x.queuedAt = null;
      Object.assign(x, extra);
    });
    return t.id;
  };
  const held = (text = 'ajuste do dono') => ({ id: 'h1', at: new Date().toISOString(), text, reason: 'espera Ana terminar a conversa em que está' });
  return { svc, state, get, edit, list, stuck, held };
}

describe('ajuste guardado enviado leva o card para fazendo', () => {
  it('todo + sessionId + ajuste guardado + processo morto: vai o ajuste, o card sai da fila e fica em fazendo (com nota)', async () => {
    const b = await club('held-todo');
    const id = await b.stuck('Tupac', { held: [b.held()], queuedAt: new Date().toISOString() });
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([{ session: 's-1', text: 'ajuste do dono' }]); // só o ajuste: nada de "retome" por cima
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'doing', sessionId: 's-1', queuedAt: null, held: [] });
    expect(t.history.at(-1)).toMatchObject({ status: 'doing', by: 'auto', note: expect.stringContaining('ajuste guardado enviado') });
  });

  it('Aguardar com conversa: o ajuste enviado também a leva para fazendo, e o motivo de Aguardar sai', async () => {
    const b = await club('held-waiting');
    const id = await b.stuck('Parada', { held: [b.held()], status: 'waiting', waitReason: 'parou no teto' });
    await b.svc.tick();
    expect(await b.get(id)).toMatchObject({ status: 'doing', waitReason: null, held: [] });
  });

  it('já em fazendo ou planejando: segue como estava (só a nota)', async () => {
    const b = await club('held-doing');
    const a = await b.stuck('Fazendo', { held: [b.held()], status: 'doing' });
    await b.svc.tick();
    expect(await b.get(a)).toMatchObject({ status: 'doing', held: [] });
    expect((await b.get(a)).history.at(-1)?.note).toBe('ajuste guardado enviado');
    const p = await club('held-planning');
    const q = await p.stuck('Planejando', { held: [p.held()], status: 'planning' });
    await p.svc.tick();
    expect(await p.get(q)).toMatchObject({ status: 'planning', held: [] });
  });

  it('o responsável em outra conversa: o ajuste espera a vez, o card não é enfileirado nem retomado por cima dele', async () => {
    const b = await club('held-ocupado');
    const id = await b.stuck('Espera', { held: [b.held()] });
    b.state.busy = true;
    await b.svc.tick();
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'todo', queuedAt: null });
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([{ session: 's-1', text: 'ajuste do dono' }]);
    expect(await b.get(id)).toMatchObject({ status: 'doing' });
  });

  it('o ajuste que não foi (envio falhou): o card não recebe a retomada da fila por cima, fica com o ajuste para tentar de novo', async () => {
    const b = await club('held-falha');
    const id = await b.stuck('Falha', { held: [b.held()], queuedAt: new Date().toISOString() });
    b.state.failOn = 'ajuste do dono';
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'todo', held: [expect.objectContaining({ attempts: 1 })] });
  });
});

describe('card em a fazer com conversa morta volta sozinho', () => {
  it('sem ajuste e sem processo: entra na fila, a vez dele retoma a MESMA conversa e o card vai para fazendo', async () => {
    const b = await club('morta');
    const id = await b.stuck('Tupac');
    await b.svc.tick();
    expect(b.state.sentTo).toHaveLength(1);
    expect(b.state.sentTo[0]).toMatchObject({ session: 's-1' });
    expect(b.state.sentTo[0]!.text).toContain('retome-a nesta conversa');
    expect(await b.get(id)).toMatchObject({ status: 'doing', sessionId: 's-1', queuedAt: null });
  });

  it('o caso inteiro: ajuste enviado, a conversa morre no meio, a órfã a retoma (mesma conversa) e o card segue em fazendo', async () => {
    const b = await club('caso-t2f3ff3');
    const id = await b.stuck('Tupac', { held: [b.held()], updatedAt: '2026-11-17T01:03:00.000Z' });
    await b.svc.tick(); // 03:53/04:03: o ajuste vai e a conversa volta a trabalhar
    b.state.working.add('s-1');
    expect(await b.get(id)).toMatchObject({ status: 'doing' });
    b.state.working.delete('s-1'); // 04:19: morreu no meio
    await b.svc.tick(new Date(Date.now() + 3 * 60_000));
    expect(b.state.sentTo).toHaveLength(2);
    expect(b.state.sentTo[1]).toMatchObject({ session: 's-1', text: expect.stringContaining('Continue de onde parou') });
    expect(await b.get(id)).toMatchObject({ status: 'doing', sessionId: 's-1', resumedAt: expect.any(String) });
  });

  it('conversa que trabalha agora: o card só volta para fazendo, nada é mandado', async () => {
    const b = await club('viva');
    const id = await b.stuck('Viva');
    b.state.working.add('s-1');
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'doing' });
  });

  it('fila serial: o responsável em outra conversa não é interrompido; quando libera, o card retoma', async () => {
    const b = await club('serial');
    const id = await b.stuck('Espera');
    b.state.busy = true;
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'todo', queuedAt: expect.any(String) });
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sentTo).toHaveLength(1);
    expect(await b.get(id)).toMatchObject({ status: 'doing' });
  });

  it('gate de recursos: segura a retomada na fila, com o motivo; liberado, retoma', async () => {
    const b = await club('gate');
    const id = await b.stuck('Gate');
    b.state.gate = { ok: false, reason: 'pouca memória livre' };
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'todo', resourceWait: { reason: 'pouca memória livre' } });
    b.state.gate = null;
    await b.svc.tick();
    expect(b.state.sentTo).toHaveLength(1);
    expect(await b.get(id)).toMatchObject({ status: 'doing', resourceWait: null });
  });

  it('dependência pendente: não entra na fila nem retoma', async () => {
    const b = await club('bloqueado');
    const base = (await b.svc.create('p', { title: 'Base', staffId: 'ana-1', start: false }))!;
    const id = await b.stuck('Depende', { blockedBy: [base.id] });
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'todo', queuedAt: null });
  });
});

describe('ação cortada pela morte: efeito incerto vai para Aguardar, não é retomado', () => {
  const push: TurnCapHit = { kind: 'restart', action: 'git push origin main' };

  it('o transcript mostra uma ação externa pela metade: Aguardar com o motivo, nada mandado', async () => {
    const b = await club('corte-transcript');
    const id = await b.stuck('Corte');
    b.state.cut = push;
    await b.svc.tick();
    expect(b.state.cutAsked).toEqual(['s-1']);
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'waiting', queuedAt: null, waitReason: expect.stringContaining('git push origin main') });
    await b.svc.tick(); // já em Aguardar: nada de novo
    expect(b.state.sentTo).toEqual([]);
  });

  it('o corte já guardado pela retomada de turno (t-1c989e): Aguardar, sem nem reabrir a conta no transcript', async () => {
    const b = await club('corte-guardado');
    const id = await b.stuck('Corte');
    b.state.cap = { kind: 'retry', why: 'cut', action: 'em segundo plano: 2 executores', error: 'o processo caiu sem aviso' };
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'waiting', waitReason: expect.stringContaining('em segundo plano') });
  });

  it('teto de ferramentas guardado não é efeito incerto: a retomada segue', async () => {
    const b = await club('teto');
    const id = await b.stuck('Teto');
    b.state.cap = { kind: 'tools', limit: 200 };
    await b.svc.tick();
    expect(b.state.sentTo).toHaveLength(1);
    expect(await b.get(id)).toMatchObject({ status: 'doing' });
  });

  it('erro ao conferir o corte: retoma como a órfã', async () => {
    const b = await club('corte-erro');
    const id = await b.stuck('Erro');
    b.state.cut = new Error('sem transcript');
    await b.svc.tick();
    expect(b.state.sentTo).toHaveLength(1);
    expect(await b.get(id)).toMatchObject({ status: 'doing' });
  });
});
