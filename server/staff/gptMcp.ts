import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { GPT_MCP_NAME, GPT_TOOL_NAME } from '../../shared/model';
import { codexEnv } from '../adapters/codex';
import { CodexBlockedError, codexSafetyArgs, tomlString } from '../chat/codexArgs';
import { isModelUnavailable } from '../chat/codexEvents';
import { killTree } from '../chat/registry';
import { findSecret } from '../chat/secrets';
import { CodexEnv } from '../codexEnv';
import { parseCodexModels, pickCodexSubstitute } from '../codexModels';
import { MYCO_HOME, readConfig } from '../config';
import { ROOT } from '../root';

// MCP do Claudio’s Club que leva uma pergunta ao GPT: um servidor stdio (JSON-RPC por linha) que o Claude Code do funcionário sobe
// quando o Codex está ligado nas configurações (`codexReview`). A única ferramenta, `perguntar_gpt`, abre o `codex exec` por spawn
// (array de argumentos: nenhum shell no meio do texto da pergunta, que vai pelo stdin), só leitura, sem rede, sem a config do usuário
// e sem os conectores da conta, com as pastas de segredo negadas (`codexSafetyArgs`, o mesmo bloqueio do motor Codex).
// Antes de abrir o `codex exec`, confere o Codex instalado com a mesma checagem do motor dos funcionários (`CodexEnv`: versão mínima), e recusa
// com a mesma mensagem se for velho demais. O `network_proxy` não importa aqui: a pergunta roda sem rede. Se o bloqueio de segredos não consegue
// provar que uma pasta secreta está protegida (`CodexBlockedError`), a ferramenta devolve esse texto como erro e não roda nada.
// Sem o SDK oficial, como o MCP de FTP: o protocolo usado é pequeno (initialize, ping, tools/list e tools/call).

export { GPT_MCP_NAME, GPT_TOOL_NAME };
const VERSION = '1.0.0';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** O Codex pensa bastante com esforço alto: uma pergunta de decisão leva de 15 s a alguns minutos. */
export const ASK_TIMEOUT = 10 * 60_000;
const MODELS_TIMEOUT = 30_000;
const MAX_ANSWER = 20_000;
const MAX_QUESTION = 20_000;
const MAX_CONTEXT = 60_000;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const DEFAULT_EFFORT = 'high';

/** Erro nosso, já em palavras: vai como está para quem chamou. O resto vira "falha inesperada". */
export class GptError extends Error {}

export interface GptRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Erro ao abrir o processo (ENOENT: o codex não está instalado). */
  spawnError?: NodeJS.ErrnoException;
  timedOut?: boolean;
}

/** Roda o `codex` com estes argumentos e esta entrada, na pasta `cwd` (os testes trocam). */
export type GptRunner = (args: string[], input: string, o: { cwd: string; timeoutMs: number }) => Promise<GptRun>;

export interface GptMcpOptions {
  /** Pasta da sessão (o projeto ou a worktree): o GPT lê daqui e o `codex exec` roda aqui. */
  root: string;
  /** Pasta do projeto (onde fica `.vps`; numa worktree é outra pasta que `root`). */
  projectPath: string;
  /** Pasta pessoal do usuário (`~/.ssh` fica negada). */
  home?: string;
  /** Pasta de dados do Claudio’s Club (`secrets` fica negada; o config.json também é lido daqui). */
  mycoHome?: string;
  run?: GptRunner;
  timeoutMs?: number;
  /** Onde ficam os arquivos temporários (os testes trocam). */
  tmpRoot?: string;
}

// ---- processo ----

/** Argumento entre aspas para o cmd.exe (o `codex` do npm no Windows é um .cmd, que só abre por shell): `"` vira `\"`. */
export function windowsArg(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/**
 * Abre o `codex`. Sem shell, exceto no Windows (o `codex.cmd` do npm não abre de outro jeito; os argumentos vão entre aspas).
 * Sem prazo (10 min), o processo e os comandos que ele abriu são encerrados. No Unix ele vira líder de grupo: matar o grupo leva todos.
 */
export const spawnCodex: GptRunner = (args, input, o) =>
  new Promise((resolve) => {
    const win = process.platform === 'win32';
    let stdout = '';
    // O cabeçalho (modelo) vem no começo do stderr e o erro, no fim: guarda o começo e, passado o limite, só o fim.
    let stderr = '';
    let stderrTail = '';
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: GptRun) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ ...r, stderr: r.stderr + stderrTail });
    };
    try {
      const child = spawn('codex', win ? args.map(windowsArg) : args, {
        cwd: o.cwd,
        env: codexEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: win,
        windowsHide: true,
        detached: !win,
      });
      timer = setTimeout(() => {
        if (child.pid) void killTree(child.pid);
        else child.kill();
        finish({ code: null, stdout, stderr, timedOut: true });
      }, o.timeoutMs);
      child.stdin.on('error', () => {}); // o codex pode sair antes de ler o prompt inteiro
      child.stdin.end(input);
      child.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString('utf8')).slice(-1_000_000)));
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 20_000) stderr += d.toString('utf8');
        else stderrTail = (stderrTail + d.toString('utf8')).slice(-8_000);
      });
      child.on('error', (err: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, spawnError: err }));
      child.on('close', (code) => finish({ code, stdout, stderr }));
    } catch (err) {
      finish({ code: null, stdout, stderr, spawnError: err as NodeJS.ErrnoException });
    }
  });

