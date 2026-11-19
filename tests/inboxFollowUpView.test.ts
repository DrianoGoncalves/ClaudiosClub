import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxMenu } from '../client/src/inbox/InboxMenu';
import type { InboxView } from '../client/src/inbox/useInbox';
import { interruptsTurn } from '../client/src/tasks/cancelDeps';
import { mergeRead } from '../client/src/tasks/useProjectTasks';
import type { InboxItem, Task } from '../shared/model';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// A caixa "precisa de mim" de verdade (menu aberto, sem efeitos): o follow-up com a tarefa de origem Finalizada ou não, e o card sem código. O que cada saída promete depende da tarefa
// lida, então a leitura que falha (ou ainda não chegou) deixa as saídas desligadas.

const AT = '2026-11-18T10:00:00Z';
const noop = () => {};
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

const inbox = (items: InboxItem[]): InboxView => ({ items, notify: false, canNotify: false, setNotify: async () => {}, dismiss: async () => {}, refresh: async () => {} });
const task = (over: Partial<Task> = {}): Task =>
  ({ id: 't-aaaaaa', title: 'Tela do selo', status: 'done', staffId: 'beto', sessionId: 'sess-w', requestedBy: null, createdAt: AT, updatedAt: AT, history: [], blockedBy: [], ...over }) as Task;
const followUpItem = (over: Partial<NonNullable<InboxItem['followUp']>> = {}): InboxItem => ({
  id: 'followup:t-aaaaaa:f-a1b2c3',
  kind: 'followUp',
  projectId: 'p-1',
  projectName: 'MyCo',
  sessionId: 'sess-w',
  staffId: null,
  name: 'Beto',
  summary: 'x',
  at: AT,
  followUp: { taskId: 't-aaaaaa', taskTitle: 'Tela do selo', followUpId: 'f-a1b2c3', by: 'rev', byName: 'Rita', text: 'achado inteiro', at: AT, recommendation: 'worth', title: 'Juntar o helper', impact: 'Esquece uma tela.', size: 'small', ...over },
});
const noCodeItem = (): InboxItem => ({
  id: 'stuck:t-aaaaaa:decide',
  kind: 'stuck',
  projectId: 'p-1',
  projectName: 'MyCo',
  sessionId: '',
  staffId: 'beto',
  name: 'Beto',
  summary: '“Mapear as telas” está parada',
  at: AT,
  stuck: { taskId: 't-aaaaaa', taskTitle: 'Mapear as telas', reason: 'r', selfHeals: false, humanAction: 'decide', since: AT, noCode: true, summary: 'Li o código.' },
});
const menu = (items: InboxItem[], tasks?: Task[]) =>
  html(createElement(InboxMenu, { inbox: inbox(items), titleOf: new Map(), onOpen: noop, initialOpen: true, initialTasks: tasks ? new Map([['p-1', tasks]]) : undefined }));

describe('follow-up na caixa', () => {
  it('tarefa de origem Finalizada: as saídas são Revisar e Concluir, e o selo "Finalizado" vai ao lado da recomendação', () => {
    const out = menu([followUpItem()], [task({ status: 'done' })]);
    expect(out).toContain('Revisar</button>');
    expect(out).toContain('Concluir</button>');
    expect(out).not.toContain('Criar card</button>');
    expect(out).not.toContain('Descartar</button>');
    expect(out).toContain('task-badge small fu-done');
  });

  it('tarefa de origem aberta: as saídas são Criar card e Descartar, sem o selo "Finalizado"', () => {
    const out = menu([followUpItem()], [task({ status: 'doing' })]);
    expect(out).toContain('Criar card</button>');
    expect(out).toContain('Descartar</button>');
    expect(out).not.toContain('Concluir</button>');
    expect(out).not.toContain('fu-done');
  });

  it('as saídas só ligam com a tarefa lida: sem a leitura (ainda não chegou ou falhou) ficam desligadas e a caixa diz por quê', () => {
    const out = menu([followUpItem()]);
    expect(out).toContain('Lendo a tarefa de origem');
    const buttons = out.match(/<button[^>]*>(Criar card|Descartar)<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b).toContain('disabled=""');
    // Com a leitura, o aviso some e o botão liga.
    const read = menu([followUpItem()], [task({ status: 'doing' })]);
    expect(read).not.toContain('Lendo a tarefa de origem');
    expect(read.match(/<button[^>]*>(Criar card|Descartar)<\/button>/g)?.some((b) => b.includes('disabled'))).toBe(false);
  });

  it('o "Abrir card" fica ligado mesmo sem a leitura (só abre o quadro)', () => {
    const out = menu([followUpItem()]);
    expect(out).toMatch(/<button(?![^>]*disabled)[^>]*>Abrir card<\/button>/);
  });
});

describe('a leitura das tarefas que falha', () => {
  const t1 = task({ id: 't-1' });

  it('projeto que leu entra; o que falhou (null) continua desconhecido', () => {
    const next = mergeRead(new Map(), [['p-1', [t1]], ['p-2', null]]);
    expect(next.has('p-1')).toBe(true);
    expect(next.has('p-2')).toBe(false);
  });

  it('falha depois de uma leitura boa mantém o que já se sabia', () => {
    const prev = new Map([['p-1', [t1]]]);
    const next = mergeRead(prev, [['p-1', null]]);
    expect(next.get('p-1')).toEqual([t1]);
    expect(prev.size).toBe(1);
  });
});

describe('card sem código na caixa', () => {
  it('mostra o que ele disse e as duas saídas: Cancelar e Devolver ao responsável', () => {
    const out = menu([noCodeItem()]);
    expect(out).toContain('Li o código.');
    expect(out).toContain('Cancelar</button>');
    expect(out).toContain('Devolver ao responsável</button>');
    expect(out).not.toContain('Concluir');
    expect(out).not.toContain('Criar card');
  });
});

describe('cancelar: o que o diálogo diz do turno', () => {
  const t = (over: Partial<Task>) => ({ status: 'doing' as const, sessionId: 'sess-w', ...over });

  it('tarefa em andamento com conversa interrompe o turno; planejando também', () => {
    expect(interruptsTurn(t({}))).toBe(true);
    expect(interruptsTurn(t({ status: 'planning' }))).toBe(true);
  });

  it('card sem código segue em "fazendo", mas o turno já terminou: nada a interromper', () => {
    expect(interruptsTurn(t({ noCode: { since: AT, to: 'owner' } }))).toBe(false);
  });

  it('sem conversa, ou fora de planejando/fazendo, também não interrompe', () => {
    expect(interruptsTurn(t({ sessionId: null }))).toBe(false);
    expect(interruptsTurn(t({ status: 'review' }))).toBe(false);
    expect(interruptsTurn(t({ status: 'todo' }))).toBe(false);
  });
});
