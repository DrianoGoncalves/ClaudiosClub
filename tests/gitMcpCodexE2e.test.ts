import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundle } from '../scripts/bundle';
import { buildCodexArgs } from '../server/chat/codexArgs';
import { resolveCodexCommand } from '../server/codexEnv';
import { killTree } from '../server/chat/registry';
import { ROOT } from '../server/root';
import { gitMcpServer, writeGitPolicy } from '../server/staff/gitMcp';

// Prova real do MCP de git (t-eaffcd) com o Codex de verdade, PULADA por padrão: só roda com MYCO_CODEX_E2E=1, o `codex` instalado e logado.
//   $env:MYCO_CODEX_E2E=1; npx vitest run tests/gitMcpCodexE2e.test.ts
// Uma conversa Codex (`codex exec`, sandbox de escrita na pasta de trabalho, perfil de permissões e MCP montados por buildCodexArgs, como o Club faz) tenta commitar
// pelo terminal (a sandbox deixa o .git só leitura) e depois pela ferramenta git_commit do MCP myco-git. O commit tem de existir no repositório de teste.

const RUN = process.env.MYCO_CODEX_E2E === '1';
const installed =
  RUN &&
  (() => {
    const { command, prefix } = resolveCodexCommand();
    return spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).status === 0;
  })();
if (RUN && !installed) console.warn('[gitMcpCodexE2e] MYCO_CODEX_E2E=1, mas o `codex` não roda aqui: teste pulado');

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();

describe.skipIf(!installed)('Codex real: commit pela ferramenta git_commit do MCP myco-git', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-gitmcp-e2e-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('o terminal da sandbox não commita; a ferramenta commita só o caminho pedido, sem levar o que outro deixou staged', async () => {
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'e2e@myco.test');
    git(repo, 'config', 'user.name', 'e2e');
    await fs.writeFile(path.join(repo, 'base.txt'), 'base\n');
    await fs.writeFile(path.join(repo, 'outro.txt'), 'outro\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    await fs.writeFile(path.join(repo, 'hello.txt'), 'olá do Codex\n');
    await fs.writeFile(path.join(repo, 'outro.txt'), 'outro mudou\n');
    git(repo, 'add', 'outro.txt'); // staged por "outra conversa": não pode entrar no commit

    // O que o Club monta: a cópia do pacote e a política na pasta da conversa.
    const session = path.join(root, 'run', 'sess-e2e');
    await fs.mkdir(session, { recursive: true });
    const built = path.join(root, 'git-mcp.mjs');
    await bundle('server/git-mcp.ts', built, { inline: true });
    await fs.copyFile(built, path.join(session, 'git-mcp.mjs'));
    await writeGitPolicy(session, { engine: 'codex', access: 'free', autonomy: 'auto', review: false });
    const mcp = { ...gitMcpServer({ bundle: path.join(session, 'git-mcp.mjs'), projectPath: repo, root: repo, runDir: session }), cwd: ROOT };

    const args = buildCodexArgs({
      cwd: repo,
      sandbox: 'workspace',
      network: 'off',
      secrets: { projectPath: repo, home: os.homedir(), mycoHome: path.join(os.homedir(), '.myco') },
      gitMcp: mcp,
    });
    expect(args.join(' ')).not.toMatch(/danger/);

    const prompt = [
      'Teste de ferramentas. Faça exatamente isto, nesta ordem, sem editar nenhum arquivo:',
      '1) No terminal, rode `git add hello.txt` e depois `git commit -m "pelo terminal"`; conte o erro que deu (ou diga que funcionou).',
      '2) Use a ferramenta `git_commit` do MCP `myco-git` com mensagem "prova: commit pelo Codex (t-eaffcd)" e caminhos ["hello.txt"].',
      '3) Use a ferramenta `git_log` do mesmo MCP e responda com o resultado das duas etapas em duas linhas.',
    ].join('\n');

    const { command, prefix } = resolveCodexCommand();
    const { MYCO_TOKEN: _token, ...env } = process.env;
    const child = spawn(command, [...prefix, ...args], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const timer = setTimeout(() => void (child.pid && killTree(child.pid)), 280_000);
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    clearTimeout(timer);

    const events = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { type: string; item?: { type?: string; server?: string; tool?: string; status?: string; command?: string; aggregated_output?: string; text?: string } });
    const calls = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call').map((e) => `${e.item!.server}/${e.item!.tool}: ${e.item!.status}`);
    const shells = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'command_execution').map((e) => `${e.item!.command} => ${(e.item!.aggregated_output ?? '').trim().slice(0, 200)}`);
    console.log(`[e2e] chamadas MCP:\n  ${calls.join('\n  ')}\n[e2e] terminal:\n  ${shells.join('\n  ')}\n[e2e] resposta:\n${events.filter((e) => e.item?.type === 'agent_message').map((e) => e.item!.text).join('\n')}`);
    if (!calls.length) console.log(`[e2e] stdout:\n${out.slice(-1500)}\n[e2e] stderr:\n${err.slice(-1500)}`);

    console.log(`[e2e] git log --stat -2:\n${git(repo, 'log', '--stat', '--format=%h %an <%ae> %s', '-2')}`);
    console.log(`[e2e] git status --short:\n${git(repo, 'status', '--short')}`);
    // MYCO_E2E_EVIDENCE=<arquivo>: guarda a prova (o console do vitest some com ela em execução longa).
    if (process.env.MYCO_E2E_EVIDENCE) {
      await fs.writeFile(
        process.env.MYCO_E2E_EVIDENCE,
        [`chamadas MCP:\n  ${calls.join('\n  ')}`, `terminal:\n  ${shells.join('\n  ')}`, `git log --stat -2:\n${git(repo, 'log', '--stat', '--format=%h %an <%ae> %s', '-2')}`, `git status --short:\n${git(repo, 'status', '--short')}`, `git diff --cached --name-only:\n${git(repo, 'diff', '--cached', '--name-only')}`].join('\n\n'),
      );
    }
    expect(calls.some((c) => c.startsWith('myco-git/git_commit') && c.endsWith('completed'))).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('prova: commit pelo Codex (t-eaffcd)');
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('hello.txt');
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('outro.txt');
  }, 300_000);
});
