import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_REVIEW_ROUNDS, CHANGED_FILES_MAX, type StaffProfile, type TurnCapHit } from '../shared/model';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import type { CodeEdit } from '../server/chat/codeEdits';
import { readTasks, TaskError, TaskService } from '../server/tasks';
import { removeTemp } from './support/tmp';

// Card automático (toda alteração de código de uma conversa sem tarefa vira card) e a revisão automática do quadro, por projeto.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-autocard-'));
});
afterAll(() => removeTemp(root));

const profileOf = (id: string, name: string, extra: Partial<StaffProfile> = {}) =>
  ({ id, name, autonomy: 'acceptEdits', worktree: false, servers: [], engine: 'claude', ...extra }) as unknown as StaffProfile;

/** Ana (a conversa direta do dono), Bia (a outra), Rui e Gil (revisores possíveis). */
function flow(dirName: string, opts: { cap?: () => TurnCapHit | null } = {}) {
  const dir = path.join(root, dirName);
  const sent: Array<{ staffId: string; text: string; session: string }> = [];
  const delivered: Array<{ sessionId: string; text: string }> = [];
  const interrupted: string[] = [];
  const texts = new Map<string, string>();
  const titles = new Map<string, string>();
  const people: Record<string, StaffProfile> = {
    'ana-1': profileOf('ana-1', 'Ana'),
    'bia-1': profileOf('bia-1', 'Bia'),
    'rui-1': profileOf('rui-1', 'Rui', { autonomy: 'manual' }),
    'gil-1': profileOf('gil-1', 'Gil', { autonomy: 'manual' }),
  };
  let n = 0;
  // Um serviço novo sobre a mesma pasta = o servidor reiniciou.
  const boot = () =>
    new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text) => {
        const session = `s-${++n}`;
        sent.push({ staffId, text, session });
        return session;
      },
      branchFor: async () => 'main',
      lastText: (sessionId) => texts.get(sessionId) ?? null,
      sendTo: async (_p, sessionId, _staffId, text) => {
        delivered.push({ sessionId, text });
        return sessionId;
      },
      conversationTitle: async (sessionId) => titles.get(sessionId) ?? null,
      interruptSession: (sessionId) => void interrupted.push(sessionId),
      ...(opts.cap && { turnCap: () => opts.cap!() }),
      isWorking: () => false,
    });
  const svc = boot();
  const edit = (sessionId: string, files: string[], extra: Partial<CodeEdit> = {}) =>
    svc.onCodeEdit({ sessionId, projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: dir, files, request: 'Corrija o botão de exportar\nEle não baixa o CSV', ...extra });
  const file = (...parts: string[]) => path.join(dir, ...parts);
  const all = async () => (await readTasks(dir)).filter((t) => !t.routineId);
  const board = (config: object) => fs.mkdir(path.join(dir, '.myco'), { recursive: true }).then(() => fs.writeFile(path.join(dir, '.myco', 'board.json'), JSON.stringify(config)));
  return { svc, boot, dir, sent, delivered, interrupted, texts, titles, edit, file, all, board };
}