// ---- a pergunta ----

const Ask = z.object({
  pergunta: z.string({ required_error: 'informe a pergunta' }).trim().min(1, 'informe a pergunta').max(MAX_QUESTION, `pergunta grande demais (máx. ${MAX_QUESTION} caracteres)`),
  contexto: z.string().trim().max(MAX_CONTEXT, `contexto grande demais (máx. ${MAX_CONTEXT} caracteres)`).optional(),
  esforco: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(EFFORTS, { errorMap: () => ({ message: `esforço: ${EFFORTS.join(', ')}` }) }).optional()),
});
type AskInput = z.infer<typeof Ask>;

export const TOOLS = [
  {
    name: GPT_TOOL_NAME,
    description:
      'Pergunta ao GPT (OpenAI, pelo Codex) uma opinião independente: decisão que pesa (arquitetura, escolher entre caminhos, trade-off) ou revisão de algo arriscado. ' +
      'O GPT lê o projeto (pasta da sessão) em só leitura, sem rede, e não altera nada; ele não vê esta conversa, então ponha a decisão, as opções e o que já se sabe (caminhos de arquivo, restrições). ' +
      'Demora de 15 s a alguns minutos e gasta a cota ChatGPT do usuário: use em decisão que pesa, não em dúvida pequena. A resposta é do GPT: compare com a sua e, se discordarem, mostre as duas ao usuário.',
    inputSchema: {
      type: 'object',
      properties: {
        pergunta: { type: 'string', description: 'A decisão ou o que revisar, com as opções (o GPT não vê esta conversa).' },
        contexto: { type: 'string', description: 'O que já se sabe: objetivo, arquivos (caminho), restrições, o que já foi decidido. Opcional.' },
        esforco: { type: 'string', enum: [...EFFORTS], description: `Quanto o GPT pensa (padrão ${DEFAULT_EFFORT}). Mais alto demora mais.` },
      },
      required: ['pergunta'],
    },
  },
];

