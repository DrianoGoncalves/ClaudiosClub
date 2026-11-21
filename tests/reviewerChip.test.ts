import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InboxItem, StaffProfile, Task } from '../shared/model';
import { projectNeeds, staffNeeds } from '../client/src/inbox/needsYou';
import { ReviewerChip } from '../client/src/tasks/ReviewerChip';
import { TasksBoard } from '../client/src/tasks/TasksBoard';

// Card em Revisão: com revisor funcionário o card mostra quem revisa (retrato + nome) e nenhum selo de ação do dono; no limite de rodadas o selo "Você aprova ou reprova" continua.

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
  it('revisor funcionário e sem inboxWait: retrato + nome, sem selo "precisa de você" nem "Você aprova ou reprova"', () => {
    const html = board({ reviewerId: 'dav', review: reviewedBy });
    expect(html).toContain('class="task-reviewer small"');
    expect(html).toContain('reviewer-chip');
    expect(html).toContain('>Dav<');
    expect(html).not.toContain('needs-badge');
    expect(html).not.toContain('Você aprova ou reprova');
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
    expect(board({ review: null })).not.toContain('reviewer-chip');
  });
});

describe('contadores de funcionário e projeto', () => {
  const item = (over: Partial<InboxItem>): InboxItem => ({ id: 'x', kind: 'plan', projectId: 'p', projectName: 'Projeto', sessionId: 's1', staffId: 'ana', name: 'Ana', summary: '', at: null, ...over });
  const stuck = (humanAction: 'review' | 'decide' | null): InboxItem =>
    item({ id: 'stuck:t1', kind: 'stuck', sessionId: '', stuck: { taskId: 't1', taskTitle: 'T1', reason: 'r', selfHeals: false, humanAction, since: '2026-11-21T10:00:00.000Z' } } as Partial<InboxItem>);

  it('revisão em andamento com revisor funcionário não gera item na caixa: contadores zerados', () => {
    expect(projectNeeds([], 'p')).toBeNull();
    expect(staffNeeds([], 'p', 'ana', ['s1'])).toBeNull();
  });

  it('o que espera o dono (revisão que não andou, limite) conta; a espera do limite do motor não', () => {
    expect(projectNeeds([stuck('review'), stuck('decide')], 'p')?.count).toBe(2);
    expect(projectNeeds([{ ...stuck(null), id: 'stuck:t1:fallback' }], 'p')).toBeNull();
  });
});
