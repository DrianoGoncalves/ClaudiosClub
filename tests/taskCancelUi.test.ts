import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import staff from '../client/src/i18n/staff';
import tasksMsgs from '../client/src/i18n/tasks';
import { blockedText, inboxText, notStartedText } from '../client/src/inbox/inboxText';
import type { Tr } from '../client/src/inbox/secretText';
import {
  applyToAll,
  cancelledByName,
  choiceOf,
  deleteReady,
  dependentRows,
  dependentsMap,
  leavesWorkBehind,
  optionsOf,
  visibleRows,
  type DepPicks,
  type DepTask,
} from '../client/src/tasks/cancelDeps';
import { BlockedBadge, blockerName, depChoices, openBlockers } from '../client/src/tasks/TaskDeps';
import { columnOf } from '../client/src/tasks/TasksBoard';
import type { InboxItem, TaskStatus } from '../shared/model';

const task = (id: string, blockedBy: string[] = [], status: TaskStatus = 'todo'): DepTask => ({ id, title: `Tarefa ${id}`, status, staffId: null, blockedBy });
const ids = (rows: { task: { id: string } }[]) => rows.map((r) => r.task.id);

// raiz r ← a, b (diretas); a ← c; c ← d; b ← e
const tree = [task('r'), task('a', ['r']), task('b', ['r']), task('c', ['a']), task('d', ['c']), task('e', ['b'])];

describe('dependentRows: a árvore de quem espera a tarefa', () => {
  it('diretas e indiretas, em pré-ordem, com o recuo e a linha de cima', () => {
    const rows = dependentRows('r', tree);
    expect(ids(rows)).toEqual(['a', 'c', 'd', 'b', 'e']);
    expect(rows.map((r) => [r.task.id, r.depth, r.parentId, r.children])).toEqual([
      ['a', 1, null, 1],
      ['c', 2, 'a', 1],
      ['d', 3, 'c', 0],
      ['b', 1, null, 1],
      ['e', 2, 'b', 0],
    ]);
  });

  it('sem dependentes: vazio', () => {
    expect(dependentRows('d', tree)).toEqual([]);
    expect(dependentRows('x', tree)).toEqual([]);
  });

  it('encerrada (pronta ou cancelada) não espera mais ninguém: fica fora, e as que dependiam só dela também', () => {
    const all = [task('r'), task('a', ['r'], 'done'), task('b', ['r'], 'cancelled'), task('c', ['a']), task('d', ['r'], 'review')];
    expect(ids(dependentRows('r', all))).toEqual(['d']);
  });

  it('quem espera por duas aparece uma vez só, no ponto mais raso', () => {
    // e espera por r (direta) e por a (que espera por r): fica nas diretas, não repete sob a.
    const all = [task('r'), task('a', ['r']), task('e', ['r', 'a']), task('f', ['a', 'e'])];
    const rows = dependentRows('r', all);
    expect(rows.map((r) => [r.task.id, r.depth])).toEqual([
      ['a', 1],
      ['f', 2],
      ['e', 1],
    ]);
  });

  it('ciclo nos dados (o servidor não deixa gravar) não trava', () => {
    const all = [task('r', ['b']), task('a', ['r']), task('b', ['a'])];
    expect(ids(dependentRows('r', all))).toEqual(['a', 'b']);
  });
});

describe('visibleRows: quem aparece e quem esconde', () => {
  const rows = dependentRows('r', tree);

  it('sem escolha, só as diretas (as de baixo esperam a de cima voltar a andar, nada a decidir)', () => {
    expect(ids(visibleRows(rows, {}, 'cancel'))).toEqual(['a', 'b']);
  });

  it('"Cancelar junto" abre as de baixo daquela linha, e só dela', () => {
    expect(ids(visibleRows(rows, { a: 'cancel' }, 'cancel'))).toEqual(['a', 'c', 'b']);
    // c continua em "esperar": d segue escondida até c ser cancelada junto.
    expect(ids(visibleRows(rows, { a: 'cancel', c: 'cancel' }, 'cancel'))).toEqual(['a', 'c', 'd', 'b']);
  });

  it('liberar ou esperar fecha as de baixo, mesmo com escolha antiga nelas', () => {
    expect(ids(visibleRows(rows, { a: 'release', c: 'cancel' }, 'cancel'))).toEqual(['a', 'b']);
    expect(ids(visibleRows(rows, { a: 'wait', c: 'cancel' }, 'cancel'))).toEqual(['a', 'b']);
  });

  it('no apagar, a direta sem escolha também esconde as de baixo', () => {
    expect(ids(visibleRows(rows, {}, 'delete'))).toEqual(['a', 'b']);
    expect(ids(visibleRows(rows, { a: 'cancel' }, 'delete'))).toEqual(['a', 'c', 'b']);
  });
});

