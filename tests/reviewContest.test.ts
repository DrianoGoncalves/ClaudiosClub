import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESCALATE_AFTER_MS } from '../server/retryPolicy';
import { contestItems, keptContestIds, parseContestAnswer, replyLineFor } from '../server/reviewBlockers';
import { TaskService, stuckState } from '../server/tasks';
import type { Engine, Rejection, StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// Contestação da reprovação (t-973be5): o card reprovado cujo executor reentrega SEM editar nada nessa rodada não volta a "revisão" como rodada nova. Fica em "fazendo" com `Task.contest`, o revisor
// que reprovou recebe só a resposta, item a item, e mantém ou retira cada 🔴: retirou todos, aprovado; manteve algum, volta ao executor como ajuste; o segundo impasse no mesmo item vai a Aguardar,
// para quem pediu decidir. Não conta no limite de revisões automáticas nem grava reprovação nova. Repositórios git de verdade (a prova de "sem edição" é o que o git e o disco dizem).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-contest-'));
});
afterAll(() => removeTemp(root));

const MIN = 60_000;
const later = (min: number) => new Date(Date.now() + min * MIN);
const PAST = '2020-01-01T00:00:00';
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: PAST, GIT_COMMITTER_DATE: PAST } }).toString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const block = (...lines: string[]) => ['[BLOQUEADORES]', ...lines, '[/BLOQUEADORES]'].join('\n');
const R1 = 'R1 | a.ts:1 | quebra com lista vazia | rodar tests/a.test.ts e ficar verde';
const R2 = 'R2 | b.ts:2 | sem teste | existir tests/b.test.ts verde';
const REJECT = ['REPROVADO', '', '🔴 a.ts:1 quebra com lista vazia', '', '🔴 b.ts:2 sem teste', '', block(R1, R2)].join('\n');
const CONTEST = ['R1: feito — a prova já existia em .myco/prints/lista-vazia.png (print de 22/11)', 'R2: não feito — o teste está em tests/b.test.ts:4, o diff não mostra porque já estava commitado'].join('\n');

const profile = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, reportsTo: [], ...extra }) as StaffProfile;

async function club(dirName: string, reviewerEngine: Engine = 'claude', opts: { repo?: boolean } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  if (opts.repo !== false) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', 'a.ts');
    git(dir, 'commit', '-q', '-m', 'base');
  }
  const people: Record<string, StaffProfile> = {
    'ana-1': profile('ana-1', 'Ana'),
    'rev-1': profile('rev-1', 'Rui', { role: 'Revisor', engine: reviewerEngine }),
    'gio-1': profile('gio-1', 'Giovana', { role: 'Orquestradora' }),
  };
  const h = {
    sent: [] as Array<{ staffId: string; session: string; text: string; reviewOnly: boolean | undefined }>,
    sentTo: [] as Array<{ session: string; text: string }>,
    notified: [] as Array<{ staffId: string; text: string }>,
    said: new Map<string, string>(),
    working: new Set<string>(),
    /** A próxima conversa nova da contestação falha (limite de consumo): o tick tenta de novo. */
    failContest: false,
    n: 0,
  };
  const make = () =>
    new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text, _force, _override, reviewOnly) => {
        if (h.failContest && /^\[Contestação/.test(text)) {
          h.failContest = false;
          throw new Error('limite de consumo');
        }
        const session = `${staffId}-${++h.n}`;
        h.sent.push({ staffId, session, text, reviewOnly });
        return session;
      },
      sendTo: async (_p, session, _staff, text) => {
        h.sentTo.push({ session, text });
        return session;
      },
      branchFor: async () => null,
      isWorking: (_p, _s, except) => {
        const skip = typeof except === 'string' ? [except] : [...(except ?? [])];
        return [...h.working].some((s) => !skip.includes(s));
      },
      isSessionWorking: () => false,
      lastText: (session) => h.said.get(session) ?? null,
      notify: async (_p, staffId, text) => {
        h.notified.push({ staffId, text });
      },
      hasAsk: () => false,
      answerAsk: () => false,
      awaitingLimit: async () => false,
      apiUrl: 'http://127.0.0.1:4848',
      sandboxApiUrl: 'http://127.0.0.2:4848',
      log: () => {},
    });
  const b = {
    dir,
    h,
    svc: make(),
    restart() {
      b.svc = make();
    },
    get: async (id: string) => (await b.svc.list('p'))!.find((t) => t.id === id)!,
  };
  return b;
}
type Club = Awaited<ReturnType<typeof club>>;