describe('card automático: o que abre', () => {
  it('a primeira edição de código abre 1 card ligado à conversa: fazendo, do funcionário, sem requestedBy, com o pedido', async () => {
    const f = flow('a1');
    await f.edit('s-ana', [f.file('src', 'export.ts')]);
    const tasks = await f.all();
    expect(tasks).toHaveLength(1);
    const card = tasks[0]!;
    expect(card).toMatchObject({
      status: 'doing',
      staffId: 'ana-1',
      sessionId: 's-ana',
      autoCreated: true,
      reviewerId: null,
      title: 'Corrija o botão de exportar',
      description: 'Corrija o botão de exportar\nEle não baixa o CSV',
      changedFiles: ['src/export.ts'],
      sessions: [{ id: 's-ana', role: 'work', staffId: 'ana-1', engine: 'claude' }],
    });
    expect(card.requestedBy ?? null).toBeNull();
    expect(card.history).toEqual([expect.objectContaining({ status: 'doing', by: 'auto', note: expect.stringContaining('card automático') })]);
    // Aparece na lista do quadro e não ocupa a fila da Ana.
    expect(((await f.svc.list('p')) ?? []).map((t) => t.id)).toEqual([card.id]);
  });

  it('o título que você deu à conversa vale; sem ele, a primeira linha do pedido (curta); o Codex entra com o motor dele', async () => {
    const f = flow('a2');
    f.titles.set('s-titulo', 'Relatório de vendas');
    await f.edit('s-titulo', [f.file('a.ts')]);
    await f.edit('s-longo', [f.file('b.ts')], { request: `${'x'.repeat(200)}\nresto`, engine: 'codex' });
    await f.edit('s-vazio', [f.file('c.ts')], { request: null });
    const by = Object.fromEntries((await f.all()).map((t) => [t.sessionId, t]));
    expect(by['s-titulo']!.title).toBe('Relatório de vendas');
    expect(by['s-longo']!.title).toHaveLength(80);
    expect(by['s-longo']!.title.endsWith('…')).toBe(true);
    expect(by['s-longo']!.sessions![0]!.engine).toBe('codex');
    expect(by['s-vazio']).toMatchObject({ title: 'Alteração de código', description: '' });
  });

  it('pedido com cara de segredo não vai para o card (o quadro fica em texto no projeto)', async () => {
    const f = flow('a3');
    await f.edit('s-ana', [f.file('a.ts')], { request: `use a chave ghp_${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6'} no deploy` });
    const [card] = await f.all();
    expect(card).toMatchObject({ title: 'Alteração de código', description: '' });
    expect(JSON.stringify(card)).not.toContain('ghp_');
  });
});

describe('card automático: o que não abre', () => {
  it('.myco/ (memória e ficha), fora da pasta do projeto, pasta e caminho que escapa: nenhum card', async () => {
    const f = flow('b1');
    await f.edit('s-ana', [
      f.file('.myco', 'staff', 'ana-1.memory.md'),
      f.file('.myco', 'tasks.json'),
      '.myco/staff/ana-1.md',
      path.join(os.tmpdir(), 'outro-projeto', 'a.ts'),
      path.join(os.homedir(), '.claude', 'settings.json'),
      f.dir,
      path.join(f.dir, '..', 'irmao', 'a.ts'),
    ]);
    expect(await f.all()).toEqual([]);
    // Misturado: só o que é código entra.
    await f.edit('s-ana', [f.file('.myco', 'staff', 'x.md'), f.file('src', 'a.ts'), path.join(os.tmpdir(), 'fora.ts')]);
    expect((await f.all())[0]!.changedFiles).toEqual(['src/a.ts']);
  });

  it('conversa de tarefa (execução ou revisão) não gera card: o card é o da tarefa', async () => {
    const f = flow('b2');
    const t = (await f.svc.create('p', { title: 'Tabela', staffId: 'ana-1', reviewerId: 'rui-1' }))!;
    await f.svc.start('p', t.id); // s-1: a conversa de trabalho
    await f.edit('s-1', [f.file('tabela.ts')]);
    await f.svc.onTurnDone('s-1'); // entregou: o Rui revisa (s-2)
    await f.edit('s-2', [f.file('revisao.ts')], { staffId: 'rui-1' }); // a revisão que mexe no código
    const tasks = await f.all();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.autoCreated).toBeUndefined();
    // A edição do trabalho entra na lista da tarefa (a dúvida escalada lê dela); a da revisão não.
    expect(tasks[0]!.changedFiles).toEqual(['tabela.ts']);
  });

  it('conversa de quem não tem ficha na equipe: nenhum card', async () => {
    const f = flow('b3');
    await f.edit('s-x', [f.file('a.ts')], { staffId: 'fantasma' });
    expect(await f.all()).toEqual([]);
  });
});

