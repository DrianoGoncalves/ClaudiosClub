import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InboxItem, StaffProfile, Task } from '../shared/model';
import { projectNeeds, staffNeeds } from '../client/src/inbox/needsYou';
import { stuckInboxItem } from '../server/inboxItems';
import { ownAlerts } from '../server/tasks';
import { ReviewerChip } from '../client/src/tasks/ReviewerChip';
import { TasksBoard } from '../client/src/tasks/TasksBoard';

// Card em Revisão: com revisor funcionário o card mostra quem revisa só pelo nome (a foto do cartão é de quem executa); o painel leva o retrato + nome. Nenhum selo de ação do dono com revisor funcionário; no limite de rodadas o selo "Você aprova ou reprova" continua.

const dav = { id: 'dav', name: 'Dav', role: 'Revisor', portrait: null, updatedAt: '2026-11-21T10:00:00.000Z', servers: [], reportsTo: [] } as unknown as StaffProfile;
const withPhoto = { ...dav, id: 'ana', name: 'Ana Souza', portrait: 'ana.png' } as unknown as StaffProfile;

const task = (over: Partial<Task> = {}): Task =>
  ({ id: 't1', title: 'Exportar em CSV', description: 'x', status: 'review', staffId: 'ana', sessionId: 's1', plan: null, branch: null, pr: null, history: [], createdAt: '2026-11-20T09:00:00.000Z', updatedAt: new Date().toISOString(), ...over }) as Task;
const board = (over: Partial<Task>) =>
  renderToStaticMarkup(createElement(TasksBoard, { projectId: 'p', projectName: 'Projeto', staff: [dav, withPhoto], costs: null, onClose: () => {}, onOpenStaff: () => {}, onChanged: () => {}, initialTasks: [task(over)] }));
const reviewedBy = { staffId: 'dav', sessionId: 'r1', at: '2026-11-21T10:00:00.000Z' };
const rejected = { ...reviewedBy, doneAt: '2026-11-21T10:10:00.000Z', verdict: 'rejected' as const };

describe('ReviewerChip', () => {
  it('foto: o retrato do funcionário e o nome; sem foto: iniciais', () => {
    const photo = renderToStaticMarkup(createElement(ReviewerChip, { id: 'ana', staff: [withPhoto], projectId: 'p' }));
    expect(photo).toContain('/api/projects/p/staff/ana/portrait?v=');
    expect(photo).toContain('>Ana Souza<');
    const initials = renderToStaticMarkup(createElement(ReviewerChip, { id: 'dav', staff: [dav], projectId: 'p' }));
    expect(initials).not.toContain('<img');
    expect(initials).toContain('<span>D</span>');
    expect(initials).toContain('>Dav<');
  });

  it('ficha apagada: o id vira nome, sem quebrar', () => {
    expect(renderToStaticMarkup(createElement(ReviewerChip, { id: 'x-1', staff: [], projectId: 'p' }))).toContain('>x-1<');
  });
});

describe('card em Revisão', () => {
  it('revisor funcionário e sem inboxWait: só o nome, sem selo "precisa de você" nem "Você aprova ou reprova"', () => {
    const html = board({ reviewerId: 'dav', review: reviewedBy });
    expect(html).toContain('class="task-reviewer small"');
    expect(html).toContain('<span class="task-reviewer-name">Dav</span>');
    expect(html).not.toContain('reviewer-chip');
    expect(html).not.toContain('needs-badge');
    expect(html).not.toContain('Você aprova ou reprova');
  });

  it('o cartão mostra quem revisa só pelo nome: sem foto, iniciais nem ícone, mesmo que o revisor tenha retrato', () => {
    const line = (html: string) => html.slice(html.indexOf('class="task-reviewer small"'), html.indexOf('</button>', html.indexOf('class="task-reviewer small"')));
    const noPhoto = line(board({ reviewerId: 'dav', review: reviewedBy }));
    expect(noPhoto).not.toContain('bn-portrait');
    expect(noPhoto).toContain('>Dav<');
    const photo = line(board({ reviewerId: 'ana', staffId: 'dav', review: { ...reviewedBy, staffId: 'ana' } }));
    expect(photo).not.toContain('bn-portrait');
    expect(photo).not.toContain('<img');
    expect(photo).toContain('>Ana Souza<');
  });

  it('em Revisão sem `reviewerId` na tarefa, quem recebeu o pedido de revisão aparece com o nome (sem retrato)', () => {
    const html = board({ review: reviewedBy });
    expect(html).toMatch(/class="task-reviewer small".*>Dav</);
    expect(html).not.toContain('bn-portrait');
  });

  it('limite de rodadas: o selo do dono continua, e quem reprovou segue visível', () => {
    const html = board({ reviewerId: 'dav', reviewRounds: 3, review: rejected });
    expect(html).toContain('Você aprova ou reprova');
    expect(html).toContain('>Dav<');
  });

  it('o dono é quem decide por inboxWait (ex.: revisão que não andou): o selo continua', () => {
    const html = board({ reviewerId: 'dav', inboxWait: { kind: 'review', by: 'owner', itemId: 'stuck:t1', since: '2026-11-21T10:00:00.000Z' } });
    expect(html).toContain('needs-badge tone-action');
  });

  it('sem revisor (o dono revisa): nenhuma linha de revisor', () => {
    expect(board({ review: null })).not.toContain('task-reviewer');
  });
});