describe('dependentes com caminho compartilhado (C espera B e D, as duas dependentes da tarefa)', () => {
  // r ← b, d (diretas); c ← b, d; e ← c
  const shared = [task('r'), task('b', ['r']), task('d', ['r']), task('c', ['b', 'd']), task('e', ['c'])];
  const rows = dependentRows('r', shared);
  const shape = (list: ReturnType<typeof visibleRows>) => list.map((r) => [r.task.id, r.depth, r.parentId]);

  it('a árvore guarda todas as bloqueadoras de cada uma, e quem é direta', () => {
    expect(rows.map((r) => [r.task.id, r.direct, r.parents])).toEqual([
      ['b', true, []],
      ['c', false, ['b', 'd']],
      ['e', false, ['c']],
      ['d', true, []],
    ]);
  });

  it('o bug: B esperando e D cancelando junto, C aparece (sob D); antes ficava escondida sob B', () => {
    expect(shape(visibleRows(rows, { b: 'wait', d: 'cancel' }, 'cancel'))).toEqual([
      ['b', 1, null],
      ['d', 1, null],
      ['c', 2, 'd'],
    ]);
  });

  it('sem nenhuma bloqueadora dela em "Cancelar junto", C não aparece; basta uma', () => {
    expect(ids(visibleRows(rows, {}, 'cancel'))).toEqual(['b', 'd']);
    expect(ids(visibleRows(rows, { b: 'release', d: 'release' }, 'cancel'))).toEqual(['b', 'd']);
    expect(shape(visibleRows(rows, { b: 'cancel' }, 'cancel'))).toEqual([
      ['b', 1, null],
      ['c', 2, 'b'],
      ['d', 1, null],
    ]);
  });

  it('com as duas em "Cancelar junto", C aparece UMA vez, sob a primeira da lista', () => {
    expect(shape(visibleRows(rows, { b: 'cancel', d: 'cancel' }, 'cancel'))).toEqual([
      ['b', 1, null],
      ['c', 2, 'b'],
      ['d', 1, null],
    ]);
  });

  it('o que está abaixo de C aparece quando C é cancelada junto, pelo caminho que a abriu', () => {
    expect(ids(visibleRows(rows, { b: 'wait', d: 'cancel', c: 'wait' }, 'cancel'))).toEqual(['b', 'd', 'c']);
    expect(shape(visibleRows(rows, { b: 'wait', d: 'cancel', c: 'cancel' }, 'cancel'))).toEqual([
      ['b', 1, null],
      ['d', 1, null],
      ['c', 2, 'd'],
      ['e', 3, 'c'],
    ]);
  });

  it('"N esperam por ela" conta só as que ainda estão escondidas', () => {
    const count = (picks: DepPicks) => Object.fromEntries(visibleRows(rows, picks, 'cancel').map((r) => [r.task.id, r.children]));
    expect(count({})).toMatchObject({ b: 1, d: 1 });
    expect(count({ b: 'wait', d: 'cancel' })).toMatchObject({ b: 0, d: 0 }); // C já está à mostra, sob D
  });

  it('o mapa enviado leva a escolha de C quando ela aparece por D, e não leva quando nenhuma das duas está em "Cancelar junto"', () => {
    expect(dependentsMap(rows, { b: 'wait', d: 'cancel', c: 'cancel' }, 'cancel')).toEqual({ d: 'cancel', c: 'cancel' }); // E aparece, mas continua esperando (o padrão não vai no mapa)
    expect(dependentsMap(rows, { b: 'wait', d: 'cancel', c: 'release' }, 'cancel')).toEqual({ d: 'cancel', c: 'release' });
    expect(dependentsMap(rows, { b: 'wait', d: 'wait', c: 'cancel' }, 'cancel')).toEqual({});
    expect(dependentsMap(rows, { b: 'release', d: 'cancel', c: 'cancel' }, 'cancel')).toEqual({ b: 'release', d: 'cancel', c: 'cancel' });
  });

  it('apagar: só as diretas travam o botão, e a escolha de C também segue a regra', () => {
    expect(deleteReady(rows, { b: 'release' })).toBe(false);
    expect(deleteReady(rows, { b: 'release', d: 'cancel' })).toBe(true);
    expect(dependentsMap(rows, { b: 'release', d: 'cancel', c: 'release' }, 'delete')).toEqual({ b: 'release', d: 'cancel', c: 'release' });
    expect(dependentsMap(rows, { b: 'cancel', d: 'release', c: 'release' }, 'delete')).toEqual({ b: 'cancel', d: 'release', c: 'release' });
    expect(dependentsMap(rows, { b: 'release', d: 'release', c: 'release' }, 'delete')).toEqual({ b: 'release', d: 'release' });
    expect(optionsOf(rows[1]!, 'delete')).toEqual(['wait', 'release', 'cancel']);
  });

  it('"Aplicar a todas" em cancelar junto alcança a árvore toda', () => {
    expect(Object.keys(applyToAll(rows, 'cancel')).sort()).toEqual(['b', 'c', 'd', 'e']);
    expect(dependentsMap(rows, applyToAll(rows, 'cancel'), 'cancel')).toEqual({ b: 'cancel', c: 'cancel', d: 'cancel', e: 'cancel' });
  });

  it('ciclo entre as de baixo (arquivo editado à mão) não trava nem repete linha', () => {
    const loop = [task('r'), task('x', ['r']), task('a', ['x', 'b']), task('b', ['a'])];
    const r = dependentRows('r', loop);
    expect(ids(visibleRows(r, { x: 'cancel', a: 'cancel', b: 'cancel' }, 'cancel'))).toEqual(['x', 'a', 'b']);
    expect(ids(visibleRows(r, { x: 'wait', a: 'cancel', b: 'cancel' }, 'cancel'))).toEqual(['x']);
  });
});

