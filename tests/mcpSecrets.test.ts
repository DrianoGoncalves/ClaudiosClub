import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findMcpJsonSecrets, mcpJsonWarnings } from '../server/staff/mcp';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-mcpsec-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const servers = (mcpServers: Record<string, unknown>) => ({ mcpServers });

describe('chave escrita no .mcp.json', () => {
  it('acha em env, headers, args e url; ${VARIAVEL} não conta', () => {
    const found = findMcpJsonSecrets(
      servers({
        anthropic: { command: 'npx', env: { ANTHROPIC_API_KEY: `${'sk-ant-'}api03-${'A'.repeat(28)}` } },
        sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: 'Bearer abc123def456ghi' } },
        github: { command: 'gh-mcp', args: ['--token', `${'ghp'}_${'a'.repeat(36)}`] },
        busca: { type: 'http', url: 'https://mcp.exemplo.com/?api_key=segredo-de-verdade' },
        banco: { command: 'pg-mcp', env: { DB_PASSWORD: 'senhaForte123' } },
        certo: { command: 'npx', env: { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}' }, headers: { Authorization: 'Bearer ${TOKEN}' } },
        inocente: { command: 'npx', args: ['-y', '@playwright/mcp'], env: { NODE_ENV: 'production', AUTH_MODE: 'oauth-device', LOG_LEVEL: 'debug' } },
      }),
    );
    expect(found.map((f) => f.server)).toEqual(['anthropic', 'sentry', 'github', 'busca', 'banco']);
    expect(found[0]!.label).toBe('uma chave da API da Anthropic');
    // Só o tipo: o valor nunca sai.
    expect(JSON.stringify(found)).not.toMatch(/sk-ant|abc123|ghp_|segredo|senhaForte/);
    expect(findMcpJsonSecrets('nada')).toEqual([]);
  });

  it('avisa só se o .mcp.json não está fora do git', async () => {
    const dir = path.join(root, 'proj');
    await fs.mkdir(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await fs.writeFile(path.join(dir, '.mcp.json'), JSON.stringify(servers({ x: { command: 'y', env: { API_TOKEN: 'literal-12345678' } } })));
    expect(await mcpJsonWarnings(dir, 1)).toEqual([{ server: 'x', label: 'uma chave' }]);
    await fs.writeFile(path.join(dir, '.gitignore'), '.mcp.json\n');
    // O .gitignore mudou, o .mcp.json não: vale depois do intervalo de releitura.
    expect(await mcpJsonWarnings(dir, 2)).toHaveLength(1);
    expect(await mcpJsonWarnings(dir, 10 * 60_000)).toEqual([]);
    expect(await mcpJsonWarnings(path.join(root, 'sem-arquivo'))).toEqual([]);
  });
});
