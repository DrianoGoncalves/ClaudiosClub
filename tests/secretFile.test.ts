import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SecretSource } from '../shared/model';
import { claudeToolFile, codexToolFile, secretFile } from '../server/chat/codeEdits';
import { CodexProcess } from '../server/chat/codexProcess';
import { ChatManager } from '../server/chat/manager';
import { ChatProcess } from '../server/chat/process';
import { secretInboxItem, type SecretHit } from '../server/inboxItems';
import { isBlockedRel, ProjectFileError, readProjectFile, readProjectImageFile } from '../server/projectFiles';

// Arquivo do aviso de segredo (`secret.file`): de onde vem em cada motor, como vira caminho do projeto e o que a tela recebe (nunca o valor
// do segredo nem pasta absoluta). O valor abaixo é fictício: só precisa casar com o filtro de segredos.
const VALOR = 'S3nh4Forte1';
const SEGREDO = `DB_PASSWORD=${VALOR}`;

let root: string;
let proj: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-secretfile-'));
  proj = path.join(root, 'proj');
  await fs.mkdir(path.join(proj, 'src'), { recursive: true });
  await fs.writeFile(path.join(proj, 'src', 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(proj, '.env'), `${SEGREDO}\n`);
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const tick = () => new Promise((r) => setTimeout(r, 15));

function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 4242, kill: () => proc.emit('exit', 0) });
  const spawnImpl = () => proc as never;
  const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
  return { proc, spawnImpl, emit };
}

function fakeCodex() {
  const runs: Array<{ emit: (ev: object) => void }> = [];
  const spawnImpl = () => {
    const stdout = new PassThrough();
    runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n') });
    return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 4243 }) as never;
  };
  return { spawnImpl, last: () => runs[runs.length - 1]! };
}

type Seen = Array<{ label: string; source?: SecretSource; file?: string }>;

