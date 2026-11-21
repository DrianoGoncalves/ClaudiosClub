import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatManager, type ChatSpawn } from '../server/chat/manager';
import { claudeToolCommand, codexToolCommand } from '../server/chat/codeEdits';
import { scanSecrets } from '../server/chat/secrets';
import { commandFiles, locateSecretFile } from '../server/chat/secretOrigin';
import { secretInboxItem } from '../server/inboxItems';
import { removeTemp } from './support/tmp';

// Origem do alerta de segredo que veio da SAÍDA de um comando (t-e45afe, caso real de 19/11: `Get-Content DEPLOY.md ...; Get-Content .gitignore ...` e a
// senha em DEPLOY.md, linha 20, sem `secret.file`): o servidor lê os arquivos que o comando leu e acha o que tem o segredo, nos dois motores.
// O valor abaixo é fictício: só precisa casar com o filtro de segredos.
const VALOR = 'S3nh4Forte1';
const SEGREDO = `DB_PASSWORD=${VALOR}`;
const PEPPER = 'a'.repeat(32);

let root: string;
let proj: string;
let outside: string;

const lines = (n: number, at: number, text: string) => Array.from({ length: n }, (_, i) => (i + 1 === at ? text : `linha ${i + 1} sem nada`)).join('\n');

async function symlinkWorks(): Promise<boolean> {
  const target = path.join(os.tmpdir(), `myco-so-probe-${process.pid}.txt`);
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-secretorigin-'));
  proj = path.join(root, 'proj');
  outside = path.join(root, 'fora');
  await fs.mkdir(path.join(proj, 'src'), { recursive: true });
  await fs.mkdir(path.join(proj, 'notas'));
  await fs.mkdir(path.join(proj, '.ssh'));
  await fs.mkdir(outside);
  await fs.writeFile(path.join(proj, 'DEPLOY.md'), lines(30, 20, `    ${SEGREDO}`) + '\n');
  await fs.writeFile(path.join(proj, '.gitignore'), 'node_modules\n.env\ndist\n');
  await fs.writeFile(path.join(proj, 'README.md'), '# Projeto\nnada aqui\n');
  await fs.writeFile(path.join(proj, 'copia.md'), `# Cópia\n${SEGREDO}\n`);
  await fs.writeFile(path.join(proj, '.env'), `APP=1\r\n${SEGREDO}\r\n`);
  await fs.writeFile(path.join(proj, 'src', 'config.ini'), `[db]\n${SEGREDO}\n`);
  await fs.writeFile(path.join(proj, 'docker.md'), `${SEGREDO}\n`);
  await fs.writeFile(path.join(proj, '.ssh', 'config'), `${SEGREDO}\n`);
  await fs.writeFile(path.join(proj, 'outro-valor.md'), 'DB_PASSWORD=OutraSenha99\n');
  await fs.writeFile(path.join(proj, 'grande.md'), `${SEGREDO}\n${'x'.repeat(1024 * 1024 + 10)}`);
  await fs.writeFile(path.join(proj, 'binario.dat'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`${SEGREDO}\n`)]));
  await fs.writeFile(path.join(outside, 'fora.md'), `${SEGREDO}\n`);
});
afterAll(() => removeTemp(root));

const at = (...p: string[]) => path.join(proj, ...p);
const occurrenceOf = (text: string) => {
  const [hit] = scanSecrets(text, { pepper: PEPPER });
  return { occurrence: hit!.occurrence, kind: hit!.kind };
};
const locate = (command: string, over: Partial<Parameters<typeof locateSecretFile>[0]> = {}, text = SEGREDO) =>
  locateSecretFile({ command, cwd: proj, projectDir: proj, pepper: PEPPER, ...occurrenceOf(text), ...over });

