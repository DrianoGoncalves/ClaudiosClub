import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BackgroundTask, ChatItem, TurnRetryNotice } from '../../shared/model';
import { writeAtomic } from '../staff/store';
import type { RetryInfo } from './autoContinue';
import { wakeClock } from './wake';

// Retomada automática de um turno que caiu por causa passageira (API sobrecarregada, 5xx, limite de taxa, falha de conexão) ou
// porque o processo morreu no meio. Aqui só o que não precisa de processo: classificar o erro, o backoff, o orçamento por turno
// (guardado em disco) e os textos. Quem decide (opção, ação externa cortada, despertador, parada) é o ChatManager; quem espera
// o horário e manda a mensagem é uma instância do AutoContinue (ver autoContinue.ts).

/** Tentativas por turno original quando o erro é passageiro (o "continue" automático não abre orçamento novo). */
export const MAX_ATTEMPTS = 3;
/** Processo que morreu no meio do turno, sem causa conhecida: no máximo uma tentativa. */
export const MAX_ATTEMPTS_UNKNOWN = 1;
/** Espera antes da tentativa 1, 2 e 3. */
export const BACKOFF_MS = [30_000, 120_000, 480_000] as const;
/** Variação aleatória do backoff (±20%): várias conversas que caem juntas não voltam juntas. */
export const JITTER = 0.2;
/** `Retry-After` maior que isto não é falha passageira (parece cota): não retoma sozinho. */
export const MAX_RETRY_AFTER_MS = 15 * 60_000;

/** O erro como o motor o deu: o texto do turno/do modelo (nunca a saída de uma ferramenta), o status HTTP e o tipo, se vieram. */
export interface TurnError {
  text: string;
  status?: number | null;
  kind?: string | null;
}

/** O que o processo sabe no instante em que o turno acaba, lido antes de limpar o estado (a decisão é assíncrona). */
export interface TurnContext {
  /** Cópia dos itens: as ferramentas sem resultado dizem o que ficou pela metade (ver cutAction.ts). */
  items: ChatItem[];
  /** Havia pedido de permissão ou pergunta sem resposta. */
  awaitingAnswer: boolean;
  /** O que ainda rodava em segundo plano (agents, comandos). */
  background: BackgroundTask[];
}

/**
 * Como um turno acabou, para quem decide retomar. `ok`: terminou bem (zera o orçamento). `failed`: o motor devolveu o erro do turno
 * (Claude: `result` com `is_error`; Codex: `turn.failed`). `lost`: o processo saiu no meio de um turno ocupado, sem fechamento
 * intencional e sem término (Claude: saída sem `result`; Codex: a execução fechou sem `turn.completed` nem `turn.failed`).
 * Turno parado por você (Parar, interrupção, fechamento) não chega aqui.
 */
export type TurnEnd = { kind: 'ok' } | ({ kind: 'failed' | 'lost'; error: TurnError } & TurnContext);

export interface Transient {
  /** Espera mínima pedida pelo serviço (`Retry-After`), em ms; null = nenhuma. */
  retryAfterMs: number | null;
  /** Em poucas palavras, para o aviso. */
  label: string;
}

// Tudo que não vale tentar de novo: autenticação, permissão, cobrança e cota, pedido ou modelo inválido, conteúdo, limite de uso da
// assinatura (que tem o fluxo próprio, ver usageLimit.ts) e o que é do próprio turno (máximo de turnos, de orçamento, de saída).
const NOT_TRANSIENT =
  /unauthori[sz]ed|authenticat|invalid[ _-]?api[ _-]?key|\b40[1-4]\b|forbidden|permission|credit balance|billing|insufficient[ _]quota|quota|usage[ _]limit|(?<!rate[ _-])limit reached|hit your (?:\w+ )?limit|\bresets? (?:at|in)\b|weekly|invalid[ _]request|prompt is too long|context[ _](?:length|window)|content[ _]policy|refus|model[ _]not[ _]found|max[ _](?:output|turns|budget)/i;
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const TRANSIENT_KIND = /\b(?:server_error|overloaded(?:_error)?|api_error|timeout(?:_error)?|rate_limit(?:_error)?)\b/i;
const TRANSIENT_TEXT =
  /overloaded|\b(?:500|502|503|504|529)\b|service unavailable|bad gateway|gateway time-?out|internal server error|high demand|temporar(?:y|ily) (?:error|unavailable)|request timed out|timed out|connection (?:error|reset|closed|lost)|\bECONN(?:RESET|ABORTED)\b|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|stream disconnected|network error|rate[ _-]?limit/i;
