import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InboxItem, TaskQuestion } from '../shared/model';
import { alertAction, isTaskAlert, stuckText, taskIdOf, questionText } from '../client/src/inbox/taskAlerts';
import { inboxText } from '../client/src/inbox/inboxText';
import type { Tr } from '../client/src/inbox/secretText';
import { DoubtBlock } from '../client/src/tasks/TaskDoubt';
import { ANSWER_MAX, answerBody, canAnswer, emptyPicks, togglePick } from '../client/src/tasks/doubtAnswer';
import staffMessages from '../client/src/i18n/staff';
import taskMessages from '../client/src/i18n/tasks';

type Locale = 'pt-BR' | 'en' | 'es';
const tr = (locale: Locale): Tr => (key, vars) => {
  const text = (staffMessages[locale] as Record<string, string>)[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
};

const asked = (over: Partial<TaskQuestion> = {}): TaskQuestion => ({
  id: 'q-1',
  source: 'ask',
  questions: [
    { question: 'Qual banco?', options: ['Postgres', 'SQLite'] },
    { question: 'Quais extras?', options: ['Cache', 'Fila', 'Logs'], multiSelect: true },
  ],
  status: 'escalated',
  askedAt: '2026-11-16T10:00:00Z',
  ...over,
});
const written = (over: Partial<TaskQuestion> = {}): TaskQuestion => ({ id: 'q-2', source: 'text', text: 'Posso apagar a tabela antiga?', status: 'escalated', askedAt: '2026-11-16T10:00:00Z', ...over });

describe('corpo da resposta da dúvida', () => {
  it('dúvida escrita: o texto aparado; vazio e acima do teto não enviam', () => {
    expect(answerBody(written(), [], '  pode, depois do backup  ')).toEqual({ questionId: 'q-2', text: 'pode, depois do backup' });
    expect(answerBody(written(), [], '   ')).toBeNull();
    expect(answerBody(written(), [], 'x'.repeat(ANSWER_MAX))).not.toBeNull();
    expect(answerBody(written(), [], 'x'.repeat(ANSWER_MAX + 1))).toBeNull();
  });

  it('por opções: toda pergunta precisa de uma opção; escolha única vai como texto, várias como lista', () => {
    const q = asked();
    expect(answerBody(q, emptyPicks(q), '')).toBeNull();
    expect(answerBody(q, [['SQLite'], []], '')).toBeNull();
    expect(answerBody(q, [['SQLite'], ['Cache', 'Logs']], '')).toEqual({
      questionId: 'q-1',
      answers: { 'Qual banco?': 'SQLite', 'Quais extras?': ['Cache', 'Logs'] },
    });
  });

  it('opção que não está na pergunta não passa (o corpo só leva o que o servidor mostrou)', () => {
    const q = asked();
    expect(answerBody(q, [['MySQL'], ['Cache']], '')).toBeNull();
  });

  it('pergunta chamada "__proto__" não se perde', () => {
    const q = asked({ questions: [{ question: '__proto__', options: ['a'] }] });
    const body = answerBody(q, [['a']], '');
    expect(Object.hasOwn(body!.answers!, '__proto__')).toBe(true);
  });

  it('dúvida por opções sem perguntas não tem como responder', () => {
    expect(canAnswer(asked({ questions: [] }))).toBe(false);
    expect(canAnswer(asked({ questions: undefined }))).toBe(false);
    expect(canAnswer(written())).toBe(true);
  });

  it('marcar: escolha única troca e desmarca a mesma; várias alternam só a clicada', () => {
    let picks = emptyPicks(asked());
    picks = togglePick(picks, 0, 'Postgres', false);
    picks = togglePick(picks, 0, 'SQLite', false);
    expect(picks[0]).toEqual(['SQLite']);
    picks = togglePick(picks, 0, 'SQLite', false);
    expect(picks[0]).toEqual([]);
    picks = togglePick(picks, 1, 'Cache', true);
    picks = togglePick(picks, 1, 'Fila', true);
    picks = togglePick(picks, 1, 'Cache', true);
    expect(picks[1]).toEqual(['Fila']);
  });
});

describe('bloco da dúvida no detalhe', () => {
  const nameOf = (id: string | null) => (id === 'gestor' ? 'Gil' : null);
  const target = { projectId: 'p1', taskId: 't-1', onAnswered: () => {} };
  const render = (question: TaskQuestion, withTarget = true) =>
    renderToStaticMarkup(createElement(DoubtBlock, { question, requestedBy: 'gestor', nameOf, now: Date.parse('2026-11-16T10:05:00Z'), ...(withTarget && { answer: target }) }));

  it('escrita com você: campo de texto e Responder desligado enquanto está vazio', () => {
    const html = render(written());
    expect(html).toContain('<textarea');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Responder<\/button>/);
    expect(html).toContain('Posso apagar a tabela antiga?');
  });

  it('por opções com você: as opções viram escolha (única e várias), sem a lista de leitura', () => {
    const html = render(asked());
    expect(html).toContain('class="q-option"');
    expect(html).toContain('q-option is-multi');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('<ul');
    expect(html).not.toContain('<textarea');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Responder<\/button>/);
  });

  it('com o gestor, respondida ou sem destino para a resposta: só leitura', () => {
    for (const html of [render(written({ status: 'open' })), render(written({ status: 'answered', answeredBy: 'user', answer: 'ok' })), render(written(), false)]) {
      expect(html).not.toContain('<textarea');
      expect(html).not.toContain('>Responder<');
    }
    // Por opções com o gestor segue a lista de antes.
    expect(render(asked({ status: 'open' }))).toContain('<ul');
  });

  it('o texto da dúvida é texto: HTML escrito pelo agente não vira marcação', () => {
    const html = render(written({ text: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

const base = { projectId: 'p1', projectName: 'MyCo', sessionId: '', staffId: null, name: 'Ana', at: '2026-11-16T10:00:00Z' };
const questionItem = (over: Partial<InboxItem> & Record<string, unknown> = {}): InboxItem =>
  ({
    ...base,
    id: 'question:t-1:q-2',
    kind: 'question',
    summary: 'dúvida da tarefa “Migrar”',
    question: { taskId: 't-1', taskTitle: 'Migrar', questionId: 'q-2', source: 'text', text: 'Posso apagar a tabela antiga?\nDepois do backup.', escalatedAt: '2026-11-16T10:00:00Z' },
    ...over,
  }) as unknown as InboxItem;
const stuckItem = (humanAction: string | null): InboxItem =>
  ({ ...base, id: 'stuck:t-3', kind: 'stuck', summary: 'resumo pt', stuck: { taskId: 't-3', taskTitle: 'Tela', reason: 'x', selfHeals: false, humanAction, since: '2026-11-16T09:00:00Z' } }) as unknown as InboxItem;
const blockedItem = (blockerStatus: string, humanAction?: string): InboxItem =>
  ({
    ...base,
    id: 'blocked:t-2:t-1',
    kind: 'blocked',
    summary: 'resumo pt',
    blocked: { taskId: 't-2', taskTitle: 'Tela', blockerId: 't-1', blockerTitle: 'API', blockerStatus, reason: 'x', ...(humanAction && { humanAction }) },
  }) as unknown as InboxItem;

describe('itens de tarefa parada na caixa', () => {
  it('dúvida escalada: a frase leva a pergunta inteira (linhas juntas), nos 3 idiomas, e a ação é responder no card da tarefa', () => {
    const item = questionItem();
    expect(questionText(item, tr('pt-BR'))).toBe('“Migrar”: Posso apagar a tabela antiga? Depois do backup.');
    expect(questionText(item, tr('en'))).toBe('“Migrar”: Posso apagar a tabela antiga? Depois do backup.');
    expect(inboxText(item, tr('pt-BR'))).toBe('“Migrar”: Posso apagar a tabela antiga? Depois do backup.');
    expect(alertAction(item, tr('pt-BR'))).toMatchObject({ action: 'answer', taskId: 't-1', label: 'Responder' });
    expect(alertAction(item, tr('en'))?.label).toBe('Answer');
    expect(taskIdOf(item)).toBe('t-1');
  });

  it('por opções: a primeira pergunta e quantas mais vieram', () => {
    const item = questionItem({
      question: { taskId: 't-1', taskTitle: 'Migrar', questionId: 'q-1', source: 'ask', questions: [{ question: 'Qual banco?', options: ['a', 'b'] }, { question: 'Quais extras?', options: ['c'] }], escalatedAt: '2026-11-16T10:00:00Z' },
    });
    expect(questionText(item, tr('pt-BR'))).toBe('“Migrar”: Qual banco? (e mais 1)');
    expect(questionText(item, tr('es'))).toBe('“Migrar”: Qual banco? (y 1 más)');
  });

  it('pergunta longa é cortada em 240 caracteres, com reticências; a de 200 passa inteira', () => {
    const long = questionItem({ question: { taskId: 't-1', taskTitle: 'Migrar', questionId: 'q', source: 'text', text: 'x'.repeat(400), escalatedAt: 'a' } });
    expect(questionText(long, tr('pt-BR'))).toBe(`“Migrar”: ${'x'.repeat(239)}…`);
    const mid = questionItem({ question: { taskId: 't-1', taskTitle: 'Migrar', questionId: 'q', source: 'text', text: 'x'.repeat(200), escalatedAt: 'a' } });
    expect(questionText(mid, tr('pt-BR'))).toBe(`“Migrar”: ${'x'.repeat(200)}`);
  });

  it('sem a estrutura (servidor sem o campo), vale o resumo do servidor', () => {
    const item = { ...questionItem(), question: undefined } as InboxItem;
    expect(questionText(item, tr('en'))).toBe('dúvida da tarefa “Migrar”');
    expect(alertAction(item, tr('en'))).toBeNull();
  });

  it('parada: uma frase e uma ação por humanAction, nos 3 idiomas', () => {
    const cases: Array<[string, string, string, string]> = [
      ['review', 'Revisar', 'Review', '“Tela” está sem revisão: o revisor não começou ou não deu o veredito'],
      ['resend', 'Reenviar ajuste', 'Resend adjustment', 'O ajuste de “Tela” não chegou ao funcionário'],
      ['decide', 'Decidir', 'Decide', '“Tela” está em Aguardar e espera sua decisão'],
      ['answer', 'Responder', 'Answer', '“Tela” tem uma dúvida esperando você'],
    ];
    for (const [action, pt, en, sentence] of cases) {
      const item = stuckItem(action);
      expect(stuckText(item, tr('pt-BR'))).toBe(sentence);
      expect(alertAction(item, tr('pt-BR'))).toMatchObject({ action, taskId: 't-3', label: pt });
      expect(alertAction(item, tr('en'))?.label).toBe(en);
      expect(stuckText(item, tr('es'))).not.toBe(sentence);
    }
  });

  it('só o reenvio do ajuste roda na caixa (direct); as outras ações abrem o card', () => {
    expect(alertAction(stuckItem('resend'), tr('pt-BR'))?.direct).toBe(true);
    for (const action of ['review', 'decide', 'answer']) expect(alertAction(stuckItem(action), tr('pt-BR'))?.direct).toBeUndefined();
    expect(alertAction(questionItem(), tr('pt-BR'))?.direct).toBeUndefined();
    // O dependente de quem tem ajuste parado só leva ao card da bloqueadora: o reenvio é no item dela.
    const dependent = alertAction(blockedItem('doing', 'resend'), tr('pt-BR'));
    expect(dependent).toMatchObject({ action: 'resend', taskId: 't-1', label: 'Ver ajuste' });
    expect(dependent?.direct).toBeUndefined();
  });

  it('parada que se recupera sozinha (sem humanAction): sem ação, resumo do servidor', () => {
    expect(alertAction(stuckItem(null), tr('pt-BR'))).toBeNull();
    expect(stuckText(stuckItem(null), tr('pt-BR'))).toBe('resumo pt');
  });

  it('dependente de tarefa parada: a ação abre o card de quem segura; cancelada tem os botões próprios', () => {
    const item = blockedItem('review', 'answer');
    expect(alertAction(item, tr('pt-BR'))).toMatchObject({ action: 'answer', taskId: 't-1', label: 'Responder' });
    expect(alertAction(item, tr('pt-BR'))?.title).toContain('“API”');
    expect(taskIdOf(item)).toBe('t-2');
    expect(alertAction(blockedItem('cancelled', 'decide'), tr('pt-BR'))).toBeNull();
    expect(alertAction(blockedItem('review'), tr('pt-BR'))).toBeNull();
  });

  it('item de tarefa não pinta o cartão do funcionário', () => {
    expect([questionItem(), stuckItem('review'), blockedItem('review')].every(isTaskAlert)).toBe(true);
    expect(isTaskAlert({ kind: 'waiting' })).toBe(false);
    expect(isTaskAlert({ kind: 'notStarted' })).toBe(false);
  });
});

describe('textos novos', () => {
  const keys = (messages: Record<string, Record<string, string>>, prefix: RegExp) => Object.keys(messages['pt-BR']!).filter((k) => prefix.test(k)).sort();

  it('a mesma lista de chaves nos 3 idiomas, nenhuma vazia', () => {
    for (const [messages, prefix] of [
      [taskMessages, /^tasks\.doubtReply/],
      [staffMessages, /^inbox\.(kindQuestion|titleQuestion|kindStuck|titleStuck|question\.|stuck\.|act\.)/],
    ] as const) {
      const pt = keys(messages as Record<string, Record<string, string>>, prefix);
      expect(pt.length).toBeGreaterThan(3);
      for (const locale of ['en', 'es'] as const) {
        expect(Object.keys(messages[locale]).filter((k) => prefix.test(k)).sort()).toEqual(pt);
        for (const k of pt) expect((messages[locale] as Record<string, string>)[k]!.trim()).not.toBe('');
      }
    }
  });
});