describe('card automático: sem duplicata', () => {
  it('evento repetido e edições juntas: 1 card só, e os arquivos novos entram sem repetir', async () => {
    const f = flow('c1');
    await Promise.all([1, 2, 3, 4, 5].map(() => f.edit('s-ana', [f.file('a.ts')])));
    await Promise.all([f.edit('s-ana', [f.file('b.ts')]), f.edit('s-ana', [f.file('a.ts'), f.file('c.ts')]), f.edit('s-ana', [f.file('b.ts')])]);
    const tasks = await f.all();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.changedFiles).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(tasks[0]!.history).toHaveLength(1);
  });

  it('o servidor reinicia no meio do turno: a próxima edição junta ao card aberto, sem card novo', async () => {
    const f = flow('c2');
    await f.edit('s-ana', [f.file('a.ts')]);
    const reborn = f.boot();
    await reborn.onCodeEdit({ sessionId: 's-ana', projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: f.dir, files: [f.file('a.ts'), f.file('d.ts')], request: 'outro pedido' });
    const tasks = await f.all();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ changedFiles: ['a.ts', 'd.ts'], title: 'Corrija o botão de exportar' });
    // E o fim do turno, no serviço novo, entrega esse mesmo card.
    await reborn.onTurnDone('s-ana');
    expect((await f.all()).map((t) => t.status)).toEqual(['review']);
  });

  it(`a lista de arquivos para em ${CHANGED_FILES_MAX}`, async () => {
    const f = flow('c3');
    await f.edit('s-ana', Array.from({ length: CHANGED_FILES_MAX + 20 }, (_, i) => f.file('src', `f${i}.ts`)));
    expect((await f.all())[0]!.changedFiles).toHaveLength(CHANGED_FILES_MAX);
    await f.edit('s-ana', [f.file('mais.ts')]);
    expect((await f.all())[0]!.changedFiles).toHaveLength(CHANGED_FILES_MAX);
    expect(await f.all()).toHaveLength(1);
  });
});

