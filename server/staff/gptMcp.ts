import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { GPT_MCP_NAME, GPT_TOOL_NAME } from '../../shared/model';
import { codexEnv } from '../adapters/codex';
import { CodexBlockedError, codexSafetyArgs, codexWindowsSandboxArgs, tomlString } from '../chat/codexArgs';
import { isModelUnavailable } from '../chat/codexEvents';
import { killTree } from '../chat/registry';
import { findSecret } from '../chat/secrets';
import { CodexEnv } from '../codexEnv';
import { parseCodexModels, pickCodexSubstitute } from '../codexModels';
import { MYCO_HOME, readConfig } from '../config';
import { ROOT } from '../root';

// MCP do Claudio’s Club que leva uma pergunta ao GPT: um servidor stdio (JSON-RPC por linha) que o Claude Code do funcionário sobe
// quando o Codex está ligado nas configurações (`codexReview`). A única ferramenta, `perguntar_gpt`, abre o `codex exec` por spawn
// (array de argumentos: nenhum shell no meio do texto da pergunta, que vai pelo stdin), só leitura, sem a config do usuário
// e sem os conectores da conta, com as pastas de segredo negadas (`codexSafetyArgs`, o mesmo bloqueio do motor Codex). A busca na web
// só existe se "Permitir acesso à internet" estiver ligado nas Configurações (`internetAccess`, lida a cada pergunta).
// Antes de abrir o `codex exec`, confere o Codex instalado com a mesma checagem do motor dos funcionários (`CodexEnv`: versão mínima), e recusa
// com a mesma mensagem se for velho demais. O `network_proxy` não importa aqui: o terminal da pergunta segue sem rede. Se o bloqueio de segredos não consegue
// provar que uma pasta secreta está protegida (`CodexBlockedError`), a ferramenta devolve esse texto como erro e não roda nada.
// Sem o SDK oficial, como o MCP de FTP: o protocolo usado é pequeno (initialize, ping, tools/list, tools/call e notifications/cancelled).
// Encerramento: o prazo de 10 min e a limpeza dos temporários só existem dentro deste processo, então quando o Claude Code o encerra
// (SIGTERM/SIGINT/SIGHUP, fim do stdin) ou cancela a chamada (notifications/cancelled), o `codex exec` em andamento é morto (o grupo todo:
// SIGTERM e, em 3 s, SIGKILL) e os temporários saem. Na subida, os `myco-gpt-*` com mais de 1 h (de um MCP que levou SIGKILL) são varridos.

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
  /** Encerrado por `signal` (cancelamento ou fim do MCP), não pelo próprio fim. */
  aborted?: boolean;
}

/** Roda o `codex` com estes argumentos e esta entrada, na pasta `cwd` (os testes trocam). `signal` aborta: o processo e o que ele abriu morrem. */
export type GptRunner = (args: string[], input: string, o: { cwd: string; timeoutMs: number; signal?: AbortSignal; graceMs?: number }) => Promise<GptRun>;

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

/** Depois do SIGTERM, quanto esperar antes do SIGKILL no grupo do codex. */
export const KILL_GRACE_MS = 3_000;

/** O que está vivo agora e precisa sumir mesmo se o MCP sair às pressas (`killLeftovers`, no evento `exit`). */
const liveChildren = new Set<ChildProcess>();
const liveTemps = new Set<string>();

/** Manda o sinal ao grupo do codex (no Unix ele é líder de grupo); sem o grupo, ao processo. No Windows, o taskkill é sempre à força. */
function signalTree(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return void child.kill(sig);
  if (process.platform === 'win32') return void killTree(pid);
  try {
    process.kill(-pid, sig);
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
  }
}

/** Último recurso, síncrono (evento `exit`): SIGKILL em todo codex vivo e apaga os temporários que ainda existem. */
export function killLeftovers(): void {
  for (const c of liveChildren) signalTree(c, 'SIGKILL');
  for (const d of liveTemps) rmSync(d, { recursive: true, force: true });
  liveChildren.clear();
  liveTemps.clear();
}