/** O prompt do GPT: o pedido e as regras (só leitura, sem segredos, resposta curta). */
export function buildAskPrompt(a: Pick<AskInput, 'pergunta' | 'contexto'>): string {
  return [
    'Você é um consultor técnico independente. Outro assistente de IA (Claude), que está trabalhando no projeto da pasta atual, pede a sua opinião. Você não vê a conversa dele: tudo o que precisa está abaixo, e pode ler arquivos do projeto (só leitura) para conferir.',
    'Não altere nada e não rode comandos que mudem arquivos, dados ou servidores. Não leia nem repita o conteúdo de .env, chaves, tokens ou senhas.',
    'Responda em português do Brasil, curto, em Markdown: 1) recomendação; 2) por quê; 3) riscos e o que conferir antes. Se faltar informação, diga qual e dê a melhor recomendação mesmo assim. Seja direto: discorde de uma premissa se ela parecer errada.',
    `## Pergunta\n${a.pergunta}`,
    a.contexto ? `## Contexto\n${a.contexto}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Argumentos depois de `codex`: só leitura, sem rede, ephemeral, a resposta final em `out`, o prompt pelo stdin (`-`). */
export function buildAskArgs(o: { cwd: string; projectPath: string; home: string; mycoHome: string; out: string; effort: string; model: string | null }): string[] {
  return [
    'exec',
    ...(o.model ? ['-m', o.model] : []),
    '-c',
    `model_reasoning_effort=${tomlString(o.effort)}`,
    ...codexSafetyArgs({ mode: 'read-only', network: 'off', cwd: o.cwd, projectPath: o.projectPath, home: o.home, mycoHome: o.mycoHome }),
    '--ephemeral',
    '--skip-git-repo-check',
    '--color',
    'never',
    '-C',
    o.cwd,
    '-o',
    o.out,
    '-',
  ];
}

const lastLine = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 300) ?? '';
/** O modelo que o Codex usou, do cabeçalho que ele imprime no stderr (`model: gpt-6-astra`). */
const modelOf = (stderr: string) => /^model:\s*(\S+)/m.exec(stderr)?.[1] ?? null;

// ---- servidor ----

export function createGptMcp(opts: GptMcpOptions) {
  const run = opts.run ?? spawnCodex;
  const timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT;
  const home = opts.home ?? os.homedir();
  const mycoHome = opts.mycoHome ?? MYCO_HOME;
  const configFile = path.join(mycoHome, 'config.json');
  /** A versão do Codex conferida uma vez e guardada por 5 min (só o que deu certo): o mesmo `CodexEnv` do motor, pelo mesmo runner. */
  const codexEnv = new CodexEnv((args, input, ms) => run(args, input, { cwd: opts.root, timeoutMs: ms }));

  /** O catálogo da conta para o plano B (`codex debug models`); sem ele, null. */
  async function catalog() {
    const r = await run(['debug', 'models'], '', { cwd: opts.root, timeoutMs: MODELS_TIMEOUT }).catch(() => null);
    return r && r.code === 0 ? parseCodexModels(r.stdout) : null;
  }

  async function ask(a: AskInput): Promise<string> {
    // Relida a cada chamada: desligar o Codex nas configurações corta o acesso na hora (e trocar o modelo vale já).
    const config = await readConfig(configFile);
    if (!config.codexReview) throw new GptError('o Codex está desligado nas configurações do Claudio’s Club: peça ao usuário para ligar "Usar o Codex (GPT)"');
    const wanted = config.codexModel.trim() || null;
    const sent = findSecret(`${a.pergunta}\n${a.contexto ?? ''}`);
    if (sent) throw new GptError(`o pedido tem ${sent.label}: não mandei ao GPT. Tire o segredo do texto e pergunte de novo`);
    // Codex ausente, sem versão legível ou velho demais: a mesma mensagem do motor (com como atualizar), e nada roda.
    const env = await codexEnv.status();
    if (env.error) throw new GptError(env.error);

    const dir = await fs.mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), 'myco-gpt-'));
    const out = path.join(dir, 'resposta.md');
    const prompt = buildAskPrompt(a);
    const effort = a.esforco ?? DEFAULT_EFFORT;
    const once = async (model: string | null) => {
      await fs.rm(out, { force: true });
      const r = await run(buildAskArgs({ cwd: opts.root, projectPath: opts.projectPath, home, mycoHome, out, effort, model }), prompt, { cwd: opts.root, timeoutMs });
      const answer = (await fs.readFile(out, 'utf8').catch(() => '')).trim() || (r.code === 0 ? r.stdout.trim() : '');
      return { r, answer };
    };

    try {
      let model = wanted;
      let notice = '';
      let { r, answer } = await once(model);
      // Plano B: a conta não aceita o modelo escolhido. Uma nova tentativa com o mais parecido do catálogo (ou sem `-m`: o padrão do Codex).
      if (!answer && wanted && !r.timedOut && !r.spawnError && (isModelUnavailable(`${r.stderr}\n${r.stdout}`) || /model_not_found/i.test(r.stderr))) {
        const substitute = pickCodexSubstitute(wanted, (await catalog()) ?? []);
        model = substitute;
        notice = `\n\nAviso: o modelo ${wanted} não está disponível na sua conta do Codex; usei ${substitute ?? 'o padrão do Codex'} nesta pergunta. Troque o modelo nas configurações (Usar o Codex).`;
        ({ r, answer } = await once(substitute));
      }
      if (!answer) {
        if (r.spawnError?.code === 'ENOENT' || r.code === 9009 || r.code === 127) throw new GptError('o Codex CLI não está instalado (npm i -g @openai/codex): avise o usuário');
        if (r.timedOut) throw new GptError(`o GPT não respondeu em ${Math.round(timeoutMs / 60_000)} minutos: tente uma pergunta menor ou com menos esforço`);
        const why = lastLine(r.stderr) || (r.spawnError ? r.spawnError.message : `saída ${r.code}`);
        throw new GptError(`o Codex falhou${/login|auth|sign in|unauthorized/i.test(r.stderr) ? ' (sem login? o usuário precisa rodar `codex login`)' : ''}: ${why}`);
      }
      // O que volta passa pelo mesmo filtro de segredos das conversas: com cara de segredo, não vai para a sessão.
      const found = findSecret(answer);
      if (found) throw new GptError(`a resposta do GPT trazia ${found.label} e foi retida: peça de novo dizendo para não citar segredos`);
      const text = answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}\n\n… (resposta cortada)` : answer;
      return `Resposta do GPT (${model ?? modelOf(r.stderr) ?? 'padrão do Codex'}):\n\n${text}${notice}`;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function callTool(name: unknown, args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError && { isError: true as const }) });
    if (name !== GPT_TOOL_NAME) return text(`ferramenta desconhecida: ${String(name).slice(0, 60)}`, true);
    const parsed = Ask.safeParse(args ?? {});
    if (!parsed.success) return text(`argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ')}`, true);
    try {
      return text(await ask(parsed.data));
    } catch (err) {
      // Erro nosso já vem em palavras (e a recusa do bloqueio de segredos, também: ela diz qual caminho corrigir); o resto, sem detalhe.
      return text(err instanceof GptError || err instanceof CodexBlockedError ? err.message : 'falha inesperada no MCP do GPT', true);
    }
  }

  type Msg = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const reply = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  /** Uma mensagem JSON-RPC; devolve a resposta, ou null (notificação, ou resposta do cliente). */
  async function handle(raw: unknown): Promise<object | null> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(null, -32600, 'Invalid Request');
    const m = raw as Msg;
    if (!('method' in m) && ('result' in m || 'error' in m)) return null; // resposta do cliente: este servidor não pergunta nada
    const isRequest = 'id' in m && m.id !== null && (typeof m.id === 'string' || typeof m.id === 'number');
    if (typeof m.method !== 'string') return isRequest ? fail(m.id, -32600, 'Invalid Request') : null;
    if (!isRequest) return null; // notifications/initialized, cancelled…
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion;
        return reply(m.id, {
          protocolVersion: typeof asked === 'string' && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: GPT_MCP_NAME, version: VERSION },
          instructions: 'Opinião do GPT (OpenAI, pelo Codex) do Claudio’s Club: só leitura, sem rede. Use em decisão que pesa e compare a resposta com a sua.',
        });
      }
      case 'ping':
        return reply(m.id, {});
      case 'tools/list':
        return reply(m.id, { tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (name !== GPT_TOOL_NAME) return fail(m.id, -32602, `ferramenta desconhecida: ${String(name).slice(0, 60)}`);
        return reply(m.id, await callTool(name, m.params?.arguments));
      }
      default:
        return fail(m.id, -32601, `método não suportado: ${m.method.slice(0, 60)}`);
    }
  }

  return { handle, callTool };
}