/** `API Error: 529 …`, `last status: 503`, `"status":429`. */
const TEXT_STATUS = /(?:API Error:?|last status:?|status["']?\s*[:=]?)\s*(\d{3})\b/i;

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** O erro do Codex chega como JSON dentro do texto (`{"type":"error","status":429,"error":{…}}`); o do Claude, como "API Error: 529 {…}". */
function unpack(e: TurnError): { text: string; status: number | null; kind: string } {
  let text = e.text;
  let status = typeof e.status === 'number' ? e.status : null;
  let kind = e.kind ?? '';
  try {
    const outer = asRecord(JSON.parse(e.text));
    const inner = asRecord(outer.error);
    text = asString(inner.message) || asString(outer.message) || e.text;
    kind = [kind, asString(inner.type), asString(inner.code), asString(outer.type)].join(' ');
    if (status === null && typeof outer.status === 'number') status = outer.status;
  } catch {
    // texto simples
  }
  if (status === null) {
    const m = TEXT_STATUS.exec(e.text);
    if (m) status = Number(m[1]);
  }
  return { text, status, kind };
}

const SECONDS = /^(?:s|secs?|seconds?)$/i;
const MINUTES = /^(?:m|mins?|minutes?)$/i;

/** Quanto esperar pedido pelo próprio erro (`retry_after`, "Retry-After: 20", "try again in 1.5s"), em ms; null se não pediu. */
function retryAfterOf(text: string): number | null {
  const header = /retry[-_ ]?after(?:[-_ ]?ms)?["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i.exec(text);
  if (header) return Math.round(Number(header[1]) * (/retry[-_ ]?after[-_ ]?ms/i.test(header[0]) ? 1 : 1000));
  const again = /try again in (\d+(?:\.\d+)?)\s*(ms|milliseconds?|[a-z]+)/i.exec(text);
  if (!again) return null;
  const n = Number(again[1]);
  const unit = again[2]!;
  if (/^(?:ms|milliseconds?)$/i.test(unit)) return Math.round(n);
  if (SECONDS.test(unit)) return Math.round(n * 1000);
  if (MINUTES.test(unit)) return Math.round(n * 60_000);
  return null;
}

function labelOf(status: number | null, hay: string): string {
  if (status === 529 || /overloaded/i.test(hay)) return 'API sobrecarregada';
  if (status === 429 || /rate[ _-]?limit/i.test(hay)) return 'limite de taxa da API';
  if (status !== null && status >= 500) return `erro ${status} da API`;
  if (/high demand/i.test(hay)) return 'API com muita demanda';
  return 'falha de conexão com a API';
}

/**
 * O erro do turno é passageiro (vale tentar de novo)? Só olha o erro do turno/do modelo, nunca a saída de ferramenta. Precisa de um sinal
 * positivo (status 429/5xx/529, tipo de erro de servidor, ou texto de sobrecarga/transporte): erro desconhecido não retoma. Auth,
 * permissão, modelo, limite de uso, cota, conteúdo e configuração ficam de fora, mesmo com status 429.
 */
export function classifyTurnError(e: TurnError): Transient | null {
  const { text, status, kind } = unpack(e);
  const hay = `${kind} ${text}`;
  if (NOT_TRANSIENT.test(hay)) return null;
  if (status !== null ? !TRANSIENT_STATUS.has(status) : !(TRANSIENT_KIND.test(kind) || TRANSIENT_TEXT.test(text))) return null;
  const retryAfterMs = retryAfterOf(`${e.text}\n${text}`);
  if (retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS) return null;
  return { retryAfterMs, label: labelOf(status, hay) };
}

/** Tentativas que o tipo de falha permite no mesmo turno original. */
export const attemptsAllowed = (kind: RetryInfo['kind']): number => (kind === 'unknown' ? MAX_ATTEMPTS_UNKNOWN : MAX_ATTEMPTS);

/** Espera antes da tentativa `attempt` (1, 2, 3…): 30 s, 2 min, 8 min, com ±20% (`rand` devolve 0–1; os testes trocam). */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1]!;
  return Math.round(base * (1 + (rand() * 2 - 1) * JITTER));
}

/** O orçamento de um turno original: o id dele e quantas retomadas já foram agendadas. */
export interface RetryBudget {
  turnId: string;
  attempts: number;
  at: number;
}

const MAX_SESSIONS = 200;

/**
 * O orçamento de cada conversa, guardado em disco (sobrevive a reiniciar o servidor). Abre na primeira falha do turno e só fecha
 * quando um turno termina com sucesso real, ou quando você manda mensagem (turno original novo): o "continue" automático não
 * abre orçamento novo. Sem arquivo (testes), fica na memória.
 */
export class TurnRetryLedger {
  private readonly data = new Map<string, RetryBudget>();
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly file: string | null = null) {
    if (!file) return;
    try {
      const raw = asRecord(JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')));
      for (const [sid, v] of Object.entries(asRecord(raw.sessions))) {
        const b = asRecord(v);
        if (typeof b.turnId === 'string' && b.turnId && typeof b.attempts === 'number' && Number.isInteger(b.attempts) && b.attempts >= 0 && typeof b.at === 'number') {
          this.data.set(sid, { turnId: b.turnId, attempts: b.attempts, at: b.at });
        }
      }
    } catch {
      // sem arquivo (ou estragado): começa vazio
    }
  }

  get(sessionId: string): RetryBudget | null {
    const b = this.data.get(sessionId);
    return b ? { ...b } : null;
  }

  /** Conta mais uma retomada agendada neste turno original (a primeira abre o turno) e devolve o orçamento. */
  take(sessionId: string, now: number): RetryBudget {
    const prev = this.data.get(sessionId);
    const next = { turnId: prev?.turnId ?? randomUUID(), attempts: (prev?.attempts ?? 0) + 1, at: now };
    this.data.set(sessionId, next);
    this.save();
    return { ...next };
  }

  /** Fecha o orçamento da conversa (turno com sucesso, ou mensagem sua). Devolve se havia. */
  clear(sessionId: string): boolean {
    const had = this.data.delete(sessionId);
    if (had) this.save();
    return had;
  }

  /** Grava em fila: duas mudanças juntas não se atropelam. */
  private save() {
    if (!this.file) return;
    const file = this.file;
    const sessions = [...this.data.entries()].sort((a, b) => a[1].at - b[1].at).slice(-MAX_SESSIONS);
    const text = JSON.stringify({ sessions: Object.fromEntries(sessions) }, null, 2) + '\n';
    this.saving = this.saving.then(() => writeAtomic(file, text)).catch(() => {});
  }

  /** Para os testes: espera a última gravação. */
  flush(): Promise<void> {
    return this.saving;
  }
}

/** Os avisos na conversa (o texto em português; a tela lê a tentativa e o horário de `Task.retry` e da lista de agendamentos). */
export const retryNotice = {
  waiting: (at: number, r: RetryInfo, label: string) => `Falha passageira (${label}). Tento de novo sozinho às ${wakeClock(at)}h (tentativa ${r.attempt} de ${r.max}).`,
  sent: (r: RetryInfo) => `Retomou sozinho (tentativa ${r.attempt} de ${r.max}).`,
  cancelled: 'Retomada automática cancelada.',
  failed: (error: string) => `Não deu para retomar sozinho (${error}). Mande uma mensagem quando quiser.`,
  /** Quando a opção desliga com a retomada marcada: sai sem mandar. */
  dropped: 'Retomada automática desligada: não vou retomar sozinho. Mande uma mensagem quando quiser.',
};

const FIELD_ERROR_MAX = 300;

/**
 * O mesmo aviso em campos (`retry` do item): a tela escreve a frase no idioma dela e faz a contagem por segundo e a hora local a
 * partir daqui, sem ler `retryNotice`. `state` é a mensagem de `retryNotice` que saiu; `r` dá `attempt`/`max` quando a pendência os
 * tem; `at` (epoch ms, UTC) só vale em `waiting`; `error` é cortado no tamanho que a tela aceita.
 */
export function retryField(state: TurnRetryNotice['state'], r?: RetryInfo, extra: { at?: number; error?: string } = {}): TurnRetryNotice {
  return {
    state,
    ...(r && { attempt: r.attempt, max: r.max }),
    ...(extra.at !== undefined && { at: extra.at }),
    ...(extra.error && { error: extra.error.slice(0, FIELD_ERROR_MAX) }),
  };
}
