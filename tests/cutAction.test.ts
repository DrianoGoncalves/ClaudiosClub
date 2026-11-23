import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackgroundTask, ChatItem } from '../shared/model';
import { externalBackground, externalCut, externalCutWithAgents, hasExternalEffect, subagentsDirOf } from '../server/chat/cutAction';
import { findSecret } from '../server/chat/secrets';
import { ResumeFile, resumeAfterRestart, takeResume, type ResumeEntry } from '../server/chat/resume';
import { capReason, capText } from '../server/chat/turnCap';
import { InboxState } from '../server/inboxState';
import { removeTemp } from './support/tmp';

// Retomada segura: a ação com efeito fora do projeto cortada pelo reinício não volta sozinha (vai para você).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-cut-'));
});
afterAll(() => removeTemp(root));

const tool = (name: string, input: unknown, result: string | null, summary = ''): ChatItem => ({
  kind: 'tool',
  id: `t:${name}:${Math.random()}`,
  name,
  summary,
  input: JSON.stringify(input),
  result,
  isError: false,
  at: null,
});
const user = (text: string): ChatItem => ({ kind: 'user', id: `u:${text}`, text, at: null });
const assistant = (text: string): ChatItem => ({ kind: 'assistant', id: `a:${text}`, text, at: null });

describe('hasExternalEffect: o que mexe fora do projeto', () => {
  it.each([
    ['Bash', { command: 'git push origin main' }],
    ['Bash', { command: 'git -C ../outro push' }],
    ['Bash', { command: 'cd app && git push' }],
    ['Bash', { command: 'bash -c "git push"' }],
    ['Bash', { command: 'sudo ssh deploy@vps' }],
    ['Bash', { command: 'ssh deploy@vps "systemctl restart app"' }],
    ['Bash', { command: 'scp dist.zip vps:/var/www' }],
    ['Bash', { command: 'rsync -a dist/ vps:/var/www' }],
    ['Bash', { command: 'npm run deploy' }],
    ['Bash', { command: 'npm publish' }],
    ['Bash', { command: './scripts/deploy.sh' }],
    ['Bash', { command: 'docker push minha/app:1' }],
    ['Bash', { command: 'docker compose up -d' }],
    ['Bash', { command: 'kubectl apply -f app.yaml' }],
    ['Bash', { command: 'gh pr create --title x' }],
    ['Bash', { command: 'gh pr merge 12' }],
    ['Bash', { command: 'gh release create v1.2.0' }],
    ['Bash', { command: 'curl -X POST https://api.example.com/orders' }],
    ['Bash', { command: 'curl -X PUT https://api.example.com/a' }],
    ['Bash', { command: 'curl -X DELETE https://api.example.com/a' }],
    ['Bash', { command: 'curl -X PATCH https://api.example.com/a' }],
    ['Bash', { command: 'curl -d "a=b" https://api.example.com' }],
    ['Bash', { command: 'curl --data-binary @x.json https://api.example.com' }],
    // Sem esquema (`localhost:3000`), o host não se sabe: conta como externo (na dúvida, trava).
    ['Bash', { command: 'curl -X POST localhost:3000/x' }],
    ['Bash', { command: 'node -e "fetch(\'https://api.example.com/a\', {method:\'POST\'})"' }],
    ['Bash', { command: 'python -c "import requests; requests.post(\'https://api.example.com\')"' }],
    ['PowerShell', { command: 'Invoke-RestMethod -Method Post https://x' }],
    ['PowerShell', { command: 'Invoke-WebRequest -Method Delete -Uri https://api.example.com/a' }],
    ['mcp__myco-ssh__ssh_executar', { servidor: 'vps', comando: 'rm -rf /tmp/x' }],
    ['mcp__myco-ftp__ftp_upload', { arquivo: 'index.html' }],
    // `query` não é leitura: um MCP de SQL apaga com ela.
    ['mcp__myco-sql__query', { sql: 'DELETE FROM pedidos' }],
    ['mcp__claude-in-chrome__computer', { action: 'left_click' }],
    ['mcp__claude-in-chrome__form_input', { value: 'x' }],
    ['mcp__playwright__browser_click', {}],
    ['mcp__github__create_issue', { title: 'x' }],
    ['mcp__github__readme_update', {}],
    ['Agent', { subagent_type: 'executor' }],
    ['Agent', { description: 'publica' }], // sem subagent_type: o padrão faz de tudo
    ['Task', { subagent_type: 'general-purpose' }],
  ])('%s %j: sim', (name, input) => {
    expect(hasExternalEffect(name, JSON.stringify(input))).toBe(true);
  });

  it.each([
    ['Bash', { command: 'npm test' }],
    ['Bash', { command: 'git status && git diff --stat' }],
    ['Bash', { command: 'git commit -m "fix deploy"' }],
    ['Bash', { command: 'git log --grep=release' }],
    ['Bash', { command: 'curl localhost:3000/health' }],
    ['Bash', { command: 'curl http://127.0.0.1:8080/x' }],
    ['Bash', { command: 'curl -X POST http://localhost:3000/x' }],
    ['Bash', { command: 'curl https://api.example.com/orders' }],
    ['Bash', { command: 'ls ~/.ssh' }],
    ['Bash', { command: 'cat docs/release.md' }],
    ['Bash', { command: 'grep deploy src/app.ts' }],
    ['Bash', { command: 'gh pr list' }],
    ['Bash', { command: 'gh pr view 12' }],
    ['Bash', { command: 'docker ps' }],
    ['Bash', { command: 'node -e "fetch(\'http://localhost:3000/health\')"' }],
    ['Bash', { command: 'node -e "console.log(1)"' }],
    ['Bash', { command: 'python -c "print(1)"' }],
    ['Edit', { file_path: 'a.ts' }],
    ['Write', { file_path: 'a.ts' }],
    ['Read', { file_path: 'a.ts' }],
    ['WebFetch', { url: 'https://example.com' }],
    ['Agent', { subagent_type: 'Explore' }],
    ['Agent', { subagent_type: 'Plan' }],
    ['Agent', { subagent_type: 'pesquisador' }],
    ['Agent', { subagent_type: 'revisor' }],
    ['Agent', { subagent_type: 'statusline-setup' }],
    ['mcp__myco-ssh__ssh_ler', { servidor: 'vps' }],
    ['mcp__myco-ssh__ssh_status', { servidor: 'vps' }],
    ['mcp__myco-ftp__ftp_list', {}],
    ['mcp__claude-in-chrome__read_page', {}],
    ['mcp__claude-in-chrome__get_page_text', {}],
    ['mcp__claude-in-chrome__tabs_context_mcp', {}],
    ['mcp__playwright__browser_snapshot', {}],
    ['mcp__github__get_me', {}],
    ['mcp__github__list_issues', {}],
  ])('%s %j: não', (name, input) => {
    expect(hasExternalEffect(name, JSON.stringify(input))).toBe(false);
  });
});

