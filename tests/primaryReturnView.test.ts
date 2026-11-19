import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../shared/model';
import { PrimaryReturnBadge, PrimaryReturnLine } from '../client/src/staff/FallbackBadge';
import { parsePrimaryNote, primaryNoteText, primaryReturnOf } from '../client/src/tasks/primaryReturn';
import { TasksBoard } from '../client/src/tasks/TasksBoard';

// A volta da tarefa ao motor principal na tela (contrato: server/tasks.ts `moveToPrimary`, tests/primaryReturn.test.ts): `Task.fallback` some e o
// histórico guarda a nota em pt. Aqui: ler a nota, o selo do cartão e a linha do detalhe, e a frase no idioma da tela.

// As frases abaixo são CÓPIAS do que o servidor grava (server/tasks.ts): elas não acompanham uma mudança de texto lá. Quem pega essa mudança é
// tests/primaryReturn.test.ts, que passa a nota gravada de verdade pelo `parsePrimaryNote`.
const BACK = 'motor principal liberado: voltou ao Claude em conversa nova, com o resumo da anterior';
const BACK_CODEX = 'motor principal liberado: voltou ao Codex em conversa nova, com o resumo da anterior';
const FAILED = 'motor principal liberado, mas a conversa nova no Claude não abriu (motor indisponível); segue na conversa do secundário';
const QUEUE = 'retomada na fila, em conversa nova no motor principal, com Ana';
const QUEUE_ACK = `${QUEUE}; você tinha confirmado a retomada, sem a checagem de ação cortada`;
const AT = '2026-11-17T17:32:00.000Z';

const task = (over: Partial<Task> = {}): Pick<Task, 'status' | 'fallback' | 'history'> => ({
  status: 'doing',
  history: [
    { at: '2026-11-17T15:00:00.000Z', status: 'doing', by: 'auto', note: 'limite do Claude no meio do turno: passa para o secundário' },
    { at: AT, status: 'doing', by: 'auto', note: BACK },
  ],
  ...over,
});

describe('parsePrimaryNote: lê as notas que o servidor grava', () => {
  it('a volta, nos dois motores', () => {
    expect(parsePrimaryNote(BACK)).toEqual({ kind: 'back', engine: 'claude' });
    expect(parsePrimaryNote(BACK_CODEX)).toEqual({ kind: 'back', engine: 'codex' });
  });

  it('a conversa nova que não abriu: o motivo vem junto, mesmo com parênteses nele', () => {
    expect(parsePrimaryNote(FAILED)).toEqual({ kind: 'failed', engine: 'claude', reason: 'motor indisponível' });
    expect(parsePrimaryNote(FAILED.replace('motor indisponível', 'erro (código 3)'))).toMatchObject({ kind: 'failed', reason: 'erro (código 3)' });
  });

  it('a retomada da fila em conversa nova no principal; o sufixo da ciência do corte fica fora do nome', () => {
    expect(parsePrimaryNote(QUEUE)).toEqual({ kind: 'queue', who: 'Ana', acked: false });
    expect(parsePrimaryNote(QUEUE_ACK)).toEqual({ kind: 'queue', who: 'Ana', acked: true });
    // Nome com espaço ou ponto e vírgula próprio não confunde com o sufixo: só o texto exato do servidor, no fim, conta.
    expect(parsePrimaryNote(QUEUE.replace('Ana', 'Ana Maria'))).toMatchObject({ who: 'Ana Maria', acked: false });
    expect(parsePrimaryNote(QUEUE.replace('Ana', 'Ana; você tinha ido'))).toMatchObject({ who: 'Ana; você tinha ido', acked: false });
  });

  it('outra nota, ou nenhuma, não é da volta (e motor desconhecido não casa)', () => {
    expect(parsePrimaryNote('conversa parou sem terminar: retomada')).toBeNull();
    expect(parsePrimaryNote(undefined)).toBeNull();
    expect(parsePrimaryNote(BACK.replace('Claude', 'Gemini'))).toBeNull();
  });
});