/** Varre os `myco-gpt-*` de mais de `maxAgeMs` (sobras de um MCP morto à força); só pastas suas, com o nome do mkdtemp. Devolve quantas apagou. */
export async function sweepStaleTemps(tmpRoot = os.tmpdir(), maxAgeMs = 60 * 60_000, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const name of await fs.readdir(tmpRoot).catch(() => [] as string[])) {
    if (!/^myco-gpt-[A-Za-z0-9]{6}$/.test(name)) continue;
    const dir = path.join(tmpRoot, name);
    try {
      const st = await fs.lstat(dir);
      if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs || (process.getuid && st.uid !== process.getuid())) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // sumiu no meio, ou sem permissão: segue
    }
  }
  return removed;
}

/**
 * Abre o `codex`. Sem shell, exceto no Windows (o `codex.cmd` do npm não abre de outro jeito; os argumentos vão entre aspas).
 * Sem prazo (10 min) ou com `signal` abortado, o processo e os comandos que ele abriu são encerrados: SIGTERM no grupo e, se sobrar
 * alguém depois de `graceMs`, SIGKILL. No Unix ele vira líder de grupo: matar o grupo leva todos.
 * Com `signal`, só devolve quando o processo fechou (o chamador pode apagar o que ele escrevia).
 */
export const spawnCodex: GptRunner = (args, input, o) =>
  new Promise((resolve) => {
    const win = process.platform === 'win32';
    const graceMs = o.graceMs ?? KILL_GRACE_MS;
    let stdout = '';
    // O cabeçalho (modelo) vem no começo do stderr e o erro, no fim: guarda o começo e, passado o limite, só o fim.
    let stderr = '';
    let stderrTail = '';
    let done = false;
    let aborted = false;
    let timer: NodeJS.Timeout | undefined;
    let giveUp: NodeJS.Timeout | undefined;
    const onAbort = () => abort();
    const finish = (r: GptRun) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (giveUp) clearTimeout(giveUp);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ ...r, stderr: r.stderr + stderrTail, ...(aborted && { aborted: true }) });
    };
    let child: ChildProcess | undefined;
    /** SIGTERM agora, SIGKILL em `graceMs` (o timer só some quando o processo fecha). */
    const terminate = () => {
      if (!child) return;
      const c = child;
      signalTree(c, 'SIGTERM');
      const hard = setTimeout(() => signalTree(c, 'SIGKILL'), graceMs);
      c.once('close', () => clearTimeout(hard));
    };
    function abort() {
      if (aborted || done) return;
      aborted = true;
      terminate();
      // O normal é o `close` resolver; se um neto segurar os pipes mesmo depois do SIGKILL, quem espera não fica preso.
      giveUp = setTimeout(() => finish({ code: null, stdout, stderr }), graceMs + 1_000);
    }
    if (o.signal?.aborted) {
      aborted = true;
      return finish({ code: null, stdout, stderr });
    }
    try {
      child = spawn('codex', win ? args.map(windowsArg) : args, {
        cwd: o.cwd,
        env: codexEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: win,
        windowsHide: true,
        detached: !win,
      });
      const c = child;
      liveChildren.add(c);
      c.once('close', () => liveChildren.delete(c));
      o.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        terminate();
        finish({ code: null, stdout, stderr, timedOut: true });
      }, o.timeoutMs);
      c.stdin!.on('error', () => {}); // o codex pode sair antes de ler o prompt inteiro
      c.stdin!.end(input);
      c.stdout!.on('data', (d: Buffer) => (stdout = (stdout + d.toString('utf8')).slice(-1_000_000)));
      c.stderr!.on('data', (d: Buffer) => {
        if (stderr.length < 20_000) stderr += d.toString('utf8');
        else stderrTail = (stderrTail + d.toString('utf8')).slice(-8_000);
      });
      c.on('error', (err: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, spawnError: err }));
      c.on('close', (code) => finish({ code, stdout, stderr }));
    } catch (err) {
      finish({ code: null, stdout, stderr, spawnError: err as NodeJS.ErrnoException });
    }
  });

// ---- a pergunta ----

const Ask = z.object({
  pergunta: z.string({ error: (iss) => (iss.input === undefined ? 'informe a pergunta' : undefined) }).trim().min(1, 'informe a pergunta').max(MAX_QUESTION, `pergunta grande demais (máx. ${MAX_QUESTION} caracteres)`),
  /** A preferência ou conclusão do chamador: o GPT a ataca, não a toma como fato. */
  hipotese: z.string().trim().max(MAX_QUESTION, `hipótese grande demais (máx. ${MAX_QUESTION} caracteres)`).optional(),
  contexto: z.string().trim().max(MAX_CONTEXT, `contexto grande demais (máx. ${MAX_CONTEXT} caracteres)`).optional(),
  esforco: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(EFFORTS, { error: `esforço: ${EFFORTS.join(', ')}` }).optional()),
});
type AskInput = z.infer<typeof Ask>;

