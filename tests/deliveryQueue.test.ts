import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CodexProcess } from '../server/chat/codexProcess';
import { TaskService } from '../server/tasks';
import type { Engine, StaffProfile, TestRun } from '../shared/model';
import { removeTemp } from './support/tmp';

// t-3f52ea: a fila do funcionário não anda enquanto a entrega dele espera (testes na fila da suíte, aviso ao gestor), e o aviso atrasado do fim do turno anterior levava à revisão
// um card cujo ajuste guardado acabara de ir. Aqui: (1) a entrega solta a vez dele depois do commit e do resumo, (2) o aviso atrasado do turno anterior não entrega nem retém o card
// do ajuste (Claude e Codex), (3) o que sai depois dos testes (testes, aviso, revisão) é só da entrega que os pediu.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-delivq-'));
});
afterAll(() => removeTemp(root));

const PAST = '2020-01-01T00:00:00';
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: PAST, GIT_COMMITTER_DATE: PAST } }).toString();
const profile = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, reportsTo: [], ...extra }) as StaffProfile;
const passed = (command: string): TestRun => ({ command, ok: true, output: '', ms: 1, at: '2026-11-19T12:00:00Z' });
const tick = () => new Promise((r) => setTimeout(r, 15));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Live = { busy: boolean; background: Array<{ id: string; kind: 'shell'; label: string }> };

/**
 * Ana faz, Gio pediu (e `rui-1` revisa, sem ser quem pediu: a revisão automática abre e o aviso sai na entrega). `repo`: a pasta é um repositório git sem mudança (o "sem código" vale).
 * `h.live`: o que a conversa tem agora (turno e segundo plano), como o `ChatManager.liveWork`; `sendTo` acende o `busy`, como o envio de verdade (`ChatProcess.send`, `CodexProcess.send`).
 */
async function club(dirName: string, opts: { repo?: boolean; engine?: Engine } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^5.1.0' }, scripts: { test: 'vitest run' } }));
  // Fora de repositório, o arquivo que o card "alterou": as provas da entrega (testes relacionados) rodam sobre os arquivos alterados (ver `begin`). Num repositório ele sujaria o git do card "sem código".
  if (!opts.repo) {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'feature.ts'), 'export const feature = 1;\n');
  }
  if (opts.repo) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'add', 'package.json');
    git(dir, 'commit', '-q', '-m', 'base');
  }
  const engine = opts.engine ?? 'claude';
  const people: Record<string, StaffProfile> = {
    'gio-1': profile('gio-1', 'Gio', { role: 'Orquestrador', engine }),
    'ana-1': profile('ana-1', 'Ana', { engine, reportsTo: ['gio-1'] }),
    'rui-1': profile('rui-1', 'Rui', { role: 'Revisor', engine }),
  };
  const h = {
    started: [] as Array<{ staffId: string; session: string; reviewOnly: boolean }>,
    sentTo: [] as Array<{ session: string; text: string }>,
    notified: [] as Array<{ staffId: string; text: string }>,
    notifyCalls: 0,
    testCalls: [] as string[],
    texts: {} as Record<string, string>,
    live: {} as Record<string, Live>,
    n: 0,
    testsGate: null as null | ReturnType<typeof deferred<TestRun>>,
    notifyGate: null as null | ReturnType<typeof deferred<void>>,
    sendGate: null as null | ReturnType<typeof deferred<void>>,
    testsFail: false,
    notifyFails: false,
    /** O que `sendTo` faz além de gravar (o Codex de verdade manda a mensagem ao processo). */
    sendHook: null as null | ((session: string, text: string) => void),
    liveWork: null as null | ((session: string) => Live | null),
  };
  const liveOf = (s: string): Live | null => (h.liveWork ? h.liveWork(s) : (h.live[s] ?? null));
  const setLive = (s: string, busy: boolean, background: Live['background'] = []) => void (h.live[s] = { busy, background });
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, _text, _force, _override, reviewOnly) => {
      const session = `${staffId}-${++h.n}`;
      h.started.push({ staffId, session, reviewOnly: !!reviewOnly });
      if (!reviewOnly) setLive(session, true);
      return session;
    },
    branchFor: async () => null,
    isWorking: (_p, _s, except) => {
      const skip = typeof except === 'string' ? [except] : [...(except ?? [])];
      return Object.keys(h.live).some((s) => !skip.includes(s) && liveOf(s)?.busy);
    },
    liveWork: (s) => liveOf(s),
    sendTo: async (_p, session, _s, text) => {
      h.sentTo.push({ session, text });
      await h.sendGate?.promise;
      if (h.sendHook) h.sendHook(session, text);
      else setLive(session, true);
      return session;
    },
    runTests: async (_cwd, command) => {
      h.testCalls.push(command);
      if (h.testsFail) throw new Error('a suíte caiu');
      return h.testsGate ? h.testsGate.promise : passed(command);
    },
    notify: async (_p, staffId, text) => {
      h.notifyCalls++;
      await h.notifyGate?.promise;
      if (h.notifyFails) throw new Error('conversa dele não abriu');
      h.notified.push({ staffId, text });
    },
    lastText: (s) => h.texts[s] ?? null,
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
    log: () => {},
  });
  const file = path.join(dir, '.myco', 'tasks.json');
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  const edit = async (id: string, fn: (t: Record<string, any>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all.find((t) => t.id === id)!);
    await fs.writeFile(file, JSON.stringify(all));
  };
  /** O card de Ana, pedido por Gio (revisor `rui-1`), já começado (ou na fila, se ela está ocupada); devolve o id e a conversa de trabalho (vazia se ficou na fila). */
  const begin = async (title: string) => {
    const t = (await svc.create('p', { title, description: 'Faça.', staffId: 'ana-1', reviewerId: 'rui-1' }, 'gio-1', 'gio-s'))!;
    await svc.start('p', t.id);
    if (!opts.repo) await edit(t.id, (x) => (x.changedFiles = ['src/feature.ts']));
    return { id: t.id, work: (await get(t.id)).sessionId! };
  };
  const held = (text = 'Corrija o item R1.') => ({ id: 'h1', at: new Date().toISOString(), text, reason: 'espera Ana terminar a conversa em que está' });
  /** Quantos esperam a vez de Ana: a prova de que o aviso atrasado já chegou ao `locked`. */
  const waiting = () => ((svc as any).lockState.get('p:ana-1')?.waiting ?? 0) as number;
  const reviews = () => h.started.filter((s) => s.reviewOnly);
  return { dir, h, svc, get, list, edit, begin, held, setLive, waiting, reviews };
}

