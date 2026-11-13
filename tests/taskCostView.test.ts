import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskCostView as RankingView } from '../client/src/detail/TaskCostPanel';
import { TaskCostView as DetailView } from '../client/src/tasks/TaskCostBlock';
import { barSizes, bucketMeta, costText, coverageNote, coverageTag, reworkText, staffIndex, tokensTotal } from '../client/src/taskCost';
import type { Board, TaskCost, TaskCostBucket, TaskCostRanking, TaskTokens } from '../shared/model';

// Rotas simuladas: nenhum dado real. As regras que importam: US$ só do Claude (Codex = tokens + "US$ indisponível"),
// tokens null = "indisponível", nunca US$ 0 nem 0 tokens por falta de dado.

const tok = (input: number, output = 0, cacheRead = 0, cacheWrite = 0): TaskTokens => ({ input, output, cacheRead, cacheWrite });
const bucket = (over: Partial<TaskCostBucket> = {}): TaskCostBucket => ({ sessions: 0, withData: 0, usd: null, tokens: null, ...over });

const board = {
  projects: [{ id: 'p1', name: 'Loja' }],
  staff: [
    { id: 'ana', name: 'Ana', role: 'Dev', projectId: 'p1' },
    { id: 'bia', name: 'Bia', role: 'Gestora', projectId: 'p1' },
  ],
} as unknown as Board;
const staff = staffIndex(board);

const ranking: TaskCostRanking = {
  since: null,
  scanning: false,
  tasks: [
    { projectId: 'p1', taskId: 't1', title: 'Tela do carrinho', staffId: 'ana', requestedBy: 'bia', completedAt: '2026-11-10T10:00:00.000Z', coverage: 'complete', sessions: 3, usd: 4.5, tokens: tok(1000, 500, 20000, 3000), reworkRounds: 2, reviewRounds: 2 },
    { projectId: 'p1', taskId: 't2', title: 'Rota no Codex', staffId: 'ana', requestedBy: 'bia', completedAt: '2026-11-09T10:00:00.000Z', coverage: 'complete', sessions: 1, usd: null, tokens: tok(80000, 12000), reworkRounds: 0, reviewRounds: 0 },
    { projectId: 'p1', taskId: 't3', title: 'Antiga', staffId: null, requestedBy: null, completedAt: '2026-10-01T10:00:00.000Z', coverage: 'none', sessions: 0, usd: null, tokens: null, reworkRounds: 0, reviewRounds: 0 },
    { projectId: 'p1', taskId: 't4', title: 'Parcial', staffId: 'ana', requestedBy: 'bia', completedAt: '2026-10-02T10:00:00.000Z', coverage: 'partial', sessions: 2, usd: 1.2, tokens: tok(300), reworkRounds: 1, reviewRounds: 1 },
  ],
  executors: [
    { staffId: 'ana', tasks: 4, usd: 5.7, tokens: tok(81300), usdAvg: 2.85, tokensAvg: tok(40650), reworkTasks: 2, reworkShare: 0.5 },
    { staffId: 'zed', tasks: 1, usd: null, tokens: tok(1000), usdAvg: null, tokensAvg: tok(1000), reworkTasks: 0, reworkShare: 0 },
  ],
  managers: [{ staffId: 'bia', tasksRequested: 3, usd: 5.7, tokens: tok(81300), review: bucket({ sessions: 2, withData: 2, usd: 0.4, tokens: tok(900) }), question: bucket() }],
};

const render = (r: TaskCostRanking | null, error: string | null = null) =>
  renderToStaticMarkup(createElement(RankingView, { ranking: r, error, staff, period: createElement('span', null, 'SELETOR'), limit: 10, onMore: () => undefined, onOpenTask: () => undefined, onOpenPerson: () => undefined }));

