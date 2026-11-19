import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ExtensionInfo, ExtensionPairing } from '../client/src/api';
import { linkItem, parseOpenLink } from '../client/src/inbox/deepLink';
import { ExtensionView, type ExtensionViewProps } from '../client/src/toolbar/ExtensionControls';
import { canGenerate, cleanLabel, codeSecondsLeft, countdown, MAX_PAIRINGS, newPairing } from '../client/src/toolbar/extensionView';
import { clubLink } from '../extension/lib/inbox.js';
import { MAX_EXTENSION_PAIRINGS } from '../server/extension/tokens';

// A tela da extensão do Chrome nas Configurações (renderização no servidor, sem navegador) e o link que a notificação abre.

const NOW = Date.parse('2026-11-16T12:00:00Z');
const pairing = (id: string, over: Partial<ExtensionPairing> = {}): ExtensionPairing => ({
  id,
  label: `Chrome ${id}`,
  createdAt: '2026-11-16T11:00:00Z',
  lastUsedAt: null,
  ...over,
});
const info = (over: Partial<ExtensionInfo> = {}): ExtensionInfo => ({ id: 'eadddhkfbbohinnnpnakbabjlmbijjgc', available: true, pairings: [], ...over });

const render = (props: Partial<ExtensionViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(ExtensionView, {
      info: info(),
      error: null,
      code: null,
      copied: false,
      label: '',
      busy: null,
      justPaired: null,
      now: NOW,
      onLabel: () => {},
      onDownload: () => {},
      onPair: () => {},
      onCopy: () => {},
      onRevoke: () => {},
      ...props,
    }),
  );

describe('extensão do Chrome nas Configurações: tela', () => {
  it('lendo ou sem a rota: só o erro, sem passos nem botões', () => {
    const html = render({ info: null, error: 'Este servidor não tem a extensão do Chrome. Atualize o Claudio’s Club.' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('não tem a extensão do Chrome');
    expect(html).not.toContain('Baixar extensão');
    expect(html).not.toContain('Gerar código');
  });

  it('mostra o botão de baixar, os passos de instalação e a lista vazia', () => {
    const html = render();
    expect(html).toContain('Baixar extensão');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Baixar extensão/);
    expect(html).toContain('chrome://extensions');
    expect(html).toContain('Modo do desenvolvedor');
    expect(html).toContain('Carregar sem compactação');
    expect(html).toContain('Nenhuma extensão pareada.');
    expect(html).toContain('Pareadas (0 de 5)');
  });

  it('pasta da extensão ausente: baixar e gerar código ficam desligados, com o motivo', () => {
    const html = render({ info: info({ available: false }) });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Baixar extensão/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Gerar código de pareamento/);
    expect(html).toContain('ainda não está nesta versão');
  });

  it('baixando: o botão avisa e desliga', () => {
    expect(render({ busy: 'download' })).toMatch(/<button[^>]*disabled[^>]*>Baixando…/);
  });

  it('o código aparece com o tempo que falta; vencido, só o aviso (e o código some)', () => {
    const live = render({ code: { value: 'ABCD-EFGH', left: 272 } });
    expect(live).toContain('ABCD-EFGH');
    expect(live).toContain('4:32');
    expect(live).toContain('uso único');
    const dead = render({ code: { value: 'ABCD-EFGH', left: 0 } });
    expect(dead).not.toContain('ABCD-EFGH');
    expect(dead).toContain('O código expirou');
  });

  it('copiado troca o rótulo do botão', () => {
    expect(render({ code: { value: 'ABCD-EFGH', left: 60 }, copied: true })).toContain('Copiado');
    expect(render({ code: { value: 'ABCD-EFGH', left: 60 } })).toContain('>Copiar<');
  });

  it('lista as pareadas com o uso e o botão de revogar; sem uso diz "ainda não usada"', () => {
    const html = render({
      info: info({ pairings: [pairing('ext-1', { label: 'Trabalho', lastUsedAt: '2026-11-16T11:58:00Z' }), pairing('ext-2', { label: 'Casa' })] }),
    });
    expect(html).toContain('Pareadas (2 de 5)');
    expect(html).toContain('Trabalho');
    expect(html).toContain('último uso há 2min');
    expect(html).toContain('pareada há 1h');
    expect(html).toContain('ainda não usada');
    expect(html.match(/is-danger/g)).toHaveLength(2);
  });

  it('com 5 pareadas não dá para gerar outro código: o motivo vem na tela', () => {
    const html = render({ info: info({ pairings: [1, 2, 3, 4, 5].map((n) => pairing(`ext-${n}`)) }) });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Gerar código de pareamento/);
    expect(html).toContain('Limite de 5 extensões pareadas');
  });

  it('quando a extensão troca o código, a tela diz quem pareou', () => {
    expect(render({ justPaired: 'Chrome do trabalho' })).toContain('✓ “Chrome do trabalho” pareada.');
  });
});