describe('claudeToolFile: o arquivo de uma ferramenta do Claude', () => {
  it('Read, Write, Edit e MultiEdit usam file_path; NotebookEdit usa notebook_path', () => {
    for (const tool of ['Read', 'Write', 'Edit', 'MultiEdit']) expect(claudeToolFile(tool, { file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(claudeToolFile('NotebookEdit', { notebook_path: 'n/a.ipynb' })).toBe('n/a.ipynb');
    expect(claudeToolFile('NotebookEdit', { file_path: 'src/a.ts' })).toBeNull();
  });

  it('as outras ferramentas e entrada sem caminho dão null (Grep e Glob têm `path` de pasta)', () => {
    expect(claudeToolFile('Grep', { pattern: 'x', path: 'src' })).toBeNull();
    expect(claudeToolFile('Glob', { pattern: '*.ts', path: 'src' })).toBeNull();
    expect(claudeToolFile('Bash', { command: 'cat .env', file_path: 'x' })).toBeNull();
    expect(claudeToolFile('Read', {})).toBeNull();
    expect(claudeToolFile('Read', { file_path: '  ' })).toBeNull();
    expect(claudeToolFile('Read', { file_path: 42 })).toBeNull();
    expect(claudeToolFile('Read', null)).toBeNull();
  });
});

describe('codexToolFile: o arquivo de um item do Codex', () => {
  const cmd = (command: string) => codexToolFile({ type: 'command_execution', command });

  it('file_change só vale com exatamente uma mudança', () => {
    expect(codexToolFile({ type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }] })).toBe('src/a.ts');
    expect(codexToolFile({ type: 'file_change', changes: [{ path: 'a.ts', kind: 'add' }, { path: 'b.ts', kind: 'update' }] })).toBeNull();
    expect(codexToolFile({ type: 'file_change', changes: [] })).toBeNull();
    expect(codexToolFile({ type: 'file_change', changes: [{ kind: 'update' }] })).toBeNull();
    expect(codexToolFile({ type: 'file_change' })).toBeNull();
  });

  it('leitura simples de um arquivo: cat, type, Get-Content, gc, head e tail, com ou sem invólucro do shell', () => {
    expect(cmd('cat .env')).toBe('.env');
    expect(cmd('type config\\app.ini')).toBe('config\\app.ini');
    expect(cmd('Get-Content config/app.ini')).toBe('config/app.ini');
    expect(cmd('gc a.txt')).toBe('a.txt');
    expect(cmd('GET-CONTENT -Raw a.txt')).toBe('a.txt');
    expect(cmd('Get-Content -Path a.txt -TotalCount 20')).toBe('a.txt');
    expect(cmd('Get-Content -LiteralPath a.txt -Tail 5')).toBe('a.txt');
    expect(cmd('head -n 20 a.txt')).toBe('a.txt');
    expect(cmd('head -n20 a.txt')).toBe('a.txt');
    expect(cmd('tail -20 a.txt')).toBe('a.txt');
    expect(cmd('cat "meu arquivo.ini"')).toBe('meu arquivo.ini');
    expect(cmd("cat 'meu arquivo.ini'")).toBe('meu arquivo.ini');
    expect(cmd("/usr/bin/bash -lc 'cat src/app.ini'")).toBe('src/app.ini');
  });

  it('fora da leitura simples de um arquivo o campo fica ausente: pipe, ; e &&, redirecionamento, vários arquivos, variável, curinga, outro programa', () => {
    for (const c of [
      'cat a.txt | head',
      'cat a.txt; echo ok',
      'cat a.txt && echo ok',
      'cat a.txt || true',
      'cat a.txt > b.txt',
      'cat < a.txt',
      'cat a.txt b.txt',
      'cat',
      'cat $HOME/.env',
      'cat ~/.env',
      'cat *.env',
      'cat .e?v',
      'cat %USERPROFILE%\\.env',
      'cat $(pwd)/.env',
      'head -n x a.txt',
      'head -n +5 a.txt',
      'tail -f a.txt',
      'cat -A a.txt',
      'grep -r PASSWORD .',
      'ls -la',
      'node -e "console.log(1)"',
      'Get-Content a.txt | Select-Object -First 3',
      'echo cat a.txt',
      '',
    ]) {
      expect(cmd(c), c).toBeNull();
    }
  });

  it('outros tipos de item e entrada inválida dão null', () => {
    expect(codexToolFile({ type: 'agent_message', text: 'cat a.txt' })).toBeNull();
    expect(codexToolFile({ type: 'mcp_tool_call', server: 's', tool: 't', arguments: { file_path: 'a' } })).toBeNull();
    expect(codexToolFile({ type: 'command_execution' })).toBeNull();
    expect(codexToolFile(null)).toBeNull();
    expect(codexToolFile('cat a.txt')).toBeNull();
  });
});

describe('secretFile: o caminho vira relativo à raiz do projeto, ou nada', () => {
  const inProj = (...p: string[]) => path.join(proj, ...p);

  it('absoluto dentro do projeto e relativo à pasta da conversa viram caminho do projeto, com "/"', () => {
    expect(secretFile(inProj('config', 'app.ini'), proj, proj)).toBe('config/app.ini');
    expect(secretFile('config\\app.ini', proj, proj)).toBe('config/app.ini');
    expect(secretFile('./src/../src/a.ts', proj, proj)).toBe('src/a.ts');
    expect(secretFile('a.ts', inProj('src'), proj)).toBe('src/a.ts');
  });

  it('worktree dentro do projeto: o caminho segue até o arquivo da worktree', () => {
    const wt = inProj('.claude', 'worktrees', 'myco-ana');
    expect(secretFile('src/a.ts', wt, proj)).toBe('.claude/worktrees/myco-ana/src/a.ts');
    expect(secretFile(path.join(wt, 'src', 'a.ts'), wt, proj)).toBe('.claude/worktrees/myco-ana/src/a.ts');
  });

  it('fora do projeto, a própria raiz, ".." e NUL: null', () => {
    expect(secretFile(path.join(root, 'outro', 'a.ts'), proj, proj)).toBeNull();
    expect(secretFile('../outro/a.ts', proj, proj)).toBeNull();
    expect(secretFile(path.join(proj, '..', 'x', 'a.ts'), proj, proj)).toBeNull();
    expect(secretFile(path.join(`${proj}-irmao`, 'a.ts'), proj, proj)).toBeNull();
    expect(secretFile(os.homedir(), proj, proj)).toBeNull();
    expect(secretFile(proj, proj, proj)).toBeNull();
    expect(secretFile('.', proj, proj)).toBeNull();
    expect(secretFile('src/a\0.ts', proj, proj)).toBeNull();
  });

  it('nome com cara de segredo ou comprido demais não vai para a tela', () => {
    expect(secretFile(`config/${SEGREDO}.ini`, proj, proj)).toBeNull();
    expect(secretFile(`${'a/'.repeat(200)}x.ts`, proj, proj)).toBeNull();
  });
});

describe('isBlockedRel: a mesma checagem da leitura de arquivos', () => {
  it('.env, chaves e certificados, pastas de segredo e caminho inválido são bloqueados; o resto abre', () => {
    for (const p of ['.env', 'a/.env.local', 'cert/site.pem', 'keys/id_rsa', 'x/credentials.prod.json', '.vps/conn.json', '.ssh/config', '.git/config', '../fora', '/etc/passwd', 'C:\\x\\a.ts', 'a\0b']) {
      expect(isBlockedRel(p), p).toBe(true);
    }
    for (const p of ['src/a.ts', '.env.example', 'config/.env.sample', 'README.md', 'a\\b.ts']) expect(isBlockedRel(p), p).toBe(false);
  });

  it('readProjectFile e readProjectImageFile recusam exatamente o que ela marca, e a rota segue fechada para o .env', async () => {
    await expect(readProjectFile(proj, '.env')).rejects.toMatchObject({ status: 403 });
    await expect(readProjectImageFile(proj, '.env')).rejects.toBeInstanceOf(ProjectFileError);
    expect(isBlockedRel('.env')).toBe(true);
    await expect(readProjectFile(proj, 'src/a.ts')).resolves.toMatchObject({ path: 'src/a.ts' });
    expect(isBlockedRel('src/a.ts')).toBe(false);
  });
});

describe('Claude: o arquivo vai no aviso de segredo', () => {
  const run = (cwd = proj) => {
    const f = fakeClaude();
    const seen: Seen = [];
    const chat = new ChatProcess({ sessionId: 's-f', cwd, args: [], spawnImpl: f.spawnImpl, onSecret: (l, source, file) => seen.push({ label: l.label, source, file }) });
    chat.start();
    chat.send('oi');
    const tool = (id: string, name: string, input: object) => f.emit({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
    const result = (id: string, content: string, is_error = false) => f.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
    return { seen, tool, result };
  };
  const LABEL = 'senha na variável DB_PASSWORD';

  it('Read: o segredo aparece no resultado, e o arquivo é o da chamada', async () => {
    const { seen, tool, result } = run();
    tool('r1', 'Read', { file_path: path.join(proj, 'config', 'app.ini') });
    result('r1', `1\t[db]\n2\t${SEGREDO}\n`);
    await tick();
    expect(seen).toEqual([{ label: LABEL, source: 'tool-result', file: path.join(proj, 'config', 'app.ini') }]);
  });

  it('Write, Edit, MultiEdit e NotebookEdit: o segredo está na chamada, e o arquivo é o alvo dela', async () => {
    const { seen, tool } = run();
    tool('w1', 'Write', { file_path: 'a/w.ini', content: `${SEGREDO}\n` });
    tool('e1', 'Edit', { file_path: 'a/e.ini', old_string: 'x', new_string: SEGREDO });
    tool('m1', 'MultiEdit', { file_path: 'a/m.ini', edits: [{ old_string: 'x', new_string: SEGREDO }] });
    tool('n1', 'NotebookEdit', { notebook_path: 'a/n.ipynb', new_source: SEGREDO });
    await tick();
    expect(seen.map((s) => [s.source, s.file])).toEqual([
      ['tool-input', 'a/w.ini'],
      ['tool-input', 'a/e.ini'],
      ['tool-input', 'a/m.ini'],
      ['tool-input', 'a/n.ipynb'],
    ]);
  });

  it('o resultado de Write e Edit com o trecho gravado também aponta o arquivo', async () => {
    const { seen, tool, result } = run();
    tool('e2', 'Edit', { file_path: 'a/e.ini', old_string: 'x', new_string: 'y' });
    result('e2', `The file a/e.ini has been updated:\n 2\t${SEGREDO}\n`);
    await tick();
    expect(seen).toEqual([{ label: LABEL, source: 'tool-result', file: 'a/e.ini' }]);
  });

  it('sem arquivo identificável o campo fica ausente: Bash, Grep, mensagem sua, resposta e resultado de chamada que o Club não viu', async () => {
    const { seen, tool, result } = run();
    tool('b1', 'Bash', { command: 'cat .env | head' });
    result('b1', SEGREDO);
    tool('g1', 'Grep', { pattern: 'PASSWORD', path: 'src' });
    result('g1', `src/x.ts:1:${SEGREDO}`);
    result('desconhecido', SEGREDO);
    tool('b2', 'Bash', { command: 'mysql -uroot -pS3nh4Forte app' });
    await tick();
    expect(seen).toHaveLength(4);
    expect(seen.every((s) => s.file === undefined)).toBe(true);
  });

  it('a chamada só vale uma vez: o resultado repetido do mesmo id perde o arquivo', async () => {
    const { seen, tool, result } = run();
    tool('r2', 'Read', { file_path: 'a/r.ini' });
    result('r2', SEGREDO);
    result('r2', SEGREDO);
    await tick();
    expect(seen.map((s) => s.file)).toEqual(['a/r.ini', undefined]);
  });
});

describe('Codex: o arquivo vai no aviso de segredo', () => {
  const profile = { cwd: '/proj', sessionId: 'sess-f', permissionMode: 'default', secrets: { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' } };
  const run = () => {
    const f = fakeCodex();
    const seen: Seen = [];
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onSecret: (l, source, file) => seen.push({ label: l.label, source, file }) });
    chat.start();
    chat.send('rode isso');
    const command = (id: string, c: string, out = `${SEGREDO}\n`) =>
      f.last().emit({ type: 'item.completed', item: { id, type: 'command_execution', command: c, aggregated_output: out, exit_code: 0, status: 'completed' } });
    return { seen, command, emit: (ev: object) => f.last().emit(ev) };
  };

  it('leitura simples de um arquivo: o arquivo do comando', async () => {
    const { seen, command } = run();
    command('i0', 'cat .env');
    command('i1', "/usr/bin/bash -lc 'head -n 5 config/app.ini'");
    command('i2', 'Get-Content -Raw config\\app.ini');
    await tick();
    expect(seen.map((s) => [s.source, s.file])).toEqual([
      ['tool-result', '.env'],
      ['tool-result', 'config/app.ini'],
      ['tool-result', 'config\\app.ini'],
    ]);
  });

  it('comando com pipe, vários arquivos ou outro programa: o campo fica ausente', async () => {
    const { seen, command } = run();
    command('i0', 'cat .env | head -n 3');
    command('i1', 'cat a.ini b.ini');
    command('i2', 'grep -r PASSWORD .');
    command('i3', 'cat a.ini && echo ok');
    await tick();
    expect(seen).toHaveLength(4);
    expect(seen.every((s) => s.file === undefined)).toBe(true);
  });

  it('file_change de um arquivo traz o caminho; de dois, não (o Codex não manda o conteúdo: só um caminho com cara de segredo o dispara)', async () => {
    const { seen, emit } = run();
    const sujo = `a/${SEGREDO}.ini`;
    emit({ type: 'item.completed', item: { id: 'f1', type: 'file_change', status: 'completed', changes: [{ path: sujo, kind: 'update' }] } });
    emit({ type: 'item.completed', item: { id: 'f2', type: 'file_change', status: 'completed', changes: [{ path: sujo, kind: 'update' }, { path: 'b.ini', kind: 'add' }] } });
    await tick();
    expect(seen.map((s) => [s.source, s.file])).toEqual([
      ['tool-input', sujo],
      ['tool-input', undefined],
    ]);
  });
});

describe('ChatManager + caixa: do motor ao item do inbox', () => {
  const place = { projectId: 'p', projectName: 'Projeto', sessionId: 'sx', staffId: 'ana', name: 'Ana' };

  async function setup() {
    const procs: Array<ReturnType<typeof fakeClaude>> = [];
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => ({ sessionId: sid ?? 'sx', cwd: proj, args: ['--permission-mode', 'acceptEdits'] }),
      spawnImpl: (() => {
        const f = fakeClaude();
        f.proc.stdin.on('finish', () => f.proc.emit('exit', 0));
        procs.push(f);
        return f.spawnImpl();
      }) as never,
    });
    await m.send('p', 'sx', 'ana', 'rode');
    const f = procs[0]!;
    const read = async (id: string, file: string, content: string) => {
      f.emit({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } });
      f.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] } });
      await tick();
    };
    return { m, f, read };
  }

  it('o caminho absoluto fica no servidor e o item leva só o relativo; .env marca fileBlocked', async () => {
    const { m, read } = await setup();
    await read('r1', path.join(proj, 'config', 'app.ini'), `[db]\n${SEGREDO}\n`);
    const [hit] = m.secretHits();
    expect(hit).toMatchObject({ sessionId: 'sx', source: 'tool-result', file: path.join(proj, 'config', 'app.ini'), cwd: proj });

    const item = secretInboxItem(hit!, place, proj);
    expect(item).toMatchObject({ kind: 'secret', secret: { kind: 'password-env', detail: 'DB_PASSWORD', source: 'tool-result', file: 'config/app.ini' } });
    expect(item.secret).not.toHaveProperty('fileBlocked');
    const json = JSON.stringify(item);
    expect(json).not.toContain(VALOR);
    expect(json).not.toContain(proj);
    expect(json).not.toContain(root);
    expect(json).not.toContain(os.userInfo().username);

    const env = secretInboxItem({ ...hit!, file: path.join(proj, '.env') }, place, proj);
    expect(env.secret).toMatchObject({ file: '.env', fileBlocked: true });
  });

  it('só o primeiro arquivo aparece por conversa e tipo (a deduplicação segue a mesma)', async () => {
    const { m, read } = await setup();
    await read('r1', path.join(proj, '.env'), SEGREDO);
    await read('r2', path.join(proj, 'src', 'a.ts'), SEGREDO);
    const hits = m.secretHits();
    expect(hits).toHaveLength(1);
    expect(secretInboxItem(hits[0]!, place, proj).secret).toMatchObject({ file: '.env', fileBlocked: true });
  });

  it('arquivo fora do projeto, projeto desconhecido ou sem arquivo: o item sai sem `file` nem `fileBlocked`', async () => {
    const { m, f, read } = await setup();
    await read('r1', path.join(root, 'fora', 'a.ini'), SEGREDO);
    const [hit] = m.secretHits();
    const sem = (it: ReturnType<typeof secretInboxItem>) => {
      expect(it.secret).toEqual({ kind: 'password-env', detail: 'DB_PASSWORD', source: 'tool-result', verdict: 'unknown', reason: 'no-context', hint: { length: VALOR.length } });
      expect(it.secret).not.toHaveProperty('file');
      expect(it.secret).not.toHaveProperty('fileBlocked');
    };
    sem(secretInboxItem(hit!, place, proj));
    sem(secretInboxItem({ ...hit!, file: path.join(proj, 'src', 'a.ts') }, place, null));
    const { file: _file, cwd: _cwd, ...semArquivo } = { ...hit!, file: 'x', cwd: proj };
    sem(secretInboxItem(semArquivo as SecretHit, place, proj));

    // Comando de shell no Claude: nem chega com arquivo.
    f.emit({ type: 'assistant', message: { id: 'mb', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'mysql -uroot -pS3nh4Forte app' } }] } });
    await tick();
    const bash = m.secretHits().find((s) => s.label.startsWith('senha no comando'))!;
    expect(bash).not.toHaveProperty('file');
    expect(secretInboxItem(bash, place, proj).secret).toEqual({ kind: 'password-cli', detail: 'mysql', source: 'tool-input', verdict: 'unknown', reason: 'no-context', hint: { length: 'S3nh4Forte'.length } });
  });
});