describe('costText: US$ só do Claude, indisponível nunca vira zero', () => {
  it('Claude: US$ na frente e os tokens ao lado', () => {
    const c = costText({ usd: 4.5, tokens: tok(1000, 500, 20000, 3000) });
    expect(c.main).toBe('US$ 4,50');
    expect(c.sub).toContain('tokens');
    expect(c.detail).toContain('entrada');
  });

  it('Codex (usd null): tokens na frente e "US$ indisponível" ao lado, sem US$ 0', () => {
    const c = costText({ usd: null, tokens: tok(80000, 12000) });
    expect(c.main).toContain('tokens');
    expect(c.sub).toBe('US$ indisponível');
    expect(`${c.main} ${c.sub}`).not.toMatch(/US\$ 0/);
  });

  it('tokens null (conversa apagada): "indisponível", não 0', () => {
    expect(costText({ usd: null, tokens: null })).toEqual({ main: 'indisponível', sub: null, detail: null });
  });

  it('soma os quatro componentes', () => {
    expect(tokensTotal(tok(1, 2, 3, 4))).toBe(10);
  });
});

describe('textos de apoio', () => {
  it('cobertura: parcial e sem registro avisam; completa não diz nada', () => {
    expect(coverageNote('complete')).toBeNull();
    expect(coverageTag('complete')).toBeNull();
    expect(coverageNote('partial')).toMatch(/parcial/i);
    expect(coverageNote('none')).toMatch(/anterior ao registro/);
    expect(coverageTag('partial')).toBe('parcial');
    expect(coverageTag('none')).toBe('sem registro');
  });

  it('retrabalho em voltas e conversas com dado', () => {
    expect(reworkText(0)).toBe('sem retrabalho');
    expect(reworkText(1)).toBe('1 volta de retrabalho');
    expect(reworkText(3)).toBe('3 voltas de retrabalho');
    expect(bucketMeta({ sessions: 1, withData: 1 })).toBe('1 conversa');
    expect(bucketMeta({ sessions: 3, withData: 1 })).toBe('3 conversas · 1 com dado');
  });

  it('barras: proporcionais ao maior; sem valor, sem barra', () => {
    expect(barSizes([4, null, 2, 0])).toEqual([1, 0, 0.5, 0]);
    expect(barSizes([null, null])).toEqual([0, 0]);
  });

  it('funcionário: nome, ficha a abrir no RH e, sem ficha, o próprio id', () => {
    expect(staff.nameOf('ana', 'p1')).toBe('Ana');
    expect(staff.nameOf(null)).toBe('sem responsável');
    expect(staff.nameOf('zed')).toBe('zed');
    expect(staff.personOf('ana')).toEqual({ projectId: 'p1', staffId: 'ana' });
    expect(staff.personOf('zed')).toBeNull();
    expect(staff.projectName('p1')).toBe('Loja');
  });
});

describe('aba Tarefas do ranking', () => {
  it('as três listas, com o período no cabeçalho da primeira', () => {
    const html = render(ranking);
    for (const heading of ['Tarefas mais caras', 'Por executor', 'Por gestor']) expect(html).toContain(`<h3>${heading}</h3>`);
    expect(html).toContain('SELETOR');
    expect(html).toContain('Tela do carrinho');
    expect(html).toContain('US$ 4,50');
  });

  it('Codex e sem dado aparecem como indisponível, nunca US$ 0,00 nem 0 tokens', () => {
    const html = render(ranking);
    expect(html).toContain('US$ indisponível');
    expect(html).toContain('indisponível');
    expect(html).not.toContain('US$ 0,00');
    expect(html).not.toMatch(/>0 tokens</);
  });

  it('cobertura parcial e sem registro viram etiqueta; retrabalho aparece na linha', () => {
    const html = render(ranking);
    expect(html).toContain('>parcial<');
    expect(html).toContain('>sem registro<');
    expect(html).toContain('2 voltas de retrabalho');
  });

  it('executor: média por tarefa e % de retrabalho; sem preço, os tokens médios', () => {
    const html = render(ranking);
    expect(html).toContain('US$ 2,85');
    expect(html).toContain('retrabalho em 50% (2 de 4)');
    expect(html).toContain('zed'); // sem ficha no quadro: mostra o id
    expect(html).toMatch(/ranking-value[^>]*>[^<]*tokens/);
  });

  it('gestor: o custo do que pediu e as revisões e dúvidas dele', () => {
    const html = render(ranking);
    expect(html).toContain('pediu 3 tarefas');
    expect(html).toContain('revisões: 2 conversas · US$ 0,40');
    expect(html).toContain('dúvidas: —');
  });

  it('carregando, com erro e vazio', () => {
    expect(render(null)).toContain('Calculando…');
    expect(render(null, 'falhou')).toContain('falhou');
    const empty = render({ ...ranking, tasks: [], executors: [], managers: [] });
    expect(empty).toContain('Nenhuma tarefa concluída neste período.');
    expect(empty).not.toContain('Por executor');
  });

  it('lendo os transcripts: avisa que os números vão crescer', () => {
    expect(render({ ...ranking, scanning: true })).toContain('Ainda lendo os transcripts');
    expect(render(ranking)).not.toContain('Ainda lendo os transcripts');
  });
});

