import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileApiError } from '../client/src/api';
import { fixNoteOf, fixProblemKey, fixTargetOf, openOutside, runFix, type FixDeps } from '../client/src/chat/fixSecret';
import type { InboxItem } from '../shared/model';

const withSecret = (secret: Partial<NonNullable<InboxItem['secret']>>): Pick<InboxItem, 'secret'> => ({ secret: { kind: 'password-env', ...secret } });

const err = (status: number, code: string | null = null) => new FileApiError('texto do servidor em pt', status, null, code);

/** As dependências com tudo espiado: `calls` guarda cada chamada na ordem. */
function deps(over: Partial<FixDeps> & { openEditor?: FixDeps['openEditor'] } = {}) {
  const calls: string[] = [];
  const d: FixDeps = {
    projectId: 'futebol',
    local: true,
    openEditor: async (p, path) => void calls.push(`editor:${p}:${path}`),
    openFiles: (path, line) => void calls.push(`files:${path}:${line ?? '-'}`),
    ...over,
  };
  return { d, calls };
}

describe('fixTargetOf: para onde o "Corrigir" leva', () => {
  it('arquivo comum vai à aba Arquivos, na linha do segredo quando o servidor a mandou (caso DEPLOY.md)', () => {
    expect(fixTargetOf(withSecret({ file: 'DEPLOY.md', line: 12 }), true)).toEqual({ how: 'files', path: 'DEPLOY.md', line: 12 });
    expect(fixTargetOf(withSecret({ file: 'DEPLOY.md' }), true)).toEqual({ how: 'files', path: 'DEPLOY.md' });
  });

  it('linha que não é inteiro positivo razoável é ignorada (só o arquivo abre)', () => {
    for (const line of [0, -3, 1.5, NaN, 1_000_001, '7' as unknown as number]) {
      expect(fixTargetOf(withSecret({ file: 'a.md', line }), true), String(line)).toEqual({ how: 'files', path: 'a.md' });
    }
  });

  it('arquivo comum sem como abrir a aba Arquivos: sem alvo', () => {
    expect(fixTargetOf(withSecret({ file: 'a.md', line: 3 }), false)).toBeNull();
  });

  it('arquivo de segredo vai ao editor do computador, com ou sem a aba Arquivos, e a linha não entra', () => {
    for (const canOpenFiles of [true, false]) {
      expect(fixTargetOf(withSecret({ file: '.env', line: 2, fileBlocked: true }), canOpenFiles)).toEqual({ how: 'editor', path: '.env' });
    }
  });

  it('sem arquivo, ou com caminho que sai do projeto: sem alvo', () => {
    expect(fixTargetOf({ secret: undefined }, true)).toBeNull();
    expect(fixTargetOf(withSecret({ detail: 'DB_PASSWORD' }), true)).toBeNull();
    for (const file of ['../x', '/etc/passwd', 'C:/x/.env', 'a\\b']) expect(fixTargetOf(withSecret({ file, fileBlocked: true }), true), file).toBeNull();
  });
});