describe('a entrega não segura a fila do funcionário', () => {
  it('testes e aviso ao gestor pendurados: a próxima tarefa começa logo depois da entrega, e o resto sai quando soltam', async () => {
    const b = await club('fila-solta');
    b.h.testsGate = deferred<TestRun>();
    b.h.notifyGate = deferred();
    const first = await b.begin('Primeira');
    const second = await b.begin('Segunda');
    expect((await b.get(second.id)).status).toBe('todo');

    b.setLive(first.work, false);
    b.h.texts[first.work] = 'Entreguei a primeira.';
    const delivering = b.svc.onTurnDone(first.work);

    // A suíte está na fila da máquina e o aviso nem saiu; a segunda tarefa já roda, e o card da primeira já está em revisão, com commit e resumo.
    await vi.waitFor(async () => expect((await b.get(second.id)).status).toBe('doing'));
    await vi.waitFor(() => expect(b.h.testCalls).toHaveLength(1));
    expect(b.h.notifyCalls).toBe(0);
    expect(await b.get(first.id)).toMatchObject({ status: 'review', delivery: { summary: 'Entreguei a primeira.' } });
    expect(b.h.started.filter((s) => !s.reviewOnly).map((s) => s.session)).toEqual(['ana-1-1', 'ana-1-2']);
    expect(b.reviews()).toHaveLength(0);
    expect(await b.svc.queueStates('p')).toMatchObject([{ staffId: 'ana-1', state: 'busy', taskId: second.id, deliveries: [{ taskId: first.id, phase: 'tests' }] }]);

    // Os testes voltam: o aviso (pendurado) segura só a entrega, não a fila.
    b.h.testsGate.resolve(passed('npm test'));
    await vi.waitFor(() => expect(b.h.notifyCalls).toBe(1));
    expect((await b.get(second.id)).status).toBe('doing');
    expect((await b.svc.queueStates('p'))![0]!.deliveries).toMatchObject([{ taskId: first.id, phase: 'notice' }]);
    b.h.notifyGate.resolve();
    await delivering;

    expect(b.h.notified).toHaveLength(1);
    expect(b.h.notified[0]!.text).toContain('Entreguei a primeira.');
    expect(b.reviews()).toHaveLength(1);
    expect(await b.get(first.id)).toMatchObject({ status: 'review', tests: { ok: true }, review: { staffId: 'rui-1' } });
    expect((await b.svc.queueStates('p'))![0]!.deliveries).toEqual([]);
  });

  it('o aviso leva o resumo gravado na entrega, não o texto que a conversa tem quando os testes acabam', async () => {
    const b = await club('resumo-gravado');
    b.h.testsGate = deferred<TestRun>();
    const first = await b.begin('Primeira');
    const second = await b.begin('Segunda');
    b.setLive(first.work, false);
    b.h.texts[first.work] = 'Entreguei a primeira.';
    const delivering = b.svc.onTurnDone(first.work);
    await vi.waitFor(async () => expect((await b.get(second.id)).status).toBe('doing'));

    // A fila andou e a conversa seguiu: o `lastText` dela já é de outro turno.
    b.h.texts[first.work] = 'Resposta do turno seguinte.';
    b.h.testsGate.resolve(passed('npm test'));
    await delivering;

    expect(b.h.notified).toHaveLength(1);
    expect(b.h.notified[0]!.text).toContain('Entreguei a primeira.');
    expect(b.h.notified[0]!.text).not.toContain('Resposta do turno seguinte.');
    expect((await b.get(first.id)).delivery?.summary).toBe('Entreguei a primeira.');
  });

  it('cancelada durante os testes: nada de testes gravados, aviso nem revisão', async () => {
    const b = await club('cancelada-nos-testes');
    b.h.testsGate = deferred<TestRun>();
    const first = await b.begin('Primeira');
    b.setLive(first.work, false);
    const delivering = b.svc.onTurnDone(first.work);
    await vi.waitFor(() => expect(b.h.testCalls).toHaveLength(1));
    expect((await b.get(first.id)).status).toBe('review');

    await b.svc.cancel('p', first.id, { by: 'user' });
    b.h.testsGate.resolve(passed('npm test'));
    await delivering;

    expect(await b.get(first.id)).toMatchObject({ status: 'cancelled' });
    expect((await b.get(first.id)).tests).toBeUndefined();
    // Só o aviso do cancelamento (o de sempre): o "entregou" desta entrega, que já não existe, não sai.
    expect(b.h.notified.map((n) => n.text)).toEqual([expect.stringContaining('foi cancelada pelo usuário')]);
    expect(b.reviews()).toEqual([]);
  });

  it('entregue de novo durante os testes: os testes e o aviso velhos não saem, e a revisão não é pedida por esta entrega', async () => {
    const b = await club('entregue-de-novo');
    b.h.testsGate = deferred<TestRun>();
    const first = await b.begin('Primeira');
    b.setLive(first.work, false);
    const delivering = b.svc.onTurnDone(first.work);
    await vi.waitFor(() => expect(b.h.testCalls).toHaveLength(1));

    // Outra entrega do mesmo card (a hora dela muda) enquanto a suíte da primeira roda.
    await b.edit(first.id, (t) => (t.delivery = { ...t.delivery, at: '2030-01-01T00:00:00.000Z' }));
    b.h.testsGate.resolve(passed('npm test'));
    await delivering;

    expect((await b.get(first.id)).tests).toBeUndefined();
    expect(b.h.notified).toEqual([]);
    expect(b.reviews()).toEqual([]);
  });

  it('a suíte que cai ou o aviso que não chega não impedem a revisão', async () => {
    const quebrada = await club('suite-cai');
    quebrada.h.testsFail = true;
    const a = await quebrada.begin('Primeira');
    quebrada.setLive(a.work, false);
    await quebrada.svc.onTurnDone(a.work);
    expect(await quebrada.get(a.id)).toMatchObject({ status: 'review', review: { staffId: 'rui-1' } });
    expect((await quebrada.get(a.id)).tests).toBeUndefined();
    expect(quebrada.h.notified).toHaveLength(1);
    expect(quebrada.reviews()).toHaveLength(1);

    const semAviso = await club('aviso-cai');
    semAviso.h.notifyFails = true;
    const c = await semAviso.begin('Primeira');
    semAviso.setLive(c.work, false);
    await semAviso.svc.onTurnDone(c.work);
    expect(await semAviso.get(c.id)).toMatchObject({ status: 'review', tests: { ok: true }, review: { staffId: 'rui-1' } });
    expect(semAviso.reviews()).toHaveLength(1);
  });
});

