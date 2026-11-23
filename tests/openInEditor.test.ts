import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { editorEnv, editorFor, hasGraphicalSession, openEditorRoute, openInEditor, type SpawnFn } from '../server/openInEditor';
import { isBlockedRel, ProjectFileError } from '../server/projectFiles';
import { removeTemp } from './support/tmp';

// "Corrigir" / arquivo de segredo da aba Arquivos (t-e45afe): o servidor abre o arquivo num editor de texto fixo e nunca devolve nem lê o conteúdo.
// Só abre arquivo de segredo e confere o caminho real de novo antes do `spawn` (t-d62471). Nenhum teste abre janela: o `spawn` é um mock, que confere o
// executável, os argumentos, o `shell: false` e o ambiente.
const CONTEUDO = 'DB_PASSWORD=S3nh4Forte1';

let base: string;
let proj: string;
let outside: string;
let realProj: string;

async function symlinkWorks(): Promise<boolean> {
  const target = path.join(os.tmpdir(), `myco-oe-probe-${process.pid}.txt`);
  const link = `${target}.lnk`;
  try {
    await fs.writeFile(target, 'x');
    await fs.symlink(target, link, 'file');
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(link, { force: true }).catch(() => {});
    await fs.rm(target, { force: true }).catch(() => {});
  }
}
const canLink = await symlinkWorks();

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-openeditor-'));
  proj = path.join(base, 'proj');
  outside = path.join(base, 'fora');
  await fs.mkdir(path.join(proj, 'src'), { recursive: true });
  await fs.mkdir(path.join(proj, 'keys'));
  await fs.mkdir(outside);
  await fs.writeFile(path.join(proj, '.env'), `${CONTEUDO}\n`);
  await fs.writeFile(path.join(proj, 'DEPLOY.md'), `${CONTEUDO}\n`);
  await fs.writeFile(path.join(proj, 'src', 'app.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(proj, 'keys', 'server.pem'), 'x');
  await fs.writeFile(path.join(outside, 'segredo.txt'), CONTEUDO);
  await fs.writeFile(path.join(outside, 'server.pem'), CONTEUDO);
  // O resto da classificação da leitura (`isBlockedRel`): pastas de segredo, .git, nomes de chave e as pastas de dependência/build; o modelo de .env é comum.
  for (const [rel, text] of [
    ['.env.local', CONTEUDO],
    ['.env.example', 'DB_PASSWORD='],
    ['.env.sample', 'DB_PASSWORD='],
    ['credentials.prod.json', '{}'],
    ['.vps/server.json', '{}'],
    ['.ssh/id_ed25519', 'x'],
    ['.git/config', '[core]'],
    ['node_modules/pkg/index.js', 'x'],
    ['dist/app.js', 'x'],
    ['README.md', '# x'],
  ] as const) {
    await fs.mkdir(path.dirname(path.join(proj, rel)), { recursive: true });
    await fs.writeFile(path.join(proj, rel), text);
  }
  realProj = await fs.realpath(proj);
});
afterAll(() => removeTemp(base));
afterEach(() => vi.restoreAllMocks());

interface Call {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
}

/** Um `spawn` falso: registra a chamada e, conforme `how`, confirma a subida, falha com ENOENT ou sai com erro. */
function fakeSpawn(how: 'ok' | 'enoent' | 'exit1' | 'throws' | 'silent' = 'ok') {
  const calls: Call[] = [];
  const spawnImpl: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts: opts as Record<string, unknown> });
    if (how === 'throws') throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    setImmediate(() => {
      if (how === 'enoent') child.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
      else if (how === 'exit1') {
        child.emit('spawn');
        child.emit('exit', 1);
      } else if (how === 'ok') child.emit('spawn');
    });
    return child as never;
  };
  return { calls, spawnImpl };
}

const WIN_ENV = { SystemRoot: 'C:\\Windows', SESSIONNAME: 'Console', PATH: 'C:\\Windows\\System32', TEMP: 'C:\\Temp' };
const open = (rel: string, f: ReturnType<typeof fakeSpawn>, o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; log?: (l: string) => void } = {}) =>
  openInEditor(proj, rel, { platform: 'win32', env: WIN_ENV, spawnImpl: f.spawnImpl, settleMs: 0, startMs: 500, ...o });
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: unknown } | 'ok'> => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof ProjectFileError) return { status: err.status, code: err.extra.code };
    throw err;
  }
};