describe('runFix: o que o clique faz', () => {
  it('arquivo comum só abre a aba Arquivos (com a linha) e nunca chama a rota do editor', async () => {
    const { d, calls } = deps();
    expect(await runFix({ how: 'files', path: 'DEPLOY.md', line: 12 }, d)).toEqual({ kind: 'files' });
    expect(calls).toEqual(['files:DEPLOY.md:12']);
  });

  it('arquivo de segredo chama a rota do editor no projeto do alerta e NÃO abre a aba Arquivos', async () => {
    const { d, calls } = deps();
    const out = await runFix({ how: 'editor', path: '.env' }, d);
    expect(out).toEqual({ kind: 'opened' });
    expect(calls).toEqual(['editor:futebol:.env']);
    expect(fixNoteOf(out)).toMatchObject({ ok: true });
  });

  it('página que não está na máquina do Club: nem chama a rota; a frase manda abrir no editor próprio', async () => {
    const { d, calls } = deps({ local: false });
    const out = await runFix({ how: 'editor', path: '.env' }, d);
    expect(calls).toEqual([]);
    expect(out).toEqual({ kind: 'refused', text: 'O Club não está nesta máquina: abra o arquivo no seu editor.' });
    expect(fixNoteOf(out)).toEqual({ ok: false, text: 'O Club não está nesta máquina: abra o arquivo no seu editor.' });
  });

  it('o servidor diz que o arquivo não é de segredo (lista velha na tela): cai na aba Arquivos; sem ela, avisa', async () => {
    const notSecret = async () => {
      throw err(403, 'not-secret');
    };
    const a = deps({ openEditor: notSecret });
    expect(await openOutside('a.env', a.d)).toEqual({ kind: 'files' });
    expect(a.calls).toEqual(['files:a.env:-']);
    const b = deps({ openEditor: notSecret, openFiles: undefined });
    expect(await openOutside('a.env', b.d)).toEqual({ kind: 'refused', text: 'Este arquivo não é de segredo: abra-o na aba Arquivos do projeto.' });
  });

  it('recusa por pareamento não ganha frase (o aviso do App já explica) e a falha de rede vira frase simples', async () => {
    const pair = deps({ openEditor: async () => { throw err(403, 'needs-pairing'); } });
    const out = await openOutside('.env', pair.d);
    expect(out).toEqual({ kind: 'refused', text: null });
    expect(fixNoteOf(out)).toBeNull();
    const net = deps({ openEditor: async () => { throw new Error('Failed to fetch'); } });
    expect(await openOutside('.env', net.d)).toEqual({ kind: 'refused', text: 'Não deu para abrir o arquivo. Tente de novo ou abra no seu editor.' });
  });

  it('o conteúdo nunca é lido: a rota só devolve o caminho e a frase de sucesso não cita o conteúdo', async () => {
    const { d } = deps({ openEditor: async () => ({ opened: true, path: '.env', editor: 'notepad' }) });
    const note = fixNoteOf(await openOutside('.env', d));
    expect(note?.text).toBe('Aberto no editor de texto do seu computador. O conteúdo não passa pelo Club.');
    expect(JSON.stringify(note)).not.toMatch(/notepad|DB_PASSWORD/);
  });
});

describe('fixProblemKey: a frase sai do status e do code, não do texto do servidor', () => {
  it.each([
    [err(409, 'no-display'), 'chat.fixNoDisplay'],
    [err(409, 'no-editor'), 'chat.fixNoEditor'],
    [err(409, 'changed'), 'chat.fixChanged'],
    [err(409), 'chat.fixError'],
    [err(502, 'open-failed'), 'chat.fixFailed'],
    [err(404), 'chat.fixGone'],
    [err(403, 'not-secret'), 'chat.fixNotSecret'],
    [err(403), 'chat.fixForbidden'],
    [err(400), 'chat.fixError'],
    [err(500), 'chat.fixError'],
    [new Error('rede'), 'chat.fixError'],
    [err(403, 'needs-pairing'), null],
  ])('%#', (e, key) => {
    expect(fixProblemKey(e)).toBe(key);
  });
});

describe('as frases dos recusados nas 3 línguas', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  const KEYS = ['chat.fixNoDisplay', 'chat.fixNoEditor', 'chat.fixChanged', 'chat.fixFailed', 'chat.fixGone', 'chat.fixForbidden', 'chat.fixNotSecret', 'chat.fixError', 'chat.fixRemote', 'chat.fixOpened'] as const;

  it.each([
    ['pt-BR', 'O Club não está nesta máquina: abra o arquivo no seu editor.', 'Corrigir'],
    ['en', 'The Club is not on this machine: open the file in your own editor.', 'Fix'],
    ['es', 'El Club no está en esta máquina: abre el archivo en tu editor.', 'Corregir'],
  ])('%s: toda recusa tem frase própria e a página remota usa a frase certa', async (locale, remote, label) => {
    vi.resetModules();
    vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
    const { t } = await import('../client/src/i18n');
    const mod = await import('../client/src/chat/fixSecret');
    const out = await mod.openOutside('.env', { projectId: 'p', local: false, openEditor: async () => {} });
    expect(out).toEqual({ kind: 'refused', text: remote });
    const seen = new Set<string>();
    for (const key of KEYS) {
      const text = t(key);
      expect(text, key).not.toBe(key);
      expect(text, key).not.toMatch(/^\s*$/);
      seen.add(text);
    }
    expect(seen.size).toBe(KEYS.length);
    expect(t('chat.secretOpenFile')).toBe(label);
  });
});