describe('o que o cancelar não desfaz', () => {
  const leaves = (patch: Partial<Parameters<typeof leavesWorkBehind>[0]>) => leavesWorkBehind({ status: 'todo', ...patch });
  it('em andamento (planejando ou fazendo), com mescla ou com deploy: avisa; o resto, não', () => {
    expect(leaves({ status: 'doing' })).toBe(true);
    expect(leaves({ status: 'planning' })).toBe(true);
    expect(leaves({ status: 'review', merged: { at: 'x', sha: 'abc', branch: 'b', base: 'main' } })).toBe(true);
    expect(leaves({ status: 'review', deploy: { staffId: 'i', sessionId: 's', at: 'x' } })).toBe(true);
    expect(leaves({ status: 'todo' })).toBe(false);
    expect(leaves({ status: 'waiting' })).toBe(false);
    expect(leaves({ status: 'review' })).toBe(false);
  });
  it('a frase existe nos três idiomas e diz que nada é desfeito', () => {
    for (const locale of ['pt-BR', 'en', 'es'] as const) {
      const text = (tasksMsgs[locale] as Record<string, string>)['tasks.cancelNotUndone'];
      expect(text, locale).toBeTruthy();
      expect(text, locale).toMatch(locale === 'pt-BR' ? /não é desfeito/ : locale === 'en' ? /not undone/ : /no se deshace/);
    }
  });
});

describe('choiceOf e optionsOf', () => {
  const [a, c] = dependentRows('r', tree);
  it('cancelar: o padrão é continuar esperando, em todas as linhas', () => {
    expect(choiceOf(a!, {}, 'cancel')).toBe('wait');
    expect(choiceOf(c!, {}, 'cancel')).toBe('wait');
    expect(choiceOf(a!, { a: 'release' }, 'cancel')).toBe('release');
    expect(optionsOf(a!, 'cancel')).toEqual(['wait', 'release', 'cancel']);
  });
  it('apagar: a direta não tem padrão nem "continuar esperando"; as de baixo têm as três', () => {
    expect(choiceOf(a!, {}, 'delete')).toBeNull();
    expect(optionsOf(a!, 'delete')).toEqual(['release', 'cancel']);
    expect(choiceOf(c!, {}, 'delete')).toBe('wait');
    expect(optionsOf(c!, 'delete')).toEqual(['wait', 'release', 'cancel']);
  });
});