describe('extensão do Chrome: regras da tela', () => {
  it('o limite da tela é o do servidor', () => {
    expect(MAX_PAIRINGS).toBe(MAX_EXTENSION_PAIRINGS);
  });

  it('tempo que falta no código: arredonda para cima e nunca passa de zero', () => {
    expect(codeSecondsLeft(NOW + 4500, NOW)).toBe(5);
    expect(codeSecondsLeft(NOW, NOW)).toBe(0);
    expect(codeSecondsLeft(NOW - 1000, NOW)).toBe(0);
    expect(countdown(272)).toBe('4:32');
    expect(countdown(300)).toBe('5:00');
    expect(countdown(5)).toBe('0:05');
    expect(countdown(-3)).toBe('0:00');
  });

  it('pareamento novo = id que não estava antes', () => {
    const list = [pairing('a'), pairing('b')];
    expect(newPairing(['a', 'b'], list)).toBeNull();
    expect(newPairing(['a'], list)?.id).toBe('b');
    expect(newPairing([], [])).toBeNull();
  });

  it('só gera código com a extensão disponível e vaga', () => {
    expect(canGenerate(null)).toBe(false);
    expect(canGenerate(info({ available: false }))).toBe(false);
    expect(canGenerate(info())).toBe(true);
    expect(canGenerate(info({ pairings: [1, 2, 3, 4].map((n) => pairing(`e${n}`)) }))).toBe(true);
    expect(canGenerate(info({ pairings: [1, 2, 3, 4, 5].map((n) => pairing(`e${n}`)) }))).toBe(false);
  });

  it('o nome do pareamento perde os espaços das pontas e passa de 40 caracteres cortado', () => {
    expect(cleanLabel('  Casa  ')).toBe('Casa');
    expect(cleanLabel('x'.repeat(60))).toHaveLength(40);
    expect(cleanLabel('   ')).toBe('');
  });
});

describe('extensão do Chrome: o link que a notificação abre', () => {
  const hashOf = (target: Parameters<typeof clubLink>[0]) => new URL(clubLink(target)).hash;

  it('aviso de funcionário: o Club lê o mesmo que a extensão escreveu', () => {
    const link = parseOpenLink(hashOf({ kind: 'plan', projectId: 'p-1', staffId: 'ana' }));
    expect(link).toEqual({ tasks: false, kind: 'plan', projectId: 'p-1', staffId: 'ana' });
    expect(linkItem(link as Extract<typeof link, { tasks: false }>)).toMatchObject({ kind: 'plan', projectId: 'p-1', staffId: 'ana', sessionId: '' });
  });

  it('aviso do projeto (sem funcionário) e consumo (sem projeto)', () => {
    expect(parseOpenLink(hashOf({ kind: 'error', projectId: 'p-1', staffId: null }))).toEqual({ tasks: false, kind: 'error', projectId: 'p-1', staffId: null });
    expect(parseOpenLink(hashOf({ kind: 'usage' }))).toEqual({ tasks: false, kind: 'usage', projectId: '', staffId: null });
  });

  it('quadro de tarefas do projeto', () => {
    expect(parseOpenLink(hashOf({ view: 'tasks', projectId: 'p-1' }))).toEqual({ tasks: true, projectId: 'p-1' });
  });

  it('aviso de tarefa (dúvida, parada, bloqueada, esquecida) abre o quadro do projeto, já no card quando traz a tarefa', () => {
    for (const kind of ['question', 'stuck', 'blocked', 'notStarted']) {
      expect(parseOpenLink(hashOf({ kind, projectId: 'p-1', staffId: 'ana' })), kind).toEqual({ tasks: true, projectId: 'p-1' });
      expect(parseOpenLink(hashOf({ kind, projectId: 'p-1', staffId: 'ana', taskId: 't-9a8b7c' })), kind).toEqual({ tasks: true, projectId: 'p-1', taskId: 't-9a8b7c' });
    }
    // Sem a extensão no meio: o kind sozinho, sem `tela`, vale do mesmo jeito; sem projeto, não abre nada.
    expect(parseOpenLink('#abrir?kind=question&projeto=p-1')).toEqual({ tasks: true, projectId: 'p-1' });
    expect(parseOpenLink('#abrir?kind=stuck')).toBeNull();
  });

  it('id de tarefa com forma estranha não vira alvo (abre só o quadro)', () => {
    expect(parseOpenLink('#abrir?kind=question&projeto=p-1&tarefa=t%2F1')).toEqual({ tasks: true, projectId: 'p-1' });
    expect(parseOpenLink('#abrir?tela=tarefas&projeto=p-1&tarefa=a%20b')).toEqual({ tasks: true, projectId: 'p-1' });
  });

  it('o que vem de fora e não tem a forma esperada não abre nada', () => {
    for (const hash of [
      '',
      '#',
      '#abrir',
      '#abrir?',
      '#outra?kind=plan&projeto=p-1',
      '#abrir?kind=plan', // sem projeto
      '#abrir?kind=nao-existe&projeto=p-1',
      '#abrir?kind=plan&projeto=../../etc',
      '#abrir?kind=plan&projeto=p 1',
      '#abrir?tela=tarefas', // sem projeto
      '#abrir?tela=arquivos&projeto=p-1',
    ]) {
      expect(parseOpenLink(hash), hash).toBeNull();
    }
  });

  it('funcionário com forma estranha vira "sem funcionário" (abre o projeto), não um id inventado', () => {
    expect(parseOpenLink('#abrir?kind=waiting&projeto=p-1&funcionario=a%2Fb')).toEqual({ tasks: false, kind: 'waiting', projectId: 'p-1', staffId: null });
  });
});
