import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitAlertOf, type CommitAlert } from '../client/src/inbox/commitAlert';
import { CommitLeftoverBody, LeftoversPanel, LeftoversView } from '../client/src/inbox/CommitLeftover';
import { InboxMenu } from '../client/src/inbox/InboxMenu';
import { pendingOf } from '../client/src/inbox/resolved';
import type { InboxView } from '../client/src/inbox/useInbox';
import { onDialogRequest, type DialogRequest } from '../client/src/lib/dialogStore';
import { CommitBadge } from '../client/src/tasks/TaskCommit';
import { commitInboxItem, stuckInboxItem } from '../server/inboxItems';
import { commitInboxAlerts, commitWaitingCount, deriveCommitLeft } from '../server/commitLeft';
import { commitAlerts, ownAlerts } from '../server/tasks';
import type { CommitLeftoversDone, CommitLeftovers, InboxItem, Task, TaskCommit } from '../shared/model';
import { flush, all, buttons, mountHooks, tag, textOf } from './support/mountHooks';

// Aviso de commit parcial, de ponta a ponta no cliente: (1) o cenário misto da caixa e do quadro com os itens que saem das regras REAIS do servidor (`commitAlerts`, `commitInboxAlerts`,
// `ownAlerts`, `stuckInboxItem`, `deriveCommitLeft`), e (2) os cliques: Ignorar, Abrir card, Revisar sobras, a confirmação, a leitura do preview, o POST com o `digest` e a recusa com o motivo.
// O servidor falso fica na borda (fetch); os hooks rodam num despachante mínimo (tests/support/mountHooks.ts).

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const card = (id: string, patch: Partial<Task> = {}): Task => ({ id, title: `Card ${id}`, description: '', status: 'doing', history: [], createdAt: at(-300), updatedAt: at(-300), ...patch }) as Task;
const commitOf = (patch: Partial<TaskCommit> = {}): TaskCommit => ({ for: at(-60), at: at(-59), status: 'partial', sha: 'abc1234', files: ['a.ts'], left: [], note: null, alert: true, ...patch });
const place = { projectId: 'p-1', projectName: 'MyCo', sessionId: '', name: 'Beto' };
const noop = () => {};
const inboxOf = (items: InboxItem[], total?: number): InboxView => ({
  items,
  commitWaiting: total ? { total, projects: [{ projectId: 'p-1', projectName: 'MyCo', count: total }] } : null,
  notify: false,
  canNotify: false,
  setNotify: async () => {},
  dismiss: async () => {},
  refresh: async () => {},
});

