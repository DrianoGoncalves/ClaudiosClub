import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { inboxTone } from '../client/src/inbox/alertTone';
import { commitAlertOf, commitText } from '../client/src/inbox/commitAlert';
import { LeftoversView } from '../client/src/inbox/CommitLeftover';
import { InboxMenu } from '../client/src/inbox/InboxMenu';
import { pendingOf } from '../client/src/inbox/resolved';
import type { InboxView } from '../client/src/inbox/useInbox';
import { CommitBadge } from '../client/src/tasks/TaskCommit';
import type { CommitLeftFile, CommitLeftovers, CommitWaitingSummary, InboxItem, Task } from '../shared/model';

// Aviso de commit parcial na caixa e no quadro: waiting só no selo do cartão e na contagem do topo da caixa; ready âmbar com "Revisar sobras"; failed vermelho com "Abrir card" e "Ignorar".

const AT = '2026-11-21T10:00:00Z';
const noop = () => {};
const file = (path: string, over: Partial<CommitLeftFile> = {}): CommitLeftFile => ({ path, why: 'owner', by: [], redo: true, ...over });
const commitItem = (id: string, autoCommit: NonNullable<InboxItem['autoCommit']>, over: Partial<InboxItem> = {}): InboxItem => ({
  id,
  kind: 'error',
  projectId: 'p-1',
  projectName: 'MyCo',
  sessionId: '',
  staffId: null,
  name: 'Beto',
  summary: 'texto do servidor',
  at: AT,
  autoCommit,
  ...over,
});
const ready = commitItem('commit:p-1:t-aaa111', {
  taskId: 't-aaa111',
  taskTitle: 'Trocar o botão',
  status: 'partial',
  sha: 'abc1234',
  state: 'ready',
  files: [file('src/a.ts', { why: 'shared' }), file('src/b.ts', { why: 'owner', cancelledBy: ['t-ccc333'] })],
  blockers: [],
  canRedo: true,
});
const failed = commitItem('commit:p-1:t-bbb222', { taskId: 't-bbb222', taskTitle: 'Ajustar a API', status: 'failed', sha: null, state: 'failed', files: [], blockers: [], canRedo: false, note: 'hook recusou o commit' });
const resolved = commitItem('commit:p-1:t-ddd444', { taskId: 't-ddd444', taskTitle: 'Antiga', status: 'partial', sha: 'fff0000' }, { resolvedAt: AT });

const inbox = (items: InboxItem[], commitWaiting?: CommitWaitingSummary | null): InboxView => ({ items, commitWaiting, notify: false, canNotify: false, setNotify: async () => {}, dismiss: async () => {}, refresh: async () => {} });
const menu = (items: InboxItem[], commitWaiting?: CommitWaitingSummary | null) => renderToStaticMarkup(createElement(InboxMenu, { inbox: inbox(items, commitWaiting), titleOf: new Map(), onOpen: noop, initialOpen: true }));
/** O item do aviso de commit na lista: do `<li ... has-commit>` até o fim do corpo (`</div></li>`), já que os arquivos de fora também são `<li>`. */
const li = (html: string) => /<li [^>]*has-commit[\s\S]*?<\/div><\/li>/.exec(html)?.[0] ?? '';

describe('caixa: commit parcial pronto (ready)', () => {
  const html = li(menu([ready]));

  it('é âmbar (tom action), com selo "pede ação" e a frase do que fazer', () => {
    expect(html).toContain('tone-action');
    expect(html).not.toContain('tone-error');
    expect(html).toContain('pede ação');
    expect(html).toContain('Trocar o botão');
    expect(html).toContain('abc1234');
    expect(html).toContain('Revise as sobras para commitar, ou ignore');
    expect(inboxTone(ready)).toBe('action');
  });

  it('lista os arquivos de fora com o motivo de agora (o card que travava já fechou)', () => {
    expect(html).toContain('<code>src/a.ts</code>');
    expect(html).toContain('o card que mexia nele já fechou');
    expect(html).not.toContain('que ainda não terminou');
    expect(html).toContain('<code>src/b.ts</code>');
    expect(html).toContain('você editou depois, no editor do Club');
    expect(html).toContain('card cancelado t-ccc333');
  });

  it('botões do design system: Ignorar secundária à esquerda, Revisar sobras primária à direita; sem o X', () => {
    const ignore = html.indexOf('btn-secondary');
    const review = html.indexOf('btn-primary');
    expect(ignore).toBeGreaterThan(-1);
    expect(review).toBeGreaterThan(ignore);
    expect(html).toMatch(/class="btn-secondary"[^>]*>Ignorar</);
    expect(html).toMatch(/class="btn-primary"[^>]*aria-expanded="false"[^>]*>Revisar sobras</);
    expect(html).not.toContain('inbox-x');
    expect(html).not.toContain('Abrir card');
  });

  it('mais de 5 arquivos: lista 5 e diz quantos faltam', () => {
    const many = commitItem('commit:p-1:t-eee555', { ...ready.autoCommit!, files: Array.from({ length: 8 }, (_, i) => file(`src/f${i}.ts`)) });
    const out = li(menu([many]));
    expect(out).toContain('src/f4.ts');
    expect(out).not.toContain('src/f5.ts');
    expect(out).toContain('…e mais 3');
  });
});