describe('card automático: fim do turno e nova edição', () => {
  it('fim do turno: o card vai para revisão com a lista de arquivos e o resumo; sem revisão ligada, fica para você', async () => {
    const f = flow('d1');
    await f.edit('s-ana', [f.file('src', 'a.ts'), f.file('src', 'b.ts')]);
    f.texts.set('s-ana', 'Corrigi o botão: o CSV agora baixa.');
    await f.svc.onTurnDone('s-ana');
    const [card] = await f.all();
    expect(card).toMatchObject({ status: 'review', changedFiles: ['src/a.ts', 'src/b.ts'], delivery: { summary: 'Corrigi o botão: o CSV agora baixa.' } });
    expect(card!.history.map((h) => h.status)).toEqual(['doing', 'review']);
    expect(f.sent).toEqual([]); // ninguém revisa: aprova ou reprova pela tela
    // O mesmo aviso de novo (o vigia e o processo avisam os dois) não muda nada.
    await f.svc.onTurnDone('s-ana');
    expect((await f.all())[0]!.history).toHaveLength(2);
  });

  it('nova edição na mesma conversa depois da revisão (ou de fechar) abre um card novo; o antigo não volta para fazendo', async () => {
    const f = flow('d2');
    await f.edit('s-ana', [f.file('a.ts')]);
    await f.svc.onTurnDone('s-ana');
    await f.svc.onSent('s-ana'); // o dono respondeu na conversa: o card automático não reabre
    expect((await f.all())[0]!.status).toBe('review');
    await f.edit('s-ana', [f.file('b.ts')]);
    let tasks = await f.all();
    expect(tasks.map((t) => [t.status, t.changedFiles])).toEqual([['review', ['a.ts']], ['doing', ['b.ts']]]);
    // Edições seguintes juntam ao novo (o aberto); o turno termina e ele vai para revisão.
    await f.edit('s-ana', [f.file('c.ts')]);
    await f.svc.onTurnDone('s-ana');
    tasks = await f.all();
    expect(tasks.map((t) => [t.status, t.changedFiles])).toEqual([['review', ['a.ts']], ['review', ['b.ts', 'c.ts']]]);
    // Fechado pela tela (pronto): a próxima edição também abre um card novo.
    await f.svc.update('p', tasks[1]!.id, { status: 'done' });
    await f.edit('s-ana', [f.file('d.ts')]);
    expect((await f.all()).map((t) => t.status)).toEqual(['review', 'done', 'doing']);
  });

  it('o limite de turno não parqueia o card automático em Aguardar: ele vai para revisão', async () => {
    const hit = { kind: 'tools', limit: 500, used: 500 } as unknown as TurnCapHit;
    const f = flow('d3', { cap: () => hit });
    await f.edit('s-ana', [f.file('a.ts')]);
    await f.svc.onTurnDone('s-ana');
    expect((await f.all())[0]!.status).toBe('review');
  });

  it('conversa que morreu no meio do turno (órfã): o card vai para revisão sem mandar "continue" nela', async () => {
    const f = flow('d4');
    await f.edit('s-ana', [f.file('a.ts')]);
    const raw = JSON.parse(await fs.readFile(path.join(f.dir, '.myco', 'tasks.json'), 'utf8')) as Array<Record<string, unknown>>;
    raw[0]!.updatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await fs.writeFile(path.join(f.dir, '.myco', 'tasks.json'), JSON.stringify(raw));
    await f.svc.tick();
    expect((await f.all())[0]).toMatchObject({ status: 'review', changedFiles: ['a.ts'] });
    expect(f.delivered).toEqual([]);
  });
});

describe('card automático: a conversa continua direta', () => {
  it('não ocupa o funcionário, não guarda a sua mensagem e não é "conversa de tarefa"', async () => {
    const f = flow('e1');
    await f.edit('s-ana', [f.file('a.ts')]);
    expect(await f.svc.hold('s-ana', { text: 'mais uma coisa' })).toBeNull();
    expect(await f.svc.isTaskSession('s-ana')).toBe(false);
    expect(await f.svc.isTaskConversation('s-ana')).toBe(false);
    // Uma tarefa de verdade para a mesma Ana começa na hora: o card automático não é "outra tarefa em andamento".
    const t = (await f.svc.create('p', { title: 'Tarefa de verdade', staffId: 'ana-1' }))!;
    const started = (await f.svc.start('p', t.id))!;
    expect(started.status).toBe('doing');
    expect(started.queuedAt ?? null).toBeNull();
    expect(await f.svc.isTaskSession('s-1')).toBe(true);
  });

  it('cancelar o card pela tela não interrompe a conversa', async () => {
    const f = flow('e2');
    await f.edit('s-ana', [f.file('a.ts')]);
    const [card] = await f.all();
    await f.svc.cancel('p', card!.id, { by: 'user', reason: 'não precisa de card' });
    expect((await f.all())[0]!.status).toBe('cancelled');
    expect(f.interrupted).toEqual([]);
  });
});