describe('o comando é lido por trecho: o description não entra, entrada cortada também', () => {
  it('o description não conta: só o command decide', () => {
    expect(hasExternalEffect('Bash', JSON.stringify({ command: 'git status', description: 'antes do release' }))).toBe(false);
    expect(hasExternalEffect('Bash', JSON.stringify({ command: 'npm test', description: 'git push depois' }))).toBe(false);
    expect(hasExternalEffect('Bash', JSON.stringify({ command: 'git push', description: 'x' }))).toBe(true);
    expect(externalCut([user('x'), tool('Bash', { command: 'git status', description: 'antes do release' }, null, 'git status')])).toBeNull();
  });

  it('entrada cortada (não é JSON inteiro): acha o command no texto cru', () => {
    expect(hasExternalEffect('Bash', '{\n  "command": "git push origin mai')).toBe(true);
    expect(hasExternalEffect('Bash', '{\n  "description": "antes do deploy", "command": "npm test')).toBe(false);
  });
});

describe('externalCut: a ação que ficou pela metade no fim da conversa', () => {
  it('a última ferramenta sem resultado e com efeito fora: devolve o resumo', () => {
    const items = [user('publica'), assistant('vou'), tool('Bash', { command: 'git push' }, null, 'git push')];
    expect(externalCut(items)).toBe('git push');
  });

  it('chamadas em paralelo: acha a de efeito fora entre as sem resultado', () => {
    const items = [user('vai'), tool('Bash', { command: 'git push' }, null, 'git push'), tool('Read', { file_path: 'a' }, null, 'a')];
    expect(externalCut(items)).toBe('git push');
  });

  it('terminou (tem resultado), ficou no projeto ou veio antes da sua última mensagem: null', () => {
    expect(externalCut([user('x'), tool('Bash', { command: 'git push' }, 'ok', 'git push')])).toBeNull();
    expect(externalCut([user('x'), tool('Edit', { file_path: 'a.ts' }, null, 'a.ts')])).toBeNull();
    expect(externalCut([tool('Bash', { command: 'git push' }, null, 'git push'), user('e agora?')])).toBeNull();
    expect(externalCut([])).toBeNull();
  });

  it('sem resumo usa o nome; resumo longo é cortado', () => {
    expect(externalCut([tool('mcp__myco-ftp__ftp_upload', {}, null)])).toBe('mcp__myco-ftp__ftp_upload');
    const long = `ssh vps ${'x'.repeat(200)}`;
    const out = externalCut([tool('Bash', { command: long }, null, long)])!;
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('permissão pendente: a ferramenta que espera a permissão não rodou', () => {
  it('a única sem resultado é a que espera: não conta como corte', () => {
    const items = [user('publica'), tool('Bash', { command: 'git push' }, null, 'git push')];
    expect(externalCut(items, true)).toBeNull();
    expect(externalCut(items, false)).toBe('git push');
  });

  it('com mais de uma sem resultado não dá para saber qual espera: conta como antes', () => {
    const items = [user('vai'), tool('Bash', { command: 'git push' }, null, 'git push'), tool('Read', { file_path: 'a' }, null, 'a')];
    expect(externalCut(items, true)).toBe('git push');
  });
});

// Subagent cortado: o transcript dele (`<sessão>/subagents/agent-<id>.jsonl`) e o `.meta.json` ao lado, com o toolUseId da chamada do pai.
describe('subagent cortado: o transcript dele decide', () => {
  const DESC = 'Codex agents: geração';
  /** A chamada Agent do pai, sem resultado (o turno foi cortado nela). */
  const agent = (toolUseId: string, input: Record<string, unknown> = { subagent_type: 'executor', description: DESC }, name = 'Agent'): ChatItem => ({
    ...tool(name, input, null, DESC),
    id: `t:${toolUseId}`,
  });
  /** Linhas do transcript do subagent: a chamada de ferramenta e, se `done`, o resultado dela. */
  const call = (id: string, name: string, input: unknown, done = true): string[] => [
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } }),
    ...(done ? [JSON.stringify({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })] : []),
  ];

  let seq = 0;
  /** `<sessão>/subagents` com um subagent por chamada do pai; `null` = só o `.meta.json`, sem transcript. */
  async function subagents(byCall: Record<string, string[] | null>): Promise<string> {
    const dir = path.join(root, `sess-${++seq}`, 'subagents');
    await fs.mkdir(dir, { recursive: true });
    let k = 0;
    for (const [toolUseId, lines] of Object.entries(byCall)) {
      const name = `agent-a${++k}`;
      await fs.writeFile(path.join(dir, `${name}.meta.json`), JSON.stringify({ agentType: 'executor', description: 'x', toolUseId, spawnDepth: 1 }));
      if (lines) await fs.writeFile(path.join(dir, `${name}.jsonl`), `${lines.join('\n')}\n`);
    }
    return dir;
  }
  const cut = (items: ChatItem[], dir: string | null, awaiting = false) => externalCutWithAgents([user('faz'), ...items], awaiting, dir);

  const localWork = [
    ...call('r1', 'Read', { file_path: 'server/chat/cutAction.ts' }),
    ...call('g1', 'Grep', { pattern: 'READ_ONLY_AGENTS' }),
    ...call('e1', 'Edit', { file_path: 'server/chat/cutAction.ts', old_string: 'a', new_string: 'b' }),
    ...call('w1', 'Write', { file_path: 'tests/novo.test.ts', content: 'x' }),
    ...call('p1', 'PowerShell', { command: 'npx tsc --noEmit' }),
    ...call('p2', 'PowerShell', { command: 'Test-Path server/chat/codexSubagents.ts' }),
    ...call('b1', 'Bash', { command: 'npx vitest run tests/cutAction.test.ts' }, false), // sem resultado: a retomada pode repetir
  ];

  it('só Read/Grep/Edit/Write e comandos locais (terminados ou não): o corte é local, a conversa retoma', async () => {
    const dir = await subagents({ toolu_a: localWork });
    expect(await cut([agent('toolu_a')], dir)).toBeNull();
    expect(await cut([agent('toolu_a', { subagent_type: 'general-purpose' }, 'Task')], dir)).toBeNull();
  });

  it('subagent sem nenhuma ferramenta no transcript: local', async () => {
    const dir = await subagents({ toolu_a: [JSON.stringify({ type: 'user', message: { content: 'faça X' } })] });
    expect(await cut([agent('toolu_a')], dir)).toBeNull();
  });

  const OUTSIDE: Array<[string, string, unknown]> = [
    ['git push', 'Bash', { command: 'git push origin main' }],
    ['ssh', 'PowerShell', { command: 'ssh deploy@vps "systemctl restart app"' }],
    ['curl POST', 'Bash', { command: 'curl -X POST https://api.example.com/orders -d a=b' }],
    ['MCP de servidor', 'mcp__myco-ssh__ssh_executar', { servidor: 'vps', comando: 'ls' }],
  ];
  it.each(OUTSIDE)('%s dentro do subagent, terminado ou não, e entre ferramentas locais: segue travando', async (_n, name, input) => {
    for (const done of [true, false]) {
      const dir = await subagents({ toolu_a: [...localWork, ...call('x1', name, input, done), ...localWork] });
      expect(await cut([agent('toolu_a')], dir)).toBe(DESC);
    }
  });

  it('transcript ausente (sem pasta, sem a chamada, só o meta) ou sem pasta informada: segue travando', async () => {
    expect(await cut([agent('toolu_a')], path.join(root, 'nao-existe', 'subagents'))).toBe(DESC);
    expect(await cut([agent('toolu_a')], null)).toBe(DESC);
    expect(await cut([agent('toolu_a')], await subagents({ toolu_outra: localWork }))).toBe(DESC); // o subagent é de outra chamada
    expect(await cut([agent('toolu_a')], await subagents({ toolu_a: null }))).toBe(DESC); // meta sem transcript
  });

  it('transcript ilegível (linha de ferramenta cortada, ou não é arquivo) segue travando; lixo sem ferramenta não atrapalha', async () => {
    const cutLine = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Bash","input":{"command":"git pu';
    expect(await cut([agent('toolu_a')], await subagents({ toolu_a: [...localWork, cutLine] }))).toBe(DESC);
    expect(await cut([agent('toolu_a')], await subagents({ toolu_a: [...localWork, '{"type":"user","message":{"content":"corta'] }))).toBeNull();
    const dir = await subagents({ toolu_a: null });
    await fs.mkdir(path.join(dir, 'agent-a1.jsonl')); // existe, mas não dá para ler como arquivo
    expect(await cut([agent('toolu_a')], dir)).toBe(DESC);
  });

  it('o .meta.json ilegível não acha o transcript: segue travando', async () => {
    const dir = await subagents({ toolu_a: localWork });
    await fs.writeFile(path.join(dir, 'agent-a1.meta.json'), '{"toolUseId":');
    expect(await cut([agent('toolu_a')], dir)).toBe(DESC);
  });

  describe('subagent dentro de subagent', () => {
    const nested = (id: string, input: Record<string, unknown> = { subagent_type: 'executor' }) => call(id, 'Agent', input);

    it('o de dentro também só local: retoma', async () => {
      const dir = await subagents({ toolu_a: [...localWork, ...nested('toolu_b')], toolu_b: localWork });
      expect(await cut([agent('toolu_a')], dir)).toBeNull();
    });

    it('o de dentro faz git push (terminado ou não): segue travando', async () => {
      for (const done of [true, false]) {
        const dir = await subagents({ toolu_a: [...localWork, ...nested('toolu_b')], toolu_b: [...localWork, ...call('x1', 'Bash', { command: 'git push' }, done)] });
        expect(await cut([agent('toolu_a')], dir)).toBe(DESC);
      }
    });

    it('o transcript do de dentro some, ou ele chama o de fora de novo: segue travando', async () => {
      expect(await cut([agent('toolu_a')], await subagents({ toolu_a: nested('toolu_b') }))).toBe(DESC);
      expect(await cut([agent('toolu_a')], await subagents({ toolu_a: nested('toolu_a') }))).toBe(DESC); // laço
    });

    it('o de dentro só lê (Explore): não precisa de transcript; o fundo demais segue travando', async () => {
      expect(await cut([agent('toolu_a')], await subagents({ toolu_a: [...localWork, ...nested('toolu_b', { subagent_type: 'Explore' })] }))).toBeNull();
      const deep = await subagents({ toolu_a: nested('toolu_b'), toolu_b: nested('toolu_c'), toolu_c: nested('toolu_d'), toolu_d: localWork });
      expect(await cut([agent('toolu_a')], deep)).toBe(DESC);
    });
  });

  it('chamadas em paralelo: o subagent local não esconde o git push solto; o de leitura não consulta transcript', async () => {
    const dir = await subagents({ toolu_a: localWork });
    const push = tool('Bash', { command: 'git push' }, null, 'git push');
    expect(await cut([agent('toolu_a'), push], dir)).toBe('git push');
    expect(await cut([agent('toolu_a', { subagent_type: 'Explore' })], null)).toBeNull();
    expect(await cut([agent('toolu_a'), agent('toolu_b')], dir)).toBe(DESC); // a segunda não tem transcript
  });

  it('o pedido de permissão pendente e a ação sem subagent seguem como em externalCut', async () => {
    const dir = await subagents({ toolu_a: [...localWork, ...call('x1', 'Bash', { command: 'git push' }, false)] });
    expect(await cut([agent('toolu_a')], dir, true)).toBeNull(); // única sem resultado e esperando permissão: não rodou
    const items = [user('x'), tool('Bash', { command: 'git push' }, null, 'git push'), tool('Read', { file_path: 'a' }, null, 'a')];
    expect(await externalCutWithAgents(items, false, dir)).toBe(externalCut(items));
    expect(await externalCutWithAgents([user('x'), agent('toolu_a')], false, null)).toBe(externalCut([user('x'), agent('toolu_a')]));
  });

  it('a pasta dos subagents fica ao lado do transcript, com o nome da sessão', () => {
    expect(subagentsDirOf(path.join('a', 'proj', 'f1e8.jsonl'))).toBe(path.join('a', 'proj', 'f1e8', 'subagents'));
  });
});

// Agent e comando em segundo plano quando o processo caiu: o formato é o da conversa f1e83e2e (Claude Code 2.1.310): subagents em
// `<sessão>/subagents/agent-<agentId>.jsonl` (+ `.meta.json`), e o resultado do comando que foi para o fundo com o id da tarefa.
describe('em segundo plano: o transcript do agent e o comando decidem', () => {
  const AGENT_A = 'a1dc631202b197a06';
  const AGENT_B = 'a32a98b6b5b4d1d74';
  const agentTask = (id: string, label = 'executor: Testes: agents Codex e ficha'): BackgroundTask => ({ id, kind: 'agent', label });
  const shellTask = (id: string): BackgroundTask => ({ id, kind: 'shell', label: 'Full test suite' });

  /** Linha do transcript do subagent, como o Claude Code a grava (`isSidechain`, `agentId`, `caller`). */
  const line = (agentId: string, name: string, input: unknown, id = `toolu_${Math.random().toString(36).slice(2)}`) =>
    JSON.stringify({ parentUuid: null, isSidechain: true, agentId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }] } });
  const result = (agentId: string, id: string) =>
    JSON.stringify({ parentUuid: null, isSidechain: true, agentId, type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok', is_error: false }] } });

  /** O trabalho que os dois executores da f1e83e2e fizeram: ler, procurar, editar, escrever e rodar tsc/testes. */
  const localWork = (agentId: string) => [
    line(agentId, 'Read', { file_path: 'server/chat/codexArgs.ts' }),
    line(agentId, 'Grep', { pattern: 'buildCodexArgs', path: 'server' }),
    line(agentId, 'Edit', { file_path: 'tests/codexAgents.test.ts', old_string: 'a', new_string: 'b' }),
    line(agentId, 'Write', { file_path: 'tests/codexSubagents.test.ts', content: 'x' }),
    line(agentId, 'PowerShell', { command: 'npx tsc --noEmit 2>&1 | Select-Object -First 20', description: 'Typecheck' }),
    line(agentId, 'PowerShell', { command: 'npx vitest run tests/codexAgents.test.ts 2>&1 | Select-Object -Last 15' }),
  ];

  let seq = 0;
  /** `<sessão>/subagents` com um subagent por `agentId`; `lines` null = só o `.meta.json`. */
  async function subagentsOf(agents: Record<string, { lines: string[] | null; label?: [string, string]; finished?: boolean }>): Promise<string> {
    const dir = path.join(root, `bg-${++seq}`, 'subagents');
    await fs.mkdir(dir, { recursive: true });
    for (const [agentId, a] of Object.entries(agents)) {
      const [agentType, description] = a.label ?? ['executor', 'Testes: agents Codex e ficha'];
      const meta = { agentType, isBuiltIn: false, description, toolUseId: `toolu_${agentId}`, spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true, model: 'sonnet', ...(a.finished && { finished: true }) };
      await fs.writeFile(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
      if (a.lines) await fs.writeFile(path.join(dir, `agent-${agentId}.jsonl`), `${a.lines.join('\n')}\n`);
    }
    return dir;
  }

  /** O comando que foi para o fundo, com o resultado no texto do Claude Code. */
  const shellCall = (command: string, taskId: string, how: 'background' | 'timeout' = 'background', name = 'PowerShell'): ChatItem =>
    tool(
      name,
      { command, description: 'x', run_in_background: how === 'background' },
      how === 'background'
        ? `Command running in background with ID: ${taskId}. Output is being written to: C:\\Users\\u\\AppData\\Local\\Temp\\claude\\p\\s\\tasks\\${taskId}.output. You will be notified when it completes. To check interim output, use Read on that file path.`
        : `Command did not complete within its 300s timeout and was moved to the background (ID: ${taskId}). Output is being written to: C:\\Users\\u\\AppData\\Local\\Temp\\claude\\p\\s\\tasks\\${taskId}.output. You will be notified when it completes.`,
      command,
    );

  describe('agent', () => {
    it('os dois executores da f1e83e2e (só ler, editar, tsc e testes): nada incerto, a retomada segue', async () => {
      const dir = await subagentsOf({
        [AGENT_A]: { lines: localWork(AGENT_A) },
        [AGENT_B]: { lines: localWork(AGENT_B), label: ['executor', 'Observabilidade subagents Codex'] },
      });
      expect(await externalBackground([agentTask(AGENT_A), agentTask(AGENT_B, 'executor: Observabilidade subagents Codex')], [], dir)).toBeNull();
    });

    it('comando terminado ou cortado no meio dá o mesmo: vale toda ferramenta do transcript', async () => {
      const id = 'toolu_cortada';
      const dir = await subagentsOf({ [AGENT_A]: { lines: [...localWork(AGENT_A), line(AGENT_A, 'Bash', { command: 'npx vitest run' }, id), result(AGENT_A, id), line(AGENT_A, 'Bash', { command: 'npx tsc --noEmit' })] } });
      expect(await externalBackground([agentTask(AGENT_A)], [], dir)).toBeNull();
    });

    const OUTSIDE: Array<[string, string, unknown]> = [
      ['git push', 'PowerShell', { command: 'git push origin main' }],
      ['ssh', 'Bash', { command: 'ssh deploy@vps "systemctl restart app"' }],
      ['curl POST', 'Bash', { command: 'curl -X POST https://api.example.com/orders -d a=b' }],
      ['npm publish', 'PowerShell', { command: 'npm publish' }],
      ['MCP de servidor', 'mcp__myco-ssh__ssh_executar', { servidor: 'vps', comando: 'ls' }],
    ];
    it.each(OUTSIDE)('%s no meio do trabalho local: o agent volta como incerto', async (_n, name, input) => {
      const dir = await subagentsOf({ [AGENT_A]: { lines: [...localWork(AGENT_A), line(AGENT_A, name, input), ...localWork(AGENT_A)] } });
      const task = agentTask(AGENT_A);
      expect(await externalBackground([task], [], dir)).toBe(task);
    });

    it('subagent de dentro: só local passa; com push, ou fundo demais, não', async () => {
      const inner = (id: string) => line(AGENT_A, 'Agent', { subagent_type: 'executor', description: 'filho', prompt: 'x' }, id);
      const meta = (agentId: string, toolUseId: string) => fs.writeFile(path.join(dirOf, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'executor', description: 'filho', toolUseId }));
      let dirOf = await subagentsOf({ [AGENT_A]: { lines: [...localWork(AGENT_A), inner('toolu_filho')] } });
      await meta('afilho', 'toolu_filho');
      await fs.writeFile(path.join(dirOf, 'agent-afilho.jsonl'), `${localWork('afilho').join('\n')}\n`);
      expect(await externalBackground([agentTask(AGENT_A)], [], dirOf)).toBeNull();

      await fs.writeFile(path.join(dirOf, 'agent-afilho.jsonl'), `${[...localWork('afilho'), line('afilho', 'Bash', { command: 'git push' })].join('\n')}\n`);
      expect(await externalBackground([agentTask(AGENT_A)], [], dirOf)).not.toBeNull();

      dirOf = await subagentsOf({ [AGENT_A]: { lines: [inner('toolu_filho')] } }); // o filho não tem transcript
      expect(await externalBackground([agentTask(AGENT_A)], [], dirOf)).not.toBeNull();
    });

    it('o id da tarefa não bate com o arquivo: acha pelo rótulo se for um só, ainda aberto', async () => {
      const dir = await subagentsOf({
        [AGENT_A]: { lines: localWork(AGENT_A) },
        [AGENT_B]: { lines: [line(AGENT_B, 'Bash', { command: 'git push' })], label: ['executor', 'Observabilidade subagents Codex'] },
      });
      expect(await externalBackground([agentTask('t-outro-id')], [], dir)).toBeNull();
      // O rótulo do outro agent (que faz push) é achado pelo rótulo dele.
      const b = agentTask('t-outro-id', 'executor: Observabilidade subagents Codex');
      expect(await externalBackground([b], [], dir)).toBe(b);
    });

    it('rótulo repetido (dois abertos), só um já terminado ou nenhum igual: incerto', async () => {
      const task = agentTask('t-outro-id');
      const twice = await subagentsOf({ a1: { lines: localWork('a1') }, a2: { lines: localWork('a2') } });
      expect(await externalBackground([task], [], twice)).toBe(task);
      const finished = await subagentsOf({ a1: { lines: localWork('a1'), finished: true } });
      expect(await externalBackground([task], [], finished)).toBe(task);
      const other = await subagentsOf({ a1: { lines: localWork('a1'), label: ['executor', 'outra coisa'] } });
      expect(await externalBackground([task], [], other)).toBe(task);
    });

    it('sem pasta, sem transcript, ilegível ou id estranho (não vira caminho): incerto', async () => {
      const task = agentTask(AGENT_A);
      expect(await externalBackground([task], [], null)).toBe(task);
      expect(await externalBackground([task], [], path.join(root, 'nao-existe', 'subagents'))).toBe(task);
      expect(await externalBackground([task], [], await subagentsOf({ [AGENT_A]: { lines: null } }))).toBe(task); // só o meta
      const cut = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Bash","input":{"command":"git pu';
      expect(await externalBackground([task], [], await subagentsOf({ [AGENT_A]: { lines: [...localWork(AGENT_A), cut] } }))).toBe(task);
      const dir = await subagentsOf({ [AGENT_A]: { lines: null } });
      await fs.mkdir(path.join(dir, `agent-${AGENT_A}.jsonl`)); // existe, mas não é arquivo
      expect(await externalBackground([task], [], dir)).toBe(task);
      // `..` no id não sai da pasta: o arquivo de fora, mesmo existindo, não é lido.
      const parent = await subagentsOf({ [AGENT_A]: { lines: localWork(AGENT_A) } });
      await fs.writeFile(path.join(path.dirname(parent), 'agent-x.jsonl'), `${localWork('x').join('\n')}\n`);
      const sneaky = agentTask('../agent-x', 'sem rótulo igual');
      expect(await externalBackground([sneaky], [], parent)).toBe(sneaky);
    });
  });

  describe('comando', () => {
    it.each([
      ['foi para o fundo (run_in_background)', 'background'],
      ['passou do tempo e o Claude Code o levou para o fundo', 'timeout'],
    ] as const)('só testa/tipa o projeto (%s): nada incerto', async (_n, how) => {
      const items = [user('rode'), shellCall('npx vitest run 2>&1 | Select-String -Pattern "FAIL"', 'brl07nnit', how), shellCall('npx tsc --noEmit', 'b37k91xg5', how, 'Bash')];
      expect(await externalBackground([shellTask('brl07nnit'), shellTask('b37k91xg5')], items, null)).toBeNull();
    });

    it.each(['git push origin main', 'ssh deploy@vps "ls"', 'npm run deploy', 'curl -X POST https://api.example.com/x -d a=b', 'cd site; npx vitest run && git push'])('%s: incerto', async (command) => {
      const task = shellTask('brl07nnit');
      expect(await externalBackground([task], [user('rode'), shellCall(command, 'brl07nnit')], null)).toBe(task);
    });

    it('chamada que não está nos itens, id parecido, de outro tipo de ferramenta ou de entrada cortada: incerto', async () => {
      const task = shellTask('b37k91xg5');
      expect(await externalBackground([task], [user('rode')], null)).toBe(task); // saiu da lista de itens (ver `evict`)
      expect(await externalBackground([task], [user('rode'), shellCall('npx tsc', 'b37k91xg5x')], null)).toBe(task); // o id é de outro comando
      expect(await externalBackground([task], [user('rode'), shellCall('npx tsc', 'b37k91xg5', 'background', 'Read')], null)).toBe(task);
      const big = shellCall('npx tsc', 'b37k91xg5');
      expect(await externalBackground([task], [user('rode'), { ...big, input: `${JSON.stringify({ command: 'npx tsc' })}\n… (900 caracteres a mais)` } as ChatItem], null)).toBe(task);
      expect(await externalBackground([shellTask('../x'), shellTask('a b')], [user('rode'), shellCall('npx tsc', 'x')], null)).not.toBeNull(); // id que não é nome de tarefa
    });
  });

  it('outros tipos de tarefa e agent sem como conferir contam como incerto; vale a primeira incerta, na ordem', async () => {
    const dir = await subagentsOf({ [AGENT_A]: { lines: localWork(AGENT_A) } });
    const items = [user('rode'), shellCall('npx tsc', 'b1'), shellCall('git push', 'b2')];
    const monitor: BackgroundTask = { id: 'm1', kind: 'monitor', label: 'Monitor: logs' };
    expect(await externalBackground([monitor], items, dir)).toBe(monitor);
    expect(await externalBackground([agentTask(AGENT_A), shellTask('b1'), shellTask('b2'), monitor], items, dir)).toEqual(shellTask('b2'));
    expect(await externalBackground([], items, dir)).toBeNull();
  });
});