const cost = (over: Partial<TaskCost> = {}): TaskCost => ({
  taskId: 't1',
  coverage: 'complete',
  usd: 4.5,
  tokens: tok(1000, 500, 20000, 3000),
  byRole: {
    work: bucket({ sessions: 2, withData: 2, usd: 3.9, tokens: tok(800, 400, 15000, 2000) }),
    review: bucket({ sessions: 1, withData: 1, usd: 0.6, tokens: tok(200, 100, 5000, 1000) }),
    question: bucket(),
  },
  reworkRounds: 2,
  reviewRounds: 3,
  nodes: [
    { sessionId: 's1', role: 'work', staffId: 'ana', engine: 'claude', at: '2026-11-10T10:00:00.000Z', usd: 3.9, tokens: tok(800, 400, 15000, 2000) },
    { sessionId: 's2', role: 'review', staffId: 'bia', engine: 'codex', at: '2026-11-10T11:00:00.000Z', usd: null, tokens: tok(5000, 100) },
    { sessionId: 's3', role: 'review', staffId: null, engine: 'claude', at: '2026-11-10T12:00:00.000Z', usd: null, tokens: null },
  ],
  scanning: false,
  ...over,
});

const detail = (c: TaskCost | null, error: string | null = null) =>
  renderToStaticMarkup(createElement(DetailView, { cost: c, error, nameOf: (id: string | null) => (id ? `@${id}` : 'ninguém') }));

describe('custo no detalhe da tarefa', () => {
  it('total, fazer, revisar e dúvida, com as voltas de retrabalho', () => {
    const html = detail(cost());
    expect(html).toContain('Custo da tarefa · US$ 4,50');
    for (const label of ['Total', 'Fazer', 'Revisar', 'Dúvida']) expect(html).toContain(`<dt>${label}</dt>`);
    expect(html).toContain('US$ 3,90');
    expect(html).toContain('2 voltas de retrabalho');
    expect(html).toContain('3 revisões');
  });

  it('papel sem conversa mostra traço, não US$ 0', () => {
    const html = detail(cost());
    expect(html).toMatch(/<dt>Dúvida<\/dt><dd>—/);
    expect(html).not.toContain('US$ 0,00');
  });

  it('conversas: Codex sem US$ e conversa sem dado como indisponível', () => {
    const html = detail(cost());
    expect(html).toContain('Conversas (3)');
    expect(html).toContain('@bia');
    expect(html).toContain('Codex');
    expect(html).toContain('US$ indisponível');
    expect(html).toContain('ninguém');
    expect(html).not.toMatch(/>0 tokens</);
  });

  it('tarefa só do Codex: tokens e US$ indisponível no total', () => {
    const html = detail(cost({ usd: null, tokens: tok(80000, 12000), byRole: { work: bucket({ sessions: 1, withData: 1, usd: null, tokens: tok(80000, 12000) }), review: bucket(), question: bucket() }, nodes: [] }));
    expect(html).toContain('US$ indisponível');
    expect(html).toMatch(/Custo da tarefa · [^<]*tokens/);
    expect(html).not.toContain('US$ 0');
  });

  it('cobertura parcial e sem registro avisam no bloco', () => {
    expect(detail(cost({ coverage: 'partial' }))).toContain('Total parcial');
    const none = detail(cost({ coverage: 'none', usd: null, tokens: null, nodes: [], byRole: { work: bucket(), review: bucket(), question: bucket() } }));
    expect(none).toContain('anterior ao registro');
    expect(none).toContain('Custo da tarefa · indisponível');
    expect(none).not.toContain('US$ 0');
  });

  it('lendo os transcripts: estado de carregamento; carregando de início e erro', () => {
    expect(detail(cost({ scanning: true }))).toContain('Ainda lendo as conversas');
    expect(detail(null)).toContain('calculando…');
    expect(detail(null, 'falhou')).toContain('falhou');
  });
});