describe('revisão do quadro: quem revisa uma tarefa que chega em revisão', () => {
  /** A Ana executa uma tarefa manual e entrega; `reviewerId` na tarefa e a configuração do quadro variam por teste. */
  async function delivered(dir: string, opts: { board?: object | null; reviewerId?: string | null; executor?: string }) {
    const f = flow(dir);
    if (opts.board) await f.board(opts.board);
    const t = (await f.svc.create('p', { title: 'Tabela', staffId: opts.executor ?? 'ana-1', reviewerId: opts.reviewerId ?? null }))!;
    const session = (await f.svc.start('p', t.id))!.sessionId!;
    await f.svc.onTurnDone(session);
    return { ...f, task: async () => (await f.all())[0]!, session };
  }

  it('reviewerId na tarefa vale mais que o responsável do quadro', async () => {
    const f = await delivered('g1', { board: { autoReview: true, reviewerId: 'gil-1' }, reviewerId: 'rui-1' });
    expect(f.sent.map((s) => s.staffId)).toEqual(['ana-1', 'rui-1']);
    expect(await f.task()).toMatchObject({ status: 'review', reviewerId: 'rui-1', review: { staffId: 'rui-1' } });
  });

  it('sem revisor na tarefa, o responsável do quadro revisa quando não foi ele quem executou; o veredito dele move a tarefa', async () => {
    const f = await delivered('g2', { board: { autoReview: true, reviewerId: 'gil-1' } });
    expect(f.sent.map((s) => s.staffId)).toEqual(['ana-1', 'gil-1']);
    expect(f.sent.at(-1)!.text).toContain('APROVADO ou REPROVADO na primeira linha');
    // O quadro marca o revisor na tarefa: sem isso o veredito não a moveria.
    expect(await f.task()).toMatchObject({ status: 'review', reviewerId: 'gil-1', reviewRounds: 1, review: { staffId: 'gil-1', sessionId: 's-2' } });
    f.texts.set('s-2', 'APROVADO\n\nok');
    await f.svc.onTurnDone('s-2');
    expect(await f.task()).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
  });

  it('responsável do quadro = quem executou: ninguém revisa, fica para você', async () => {
    const f = await delivered('g3', { board: { autoReview: true, reviewerId: 'ana-1' } });
    expect(f.sent.map((s) => s.staffId)).toEqual(['ana-1']);
    expect(await f.task()).toMatchObject({ status: 'review', reviewerId: null });
    expect((await f.task()).review).toBeUndefined();
  });

  it('revisão do quadro desligada (ou sem arquivo): ninguém revisa, mesmo com responsável guardado', async () => {
    const off = await delivered('g4', { board: { autoReview: false, reviewerId: 'gil-1' } });
    expect(off.sent.map((s) => s.staffId)).toEqual(['ana-1']);
    expect(await off.task()).toMatchObject({ status: 'review', reviewerId: null });
    const none = await delivered('g5', { board: null });
    expect(none.sent.map((s) => s.staffId)).toEqual(['ana-1']);
  });

  it('responsável que saiu da equipe, ou arquivo estragado: ninguém revisa, sem erro', async () => {
    const gone = await delivered('g6', { board: { autoReview: true, reviewerId: 'ninguem' } });
    expect(gone.sent.map((s) => s.staffId)).toEqual(['ana-1']);
    const broken = flow('g7');
    await fs.mkdir(path.join(broken.dir, '.myco'), { recursive: true });
    await fs.writeFile(path.join(broken.dir, '.myco', 'board.json'), '{nao é json');
    const t = (await broken.svc.create('p', { title: 'X', staffId: 'ana-1' }))!;
    await broken.svc.onTurnDone((await broken.svc.start('p', t.id))!.sessionId!);
    expect(broken.sent.map((s) => s.staffId)).toEqual(['ana-1']);
  });

  it('outro executor: o responsável do quadro revisa quem não é ele (Ana executa, Rui é o responsável)', async () => {
    const f = await delivered('g8', { board: { autoReview: true, reviewerId: 'rui-1' }, executor: 'bia-1' });
    expect(f.sent.map((s) => s.staffId)).toEqual(['bia-1', 'rui-1']);
  });

  it('o limite de rodadas automáticas vale também para o revisor do quadro', async () => {
    const f = await delivered('g9', { board: { autoReview: true, reviewerId: 'gil-1' } });
    for (const round of [1, 2, 3]) {
      f.texts.set(`s-${round + 1}`, `REPROVADO\n\najuste ${round}`);
      await f.svc.onTurnDone(`s-${round + 1}`);
      await f.svc.onTurnDone('s-1');
    }
    expect(f.sent.filter((s) => s.staffId === 'gil-1')).toHaveLength(AUTO_REVIEW_ROUNDS);
    expect(await f.task()).toMatchObject({ status: 'review', reviewRounds: AUTO_REVIEW_ROUNDS });
  });
});

