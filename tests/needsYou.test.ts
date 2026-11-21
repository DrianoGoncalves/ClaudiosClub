import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InboxItem, Task } from '../shared/model';
import { NeedsYouBadge } from '../client/src/inbox/NeedsYouBadge';
import { needsYouItems, needsYouText, projectNeeds, staffNeeds } from '../client/src/inbox/needsYou';
import { footerPlan } from '../client/src/tasks/detailActions';
import { TasksBoard } from '../client/src/tasks/TasksBoard';

// O selo "precisa de você": a fonte é a caixa (pendente, tom `action`), nos três cartões (tarefa, funcionário, projeto), com o motivo no rótulo.

const item = (over: Partial<InboxItem>): InboxItem => ({ id: 'plan:s1', kind: 'plan', projectId: 'p', projectName: 'Projeto', sessionId: 's1', staffId: 'ana', name: 'Ana', summary: 'plano', at: null, ...over });
const stuck = (over: Partial<NonNullable<InboxItem['stuck']>> = {}): Partial<InboxItem> => ({
  id: 'stuck:t1', kind: 'stuck', sessionId: '', stuck: { taskId: 't1', taskTitle: 'T1', reason: 'r', selfHeals: false, humanAction: 'review', since: '2026-11-20T10:00:00.000Z', ...over },
});
const followUp = { id: 'fu:t1:a', kind: 'followUp', followUp: { taskId: 't1' } } as unknown as Partial<InboxItem>;

describe('needsYouItems: o que a caixa considera que espera o dono', () => {
  it('só o tom action: plano, permissão, resposta, dúvida, parada e follow-up; erro, rotina, bloqueio e uso não', () => {
    const kinds = ['plan', 'permission', 'waiting', 'question', 'stuck', 'followUp', 'error', 'routine', 'blocked', 'notStarted', 'usage', 'secret', 'orphan', 'denied'] as const;
    const got = needsYouItems(kinds.map((kind) => item({ id: kind, kind })));
    expect(got.map((i) => i.kind)).toEqual(['plan', 'permission', 'waiting', 'question', 'stuck', 'followUp']);
  });

  it('aviso resolvido e espera da troca de motor (sem ação do dono) ficam de fora', () => {
    expect(needsYouItems([item({ resolvedAt: '2026-11-20T10:00:00.000Z' })])).toEqual([]);
    expect(needsYouItems([item({ ...stuck({ humanAction: null }), id: 'stuck:t1:fallback' })])).toEqual([]);
  });
});

describe('staffNeeds / projectNeeds', () => {
  it('funcionário: pelo staffId ou pelas conversas; o fantasma só pelas conversas', () => {
    expect(staffNeeds([item({})], 'p', 'ana', [])).toEqual({ count: 1, reasons: ['plan'] });
    expect(staffNeeds([item({ staffId: null })], 'p', 'ana', ['s1'])?.count).toBe(1);
    expect(staffNeeds([item({})], 'p', 'bia', ['s9'])).toBeNull();
    expect(staffNeeds([item({})], 'p', null, ['s9'])).toBeNull();
    expect(staffNeeds([item({ staffId: null })], 'p', null, ['s1'])?.count).toBe(1);
  });

  it('projeto: tudo da sala, com o card sem código como motivo próprio', () => {
    expect(projectNeeds([], 'p')).toBeNull();
    expect(projectNeeds([item({}), item(stuck()), item({ projectId: 'q' })], 'p')?.count).toBe(2);
    expect(projectNeeds([item({ ...stuck({ noCode: { to: 'owner' } } as never) })], 'p')?.reasons).toEqual(['noCode']);
    expect(projectNeeds([item(followUp)], 'p')?.reasons).toEqual(['followUp']);
  });
});