describe('o que roda em cada sistema', () => {
  it('Windows: notepad.exe do System32 com o caminho absoluto real, `shell: false`, destacado, sem tokens no ambiente', async () => {
    const f = fakeSpawn();
    const env = {
      ...WIN_ENV,
      MYCO_TOKEN: 'tok-club',
      MYCO_URL: 'http://127.0.0.1:4848',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok-claude',
      CLAUDECODE: '1',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      CODEX_HOME: 'C:\\codex',
      OPENAI_API_KEY: 'sk-x',
      GITHUB_TOKEN: 'ghp_x',
      GH_TOKEN: 'ghp_y',
      AWS_ACCESS_KEY_ID: 'AKIAX',
      NPM_TOKEN: 'npm_x',
      DB_PASSWORD: 'senha',
      API_KEY: 'k',
      STRIPE_SECRET: 's',
      SSH_AUTH_SOCK: '/tmp/ssh',
    };
    const r = await open('.env', f, { env });
    expect(f.calls).toHaveLength(1);
    const [c] = f.calls;
    expect(c!.cmd).toBe(path.win32.join('C:\\Windows', 'System32', 'notepad.exe'));
    expect(c!.args).toEqual([path.join(realProj, '.env')]);
    expect(c!.opts).toMatchObject({ shell: false, detached: true, stdio: 'ignore', cwd: realProj });
    // O ambiente: o do servidor, menos tudo o que é do Club/CLI e o que tem cara de chave.
    expect(c!.opts.env).toEqual({ SystemRoot: 'C:\\Windows', SESSIONNAME: 'Console', PATH: 'C:\\Windows\\System32', TEMP: 'C:\\Temp' });
    expect(r).toEqual({ opened: true, path: '.env', editor: 'notepad' });
  });

  it('macOS: /usr/bin/open -t <caminho> (o editor de texto padrão, não o app da extensão)', async () => {
    const f = fakeSpawn();
    const r = await open('keys/server.pem', f, { platform: 'darwin', env: { HOME: '/Users/x', MYCO_TOKEN: 't' } });
    expect(f.calls).toEqual([{ cmd: '/usr/bin/open', args: ['-t', path.join(realProj, 'keys', 'server.pem')], opts: expect.objectContaining({ shell: false, env: { HOME: '/Users/x' } }) }]);
    expect(r).toEqual({ opened: true, path: 'keys/server.pem', editor: 'textedit' });
  });

  it('Linux: só o editor gráfico configurado (VISUAL, depois EDITOR), com os argumentos dele e o caminho por último', async () => {
    const f = fakeSpawn();
    const r = await open('.env', f, { platform: 'linux', env: { DISPLAY: ':0', VISUAL: 'gedit --new-window', EDITOR: 'nano' } });
    expect(f.calls).toEqual([{ cmd: 'gedit', args: ['--new-window', path.join(realProj, '.env')], opts: expect.objectContaining({ shell: false }) }]);
    expect(r).toEqual({ opened: true, path: '.env', editor: 'custom' });
    const g = fakeSpawn();
    await open('.env', g, { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', EDITOR: '/usr/bin/kate' } });
    expect(g.calls[0]).toMatchObject({ cmd: '/usr/bin/kate', args: [path.join(realProj, '.env')] });
  });

  it('Linux sem editor configurado, ou só com editor de terminal: recusa com mensagem e código, sem abrir nada', async () => {
    for (const env of [{ DISPLAY: ':0' }, { DISPLAY: ':0', EDITOR: '  ' }, { DISPLAY: ':0', VISUAL: 'vim' }, { DISPLAY: ':0', EDITOR: '/usr/bin/nano' }, { DISPLAY: ':0', EDITOR: 'nvim -f' }]) {
      const f = fakeSpawn();
      const err = await open('.env', f, { platform: 'linux', env }).catch((e) => e);
      expect(err, JSON.stringify(env)).toBeInstanceOf(ProjectFileError);
      expect(err).toMatchObject({ status: 409, extra: { code: 'no-editor' } });
      expect(err.message).toMatch(/VISUAL ou EDITOR/);
      expect(f.calls).toHaveLength(0);
    }
  });

  it('o caminho que o Windows usa é completo (a pasta atual não entra na busca do notepad.exe)', () => {
    expect(editorFor('win32', {}, 'C:\\p\\a.txt').cmd).toBe(path.win32.join('C:\\Windows', 'System32', 'notepad.exe'));
    expect(editorFor('win32', { windir: 'D:\\Win' }, 'C:\\p\\a.txt').cmd).toBe(path.win32.join('D:\\Win', 'System32', 'notepad.exe'));
    expect(path.win32.isAbsolute(editorFor('win32', { SystemRoot: 'C:\\Windows' }, 'C:\\p\\a.txt').cmd)).toBe(true);
  });
});

describe('sem sessão gráfica a recusa é no servidor, com um código que a tela entende', () => {
  it('Linux sem DISPLAY nem WAYLAND_DISPLAY; Windows sem sessão interativa; MYCO_HEADLESS em qualquer sistema', async () => {
    for (const [platform, env] of [
      ['linux', { VISUAL: 'gedit' }],
      ['linux', { VISUAL: 'gedit', DISPLAY: '', WAYLAND_DISPLAY: '' }],
      ['win32', { SystemRoot: 'C:\\Windows' }],
      ['win32', { ...WIN_ENV, MYCO_HEADLESS: '1' }],
      ['darwin', { MYCO_HEADLESS: 'true' }],
      ['linux', { VISUAL: 'gedit', DISPLAY: ':0', MYCO_HEADLESS: 'yes' }],
    ] as const) {
      const f = fakeSpawn();
      const err = await open('.env', f, { platform, env }).catch((e) => e);
      expect(err, `${platform} ${JSON.stringify(env)}`).toMatchObject({ status: 409, extra: { code: 'no-display' } });
      expect(f.calls).toHaveLength(0);
    }
  });

  it('com sessão gráfica a regra libera', () => {
    expect(hasGraphicalSession('linux', { DISPLAY: ':0' })).toBe(true);
    expect(hasGraphicalSession('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
    expect(hasGraphicalSession('win32', { SESSIONNAME: 'RDP-Tcp#0' })).toBe(true);
    expect(hasGraphicalSession('darwin', {})).toBe(true);
    expect(hasGraphicalSession('darwin', { MYCO_HEADLESS: '0' })).toBe(true);
  });
});

describe('o que a rota recusa (e nada é aberto)', () => {
  it('fora do projeto, caminho absoluto, `..` e NUL: 403', async () => {
    const f = fakeSpawn();
    for (const p of ['../fora/segredo.txt', 'src/../../fora/segredo.txt', path.join(outside, 'segredo.txt'), 'C:\\Windows\\win.ini', '/etc/passwd', 'DEPLOY.md\0.txt']) {
      expect(await status(open(p, f)), p).toMatchObject({ status: 403 });
    }
    expect(f.calls).toHaveLength(0);
  });

  it.runIf(canLink)('link e junção que saem do projeto: 403; link para dentro abre o arquivo real', async () => {
    const f = fakeSpawn();
    await fs.symlink(path.join(outside, 'segredo.txt'), path.join(proj, 'atalho-fora.pem'), 'file');
    await fs.symlink(outside, path.join(proj, 'junction-fora'), 'junction');
    expect(await status(open('atalho-fora.pem', f))).toMatchObject({ status: 403 });
    expect(await status(open('junction-fora/segredo.txt', f))).toMatchObject({ status: 403 });
    expect(f.calls).toHaveLength(0);
    await fs.symlink(path.join(proj, '.env'), path.join(proj, 'atalho-dentro.txt'), 'file');
    const r = await open('atalho-dentro.txt', f);
    expect(f.calls[0]!.args).toEqual([path.join(realProj, '.env')]);
    expect(r.path).toBe('atalho-dentro.txt');
  });

  it('pasta e inexistente: 404; vazio ou só "." (a raiz): não abre', async () => {
    const f = fakeSpawn();
    for (const p of ['src', 'keys', '.env.nao-existe', 'src/app.ts/dentro', 'nao/existe/mesmo.txt']) expect(await status(open(p, f)), p).toMatchObject({ status: 404 });
    for (const p of ['', '.', './']) expect(await status(open(p, f)), JSON.stringify(p)).toMatchObject({ status: 400 });
    expect(f.calls).toHaveLength(0);
  });

  it('o sistema não conseguiu abrir (programa ausente, saída com erro, spawn que falha, sem resposta): 502 `open-failed`, com texto fixo', async () => {
    for (const how of ['enoent', 'exit1', 'throws', 'silent'] as const) {
      const f = fakeSpawn(how);
      const logs: string[] = [];
      const err = await open('.env', f, { log: (l) => logs.push(l) }).catch((e) => e);
      expect(err, how).toMatchObject({ status: 502, extra: { code: 'open-failed' } });
      // A mensagem do sistema (que pode ter o caminho do usuário) só vai ao log; a tela recebe o texto fixo.
      expect(err.message).not.toContain(base);
      expect(logs.join('\n')).not.toContain(CONTEUDO);
    }
  });
});

describe('só arquivo de segredo abre (a classificação da leitura: isBlockedRel)', () => {
  const SEGREDO = ['.env', '.env.local', 'credentials.prod.json', 'keys/server.pem', '.vps/server.json', '.ssh/id_ed25519', '.git/config', 'node_modules/pkg/index.js', 'dist/app.js'];
  const COMUM = ['DEPLOY.md', 'src/app.ts', 'README.md', '.env.example', '.env.sample'];

  it('segredo, pasta de segredo, .git e as pastas que a leitura esconde abrem, e a resposta é a do contrato (200 {opened, path, editor})', async () => {
    for (const p of SEGREDO) {
      const f = fakeSpawn();
      expect(await open(p, f), p).toEqual({ opened: true, path: p, editor: 'notepad' });
      expect(f.calls[0]!.args, p).toEqual([path.join(realProj, ...p.split('/'))]);
    }
  });

  it('arquivo comum (mesmo com senha dentro) e modelo de .env: 403 `not-secret`, nada abre e o arquivo não é lido', async () => {
    const read = vi.spyOn(fs, 'readFile');
    const f = fakeSpawn();
    for (const p of COMUM) {
      const err = await open(p, f).catch((e) => e);
      expect(err, p).toBeInstanceOf(ProjectFileError);
      expect(err, p).toMatchObject({ status: 403, extra: { code: 'not-secret' } });
      expect(err.message).toMatch(/aba Arquivos/);
      expect(err.message).not.toContain(CONTEUDO);
    }
    expect(f.calls).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('a recusa por não ser segredo vem antes das de ambiente (sem tela, sem editor): a tela vê o motivo da política', async () => {
    const f = fakeSpawn();
    expect(await status(open('DEPLOY.md', f, { platform: 'linux', env: { VISUAL: 'gedit' } }))).toMatchObject({ status: 403, code: 'not-secret' });
    expect(await status(open('DEPLOY.md', f, { platform: 'linux', env: { DISPLAY: ':0' } }))).toMatchObject({ status: 403, code: 'not-secret' });
    expect(f.calls).toHaveLength(0);
  });

  it('é a mesma lista que a leitura recusa: abre se e só se `isBlockedRel`', async () => {
    for (const p of [...SEGREDO, ...COMUM]) {
      const f = fakeSpawn();
      const r = await status(open(p, f));
      expect(r === 'ok', p).toBe(isBlockedRel(p));
      expect(f.calls.length, p).toBe(isBlockedRel(p) ? 1 : 0);
    }
  });

  it.runIf(canLink)('vale o caminho REAL: `a.env` que aponta para arquivo comum recusa; nome comum que aponta para um segredo abre o segredo', async () => {
    const f = fakeSpawn();
    await fs.symlink(path.join(proj, 'src', 'app.ts'), path.join(proj, 'segredo-falso.env'), 'file');
    expect(await status(open('segredo-falso.env', f))).toMatchObject({ status: 403, code: 'not-secret' });
    expect(f.calls).toHaveLength(0);
    await fs.symlink(path.join(proj, 'keys'), path.join(proj, 'pasta-chaves'), 'junction');
    await fs.symlink(path.join(proj, 'src'), path.join(proj, 'pasta-src'), 'junction');
    expect(await status(open('pasta-src/app.ts', f))).toMatchObject({ status: 403, code: 'not-secret' });
    expect(f.calls).toHaveLength(0);
    const r = await open('pasta-chaves/server.pem', f);
    expect(f.calls[0]!.args).toEqual([path.join(realProj, 'keys', 'server.pem')]);
    expect(r.path).toBe('pasta-chaves/server.pem');
  });
});

describe('troca do arquivo por link entre a conferência e a abertura (TOCTOU)', () => {
  /**
   * Roda `swap` quando a SEGUNDA conferência do caminho começa (a 2ª leitura do realpath da raiz do projeto), isto é, depois da primeira conferência
   * e antes do `spawn`: é o momento em que um agente trocaria o arquivo. Devolve quantas vezes o projeto foi resolvido.
   */
  function swapOnRecheck(swap: () => Promise<void>) {
    const real = fs.realpath;
    const seen = { roots: 0 };
    vi.spyOn(fs, 'realpath').mockImplementation((async (p: string, ...rest: never[]) => {
      if (p === proj && ++seen.roots === 2) await swap();
      return (real as (...a: unknown[]) => Promise<string>).call(fs, p, ...rest);
    }) as never);
    return seen;
  }
  const toDir = (dir: string, target: string) => async () => {
    await fs.rename(path.join(proj, dir), path.join(proj, `${dir}.orig`));
    await fs.symlink(target, path.join(proj, dir), 'junction');
  };

  it('sem troca: o projeto é resolvido duas vezes (a segunda é a que vale) e o editor abre o caminho real', async () => {
    await fs.mkdir(path.join(proj, 'estavel'));
    await fs.writeFile(path.join(proj, 'estavel', 'server.pem'), 'x');
    const seen = swapOnRecheck(async () => {});
    const f = fakeSpawn();
    await open('estavel/server.pem', f);
    expect(seen.roots).toBe(2);
    expect(f.calls[0]!.args).toEqual([path.join(realProj, 'estavel', 'server.pem')]);
  });

  it.runIf(canLink)('a pasta vira junção para FORA do projeto depois da primeira conferência: 403 e nada abre', async () => {
    await fs.mkdir(path.join(proj, 'troca-fora'));
    await fs.writeFile(path.join(proj, 'troca-fora', 'server.pem'), 'x');
    swapOnRecheck(toDir('troca-fora', outside));
    const f = fakeSpawn();
    expect(await status(open('troca-fora/server.pem', f))).toMatchObject({ status: 403 });
    expect(f.calls).toHaveLength(0);
  });

  it.runIf(canLink)('vira junção para OUTRO arquivo de segredo dentro do projeto: o caminho real mudou, 409 `changed` e nada abre', async () => {
    await fs.mkdir(path.join(proj, 'troca-dentro'));
    await fs.writeFile(path.join(proj, 'troca-dentro', 'server.pem'), 'x');
    swapOnRecheck(toDir('troca-dentro', path.join(proj, 'keys')));
    const f = fakeSpawn();
    const err = await open('troca-dentro/server.pem', f).catch((e) => e);
    expect(err).toMatchObject({ status: 409, extra: { code: 'changed' } });
    expect(err.message).not.toContain(base);
    expect(f.calls).toHaveLength(0);
  });

  it.runIf(canLink)('o link passa a apontar para arquivo comum do projeto: a segunda conferência recusa por não ser segredo', async () => {
    const link = path.join(proj, 'troca-comum.txt');
    await fs.symlink(path.join(proj, '.env'), link, 'file');
    swapOnRecheck(async () => {
      await fs.rm(link);
      await fs.symlink(path.join(proj, 'src', 'app.ts'), link, 'file');
    });
    const f = fakeSpawn();
    expect(await status(open('troca-comum.txt', f))).toMatchObject({ status: 403, code: 'not-secret' });
    expect(f.calls).toHaveLength(0);
  });

  it('o arquivo some entre as duas conferências: 404, nada abre', async () => {
    await fs.writeFile(path.join(proj, 'some.pem'), 'x');
    swapOnRecheck(() => fs.rm(path.join(proj, 'some.pem')));
    const f = fakeSpawn();
    expect(await status(open('some.pem', f))).toMatchObject({ status: 404 });
    expect(f.calls).toHaveLength(0);
  });
});

describe('o conteúdo nunca passa pelo servidor desta rota', () => {
  it('não lê o arquivo (nem o .env), a resposta e o log têm só o caminho', async () => {
    const read = vi.spyOn(fs, 'readFile');
    const f = fakeSpawn();
    const logs: string[] = [];
    for (const p of ['.env', '.env.local', 'keys/server.pem']) {
      const r = await open(p, f, { log: (l) => logs.push(l) });
      expect(r).toEqual({ opened: true, path: p, editor: 'notepad' });
      expect(JSON.stringify(r)).not.toContain('DB_PASSWORD');
    }
    expect(read).not.toHaveBeenCalled();
    expect(logs).toHaveLength(3);
    expect(logs.join('\n')).not.toContain('DB_PASSWORD');
    expect(logs[0]).toContain('".env"');
    expect(logs.join('\n')).not.toContain(base);
  });
});

describe('openEditorRoute: o que a rota POST files/open-editor faz', () => {
  it('sem o navegador pareado (ferramenta, funcionário, sandbox): 403, e nada abre nem é validado', async () => {
    const f = fakeSpawn();
    const o = { platform: 'win32', env: WIN_ENV, spawnImpl: f.spawnImpl, settleMs: 0 } as const;
    expect(await status(openEditorRoute({ fromBrowser: false, body: { path: '.env' }, projectDir: proj }, o))).toMatchObject({ status: 403 });
    expect(await status(openEditorRoute({ fromBrowser: false, body: 'lixo', projectDir: proj }, o))).toMatchObject({ status: 403 });
    expect(f.calls).toHaveLength(0);
  });

  it('corpo inválido: 400; projeto desconhecido: null (404 da rota); válido: o resultado', async () => {
    const f = fakeSpawn();
    const o = { platform: 'win32', env: WIN_ENV, spawnImpl: f.spawnImpl, settleMs: 0 } as const;
    for (const body of [null, undefined, 'x', 1, {}, { path: 1 }, { path: null }]) {
      expect(await status(openEditorRoute({ fromBrowser: true, body, projectDir: proj }, o)), JSON.stringify(body)).toMatchObject({ status: 400 });
    }
    expect(await openEditorRoute({ fromBrowser: true, body: { path: '.env' }, projectDir: null }, o)).toBeNull();
    expect(await openEditorRoute({ fromBrowser: true, body: { path: '.env', extra: 'ignorado' }, projectDir: proj }, o)).toEqual({ opened: true, path: '.env', editor: 'notepad' });
    expect(f.calls).toHaveLength(1);
  });

  it('está ligada no servidor só como POST do navegador; a rota files/reveal e o que ela servia saíram', async () => {
    const index = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(index).toMatch(/'POST',\s*new RegExp\(`\^\/api\/projects\/\$\{ID\}\/files\/open-editor\$`\),\s*async \(\{ params: \[id\], body, fromBrowser \}\) => openEditorRoute\(/);
    expect(index).not.toMatch(/files\/reveal|parseRevealBody|reveal: true/);
    const files = await fs.readFile(path.join(__dirname, '..', 'server', 'projectFiles.ts'), 'utf8');
    expect(files).not.toMatch(/reveal|inHiddenDir/i);
  });
});

describe('editorEnv: o ambiente do editor', () => {
  it('sai sem MYCO_*, CLAUDE*, ANTHROPIC*, CODEX*, OPENAI*, GitHub, AWS e o que tem cara de token, chave ou senha; o resto fica', () => {
    const out = editorEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      DISPLAY: ':0',
      LANG: 'pt_BR.UTF-8',
      KEYBOARD_LAYOUT: 'br',
      MYCO_TOKEN: 'a',
      MYCO_HOME: '/h',
      CLAUDE_CODE_X: 'b',
      CLAUDECODE: '1',
      ANTHROPIC_API_KEY: 'c',
      CODEX_HOME: 'd',
      OPENAI_API_KEY: 'e',
      GITHUB_TOKEN: 'f',
      GH_ENTERPRISE_TOKEN: 'g',
      AWS_SESSION_TOKEN: 'h',
      NPM_CONFIG_TOKEN: 'i',
      MY_DB_PASSWORD: 'j',
      SOME_SECRET: 'k',
      GPG_KEY: 'l',
      APIKEY: 'm',
      SSH_AUTH_SOCK: 'n',
      PASSWD: 'o',
    });
    expect(Object.keys(out).sort()).toEqual(['DISPLAY', 'HOME', 'KEYBOARD_LAYOUT', 'LANG', 'PATH']);
  });
});
