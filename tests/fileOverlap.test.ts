import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffProfile, Task } from '../shared/model';
import { ProjectPauses } from '../server/projectPause';
import { readTasks, TaskService } from '../server/tasks';
import { removeTemp } from './support/tmp';

// Arquivo em comum entre tarefas abertas de pessoas diferentes (t-baa184): as duas conversas de trabalho são avisadas, uma vez por par de tarefas e
// arquivo; a sobreposição fica gravada nas duas (`Task.fileOverlaps`) e o pedido de revisão a cita. Claude e Codex passam pelo mesmo `onCodeEdit`.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-overlap-'));
});
afterAll(() => removeTemp(root));

const SAY = (file: string, id: string, name: string) => `${file} também está sendo editado na ${id} (${name}): releia antes de editar e não desfaça mudança alheia`;

function flow(dirName: string, engine: 'claude' | 'codex', extra: Partial<Record<string, Partial<StaffProfile>>> = {}) {
  const dir = path.join(root, dirName);
  const profile = (id: string, name: string, more: Partial<StaffProfile> = {}) =>
    ({ id, name, autonomy: 'acceptEdits', worktree: false, servers: [], engine, ...more, ...extra[id] }) as unknown as StaffProfile;
  const people: Record<string, StaffProfile> = {
    'ana-1': profile('ana-1', 'Ana'),
    'bia-1': profile('bia-1', 'Bia'),
    'rui-1': profile('rui-1', 'Rui', { autonomy: 'manual' }),
  };
  const notices: Array<{ sessionId: string; text: string }> = [];
  const sent: string[] = [];
  const state = { working: false, fail: null as string | null, gate: null as Promise<void> | null };
  const pauses = new ProjectPauses(path.join(root, `${dirName}-pausas.json`), () => {});
  let n = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, _staff, text) => {
      sent.push(text);
      return `s-${++n}`;
    },
    sendTo: async (_p, session) => session,
    sendNotice: async (_p, sessionId, _staff, text) => {
      if (state.gate) await state.gate;
      if (state.fail && sessionId === state.fail) throw new Error('conversa indisponível');
      notices.push({ sessionId, text });
      return sessionId;
    },
    branchFor: async () => null,
    isWorking: () => state.working,
    isSessionWorking: () => state.working,
    lastText: () => null,
    notify: async () => {},
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    apiUrl: 'http://127.0.0.1:4848',
    pauses,
  });
  const file = (...parts: string[]) => path.join(dir, ...parts);
  const tasksFile = path.join(dir, '.myco', 'tasks.json');
  /** Tarefa comum começada: devolve o id e a conversa de trabalho dela. */
  const doing = async (staffId: string, title: string) => {
    const t = (await svc.create('p', { title, description: title, staffId }))!;
    const started = (await svc.start('p', t.id))!;
    return { id: t.id, session: started.sessionId! };
  };
  const edit = (sessionId: string, staffId: string, files: string[]) =>
    svc.onCodeEdit({ sessionId, projectId: 'p', staffId, engine, cwd: dir, files, request: 'Ajuste o arquivo' });
  const patch = async (id: string, fields: Partial<Task>) => {
    const all = JSON.parse(await fs.readFile(tasksFile, 'utf8')) as Task[];
    Object.assign(all.find((t) => t.id === id)!, fields);
    await fs.writeFile(tasksFile, JSON.stringify(all));
  };
  const task = async (id: string) => (await readTasks(dir)).find((t) => t.id === id)!;
  const to = (session: string) => notices.filter((x) => x.sessionId === session);
  return { svc, dir, file, edit, doing, patch, task, notices, to, sent, state, pauses };
}

