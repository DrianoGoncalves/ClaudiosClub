import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BoardConfig, TaskCommit } from '../shared/model';
import { BoardReview, type BoardCommitState, type BoardReviewState } from '../client/src/tasks/BoardReview';
import { CommitBadge, CommitBlock } from '../client/src/tasks/TaskCommit';
import { taskIdOf } from '../client/src/inbox/taskAlerts';
import messages from '../client/src/i18n/tasks';

// Commit automático na tela (t-33bd83): o liga/desliga no bloco da revisão do quadro, o selo no cartão (SHA ou "commit parcial") e o bloco do detalhe.

const off: BoardConfig = { autoReview: false, reviewerId: null };
const review: BoardReviewState = { config: off, missing: false, error: null, saving: false, save: async () => {} };
const commitState = (autoCommit: boolean | null, extra: Partial<BoardCommitState> = {}): BoardCommitState => ({
  config: autoCommit === null ? null : { autoCommit },
  error: null,
  saving: false,
  save: async () => {},
  ...extra,
});
const render = (commit?: BoardCommitState) => renderToStaticMarkup(createElement(BoardReview, { review, commit, staff: [] }));

const done = (commit: Partial<TaskCommit>): TaskCommit => ({ for: '2026-11-18T10:00:00Z', at: '2026-11-18T10:00:05Z', status: 'committed', sha: 'abc1234', files: ['a.ts', 'b.ts'], left: [], note: null, alert: false, ...commit });
const badge = (commit: TaskCommit | undefined, status: 'done' | 'review' = 'done') => renderToStaticMarkup(createElement(CommitBadge, { task: { status, commit } }));

describe('o controle do commit automático', () => {
  it('fica no bloco da revisão do quadro, desligado por padrão, com a frase "local, nunca push"', () => {
    const html = render(commitState(false));
    expect(html).toContain('Commit automático');
    expect(html).toMatch(/aria-labelledby="[^"]+"[^>]*>Desligada<\/button>/);
    expect(html).toContain('commit local');
    expect(html).toContain('Nunca faz push');
    expect(html).toContain('não é detectada'); // edição fora do Club
    expect(html).not.toContain('commit automático ligado');
  });

  it('ligado: o botão fica pressionado e o título do bloco diz que está ligado', () => {
    const html = render(commitState(true));
    expect(html).toContain('commit automático ligado');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1); // o da revisão segue desligado
  });

  it('sem estado (lendo, ou servidor sem a rota) o controle não aparece; gravando desabilita; o erro do servidor aparece', () => {
    expect(render()).not.toContain('Commit automático');
    expect(render(commitState(null))).not.toContain('Commit automático');
    expect(render(commitState(false, { saving: true }))).toMatch(/<button[^>]*disabled=""[^>]*>Desligada<\/button>/);
    expect(render(commitState(false, { error: 'o commit automático só é ligado ou desligado pelo Claudio’s Club' }))).toContain('só é ligado ou desligado pelo Claudio’s Club');
  });
});

describe('o selo do cartão', () => {
  it('commit inteiro: o SHA, neutro', () => {
    const html = badge(done({}));
    expect(html).toContain('commit abc1234');
    expect(html).not.toContain('is-waiting');
    expect(html).toContain('Nunca vai para o servidor remoto');
  });

  it('commit parcial: amarelo até você ignorar o aviso; depois neutro', () => {
    const partial = done({ status: 'partial', left: [{ path: 'b.ts', why: 'owner' }], alert: true });
    expect(badge(partial)).toMatch(/task-commit small is-waiting[^>]*>commit parcial</);
    expect(badge({ ...partial, ack: true })).toMatch(/task-commit small"[^>]*>commit parcial</);
  });

  it('falhou ou não coube: "sem commit"; nada a commitar (sem alerta) ou fora de "pronto": sem selo', () => {
    expect(badge(done({ status: 'failed', sha: null, files: [], alert: true, note: 'hook' }))).toContain('sem commit');
    expect(badge(done({ status: 'none', sha: null, files: [], alert: true }))).toContain('sem commit');
    expect(badge(done({ status: 'none', sha: null, files: [], alert: false }))).toBe('');
    expect(badge(undefined)).toBe('');
    expect(badge(done({}), 'review')).toBe('');
  });
});

describe('o detalhe', () => {
  const block = (commit?: TaskCommit) => renderToStaticMarkup(createElement(CommitBlock, { task: { status: 'done', commit } }));

  it('lista o que ficou de fora com o motivo no idioma da página; o caminho vai como texto, nunca como HTML', () => {
    const html = block(
      done({
        status: 'partial',
        alert: true,
        left: [
          { path: 'b.ts', why: 'shared', by: 't-111111' },
          { path: 'c.ts', why: 'owner' },
          { path: '<img src=x onerror=alert(1)>.ts', why: 'blocked' },
        ],
      }),
    );
    expect(html).toContain('Commit local abc1234 com 2 arquivo(s).');
    expect(html).toContain('Ficaram de fora (3):');
    expect(html).toContain('também alterado por t-111111, que ainda não terminou');
    expect(html).toContain('você editou depois, no editor do Club');
    expect(html).toContain('Só local: o Claudio’s Club nunca faz push.');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('sem commit: diz que nenhum foi feito e mostra a nota do servidor; sem resultado, nada', () => {
    const html = block(done({ status: 'failed', sha: null, files: [], alert: true, note: 'lint falhou: faltou ponto e vírgula' }));
    expect(html).toContain('Nenhum commit foi feito.');
    expect(html).toContain('lint falhou: faltou ponto e vírgula');
    expect(block(undefined)).toBe('');
  });
});

describe('a caixa e os idiomas', () => {
  it('o item da caixa abre o card da tarefa', () => {
    expect(taskIdOf({ kind: 'error', autoCommit: { taskId: 't-abc123', taskTitle: 'X', status: 'partial' } })).toBe('t-abc123');
    expect(taskIdOf({ kind: 'error' })).toBeUndefined();
  });

  it('as chaves novas existem nos três idiomas, e os motivos têm uma frase para cada código', () => {
    const keys = Object.keys(messages['pt-BR']).filter((k) => /^tasks\.(boardCommit|commit)/.test(k));
    expect(keys.length).toBeGreaterThanOrEqual(19);
    for (const lang of ['en', 'es'] as const) for (const k of keys) expect((messages[lang] as Record<string, string>)[k], `${lang}:${k}`).toBeTruthy();
    for (const why of ['blocked', 'conflict', 'staged', 'owner', 'shared']) expect(keys).toContain(`tasks.commitWhy.${why}`);
  });
});