describe('cenário misto: o que entra na caixa, o que só conta e o que só aparece no cartão', () => {
  // Um card aberto (t-bbbbbb) mexe em b.ts e d.ts. Quatro tarefas prontas com aviso de commit e uma revisão parada (aviso `stuck`, do `ownAlerts`).
  const blocker = card('t-bbbbbb', { status: 'doing', changedFiles: ['b.ts', 'd.ts'] });
  const waiting = card('t-wait01', { status: 'done', commit: commitOf({ left: [{ path: 'b.ts', why: 'shared', by: 't-bbbbbb' }] }) });
  const acked = card('t-ackd01', { status: 'done', commit: commitOf({ ack: true, left: [{ path: 'd.ts', why: 'shared', by: 't-bbbbbb' }] }) });
  const ready = card('t-redy01', { status: 'done', commit: commitOf({ left: [{ path: 'c.ts', why: 'owner' }] }) });
  const failed = card('t-fail01', { status: 'done', commit: commitOf({ status: 'failed', sha: null, left: [], note: 'hook recusou o commit' }) });
  const stuck = card('t-stuk01', {
    title: 'Tela parada',
    status: 'review',
    staffId: 'ana-1',
    reviewerId: 'rui-1',
    requestedBy: 'gio-1',
    sessionId: 'ana-1-1',
    delivery: { at: at(-40), summary: 'feito' },
    history: [{ at: at(-40), status: 'review', by: 'auto', note: 'turno terminou' }],
    updatedAt: at(-40),
  } as Partial<Task>);
  const status = new Map(['b.ts', 'c.ts', 'd.ts'].map((p) => [p, { path: p, x: ' ', y: 'M' }]));
  const base = [blocker, waiting, acked, ready, failed, stuck];
  const board = base.map((t) => {
    const view = deriveCommitLeft(t, base, status);
    return view ? { ...t, commitLeft: view } : t;
  });
  const items = [...commitInboxAlerts(commitAlerts(board)).map((a) => commitInboxItem(a, place)), ...ownAlerts(board, NOW).map((a) => stuckInboxItem(a, { ...place, staffId: null }))];

  it('o servidor deriva os estados: waiting (e dispensado), ready e failed', () => {
    const state = (t: Task) => board.find((b) => b.id === t.id)!.commitLeft?.state;
    expect([state(waiting), state(acked), state(ready), state(failed)]).toEqual(['waiting', 'waiting', 'ready', 'failed']);
  });

  it('a lista da caixa leva ready, failed e a revisão parada; o waiting (com ou sem ack) não vira item', () => {
    expect(items.map((i) => i.id).sort()).toEqual(['commit:p-1:t-fail01', 'commit:p-1:t-redy01', 'stuck:t-stuk01:review']);
  });

  it('a contagem do topo conta só o waiting ainda não dispensado: 1 (o dispensado e o ready ficam de fora)', () => {
    expect(commitWaitingCount(board)).toBe(1);
  });

  it('a caixa renderizada: 3 itens no botão, a linha de ciência com 1 tarefa e nenhum item do waiting', () => {
    expect(pendingOf(items)).toHaveLength(3);
    const html = renderToStaticMarkup(createElement(InboxMenu, { inbox: inboxOf(items, commitWaitingCount(board)), titleOf: new Map(), onOpen: noop, initialOpen: true }));
    expect(html).toContain('<span class="inbox-count">3</span>');
    expect(html).toContain('Commit de 1 tarefa aguardando outro card fechar. Nada a fazer.');
    expect(html).toContain('Card t-redy01');
    expect(html).toContain('has-commit tone-action');
    expect(html).toContain('Card t-fail01');
    expect(html).toContain('has-commit tone-error');
    expect(html).toContain('inbox-stuck');
    expect(html).not.toContain('Card t-wait01');
    expect(html).not.toContain('Card t-ackd01');
    expect(html.match(/Revisar sobras/g)).toHaveLength(1);
    expect(html.match(/Abrir card/g)).toHaveLength(1);
  });

  it('o quadro: só o waiting ainda não dispensado ganha o selo "aguardando"; o resto mantém o selo de sempre', () => {
    const badge = (id: string) => renderToStaticMarkup(createElement(CommitBadge, { task: board.find((b) => b.id === id)! }));
    expect(badge('t-wait01')).toContain('aguardando t-bbbbbb, nada a fazer');
    expect(badge('t-ackd01')).toContain('commit parcial');
    expect(badge('t-ackd01')).not.toContain('aguardando');
    expect(badge('t-redy01')).toContain('commit parcial');
    expect(badge('t-redy01')).not.toContain('aguardando');
    expect(badge('t-fail01')).toContain('sem commit');
    expect(badge('t-stuk01')).toBe('');
  });
});

