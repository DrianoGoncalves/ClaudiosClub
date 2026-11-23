import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import releaseMessages from '../client/src/i18n/release';
import { ReleaseBanner, ReleaseDialog } from '../client/src/tasks/ReleaseDialog';
import type { StaffProfile, Task } from '../shared/model';
import type { ReleaseState, ReleaseView } from '../shared/release';

// A página da versão e a faixa do quadro (ver client/src/tasks/ReleaseDialog.tsx), renderizadas sem navegador.

const task = (id: string, status: Task['status'], title: string, extra: Partial<Task> = {}): Task => ({ id, title, status, staffId: 'ana-1', blockedBy: [], ...extra }) as Task;
const STAFF = [{ id: 'ana-1', name: 'Ana' }] as StaffProfile[];
const TASKS = [task('t-aaaa01', 'todo', 'Tela nova', { blockedBy: ['t-bbbb02'] }), task('t-bbbb02', 'doing', 'Servidor'), task('t-done03', 'done', 'Velha')];
const OPEN: ReleaseState = { version: '1.5.2', taskIds: ['t-aaaa01', 't-bbbb02'], docsTaskId: null, openedAt: '2026-11-23T12:00:00.000Z', prepared: null, prepareError: null, published: null };
const view = (release: ReleaseState | null, extra: Partial<ReleaseView> = {}): ReleaseView => ({
  release,
  tasks: release
    ? [
        { id: 't-aaaa01', title: 'Tela nova', status: 'todo', staffId: 'ana-1', state: 'pending', rejections: 2 },
        { id: 't-bbbb02', title: 'Servidor', status: 'done', staffId: 'ana-1', state: 'done', rejections: 0 },
      ]
    : [],
  done: release ? 1 : 0,
  total: release ? 2 : 0,
  ready: false,
  preparing: false,
  ...extra,
});
const render = (v: ReleaseView | null) =>
  renderToStaticMarkup(createElement(ReleaseDialog, { projectId: 'p', projectName: 'Club', staff: STAFF, tasks: TASKS, onClose: () => {}, onChanged: () => {}, initialView: v, initialHistory: { entries: [], suggested: '1.5.2' } }));

describe('a página da versão', () => {
  it('sem versão aberta: só as pendentes, com caixa de marcar, o número e o card de manual', () => {
    const html = render(view(null));
    expect(html).toContain('Tela nova');
    expect(html).toContain('Servidor');
    expect(html).not.toContain('Velha');
    expect(html).toContain('Pendentes (2)');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('Criar o card de manual e doc');
    // Nada marcado: o botão de abrir fica desligado.
    expect(html).toMatch(/<button type="button" class="btn-primary" disabled="">Abrir versão \(0\)<\/button>/);
  });

  it('versão aberta: progresso, estado de cada tarefa (com as reprovações), tirar e cancelar', () => {
    const html = render(view(OPEN));
    expect(html).toContain('Versão 1.5.2 · 1 de 2 prontas');
    expect(html).toContain('reprovada 2×');
    expect(html).toContain('data-state="done"');
    expect(html).toContain('Tirar');
    expect(html).toContain('Cancelar versão');
    expect(html).toContain('o Club roda os testes e faz o commit da versão sozinho');
  });

  it('preparada e publicada: o PR e o botão da tag; falha de preparação mostra o motivo e as saídas', () => {
    const published = render(view({ ...OPEN, prepared: { at: '', sha: 'abcdef1234', branch: 'release/1.5.0' }, published: { at: '', branch: 'release/1.5.2', pr: 'https://github.com/d/c/pull/9' } }));
    expect(published).toContain('Commit abcdef1 em release/1.5.0');
    expect(published).toContain('href="https://github.com/d/c/pull/9"');
    expect(published).toContain('rel="noopener noreferrer"');
    expect(published).toContain('Criar tag v1.5.2');
    expect(published).not.toContain('>Tirar<');
    const failed = render(view({ ...OPEN, prepareError: { at: '', message: 'os testes falharam: nada foi commitado', testsOutput: 'FAIL' } }, { ready: true }));
    expect(failed).toContain('A preparação falhou: os testes falharam');
    expect(failed).toContain('Preparar sem os testes');
    expect(failed).toContain('Saída dos testes');
  });

  it('a faixa do quadro: some sem versão; aberta diz quantas prontas; preparada pede publicar', () => {
    const banner = (v: ReleaseView | null | undefined) => renderToStaticMarkup(createElement(ReleaseBanner, { view: v, onOpen: () => {} }));
    expect(banner(undefined)).toBe('');
    expect(banner(view(null))).toBe('');
    expect(banner(view(OPEN))).toContain('Versão 1.5.2 aberta · 1 de 2 prontas');
    expect(banner(view({ ...OPEN, prepared: { at: '', sha: 'a'.repeat(40), branch: 'x' } }))).toContain('preparada: falta publicar');
  });

  it('os textos existem nos três idiomas com as mesmas chaves', () => {
    const m = releaseMessages as unknown as Record<string, Record<string, string>>;
    const keys = (l: string) => Object.keys(m[l]!).sort();
    expect(keys('en')).toEqual(keys('pt-BR'));
    expect(keys('es')).toEqual(keys('pt-BR'));
  });
});