describe('o aviso atrasado do fim do turno anterior (o ajuste guardado já foi)', () => {
  it('não entrega: o card segue em fazendo; o fim do turno do ajuste entrega uma vez, com o resumo novo', async () => {
    const b = await club('corrida-claude');
    const { id, work } = await b.begin('Ajuste');
    b.setLive(work, false); // o turno terminou...
    b.h.texts[work] = 'Nada corrigido.';
    await b.edit(id, (t) => (t.held = [b.held()]));

    await b.svc.kickStaff('p', 'ana-1'); // ...a vez dele manda o ajuste guardado (busy acende no envio)...
    expect(b.h.sentTo).toEqual([{ session: work, text: 'Corrija o item R1.' }]);

    // ...e só então chegam os dois avisos do fim do turno ANTERIOR (o vigia e o processo).
    await b.svc.onTurnDone(work);
    await b.svc.onIdle(work, 'p', 'ana-1', 'turn', 'claude');
    let t = await b.get(id);
    expect(t.status).toBe('doing');
    expect(t.delivery).toBeUndefined();
    expect(t.history.at(-1)?.note).toBe('ajuste guardado enviado');
    expect(b.h.notified).toEqual([]);
    expect(b.h.testCalls).toEqual([]);
    expect(b.reviews()).toEqual([]);

    // O turno do ajuste termina (os dois avisos de novo): entrega uma vez, com o resumo dele.
    b.setLive(work, false);
    b.h.texts[work] = 'Corrigi o item R1.';
    await b.svc.onTurnDone(work);
    await b.svc.onIdle(work, 'p', 'ana-1', 'turn', 'claude');
    t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.delivery?.summary).toBe('Corrigi o item R1.');
    expect(t.history.filter((h) => h.status === 'review')).toHaveLength(1);
    expect(b.h.notified).toHaveLength(1);
    expect(b.h.notified[0]!.text).toContain('Corrigi o item R1.');
    expect(b.h.testCalls).toHaveLength(1);
    expect(b.reviews()).toHaveLength(1);
  });

  it('o que já passou da primeira conferência e espera a vez do envio também não entrega: a conferência vale dentro da vez', async () => {
    const b = await club('corrida-na-vez');
    const { id, work } = await b.begin('Ajuste');
    b.setLive(work, false);
    b.h.texts[work] = 'Nada corrigido.';
    await b.edit(id, (t) => (t.held = [b.held()]));
    b.h.sendGate = deferred();

    const kicked = b.svc.kickStaff('p', 'ana-1'); // o envio do ajuste tem a vez dele e espera (o busy ainda não acendeu)
    await vi.waitFor(() => expect(b.h.sentTo).toHaveLength(1));
    const stale = b.svc.onTurnDone(work); // conversa parada: passa pela primeira conferência e espera a vez para entregar
    await vi.waitFor(() => expect(b.waiting()).toBeGreaterThan(0));
    b.h.sendGate.resolve(); // o envio acende o busy e solta a vez
    await kicked;
    await stale;

    const t = await b.get(id);
    expect(t.status).toBe('doing');
    expect(t.delivery).toBeUndefined();
    expect(b.h.notified).toEqual([]);
    expect(b.reviews()).toEqual([]);
  });

  it('com a conversa em turno novo o aviso atrasado nem lê o segundo plano: o card do ajuste não ganha espera nem nota', async () => {
    const b = await club('corrida-retencoes');
    const { id, work } = await b.begin('Ajuste');
    const before = (await b.get(id)).history.length;
    b.setLive(work, true, [{ id: 'b1', kind: 'shell', label: 'npm run mutation' }]); // turno novo rodando, com um comando em segundo plano
    b.h.texts[work] = 'Lote A rodando em segundo plano; retomo quando terminar.';
    await b.svc.onTurnDone(work);

    const t = await b.get(id);
    expect(t.backgroundWait).toBeUndefined();
    expect(t.history).toHaveLength(before);
    expect(t.status).toBe('doing');
    expect(b.h.notified).toEqual([]);
  });

  it('o card sem edição não é marcado "sem código" por esse aviso: a conferência vale dentro da vez', async () => {
    const b = await club('corrida-sem-codigo', { repo: true });
    const { id, work } = await b.begin('Ajuste');
    b.setLive(work, false);
    b.h.texts[work] = 'Nada a alterar.';
    await b.edit(id, (t) => (t.held = [b.held()]));
    b.h.sendGate = deferred();

    const kicked = b.svc.kickStaff('p', 'ana-1');
    await vi.waitFor(() => expect(b.h.sentTo).toHaveLength(1));
    const stale = b.svc.onTurnDone(work); // sem edição no git: iria marcar "sem código" e esperar a vez para isso
    await vi.waitFor(() => expect(b.waiting()).toBeGreaterThan(0));
    b.h.sendGate.resolve();
    await kicked;
    await stale;

    const t = await b.get(id);
    expect(t.noCode).toBeUndefined();
    expect(t.status).toBe('doing');
    expect(b.h.notified).toEqual([]);
  });

  it('sem a corrida o fim do turno entrega como sempre (a conferência não segura entrega de turno que terminou)', async () => {
    const b = await club('sem-corrida');
    const { id, work } = await b.begin('Normal');
    b.setLive(work, false);
    b.h.texts[work] = 'Pronto.';
    await b.svc.onTurnDone(work);
    expect(await b.get(id)).toMatchObject({ status: 'review', delivery: { summary: 'Pronto.' } });
    expect(b.h.notified).toHaveLength(1);
  });
});