/** A Ana começa a tarefa (pedida pela Giovana, ou pelo dono), edita e a conversa de trabalho dela abre. O revisor é o Rui. */
async function begin(b: Club, requested = false) {
  const input = { title: 'Tela', description: 'Mostrar o card', acceptance: 'Sem erro no console', staffId: 'ana-1', reviewerId: 'rev-1' };
  const t = (requested ? await b.svc.create('p', input, 'gio-1', 'gio-s') : await b.svc.create('p', input))!;
  await b.svc.start('p', t.id);
  const work = (await b.get(t.id)).sessionId!;
  await edit(b, work);
  return { id: t.id, work };
}

/** O Club vê a Ana editar `a.ts` pela ferramenta de edição. */
const edit = (b: Club, work: string) => b.svc.onCodeEdit({ sessionId: work, projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: b.dir, files: [path.join(b.dir, 'a.ts')], request: null });

/** A Ana termina o turno dizendo `said`: o card vai a revisão e o Rui recebe o pedido da rodada. */
async function deliver(b: Club, id: string, work: string, said: string) {
  b.h.said.set(work, said);
  await b.svc.onTurnDone(work);
  return (await b.get(id)).review!.sessionId;
}

/** O Rui responde (a revisão da rodada, ou a conversa curta da contestação). */
async function answer(b: Club, session: string, text: string) {
  b.h.said.set(session, text);
  await b.svc.onTurnDone(session);
}

/** A primeira rodada até a reprovação: a Ana entrega, o Rui reprova com R1 e R2. */
async function rejected(b: Club, requested = false) {
  const { id, work } = await begin(b, requested);
  const review = await deliver(b, id, work, 'Fiz a tela.');
  await answer(b, review, REJECT);
  return { id, work, review };
}