describe('o resumo da ação não leva segredo', () => {
  const token = 'ghp_Qr7Lx2Vm9Kd4Tn8Bw3Zp6Hs1Yc5Fj0Ga2Ue';

  it('o token no comando sai como [segredo]', () => {
    expect(findSecret(token)).not.toBeNull(); // o exemplo tem que ser um segredo de verdade para o teste valer
    const out = externalCut([user('publica'), tool('Bash', { command: `curl -X POST https://api.example.com/x -H "Authorization: ${token}"` }, null)])!;
    expect(out).not.toContain(token);
    expect(out).toContain('[segredo]');
  });

  it('o segredo é trocado antes de cortar: nem o começo dele aparece no resumo longo', () => {
    const cmd = `echo ${'x'.repeat(75)}; curl -X POST https://api.example.com -d ${token}`;
    const out = externalCut([user('publica'), tool('Bash', { command: cmd }, null, cmd)])!;
    expect(out).not.toContain('ghp_');
    expect(out.length).toBeLessThanOrEqual(80);
  });
});

describe('reinício pelo navegador: a conversa cortada numa ação externa', () => {
  const NOW = Date.parse('2026-11-13T12:00:00Z');
  const entry = (over: Partial<ResumeEntry> = {}): ResumeEntry => ({ projectId: 'p', sessionId: 'sx', staffId: 'ana', engine: 'claude', cwd: '.', hadPending: false, ...over });

  it('não envia: segura para você e diz no log; as outras retomam', async () => {
    const file = path.join(root, 'resume-cut.json');
    await new ResumeFile(file).save([entry({ sessionId: 'sx', cut: 'git push' }), entry({ sessionId: 'sy' })], NOW);
    const sent: string[] = [];
    const held: Array<{ id: string; cut: string }> = [];
    const logs: string[] = [];
    let limitAsked = 0;
    await resumeAfterRestart({
      file,
      now: () => NOW + 60_000,
      log: (l) => logs.push(l),
      stopHit: async () => (limitAsked++, null),
      send: async (e) => void sent.push(e.sessionId),
      hold: (e) => void held.push({ id: e.sessionId, cut: e.cut }),
    });
    expect(sent).toEqual(['sy']);
    expect(held).toEqual([{ id: 'sx', cut: 'git push' }]);
    expect(limitAsked).toBe(1); // a cortada nem confere o limite
    expect(logs[0]).toBe('sx: não retomada: o reinício cortou "git push" no meio (vai para você)');
  });

  it('o arquivo de antes (sem `cut`) segue valendo; `cut` vazio não passa', async () => {
    const file = path.join(root, 'resume-old.json');
    const old = { savedAt: new Date(NOW).toISOString(), sessions: [entry(), { ...entry({ sessionId: 'sz' }), cut: '' }] };
    await fs.writeFile(file, JSON.stringify(old));
    const got = await takeResume(file, NOW + 60_000, () => {});
    expect(got.map((e) => e.sessionId)).toEqual(['sx']);
    expect(got[0]).not.toHaveProperty('cut');
  });
});

describe('o aviso do corte, na caixa e na tarefa', () => {
  it('texto da caixa e motivo da tarefa', () => {
    expect(capText({ kind: 'restart', action: 'git push' })).toContain('a conversa parou no meio de "git push"');
    expect(capReason({ kind: 'restart', action: 'git push' })).toBe('a conversa parou no meio de "git push": confira se aconteceu antes de retomar');
    expect(capReason({ kind: 'tools', limit: 50 })).toBe('turno parado: passou de 50 ferramentas');
  });

  it('a caixa lembra o corte depois de reabrir', async () => {
    const file = path.join(root, 'inbox-cut.json');
    const a = new InboxState(file);
    a.setTurnCap('s1', { kind: 'restart', action: 'git push', at: '2026-11-13T12:00:00Z' });
    a.setTurnCap('s2', { kind: 'tools', limit: 50, at: '2026-11-13T12:00:00Z' });
    await a.flush();
    const b = new InboxState(file);
    expect(b.turnCapOf('s1')).toEqual({ kind: 'restart', action: 'git push' });
    expect(b.turnCapOf('s2')).toEqual({ kind: 'tools', limit: 50 });
  });
});