describe('primaryReturnOf: quando o selo existe', () => {
  it('tarefa aberta, fora do secundário, com a volta no histórico: motor e hora da volta', () => {
    expect(primaryReturnOf(task())).toEqual({ at: AT, engine: 'claude' });
  });

  it('a volta mais recente vale (voltou, trocou de novo e voltou)', () => {
    const second = { at: '2026-11-18T09:00:00.000Z', status: 'doing' as const, by: 'auto' as const, note: BACK_CODEX };
    expect(primaryReturnOf(task({ history: [...task().history, second] }))).toEqual({ at: second.at, engine: 'codex' });
  });

  it('no secundário de novo: o selo é o do secundário, não o da volta', () => {
    const fallback = { engine: 'codex', model: 'gpt-5', from: 'claude', at: Date.now(), fromSession: 's', reason: 'limit-mid' } as const;
    expect(primaryReturnOf(task({ fallback }))).toBeNull();
  });

  it('encerrada (pronta ou cancelada): sem selo; o histórico segue contando', () => {
    expect(primaryReturnOf(task({ status: 'done' }))).toBeNull();
    expect(primaryReturnOf(task({ status: 'cancelled' }))).toBeNull();
    expect(primaryReturnOf(task({ status: 'review' }))).not.toBeNull();
  });

  it('nunca voltou, ou só avisou que a conversa nova não abriu: sem selo (continua no secundário)', () => {
    expect(primaryReturnOf(task({ history: [] }))).toBeNull();
    expect(primaryReturnOf(task({ history: [{ at: AT, status: 'doing', by: 'auto', note: FAILED }] }))).toBeNull();
  });

  describe('reaberta depois de encerrada: a volta de antes do encerramento não conta', () => {
    const back = task().history;
    // Cancelada volta pelo `reopen` do servidor (para "a fazer", nota "reaberta"); pronta, pelo arrasto do dono para outra coluna.
    const cancelled = { at: '2026-11-18T10:00:00.000Z', status: 'cancelled' as const, by: 'you' as const, note: 'cancelada' };
    const reopened = { at: '2026-11-18T11:00:00.000Z', status: 'todo' as const, by: 'you' as const, note: 'reaberta' };
    const done = { at: '2026-11-18T10:00:00.000Z', status: 'done' as const, by: 'auto' as const, note: 'aprovada por Rui' };
    const dragged = { at: '2026-11-18T11:00:00.000Z', status: 'doing' as const, by: 'you' as const };
    const second = { at: '2026-11-18T12:00:00.000Z', status: 'doing' as const, by: 'auto' as const, note: BACK_CODEX };

    it('cancelada e reaberta: o selo não volta com a data antiga', () => {
      expect(primaryReturnOf(task({ status: 'todo', history: [...back, cancelled, reopened] }))).toBeNull();
    });

    it('pronta e levada de volta para "fazendo": o selo não volta com a data antiga', () => {
      expect(primaryReturnOf(task({ status: 'doing', history: [...back, done, dragged] }))).toBeNull();
    });

    it('a volta que acontece depois da reabertura conta (e só ela)', () => {
      expect(primaryReturnOf(task({ status: 'doing', history: [...back, cancelled, reopened, second] }))).toEqual({ at: second.at, engine: 'codex' });
    });

    it('sem encerramento no meio, a volta continua valendo (outras mudanças de coluna não a apagam)', () => {
      const moved = { at: '2026-11-18T10:00:00.000Z', status: 'review' as const, by: 'auto' as const, note: 'entregue' };
      expect(primaryReturnOf(task({ status: 'review', history: [...back, moved] }))).toEqual({ at: AT, engine: 'claude' });
    });
  });
});

describe('selo do cartão e linha do detalhe', () => {
  it('o selo diz o motor, tem a borda contínua (is-back) e o tooltip com a hora; o do secundário não é afetado', () => {
    const html = renderToStaticMarkup(createElement(PrimaryReturnBadge, { task: task() }));
    expect(html).toContain('fallback-badge is-back small');
    expect(html).toContain('voltou ao principal: Claude');
    expect(html).toMatch(/title="Voltou ao Claude em [^"]+: o limite liberou/);
  });

  it('o detalhe escreve a volta por extenso (sem depender do tooltip, que o toque não tem)', () => {
    const html = renderToStaticMarkup(createElement(PrimaryReturnLine, { task: task() }));
    expect(html).toContain('<p class="muted small">Voltou ao Claude em ');
    expect(html).toContain('conversa nova no motor principal');
  });

  it('sem volta (ou no secundário): nada renderiza, nem selo nem linha', () => {
    expect(renderToStaticMarkup(createElement(PrimaryReturnBadge, { task: task({ history: [] }) }))).toBe('');
    expect(renderToStaticMarkup(createElement(PrimaryReturnLine, { task: task({ status: 'done' }) }))).toBe('');
  });
});