const contestsTo = (b: Club) => b.h.sent.filter((s) => s.staffId === 'rev-1' && /^\[Contestação/.test(s.text));
const reviewRequests = (b: Club) => b.h.sent.filter((s) => s.staffId === 'rev-1' && /^\[Revisão da tarefa/.test(s.text));
const toWork = (b: Club, work: string) => b.h.sentTo.filter((m) => m.session === work);

/** A Ana responde ao ajuste SEM editar nada e o card vira contestação; devolve a conversa curta do Rui. */
async function contested(b: Club, id: string, work: string, said = CONTEST) {
  b.h.said.set(work, said);
  await b.svc.onTurnDone(work);
  const t = await b.get(id);
  return { t, session: t.contest?.sessionId ?? '' };
}

describe.each<Engine>(['claude', 'codex'])('contestação da reprovação, revisor no %s', (engine) => {
  it('1) reentrega depois da reprovação sem edição: o card fica em "fazendo" com a contestação exposta, sem rodada nova nem reprovação nova', async () => {
    const b = await club(`c1-${engine}`, engine);
    const { id, work } = await rejected(b);
    const before = await b.get(id);
    expect(before).toMatchObject({ status: 'doing', reviewRounds: 1, reworkRounds: 1 });
    const deliveryAt = before.delivery!.at;

    const { t } = await contested(b, id, work);
    expect(t.status).toBe('doing');
    expect(t.contest).toMatchObject({
      round: 1,
      at: expect.any(String),
      reviewer: { staffId: 'rev-1', name: 'Rui' },
      sessionId: expect.any(String),
      reply: CONTEST,
      items: [
        { id: 'R1', where: 'a.ts:1', problem: 'quebra com lista vazia', answer: 'R1: feito — a prova já existia em .myco/prints/lista-vazia.png (print de 22/11)' },
        { id: 'R2', where: 'b.ts:2', problem: 'sem teste', answer: expect.stringContaining('R2: não feito — o teste está em tests/b.test.ts:4') },
      ],
    });
    // Nada de rodada nova: a entrega é a mesma, as contagens não andam, a reprovação não se repete e o card nunca voltou a "revisão".
    expect(t.delivery!.at).toBe(deliveryAt);
    expect(t.reviewRounds).toBe(1);
    expect(t.reworkRounds).toBe(1);
    expect(t.rejections).toHaveLength(1);
    const afterReject = t.history.slice(t.history.findIndex((h) => /^reprovada por /.test(h.note ?? '')));
    expect(afterReject.map((h) => h.status)).not.toContain('review');
    expect(t.history.filter((h) => /^reprovada por /.test(h.note ?? ''))).toHaveLength(1);
    expect(reviewRequests(b)).toHaveLength(1);
    // A API de tarefas devolve o estado (a tela o lê), e a parada fala a mesma língua.
    expect(((await b.svc.list('p'))!.find((x) => x.id === id) as { contest?: unknown }).contest).toBeTruthy();
    expect(stuckState(t)).toMatchObject({ humanAction: null, selfHeals: true, reason: expect.stringContaining('contestou a reprovação sem editar') });
  });

  it('2) o revisor recebe só a contestação (a resposta item a item), numa conversa curta só de leitura, sem o diff nem o pedido de revisão inteiro', async () => {
    const b = await club(`c2-${engine}`, engine);
    const { id, work } = await rejected(b);
    await contested(b, id, work);
    const [msg] = contestsTo(b);
    expect(msg).toBeDefined();
    expect(msg!.reviewOnly).toBe(true);
    expect(msg!.text).toContain('SEM editar nenhum arquivo');
    expect(msg!.text).toContain('Não é uma rodada nova de revisão');
    expect(msg!.text).toContain('R1 · a.ts:1 — quebra com lista vazia');
    expect(msg!.text).toContain('R2 · b.ts:2 — sem teste');
    expect(msg!.text).toContain('“R1: feito — a prova já existia em .myco/prints/lista-vazia.png (print de 22/11)”');
    expect(msg!.text).toContain('`R1: MANTIDO — ');
    expect(msg!.text).toContain('`R1: RETIRADO — ');
    // Não é o pedido de revisão: nada de diff, critério de aceite, rubrica nem bloco novo de bloqueadores.
    expect(msg!.text).not.toContain('git diff');
    expect(msg!.text).not.toContain('Critério de aceite');
    expect(msg!.text).not.toContain('Rodada anterior');
    expect(msg!.text).not.toContain('[BLOQUEADORES]');
    expect(msg!.text.length).toBeLessThan(3000);
    expect(reviewRequests(b)).toHaveLength(1); // só a 1ª rodada
  });

  it('3a) o revisor retirou todos os 🔴: aprovado pelo fluxo normal (pronto), sem rodada nova nem reprovação nova', async () => {
    const b = await club(`c3a-${engine}`, engine);
    const { id, work } = await rejected(b, true);
    const { session } = await contested(b, id, work);
    await answer(b, session, 'R1: RETIRADO — vi o print em .myco/prints/lista-vazia.png, cobre o caso\nR2: **RETIRADO** — o teste existe em tests/b.test.ts:4');
    const t = await b.get(id);
    expect(t.status).toBe('done');
    expect(t.contest).toBeUndefined();
    expect(t.history.at(-1)!.note).toBe('aprovada por Rui');
    expect(t.reviewRounds).toBe(1);
    expect(t.reworkRounds).toBe(1);
    expect(t.rejections).toHaveLength(1);
    expect(t.rejections![0]!.contested).toMatchObject({ items: [{ id: 'R1', decision: 'withdraw', reason: expect.stringContaining('vi o print') }, { id: 'R2', decision: 'withdraw' }] });
    expect(reviewRequests(b)).toHaveLength(1);
    expect(toWork(b, work)).toHaveLength(1); // só o ajuste da reprovação; nada voltou ao executor
  });

  it('3b) o revisor manteve algum 🔴: volta ao executor com o motivo, como ajuste; o que foi retirado só é avisado', async () => {
    const b = await club(`c3b-${engine}`, engine);
    const { id, work } = await rejected(b);
    const { session } = await contested(b, id, work);
    await answer(b, session, 'R1: MANTIDO — o print é de outra tela, não prova a lista vazia; rode tests/a.test.ts\nR2: RETIRADO — achei o teste em tests/b.test.ts:4');
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'doing', reviewRounds: 1, reworkRounds: 1 });
    expect(t.contest).toBeUndefined();
    expect(t.rejections).toHaveLength(1);
    expect(t.rejections![0]!.contested).toMatchObject({
      at: expect.any(String),
      items: [{ id: 'R1', decision: 'keep', reason: expect.stringContaining('o print é de outra tela') }, { id: 'R2', decision: 'withdraw' }],
    });
    const msg = toWork(b, work).at(-1)!.text;
    expect(msg).toContain('[Revisão da tarefa "Tela"]');
    expect(msg).toContain('Rui conferiu a sua contestação da reprovação 1');
    expect(msg).toContain('MANTEVE este 🔴');
    expect(msg).toContain('- [ ] R1 · a.ts:1 — quebra com lista vazia');
    expect(msg).toContain('Como provar: rodar tests/a.test.ts e ficar verde');
    expect(msg).toContain('Por que ele mantém: o print é de outra tela');
    expect(msg).toContain('Ele RETIROU (não precisa fazer): R2 — achei o teste em tests/b.test.ts:4');
    expect(msg).toContain('o segundo impasse no mesmo item vai a quem pediu a tarefa');
    expect(msg).not.toContain('- [ ] R2');
    expect(reviewRequests(b)).toHaveLength(1);
    expect(t.history.filter((h) => /^reprovada por /.test(h.note ?? ''))).toHaveLength(1);
  });

  it('4) o segundo impasse no mesmo item (contesta de novo sem editar): Aguardar para quem pediu, com os dois lados, sem conversa nova nem rodada', async () => {
    const b = await club(`c4-${engine}`, engine);
    const { id, work } = await rejected(b, true);
    const { session } = await contested(b, id, work);
    await answer(b, session, 'R1: MANTIDO — o print é de outra tela, rode tests/a.test.ts\nR2: RETIRADO — achei o teste');
    expect(contestsTo(b)).toHaveLength(1);
    b.h.notified.length = 0;

    b.h.said.set(work, 'R1: não feito — insisto: o print de 22/11 prova a lista vazia, é a mesma tela');
    await b.svc.onTurnDone(work);
    const t = await b.get(id);
    expect(t.status).toBe('waiting');
    expect(t.contest).toBeUndefined();
    expect(t.waitReason).toContain('segundo impasse no mesmo item');
    expect(t.waitReason).toContain('contestou de novo sem editar');
    expect(t.waitReason).toContain('R1: revisor “o print é de outra tela, rode tests/a.test.ts”');
    expect(t.waitReason).toContain('responsável “R1: não feito — insisto: o print de 22/11 prova a lista vazia');
    expect(contestsTo(b)).toHaveLength(1); // sem laço: nenhuma contestação nova
    expect(reviewRequests(b)).toHaveLength(1);
    expect(t).toMatchObject({ reviewRounds: 1, reworkRounds: 1 });
    expect(t.rejections).toHaveLength(1);
    // Quem pediu (Giovana) é avisada na conversa dela, com os dois lados e o que fazer.
    expect(b.h.notified).toHaveLength(1);
    expect(b.h.notified[0]!.staffId).toBe('gio-1');
    expect(b.h.notified[0]!.text).toContain('segundo impasse no mesmo item');
    expect(b.h.notified[0]!.text).toContain('revisor — “o print é de outra tela, rode tests/a.test.ts”; responsável — “R1: não feito — insisto');
    expect(b.h.notified[0]!.text).toContain(`/tasks/${id}/cancel-request`);
    expect(b.h.notified[0]!.text).toContain('o dono');
  });

  it('4b) pedida pelo dono (sem gestor): Aguardar com o motivo, sem aviso a ninguém; o dono decide pelo quadro', async () => {
    const b = await club(`c4b-${engine}`, engine);
    const { id, work } = await rejected(b, false);
    const { session } = await contested(b, id, work);
    await answer(b, session, 'R1: MANTIDO — falta o teste\nR2: MANTIDO — falta o teste');
    b.h.said.set(work, 'R1: feito — está lá\nR2: feito — está lá');
    await b.svc.onTurnDone(work);
    const t = await b.get(id);
    expect(t.status).toBe('waiting');
    expect(t.waitReason).toContain('R1: revisor “falta o teste” | responsável “R1: feito — está lá”');
    expect(t.waitReason).toContain('R2: revisor “falta o teste” | responsável “R2: feito — está lá”');
    expect(b.h.notified).toHaveLength(0);
    expect(stuckState(t)).toMatchObject({ humanAction: 'decide', reason: expect.stringContaining('em Aguardar: segundo impasse no mesmo item') });
  });

  it('5) a contestação não conta no limite de 3 revisões automáticas: com o card no limite, ela ainda corre; nada de "limite atingido"', async () => {
    const b = await club(`c5-${engine}`, engine);
    const { id, work } = await rejected(b);
    // Duas rodadas de revisão já gastas além da 1ª: o próximo pedido de revisão seria barrado pelo limite.
    await b.svc.list('p');
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { tasks?: Array<{ id: string; reviewRounds?: number }> } | Array<{ id: string; reviewRounds?: number }>;
    const list = Array.isArray(raw) ? raw : raw.tasks!;
    list.find((t) => t.id === id)!.reviewRounds = 3;
    await fs.writeFile(file, JSON.stringify(raw));
    b.restart();

    const { t, session } = await contested(b, id, work);
    expect(t.contest).toBeTruthy();
    expect(t.reviewRounds).toBe(3);
    expect(t.history.map((h) => h.note ?? '').some((n) => /limite de \d+ revisões/.test(n))).toBe(false);
    await answer(b, session, 'R1: RETIRADO — ok\nR2: RETIRADO — ok');
    const done = await b.get(id);
    expect(done.status).toBe('done');
    expect(done.reviewRounds).toBe(3);
    expect(done.rejections).toHaveLength(1);
  });

  it('6) reentrega COM edição (a ferramenta de edição, ou o disco) segue o fluxo atual: rodada nova de revisão, sem contestação', async () => {
    const tool = await club(`c6a-${engine}`, engine);
    const a = await rejected(tool);
    await edit(tool, a.work); // o Club vê a edição depois da reprovação
    tool.h.said.set(a.work, 'R1: feito — a.ts:1\nR2: feito — b.ts:2');
    await tool.svc.onTurnDone(a.work);
    const t1 = await tool.get(a.id);
    expect(t1.status).toBe('review');
    expect(t1.contest).toBeUndefined();
    expect(t1.reviewRounds).toBe(2);
    expect(reviewRequests(tool)).toHaveLength(2);
    expect(contestsTo(tool)).toHaveLength(0);

    // Edição por shell, que o Club não vê pela ferramenta: o git a pega (arquivo mexido depois da reprovação).
    const disk = await club(`c6b-${engine}`, engine);
    const d = await rejected(disk);
    await sleep(60);
    await fs.writeFile(path.join(disk.dir, 'a.ts'), 'export const a = 2;\n');
    disk.h.said.set(d.work, 'R1: feito — a.ts:1\nR2: feito — b.ts:2');
    await disk.svc.onTurnDone(d.work);
    const t2 = await disk.get(d.id);
    expect(t2.status).toBe('review');
    expect(t2.contest).toBeUndefined();
    expect(t2.reviewRounds).toBe(2);
    expect(contestsTo(disk)).toHaveLength(0);

    // Edição e depois contestação do que sobrou também é entrega: a edição da rodada manda.
    const mixed = await club(`c6c-${engine}`, engine);
    const m = await rejected(mixed);
    await edit(mixed, m.work);
    mixed.h.said.set(m.work, 'R1: feito — a.ts:1\nR2: não feito — o teste já existia');
    await mixed.svc.onTurnDone(m.work);
    expect((await mixed.get(m.id)).status).toBe('review');
  });

  it('sem prova de ausência (projeto fora do git) a reentrega segue como entrega, como o "sem código"', async () => {
    const b = await club(`semgit-${engine}`, engine, { repo: false });
    const { id, work } = await rejected(b);
    b.h.said.set(work, CONTEST);
    await b.svc.onTurnDone(work);
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.contest).toBeUndefined();
    expect(contestsTo(b)).toHaveLength(0);
  });
});