describe('commandFiles: os caminhos que o comando lê (só candidatos)', () => {
  const files = (command: string, cwd = proj) => commandFiles(command, cwd);

  it('o caso real: dois Get-Content no mesmo comando, com as opções de quantidade', () => {
    expect(files('Get-Content DEPLOY.md -TotalCount 80; Get-Content .gitignore -TotalCount 40')).toEqual([at('DEPLOY.md'), at('.gitignore')]);
  });

  it('com o invólucro do PowerShell (Codex no Windows) e do bash, aspas e caminho com espaço', () => {
    expect(files('"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "Get-Content DEPLOY.md; Get-Content \'meu doc.md\'"')).toEqual([at('DEPLOY.md'), at('meu doc.md')]);
    expect(files('pwsh -c "gc a.md | Select-String x"')).toContain(at('a.md'));
    expect(files("bash -lc 'cat a.md && cat b.md'")).toEqual([at('a.md'), at('b.md')]);
    expect(files('cmd /c type a.md & type b.md')).toEqual([at('a.md'), at('b.md')]);
  });

  it('vários arquivos num comando só: lista com espaço, vírgula (PowerShell), -Path/-LiteralPath e entrada por `<`', () => {
    expect(files('cat a.md b.md')).toEqual([at('a.md'), at('b.md')]);
    expect(files('Get-Content a.md, b.md')).toEqual([at('a.md'), at('b.md')]);
    expect(files('Get-Content -Path a.md -TotalCount 5')).toEqual([at('a.md')]);
    expect(files('Get-Content -LiteralPath a.md')).toEqual([at('a.md')]);
    expect(files('head -n 20 a.md; tail -5 b.md')).toEqual([at('a.md'), at('b.md')]);
    expect(files('type a.md')).toEqual([at('a.md')]);
  });

  it('absoluto e relativo à pasta da conversa; cd muda a base dos seguintes; repetido sai uma vez', () => {
    expect(files(`cat "${at('x.md')}"`)).toEqual([at('x.md')]);
    expect(files('cd src && cat config.ini; cat ../README.md')).toEqual([at('src', 'config.ini'), at('README.md')]);
    expect(files('Set-Location notas; Get-Content a.md')).toEqual([at('notas', 'a.md')]);
    expect(files('cat a.md; cat a.md; cat ./a.md')).toEqual([at('a.md')]);
    expect(files('cat a.md', at('src'))).toEqual([at('src', 'a.md')]);
  });

  it('só comando que lê arquivo conta: o resto não dá candidato', () => {
    for (const c of ['ls -la', 'node -e "console.log(1)"', 'npm test', 'echo cat a.md', 'python ler.py a.md', 'Get-ChildItem', 'git status', '']) {
      expect(files(c), c).toEqual([]);
    }
  });

  it('o que não é caminho literal não vira candidato: variável, curinga, subcomando, `~`, %VAR%; nem o alvo de um redirecionamento', () => {
    for (const c of ['cat $HOME/.env', 'cat ~/.env', 'cat *.env', 'cat .e?v', 'cat %USERPROFILE%\\.env', 'cat $(pwd)/.env', 'cat `pwd`/.env', 'cat "$X"']) {
      expect(files(c), c).toEqual([]);
    }
    expect(files('cat a.md > saida.md')).toEqual([at('a.md')]);
    expect(files('cat a.md >> saida.md 2>&1')).toEqual([at('a.md')]);
    expect(files('cat a.md 2> erro.txt')).toEqual([at('a.md')]);
  });

  it('comando que fala com outra máquina não dá candidato nenhum, mesmo que outra parte dele leia um arquivo daqui', () => {
    for (const c of [
      'ssh host cat .env',
      'ssh host "cat /var/www/.env"; cat README.md',
      'cat README.md; scp host:.env .',
      'rsync -av host:/x . && cat README.md',
      'curl https://x/y | cat',
      'sshpass -p x ssh h cat .env',
      'docker exec app cat .env; cat README.md',
      'kubectl exec pod -- cat .env',
      'Invoke-Command -ComputerName h { Get-Content .env }',
      'plink host cat x',
      'bash -lc \'ssh h "cat a"\'',
    ]) {
      expect(files(c), c).toEqual([]);
    }
  });

  it('nome com cara de comando remoto no caminho não bloqueia: `.ssh/config`, `docker.md`, `ssh.exe` só como programa', () => {
    expect(files('cat .ssh/config')).toEqual([at('.ssh', 'config')]);
    expect(files('cat docker.md')).toEqual([at('docker.md')]);
    expect(files('cat docker-compose.yml')).toEqual([at('docker-compose.yml')]);
    expect(files('cat keys/ssh.txt')).toEqual([at('keys', 'ssh.txt')]);
    expect(files('ssh.exe host; cat a.md')).toEqual([]);
  });

  it('teto de candidatos, comando comprido e entrada inválida', () => {
    const many = Array.from({ length: 40 }, (_, i) => `f${i}.md`).join(' ');
    expect(files(`cat ${many}`)).toHaveLength(12);
    expect(files(`cat a.md ${'x'.repeat(9_000)}`)).toEqual([]);
    expect(files('cat "aberta.md')).toEqual([at('aberta.md')]);
    expect(files('cat a\0.md')).toEqual([]);
  });
});

