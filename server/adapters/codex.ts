import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSecret } from '../chat/secrets';

// Codex CLI como ferramenta de segunda opinião: o Claude continua sendo o motor dos funcionários.
// Só `codex exec`, numa pasta temporária vazia, em só leitura e sem guardar sessão: o Codex recebe o
// diff por texto e não lê o projeto (as travas de segredo do Claude não valem para ele). O que vai
// para a OpenAI é só esse texto, e só quando você pede.

export class CodexError extends Error {}

export interface CodexRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Erro ao abrir o processo (ENOENT: o codex não está instalado). */
  spawnError?: NodeJS.ErrnoException;
  timedOut?: boolean;
}

/** Roda o `codex` com estes argumentos e esta entrada (os testes trocam). */
export type CodexRunner = (args: string[], input: string, timeoutMs: number) => Promise<CodexRun>;

export interface CodexStatus {
  available: boolean;
  /** Por que não dá para usar (sem o CLI, sem login). */
  reason: string | null;
}

export interface SecondOpinionInput {
  title: string;
  request: string;
  diff: string;
  truncated: boolean;
}

const STATUS_TTL = 5 * 60_000;
// Uma revisão pequena levou ~4 min no Codex CLI 0.165 (ele pensa bastante): folga até 8.
const REVIEW_TIMEOUT = 8 * 60_000;
const MAX_DIFF = 120_000;
const MAX_ANSWER = 20_000;
/** Uma nova tentativa, com espera exponencial e variação aleatória (falha passageira do CLI ou da rede). */
const RETRIES = 1;
const BACKOFF_MS = 2_000;
/** Disjuntor: depois de tantas falhas seguidas, para de tentar por um tempo (o Codex fora não trava a revisão). */
const BREAKER_FAILURES = 3;
const BREAKER_MS = 10 * 60_000;

/** Arquivos que nunca vão para o Codex, mesmo no diff. */
const SECRET_FILE = /(^|\/)(\.env(\.[^/]*)?|\.vps\/.*|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*)$/i;

export function defaultRunner(): CodexRunner {
  return (args, input, timeoutMs) =>
    new Promise((resolve) => {
      // No Windows o `codex` do npm é um .cmd: precisa do shell, e os argumentos vão entre aspas.
      const win = process.platform === 'win32';
      const child = spawn('codex', win ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '')}"` : a)) : args, {
        shell: win,
        windowsHide: true,
        env: codexEnv(),
      });
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (r: CodexRun) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ code: null, stdout, stderr, timedOut: true });
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, spawnError: err }));
      child.on('close', (code) => finish({ code, stdout, stderr }));
      child.stdin?.end(input);
    });
}

export class CodexAdapter {
  private status: { at: number; value: CodexStatus } | null = null;
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly run: CodexRunner = defaultRunner(),
    private readonly opts: { tmpRoot?: string; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
  ) {}

  /** Instalado e com login? `codex login status` sai com 0 quando há credencial. Guardado por 5 min. */
  async check(fresh = false): Promise<CodexStatus> {
    const now = this.now();
    if (!fresh && this.status && now - this.status.at < STATUS_TTL) return this.status.value;
    const r = await this.run(['login', 'status'], '', 15_000);
    // Sem o CLI: ENOENT sem shell; pelo cmd do Windows, saída 9009 (no sh, 127), com a mensagem na
    // página de código do console (o texto pode chegar com acento quebrado).
    const value: CodexStatus =
      r.spawnError?.code === 'ENOENT' || r.code === 9009 || r.code === 127 || /not recognized|reconhecido|command not found/i.test(r.stderr)
        ? { available: false, reason: 'o Codex CLI não está instalado (npm i -g @openai/codex)' }
        : r.code === 0
          ? { available: true, reason: null }
          : { available: false, reason: 'o Codex CLI está sem login (rode codex login)' };
    this.status = { at: now, value };
    return value;
  }

