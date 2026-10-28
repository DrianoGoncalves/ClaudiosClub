import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readServerLog } from '../server/staff/serverLog';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-srvlog-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const use = (at: string, id: string, name: string, command: string) =>
  JSON.stringify({ type: 'assistant', timestamp: at, sessionId: 's1', message: { content: [{ type: 'tool_use', id, name, input: { command } }] } });
const result = (id: string, isError: boolean) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } });

describe('registro de acesso aos servidores', () => {
  it('acha ssh, scp e a skill vps nas conversas, com a conexão e o resultado', async () => {
    const file = path.join(root, 's1.jsonl');
    await fs.writeFile(
      file,
      [
        use('2026-10-28T10:00:00Z', 'a', 'Bash', 'ssh -F "C:/p/.vps/ssh_config" producao "systemctl status nginx"'),
        result('a', false),
        use('2026-10-28T10:05:00Z', 'b', 'PowerShell', 'scp -F "C:/p/.vps/ssh_config" dist.zip producao:/var/www/app'),
        result('b', true),
        use('2026-10-28T10:06:00Z', 'c', 'Bash', 'git status && npm test'),
        result('c', false),
        use('2026-10-28T10:07:00Z', 'd', 'Bash', 'ssh -o BatchMode=yes VPS "df -h"'),
        use('2026-10-28T10:08:00Z', 'e', 'PowerShell', '& powershell -File "$HOME\\.claude\\skills\\vps\\vps.ps1" push .env -c VPS'),
        // Comando composto e destino em variável: não inventa conexão.
        use('2026-10-28T09:00:00Z', 'f', 'PowerShell', 'Set-Location x; Remove-Item -Force a; ssh @opts "$u@$h" "ls"'),
        use('2026-10-28T09:01:00Z', 'g', 'Bash', 'cd /x && ssh -i ~/.ssh/k -p 2222 deploy@1.2.3.4 "uptime"; echo ok'),
        'linha quebrada {',
      ].join('\n'),
    );
    const log = await readServerLog([file, path.join(root, 'nao-existe.jsonl')], ['producao', 'VPS']);
    expect(log.map((e) => [e.connection, e.ok])).toEqual([
      ['VPS', null],
      ['VPS', null],
      ['producao', false],
      ['producao', true],
      ['1.2.3.4', null],
      [null, null],
    ]);
    expect(log[3]).toMatchObject({ at: '2026-10-28T10:00:00Z', sessionId: 's1', command: 'ssh -F "C:/p/.vps/ssh_config" producao "systemctl status nginx"' });
    // Comando comum (git, npm) não entra.
    expect(log.some((e) => e.command.includes('npm test'))).toBe(false);
  });
});