describe('claudeToolCommand e codexToolCommand: o comando que a ferramenta rodou', () => {
  it('Claude: Bash e PowerShell; nas outras ferramentas e sem texto, null', () => {
    expect(claudeToolCommand('Bash', { command: 'cat a.md' })).toBe('cat a.md');
    expect(claudeToolCommand('PowerShell', { command: 'Get-Content a.md' })).toBe('Get-Content a.md');
    for (const [tool, input] of [['Read', { command: 'x' }], ['Grep', { command: 'x' }], ['Bash', {}], ['Bash', { command: '  ' }], ['Bash', { command: 3 }], ['Bash', null]] as const) {
      expect(claudeToolCommand(tool, input), `${tool} ${JSON.stringify(input)}`).toBeNull();
    }
  });

  it('Codex: o comando sem o invólucro bash -lc; item de outro tipo ou sem comando, null', () => {
    expect(codexToolCommand({ type: 'command_execution', command: "/usr/bin/bash -lc 'cat a.md; cat b.md'" })).toBe('cat a.md; cat b.md');
    expect(codexToolCommand({ type: 'command_execution', command: 'Get-Content a.md; Get-Content b.md' })).toBe('Get-Content a.md; Get-Content b.md');
    for (const raw of [{ type: 'agent_message', command: 'cat a' }, { type: 'command_execution' }, { type: 'command_execution', command: ' ' }, null, 'cat a']) {
      expect(codexToolCommand(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe('locateSecretFile: qual dos arquivos lidos tem o segredo da saída', () => {
  it('o caso real: dois arquivos no comando, o segredo em um só → o arquivo e a linha dele', async () => {
    expect(await locate('Get-Content DEPLOY.md -TotalCount 80; Get-Content .gitignore -TotalCount 40')).toEqual({ file: 'DEPLOY.md', line: 20 });
    expect(await locate('Get-Content .gitignore; Get-Content DEPLOY.md')).toEqual({ file: 'DEPLOY.md', line: 20 });
    expect(await locate('cat README.md DEPLOY.md .gitignore')).toEqual({ file: 'DEPLOY.md', line: 20 });
  });

  it('arquivo de segredo (.env) e arquivo com CRLF: o caminho e a linha certos', async () => {
    expect(await locate('cat .gitignore; cat .env')).toEqual({ file: '.env', line: 2 });
    expect(await locate('cd src; cat config.ini')).toEqual({ file: 'src/config.ini', line: 2 });
  });

  it('nenhum arquivo lido tem o segredo → sem arquivo', async () => {
    expect(await locate('cat README.md; cat .gitignore')).toBeNull();
  });

  it('o arquivo tem outro valor da mesma variável: é outro segredo, não é ele', async () => {
    expect(await locate('cat outro-valor.md')).toBeNull();
    expect(await locate('cat outro-valor.md DEPLOY.md')).toEqual({ file: 'DEPLOY.md', line: 20 });
  });

  it('mais de um arquivo com o mesmo segredo → sem arquivo (não escolhe)', async () => {
    expect(await locate('cat DEPLOY.md; cat copia.md')).toBeNull();
    expect(await locate('cat DEPLOY.md copia.md .env')).toBeNull();
    // O mesmo arquivo escrito de dois jeitos não é "mais de um".
    expect(await locate('cat DEPLOY.md; cat ./DEPLOY.md; cat notas/../DEPLOY.md')).toEqual({ file: 'DEPLOY.md', line: 20 });
  });

  it('fora do projeto não vira arquivo, nem abre: caminho absoluto, `..` e pasta irmã', async () => {
    expect(await locate(`cat "${path.join(outside, 'fora.md')}"`)).toBeNull();
    expect(await locate('cat ../fora/fora.md')).toBeNull();
    expect(await locate(`cat "${path.join(outside, 'fora.md')}"; cat README.md`)).toBeNull();
    // Dentro e fora com o mesmo segredo: só o de dentro conta.
    expect(await locate(`cat "${path.join(outside, 'fora.md')}"; cat DEPLOY.md`)).toEqual({ file: 'DEPLOY.md', line: 20 });
  });

  it.runIf(canLink)('link que sai do projeto: sem arquivo; link para dentro: o arquivo de verdade', async () => {
    await fs.symlink(path.join(outside, 'fora.md'), at('atalho-fora.md'), 'file');
    await fs.symlink(outside, at('junction-fora'), 'junction');
    await fs.symlink(at('DEPLOY.md'), at('atalho-deploy.md'), 'file');
    expect(await locate('cat atalho-fora.md')).toBeNull();
    expect(await locate('cat junction-fora/fora.md')).toBeNull();
    expect(await locate('cat atalho-deploy.md')).toEqual({ file: 'DEPLOY.md', line: 20 });
  });

  it('pasta, inexistente, binário e arquivo maior que 1 MB não valem', async () => {
    expect(await locate('cat notas')).toBeNull();
    expect(await locate('cat nao-existe.md')).toBeNull();
    expect(await locate('cat binario.dat')).toBeNull();
    expect(await locate('cat grande.md')).toBeNull();
    expect(await locate('cat grande.md DEPLOY.md')).toEqual({ file: 'DEPLOY.md', line: 20 });
  });

  it('comando para outra máquina: sem arquivo, mesmo que o arquivo local tenha o mesmo segredo', async () => {
    expect(await locate('ssh host "cat DEPLOY.md"; cat DEPLOY.md')).toBeNull();
    expect(await locate('docker exec app cat DEPLOY.md')).toBeNull();
    // O nome `.ssh/config` não é comando remoto: um arquivo local com esse nome vale.
    expect(await locate('cat .ssh/config')).toEqual({ file: '.ssh/config', line: 1 });
  });

  it('chave privada (várias linhas): acha o arquivo, sem a linha', async () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxample0123456789abcdefghijklmnopqrstuvwxyz\nQRSTUVWXYZ\n-----END RSA PRIVATE KEY-----\n';
    await fs.writeFile(at('chave.txt'), `# nota\n${key}`);
    await fs.writeFile(at('outra-chave.txt'), key.replace('MIIEow', 'MIIEzz'));
    expect(await locate('cat chave.txt; cat README.md', {}, key)).toEqual({ file: 'chave.txt' });
    expect(await locate('cat outra-chave.txt; cat README.md', {}, key)).toBeNull();
  });

  it('o sal é parte da identidade: com outro sal nada casa', async () => {
    expect(await locate('cat DEPLOY.md', { pepper: 'b'.repeat(32) })).toBeNull();
  });

  it('nunca lança e o resultado não traz o valor nem o caminho absoluto', async () => {
    expect(await locate('cat DEPLOY.md', { projectDir: path.join(root, 'nao-existe') })).toBeNull();
    expect(await locate('cat DEPLOY.md', { command: '' })).toBeNull();
    const found = await locate('cat DEPLOY.md');
    const json = JSON.stringify(found);
    expect(json).not.toContain(VALOR);
    expect(json).not.toContain(root);
  });
});

// ---- do motor ao item da caixa, nos dois motores ----

const tick = () => new Promise((r) => setTimeout(r, 15));
const place = { projectId: 'p', projectName: 'Projeto', sessionId: 'sx', staffId: 'rogerio', name: 'Rogério' };

/** A saída do comando do caso real: o conteúdo dos dois arquivos, um depois do outro. */
const outputOf = async (...rels: string[]) => (await Promise.all(rels.map((r) => fs.readFile(at(r), 'utf8')))).join('\n---\n');

interface Rig {
  m: ChatManager;
  /** O motor roda o comando (que leu `command`) e devolve esta saída. */
  run: (command: string, output: string) => Promise<void>;
}

type ProjectDirOf = NonNullable<ConstructorParameters<typeof ChatManager>[0]['projectDirOf']> | undefined;

async function claudeRig(projectDirOf: ProjectDirOf): Promise<Rig> {
  const procs: Array<{ emit: (ev: object) => void }> = [];
  const spawnImpl = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4242, kill: () => proc.emit('exit', 0) });
    stdin.on('finish', () => proc.emit('exit', 0));
    procs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n') });
    return proc as never;
  };
  const m = new ChatManager({
    transcriptsDir: root,
    usageFile: path.join(root, 'usage-claude.json'),
    listLive: async () => [],
    resolve: async (_p, sid) => ({ sessionId: sid ?? 'sx', cwd: proj, args: ['--permission-mode', 'acceptEdits'] }),
    spawnImpl: spawnImpl as never,
    projectDirOf,
  });
  await m.send('p', 'sx', 'rogerio', 'rode');
  let n = 0;
  return {
    m,
    run: async (command, output) => {
      const id = `tu${++n}`;
      const f = procs[0]!;
      f.emit({ type: 'assistant', message: { id: `m${n}`, content: [{ type: 'tool_use', id, name: n % 2 ? 'PowerShell' : 'Bash', input: { command } }] } });
      f.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: false }] } });
      await tick();
    },
  };
}

