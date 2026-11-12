import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StaffProfile } from '../shared/model';
import { appendSystemCost, systemCostsPath, type SystemCostRow } from './adapters/claude/costs';
import { cleanEnv, withoutMycoToken } from './auth';
import { killTree } from './chat/registry';
import { findSecret } from './chat/secrets';
import { MYCO_HOME } from './config';
import { MAX_SHOWCASE_BYTES, recordCheck, SHOWCASE_CHECK_PATH, SHOWCASE_PATH, unsafeShowcase } from './projectGuide';
import type { Reservation } from './resourceGate';
import { secretDenyRules } from './staff/ficha';
import { writeAtomic } from './staff/store';
import { UsageStopError } from './usageStop';

// Gerador da vitrine (ação `showcase` do guia): um `claude -p` oculto, sem funcionário, sem ficha e sem conversa.
// O agente só lê (Read, Glob, Grep) e devolve o HTML como resposta final; quem valida e grava é o servidor.
// Só motor Claude: o Codex não restringe a escrita a um arquivo.

const SHOWCASE_MODEL = 'sonnet';
/** Teto da geração inteira (todas as tentativas). Passou: o processo é morto e a vitrine falha. */
export const SHOWCASE_TIMEOUT_MS = 15 * 60_000;
/** Uma tentativa a mais, e só em falha transitória. A espera: 5 s, com jitter de até 5 s (5–10 s). */
const MAX_ATTEMPTS = 2;
const RETRY_BASE_MS = 5_000;
/** O que o gerador pode usar: só leitura. */
const TOOLS = ['Read', 'Glob', 'Grep'];
/** Negado além do que não está em TOOLS: escrita, rede, subagents e MCP. */
const BLOCKED_TOOLS = ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'mcp__*'];
/** Segredos que o Read não abre. `secretDenyRules` só nega .env quando a ficha tem servidor; aqui não há servidor. */
const EXTRA_READ_DENIES = ['Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)'];
/** Erros do `claude` que valem nova tentativa: sobrecarga, limite de taxa, 5xx. Limite de uso da conta não entra: tentar de novo não resolve. */
const TRANSIENT = /overloaded|rate[ _-]?limit|too many requests|\b429\b|\b5\d\d\b/i;

export interface ClaudeOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Um `claude` em andamento: `done` resolve quando ele sai (com o que escreveu); `kill` mata a árvore dele. */
export interface ClaudeRun {
  done: Promise<ClaudeOutput>;
  kill: () => void;
}

export type SpawnClaude = (args: string[], cwd: string, stdin: string) => ClaudeRun;

/**
 * Argumentos do `claude -p` do gerador. Sem `--allow-dangerously-skip-permissions` nem `--permission-prompt-tool`: nada
 * pergunta, e o que não está liberado é negado. `--max-turns` não existe nesta versão do CLI: o teto é o tempo.
 */
export function showcaseArgs(): string[] {
  // Perfil sem servidor (só `servers` é lido): secretDenyRules devolve as regras de sempre (chaves, cofre, memória pessoal, manual, programas remotos).
  const denied = [...secretDenyRules({ servers: [] } as unknown as StaffProfile), ...EXTRA_READ_DENIES, ...BLOCKED_TOOLS];
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    SHOWCASE_MODEL,
    '--tools',
    TOOLS.join(','),
    '--allowedTools',
    TOOLS.join(','),
    '--disallowedTools',
    denied.join(','),
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--strict-mcp-config',
    '--setting-sources',
    'user',
    '--no-session-persistence',
  ];
}

/** O `claude` de verdade: mesmo ambiente e mesmo modo de processo do chat (ver chat/process.ts), sem shell. */
export const spawnClaudeProcess: SpawnClaude = (args, cwd, stdin) => {
  const child = spawn('claude', args, {
    cwd,
    env: withoutMycoToken(cleanEnv()),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-2_000);
  });
  // O processo pode sair antes de ler o prompt inteiro: o erro de escrita não é da geração.
  child.stdin.on('error', () => {});
  child.stdin.end(stdin, 'utf8');
  const done = new Promise<ClaudeOutput>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return {
    done,
    kill: () => {
      if (child.pid) void killTree(child.pid);
    },
  };
};