  /** Revisão do diff pelo Codex; devolve a resposta dele em Markdown. */
  async review(input: SecondOpinionInput): Promise<string> {
    if (this.now() < this.openUntil) throw new CodexError('o Codex falhou várias vezes seguidas: tente de novo em alguns minutos');
    const status = await this.check();
    if (!status.available) throw new CodexError(status.reason ?? 'o Codex não está disponível');
    const { prompt } = buildReviewPrompt(input);
    const dir = await fs.mkdtemp(path.join(this.opts.tmpRoot ?? os.tmpdir(), 'myco-codex-'));
    const out = path.join(dir, 'resposta.md');
    const args = ['exec', '-', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-C', dir, '-o', out];
    try {
      for (let attempt = 0; ; attempt++) {
        const r = await this.run(args, prompt, REVIEW_TIMEOUT);
        const answer = (await fs.readFile(out, 'utf8').catch(() => '')).trim() || (r.code === 0 ? r.stdout.trim() : '');
        if (answer) {
          this.failures = 0;
          return answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}\n\n… (resposta cortada)` : answer;
        }
        // Tempo esgotado não se repete (custaria de novo o mesmo tanto); o resto tenta mais uma vez.
        if (r.timedOut || attempt >= RETRIES) {
          this.fail();
          throw new CodexError(r.timedOut ? 'o Codex não respondeu em 8 minutos' : `o Codex falhou: ${lastLine(r.stderr) || `saída ${r.code}`}`);
        }
        await (this.opts.sleep ?? sleep)(BACKOFF_MS * 2 ** attempt + Math.random() * 1_000);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private fail() {
    this.failures++;
    if (this.failures >= BREAKER_FAILURES) {
      this.openUntil = this.now() + BREAKER_MS;
      this.failures = 0;
    }
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }
}

/**
 * O pedido ao Codex: o que a tarefa pediu e o diff, sem os arquivos de segredo. Com algo com cara
 * de segredo no que sobrou, recusa (não manda nada).
 */
export function buildReviewPrompt(input: SecondOpinionInput): { prompt: string; skipped: string[] } {
  const { diff, skipped } = withoutSecretFiles(input.diff);
  const hit = findSecret(diff);
  if (hit) throw new CodexError(`o diff tem ${hit.label}: não mandei ao Codex`);
  const cut = diff.length > MAX_DIFF;
  const body = cut ? diff.slice(0, MAX_DIFF) : diff;
  const prompt = [
    'Você é um revisor de código independente. Revise só o diff abaixo, comparando com o pedido. Não rode comandos nem procure arquivos: tudo o que precisa está aqui.',
    `Pedido: ${input.title}`,
    input.request.trim() ? input.request.trim() : '',
    'Responda em português do Brasil, em Markdown curto:',
    '- Bugs, do mais grave ao menos, cada um com o arquivo e a linha do diff e um cenário concreto de falha;',
    '- Riscos de segurança;',
    '- O que foge do pedido;',
    '- Estilo só quando atrapalha a leitura.',
    'Se não achar nada relevante, diga isso em uma linha.',
    input.truncated || cut ? 'Atenção: o diff foi cortado; não conclua sobre o que não aparece.' : '',
    skipped.length ? `Arquivos de segredo ficaram de fora do diff: ${skipped.join(', ')}.` : '',
    '```diff',
    body,
    '```',
  ]
    .filter(Boolean)
    .join('\n');
  return { prompt, skipped };
}

/** Tira do diff as seções de arquivos de segredo (.env, chaves, .vps). */
export function withoutSecretFiles(diff: string): { diff: string; skipped: string[] } {
  const parts = diff.split(/(?=^diff --git )/m);
  const skipped: string[] = [];
  const kept = parts.filter((p) => {
    const file = /^diff --git a\/(\S+) b\//.exec(p)?.[1];
    if (file && SECRET_FILE.test(file)) {
      skipped.push(file);
      return false;
    }
    return true;
  });
  return { diff: kept.join(''), skipped };
}

/** O ambiente do servidor sem o que é do Claude e do Claudio’s Club: o Codex usa o login dele (~/.codex). */
function codexEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC|CLAUDE|MYCO)_/i.test(k)));
}

function lastLine(s: string): string {
  return s.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 200) ?? '';
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
