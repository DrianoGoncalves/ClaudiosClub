import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, StaffProfile, Task } from '../shared/model';

// Atalho "Delegar revisão" no aviso de revisão parada da caixa (t-44a0c2): oferece só o que o painel do card oferece (mesma lista e mesma regra de quando
// aparece) e pede pela mesma rota. O vitest daqui é sem DOM: a regra (reviewShortcutOf), o pedido (askReview) e a lista renderizada de verdade
// (ReviewShortcutForm × ReviewDelegate, por SSR) são o que roda; o clique que abre o seletor está em "ligações" no fim.

vi.mock('../client/src/api', async (orig) => {
  const real = await orig<typeof import('../client/src/api')>();
  return { ...real, api: { ...real.api, taskReview: vi.fn() } };
});

import { api, ApiError } from '../client/src/api';
import { askReview, reviewShortcutOf, type AskReviewIo } from '../client/src/inbox/delegateReview';
import { ReviewShortcutForm } from '../client/src/inbox/ReviewShortcut';
import { alertAction } from '../client/src/inbox/taskAlerts';
import { ReviewDelegate } from '../client/src/tasks/ReviewDelegate';
import { byHierarchy, canPickReviewer, reviewerChoice, reviewersOf, reviewInProgress } from '../client/src/tasks/reviewPick';
import { t } from '../client/src/i18n';

const taskReview = vi.mocked(api.taskReview);

const person = (id: string, name: string, role: string, projectId = 'p1', reportsTo: string[] = []): StaffProfile => ({ id, name, role, projectId, reportsTo }) as StaffProfile;
const TEAM = [
  person('dev', 'Ana', 'Dev'),
  person('rev', 'Rui', 'Revisor'),
  person('orq', 'Denzel', 'Orquestrador(a)'),
  person('sec', 'Sol', 'Segurança', 'p1', ['orq']),
  person('out', 'Outro', 'Dev', 'p2'),
];
const task = (over: Partial<Task> = {}): Task => ({ id: 't-abc123', status: 'review', staffId: 'dev', title: 'Painel', ...over }) as Task;
const stuck = (over: Record<string, unknown> = {}, kind = 'stuck'): InboxItem =>
  ({
    id: 'stuck:t-abc123:review',
    kind,
    projectId: 'p1',
    sessionId: 's',
    summary: '',
    stuck: { taskId: 't-abc123', taskTitle: 'Painel', reason: 'a revisão automática não começou', selfHeals: false, humanAction: 'review', since: '2026-11-19T10:00:00.000Z', ...over },
  }) as InboxItem;
const ids = (list: StaffProfile[]) => list.map((s) => s.id);