/** Já há uma geração no projeto: a rota responde 409. */
export class ShowcaseBusyError extends Error {}

/** Recusada antes de começar: uso no limite (429) ou recursos ocupados, ou o servidor está fechando (503). */
export class ShowcaseRefusedError extends Error {
  constructor(
    message: string,
    readonly status: 429 | 503,
  ) {
    super(message);
  }
}

export type ShowcaseState = 'idle' | 'running' | 'done' | 'failed';

export interface ShowcaseInfo {
  state: ShowcaseState;
  startedAt?: string;
  finishedAt?: string;
  /** Motivo da falha, em pt-BR (só quando `failed`). */
  error?: string;
  /** Custo em USD que o `claude` informou (`total_cost_usd`), somado das tentativas. Ausente se ele não informou. */
  costUsd?: number;
}

export interface ShowcaseJob {
  projectId: string;
  /** Pasta do projeto (raiz: onde o agente lê e onde a página é gravada). */
  dir: string;
  /** O texto da ação: vai pelo stdin, nunca na linha de comando. */
  prompt: string;
  /** HEAD da hora de começar (vira a base da conferência, se a página for gravada); null fora de git. */
  head: string | null;
}

export interface ShowcaseRunnerDeps {
  spawnClaude: SpawnClaude;
  /** Trava de consumo (StaffService.checkUsage, motor claude): lança UsageStopError quando passou do limite. */
  checkUsage: (projectId: string) => Promise<void>;
  /** Gate de recursos (ResourceGate.reserve): a reserva vale até a geração terminar. */
  reserve: () => Promise<Reservation>;
  /** Teto da geração inteira (padrão: 15 min). */
  timeoutMs?: number;
  /** Espera entre tentativas (padrão: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Número entre 0 e 1 para o jitter (padrão: Math.random). */
  random?: () => number;
  /** Relógio em ms (padrão: Date.now). */
  now?: () => number;
  /** Ledger do gasto do Sistema (padrão: logs/system-costs.jsonl em MYCO_HOME); os testes trocam. */
  systemCostsFile?: string;
  /** Linha de log (padrão: console.log). Nunca leva o HTML nem o prompt. */
  log?: (line: string) => void;
}

export type ReadResult = { ok: true; result: string } | { ok: false; transient: boolean; reason: string };

function parseJsonObject(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  // O JSON é uma linha; se o CLI soltar algo antes, pega a última linha.
  for (const candidate of [text, text.slice(text.lastIndexOf('\n') + 1)]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // tenta a próxima
    }
  }
  return null;
}

/** A resposta de `claude -p --output-format json`: o texto do resultado, ou o motivo de não ter (e se vale tentar de novo). */
export function readResult(out: ClaudeOutput): ReadResult {
  const obj = parseJsonObject(out.stdout);
  if (!obj) return { ok: false, transient: true, reason: `o claude não devolveu resultado (código ${out.code ?? '?'})` };
  if (obj.is_error === true || obj.subtype !== 'success') {
    const text = [obj.result, obj.subtype, obj.api_error_status, obj.error].filter((v) => typeof v === 'string' || typeof v === 'number').join(' ');
    const transient = TRANSIENT.test(text);
    const sub = String(obj.subtype ?? 'erro');
    return { ok: false, transient, reason: transient ? `o claude falhou com erro temporário (${sub})` : `o claude respondeu com erro (${sub})` };
  }
  return typeof obj.result === 'string' ? { ok: true, result: obj.result } : { ok: false, transient: true, reason: 'o claude não devolveu o texto do resultado' };
}