async function codexRig(projectDirOf: ProjectDirOf): Promise<Rig> {
  const runs: Array<{ emit: (ev: object) => void }> = [];
  const spawnImpl = () => {
    const stdout = new PassThrough();
    runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n') });
    return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 4343 }) as never;
  };
  const spawn: ChatSpawn = {
    sessionId: 'sx',
    cwd: proj,
    args: [],
    engine: 'codex',
    codex: {
      autonomy: 'acceptEdits',
      model: null,
      effort: null,
      instructions: '',
      writableRoots: [],
      readOnlyPaths: [],
      agents: [],
      secrets: { projectPath: proj, home: path.join(root, 'home'), mycoHome: path.join(root, 'home', '.myco') },
      threadId: null,
      mycoUrl: 'http://127.0.0.2:1',
      threadFile: path.join(root, 'codex-thread.json'),
    },
  };
  const m = new ChatManager({
    transcriptsDir: root,
    usageFile: path.join(root, 'usage-codex.json'),
    listLive: async () => [],
    resolve: async () => spawn,
    spawnImpl: spawnImpl as never,
    projectDirOf,
  });
  await m.send('p', 'sx', 'rogerio', 'rode');
  await tick();
  let n = 0;
  return {
    m,
    run: async (command, output) => {
      const id = `item_${++n}`;
      const f = runs[runs.length - 1]!;
      // O Codex mostra o comando com o invólucro do shell: o servidor tira antes de ler.
      f.emit({ type: 'item.completed', item: { id, type: 'command_execution', command: n % 2 ? `/usr/bin/bash -lc '${command}'` : command, aggregated_output: output, exit_code: 0, status: 'completed' } });
      await tick();
    },
  };
}