// O Codex: uma execução por mensagem, e o `busy` acende no `send` (antes de o processo responder), como o do Claude. Aqui o `liveWork` é o do CodexProcess de verdade.
describe('o mesmo no Codex (CodexProcess de verdade, codex falso)', () => {
  const fixture = async (name: string) =>
    (await fs.readFile(path.join(process.cwd(), 'tests', 'fixtures', 'codex', `${name}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

  /** Cada `spawn` é uma execução falsa: `emit` simula o stdout, `close` o fim do processo. */
  function fakeCodex() {
    const runs: Array<{ emit: (ev: object) => void; close: (code?: number | null) => void }> = [];
    const spawnImpl = () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 4242 + runs.length });
      runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'), close: (code = 0) => void child.emit('close', code) });
      return child as never;
    };
    return { runs, spawnImpl };
  }

  it('o ajuste vai (o busy acende no envio), o aviso atrasado não entrega, e o fim do turno do ajuste entrega com o resumo novo', async () => {
    const b = await club('corrida-codex', { engine: 'codex' });
    const { id, work } = await b.begin('Ajuste');
    const f = fakeCodex();
    const forward: Array<Promise<void>> = [];
    let forwarding = false;
    const chat = new CodexProcess({
      cwd: '/proj',
      sessionId: work,
      permissionMode: 'default',
      secrets: { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' },
      threadFile: path.join(root, work, 'codex-thread.json'),
      spawnImpl: f.spawnImpl,
      // O que o manager faz: o fim do turno do processo vai para a tarefa (só depois do ajuste, para não entregar o primeiro turno).
      onIdle: (reason) => {
        if (forwarding) forward.push(b.svc.onIdle(work, 'p', 'ana-1', reason, 'codex'));
      },
    });
    b.h.liveWork = (s) => (s === work && chat.running ? { busy: chat.busy, background: [] } : null);
    b.h.sendHook = (_session, text) => chat.send(text, 'next', []);
    chat.start();

    // O primeiro turno acaba.
    chat.send('primeiro turno', 'next', []);
    for (const ev of await fixture('comando-ls')) f.runs[0]!.emit(ev);
    await tick();
    f.runs[0]!.close(0);
    await tick();
    expect(chat.busy).toBe(false);
    b.h.texts[work] = 'Nada corrigido.';
    await b.edit(id, (t) => (t.held = [b.held()]));

    // A vez dele manda o ajuste: no mesmo instante o busy já acendeu, antes de qualquer evento do processo.
    await b.svc.kickStaff('p', 'ana-1');
    expect(f.runs).toHaveLength(2);
    expect(chat.busy).toBe(true);
    expect(b.h.liveWork(work)).toMatchObject({ busy: true });

    // O aviso atrasado do primeiro turno (o vigia e o processo): não entrega.
    await b.svc.onIdle(work, 'p', 'ana-1', 'turn', 'codex');
    await b.svc.onTurnDone(work);
    let t = await b.get(id);
    expect(t.status).toBe('doing');
    expect(t.delivery).toBeUndefined();
    expect(b.h.notified).toEqual([]);

    // O turno do ajuste termina de verdade (turn.completed): é ele que entrega, com o resumo dele.
    forwarding = true;
    b.h.texts[work] = 'Corrigi o item R1.';
    for (const ev of await fixture('comando-ls')) f.runs[1]!.emit(ev);
    await tick();
    f.runs[1]!.close(0);
    await tick();
    await Promise.all(forward);
    t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.delivery?.summary).toBe('Corrigi o item R1.');
    expect(b.h.notified).toHaveLength(1);
    expect(b.h.notified[0]!.text).toContain('Corrigi o item R1.');
  });
});