describe('cliques do item da caixa (CommitLeftoverBody)', () => {
  const alertOf = (state: 'ready' | 'failed'): CommitAlert =>
    commitAlertOf({
      kind: 'error',
      autoCommit: { taskId: 't-aaa111', taskTitle: 'Trocar o botão', status: 'partial', sha: 'abc1234', state, files: [{ path: 'src/a.ts', why: 'owner', by: [], redo: true }], blockers: [], canRedo: state === 'ready', ...(state === 'failed' && { note: 'hook' }) },
    })!;
  const body = (state: 'ready' | 'failed') => {
    const props = { projectId: 'p-1', alert: alertOf(state), onIgnore: vi.fn(), onOpenCard: vi.fn(), onChanged: vi.fn(async () => {}), onDone: vi.fn() };
    return { ...mountHooks(CommitLeftoverBody, props), props };
  };
  const click = (tree: unknown, label: string) => buttons(tree).find((b) => b.label === label)!.props.onClick();

  it('ready: "Ignorar" só dispensa (chama onIgnore, nada vai ao servidor)', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { view, props } = body('ready');
    expect(buttons(view()).map((b) => b.label)).toEqual(['Ignorar', 'Revisar sobras']);
    click(view(), 'Ignorar');
    expect(props.onIgnore).toHaveBeenCalledTimes(1);
    expect(props.onOpenCard).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ready: "Revisar sobras" abre o painel (sem commitar nada) e vira secundária; clicar de novo fecha', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { view, props } = body('ready');
    expect(all(view()).some((e) => e.type === LeftoversPanel)).toBe(false);
    expect(buttons(view()).find((b) => b.label === 'Revisar sobras')!.className).toBe('btn-primary');
    click(view(), 'Revisar sobras');
    const open = view();
    const panel = all(open).find((e) => e.type === LeftoversPanel)!;
    expect(panel.props).toMatchObject({ projectId: 'p-1', alert: { taskId: 't-aaa111' } });
    const toggle = buttons(open).find((b) => b.label === 'Revisar sobras')!;
    expect(toggle.className).toBe('btn-secondary');
    expect(toggle.props['aria-expanded']).toBe(true);
    expect(props.onDone).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled(); // quem lê o preview é o painel, não o botão
    click(open, 'Revisar sobras');
    expect(all(view()).some((e) => e.type === LeftoversPanel)).toBe(false);
  });

  it('failed: "Abrir card" chama onOpenCard e "Ignorar" chama onIgnore; não há "Revisar sobras"', () => {
    const { view, props } = body('failed');
    expect(buttons(view()).map((b) => b.label)).toEqual(['Ignorar', 'Abrir card']);
    click(view(), 'Abrir card');
    expect(props.onOpenCard).toHaveBeenCalledTimes(1);
    expect(props.onIgnore).not.toHaveBeenCalled();
    click(view(), 'Ignorar');
    expect(props.onIgnore).toHaveBeenCalledTimes(1);
  });
});