describe('dependentsMap: o mapa que vai no corpo', () => {
  const rows = dependentRows('r', tree);

  it('sem mexer em nada: vazio (todas continuam esperando e aparecem na caixa)', () => {
    expect(dependentsMap(rows, {}, 'cancel')).toEqual({});
  });

  it('leva só liberar e cancelar junto; "continuar esperando" fica de fora', () => {
    expect(dependentsMap(rows, { a: 'release', b: 'wait' }, 'cancel')).toEqual({ a: 'release' });
  });

  it('as de baixo só entram quando a de cima está em cancelar junto (a escolha de linha escondida não vai)', () => {
    expect(dependentsMap(rows, { a: 'cancel', c: 'release', b: 'release', e: 'cancel' }, 'cancel')).toEqual({ a: 'cancel', c: 'release', b: 'release' });
    expect(dependentsMap(rows, { a: 'release', c: 'cancel' }, 'cancel')).toEqual({ a: 'release' });
  });

  it('a cascata inteira com "cancelar junto" em todas', () => {
    expect(dependentsMap(rows, applyToAll(rows, 'cancel'), 'cancel')).toEqual({ a: 'cancel', b: 'cancel', c: 'cancel', d: 'cancel', e: 'cancel' });
  });
});

describe('apagar: validação e "Aplicar a todas"', () => {
  const rows = dependentRows('r', tree);

  it('só confirma com todas as diretas em liberar ou cancelar junto', () => {
    expect(deleteReady(rows, {})).toBe(false);
    expect(deleteReady(rows, { a: 'release' })).toBe(false);
    // "continuar esperando" não existe para direta: se vier (estado velho), não conta.
    expect(deleteReady(rows, { a: 'release', b: 'wait' })).toBe(false);
    expect(deleteReady(rows, { a: 'release', b: 'cancel' })).toBe(true);
  });

  it('as de baixo não travam o botão (têm padrão)', () => {
    expect(deleteReady(rows, { a: 'cancel', b: 'cancel' })).toBe(true);
  });

  it('sem dependentes não há o que escolher', () => {
    expect(deleteReady([], {})).toBe(true);
  });

  it('o mapa do apagar sai completo para as diretas', () => {
    const picks: DepPicks = { a: 'release', b: 'cancel' };
    expect(dependentsMap(rows, picks, 'delete')).toEqual({ a: 'release', b: 'cancel' });
  });

  it('"Aplicar a todas": cancelar junto vale para a árvore toda; liberar e esperar só mexem nas diretas', () => {
    expect(applyToAll(rows, 'release')).toEqual({ a: 'release', b: 'release' });
    expect(applyToAll(rows, 'wait')).toEqual({ a: 'wait', b: 'wait' });
    expect(Object.keys(applyToAll(rows, 'cancel')).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(deleteReady(rows, applyToAll(rows, 'release'))).toBe(true);
  });
});

describe('cancelledByName', () => {
  const nameOf = (id: string) => (id === 's-1' ? 'Ana' : null);
  it('"user" (e sem valor) é você; funcionário vai pelo nome, ou pelo id se a ficha sumiu', () => {
    expect(cancelledByName('user', nameOf, 'você')).toBe('você');
    expect(cancelledByName(undefined, nameOf, 'você')).toBe('você');
    expect(cancelledByName('s-1', nameOf, 'você')).toBe('Ana');
    expect(cancelledByName('s-9', nameOf, 'você')).toBe('s-9');
  });
});

describe('quadro: a cancelada não é coluna', () => {
  it('columnOf(cancelled) é null (não estoura); os outros status continuam na coluna deles', () => {
    expect(columnOf('cancelled')).toBeNull();
    expect(columnOf('planning')).toBe('doing');
    expect(columnOf('done')).toBe('done');
  });
});

describe('dependências na tela: cancelada continua bloqueando', () => {
  const all = [task('a', [], 'cancelled'), task('b', [], 'done'), task('c', [], 'todo')];

  it('openBlockers segura pela cancelada, não pela pronta', () => {
    expect(openBlockers({ blockedBy: ['a', 'b', 'c'] }, all).map((o) => o.id)).toEqual(['a', 'c']);
  });

  it('o selo "Esperando" marca a cancelada, no texto e no title', () => {
    const html = renderToStaticMarkup(createElement(BlockedBadge, { blockers: [all[0]!, all[2]!] }));
    expect(html).toContain('Esperando: “Tarefa a” (cancelada), “Tarefa c”');
    expect(html).toContain('Tarefa a (cancelada) (a)');
    expect(blockerName(all[2]!)).toBe('“Tarefa c”');
  });

  it('a lista de "Bloqueada por" só oferece cancelada que já é dependência (para poder tirar)', () => {
    expect(depChoices(all, 'x', []).open.map((o) => o.id)).toEqual(['c']);
    expect(depChoices(all, 'x', ['a']).open.map((o) => o.id)).toEqual(['a', 'c']);
    // pronta vai para os vínculos antigos, como sempre.
    expect(depChoices(all, 'x', ['b']).old.map((o) => o.id)).toEqual(['b']);
  });
});

type Locale = 'pt-BR' | 'en' | 'es';
const tr = (locale: Locale): Tr => (key, vars) => {
  const text = ({ ...staff[locale], ...tasksMsgs[locale] } as Record<string, string>)[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
};

const blocked = (reason: string): Pick<InboxItem, 'summary' | 'blocked'> => ({
  summary: `“Tela” espera “API”: ${reason}`,
  blocked: { taskId: 't2', taskTitle: 'Tela', blockerId: 't1', blockerTitle: 'API', blockerStatus: 'cancelled', reason },
});

describe('caixa: bloqueadora cancelada e cartão esquecido', () => {
  it('bloqueadora cancelada: "que foi cancelada (motivo)" no idioma da página, sem dois-pontos duplos', () => {
    expect(blockedText(blocked('cancelada'), tr('pt-BR'))).toBe('“Tela” espera “API”, que foi cancelada');
    expect(blockedText(blocked('cancelada'), tr('en'))).toBe('“Tela” is waiting for “API”, which was cancelled');
    expect(blockedText(blocked('cancelada: mudou o escopo'), tr('pt-BR'))).toBe('“Tela” espera “API”, que foi cancelada (mudou o escopo)');
    expect(blockedText(blocked('cancelada: mudou o escopo'), tr('en'))).toBe('“Tela” is waiting for “API”, which was cancelled (mudou o escopo)');
    expect(blockedText(blocked('cancelada: mudou o escopo\nde novo'), tr('es'))).toBe('“Tela” espera “API”, que fue cancelada (mudou o escopo\nde novo)');
    // Os outros motivos seguem como antes: "espera “B”: motivo".
    expect(blockedText(blocked('em Aguardar'), tr('en'))).toBe('“Tela” is waiting for “API”: on hold');
    for (const locale of ['pt-BR', 'en', 'es'] as const) expect(blockedText(blocked('cancelada: x'), tr(locale))).not.toMatch(/:.*:/);
  });

  it('cartão esquecido: a frase sai de notStarted, no idioma da página', () => {
    const item: Pick<InboxItem, 'summary' | 'notStarted'> = { summary: 'resumo', notStarted: { taskId: 't1', taskTitle: 'Login', days: 3, staffId: null } };
    expect(notStartedText(item, tr('pt-BR'))).toBe('“Login” está em A fazer há 3 dias e não começou');
    expect(notStartedText(item, tr('en'))).toBe('“Login” has been in To do for 3 days and has not started');
    expect(notStartedText(item, tr('es'))).toBe('“Login” lleva 3 días en Por hacer y no ha empezado');
    expect(inboxText(item, tr('en'))).toBe('“Login” has been in To do for 3 days and has not started');
    expect(notStartedText({ summary: 'resumo do servidor' }, tr('en'))).toBe('resumo do servidor');
  });

  it('as chaves novas existem nos três idiomas', () => {
    const inbox = [
      'inbox.blocked.sentenceCancelled',
      'inbox.blocked.sentenceCancelledWhy',
      'inbox.notStarted.sentence',
      'inbox.blockerRelease',
      'inbox.blockerCancel',
      'inbox.blockerWait',
      'inbox.notStartedStart',
      'inbox.notStartedCancel',
    ];
    const board = ['tasks.cancelTask', 'tasks.cancelledNoCode', 'tasks.reopen', 'tasks.showCancelled', 'tasks.cancelledBy', 'tasks.depWait', 'tasks.depRelease', 'tasks.depCancel', 'tasks.depAll', 'tasks.depAlsoOne', 'tasks.depAlsoOther', 'tasks.cancelNotUndone'];
    for (const locale of ['pt-BR', 'en', 'es'] as const) {
      for (const key of inbox) expect((staff[locale] as Record<string, string>)[key], `${locale} ${key}`).toBeTruthy();
      for (const key of board) expect((tasksMsgs[locale] as Record<string, string>)[key], `${locale} ${key}`).toBeTruthy();
    }
  });
});