// Os contadores leem os itens que o servidor deriva dos cards (mesma montagem de `getInbox`: `ownAlerts` + `stuckInboxItem`, com o funcionário do card), não listas escritas à mão.
describe('contadores de funcionário e projeto, com cards em Revisão', () => {
  const NOW = Date.parse('2026-11-21T12:00:00.000Z');
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const card = (id: string, staffId: string, over: Partial<Task>): Task =>
    ({ id, title: id, description: '', status: 'review', staffId, sessionId: null, plan: null, branch: null, pr: null, createdAt: ago(300), updatedAt: ago(60), history: [{ at: ago(60), status: 'review', by: 'auto' }], reviewerId: 'dav', ...over }) as Task;
  const itemsOf = (tasks: Task[]): InboxItem[] =>
    ownAlerts(tasks, NOW).map((a) => stuckInboxItem(a, { projectId: 'p', projectName: 'Projeto', sessionId: '', staffId: a.task.staffId, name: a.task.staffId ?? '' }));

  // ana: o revisor (Dav) está com a revisão aberta. bia: a revisão automática não começou, e o dono precisa agir. cai: o revisor funcionário foi pedido há pouco e ainda não houve revisão aberta.
  const inReview = card('t-ana', 'ana', { review: { staffId: 'dav', sessionId: 'r1', at: ago(10) } as Task['review'] });
  const notStarted = card('t-bia', 'bia', { reviewRetry: { attempts: 4, firstAt: ago(45), nextAt: ago(1), lastError: 'sem conversa', deliveryAt: null } });
  const justAsked = card('t-cai', 'cai', { history: [{ at: ago(2), status: 'review', by: 'auto' }] });

  it('revisão em andamento com revisor funcionário não vira item da caixa nem conta para o dono', () => {
    expect(itemsOf([inReview, justAsked])).toEqual([]);
    expect(staffNeeds(itemsOf([inReview]), 'p', 'ana', [])).toBeNull();
    expect(projectNeeds(itemsOf([inReview, justAsked]), 'p')).toBeNull();
  });

  it('misturado: só o card que espera o dono entra, no funcionário dele e no projeto', () => {
    const items = itemsOf([inReview, notStarted, justAsked]);
    expect(items.map((i) => i.id)).toEqual(['stuck:t-bia:review']);
    expect(staffNeeds(items, 'p', 'bia', [])).toEqual({ count: 1, reasons: ['stuck'] });
    expect(staffNeeds(items, 'p', 'ana', [])).toBeNull();
    expect(staffNeeds(items, 'p', 'cai', [])).toBeNull();
    expect(projectNeeds(items, 'p')).toEqual({ count: 1, reasons: ['stuck'] });
    expect(projectNeeds(items, 'q')).toBeNull();
  });

  it('o selo do cartão e o contador concordam: o card com revisor trabalhando não tem selo, o parado tem', () => {
    const html = (t: Task) => board({ ...t, id: 't1', ...(t.id === 't-bia' && { inboxWait: { kind: 'review', by: 'owner', itemId: 'stuck:t-bia:review', since: ago(45) } }) });
    expect(html(inReview)).not.toContain('needs-badge');
    expect(html(notStarted)).toContain('needs-badge tone-action');
  });
});