/** Lê `--chave valor` dos argumentos. */
function argOf(argv: string[], key: string): string | undefined {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Sobe o MCP no stdin/stdout (uma mensagem JSON por linha). Log só no stderr. */
export async function runGptMcpStdio(argv: string[], input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const projectPath = argOf(argv, '--project');
  const root = argOf(argv, '--root') ?? projectPath;
  if (!projectPath || !path.isAbsolute(projectPath) || !root || !path.isAbsolute(root)) throw new Error('uso: --project <pasta absoluta> [--root <pasta>] [--home <pasta>] [--myco-home <pasta>]');
  const home = argOf(argv, '--home');
  const mycoHome = argOf(argv, '--myco-home');
  const server = createGptMcp({ projectPath, root, ...(home && { home }), ...(mycoHome && { mycoHome }) });
  const pending = new Set<Promise<void>>();
  const write = (obj: object | null) => {
    if (obj) output.write(JSON.stringify(obj) + '\n');
  };
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const raw of lines) {
    const line = raw.replace(/^﻿/, ''); // BOM (pipe do PowerShell 5.1)
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    // Em paralelo: uma pergunta longa não segura o ping.
    const p = server.handle(msg).then(write, (err: unknown) => {
      process.stderr.write(`[myco-gpt] ${err instanceof Error ? err.name : 'erro'}\n`);
      const id = (msg as { id?: unknown })?.id;
      if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
}

// ---- como o funcionário sobe este MCP ----

/** Pacote gerado pelo build (scripts/bundle.ts); sem ele (dev), o .ts pelo tsx. */
export const GPT_MCP_BUNDLE = path.join(ROOT, 'dist', 'gpt-mcp.mjs');
export const GPT_MCP_ENTRY = path.join(ROOT, 'server', 'gpt-mcp.ts');

/** node + o que rodar: o pacote quando o servidor roda empacotado e ele existe; senão o .ts com o tsx. */
export function gptMcpCommand(bundled = !import.meta.url.endsWith('.ts')): { command: string; args: string[] } {
  if (bundled && existsSync(GPT_MCP_BUNDLE)) return { command: process.execPath, args: [GPT_MCP_BUNDLE] };
  const tsx = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return { command: process.execPath, args: ['--import', tsx, GPT_MCP_ENTRY] };
}

/** A entrada do mcpConfig: só caminhos (nada de segredo; a credencial é o login do Codex da própria máquina). */
export function gptMcpServerConfig(o: { projectPath: string; root: string; home?: string; mycoHome?: string }) {
  const { command, args } = gptMcpCommand();
  return {
    type: 'stdio',
    command,
    args: [...args, '--project', o.projectPath, '--root', o.root, '--home', o.home ?? os.homedir(), '--myco-home', o.mycoHome ?? MYCO_HOME],
  };
}