describe.each([
  ['Claude', claudeRig],
  ['Codex', codexRig],
] as const)('%s: o arquivo do segredo da saída do comando chega ao item da caixa', (_name, rig) => {
  const settle = async (m: ChatManager) => {
    await vi.waitFor(() => expect(m.secretHits().length).toBeGreaterThan(0));
    await tick();
    await tick();
  };

  it('o caso real: o comando lê DEPLOY.md e .gitignore, o segredo está em DEPLOY.md (linha 20) → file e line, sem o valor', async () => {
    const { m, run } = await rig(async () => proj);
    await run('Get-Content DEPLOY.md -TotalCount 80; Get-Content .gitignore -TotalCount 40', await outputOf('DEPLOY.md', '.gitignore'));
    await settle(m);
    const [hit] = m.secretHits();
    expect(hit).toMatchObject({ source: 'tool-result', file: 'DEPLOY.md', line: 20, cwd: proj });
    const item = secretInboxItem(hit!, place, proj);
    expect(item).toMatchObject({ kind: 'secret', secret: { kind: 'password-env', detail: 'DB_PASSWORD', source: 'tool-result', file: 'DEPLOY.md', line: 20 } });
    expect(item.secret).not.toHaveProperty('fileBlocked');
    const json = JSON.stringify(item);
    for (const leak of [VALOR, proj, root, os.userInfo().username]) expect(json).not.toContain(leak);
  });

  it('o segredo está em um arquivo de segredo (.env): o item leva file, line e fileBlocked', async () => {
    const { m, run } = await rig(async () => proj);
    await run('cat .gitignore; cat .env', await outputOf('.gitignore', '.env'));
    await settle(m);
    expect(secretInboxItem(m.secretHits()[0]!, place, proj).secret).toMatchObject({ file: '.env', line: 2, fileBlocked: true });
  });

  it('nenhum dos arquivos lidos tem o segredo (a saída veio de outro lugar): sem arquivo', async () => {
    const { m, run } = await rig(async () => proj);
    await run('Get-Content README.md; Get-Content .gitignore', `# Projeto\n${SEGREDO}\n`);
    await settle(m);
    const [hit] = m.secretHits();
    expect(hit).not.toHaveProperty('file');
    const item = secretInboxItem(hit!, place, proj);
    expect(item.secret).not.toHaveProperty('file');
    expect(item.secret).not.toHaveProperty('line');
  });

  it('mais de um arquivo com o segredo, sem decisão clara: sem arquivo', async () => {
    const { m, run } = await rig(async () => proj);
    await run('Get-Content DEPLOY.md; Get-Content copia.md', await outputOf('DEPLOY.md', 'copia.md'));
    await settle(m);
    expect(m.secretHits()[0]).not.toHaveProperty('file');
  });

  it('o arquivo fica fora do projeto: sem arquivo', async () => {
    const { m, run } = await rig(async () => proj);
    await run(`Get-Content "${path.join(outside, 'fora.md')}"; Get-Content README.md`, `${SEGREDO}\n`);
    await settle(m);
    const [hit] = m.secretHits();
    expect(hit).not.toHaveProperty('file');
    expect(JSON.stringify(secretInboxItem(hit!, place, proj))).not.toContain('fora.md');
  });

  it('comando para o servidor do projeto (ssh): a saída não vira arquivo local', async () => {
    const { m, run } = await rig(async () => proj);
    await run('ssh deploy@host "cat /var/www/DEPLOY.md"; Get-Content DEPLOY.md', await outputOf('DEPLOY.md'));
    await settle(m);
    expect(m.secretHits()[0]).not.toHaveProperty('file');
  });

  it('sem a pasta do projeto (projeto desconhecido ou sem a opção): o aviso segue sem arquivo, sem erro', async () => {
    for (const projectDirOf of [async () => null, undefined]) {
      const { m, run } = await rig(projectDirOf);
      await run('Get-Content DEPLOY.md; Get-Content .gitignore', await outputOf('DEPLOY.md', '.gitignore'));
      await settle(m);
      expect(m.secretHits()[0]).not.toHaveProperty('file');
    }
  });

  it('leitura de um arquivo só: o arquivo dela (no Codex já vinha do comando; no Claude, de Bash e PowerShell, passa a vir do disco)', async () => {
    const { m, run } = await rig(async () => proj);
    await run('cat src/config.ini', await outputOf('src/config.ini'));
    await settle(m);
    expect(secretInboxItem(m.secretHits()[0]!, place, proj).secret).toMatchObject({ file: 'src/config.ini' });
  });
});
