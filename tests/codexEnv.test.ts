import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodexRun, CodexRunner } from '../server/adapters/codex';
import { CODEX_ENV_TTL, CODEX_MIN_VERSION, CodexEnv, codexUpgradeHint, compareVersions, locateCodex, parseCodexFeatures, parseCodexVersion, resolveCodexCommand, withAppAddress, type CodexEnvStatus } from '../server/codexEnv';

// Conferência do Codex instalado: versão mínima (0.156.1) e o recurso `network_proxy`, de que a rede local depende.

/** Recorte do `codex features list` do 0.167.0: `nome  estágio  true|false`; o estágio pode ter duas palavras. */
const FEATURES = `apps                                     stable             true
code_mode                                under development  false
network_proxy                            experimental       false
search_tool                              removed            false
`;

function fake(version: string, features: string, over: { features?: Partial<CodexRun>; version?: Partial<CodexRun> } = {}, paths: string[] = ['/usr/bin/codex']) {
  const calls: string[][] = [];
  const run: CodexRunner = async (args) => {
    calls.push(args);
    if (args[0] === '--version') return { code: 0, stdout: version, stderr: '', ...over.version };
    return { code: 0, stdout: features, stderr: '', ...over.features };
  };
  let now = 1_000_000;
  const env = new CodexEnv(run, { now: () => now, locate: async () => paths });
  return { env, calls, advance: (ms: number) => void (now += ms) };
}