export const TOOLS = [
  {
    name: GPT_TOOL_NAME,
    description:
      'Pergunta ao GPT (OpenAI, pelo Codex) uma opinião independente: decisão que pesa (arquitetura, escolher entre caminhos, trade-off) ou revisão de algo arriscado. ' +
      'O GPT lê o projeto (pasta da sessão) em só leitura e não altera nada; pesquisa na web só se "Permitir acesso à internet" estiver ligado nas Configurações. Ele não vê esta conversa, então ponha a decisão, as opções em termos neutros e o que já se sabe (caminhos de arquivo, restrições); a sua preferência vai em hipotese. ' +
      'Demora de 15 s a alguns minutos e gasta a cota ChatGPT do usuário: use em decisão que pesa, não em dúvida pequena. A resposta começa com um veredito (CONCORDO, CONCORDO COM RESSALVAS ou DISCORDO): mostre ao usuário o veredito e as divergências em 1-2 linhas, mesmo com ressalvas, e se discordarem mostre as duas posições.',
    inputSchema: {
      type: 'object',
      properties: {
        pergunta: { type: 'string', description: 'A decisão ou o que revisar, com as opções em termos neutros, sem a sua preferência (ela vai em hipotese). O GPT não vê esta conversa.' },
        hipotese: { type: 'string', description: 'A sua preferência ou conclusão, separada da pergunta: o GPT vai atacá-la, não tomá-la como fato. Opcional.' },
        contexto: { type: 'string', description: 'O que já se sabe: objetivo, arquivos (caminho), restrições, o que já foi decidido. Opcional.' },
        esforco: { type: 'string', enum: [...EFFORTS], description: `Quanto o GPT pensa (padrão ${DEFAULT_EFFORT}). Mais alto demora mais.` },
      },
      required: ['pergunta'],
    },
  },
];