describe('o selo: render com e sem pendência', () => {
  it('sem pendência não desenha nada', () => {
    expect(renderToStaticMarkup(createElement(NeedsYouBadge, { needs: null }))).toBe('');
    expect(renderToStaticMarkup(createElement(NeedsYouBadge, { needs: undefined, compact: true }))).toBe('');
  });

  it('um item: texto "Precisa de você", tom action e o motivo no aria-label e no title', () => {
    const html = renderToStaticMarkup(createElement(NeedsYouBadge, { needs: { count: 1, reasons: ['plan'] } }));
    expect(html).toContain('class="needs-badge tone-action"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Precisa de você: plano para aprovar"');
    expect(html).toContain('title="Precisa de você: plano para aprovar"');
    expect(html).toContain('>Precisa de você<');
  });

  it('vários: a contagem e todos os motivos; compacto mostra só ponto e número', () => {
    const needs = { count: 3, reasons: ['plan', 'followUp'] as const };
    const full = renderToStaticMarkup(createElement(NeedsYouBadge, { needs: { count: 3, reasons: [...needs.reasons] } }));
    expect(full).toContain('3 precisam de você: plano para aprovar, follow-up para decidir');
    const compact = renderToStaticMarkup(createElement(NeedsYouBadge, { needs: { count: 3, reasons: [...needs.reasons] }, compact: true }));
    expect(compact).toContain('needs-badge tone-action is-compact');
    expect(compact).toContain('<span aria-hidden="true">3</span>');
    expect(compact).not.toContain('precisam de você</span>');
    expect(renderToStaticMarkup(createElement(NeedsYouBadge, { needs: { count: 1, reasons: ['stuck'] }, compact: true }))).not.toMatch(/<span aria-hidden="true">\d/);
  });

  it('en e es: as chaves existem nos três idiomas', () => {
    const src = readFileSync('client/src/i18n/staff.ts', 'utf8');
    for (const key of ['needs.badge', 'needs.badgeMany', 'needs.label', 'needs.reason.plan', 'needs.reason.permission', 'needs.reason.waiting', 'needs.reason.question', 'needs.reason.noCode', 'needs.reason.stuck', 'needs.reason.followUp', 'needs.reason.review', 'needs.reason.resend', 'needs.reason.blocked']) {
      expect(src.split(`'${key}':`).length - 1, key).toBe(3);
    }
    expect(needsYouText({ count: 2, reasons: ['plan'] }).text).toBe('2 precisam de você');
  });

  it('o CSS usa só tokens (nenhuma cor solta) e a cor vem do --tone', () => {
    const lines = readFileSync('client/src/styles.css', 'utf8').split('\n').filter((l) => /^\.needs-(badge|dot)/.test(l));
    expect(lines.length).toBe(3);
    for (const l of lines) expect(l).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(lines.join('\n')).toContain('var(--tone)');
  });
});

describe('os três cartões', () => {
  const task = (over: Partial<Task> = {}): Task =>
    ({ id: 't1', title: 'Exportar em CSV', description: 'x', status: 'doing', staffId: 'ana', sessionId: 's1', plan: null, branch: null, pr: null, history: [], createdAt: '2026-11-20T09:00:00.000Z', updatedAt: new Date().toISOString(), ...over }) as Task;
  const board = (over: Partial<Task> = {}) =>
    renderToStaticMarkup(createElement(TasksBoard, { projectId: 'p', projectName: 'Projeto', staff: [], costs: null, onClose: () => {}, onOpenStaff: () => {}, onChanged: () => {}, initialTasks: [task(over)] }));
  const wait = (by: 'owner' | 'manager', kind: 'plan' | 'review' = 'plan') => ({ inboxWait: { kind, by, itemId: 'plan:s1', since: '2026-11-20T10:00:00.000Z' } });

  it('tarefa: o selo vem de Task.inboxWait (dono); sem o campo ou com ação do gestor não aparece', () => {
    expect(board()).not.toContain('needs-badge');
    expect(board(wait('manager'))).not.toContain('needs-badge');
    const html = board(wait('owner'));
    expect(html).toContain('needs-badge tone-action');
    expect(html).toContain('aria-label="Precisa de você: plano para aprovar"');
    expect(board(wait('owner', 'review'))).toContain('aria-label="Precisa de você: revisão que não andou"');
  });
});

describe('o rodapé do painel: a ação principal aponta para a pendência', () => {
  const base = { task: { id: 't1', status: 'planning', sessionId: 's1', staffId: 'ana', history: [] } as unknown as Task, asks: [], queuePos: 0, canOpenPermission: false, hasChat: true };

  it('plano esperando: a principal abre a conversa; sem plano, segue a regra de antes', () => {
    expect(footerPlan({ ...base, planWaiting: true }).primary).toBe('openChat');
    const review = { ...base, task: { ...base.task, status: 'review' } as Task };
    expect(footerPlan({ ...review, planWaiting: false }).primary).toBe('approve');
    expect(footerPlan({ ...review, planWaiting: true }).primary).toBe('openChat');
    expect(footerPlan({ ...review, planWaiting: true }).secondary).toContain('approve');
  });
});
