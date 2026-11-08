import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodexRun, CodexRunner } from '../server/adapters/codex';
import { CODEX_ENV_TTL, CODEX_MIN_VERSION, CodexEnv, codexUpgradeHint, compareVersions, locateCodex, parseCodexFeatures, parseCodexVersion } from '../server/codexEnv';

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
    expect((await fake('', '', { version: { code: null, spawnError: enoent } }).env.status()).error).toBe('o Codex CLI não está instalado (npm i -g @openai/codex)');
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
    expect(index.match(/codexEnv: \(\) => codexEnv\.status\(\)/g)).toHaveLength(2); // StaffService (recusa ao abrir) e ChatManager (cada execução)
  });
});