describe('reviewShortcutOf (quando há atalho e quem entra)', () => {
  it('revisão parada com a tarefa em revisão: a ficha do projeto, na ordem da hierarquia, sem o responsável nem gente de outro projeto', () => {
    const got = reviewShortcutOf(stuck(), task(), TEAM);
    // O mesmo que o painel monta: ficha do projeto → byHierarchy → sem o responsável.
    expect(ids(got!.reviewers)).toEqual(ids(reviewersOf(byHierarchy(TEAM.filter((s) => s.projectId === 'p1')), task())));
    expect(ids(got!.reviewers)).toEqual(['orq', 'rev', 'sec']);
    expect(ids(got!.reviewers)).not.toContain('dev'); // o responsável não revisa a própria entrega
    expect(ids(got!.reviewers)).not.toContain('out'); // outro projeto
  });

  it('a ação do item segue sendo Revisar (a abertura do card não muda)', () => {
    expect(alertAction(stuck())?.action).toBe('review');
  });

  it('sem atalho quando o item não é a revisão parada', () => {
    expect(reviewShortcutOf(stuck({ humanAction: 'resend' }), task(), TEAM)).toBeNull();
    expect(reviewShortcutOf(stuck({ humanAction: 'answer' }), task(), TEAM)).toBeNull();
    expect(reviewShortcutOf(stuck({ humanAction: 'decide', noCode: true }), task(), TEAM)).toBeNull();
    expect(reviewShortcutOf(stuck({ humanAction: null }), task(), TEAM)).toBeNull();
    // 'blocked' com a bloqueadora precisando de revisão: o atalho fica no item `stuck` dela, não no do dependente.
    expect(reviewShortcutOf(stuck({}, 'blocked'), task(), TEAM)).toBeNull();
  });

  it('sem atalho enquanto a tarefa não foi lida, ou se a lida é outra', () => {
    expect(reviewShortcutOf(stuck(), null, TEAM)).toBeNull();
    expect(reviewShortcutOf(stuck(), task({ id: 't-zzz999' }), TEAM)).toBeNull();
  });

  it('o painel só pede revisão com a tarefa em revisão e sem pedido em andamento: o atalho segue a mesma regra', () => {
    const open = { staffId: 'rev', sessionId: 's', at: '2026-11-19T10:00:00.000Z' };
    expect(reviewShortcutOf(stuck(), task({ status: 'doing' }), TEAM)).toBeNull();
    expect(reviewShortcutOf(stuck(), task({ review: open }), TEAM)).toBeNull(); // revisor ainda sem responder
    expect(reviewShortcutOf(stuck(), task({ review: { ...open, doneAt: '2026-11-19T11:00:00.000Z' } }), TEAM)).not.toBeNull(); // respondeu sem veredito: dá para pedir outra
    expect(canPickReviewer(task({ review: open }))).toBe(false);
    expect(canPickReviewer(task())).toBe(true);
  });

  it('revisão superseded (ou anterior à última entrega) não conta como em andamento: painel e atalho deixam pedir de novo, como o servidor (liveReview)', () => {
    const open = { staffId: 'rev', sessionId: 's', at: '2026-11-19T10:00:00.000Z' };
    const old = task({ review: { ...open, superseded: true } });
    expect(reviewInProgress(old)).toBe(false);
    expect(canPickReviewer(old)).toBe(true);
    expect(reviewShortcutOf(stuck(), old, TEAM)).not.toBeNull();
    const redelivered = task({ review: open, delivery: { at: '2026-11-19T12:00:00.000Z', summary: '' } as Task['delivery'] });
    expect(reviewInProgress(redelivered)).toBe(false);
    expect(reviewInProgress(task({ review: open, delivery: { at: '2026-11-19T09:00:00.000Z', summary: '' } as Task['delivery'] }))).toBe(true);
    // O painel mostra o seletor quando o atalho mostra.
    const html = renderToStaticMarkup(createElement(ReviewDelegate, { projectId: 'p1', task: old, staff: TEAM.slice(0, 3), onChanged: () => {}, onOpenStaff: () => {} }));
    expect(html).toContain('<select');
  });

  it('sem ninguém para revisar a lista vem vazia (o seletor mostra o "contrate um revisor", como o painel)', () => {
    const lone = [person('dev', 'Ana', 'Dev')];
    expect(reviewShortcutOf(stuck(), task(), lone)).toEqual({ reviewers: [] });
  });
});

describe('o seletor do atalho = o do painel', () => {
  const options = (html: string) => [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*(?:<!-- -->[^<]*)*)<\/option>/g)].map((m) => [m[1], m[2]!.replace(/<!-- -->/g, '')]);
  const selected = (html: string) => /<option value="([^"]*)" selected/.exec(html)?.[1] ?? /<select[^>]*value="([^"]*)"/.exec(html)?.[1];
  const shortcut = (tk: Task) => renderToStaticMarkup(createElement(ReviewShortcutForm, { projectId: 'p1', task: tk, reviewers: reviewShortcutOf(stuck(), tk, TEAM)!.reviewers, onAsked: () => {} }));
  const panel = (tk: Task) =>
    renderToStaticMarkup(createElement(ReviewDelegate, { projectId: 'p1', task: tk, staff: byHierarchy(TEAM.filter((s) => s.projectId === 'p1')), onChanged: () => {}, onOpenStaff: () => {} }));

  it('mesmas opções, na mesma ordem, com o mesmo texto', () => {
    expect(options(shortcut(task()))).toEqual(options(panel(task())));
    expect(options(shortcut(task())).length).toBe(3);
  });

  it('mesmo padrão marcado, também depois de uma revisão respondida (outro revisor que não o último)', () => {
    const answered = task({ review: { staffId: 'orq', sessionId: 's', at: '2026-11-19T10:00:00.000Z', doneAt: '2026-11-19T11:00:00.000Z' } });
    expect(options(shortcut(answered))).toEqual(options(panel(answered)));
    expect(selected(shortcut(answered))).toBe(selected(panel(answered)));
    expect(selected(shortcut(answered))).not.toBe('orq');
  });

  it('o botão de confirmar diz "Delegar revisão" (ou "Delegar nova revisão" depois de uma resposta), como no painel', () => {
    expect(shortcut(task())).toContain(t('tasks.reviewDelegate'));
    const answered = task({ review: { staffId: 'orq', sessionId: 's', at: '2026-11-19T10:00:00.000Z', doneAt: '2026-11-19T11:00:00.000Z' } });
    expect(shortcut(answered)).toContain(t('tasks.reviewDelegateAgain'));
  });

  it('sem revisor possível: o aviso de contratar, sem seletor', () => {
    const html = renderToStaticMarkup(createElement(ReviewShortcutForm, { projectId: 'p1', task: task(), reviewers: [], onAsked: () => {} }));
    expect(html).toContain(t('tasks.hireReviewer'));
    expect(html).not.toContain('<select');
  });

  it('reviewerChoice: o marcado vale se ainda está na lista; senão o primeiro que não é o último revisor', () => {
    const list = reviewersOf(TEAM.slice(0, 3), task());
    expect(reviewerChoice(list, 'orq', undefined)).toBe('orq');
    expect(reviewerChoice(list, 'some', 'rev')).toBe('orq');
    expect(reviewerChoice(list, '', undefined)).toBe('rev');
    expect(reviewerChoice([], '', undefined)).toBe('');
  });
});

