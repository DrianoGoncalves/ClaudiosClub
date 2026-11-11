import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testMcpConfig } from '../server/staff/mcpTest';

// O teste do MCP encerra a árvore inteira: um servidor aberto por um intermediário (como o npx faz) não fica órfão,
// mesmo que ele não saia quando o stdin fecha. No Windows quem faz isso é o taskkill /T; aqui, o grupo do processo.
const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-tree-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('teste do MCP no Unix', () => {
  it('o neto (servidor aberto pelo comando) sai junto com o comando', async () => {
    const pidFile = path.join(dir, 'neto.pid');
    const child = path.join(dir, 'neto.mjs');
    const parent = path.join(dir, 'pai.mjs');
    await writeFile(
      child,
      `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.on('end', () => {}); // não sai com o stdin fechado
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  const result = m.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } }
    : { tools: [{ name: 'eco', inputSchema: { type: 'object' } }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
setInterval(() => {}, 1e6);
`,
    );
    await writeFile(parent, `import { spawn } from 'node:child_process';\nspawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'inherit' });\nsetInterval(() => {}, 1e6);\n`);
    const r = await testMcpConfig({ type: 'stdio', command: process.execPath, args: [parent] }, { cwd: dir });
    expect(r).toMatchObject({ ok: true, tools: ['eco'] });
    const pid = Number(await readFile(pidFile, 'utf8'));
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((res) => setTimeout(res, 50));
    const left = alive(pid);
    if (left) process.kill(pid, 'SIGKILL');
    expect(left).toBe(false);
  }, 20_000);
});
