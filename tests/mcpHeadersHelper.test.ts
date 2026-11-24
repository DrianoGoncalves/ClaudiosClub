import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSecret } from '../server/secretVault';
import { clubEntry, clubSecretId, type ClubEntry } from '../server/staff/mcp';
import { mcpLaunchCommand, parseLauncherEntry, quotedCommand } from '../server/staff/mcpLaunch';
import { removeTemp } from './support/tmp';

// O `headersHelper` que o Club grava no ~/.claude.json para um MCP http/sse com cabeçalho do cofre: o Claude Code (também o de fora do Club) o roda
// por um shell antes de conectar e lê os cabeçalhos do stdout. Aqui: o formato da linha gerada, a ida e volta pelo parser do Club e a execução por
// um shell de verdade (cmd.exe no Windows, sh no resto, como o Claude Code), com espaço e acento no caminho. O Claude Code real (2.1.310, Windows) foi
// conferido à mão contra um servidor HTTP local: mandou o `Authorization` do cofre; não dá para rodá-lo na suíte (precisa do binário e de rede local).

const HDR = 'Bearer tok-do-cofre-HH-987zyx';
let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-hh-'));
});
afterAll(() => removeTemp(root));

const DEF: ClubEntry = { type: 'http', url: 'https://mcp.exemplo.com/mcp', headers: ['Authorization'] };

/** Uma pasta de Club (MYCO_HOME) com a biblioteca e o cofre dentro, com o segredo já cadastrado; o nome da pasta traz espaço e acento. */
async function club(folder: string) {
  const home = path.join(root, folder);
  const clubFile = path.join(home, 'mcps.json');
  const vault = { dir: path.join(home, 'secrets'), platform: 'linux' as const };
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(clubFile, JSON.stringify({ servers: { web: DEF } }));
  await setSecret(clubSecretId('web', 'header', 'Authorization'), HDR, vault);
  return { home, clubFile, vault };
}

describe('headersHelper gravado no ~/.claude.json: o formato', () => {
  it('só tem o tipo, a URL e a linha de comando; cada parte entre aspas duplas, separadas por um espaço; nenhum valor do cofre', async () => {
    const c = await club('formato');
    const launcher = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['--import', 'file:///C:/club/node_modules/tsx/dist/loader.mjs', 'C:\\club\\server\\mcp-launch.ts'] };
    const entry = clubEntry('web', DEF, { clubFile: c.clubFile, vaultDir: c.vault.dir, launcher })!;
    expect(Object.keys(entry).sort()).toEqual(['headersHelper', 'type', 'url']);
    expect(entry).toMatchObject({ type: 'http', url: 'https://mcp.exemplo.com/mcp' });
    expect(entry).not.toHaveProperty('headers');

    const helper = entry.headersHelper as string;
    expect(helper).toMatch(/^"[^"]+"( "[^"]+")*$/);
    expect([...helper.matchAll(/"([^"]*)"/g)].map((m) => m[1])).toEqual([
      launcher.command,
      ...launcher.args,
      '--headers',
      '--server',
      'web',
      '--club',
      c.clubFile,
      '--vault',
      c.vault.dir,
    ]);
    expect(helper).toBe(quotedCommand([launcher.command, ...launcher.args, '--headers', '--server', 'web', '--club', c.clubFile, '--vault', c.vault.dir]));
    expect(JSON.stringify(entry)).not.toContain(HDR);
    expect(JSON.stringify(entry)).not.toContain('tok-do-cofre');
  });

  it('sse também; sem cabeçalho, nada de lançador (só tipo e URL); stdio vai por command e args, sem headersHelper', async () => {
    const c = await club('tipos');
    const o = { clubFile: c.clubFile, vaultDir: c.vault.dir, launcher: { command: 'node', args: ['mcp-launch.mjs'] } };
    expect(clubEntry('web', { ...DEF, type: 'sse' }, o)).toMatchObject({ type: 'sse', headersHelper: expect.stringContaining('"--headers"') });
    expect(clubEntry('web', { ...DEF, headers: [] }, o)).toEqual({ type: 'http', url: DEF.url });
    const stdio = clubEntry('web', { type: 'stdio', command: 'x', env: [] }, o)!;
    expect(stdio).toEqual({ type: 'stdio', command: 'node', args: ['mcp-launch.mjs', '--server', 'web', '--club', c.clubFile, '--vault', c.vault.dir] });
    expect(stdio).not.toHaveProperty('headersHelper');
  });

  it('ida e volta: o parser do Club devolve o servidor, a biblioteca, o cofre e que é o modo de cabeçalhos (caminho com espaço e acento)', async () => {
    const c = await club('configuração com espaço');
    const entry = clubEntry('web', DEF, { clubFile: c.clubFile, vaultDir: c.vault.dir, launcher: { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\club\\dist\\mcp-launch.mjs'] } })!;
    expect(parseLauncherEntry(entry)).toEqual({ server: 'web', club: c.clubFile, vault: c.vault.dir, headers: true, launcher: 'C:\\club\\dist\\mcp-launch.mjs' });
  });

  it('caminho que o shell reinterpretaria (aspas, %, $, crase, controle) não gera a linha: a entrada não é montada', async () => {
    const c = await club('recusa');
    const ok = { clubFile: c.clubFile, vaultDir: c.vault.dir, launcher: { command: 'node', args: ['mcp-launch.mjs'] } };
    expect(clubEntry('web', DEF, ok)).not.toBeNull();
    for (const bad of ['a"b', 'a%PATH%b', 'a$HOME', 'a`id`', 'a\nb', 'a\u0000b']) {
      expect(clubEntry('web', DEF, { ...ok, clubFile: path.join(c.home, bad, 'mcps.json') }), JSON.stringify(bad)).toBeNull();
      expect(clubEntry('web', DEF, { ...ok, vaultDir: path.join(c.home, bad) }), JSON.stringify(bad)).toBeNull();
      expect(clubEntry('web', DEF, { ...ok, launcher: { command: 'node', args: [`${bad}.mjs`] } }), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('headersHelper gravado no ~/.claude.json: rodando por um shell, como o Claude Code', () => {
  it('imprime só o JSON dos cabeçalhos do cofre; o MYCO_HOME do processo é o do Club (o lançador só aceita os caminhos padrão)', async () => {
    const c = await club('configuração com espaço');
    const entry = clubEntry('web', DEF, { clubFile: c.clubFile, vaultDir: c.vault.dir, launcher: mcpLaunchCommand(false) })!;
    const out = execSync(entry.headersHelper as string, { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, MYCO_HOME: c.home } });
    expect(JSON.parse(out)).toEqual({ Authorization: HDR });
    expect(out.trim()).toBe(out);
  }, 120_000);

  it('o MYCO_HOME de outra pasta (o --club da entrada deixa de ser o padrão): sai com erro, sem cabeçalho e sem o valor na mensagem', async () => {
    const c = await club('configuração com espaço');
    const entry = clubEntry('web', DEF, { clubFile: c.clubFile, vaultDir: c.vault.dir, launcher: mcpLaunchCommand(false) })!;
    let stdout = '';
    let stderr = '';
    let status: number | null = 0;
    try {
      execSync(entry.headersHelper as string, { encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: 'pipe', env: { ...process.env, MYCO_HOME: path.join(root, 'outro-club') } });
    } catch (err) {
      ({ stdout, stderr, status } = err as { stdout: string; stderr: string; status: number | null });
    }
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('recusado');
    expect(`${stdout}${stderr}`).not.toContain(HDR);
  }, 120_000);
});