describe.each(['claude', 'codex'] as const)('arquivo em comum, motor %s', (engine) => {
  it('duas tarefas abertas de pessoas diferentes no mesmo arquivo: um aviso em cada conversa, uma vez só', async () => {
    const f = flow(`dois-${engine}`, engine);
    const a = await f.doing('ana-1', 'Tela A');
    const b = await f.doing('bia-1', 'Tela B');
    await f.edit(a.session, 'ana-1', [f.file('src', 'a.ts')]);
    await f.svc.overlapNoticesSettled();
    expect(f.notices).toEqual([]); // a primeira a editar não tem com quem dividir
    await f.edit(b.session, 'bia-1', [f.file('src', 'a.ts')]);
    await f.svc.overlapNoticesSettled();
    expect(f.notices).toHaveLength(2);
    expect(f.to(a.session)[0]!.text).toContain(`- ${SAY('src/a.ts', b.id, 'Bia')}`);
    expect(f.to(b.session)[0]!.text).toContain(`- ${SAY('src/a.ts', a.id, 'Ana')}`);
    expect(f.to(a.session)[0]!.text).toMatch(/^\[MyCo\] /);

    // Registrado nas duas tarefas, com o aviso entregue.
    expect((await f.task(a.id)).fileOverlaps).toEqual([{ file: 'src/a.ts', taskId: b.id, staffId: 'bia-1', at: expect.any(String), toldAt: expect.any(String) }]);
    expect((await f.task(b.id)).fileOverlaps).toEqual([{ file: 'src/a.ts', taskId: a.id, staffId: 'ana-1', at: expect.any(String), toldAt: expect.any(String) }]);

    // Mais edições do mesmo arquivo (das duas) e o tick: nenhum aviso novo.
    await f.edit(a.session, 'ana-1', [f.file('src', 'a.ts')]);
    await f.edit(b.session, 'bia-1', [f.file('src', 'a.ts')]);
    f.state.working = true;
    await f.svc.tick();
    await f.svc.overlapNoticesSettled();
    expect(f.notices).toHaveLength(2);

    // Outro arquivo em comum é outro par: o aviso traz só ele.
    await f.edit(b.session, 'bia-1', [f.file('src', 'b.ts')]);
    await f.edit(a.session, 'ana-1', [f.file('src', 'b.ts')]);
    await f.svc.overlapNoticesSettled();
    expect(f.notices).toHaveLength(4);
    const last = f.to(a.session)[1]!.text;
    expect(last).toContain(SAY('src/b.ts', b.id, 'Bia'));
    expect(last).not.toContain('src/a.ts');
    expect((await f.task(a.id)).fileOverlaps).toHaveLength(2);
  });

  it('edições juntas das duas tarefas geram um par só (um aviso em cada conversa)', async () => {
    const f = flow(`juntas-${engine}`, engine);
    const a = await f.doing('ana-1', 'Tela A');
    const b = await f.doing('bia-1', 'Tela B');
    await Promise.all([f.edit(a.session, 'ana-1', [f.file('x.ts')]), f.edit(b.session, 'bia-1', [f.file('x.ts')])]);
    await f.svc.overlapNoticesSettled();
    expect(f.to(a.session)).toHaveLength(1);
    expect(f.to(b.session)).toHaveLength(1);
    expect((await f.task(a.id)).fileOverlaps).toHaveLength(1);
    expect((await f.task(b.id)).fileOverlaps).toHaveLength(1);
  });

  it('o card automático de uma conversa direta também conta, nos dois lados', async () => {
    const f = flow(`auto-${engine}`, engine);
    const a = await f.doing('ana-1', 'Tela A');
    await f.edit(a.session, 'ana-1', [f.file('src', 'a.ts')]);
    await f.edit('s-direta', 'bia-1', [f.file('src', 'a.ts')]); // sem tarefa: abre o card automático da Bia
    await f.svc.overlapNoticesSettled();
    const card = (await readTasks(f.dir)).find((t) => t.autoCreated)!;
    expect(f.to(a.session)).toHaveLength(1);
    expect(f.to(a.session)[0]!.text).toContain(SAY('src/a.ts', card.id, 'Bia'));
    expect(f.to('s-direta')).toHaveLength(1);
    expect(f.to('s-direta')[0]!.text).toContain(SAY('src/a.ts', a.id, 'Ana'));
    expect(card.fileOverlaps).toEqual([expect.objectContaining({ taskId: a.id, file: 'src/a.ts' })]);
  });

  it('a mesma pessoa não avisa (a fila dela já serializa)', async () => {
    const f = flow(`mesma-${engine}`, engine);
    const a = await f.doing('ana-1', 'Tela A');
    await f.edit(a.session, 'ana-1', [f.file('src', 'a.ts')]);
    await f.edit('s-direta', 'ana-1', [f.file('src', 'a.ts')]); // card automático da própria Ana
    await f.svc.overlapNoticesSettled();
    expect(f.notices).toEqual([]);
    expect((await readTasks(f.dir)).every((t) => !t.fileOverlaps)).toBe(true);
  });

  it('tarefa fechada (pronta ou cancelada) não conta', async () => {
    const f = flow(`fechada-${engine}`, engine);
    const a = await f.doing('ana-1', 'Tela A');
    const b = await f.doing('bia-1', 'Tela B');
    const c = await f.doing('bia-1', 'Tela C'); // fica na fila da Bia, mas o estado é gravado à mão abaixo
    await f.edit(b.session, 'bia-1', [f.file('src', 'a.ts')]);
    await f.patch(b.id, { status: 'done' });
    await f.patch(c.id, { status: 'cancelled', changedFiles: ['src/a.ts'] });
    await f.edit(a.session, 'ana-1', [f.file('src', 'a.ts')]);
    await f.svc.overlapNoticesSettled();
    expect(f.notices).toEqual([]);
    expect((await f.task(a.id)).fileOverlaps).toBeUndefined();
  });

  it('quem trabalha numa worktree tem outra cópia do arquivo: não avisa', async () => {
    const f = flow(`worktree-${engine}`, engine, { 'bia-1': { worktree: true } });
    const a = await f.doing('ana-1', 'Tela A');
    const b = await f.doing('bia-1', 'Tela B');
    await f.edit(a.session, 'ana-1', [f.file('src', 'a.ts')]);
    await f.edit(b.session, 'bia-1', [f.file('src', 'a.ts')]);
    await f.svc.overlapNoticesSettled();
    expect(f.notices).toEqual([]);
    expect((await f.task(a.id)).fileOverlaps).toBeUndefined();
  });

  it('a edição não espera o aviso: o envio travado não segura onCodeEdit', async () => {
    const f = flow(`sem-espera-${engine}`, engine);
    const a = await f.doing('ana-1', 'Tela A');
    const b = await f.doing('bia-1', 'Tela B');
    let release!: () => void;
    f.state.gate = new Promise<void>((resolve) => (release = resolve));
    await f.edit(a.session, 'ana-1', [f.file('x.ts')]);
    await f.edit(b.session, 'bia-1', [f.file('x.ts')]); // volta mesmo com o envio preso
    expect(f.notices).toEqual([]);
    expect((await f.task(a.id)).changedFiles).toEqual(['x.ts']);
    release();
    await f.svc.overlapNoticesSettled();
    expect(f.notices).toHaveLength(2);
  });

  it('o aviso de quem não está trabalhando espera (revisão não acorda à toa) e sai quando ela volta a trabalhar, uma vez', async () => {
    const f = flow(`espera-${engine}`, engine);
    const a = await f.doing('ana-1', 'Tela A');
    const b = await f.doing('bia-1', 'Tela B');
    await f.edit(b.session, 'bia-1', [f.file('x.ts')]);
    await f.patch(b.id, { status: 'review' });
    await f.edit(a.session, 'ana-1', [f.file('x.ts')]);
    await f.svc.overlapNoticesSettled();
    expect(f.to(a.session)).toHaveLength(1);
    expect(f.to(b.session)).toEqual([]);
    expect((await f.task(b.id)).fileOverlaps![0]!.toldAt).toBeUndefined(); // gravado, mas ainda sem aviso
    f.state.working = true;
    await f.svc.tick();
    await f.svc.overlapNoticesSettled();
    expect(f.to(b.session)).toEqual([]); // segue em revisão
    await f.patch(b.id, { status: 'doing' });
    await f.svc.tick();
    await f.svc.overlapNoticesSettled();
    expect(f.to(b.session)).toHaveLength(1);
    expect(f.to(b.session)[0]!.text).toContain(SAY('x.ts', a.id, 'Ana'));
    expect((await f.task(b.id)).fileOverlaps![0]!.toldAt).toEqual(expect.any(String));
    await f.svc.tick();
    await f.svc.overlapNoticesSettled();
    expect(f.to(b.session)).toHaveLength(1);
    expect(f.to(a.session)).toHaveLength(1);
  });

  it('envio que falha: o par fica pendente com retry, o tick refaz na hora e o aviso sai uma vez', async () => {
    const f = flow(`retry-${engine}`, engine);
    const a = await f.doing('ana-1', 'Tela A');
    const b = await f.doing('bia-1', 'Tela B');
    f.state.fail = a.session;
    await f.edit(a.session, 'ana-1', [f.file('x.ts')]);
    await f.edit(b.session, 'bia-1', [f.file('x.ts')]);
    await f.svc.overlapNoticesSettled();
    expect(f.to(b.session)).toHaveLength(1); // o da Bia chegou
    expect(f.to(a.session)).toEqual([]);
    const failed = await f.task(a.id);
    expect(failed.fileOverlaps![0]!.toldAt).toBeUndefined();
    expect(failed.overlapRetry).toMatchObject({ attempts: 1, lastError: 'conversa indisponível' });

    f.state.working = true;
    await f.svc.tick(new Date()); // antes da hora: nada
    await f.svc.overlapNoticesSettled();
    expect(f.to(a.session)).toEqual([]);
    f.state.fail = null;
    await f.svc.tick(new Date(Date.now() + 20 * 60_000)); // na hora
    await f.svc.overlapNoticesSettled();
    expect(f.to(a.session)).toHaveLength(1);
    const ok = await f.task(a.id);
    expect(ok.overlapRetry).toBeUndefined();
    expect(ok.fileOverlaps![0]!.toldAt).toEqual(expect.any(String));
    await f.svc.tick(new Date(Date.now() + 40 * 60_000));
    await f.svc.overlapNoticesSettled();
    expect(f.to(a.session)).toHaveLength(1);
  });

  it('projeto pausado não abre conversa: o par é gravado e o aviso sai quando ele volta', async () => {
    const f = flow(`pausa-${engine}`, engine);
    const a = await f.doing('ana-1', 'Tela A');
    const b = await f.doing('bia-1', 'Tela B');
    await f.pauses.pause('p');
    await f.edit(a.session, 'ana-1', [f.file('x.ts')]);
    await f.edit(b.session, 'bia-1', [f.file('x.ts')]);
    await f.svc.overlapNoticesSettled();
    expect(f.notices).toEqual([]);
    expect((await f.task(a.id)).fileOverlaps).toHaveLength(1);
    await f.pauses.resume('p');
    f.state.working = true;
    await f.svc.tick();
    await f.svc.overlapNoticesSettled();
    expect(f.to(a.session)).toHaveLength(1);
    expect(f.to(b.session)).toHaveLength(1);
  });

  it('o pedido de revisão cita a sobreposição, também com a outra tarefa já encerrada', async () => {
    const f = flow(`revisao-${engine}`, engine);
    const a = await f.doing('ana-1', 'Tela A');
    const b = await f.doing('bia-1', 'Tela B');
    const c = await f.doing('ana-1', 'Tela C'); // sem relação: nada dela no pedido
    await f.edit(a.session, 'ana-1', [f.file('src', 'a.ts'), f.file('so-dela.ts')]);
    await f.edit(b.session, 'bia-1', [f.file('src', 'a.ts')]);
    await f.svc.overlapNoticesSettled();

    // Com a outra tarefa aberta: a marca de sempre.
    await f.svc.requestReview('p', a.id, 'rui-1');
    expect(f.sent.at(-1)).toContain(`- \`src/a.ts\`: arquivo compartilhado com ${b.id}; hunks de outras tarefas não contam para o veredito`);
    expect(f.sent.at(-1)).not.toContain('so-dela.ts`: arquivo compartilhado');
    expect(f.sent.at(-1)).not.toContain(c.id);

    // A outra fechou, mas o que ela mexeu segue no arquivo: o registro da hora da edição segura a citação.
    await f.patch(b.id, { status: 'done' });
    await f.svc.requestReview('p', a.id, 'rui-1', true);
    expect(f.sent.at(-1)).toContain(`- \`src/a.ts\`: arquivo compartilhado com ${b.id} (já encerrada); hunks de outras tarefas não contam para o veredito`);
  });
});