describe('contestação: o que não muda e as bordas', () => {
  it('a primeira entrega sem código segue a regra "sem código" (não é contestação); nada de reprovação, nada de contestação', async () => {
    const b = await club('semcodigo');
    const t = (await b.svc.create('p', { title: 'Análise', description: 'Diga', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
    await b.svc.start('p', t.id);
    const work = (await b.get(t.id)).sessionId!;
    b.h.said.set(work, 'Respondi.');
    await b.svc.onTurnDone(work);
    const now = await b.get(t.id);
    expect(now.status).toBe('doing');
    expect(now.noCode).toBeTruthy();
    expect(now.contest).toBeUndefined();
    expect(contestsTo(b)).toHaveLength(0);
  });

  it('o revisor responde fora do formato: pede UMA vez de novo e, sem as linhas, o card vai a Aguardar; nada é retirado por omissão', async () => {
    const b = await club('formato');
    const { id, work } = await rejected(b, true);
    const { session } = await contested(b, id, work);
    await answer(b, session, 'Tudo certo, pode seguir.');
    expect(b.h.sentTo.filter((m) => m.session === session)).toHaveLength(1);
    expect(b.h.sentTo.find((m) => m.session === session)!.text).toContain('Faltou a linha de R1, R2.');
    expect((await b.get(id)).status).toBe('doing');
    expect((await b.get(id)).contest?.reasked).toBe(true);
    // Responde só R1: R2 segue faltando, e o re-pedido não se repete.
    await answer(b, session, 'R1: RETIRADO — ok');
    const t = await b.get(id);
    expect(t.status).toBe('waiting');
    expect(t.waitReason).toContain('o revisor não respondeu MANTIDO ou RETIRADO para R2');
    expect(b.h.sentTo.filter((m) => m.session === session)).toHaveLength(1);
    expect(b.h.notified.at(-1)!.text).toContain('a contestação não foi decidida');
  });

  it('duas linhas que se contradizem no mesmo item contam como falta (nada se decide por omissão)', async () => {
    const parsed = parseContestAnswer('R1: MANTIDO — a\nR1: RETIRADO — b\nR2: RETIRADO — c', ['R1', 'R2']);
    expect(parsed.missing).toEqual(['R1']);
    expect(parsed.decisions.get('R2')).toEqual({ keep: false, reason: 'c' });
  });

  it('o revisor não responde em 30 min: Aguardar com o lado do responsável; o tick não mexe antes disso', async () => {
    const b = await club('prazo');
    const { id, work } = await rejected(b, true);
    await contested(b, id, work);
    await b.svc.tick(later(10));
    expect((await b.get(id)).status).toBe('doing'); // dentro do prazo
    await b.svc.tick(later(ESCALATE_AFTER_MS / MIN + 1));
    const t = await b.get(id);
    expect(t.status).toBe('waiting');
    expect(t.contest).toBeUndefined();
    expect(t.waitReason).toContain('contestação sem decisão de Rui (ninguém decidiu em 30 min)');
    expect(t.waitReason).toContain('responsável “R1: feito — a prova já existia');
    expect(b.h.notified.at(-1)).toMatchObject({ staffId: 'gio-1' });
    expect(t.reviewRounds).toBe(1);
  });

  it('a conversa curta não abriu (limite de consumo): fica com a marca e o backoff, o tick abre depois, e a contestação segue', async () => {
    const b = await club('abrir');
    const { id, work } = await rejected(b);
    b.h.failContest = true;
    const { t } = await contested(b, id, work);
    expect(t.contest!.sessionId).toBeUndefined();
    expect(t.contest!.retry).toMatchObject({ attempts: 1 });
    expect(contestsTo(b)).toHaveLength(0);
    await b.svc.tick(later(5));
    const opened = await b.get(id);
    expect(opened.contest!.sessionId).toBeTruthy();
    expect(opened.contest!.retry).toBeUndefined();
    expect(contestsTo(b)).toHaveLength(1);
  });

  it('o Club reinicia com a contestação aberta: a conversa curta é reconhecida e a resposta do revisor decide', async () => {
    const b = await club('reinicio');
    const { id, work } = await rejected(b);
    const { session } = await contested(b, id, work);
    b.restart();
    await answer(b, session, 'R1: RETIRADO — ok\nR2: RETIRADO — ok');
    expect((await b.get(id)).status).toBe('done');
  });

  it('o fim de turno e a varredura chegando juntos decidem uma vez só (um ajuste, não dois)', async () => {
    const b = await club('dupla');
    const { id, work } = await rejected(b);
    const { session } = await contested(b, id, work);
    b.h.said.set(session, 'R1: MANTIDO — falta a prova\nR2: MANTIDO — falta a prova');
    const before = toWork(b, work).length;
    await Promise.all([b.svc.onTurnDone(session), b.svc.onTurnDone(session), b.svc.tick(later(1))]);
    expect(toWork(b, work).length - before).toBe(1);
    expect((await b.get(id)).rejections![0]!.contested!.items).toHaveLength(2);
  });

  it('com a contestação aberta a órfã não retoma a conversa nem entrega: o card espera o revisor', async () => {
    const b = await club('orfa');
    const { id, work } = await rejected(b);
    await contested(b, id, work);
    const before = toWork(b, work).length;
    await b.svc.tick(later(5)); // passa do ORPHAN_MS (2 min), dentro do prazo do revisor
    expect(toWork(b, work)).toHaveLength(before);
    expect((await b.get(id)).status).toBe('doing');
    expect((await b.get(id)).contest).toBeTruthy();
  });

  it('o ajuste da contestação mantida fica guardado com o executor ocupado em outra conversa, e o card volta a "revisão" até ele ir (como a reprovação)', async () => {
    const b = await club('ocupado');
    const { id, work } = await rejected(b);
    const { session } = await contested(b, id, work);
    b.h.working.add('outra-conversa-da-ana'); // a Ana está noutra conversa: o envio espera a vez dela
    const sentBefore = toWork(b, work).length;
    await answer(b, session, 'R1: MANTIDO — falta a prova\nR2: MANTIDO — falta a prova');
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.contest).toBeUndefined();
    expect(t.held).toHaveLength(1);
    expect(t.held![0]!.text).toContain('MANTEVE estes 🔴');
    expect(toWork(b, work)).toHaveLength(sentBefore);
    expect(t.rejections![0]!.contested!.items.every((i) => i.decision === 'keep')).toBe(true);
    expect(t.reviewRounds).toBe(1);
  });

  it('reprovação sem bloco válido: um item só (GERAL), e o revisor responde GERAL', async () => {
    const b = await club('geral');
    const { id, work } = await begin(b);
    const review = await deliver(b, id, work, 'Fiz a tela.');
    await answer(b, review, 'REPROVADO\n🔴 a.ts:1 quebra com lista vazia');
    const { t, session } = await contested(b, id, work, 'Já estava feito: a prova está em .myco/prints/x.png');
    expect(t.contest!.items).toEqual([{ id: 'GERAL', where: '(texto do revisor)', problem: expect.stringContaining('a.ts:1 quebra com lista vazia'), answer: 'Já estava feito: a prova está em .myco/prints/x.png' }]);
    await answer(b, session, 'GERAL: RETIRADO — vi o print');
    expect((await b.get(id)).status).toBe('done');
  });

  it('outro revisor marcado no card (não o que reprovou): sem contestação, a reentrega segue como entrega', async () => {
    const b = await club('outro-revisor');
    const { id, work } = await rejected(b);
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { tasks?: Array<{ id: string; reviewerId?: string }> } | Array<{ id: string; reviewerId?: string }>;
    const list = Array.isArray(raw) ? raw : raw.tasks!;
    list.find((t) => t.id === id)!.reviewerId = 'gio-1';
    await fs.writeFile(file, JSON.stringify(raw));
    b.restart();
    b.h.said.set(work, CONTEST);
    await b.svc.onTurnDone(work);
    expect((await b.get(id)).status).toBe('review');
    expect(contestsTo(b)).toHaveLength(0);
  });
});

describe('contestação: funções puras', () => {
  const rej = (extra: Partial<Rejection> = {}): Rejection => ({
    round: 1,
    at: '2026-11-24T10:00:00.000Z',
    deliveryAt: '2026-11-24T09:00:00.000Z',
    reviewer: { staffId: 'rev-1', name: 'Rui', sessionId: 's' },
    block: 'ok',
    blockers: [
      { id: 'R1', where: 'a.ts:1', problem: 'p1', proof: 'x1' },
      { id: 'R2', where: 'b.ts:2', problem: 'p2', proof: 'x2' },
      { id: 'R10', where: 'c.ts:3', problem: 'p10', proof: 'x10' },
    ],
    ...extra,
  });

  it('a linha de cada item sai da resposta do executor (lista, negrito, caixa marcada), com as linhas seguintes e sem confundir R1 com R10', () => {
    const reply = ['Resumo: nada mudou.', '- [x] **R1**: feito — a prova existe', '  em .myco/prints/a.png', '', '2) nada', 'R10: não feito — por quê', 'R2 — feito — b.test.ts:4'].join('\n');
    expect(replyLineFor(reply, 'R1')).toBe('- [x] **R1**: feito — a prova existe em .myco/prints/a.png');
    expect(replyLineFor(reply, 'R10')).toBe('R10: não feito — por quê');
    expect(replyLineFor(reply, 'R2')).toBe('R2 — feito — b.test.ts:4');
    expect(replyLineFor('sem item nenhum', 'R1')).toBe('');
    expect(contestItems(rej(), reply).map((i) => [i.id, !!i.answer])).toEqual([['R1', true], ['R2', true], ['R10', true]]);
  });

  it('a resposta do revisor aceita a marcação comum e ignora id que não foi pedido', () => {
    const text = ['- **R1**: **MANTIDO** — falta a prova', 'r2 retirado: o teste existe', 'R9: MANTIDO — não é daqui', 'R10 : MANTIDOS — não conta (palavra errada)'].join('\n');
    const parsed = parseContestAnswer(text, ['R1', 'R2', 'R10']);
    expect(parsed.decisions.get('R1')).toEqual({ keep: true, reason: 'falta a prova' });
    expect(parsed.decisions.get('R2')).toEqual({ keep: false, reason: 'o teste existe' });
    expect(parsed.missing).toEqual(['R10']);
  });

  it('os ids mantidos de qualquer reprovação do card valem para o segundo impasse', () => {
    const kept = rej({ contested: { at: 'x', items: [{ id: 'R1', where: 'a', problem: 'p', answer: 'a', decision: 'keep' }, { id: 'R2', where: 'b', problem: 'p', answer: 'a', decision: 'withdraw' }] } });
    expect([...keptContestIds([kept, rej({ round: 2 })])]).toEqual(['R1']);
    expect([...keptContestIds(undefined)]).toEqual([]);
  });
});