describe('o quadro de tarefas: onde o selo e a linha são ligados', () => {
  const full = (over: Partial<Task> = {}): Task =>
    ({ id: 't-volta1', title: 'Exportar em CSV', description: 'exportar', staffId: 'ana-1', sessionId: 'sess-novo', plan: null, branch: null, pr: null, createdAt: '2026-11-17T09:00:00.000Z', updatedAt: AT, ...task(), ...over }) as Task;

  /** O quadro de verdade no servidor, com a tarefa já carregada e o detalhe dela aberto: separa o que é do cartão (colunas) do que é do detalhe. */
  const board = (over: Partial<Task> = {}) => {
    const t = full(over);
    const html = renderToStaticMarkup(
      createElement(TasksBoard, { projectId: 'p', projectName: 'Projeto', staff: [], costs: null, onClose: () => {}, onOpenStaff: () => {}, onChanged: () => {}, initialTasks: [t], initialTaskId: t.id }),
    );
    const at = html.indexOf('<aside class="task-detail">');
    expect(at).toBeGreaterThan(0);
    return { card: html.slice(0, at), detail: html.slice(at) };
  };

  it('voltou ao principal: o cartão tem o selo (borda contínua) e o detalhe, a linha por extenso; um não repete o outro', () => {
    const { card, detail } = board();
    expect(card).toContain('<button class="task-card');
    expect(card).toMatch(/<span class="fallback-badge is-back small" title="Voltou ao Claude em [^"]+">voltou ao principal: Claude<\/span>/);
    expect(card).not.toContain('Voltou ao Claude em </p>');
    expect(detail).toMatch(/<p class="muted small">Voltou ao Claude em [^<]+: o limite liberou/);
    expect(detail).not.toContain('is-back');
  });

  it('ainda no secundário: só o selo do secundário (tracejado), sem o da volta nem a linha', () => {
    const fallback = { engine: 'codex', model: 'gpt-5', from: 'claude', at: Date.parse(AT), fromSession: 's', reason: 'limit-mid' } as const;
    const { card, detail } = board({ fallback });
    expect(card).toContain('<span class="fallback-badge small"');
    expect(card).toContain('no secundário: Codex (GPT) · gpt-5');
    expect(card).not.toContain('is-back');
    expect(detail).not.toContain('Voltou ao');
  });

  it('tarefa encerrada: o selo e a linha somem (o histórico segue contando)', () => {
    const { card, detail } = board({ status: 'done' });
    expect(card).not.toContain('voltou ao principal');
    expect(detail).not.toContain('Voltou ao');
    expect(detail).toContain('motor principal liberado: voltou ao Claude');
  });

  it('cancelada e reaberta: o selo e a linha não voltam, e o histórico segue com a nota', () => {
    const history = [
      ...task().history,
      { at: '2026-11-18T10:00:00.000Z', status: 'cancelled' as const, by: 'you' as const, note: 'cancelada' },
      { at: '2026-11-18T11:00:00.000Z', status: 'todo' as const, by: 'you' as const, note: 'reaberta' },
    ];
    const { card, detail } = board({ status: 'todo', history });
    expect(card).not.toContain('voltou ao principal');
    expect(detail).not.toContain('Voltou ao');
    expect(detail).toContain('motor principal liberado: voltou ao Claude');
  });
});

describe('primaryNoteText: a nota no idioma da tela', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  const inLocale = async (locale: string) => {
    vi.resetModules();
    vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
    return import('../client/src/tasks/primaryReturn');
  };

  it('pt: a frase do servidor volta igual (o motor sai pelo nome da tela: Codex (GPT))', () => {
    expect(primaryNoteText(BACK)).toBe(BACK);
    expect(primaryNoteText(FAILED)).toBe(FAILED);
    expect(primaryNoteText(QUEUE)).toBe(QUEUE);
    expect(primaryNoteText(QUEUE_ACK)).toBe(QUEUE_ACK);
    expect(primaryNoteText(BACK_CODEX)).toBe(BACK_CODEX.replace('Codex', 'Codex (GPT)'));
  });

  it('en e es: a volta, a falha com o motivo e a fila', async () => {
    const en = await inLocale('en');
    expect(en.primaryNoteText(BACK)).toBe('main engine available again: back on Claude in a new chat, with a summary of the previous one');
    expect(en.primaryNoteText(FAILED)).toBe('main engine available again, but the new chat on Claude did not open (motor indisponível); stays in the secondary chat');
    expect(en.primaryNoteText(QUEUE)).toBe('resumed from the queue, in a new chat on the main engine, with Ana');
    const es = await inLocale('es');
    expect(es.primaryNoteText(BACK)).toBe('motor principal liberado: volvió a Claude en una conversación nueva, con el resumen de la anterior');
    expect(es.primaryNoteText(QUEUE)).toBe('retomada en la cola, en una conversación nueva en el motor principal, con Ana');
  });

  it('en e es: o sufixo da ciência do corte sai no idioma da tela, não em pt no meio da frase', async () => {
    const en = await inLocale('en');
    expect(en.primaryNoteText(QUEUE_ACK)).toBe('resumed from the queue, in a new chat on the main engine, with Ana; you had confirmed the resumption, skipping the check for a cut-off action');
    const es = await inLocale('es');
    expect(es.primaryNoteText(QUEUE_ACK)).toBe('retomada en la cola, en una conversación nueva en el motor principal, con Ana; habías confirmado la retomada, sin la comprobación de una acción cortada');
    for (const out of [en.primaryNoteText(QUEUE_ACK), es.primaryNoteText(QUEUE_ACK)]) expect(out).not.toContain('você');
  });

  it('nota que não é da volta: null (a linha do histórico segue como veio)', () => {
    expect(primaryNoteText('conversa parou sem terminar: retomada')).toBeNull();
  });
});