describe('askReview (o pedido)', () => {
  const io = () => {
    const log: string[] = [];
    const out: AskReviewIo & { log: string[]; asked: string[] } = {
      log,
      asked: [],
      setBusy: (b) => void log.push(`busy:${b}`),
      setError: (m) => void log.push(`error:${m}`),
      onAsked: (name) => void out.asked.push(name),
    };
    return out;
  };
  const reviewers = reviewersOf(TEAM.slice(0, 4), task());
  // Chaves, não seta: `mockReset()` devolve o próprio mock, e o vitest chamaria o que o beforeEach devolve como limpeza (rejeição solta).
  beforeEach(() => {
    taskReview.mockReset();
  });

  it('bate na MESMA rota do painel (api.taskReview: projeto, tarefa, revisor, sem force) e avisa quem recebeu', async () => {
    taskReview.mockResolvedValue(task({ review: { staffId: 'rev', sessionId: 's', at: 'x' } }));
    const o = io();
    await askReview('p1', task(), reviewers, 'rev', o);
    expect(taskReview).toHaveBeenCalledTimes(1);
    expect(taskReview).toHaveBeenCalledWith('p1', 't-abc123', 'rev', false);
    expect(o.asked).toEqual(['Rui']);
    expect(o.log).toEqual(['busy:true', 'error:null', 'busy:false']);
  });

  it('o servidor recusa: o erro aparece e o ocupado volta, sem aviso de sucesso', async () => {
    taskReview.mockRejectedValue(new ApiError('a revisão precisa ser de outro funcionário', null, null, {}, 400));
    const o = io();
    await askReview('p1', task(), reviewers, 'rev', o);
    expect(o.asked).toEqual([]);
    expect(o.log).toEqual(['busy:true', 'error:null', 'error:a revisão precisa ser de outro funcionário', 'busy:false']);
  });

  it('sem resposta (null, ex.: trava de consumo recusada): não diz que pediu', async () => {
    taskReview.mockResolvedValue(null);
    const o = io();
    await askReview('p1', task(), reviewers, 'rev', o);
    expect(o.asked).toEqual([]);
    expect(o.log).toEqual(['busy:true', 'error:null', 'busy:false']);
  });

  it('falha ao reler depois de pedir (onAsked lança): o erro aparece e o ocupado volta', async () => {
    taskReview.mockResolvedValue(task());
    const o = io();
    o.onAsked = () => {
      throw new Error('sem rede');
    };
    await askReview('p1', task(), reviewers, 'rev', o);
    expect(o.log.at(-1)).toBe('busy:false');
    expect(o.log).toContain('error:sem rede');
  });
});

describe('textos do atalho (pt, en, es)', () => {
  it('as 2 chaves novas existem nos 3 idiomas e a frase leva o nome', async () => {
    const { default: staff } = await import('../client/src/i18n/staff');
    for (const lang of ['pt-BR', 'en', 'es'] as const) {
      const m = staff[lang] as Record<string, string>;
      expect(m['inbox.act.delegateTitle'], lang).toBeTruthy();
      expect(m['inbox.act.delegated'], lang).toContain('{name}');
    }
  });
});

describe('ligações (sem DOM: só conferidas no código)', () => {
  it('InboxMenu: o link abre/fecha o seletor do item, e o item é lido do quadro do projeto', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../client/src/inbox/InboxMenu.tsx', import.meta.url), 'utf8');
    expect(src).toContain("stuckOf(i)?.humanAction === 'review'"); // o quadro do projeto é lido por causa desse item
    expect(src).toContain('reviewShortcutOf(item, stuckTask, staff)');
    expect(src).toMatch(/aria-expanded=\{delegating === item\.id\}/);
    expect(src).toContain('<ReviewShortcutForm');
    expect(src).toContain('aria-controls={`inbox-review-${item.id}`}');
    expect(src).toContain('id={`inbox-review-${item.id}`}');
    expect(src).toContain('setReviewReadError('); // falha da releitura vai para o topo do menu
    const dr = readFileSync(new URL('../client/src/inbox/delegateReview.ts', import.meta.url), 'utf8');
    expect(dr).not.toContain('TasksBoard');
  });
});
