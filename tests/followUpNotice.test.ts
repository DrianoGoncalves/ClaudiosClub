import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowUpNotice } from '../client/src/chat/FollowUpNotice';
import tasksMsgs from '../client/src/i18n/tasks';
import { isTaskAlert } from '../client/src/inbox/taskAlerts';
import {
  byWorth,
  cardBody,
  cardDraft,
  chatFollowUpIds,
  concludeDecision,
  conversationItemFor,
  discardDecision,
  discardReasonText,
  followUpNoticesFor,
  followUpSummary,
  followUpTitle,
  hasFields,
  taskFinished,
  verdictShown,
  whoWouldDo,
  withTaskStaff,
} from '../client/src/tasks/followUpNotice';
import { FollowUpBadge, sendCard } from '../client/src/tasks/TaskFollowUps';
import { TasksBoard } from '../client/src/tasks/TasksBoard';
import type { FollowUp, InboxItem, Task } from '../shared/model';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// O follow-up como balão na conversa de trabalho da tarefa, o selo do cartão que ocupa o lugar do "Aprovada", o "Finalizado" e as saídas (Criar card / Descartar; Revisar / Concluir).
// Contrato do servidor: `InboxItem.followUp` com os campos do revisor e `sessionId` = a conversa de trabalho; `POST .../followup/:id/card` e `.../resolve` (tests/followUpCard.test.ts).

const NOW = Date.parse('2026-11-18T12:00:00Z');
const AT = '2026-11-18T10:00:00Z';
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const noop = () => {};
const TEAM = [
  { id: 'ana', name: 'Ana' },
  { id: 'beto', name: 'Beto' },
];

const fields = (over: Partial<NonNullable<InboxItem['followUp']>> = {}): NonNullable<InboxItem['followUp']> => ({
  taskId: 't-aaaaaa',
  taskTitle: 'Tela do selo',
  followUpId: 'f-a1b2c3',
  by: 'rev',
  byName: 'Rita',
  text: 'Extrair o helper de data.\nHoje há duas cópias, uma em cada tela.',
  at: AT,
  recommendation: 'worth',
  title: 'Juntar as duas cópias do helper de data',
  impact: 'Quem muda o formato de data esquece uma das telas.',
  size: 'small',
  staffId: 'beto',
  staffName: 'Beto',
  ...over,
});
const item = (followUp: NonNullable<InboxItem['followUp']>, over: Partial<InboxItem> = {}): InboxItem => ({
  id: `followup:${followUp.taskId}:${followUp.followUpId}`,
  kind: 'followUp',
  projectId: 'p-1',
  projectName: 'MyCo',
  sessionId: 'sess-1',
  staffId: null,
  name: 'Beto',
  summary: 'x',
  at: followUp.at,
  followUp,
  ...over,
});
const legacy = (over: Partial<NonNullable<InboxItem['followUp']>> = {}) => fields({ recommendation: undefined, title: undefined, impact: undefined, size: undefined, staffId: undefined, staffName: undefined, ...over });
const task = (over: Partial<Task> = {}): Task => ({ id: 't-aaaaaa', title: 'Tela do selo', status: 'done', staffId: 'beto', requestedBy: null, createdAt: '2026-11-17T09:00:00Z', updatedAt: AT, history: [], ...over }) as Task;
const fu = (over: Partial<FollowUp> = {}): FollowUp => ({ id: 'f-a1b2c3', by: 'rev', at: AT, text: 'achado', status: 'open', to: 'owner', ...over });

const notice = (it: InboxItem, t: Task | null = null, team = TEAM) =>
  html(createElement(FollowUpNotice, { item: it, task: t, team, now: NOW, onChanged: noop, onGone: noop, onDecided: noop }));