describe('caixa: commit com erro (failed)', () => {
  const html = li(menu([failed]));

  it('é vermelho, com selo "falhou" e o motivo do git', () => {
    expect(html).toContain('tone-error');
    expect(html).not.toContain('tone-action');
    expect(html).toContain('falhou');
    expect(html).toContain('hook recusou o commit');
    expect(inboxTone(failed)).toBe('error');
  });

  it('traz Abrir card (primária) e Ignorar (secundária), sem Revisar sobras nem X', () => {
    expect(html).toMatch(/class="btn-secondary"[^>]*>Ignorar</);
    expect(html).toMatch(/class="btn-primary"[^>]*>Abrir card</);
    expect(html).not.toContain('Revisar sobras');
    expect(html).not.toContain('inbox-x');
  });

  it('sem a nota do git, a frase manda abrir o card', () => {
    const bare = commitItem('commit:p-1:t-fff666', { ...failed.autoCommit!, note: undefined });
    expect(commitText(bare)).toContain('Abra o card para ver o motivo');
  });
});

describe('caixa: waiting e aviso já passado', () => {
  it('waiting não é item: só a contagem no topo, fora do número do botão', () => {
    const html = menu([], { total: 3, projects: [{ projectId: 'p-1', projectName: 'MyCo', count: 3 }] });
    expect(html).toContain('inbox-commit-waiting');
    expect(html).toContain('Commit de 3 tarefas aguardando outro card fechar. Nada a fazer.');
    expect(html).toContain('tone-info');
    expect(html).not.toContain('inbox-count');
    expect(html).not.toContain('has-commit');
    expect(menu([], { total: 1, projects: [] })).toContain('Commit de 1 tarefa aguardando');
  });

  it('sem contagem (zero, nula ou servidor sem a rota) a linha não aparece', () => {
    expect(menu([ready], { total: 0, projects: [] })).not.toContain('inbox-commit-waiting');
    expect(menu([ready], null)).not.toContain('inbox-commit-waiting');
    expect(menu([ready])).not.toContain('inbox-commit-waiting');
  });

  it('item de waiting que escapasse do servidor não vira aviso de commit', () => {
    const w = commitItem('commit:p-1:t-ggg777', { ...ready.autoCommit!, state: 'waiting' });
    expect(commitAlertOf(w)).toBeNull();
    expect(menu([w])).not.toContain('has-commit');
  });

  it('aviso sem estado (já passou) segue como erro comum: frase do servidor, X e sem botões de commit', () => {
    const html = menu([resolved]);
    expect(html).toContain('texto do servidor');
    expect(html).toContain('inbox-x');
    expect(html).toContain('Resolvido');
    expect(html).not.toContain('Revisar sobras');
    expect(html).not.toContain('has-commit');
  });

  it('a contagem do botão inclui ready e failed (pendentes)', () => {
    expect(pendingOf([ready, failed])).toHaveLength(2);
    expect(menu([ready, failed])).toContain('<span class="inbox-count">2</span>');
  });
});