/** O prompt do GPT: o pedido e as regras (só leitura, sem segredos, veredito na primeira linha, resposta curta). */
export function buildAskPrompt(a: Pick<AskInput, 'pergunta' | 'contexto' | 'hipotese'>): string {
  return [
    'Você é um consultor técnico independente. Outro assistente de IA (Claude), que está trabalhando no projeto da pasta atual, pede a sua opinião. Você não vê a conversa dele: tudo o que precisa está abaixo, e pode ler arquivos do projeto (só leitura) para conferir.',
    'Não altere nada e não rode comandos que mudem arquivos, dados ou servidores. Não leia nem repita o conteúdo de .env, chaves, tokens ou senhas.',
    'Responda em português do Brasil, curto, em Markdown, nesta ordem:\n' +
      '1) Primeira linha exatamente `Veredito: CONCORDO`, `Veredito: CONCORDO COM RESSALVAS` ou `Veredito: DISCORDO` (sobre a hipótese do chamador; sem hipótese, sobre a opção que parece preferida ou sobre a premissa da pergunta).\n' +
      '2) O argumento mais forte contra a hipótese ou a opção que você recomenda, mesmo que você concorde.\n' +
      '3) Uma alternativa que não está na pergunta (ou diga por que nenhuma é melhor).\n' +
      '4) Recomendação e o que você mudaria.\n' +
      '5) Riscos e o que conferir antes (confira no código o que puder; fatos do chamador podem estar errados ou desatualizados).\n' +
      'Não concorde por educação: concordar sem ter achado nada é a resposta menos útil. Se faltar informação para decidir, diga qual e se ela muda a recomendação.',
    `## Pergunta\n${a.pergunta}`,
    a.hipotese ? `## Hipótese do chamador (a atacar, não é fato)\n${a.hipotese}` : '',
    a.contexto ? `## Contexto\n${a.contexto}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export type Verdict = 'concordo' | 'ressalvas' | 'discordo';
const semAcento = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();

/** O veredito da linha `Veredito: ...` nas primeiras linhas da resposta (sem diferenciar maiúsculas nem acentos). RESSALVAS vence CONCORDO. */
export function parseVerdict(answer: string): Verdict | null {
  const line = answer.split(/\r?\n/).slice(0, 5).map(semAcento).find((l) => /^\W*VEREDITO\s*:/.test(l));
  if (!line) return null;
  if (line.includes('RESSALVAS')) return 'ressalvas';
  if (line.includes('CONCORDO')) return 'concordo';
  if (line.includes('DISCORDO')) return 'discordo';
  return null;
}

/** Uma linha por chamada, para medir (sem o texto da pergunta nem da resposta). Erro no log é engolido. */
export interface ConsultaLog {
  ts: string;
  project: string;
  effort: string;
  model: string | null;
  ok: boolean;
  verdict: Verdict | null;
  /** Caracteres de pergunta, hipótese e contexto somados. */
  questionChars: number;
  answerChars: number;
}
async function logConsulta(file: string, e: ConsultaLog): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.appendFile(file, JSON.stringify(e) + '\n')).catch(() => {});
}

/** Argumentos depois de `codex`: só leitura, terminal sem rede, busca na web só com `internetAccess`, ephemeral, a resposta final em `out`, o prompt pelo stdin (`-`). */
export function buildAskArgs(o: { cwd: string; projectPath: string; home: string; mycoHome: string; out: string; effort: string; model: string | null; internetAccess: boolean }): string[] {
  return [
    'exec',
    ...(o.model ? ['-m', o.model] : []),
    '-c',
    `model_reasoning_effort=${tomlString(o.effort)}`,
    ...codexSafetyArgs({ mode: 'read-only', network: 'off', webSearch: o.internetAccess, cwd: o.cwd, projectPath: o.projectPath, home: o.home, mycoHome: o.mycoHome }),
    ...codexWindowsSandboxArgs(),
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
  /** Vale pelo servidor todo: abortado no `shutdown`, leva junto a conferência de versão (que é compartilhada entre as perguntas). */
  const life = new AbortController();
  const codexEnv = new CodexEnv((args, input, ms) => run(args, input, { cwd: opts.root, timeoutMs: ms, signal: life.signal }));
  /** Chamadas `tools/call` em andamento: `notifications/cancelled` aborta uma; o `shutdown`, todas. */
  const inflight = new Set<{ id: unknown; ac: AbortController; done: Promise<unknown> }>();
  let closed = false;

  /** O catálogo da conta para o plano B (`codex debug models`); sem ele, null. */
  async function catalog(signal: AbortSignal) {
    const r = await run(['debug', 'models'], '', { cwd: opts.root, timeoutMs: MODELS_TIMEOUT, signal }).catch(() => null);
    return r && r.code === 0 ? parseCodexModels(r.stdout) : null;
  }

  /** O que o log precisa da chamada: o modelo que rodou e o tamanho da resposta (preenchido conforme a chamada anda). */
  interface Seen {
    model?: string | null;
    answer?: string;
  }

  async function ask(a: AskInput, signal: AbortSignal, seen: Seen): Promise<string> {
    const check = () => {
      if (signal.aborted) throw new GptError('pergunta cancelada');
    };
    // Relida a cada chamada: desligar o Codex nas configurações corta o acesso na hora (e trocar o modelo vale já).
    const config = await readConfig(configFile);
    if (!config.codexReview) throw new GptError('o Codex está desligado nas configurações do Claudio’s Club: peça ao usuário para ligar "Usar o Codex (GPT)"');
    const wanted = config.codexModel.trim() || null;
    const sent = findSecret(`${a.pergunta}\n${a.hipotese ?? ''}\n${a.contexto ?? ''}`);
    if (sent) throw new GptError(`o pedido tem ${sent.label}: não mandei ao GPT. Tire o segredo do texto e pergunte de novo`);
    // Codex ausente, sem versão legível ou velho demais: a mesma mensagem do motor (com como atualizar), e nada roda.
    const env = await codexEnv.status();
    check();
    if (env.error) throw new GptError(env.error);

    const dir = await fs.mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), 'myco-gpt-'));
    liveTemps.add(dir);
    const out = path.join(dir, 'resposta.md');
    const prompt = buildAskPrompt(a);
    const effort = a.esforco ?? DEFAULT_EFFORT;
    const once = async (model: string | null) => {
      check();
      await fs.rm(out, { force: true });
      const r = await run(buildAskArgs({ cwd: opts.root, projectPath: opts.projectPath, home, mycoHome, out, effort, model, internetAccess: config.internetAccess }), prompt, { cwd: opts.root, timeoutMs, signal });
      check(); // cancelada: o codex já fechou (o runner só devolve depois), a resposta não interessa e a pasta sai no finally
      const answer = (await fs.readFile(out, 'utf8').catch(() => '')).trim() || (r.code === 0 ? r.stdout.trim() : '');
      seen.model = model ?? modelOf(r.stderr);
      seen.answer = answer;
      return { r, answer };
    };

    try {
      let model = wanted;
      let notice = '';
      let { r, answer } = await once(model);
      // Plano B: a conta não aceita o modelo escolhido. Uma nova tentativa com o mais parecido do catálogo (ou sem `-m`: o padrão do Codex).
      if (!answer && wanted && !r.timedOut && !r.spawnError && (isModelUnavailable(`${r.stderr}\n${r.stdout}`) || /model_not_found/i.test(r.stderr))) {
        const substitute = pickCodexSubstitute(wanted, (await catalog(signal)) ?? []);
        check();
        model = substitute;
        notice = `\n\nAviso: o modelo ${wanted} não está disponível na sua conta do Codex; usei ${substitute ?? 'o padrão do Codex'} nesta pergunta. Troque o modelo nas configurações (Usar o Codex).`;
        ({ r, answer } = await once(substitute));
      }
      if (!answer) {
        if (r.spawnError?.code === 'ENOENT' || r.code === 9009 || r.code === 127) throw new GptError('o Codex CLI não está instalado: avise o usuário para ligar o Codex nas Configurações do Claudio’s Club');
        if (r.timedOut) throw new GptError(`o GPT não respondeu em ${Math.round(timeoutMs / 60_000)} minutos: tente uma pergunta menor ou com menos esforço`);
        const why = lastLine(r.stderr) || (r.spawnError ? r.spawnError.message : `saída ${r.code}`);
        throw new GptError(`o Codex falhou${/login|auth|sign in|unauthorized/i.test(r.stderr) ? ' (sem login? o usuário entra no Codex pelo Claudio’s Club)' : ''}: ${why}`);
      }
      // O que volta passa pelo mesmo filtro de segredos das conversas: com cara de segredo, não vai para a sessão.
      const found = findSecret(answer);
      if (found) throw new GptError(`a resposta do GPT trazia ${found.label} e foi retida: peça de novo dizendo para não citar segredos`);
      const text = answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}\n\n… (resposta cortada)` : answer;
      return `Resposta do GPT (${model ?? modelOf(r.stderr) ?? 'padrão do Codex'}):\n\n${text}${notice}`;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      liveTemps.delete(dir);
    }
  }

  async function callTool(name: unknown, args: unknown, signal: AbortSignal = new AbortController().signal): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError && { isError: true as const }) });
    if (name !== GPT_TOOL_NAME) return text(`ferramenta desconhecida: ${String(name).slice(0, 60)}`, true);
    const parsed = Ask.safeParse(args ?? {});
    if (!parsed.success) return text(`argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ')}`, true);
    const a = parsed.data;
    const seen: Seen = {};
    let ok = true;
    let out: ReturnType<typeof text>;
    try {
      out = text(await ask(a, signal, seen));
    } catch (err) {
      // Erro nosso já vem em palavras (e a recusa do bloqueio de segredos, também: ela diz qual caminho corrigir); o resto, sem detalhe.
      ok = false;
      out = text(err instanceof GptError || err instanceof CodexBlockedError ? err.message : 'falha inesperada no MCP do GPT', true);
    }
    await logConsulta(path.join(mycoHome, 'logs', 'gpt-consultas.jsonl'), {
      ts: new Date().toISOString(),
      project: opts.projectPath,
      effort: a.esforco ?? DEFAULT_EFFORT,
      model: seen.model ?? null,
      ok,
      verdict: ok && seen.answer !== undefined ? parseVerdict(seen.answer) : null,
      questionChars: a.pergunta.length + (a.hipotese?.length ?? 0) + (a.contexto?.length ?? 0),
      answerChars: seen.answer?.length ?? 0,
    });
    return out;
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
    if (!isRequest) {
      // O cliente desistiu da pergunta: o codex dela morre (o `tools/call` fica sem resposta, como manda o protocolo).
      if (m.method === 'notifications/cancelled') for (const e of inflight) if (e.id === m.params?.requestId) e.ac.abort();
      return null; // notifications/initialized…
    }
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion;
        return reply(m.id, {
          protocolVersion: typeof asked === 'string' && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: GPT_MCP_NAME, version: VERSION },
          instructions: 'Opinião do GPT (OpenAI, pelo Codex) do Claudio’s Club: só leitura; pesquisa na web se "Permitir acesso à internet" estiver ligado nas Configurações. Use em decisão que pesa e compare a resposta com a sua.',
        });
      }
      case 'ping':
        return reply(m.id, {});
      case 'tools/list':
        return reply(m.id, { tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (name !== GPT_TOOL_NAME) return fail(m.id, -32602, `ferramenta desconhecida: ${String(name).slice(0, 60)}`);
        const ac = new AbortController();
        if (closed) ac.abort();
        const work = callTool(name, m.params?.arguments, ac.signal);
        const entry = { id: m.id, ac, done: work.catch(() => undefined) };
        inflight.add(entry);
        try {
          const result = await work;
          return ac.signal.aborted ? null : reply(m.id, result); // cancelada (ou MCP encerrando): sem resposta
        } finally {
          inflight.delete(entry);
        }
      }
      default:
        return fail(m.id, -32601, `método não suportado: ${m.method.slice(0, 60)}`);
    }
  }

  /** Aborta o que está em andamento (cada codex morre e cada temporário sai) e espera isso terminar. Idempotente. */
  async function shutdown(): Promise<void> {
    closed = true;
    life.abort();
    const waiting = [...inflight];
    for (const e of waiting) e.ac.abort();
    await Promise.all(waiting.map((e) => e.done));
  }

  return { handle, callTool, shutdown };
}