describe('codexEnv: versão e recurso network_proxy', () => {
  it('lê a versão e compara número a número (0.156.1 é o mínimo)', () => {
    expect(parseCodexVersion('codex-cli 0.167.0\n')).toEqual([0, 167, 0]);
    expect(parseCodexVersion('codex 1.2.3-beta.4')).toEqual([1, 2, 3]);
    expect(parseCodexVersion('sem número')).toBeNull();
    expect(CODEX_MIN_VERSION).toBe('0.156.1');
    const min = parseCodexVersion(CODEX_MIN_VERSION)!;
    expect(compareVersions([0, 156, 1], min)).toBe(0);
    expect(compareVersions([0, 156, 0], min)).toBeLessThan(0);
    expect(compareVersions([0, 99, 99], min)).toBeLessThan(0);
    expect(compareVersions([0, 167, 0], min)).toBeGreaterThan(0);
    expect(compareVersions([1, 0, 0], min)).toBeGreaterThan(0);
    expect(compareVersions([0, 156, 10], [0, 156, 9])).toBeGreaterThan(0); // 10 > 9, não texto
  });

  it('lê as linhas do features list (estágio de uma ou duas palavras) e ignora o que não é linha', () => {
    const f = parseCodexFeatures(`${FEATURES}\nlinha solta\n`);
    expect(f.get('network_proxy')).toBe('experimental');
    expect(f.get('code_mode')).toBe('under development');
    expect(f.get('search_tool')).toBe('removed');
    expect(f.get('apps')).toBe('stable');
    expect(f.has('linha')).toBe(false);
  });

  it('como atualizar: mise upgrade codex se o binário está numa pasta do mise (direto, pelo shim ou depois do link), senão codex update', () => {
    expect(codexUpgradeHint(['/home/x/.local/share/mise/installs/codex/latest/bin/codex'])).toBe('mise upgrade codex');
    expect(codexUpgradeHint(['/home/x/.local/share/mise/shims/codex', '/opt/algo/codex'])).toBe('mise upgrade codex');
    expect(codexUpgradeHint(['/usr/local/bin/codex', '/home/x/.local/share/mise/installs/codex/0.150.0/bin/codex'])).toBe('mise upgrade codex'); // o real está no mise
    expect(codexUpgradeHint(['C:\\Users\\x\\AppData\\Local\\mise\\installs\\codex\\0.150.0\\codex.cmd'])).toBe('mise upgrade codex');
    expect(codexUpgradeHint(['/usr/local/bin/codex'])).toBe('codex update');
    expect(codexUpgradeHint(['/home/x/promise/bin/codex'])).toBe('codex update'); // "mise" só como pasta inteira
    expect(codexUpgradeHint([])).toBe('codex update');
    expect(codexUpgradeHint([null])).toBe('codex update');
  });

  it('acha o codex no PATH e o caminho real depois dos links; sem ele, lista vazia', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-locate-'));
    const real = path.join(dir, 'mise', 'installs', 'codex', 'latest', 'bin');
    const bin = path.join(dir, 'bin');
    await fs.mkdir(real, { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(real, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    await fs.symlink(path.join(real, 'codex'), path.join(bin, 'codex'));
    const found = await locateCodex({ PATH: [path.join(dir, 'vazia'), bin].join(path.delimiter) }, 'linux');
    expect(found).toEqual([path.join(bin, 'codex'), path.join(real, 'codex')]);
    expect(codexUpgradeHint(found)).toBe('mise upgrade codex');
    expect(await locateCodex({ PATH: path.join(dir, 'vazia') }, 'linux')).toEqual([]);
    expect(await locateCodex({}, 'linux')).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('Codex serve e tem o network_proxy (experimental ou stable): rede local liberada, sem aviso', async () => {
    const { env } = fake('codex-cli 0.167.0\n', FEATURES);
    expect(await env.status()).toEqual({ error: null, version: '0.167.0', networkProxy: true, notice: null });
    const stable = fake('codex-cli 0.200.0', FEATURES.replace('network_proxy                            experimental', 'network_proxy                            stable      '));
    expect((await stable.env.status()).networkProxy).toBe(true);
    // No mínimo exato também serve.
    expect((await fake('codex-cli 0.156.1', FEATURES).env.status()).error).toBeNull();
  });

  it('sem o network_proxy (sumiu, saiu — "removed" —, em desenvolvimento ou o features list falhou): roda sem rede e avisa; nunca libera a rede toda', async () => {
    const sumiu = await fake('codex-cli 0.200.0', FEATURES.replace(/network_proxy.*\n/, '')).env.status();
    expect(sumiu).toMatchObject({ error: null, version: '0.200.0', networkProxy: false });
    expect(sumiu.notice).toMatch(/Este Codex \(0\.200\.0\) não tem o recurso network_proxy.*sem rede nenhuma, nem a local.*curl para a API do Claudio’s Club/);
    const removido = await fake('codex-cli 0.200.0', FEATURES.replace('network_proxy                            experimental', 'network_proxy                            removed     ')).env.status();
    expect(removido.networkProxy).toBe(false);
    expect(removido.notice).toContain('"removed"');
    const dev = await fake('codex-cli 0.200.0', FEATURES.replace('network_proxy                            experimental', 'network_proxy                            under development')).env.status();
    expect(dev.networkProxy).toBe(false);
    for (const features of [{ code: 1 }, { code: null, timedOut: true }, { code: null, spawnError: Object.assign(new Error('x'), { code: 'EACCES' }) as NodeJS.ErrnoException }] as Array<Partial<CodexRun>>) {
      const r = await fake('codex-cli 0.167.0', FEATURES, { features }).env.status();
      expect(r).toMatchObject({ error: null, networkProxy: false });
      expect(r.notice).toContain('não tem o recurso network_proxy (ou não consegui conferir)');
    }
  });

  it('abaixo de 0.156.1: engine codex recusada, com o jeito de atualizar (mise upgrade codex no caminho do mise, senão codex update)', async () => {
    const mise = await fake('codex-cli 0.150.0', FEATURES, {}, ['/home/x/.local/share/mise/installs/codex/latest/bin/codex']).env.status();
    expect(mise.error).toBe('O Codex 0.150.0 é antigo demais para rodar funcionários no Claudio’s Club (o mínimo é 0.156.1). Atualize com: mise upgrade codex');
    expect(mise.networkProxy).toBe(false);
    const npm = await fake('codex-cli 0.156.0', FEATURES, {}, ['/usr/local/bin/codex']).env.status();
    expect(npm.error).toBe('O Codex 0.156.0 é antigo demais para rodar funcionários no Claudio’s Club (o mínimo é 0.156.1). Atualize com: codex update');
  });

  it('codex ausente, versão ilegível, comando que falha ou demora: erro claro (falha fechada), nunca lança', async () => {
    const enoent = Object.assign(new Error('x'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
    expect((await fake('', '', { version: { code: null, spawnError: enoent } }).env.status()).error).toBe('o Codex CLI não está instalado: ligue o Codex nas Configurações do Claudio’s Club');
    expect((await fake('', '', { version: { code: null, spawnError: Object.assign(new Error('sem permissão'), { code: 'EACCES' }) as NodeJS.ErrnoException } }).env.status()).error).toBe('não consegui rodar o codex: sem permissão');
    expect((await fake('codex', FEATURES).env.status()).error).toMatch(/não reconheci a versão do Codex/);
    expect((await fake('', '', { version: { code: 2 } }).env.status()).error).toBe('não consegui conferir a versão do Codex (saída 2)');
    expect((await fake('', '', { version: { code: null, timedOut: true } }).env.status()).error).toBe('não consegui conferir a versão do Codex (demorou demais)');
  });

  it('cache: o que deu certo vale por 5 minutos (uma conferência por versão e por features); erro não fica guardado', async () => {
    const f = fake('codex-cli 0.167.0', FEATURES);
    await f.env.status();
    await f.env.status();
    expect(f.calls).toEqual([['--version'], ['features', 'list']]);
    f.advance(CODEX_ENV_TTL - 1);
    await f.env.status();
    expect(f.calls).toHaveLength(2);
    f.advance(2);
    await f.env.status();
    expect(f.calls).toHaveLength(4); // passou do prazo
    await f.env.status(true);
    expect(f.calls).toHaveLength(6); // `fresh` ignora o guardado
    // Codex antigo: o usuário atualiza e a próxima conversa já confere de novo (o erro não ficou guardado).
    let version = 'codex-cli 0.150.0';
    const calls: string[][] = [];
    const env = new CodexEnv(async (args) => (calls.push(args), { code: 0, stdout: args[0] === '--version' ? version : FEATURES, stderr: '' }), { locate: async () => ['/usr/local/bin/codex'] });
    expect((await env.status()).error).toMatch(/antigo demais/);
    version = 'codex-cli 0.167.0';
    expect((await env.status()).error).toBeNull();
  });

  it('o servidor usa a conferência: o catálogo e a conversa recusam com Codex que não serve; a rede vem do network_proxy', async () => {
    const index = await fs.readFile(path.join(process.cwd(), 'server', 'index.ts'), 'utf8');
    expect(index).toContain('const codexEnv = new CodexEnv();');
    // StaffService (recusa ao abrir) e ChatManager (cada execução): os dois pela conferência que também olha o 127.0.0.2 de pé.
    expect(index.match(/codexEnv: \(\) => codexRunEnv\(\)/g)).toHaveLength(2);
    expect(index).toContain('withAppAddress(await codexEnv.status(), sandboxListener');
  });
});

describe('codexEnv: o endereço do Claudio’s Club para o Codex (127.0.0.2)', () => {
  const ok: CodexEnvStatus = { error: null, version: '0.167.0', networkProxy: true, notice: null };

  it('com o 127.0.0.2 de pé, a conferência passa como veio', () => {
    expect(withAppAddress(ok, { up: true, error: null }, '127.0.0.2:4848')).toBe(ok);
  });

  it('sem ele (macOS sem o alias), a conversa roda sem rede e o aviso diz o endereço, o motivo e o que fazer', () => {
    const r = withAppAddress(ok, { up: false, error: 'EADDRNOTAVAIL' }, '127.0.0.2:4848');
    expect(r).toMatchObject({ error: null, version: '0.167.0', networkProxy: false });
    expect(r.notice).toContain('127.0.0.2:4848');
    expect(r.notice).toContain('EADDRNOTAVAIL');
    expect(r.notice).toContain('sem rede nenhuma');
    expect(r.notice).toContain('sudo ifconfig lo0 alias 127.0.0.2 up');
  });

  it('Codex que não serve (erro) ou sem network_proxy já diz tudo: passa como veio', () => {
    const erro: CodexEnvStatus = { error: 'antigo demais', version: '0.150.0', networkProxy: false, notice: null };
    const semProxy: CodexEnvStatus = { error: null, version: '0.167.0', networkProxy: false, notice: 'sem network_proxy' };
    expect(withAppAddress(erro, { up: false, error: null }, '127.0.0.2:1')).toBe(erro);
    expect(withAppAddress(semProxy, { up: false, error: null }, '127.0.0.2:1')).toBe(semProxy);
  });
});

describe('resolveCodexCommand: o codex sem shell (Windows acha o JS do .cmd do npm)', () => {
  // PATH e plataforma passados explicitamente: o resultado é o mesmo no Ubuntu do CI.
  const JS = path.join('node_modules', '@openai', 'codex', 'bin', 'codex.js');
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codexcmd-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  /** Uma pasta de PATH com os arquivos (vazios) pedidos. */
  async function folder(name: string, files: string[] = []) {
    const dir = path.join(root, name);
    for (const f of files) {
      await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await fs.writeFile(path.join(dir, f), '');
    }
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }
  const pathOf = (...dirs: string[]) => ({ PATH: dirs.join(path.delimiter) });

  it('codex.exe na pasta do PATH: abre ele direto', async () => {
    const exe = await folder('exe', ['codex.exe', 'codex.cmd', JS]);
    expect(resolveCodexCommand(pathOf(exe), 'win32')).toEqual({ command: path.join(exe, 'codex.exe'), prefix: [] });
  });

  it('codex.cmd do npm, sem node.exe ao lado: o node que roda o Claudio’s Club, com o codex.js como primeiro argumento', async () => {
    const npm = await folder('npm-sem-node', ['codex.cmd', JS]);
    const empty = await folder('vazia');
    // A pasta vazia antes não atrapalha: a primeira que tem o codex é a que vale.
    expect(resolveCodexCommand(pathOf(empty, npm), 'win32')).toEqual({ command: process.execPath, prefix: [path.join(npm, JS)] });
  });

  it('codex.cmd com node.exe ao lado: usa o node.exe da pasta, como o próprio codex.cmd', async () => {
    const npm = await folder('npm-com-node', ['codex.cmd', JS, 'node.exe']);
    expect(resolveCodexCommand(pathOf(npm), 'win32')).toEqual({ command: path.join(npm, 'node.exe'), prefix: [path.join(npm, JS)] });
  });

  it('nada achado no PATH: cai em codex (o spawn dá ENOENT, como antes)', async () => {
    const vazia = await folder('nada');
    expect(resolveCodexCommand(pathOf(vazia), 'win32')).toEqual({ command: 'codex', prefix: [] });
    expect(resolveCodexCommand({}, 'win32')).toEqual({ command: 'codex', prefix: [] });
  });

  it('fora do Windows: codex, sem prefixo, mesmo com o codex.exe no PATH', async () => {
    const exe = await folder('linux', ['codex.exe', 'codex.cmd', JS]);
    expect(resolveCodexCommand(pathOf(exe), 'linux')).toEqual({ command: 'codex', prefix: [] });
  });
});