describe('quais follow-ups viram balão nesta conversa', () => {
  it('só os da conversa (sessionId do item), sem repetir id, e sem conversa nenhum', () => {
    const mine = item(fields());
    const other = item(fields({ followUpId: 'f-000002' }), { sessionId: 'sess-2' });
    const notFollowUp = { ...item(fields({ followUpId: 'f-000003' })), kind: 'error' as const };
    expect(followUpNoticesFor([mine, other, notFollowUp, mine], 'sess-1').map((i) => i.id)).toEqual([mine.id]);
    expect(followUpNoticesFor([mine], null)).toEqual([]);
    expect(followUpNoticesFor(undefined, 'sess-1')).toEqual([]);
  });

  it('o "vale fazer" vem antes do opcional e do sem recomendação; no mesmo grau, o mais antigo primeiro', () => {
    const items = [
      item(fields({ followUpId: 'f-000001', recommendation: undefined, at: '2026-11-18T08:00:00Z' })),
      item(fields({ followUpId: 'f-000002', recommendation: 'optional', at: '2026-11-18T07:00:00Z' })),
      item(fields({ followUpId: 'f-000003', recommendation: 'worth', at: '2026-11-18T09:00:00Z' })),
      item(fields({ followUpId: 'f-000004', recommendation: 'worth', at: '2026-11-18T06:00:00Z' })),
    ];
    expect(followUpNoticesFor(items, 'sess-1').map((i) => i.followUp!.followUpId)).toEqual(['f-000004', 'f-000003', 'f-000002', 'f-000001']);
    expect(byWorth([fu({ id: 'a', recommendation: 'optional' }), fu({ id: 'b', recommendation: 'worth' })]).map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('o follow-up não pinta de amarelo a conversa do funcionário: conta como alerta de tarefa (o sessionId dele é só o alvo do balão)', () => {
    expect(isTaskAlert(item(fields()))).toBe(true);
  });
});

describe('balão do follow-up', () => {
  it('mostra o que importa para decidir: selo, título leigo, "Se não fizer", tamanho, quem faria e quem achou', () => {
    const out = notice(item(fields()));
    expect(out).toContain('fu-rec is-worth');
    expect(out).toContain('Vale fazer');
    expect(out).toContain('Juntar as duas cópias do helper de data');
    expect(out).toContain('Se não fizer:');
    expect(out).toContain('Quem muda o formato de data esquece uma das telas.');
    expect(out).toContain('Tamanho: pequeno');
    expect(out).toContain('Quem faria: Beto');
    expect(out).toContain('Achado de Rita há 2h00');
  });

  it('o "vale fazer" não depende de cor: o selo é texto e o opcional é outro texto, com a borda tracejada', () => {
    const out = notice(item(fields({ recommendation: 'optional' })));
    expect(out).toContain('fu-rec is-optional');
    expect(out).toContain('Opcional');
    expect(out).not.toContain('Vale fazer');
  });

  it('os detalhes técnicos vêm fechados, com o achado inteiro (o da caixa vem cortado em 600: vale o da tarefa)', () => {
    const cut = item(fields({ text: 'Extrair o helper de dat…' }));
    const full = task({ followUps: [fu({ text: 'Extrair o helper de data.\nHoje há duas cópias, uma em cada tela.' })] });
    const out = notice(cut, full);
    expect(out).toContain('<details class="fu-details"><summary>Detalhes técnicos</summary>');
    expect(out).not.toMatch(/<details[^>]* open/);
    expect(out).toContain('Hoje há duas cópias, uma em cada tela.');
    expect(out).not.toContain('helper de dat…');
  });

  it('o texto do autor é puro: HTML nele não vira marcação', () => {
    const out = notice(item(fields({ title: '<img src=x onerror=alert(1)>', impact: '<b>x</b>', text: '<script>1</script>' })));
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('tarefa aberta: "Criar card" e "Descartar"; sem o selo "Finalizado"', () => {
    for (const t of [null, task({ status: 'doing' })]) {
      const out = notice(item(fields()), t);
      expect(out).toContain('Criar card');
      expect(out).toContain('Descartar');
      expect(out).not.toContain('Finalizado');
      expect(out).not.toContain('Revisar');
      expect(out).not.toContain('Concluir');
    }
  });

  it('tarefa Finalizada: o selo "Finalizado" e as ações "Revisar" e "Concluir", sem "Criar card" nem "Descartar"', () => {
    const out = notice(item(fields()), task({ status: 'done' }));
    expect(out).toContain('fu-done');
    expect(out).toContain('Finalizado');
    expect(out).toContain('A tarefa já está Finalizada');
    expect(out).toContain('Revisar');
    expect(out).toContain('Concluir');
    expect(out).not.toContain('Criar card');
    expect(out).not.toContain('Descartar');
    expect(taskFinished(task({ status: 'done' }))).toBe(true);
    for (const status of ['todo', 'doing', 'review', 'cancelled'] as const) expect(taskFinished(task({ status }))).toBe(false);
    expect(taskFinished(null)).toBe(false);
  });

  it('follow-up antigo (sem os campos do revisor): a primeira linha do achado é o título e o texto fica nos detalhes', () => {
    const out = notice(item(legacy()));
    expect(out).toContain('Extrair o helper de data.');
    expect(out).toContain('Hoje há duas cópias');
    expect(out).not.toContain('Se não fizer');
    expect(out).not.toContain('fu-rec');
    expect(out).not.toContain('Tamanho:');
    expect(out).toContain('Criar card');
    expect(hasFields(legacy())).toBe(false);
    expect(hasFields(fields())).toBe(true);
    expect(followUpTitle({ title: undefined, text: 'Primeira.\nSegunda.' })).toBe('Primeira.');
  });

  it('quem faria vem do nome da ficha; sem o nome no item, da equipe; ficha que saiu, nada', () => {
    expect(whoWouldDo({ staffId: 'beto', staffName: 'Beto' }, [])).toBe('Beto');
    expect(whoWouldDo({ staffId: 'ana' }, TEAM)).toBe('Ana');
    expect(whoWouldDo({ staffId: 'zed' }, TEAM)).toBeNull();
    expect(whoWouldDo({}, TEAM)).toBeNull();
    expect(notice(item(fields({ staffId: 'zed', staffName: '' })))).not.toContain('Quem faria');
  });
});

describe('selo do cartão com os follow-ups', () => {
  const badge = (followUps: FollowUp[]) => html(createElement(FollowUpBadge, { task: { followUps } }));

  it('"2 follow-ups, 1 vale fazer"; sem nenhum "vale fazer", o selo de sempre', () => {
    expect(followUpSummary([{ recommendation: 'worth' }, { recommendation: 'optional' }])).toBe('2 follow-ups, 1 vale fazer');
    expect(followUpSummary([{ recommendation: 'worth' }])).toBe('1 follow-up, 1 vale fazer');
    expect(followUpSummary([{ recommendation: 'worth' }, { recommendation: 'worth' }, {}])).toBe('3 follow-ups, 2 vale fazer');
    expect(followUpSummary([{ recommendation: 'optional' }, {}])).toBe('2 follow-ups abertos');
    expect(followUpSummary([{}])).toBe('1 follow-up aberto');
    expect(badge([fu({ recommendation: 'worth' }), fu({ id: 'f-2', recommendation: 'optional' })])).toContain('2 follow-ups, 1 vale fazer');
  });

  it('só os abertos contam (os decididos saem da conta do selo)', () => {
    expect(badge([fu({ recommendation: 'worth' }), fu({ id: 'f-2', recommendation: 'worth', status: 'resolved', resolution: 'discarded' })])).toContain('1 follow-up, 1 vale fazer');
  });

  it('o "Aprovada" só vale sem follow-up aberto; a reprovação sempre aparece', () => {
    const review = (verdict: 'approved' | 'rejected') => ({ review: { verdict } as Task['review'] });
    expect(verdictShown({ ...review('approved'), followUps: [fu()] })).toBe(false);
    expect(verdictShown({ ...review('approved'), followUps: [fu({ status: 'resolved', resolution: 'card' })] })).toBe(true);
    expect(verdictShown({ ...review('approved'), followUps: [] })).toBe(true);
    expect(verdictShown({ ...review('approved') })).toBe(true);
    expect(verdictShown({ ...review('rejected'), followUps: [fu()] })).toBe(true);
    expect(verdictShown({ followUps: [fu()] })).toBe(false);
  });
});

// O quadro de verdade, com a tarefa carregada: separa o que é do cartão do que é do detalhe.
describe('no quadro', () => {
  const approved = (followUps: FollowUp[], over: Partial<Task> = {}) =>
    task({ status: 'done', review: { staffId: 'rev', verdict: 'approved' } as Task['review'], followUps, ...over });
  const render = (t: Task, extra: { inboxItems?: InboxItem[]; onOpenInbox?: () => void } = {}) => {
    const out = html(
      createElement(TasksBoard, { projectId: 'p-1', projectName: 'Projeto', staff: [], costs: null, onClose: noop, onOpenStaff: noop, onChanged: noop, initialTasks: [t], initialTaskId: t.id, ...extra }),
    );
    const at = out.indexOf('<aside class="task-detail">');
    expect(at).toBeGreaterThan(0);
    return { card: out.slice(0, at), detail: out.slice(at) };
  };

  it('com follow-up aberto o cartão mostra o selo dos follow-ups no lugar do "Aprovada" e não mostra o texto cru do achado', () => {
    const { card } = render(approved([fu({ recommendation: 'worth', title: 'Juntar helper', text: 'texto cru do achado' })]));
    expect(card).toContain('1 follow-up, 1 vale fazer');
    expect(card).not.toContain('Aprovada por');
    expect(card).not.toContain('texto cru do achado');
  });

  it('decididos todos, volta o "Aprovada" e o selo dos follow-ups sai', () => {
    const { card } = render(approved([fu({ status: 'resolved', resolution: 'discarded' })]));
    expect(card).toContain('Aprovada por');
    expect(card).not.toContain('follow-up');
  });

  it('o detalhe dos follow-ups com os campos do revisor não despeja o texto cru: título, selo e o achado recolhido', () => {
    const { detail } = render(approved([fu({ recommendation: 'worth', title: 'Juntar helper', impact: 'Quem muda esquece uma tela.', text: 'texto cru do achado' })]));
    expect(detail).toContain('Juntar helper');
    expect(detail).toContain('Se não fizer:');
    expect(detail).toContain('<details class="fu-details">');
    expect(detail).not.toMatch(/<p class="task-doubt-text">texto cru do achado/);
  });

  it('o follow-up antigo (sem os campos) segue aparecendo com o texto, como antes', () => {
    const { detail } = render(approved([fu({ text: 'texto cru do achado' })]));
    expect(detail).toContain('<p class="task-doubt-text">texto cru do achado</p>');
  });

  it('com a conversa na caixa, o detalhe leva a ela ("Abrir conversa") e não decide ali; sem conversa (ou sem como abrir), decide no próprio card', () => {
    const t = approved([fu({ recommendation: 'worth', title: 'Juntar helper', text: 'x' })]);
    const inboxItems = [item(fields({ title: 'Juntar helper' }))];
    const withChat = render(t, { inboxItems, onOpenInbox: noop }).detail;
    expect(withChat).toContain('Abrir conversa');
    expect(withChat).toContain('Decida na conversa de trabalho da tarefa');
    expect(withChat).not.toContain('Concluir');
    const noChat = render(t, { inboxItems: [], onOpenInbox: noop }).detail;
    expect(noChat).not.toContain('Abrir conversa');
    expect(noChat).toContain('Revisar');
    expect(noChat).toContain('Concluir');
    // Sem o `onOpenInbox` do App não há como abrir a conversa: o botão não aparece.
    expect(render(t, { inboxItems }).detail).not.toContain('Abrir conversa');
  });

  // Regra única: o servidor deixa decidir quem pediu a tarefa OU o dono (pela tela), então o dono vê as saídas no follow-up antigo e no novo, esteja ele com o gestor ou com você.
  describe('quem decide pela tela (a mesma regra para o antigo e o novo)', () => {
    const open = (over: Partial<FollowUp>, taskOver: Partial<Task> = {}) => render(approved([fu(over)], { requestedBy: 'ana', ...taskOver })).detail;
    const NEW = { recommendation: 'optional', title: 'Renomear variável', text: 'x' } as const;
    const OLD = { text: 'texto cru do achado' } as const;

    for (const [kind, shape] of [['novo', NEW], ['antigo', OLD]] as const) {
      for (const to of ['manager', 'owner'] as const) {
        it(`follow-up ${kind} com ${to === 'manager' ? 'o gestor' : 'você'}, sem conversa, tarefa Finalizada: o dono vê Revisar e Concluir`, () => {
          const detail = open({ ...shape, to });
          expect(detail).toContain('Revisar');
          expect(detail).toContain('Concluir');
        });
        it(`follow-up ${kind} com ${to === 'manager' ? 'o gestor' : 'você'}, sem conversa, tarefa em andamento: o dono vê Criar card e Descartar`, () => {
          const detail = open({ ...shape, to }, { status: 'doing', review: undefined });
          expect(detail).toContain('Criar card');
          expect(detail).toContain('Descartar');
        });
      }
    }

    it('com o gestor, a nota diz que quem pediu a tarefa também pode decidir; com você, não há essa nota', () => {
      expect(open({ ...NEW, to: 'manager' })).toContain('Quem pediu a tarefa também pode decidir');
      expect(open({ ...OLD, to: 'manager' })).toContain('Quem pediu a tarefa também pode decidir');
      expect(open({ ...NEW, to: 'owner' })).not.toContain('Quem pediu a tarefa também pode decidir');
      // A nota de quem pediu a tarefa segue ali (o quadro do teste não tem a ficha dele, então é "o gestor").
      expect(open({ ...NEW, to: 'manager' })).toContain('Espera o gestor, que pediu a tarefa.');
    });

    it('com a conversa na caixa, nenhum dos dois decide no detalhe: aponta para a conversa', () => {
      for (const shape of [NEW, OLD]) {
        const t = approved([fu({ ...shape, to: 'owner' })]);
        const detail = render(t, { inboxItems: [item(fields())], onOpenInbox: noop }).detail;
        expect(detail).toContain('Decida na conversa de trabalho da tarefa');
        expect(detail).not.toContain('Concluir');
      }
    });

    it('decidido, nenhum oferece saída', () => {
      const detail = open({ ...NEW, status: 'resolved', resolution: 'discarded', resolvedBy: 'you', to: 'owner' });
      expect(detail).not.toContain('Concluir');
      expect(detail).not.toContain('Criar card');
    });
  });

  it('follow-up já decidido, com os campos do revisor: mostra o título e o selo, não o texto cru', () => {
    const decided = { status: 'resolved', resolution: 'discarded', resolvedBy: 'you', resolvedAt: AT, recommendation: 'worth', title: 'Juntar helper', impact: 'Quem muda esquece uma tela.', text: 'texto cru do achado' } as const;
    const { detail } = render(approved([fu(decided)]));
    expect(detail).toContain('Juntar helper');
    expect(detail).toContain('Vale fazer');
    expect(detail).toContain('Se não fizer:');
    expect(detail).toContain('<details class="fu-details">');
    expect(detail).not.toMatch(/<p class="task-doubt-text">texto cru do achado/);
    expect(detail).toContain('Descartado');
  });

  it('follow-up decidido sem os campos (antigo) segue com o texto', () => {
    const { detail } = render(approved([fu({ status: 'resolved', resolution: 'discarded', resolvedBy: 'you', text: 'texto cru do achado' })]));
    expect(detail).toContain('<p class="task-doubt-text">texto cru do achado</p>');
  });
});

describe('a conversa de um follow-up', () => {
  it('o item que leva à conversa é o do "vale fazer" primeiro; sem sessionId (tarefa pedida por gestor, sem conversa) não há conversa', () => {
    const optional = item(fields({ followUpId: 'f-000002', recommendation: 'optional' }));
    const worth = item(fields({ followUpId: 'f-000003' }));
    const noSession = item(fields({ followUpId: 'f-000004' }), { sessionId: '' });
    expect(conversationItemFor('t-aaaaaa', [optional, worth, noSession])?.followUp?.followUpId).toBe('f-000003');
    expect(conversationItemFor('t-aaaaaa', [noSession])).toBeNull();
    expect(conversationItemFor('t-outra1', [worth])).toBeNull();
    expect(conversationItemFor('t-aaaaaa', [worth], 'p-outro')).toBeNull();
    expect([...chatFollowUpIds('t-aaaaaa', [optional, worth, noSession])].sort()).toEqual(['f-000002', 'f-000003']);
  });

  it('abrir a conversa precisa do funcionário da tarefa (o do item é de quem faria o ajuste): sem tarefa, ou com outra conversa, abre o card', () => {
    const it0 = item(fields());
    expect(withTaskStaff(it0, { sessionId: 'sess-1', staffId: 'ana' })?.staffId).toBe('ana');
    expect(withTaskStaff(it0, { sessionId: 'sess-1', staffId: null })?.staffId).toBeNull();
    expect(withTaskStaff(it0, { sessionId: 'sess-9', staffId: 'ana' })).toBeNull();
    expect(withTaskStaff(it0, { sessionId: null, staffId: 'ana' })).toBeNull();
    expect(withTaskStaff(it0, undefined)).toBeNull();
    // O staffId do follow-up (quem faria: beto) NÃO é o dono da conversa.
    expect(withTaskStaff(it0, { sessionId: 'sess-1', staffId: 'ana' })?.staffId).not.toBe(it0.followUp!.staffId);
  });
});

describe('criar card', () => {
  const base = { title: 'Juntar as duas cópias do helper de data', text: 'Achado inteiro.', staffId: 'beto' };

  it('o rascunho: responsável sugerido (se é da equipe), título do follow-up e o achado como descrição', () => {
    expect(cardDraft(base, { taskStaffId: 'ana', finished: false, team: TEAM })).toEqual({ staffId: 'beto', title: base.title, description: 'Achado inteiro.' });
  });

  it('sem sugestão, o responsável da tarefa; sugestão que saiu da equipe cai no da tarefa; ninguém da equipe, vazio', () => {
    expect(cardDraft({ ...base, staffId: undefined }, { taskStaffId: 'ana', finished: false, team: TEAM }).staffId).toBe('ana');
    expect(cardDraft({ ...base, staffId: 'zed' }, { taskStaffId: 'ana', finished: false, team: TEAM }).staffId).toBe('ana');
    expect(cardDraft({ ...base, staffId: 'zed' }, { taskStaffId: 'zed', finished: false, team: TEAM }).staffId).toBe('');
  });

  it('"Revisar" (tarefa Finalizada): o card vai para o responsável da tarefa, que ajusta o que entregou', () => {
    expect(cardDraft(base, { taskStaffId: 'ana', finished: true, team: TEAM }).staffId).toBe('ana');
    expect(cardDraft(base, { taskStaffId: null, finished: true, team: TEAM }).staffId).toBe('beto');
  });

  it('follow-up antigo: o título sai da primeira linha do achado, e passa de 120 vira reticências', () => {
    expect(cardDraft({ text: 'Primeira linha.\nSegunda.' }, { taskStaffId: null, finished: false, team: [] }).title).toBe('Primeira linha.');
    const long = cardDraft({ title: 'x'.repeat(200), text: 'y' }, { taskStaffId: null, finished: false, team: [] }).title;
    expect(long).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });

  it('o corpo do POST: o responsável sempre; título e descrição só se o dono mexeu (senão o servidor usa o achado inteiro)', () => {
    const initial = cardDraft(base, { taskStaffId: 'ana', finished: false, team: TEAM });
    expect(cardBody(initial, initial)).toEqual({ staffId: 'beto' });
    expect(cardBody({ ...initial, staffId: '' }, initial)).toEqual({ staffId: null });
    expect(cardBody({ ...initial, staffId: 'ana', title: '  Outro título  ' }, initial)).toEqual({ staffId: 'ana', title: 'Outro título' });
    expect(cardBody({ ...initial, description: 'Descrição minha.' }, initial)).toEqual({ staffId: 'beto', description: 'Descrição minha.' });
    // Título apagado: não manda vazio (o servidor recusa); o botão já fica desligado sem título.
    expect(cardBody({ ...initial, title: '   ' }, initial)).toEqual({ staffId: 'beto' });
  });
});

describe('descartar e concluir', () => {
  it('motivos prontos no idioma da tela, ou o texto livre; "outro" sem texto e nenhum marcado não valem', () => {
    expect(discardReasonText('cost', '')).toBe('Não vale o custo');
    expect(discardReasonText('done', '')).toBe('Já resolvido');
    expect(discardReasonText('scope', '')).toBe('Fora do escopo');
    expect(discardReasonText('other', '  porque sim  ')).toBe('porque sim');
    expect(discardReasonText('other', '   ')).toBeNull();
    expect(discardReasonText(null, 'texto solto')).toBeNull();
    // O texto livre só vale com "outro": um motivo pronto não leva o que sobrou no campo.
    expect(discardReasonText('cost', 'sobra')).toBe('Não vale o custo');
  });

  it('o corpo do descarte leva o motivo; sem motivo válido, nada é enviado', () => {
    expect(discardDecision('scope', '')).toEqual({ resolution: 'discarded', reason: 'Fora do escopo' });
    expect(discardDecision('other', 'já coberto pela t-cccccc')).toEqual({ resolution: 'discarded', reason: 'já coberto pela t-cccccc' });
    expect(discardDecision('other', '')).toBeNull();
    expect(discardDecision(null, '')).toBeNull();
  });

  it('"Concluir" usa a rota de descarte com o motivo "concluído sem ajuste" (nunca a de card)', () => {
    expect(concludeDecision()).toEqual({ resolution: 'discarded', reason: 'concluído sem ajuste' });
    expect(concludeDecision()).not.toHaveProperty('cardId');
  });
});

// O envio, com o servidor falso na borda: a rota, o corpo e o que a tela fica sabendo de cada resposta.
describe('enviar o card', () => {
  const REF = { projectId: 'p-1', taskId: 't-aaaaaa', followUpId: 'f-a1b2c3' };
  const reply = (status: number, body: unknown = {}) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const stubServer = (answer: () => Promise<Response>) => {
    const fetch = vi.fn(answer);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    return fetch;
  };
  const sent = (fetch: ReturnType<typeof stubServer>) => {
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    return { url, method: init.method, body: JSON.parse(init.body as string) as unknown };
  };
  const created = reply(200, { task: { id: 't-novo01', title: 'Juntar helper', status: 'waiting' }, followUp: { id: 'f-a1b2c3', status: 'resolved', resolution: 'card', cardId: 't-novo01' } });

  it('POST na rota do card com o corpo do rascunho; devolve o card criado e relê depois', async () => {
    const fetch = stubServer(created);
    const onDone = vi.fn();
    const out = await sendCard(REF, { staffId: 'ana', title: 'Juntar helper' }, onDone);
    expect(sent(fetch)).toEqual({ url: '/api/projects/p-1/tasks/t-aaaaaa/followup/f-a1b2c3/card', method: 'POST', body: { staffId: 'ana', title: 'Juntar helper' } });
    expect(out).toMatchObject({ error: null, gone: false, card: { id: 't-novo01' } });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('409 (já decidido por outro caminho): relê a lista e devolve o aviso no idioma da tela, marcado "gone"; sem card', async () => {
    stubServer(reply(409, { error: 'esse follow-up já foi decidido (descartado por o usuário)' }));
    const onDone = vi.fn();
    const out = await sendCard(REF, { staffId: null }, onDone);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ error: tasksMsgs['pt-BR']['tasks.fuErrDecided'], gone: true, card: null });
  });

  it('recusa do servidor (400): o texto dele fica sob o formulário, sem reler e sem "gone"', async () => {
    stubServer(reply(400, { error: 'staffId: id de funcionário inválido' }));
    const onDone = vi.fn();
    await expect(sendCard(REF, { staffId: 'x y' }, onDone)).resolves.toEqual({ error: 'staffId: id de funcionário inválido', gone: false, card: null });
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('textos nos 3 idiomas', () => {
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('o balão e as saídas têm as mesmas chaves e {parâmetros} em en e es', () => {
    const pt = tasksMsgs['pt-BR'] as Record<string, string>;
    for (const locale of ['en', 'es'] as const) {
      const msgs = tasksMsgs[locale] as Record<string, string>;
      for (const key of Object.keys(pt).filter((k) => /^tasks\.(fu|noCode)[A-Z]/.test(k))) {
        expect(msgs[key], `${locale} ${key}`).toBeTruthy();
        expect(vars(msgs[key]!), `${locale} ${key}`).toEqual(vars(pt[key]!));
      }
    }
  });

  it('"Finalizado" no balão usa o nome da coluna de cada idioma', () => {
    expect(tasksMsgs['pt-BR']['tasks.statusDone']).toBe('Finalizado');
    expect(tasksMsgs.en['tasks.statusDone']).toBe('Finished');
  });
});