describe('painel Revisar sobras (LeftoversView)', () => {
  const alert = commitAlertOf(ready)!;
  const preview = (over: Partial<CommitLeftovers> = {}): CommitLeftovers => ({
    taskId: 't-aaa111',
    state: 'ready',
    sha: 'abc1234',
    canRedo: true,
    head: 'a1b2c3d',
    digest: 'd'.repeat(32),
    blockers: [],
    dropped: [],
    files: [
      { ...file('src/a.ts'), status: 'M', diff: 'diff --git a/src/a.ts b/src/a.ts\n-<b>velho</b>\n+novo' },
      { ...file('src/novo.ts'), status: 'A', diff: '+tudo novo', diffTruncated: true },
      { ...file('img.png'), status: 'M', diff: '', binary: true },
      { ...file('.env', { why: 'blocked', redo: false }), status: 'M', diff: '' },
    ],
    ...over,
  });
  const render = (p: CommitLeftovers, extra: { busy?: boolean; error?: string | null } = {}) =>
    renderToStaticMarkup(createElement(LeftoversView, { id: 'x', preview: p, alert, busy: !!extra.busy, error: extra.error ?? null, onRedo: noop, onClose: noop }));

  it('mostra o HEAD, a letra do git, o diff como texto puro e o aviso de corte e de binário', () => {
    const html = render(preview());
    expect(html).toContain('O que seria commitado (HEAD a1b2c3d)');
    expect(html).toContain('inbox-commit-letter');
    expect(html).toContain('ver diff');
    expect(html).toContain('-&lt;b&gt;velho&lt;/b&gt;');
    expect(html).not.toContain('<b>velho</b>');
    expect(html).toContain('diff cortado; o arquivo vai inteiro no commit');
    expect(html).toContain('arquivo binário: sem diff');
  });

  it('arquivo que o botão não leva fica de fora, com o motivo, e sem diff', () => {
    const html = render(preview());
    expect(html).toContain('fica de fora: resolva no git');
    expect(html).toContain('barrado (segredo, dependência ou caminho inválido)');
    expect(html.match(/ver diff/g)).toHaveLength(2);
  });

  it('Fechar secundária e Commitar sobras primária, habilitada com canRedo', () => {
    const html = render(preview());
    expect(html).toMatch(/class="btn-secondary"[^>]*>Fechar</);
    expect(html).toMatch(/<button class="btn-primary"[^>]*>Commitar sobras</);
    expect(html).not.toMatch(/class="btn-primary" disabled/);
  });

  it('sem canRedo o botão fica desabilitado e o painel diz o motivo (card aberto, ou nada vai pelo botão)', () => {
    const blocked = render(preview({ canRedo: false, state: 'waiting', digest: '', blockers: [{ id: 't-zzz999', title: 'x', status: 'doing', paths: ['src/a.ts'] }] }));
    expect(blocked).toMatch(/class="btn-primary" disabled/);
    expect(blocked).toContain('Ainda há card aberto mexendo nos arquivos: t-zzz999');
    const none = render(preview({ canRedo: false, digest: '', files: [{ ...file('.env', { why: 'blocked', redo: false }), status: 'M', diff: '' }] }));
    expect(none).toContain('Nada destas sobras pode ir pelo botão agora.');
    expect(none).toMatch(/class="btn-primary" disabled/);
  });

  it('a recusa do servidor aparece com o motivo, como alerta; durante o envio o botão avisa e não clica', () => {
    const refused = render(preview(), { error: 'os arquivos mudaram desde que você viu o diff: confira de novo e confirme' });
    expect(refused).toContain('role="alert"');
    expect(refused).toContain('os arquivos mudaram desde que você viu o diff');
    const sending = render(preview(), { busy: true });
    expect(sending).toContain('commitando…');
    expect(sending).toMatch(/class="btn-primary" disabled/);
  });

  it('arquivos que já não têm mudança no git são contados', () => {
    expect(render(preview({ dropped: ['a', 'b'] }))).toContain('2 arquivo(s) já sem mudança no git');
  });
});

describe('selo waiting no cartão do quadro', () => {
  const left = (over: Partial<NonNullable<Task['commitLeft']>> = {}): NonNullable<Task['commitLeft']> => ({
    state: 'waiting',
    sha: 'abc1234',
    files: [file('src/a.ts', { by: ['t-bbb222'] })],
    blockers: [{ id: 't-bbb222', title: 'Outra', status: 'doing', paths: ['src/a.ts'] }],
    canRedo: false,
    ...over,
  });
  const task = (over: Partial<Task> = {}): Pick<Task, 'status' | 'commit' | 'commitLeft'> => ({
    status: 'done',
    commit: { status: 'partial', sha: 'abc1234', for: AT, at: AT, files: ['x'], left: [{ path: 'src/a.ts', why: 'shared', by: 't-bbb222' }], note: null, alert: true },
    commitLeft: left(),
    ...over,
  });
  const badge = (t: Pick<Task, 'status' | 'commit' | 'commitLeft'>) => renderToStaticMarkup(createElement(CommitBadge, { task: t }));

  it('mostra "aguardando t-xxx, nada a fazer" em tom informativo, sem o amarelo do "precisa de você"', () => {
    const html = badge(task());
    expect(html).toContain('aguardando t-bbb222, nada a fazer');
    expect(html).toContain('tone-info');
    expect(html).not.toContain('tone-action');
    expect(html).not.toContain('commit parcial');
    expect(html).toContain('Nada a fazer agora.');
  });

  it('vários cards: os 3 primeiros e a conta do resto', () => {
    const blockers = ['t-1', 't-2', 't-3', 't-4', 't-5'].map((id) => ({ id, title: id, status: 'doing' as const, paths: ['src/a.ts'] }));
    expect(badge(task({ commitLeft: left({ blockers }) }))).toContain('aguardando t-1, t-2, t-3 +2, nada a fazer');
  });

  it('já dispensado (ack), ready ou sem estado: volta ao selo de sempre', () => {
    const acked = task();
    acked.commit = { ...acked.commit!, ack: true };
    expect(badge(acked)).toContain('commit parcial');
    expect(badge(acked)).not.toContain('aguardando');
    const readyTask = badge(task({ commitLeft: left({ state: 'ready', blockers: [] }) }));
    expect(readyTask).toContain('commit parcial');
    expect(readyTask).toContain('tone-action');
    expect(badge(task({ commitLeft: undefined }))).toContain('commit parcial');
  });
});