/** Lê `--chave valor` dos argumentos. */
function argOf(argv: string[], key: string): string | undefined {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : undefined;
}

const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

/**
 * Sobe o MCP no stdin/stdout (uma mensagem JSON por linha). Log só no stderr.
 * Termina quando o stdin acaba (o Claude Code saiu): aí as perguntas em andamento são abortadas, cada codex morre e os temporários saem
 * antes de devolver. Com `handleSignals` (a entrada real), SIGTERM, SIGINT e SIGHUP fazem o mesmo; um segundo sinal sai na hora.
 */
export async function runGptMcpStdio(
  argv: string[],
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  o: { handleSignals?: boolean; tmpRoot?: string } = {},
): Promise<void> {
  const projectPath = argOf(argv, '--project');
  const root = argOf(argv, '--root') ?? projectPath;
  if (!projectPath || !path.isAbsolute(projectPath) || !root || !path.isAbsolute(root)) throw new Error('uso: --project <pasta absoluta> [--root <pasta>] [--home <pasta>] [--myco-home <pasta>]');
  const home = argOf(argv, '--home');
  const mycoHome = argOf(argv, '--myco-home');
  const server = createGptMcp({ projectPath, root, ...(home && { home }), ...(mycoHome && { mycoHome }), ...(o.tmpRoot && { tmpRoot: o.tmpRoot }) });
  void sweepStaleTemps(o.tmpRoot).catch(() => {}); // sobras de um MCP que levou SIGKILL
  const pending = new Set<Promise<void>>();
  output.on('error', () => {}); // o cliente já foi embora (EPIPE): não derruba o encerramento
  const write = (obj: object | null) => {
    if (obj) output.write(JSON.stringify(obj) + '\n');
  };
  const lines = createInterface({ input, crlfDelay: Infinity });
  let signaled = false;
  const onSignal = () => {
    if (signaled) process.exit(1); // segunda vez: sem esperar (o evento `exit` mata o que sobrou)
    signaled = true;
    setTimeout(() => process.exit(1), KILL_GRACE_MS + 4_000).unref(); // trava no encerramento: sai assim mesmo
    lines.close(); // o laço abaixo termina e o encerramento é o mesmo do fim do stdin
  };
  if (o.handleSignals) {
    for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
    process.on('exit', killLeftovers);
  }
  try {
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
  } finally {
    // Fim do stdin ou sinal: ninguém mais espera resposta, então nenhum codex fica para trás. Os sinais seguem tratados até aqui
    // (um segundo sinal durante a espera sai na hora, em vez de cair no padrão do Node, que não limparia nada).
    try {
      await server.shutdown();
    } finally {
      if (o.handleSignals) for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
    }
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