/** O custo que o `claude` informou nesta tentativa (`total_cost_usd`), ou null se não veio. Não estima nada. */
function costOf(out: ClaudeOutput): number | null {
  const v = parseJsonObject(out.stdout)?.total_cost_usd;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Gasto de uma geração num modelo (uma linha do ledger, sem o que identifica a geração). */
type SpendRow = Omit<SystemCostRow, 'at' | 'projectId' | 'source'>;
const SPEND_FIELDS = ['costUsd', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const;

/** O que a geração gastou: `usd` (o total, para o status) e as linhas por modelo (para o ledger). */
interface Spend {
  usd: number | null;
  rows: Map<string, SpendRow>;
}

/**
 * O gasto que o `claude` informou nesta tentativa. Um modelo só: o `usage` do total. Mais de um: o `modelUsage` de cada um.
 * Só números válidos. É o que o CLI informou; o ledger recalcula o custo pelos tokens.
 */
function spendOf(out: ClaudeOutput): SpendRow[] {
  const obj = parseJsonObject(out.stdout);
  if (!obj) return [];
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const models = Object.entries(rec(obj.modelUsage));
  if (models.length > 1) {
    return models.map(([model, v]) => {
      const u = rec(v);
      return {
        model,
        costUsd: num(u.costUSD),
        inputTokens: num(u.inputTokens),
        outputTokens: num(u.outputTokens),
        cacheReadTokens: num(u.cacheReadInputTokens),
        cacheCreationTokens: num(u.cacheCreationInputTokens),
      };
    });
  }
  const u = rec(obj.usage);
  return [
    {
      model: models[0]?.[0],
      costUsd: costOf(out) ?? undefined,
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheCreationTokens: num(u.cache_creation_input_tokens),
    },
  ];
}

/** Soma uma tentativa no gasto da geração, por modelo (retry conta tudo o que foi pago). */
function tally(rows: Map<string, SpendRow>, r: SpendRow): void {
  const acc: SpendRow = rows.get(r.model ?? '') ?? (r.model ? { model: r.model } : {});
  for (const f of SPEND_FIELDS) {
    const v = r[f];
    if (v !== undefined) acc[f] = (acc[f] ?? 0) + v;
  }
  rows.set(r.model ?? '', acc);
}

/**
 * O HTML da resposta: do `<!doctype html>` (ou `<html`) até o último `</html>`, sem o texto em volta nem as cercas de código.
 * Não usa toLowerCase para achar as posições: ele pode mudar o tamanho da string e deslocar os índices.
 */
export function extractShowcase(text: string): string | null {
  const open = /<!doctype html|<html[\s>]/i.exec(text);
  const closes = [...text.matchAll(/<\/html\s*>/gi)];
  const last = closes.at(-1);
  if (!open || !last) return null;
  const end = last.index! + last[0].length;
  return end > open.index ? text.slice(open.index, end) : null;
}

/** Motivo para recusar o HTML (null: pode gravar). A página abre numa CSP que bloqueia script e recurso externo; aqui a conferência é a primeira barreira. */
export function showcaseRefusal(html: string): string | null {
  if (Buffer.byteLength(html, 'utf8') > MAX_SHOWCASE_BYTES) return 'a página passou de 5 MB';
  if (/<script/i.test(html)) return 'a página tem <script>';
  if (/<iframe/i.test(html)) return 'a página tem <iframe>';
  if (/<object/i.test(html)) return 'a página tem <object>';
  if (/<embed/i.test(html)) return 'a página tem <embed>';
  if (/[\s"'/]on\w+\s*=/i.test(html)) return 'a página tem atributo de evento (on…=)';
  if (unsafeShowcase(html)) return 'a página tem <link>, <base> ou <meta http-equiv>';
  return null;
}

/** Espera antes da próxima tentativa: 5 s na primeira, 10 s na segunda, com jitter de até a base. */
export function retryDelay(attempt: number, random: () => number): number {
  return RETRY_BASE_MS * 2 ** (attempt - 1) + Math.floor(random() * RETRY_BASE_MS);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Uma geração por projeto, em segundo plano. `start` confere o uso e reserva o gate (429/503) e só então devolve;
 * a geração segue e grava a página (ou falha, com o motivo em `status`). Nada é gravado antes da validação.
 */
export class ShowcaseRunner {
  private readonly states = new Map<string, ShowcaseInfo>();
  private readonly jobs = new Map<string, Promise<void>>();
  /** Como parar a geração de cada projeto (tempo esgotado, desligamento): mata o processo atual e guarda o motivo. */
  private readonly cutters = new Map<string, (why: string) => void>();
  private closing = false;

  constructor(private readonly deps: ShowcaseRunnerDeps) {}

  status(projectId: string): ShowcaseInfo {
    return this.states.get(projectId) ?? { state: 'idle' };
  }

  /** A geração atual do projeto (ou a última) termina. Para testes e para o desligamento. */
  settled(projectId: string): Promise<void> {
    return this.jobs.get(projectId) ?? Promise.resolve();
  }

  async start(job: ShowcaseJob): Promise<void> {
    const { projectId } = job;
    if (this.closing) throw new ShowcaseRefusedError('o servidor está reiniciando: tente de novo daqui a pouco', 503);
    if (this.status(projectId).state === 'running') throw new ShowcaseBusyError('a vitrine já está sendo gerada');
    // Marca antes de qualquer await: uma chamada em paralelo já encontra a geração e sai com 409.
    const before = this.states.get(projectId);
    this.states.set(projectId, { state: 'running', startedAt: this.iso(this.now()) });
    let reservation: Reservation;
    try {
      await this.deps.checkUsage(projectId);
      reservation = await this.deps.reserve();
    } catch (err) {
      this.restore(projectId, before);
      if (err instanceof UsageStopError) throw new ShowcaseRefusedError(err.message, 429);
      throw err;
    }
    if (!reservation.ok) {
      this.restore(projectId, before);
      throw new ShowcaseRefusedError(reservation.reason, 503);
    }
    this.jobs.set(projectId, this.execute(job, reservation.release));
  }

  /** Desligando o servidor: não começa outra, mata a que roda e espera as que estão rodando sair. */
  async stopAll(): Promise<void> {
    this.closing = true;
    for (const stop of this.cutters.values()) stop('parado: o servidor está fechando');
    await Promise.all([...this.jobs.values()]);
  }

  private async execute(job: ShowcaseJob, release: () => void): Promise<void> {
    const started = this.now();
    const spend: Spend = { usd: null, rows: new Map() };
    try {
      let error: string | null = null;
      try {
        const html = await this.generate(job, spend);
        await this.write(job, html);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      // Done ou failed: o que foi gasto entra no ledger (a falha de gravação não derruba nada).
      await this.record(job, spend);
      this.finish(job, started, error, spend.usd);
    } finally {
      release();
    }
  }

  /** As tentativas (com a espera entre elas), o tempo máximo e a validação. Lança com o motivo da falha. */
  private async generate(job: ShowcaseJob, spend: Spend): Promise<string> {
    const cut = { why: null as string | null };
    const cutWhy = (): string | null => cut.why;
    let current: ClaudeRun | null = null;
    const stop = (why: string) => {
      cut.why ??= why;
      current?.kill();
    };
    const timer = setTimeout(() => stop('tempo esgotado (15 min)'), this.deps.timeoutMs ?? SHOWCASE_TIMEOUT_MS);
    this.cutters.set(job.projectId, stop);
    try {
      for (let attempt = 1; ; attempt++) {
        if (cutWhy() || this.closing) throw new Error(cutWhy() ?? 'parado: o servidor está fechando');
        current = this.deps.spawnClaude(showcaseArgs(), job.dir, job.prompt);
        let out: ClaudeOutput;
        try {
          out = await current.done;
        } catch (err) {
          throw new Error(`não foi possível iniciar o claude: ${err instanceof Error ? err.message : String(err)}`);
        }
        const cost = costOf(out);
        if (cost !== null) spend.usd = (spend.usd ?? 0) + cost;
        for (const r of spendOf(out)) tally(spend.rows, r);
        if (cutWhy()) throw new Error(cutWhy()!);
        const r = readResult(out);
        if (!r.ok) {
          if (r.transient && attempt < MAX_ATTEMPTS) {
            await (this.deps.sleep ?? defaultSleep)(retryDelay(attempt, this.deps.random ?? Math.random));
            continue;
          }
          throw new Error(r.reason);
        }
        const html = extractShowcase(r.result);
        if (!html) throw new Error('a resposta não traz o HTML (de <!doctype html> até </html>)');
        const refusal = showcaseRefusal(html);
        if (refusal) throw new Error(`o HTML foi recusado: ${refusal}`);
        // Só o tipo do achado sai daqui: o valor do segredo não vai para a mensagem nem para o log.
        const secret = findSecret(html);
        if (secret) throw new Error(`a vitrine saiu com algo que parece segredo (${secret.label}): nada foi gravado; gere de novo`);
        return html;
      }
    } finally {
      clearTimeout(timer);
      this.cutters.delete(job.projectId);
    }
  }

  /**
   * Grava a página e, só depois, a base da conferência. Não sobrescreve link simbólico nem pasta: o lstat confere antes.
   */
  private async write(job: ShowcaseJob, html: string): Promise<void> {
    const file = path.join(job.dir, SHOWCASE_PATH);
    const st = await fs.lstat(file).catch(() => null);
    if (st && !st.isFile()) throw new Error(`${SHOWCASE_PATH} não é arquivo comum (link simbólico ou pasta): não gravei`);
    await writeAtomic(file, html + '\n');
    if (job.head) {
      await recordCheck(job.dir, job.head, SHOWCASE_CHECK_PATH).catch((err) => this.log(`[vitrine] projeto ${job.projectId}: não gravei a base: ${String(err)}`));
    }
  }

  /**
   * Uma linha por modelo no ledger do Sistema, com o que o `claude` informou (sem prompt, sem HTML).
   * Nunca lança: falha de gravação vira linha de log, e a geração segue.
   */
  private async record(job: ShowcaseJob, spend: Spend): Promise<void> {
    const file = this.deps.systemCostsFile ?? systemCostsPath(MYCO_HOME);
    const at = this.iso(this.now());
    for (const r of spend.rows.values()) {
      if (!SPEND_FIELDS.some((f) => r[f] !== undefined)) continue;
      try {
        await appendSystemCost(file, { at, projectId: job.projectId, source: 'vitrine', ...r });
      } catch (err) {
        this.log(`[vitrine] projeto ${job.projectId}: não gravei o custo no ledger do Sistema: ${String(err)}`);
      }
    }
  }

  private finish(job: ShowcaseJob, started: number, error: string | null, costUsd: number | null): void {
    const finishedAt = this.now();
    const secs = Math.round((finishedAt - started) / 1000);
    this.states.set(job.projectId, {
      state: error ? 'failed' : 'done',
      startedAt: this.iso(started),
      finishedAt: this.iso(finishedAt),
      ...(error ? { error } : {}),
      ...(costUsd !== null ? { costUsd } : {}),
    });
    const custo = costUsd !== null ? ` (custo US$ ${costUsd.toFixed(4).replace('.', ',')})` : '';
    this.log(error ? `[vitrine] projeto ${job.projectId}: falhou em ${secs} s${custo}: ${error}` : `[vitrine] projeto ${job.projectId}: página gravada em ${secs} s${custo}`);
  }

  private restore(projectId: string, before: ShowcaseInfo | undefined): void {
    if (before) this.states.set(projectId, before);
    else this.states.delete(projectId);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }
}