describe('revisão do quadro: o card automático passa pela mesma revisão', () => {
  it('aprovado pelo responsável do quadro: vai para pronto; o pedido de revisão traz os arquivos da conversa', async () => {
    const f = flow('h1');
    await f.board({ autoReview: true, reviewerId: 'gil-1' });
    await f.edit('s-ana', [f.file('src', 'export.ts')]);
    await f.svc.onTurnDone('s-ana'); // o Gil revisa (s-1)
    const review = f.sent.at(-1)!;
    expect(review).toMatchObject({ staffId: 'gil-1', session: 's-1' });
    expect(review.text).toContain('Arquivos que esta conversa alterou (confira só eles): src/export.ts');
    expect(review.text).toContain('Corrija o botão de exportar');
    expect((await f.all())[0]).toMatchObject({ status: 'review', reviewerId: 'gil-1', autoCreated: true });
    // A conversa do revisor é da revisão: o que ele editar não vira outro card.
    await f.edit('s-1', [f.file('src', 'export.ts')], { staffId: 'gil-1' });
    expect(await f.all()).toHaveLength(1);
    f.texts.set('s-1', 'APROVADO\n\nconferido');
    await f.svc.onTurnDone('s-1');
    expect(await f.all()).toMatchObject([{ status: 'done', review: { verdict: 'approved' } }]);
  });

  it('reprovado: os ajustes voltam para a mesma conversa e o card volta para fazendo; ao terminar, nova rodada', async () => {
    const f = flow('h2');
    await f.board({ autoReview: true, reviewerId: 'gil-1' });
    await f.edit('s-ana', [f.file('a.ts')]);
    await f.svc.onTurnDone('s-ana'); // s-1
    f.texts.set('s-1', 'REPROVADO\n\na.ts:3 falta validar a entrada');
    await f.svc.onTurnDone('s-1');
    expect((await f.all())[0]).toMatchObject({ status: 'doing', review: { verdict: 'rejected' } });
    expect(f.delivered).toEqual([{ sessionId: 's-ana', text: expect.stringContaining('a.ts:3 falta validar a entrada') }]);
    // Ajustou (edita de novo na mesma conversa: junta ao mesmo card) e terminou: segunda rodada.
    await f.edit('s-ana', [f.file('a.ts'), f.file('b.ts')]);
    await f.svc.onTurnDone('s-ana');
    expect(await f.all()).toHaveLength(1);
    expect((await f.all())[0]).toMatchObject({ status: 'review', reviewRounds: 2, changedFiles: ['a.ts', 'b.ts'] });
  });

  it('o responsável do quadro executou a conversa: o card fica em revisão para você', async () => {
    const f = flow('h3');
    await f.board({ autoReview: true, reviewerId: 'ana-1' });
    await f.edit('s-ana', [f.file('a.ts')]);
    await f.svc.onTurnDone('s-ana');
    expect((await f.all())[0]).toMatchObject({ status: 'review', reviewerId: null });
    expect(f.sent).toEqual([]);
  });
});