describe('Revisar sobras: preview, confirmação, POST com o digest e a recusa (LeftoversPanel)', () => {
  const URL = '/api/projects/p-1/tasks/t-aaa111/commit-leftovers';
  const alert = commitAlertOf({ kind: 'error', autoCommit: { taskId: 't-aaa111', taskTitle: 'Trocar o botão', status: 'partial', sha: 'abc1234', state: 'ready', files: [], blockers: [], canRedo: true } })!;
  const preview = (digest: string): CommitLeftovers => ({
    taskId: 't-aaa111',
    state: 'ready',
    sha: 'abc1234',
    canRedo: true,
    head: 'a1b2c3d',
    digest,
    blockers: [],
    dropped: [],
    files: [
      { path: 'src/a.ts', why: 'owner', by: [], redo: true, status: 'M', diff: '-velho\n+novo' },
      { path: 'src/b.ts', why: 'owner', by: [], redo: true, status: 'A', diff: '+tudo novo' },
      { path: '.env', why: 'blocked', by: [], redo: false, status: 'M', diff: '' },
    ],
  });
  const D1 = '1'.repeat(32);
  const D2 = '2'.repeat(32);
  const done: CommitLeftoversDone = { ok: true, sha: 'f00ba12345', files: ['src/a.ts', 'src/b.ts'], left: [], commit: {} as TaskCommit };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  /** O servidor falso: os GETs do preview saem da fila `previews`, o POST responde `post`. Devolve o fetch (para conferir as chamadas) e os pedidos de confirmação que o modal recebeu. */
  function setup(opts: { previews: Array<Response>; post?: () => Response; confirm: boolean }) {
    const previews = [...opts.previews];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? opts.post!() : previews.shift()!));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const asked: DialogRequest[] = [];
    const off = onDialogRequest((req) => {
      asked.push(req);
      req.resolve(opts.confirm);
    });
    const props = { id: 'x', projectId: 'p-1', alert, onClose: vi.fn(), onChanged: vi.fn(async () => {}), onDone: vi.fn() };
    return { fetch, asked, off, props, ...mountHooks(LeftoversPanel, props) };
  }
  const viewEl = (tree: unknown) => all(tree).find((e) => e.type === LeftoversView)!;
  const posts = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');

  it('ao abrir: mostra "lendo", faz o GET do preview e entrega o preview (com o digest) à view', async () => {
    const s = setup({ previews: [json(preview(D1))], confirm: true });
    expect(textOf(s.view())).toContain('Lendo os arquivos e o diff…');
    await s.runEffects();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.fetch.mock.calls[0]![0]).toBe(URL);
    expect((s.fetch.mock.calls[0]![1] as RequestInit | undefined)?.method).toBeUndefined();
    expect(viewEl(s.view()).props.preview.digest).toBe(D1);
    s.off();
  });

  it('falha ao ler o preview: o motivo do servidor aparece como alerta e não há botão de commit', async () => {
    const s = setup({ previews: [json({ error: 'não deu para ler o git' }, 500)], confirm: true });
    await s.runEffects();
    const tree = s.view();
    expect(viewEl(tree)).toBeUndefined();
    expect(tag(tree, 'p').find((p) => p.props.role === 'alert')).toBeDefined();
    expect(textOf(tree)).toContain('Não deu para ler as sobras: não deu para ler o git');
    s.off();
  });

  it('confirmação recusada: o modal diz quantos arquivos e de qual tarefa, e NADA é commitado', async () => {
    const s = setup({ previews: [json(preview(D1))], confirm: false });
    await s.runEffects();
    viewEl(s.view()).props.onRedo();
    await flush();
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ kind: 'confirm', okLabel: 'Commitar sobras' });
    expect(s.asked[0]!.text).toContain('Commitar 2 arquivo(s) das sobras de “Trocar o botão”');
    expect(posts(s.fetch)).toHaveLength(0);
    expect(s.props.onDone).not.toHaveBeenCalled();
    expect(s.props.onClose).not.toHaveBeenCalled();
    s.off();
  });

  it('confirmado: POST na rota certa só com {digest} do preview; depois avisa o resultado, fecha o painel e relê a caixa', async () => {
    const s = setup({ previews: [json(preview(D1))], post: () => json(done), confirm: true });
    await s.runEffects();
    viewEl(s.view()).props.onRedo();
    await flush();
    const sent = posts(s.fetch);
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(URL);
    const init = sent[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ digest: D1 });
    expect((init.headers as Record<string, string>)['x-myco']).toBe('1');
    expect(s.props.onDone).toHaveBeenCalledWith('Commit f00ba12 feito com 2 arquivo(s).');
    expect(s.props.onClose).toHaveBeenCalledTimes(1);
    expect(s.props.onChanged).toHaveBeenCalledTimes(1);
    s.off();
  });

  it('commit que deixa sobras: o resultado diz quantas ficaram de fora', async () => {
    const left = { ...done, left: [{ path: '.env', why: 'blocked' as const }] };
    const s = setup({ previews: [json(preview(D1))], post: () => json(left), confirm: true });
    await s.runEffects();
    viewEl(s.view()).props.onRedo();
    await flush();
    expect(s.props.onDone).toHaveBeenCalledWith('Commit f00ba12 feito com 2 arquivo(s). Ficaram 1 de fora.');
    s.off();
  });

  it('recusa do servidor (409): mostra o motivo, NÃO fecha nem avisa sucesso, relê o preview e o próximo clique usa o digest novo', async () => {
    const reason = 'os arquivos mudaram desde que você viu o diff: confira de novo e confirme';
    const s = setup({ previews: [json(preview(D1)), json(preview(D2))], post: () => json({ error: reason }, 409), confirm: true });
    await s.runEffects();
    viewEl(s.view()).props.onRedo();
    await flush();
    const tree = s.view();
    expect(viewEl(tree).props.error).toBe(reason);
    expect(viewEl(tree).props.busy).toBe(false);
    expect(viewEl(tree).props.preview.digest).toBe(D2); // preview relido
    expect(s.fetch.mock.calls.filter((c) => !(c[1] as RequestInit | undefined)?.method)).toHaveLength(2);
    expect(s.props.onDone).not.toHaveBeenCalled();
    expect(s.props.onClose).not.toHaveBeenCalled();
    expect(s.props.onChanged).not.toHaveBeenCalled();
    // O painel real mostra o motivo como alerta.
    const html = renderToStaticMarkup(createElement(LeftoversView, viewEl(tree).props as never));
    expect(html).toContain('role="alert"');
    expect(html).toContain(reason);
    // Segundo clique: o POST leva o digest novo.
    viewEl(tree).props.onRedo();
    await flush();
    expect(JSON.parse(String((posts(s.fetch)[1]![1] as RequestInit).body))).toEqual({ digest: D2 });
    s.off();
  });
});