describe('revisão do quadro: configuração por projeto', () => {
  it('lê e grava { autoReview, reviewerId } em .myco/board.json; começa desligada', async () => {
    const f = flow('i1');
    expect(await f.svc.boardConfig('p')).toEqual({ autoReview: false, reviewerId: null });
    expect(await f.svc.setBoardConfig('p', { autoReview: true, reviewerId: 'gil-1' })).toEqual({ autoReview: true, reviewerId: 'gil-1' });
    expect(JSON.parse(await fs.readFile(path.join(f.dir, '.myco', 'board.json'), 'utf8'))).toEqual({ autoReview: true, reviewerId: 'gil-1' });
    expect(await f.svc.boardConfig('p')).toEqual({ autoReview: true, reviewerId: 'gil-1' });
    // Desligar guarda o responsável (a tela mostra de novo ao ligar).
    expect(await f.svc.setBoardConfig('p', { autoReview: false, reviewerId: 'gil-1' })).toEqual({ autoReview: false, reviewerId: 'gil-1' });
    expect(await f.svc.setBoardConfig('p', { autoReview: false, reviewerId: null })).toEqual({ autoReview: false, reviewerId: null });
  });

  it('recusa corpo inválido: ligar sem responsável, responsável fora da equipe, campo a mais ou de menos, id estranho', async () => {
    const f = flow('i2');
    await expect(f.svc.setBoardConfig('p', { autoReview: true, reviewerId: null })).rejects.toThrow(/escolha quem revisa/);
    await expect(f.svc.setBoardConfig('p', { autoReview: true, reviewerId: 'ninguem' })).rejects.toThrow(/revisor não encontrado/);
    await expect(f.svc.setBoardConfig('p', { autoReview: true, reviewerId: 'gil-1', extra: 1 })).rejects.toBeInstanceOf(TaskError);
    await expect(f.svc.setBoardConfig('p', { reviewerId: 'gil-1' })).rejects.toBeInstanceOf(TaskError);
    await expect(f.svc.setBoardConfig('p', { autoReview: 'sim', reviewerId: 'gil-1' })).rejects.toBeInstanceOf(TaskError);
    await expect(f.svc.setBoardConfig('p', { autoReview: false, reviewerId: '../../etc' })).rejects.toBeInstanceOf(TaskError);
    await expect(f.svc.setBoardConfig('p', null)).rejects.toBeInstanceOf(TaskError);
    // Nada foi gravado.
    await expect(fs.readFile(path.join(f.dir, '.myco', 'board.json'), 'utf8')).rejects.toThrow();
  });

  it('o responsável que saiu da equipe volta como desligada (a leitura não confia no arquivo)', async () => {
    const f = flow('i3');
    await f.board({ autoReview: true, reviewerId: 'ex-funcionario' });
    expect(await f.svc.boardConfig('p')).toEqual({ autoReview: false, reviewerId: null });
    // Ligada sem responsável no arquivo (editado à mão) também não vale.
    await f.board({ autoReview: true, reviewerId: null });
    expect(await f.svc.boardConfig('p')).toEqual({ autoReview: false, reviewerId: null });
  });

  it('projeto que não existe: null', async () => {
    const svc = new TaskService({ projectPath: async () => null, projectIds: async () => [], readProfile: async () => null, send: async () => 's', branchFor: async () => null });
    expect(await svc.boardConfig('x')).toBeNull();
    expect(await svc.setBoardConfig('x', { autoReview: false, reviewerId: null })).toBeNull();
  });

  it('só a tela grava: o funcionário (e a sandbox do Codex) não têm esta rota na lista', async () => {
    expect(staffMayPost('/api/projects/p/board-review')).toBe(false);
    expect(sandboxVerdict('POST', '/api/projects/p/board-review', 'p')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('GET', '/api/projects/p/board-review', 'p')).toMatchObject({ status: 403 });
    const index = await fs.readFile(path.join(process.cwd(), 'server', 'index.ts'), 'utf8');
    const start = index.indexOf('board-review$`), ({ params: [id] }) => tasks.boardConfig');
    expect(start).toBeGreaterThan(0);
    // O POST da rota confere a tela antes de gravar (a janela é só o bloco dela).
    const route = index.slice(start, start + 600);
    expect(route).toMatch(/if \(!fromBrowser\) throw new BadRequest\('a revisão do quadro[^']*'\);\s+return tasks\.setBoardConfig\(id!, body\);/);
  });
});
