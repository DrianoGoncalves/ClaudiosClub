import { z } from 'zod';

// Presença da tela: há alguma aba do Claudio’s Club aberta? Cada aba manda um sinal (`POST /api/presence`, só o navegador pareado) a cada poucos
// segundos; com a opção `stopOnTabClose` ligada, o servidor para quando NENHUMA aba deu sinal por uma carência inteira. Nunca por um sinal
// de saída sozinho: F5, navegação dentro do app e fechar uma de duas abas só mudam quem está na lista, e a aba nova volta antes da carência.
//
// Quem não é aba não conta: a extensão do Chrome, as conversas dos funcionários (token) e a sandbox do Codex nem alcançam a rota (gate.ts, apiPolicy.ts).
// Sem nenhuma aba desde o boot (daemon subido sem navegador), nunca para: a lista vazia não é "todas fecharam".

/** Quanto vale o último sinal de uma aba. Alto de propósito: o Chrome deixa o timer de uma aba escondida (há mais de 5 min) rodar só 1×/min. */
export const TAB_TTL_MS = 90_000;
/** Sem nenhuma aba por tanto tempo seguido: para. Cobre o F5 e a navegação, em que a aba nova demora a dar o primeiro sinal. */
export const TAB_GRACE_MS = 30_000;
/** De quanto em quanto tempo o servidor confere. */
export const TAB_CHECK_MS = 5_000;
/** Entre duas conferências, mais que isto: a máquina dormiu (ou o servidor travou) e as abas também não puderam dar sinal. */
const STALL_MS = 15_000;
/** Enquanto está na carência com a opção desligada, a configuração só é lida de tempos em tempos (o caso normal de quem não ligou). */
const OFF_RECHECK_MS = 30_000;
const MAX_TABS = 64;

/** `tab`: id da aba (a tela gera um por aba, 8 a 64 letras, números, `_` e `-`); `leaving`: a aba está saindo (`pagehide`), o que só encurta a espera. */
export const PresenceBody = z.object({ tab: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'aba inválida'), leaving: z.boolean().optional() }).strict();

export interface TabPresenceOptions {
  /** A opção `stopOnTabClose` está ligada? Só lida quando a carência já passou. */
  enabled: () => Promise<boolean>;
  /** Para o servidor, pelo mesmo caminho do botão Parar. */
  stop: () => void;
  now?: () => number;
  ttlMs?: number;
  graceMs?: number;
}

export class TabPresence {
  /** Aba → até quando o último sinal dela vale (`leaving` a vence na hora). */
  private tabs = new Map<string, number>();
  private lastTick: number | null = null;
  private askAfter = 0;
  private stopping = false;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly graceMs: number;

  constructor(private readonly o: TabPresenceOptions) {
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? TAB_TTL_MS;
    this.graceMs = o.graceMs ?? TAB_GRACE_MS;
  }

  /** Sinal de uma aba (ou, com `leaving`, aviso de que ela está saindo: a aba que o servidor nunca viu não entra na lista por isso). */
  signal(tab: string, leaving = false): void {
    const now = this.now();
    if (leaving) {
      if (this.tabs.has(tab)) this.tabs.set(tab, now);
      return;
    }
    // O que já venceu não conta para nada (há uma aba viva entrando agora), então sai: a lista não cresce a cada F5.
    for (const [id, until] of this.tabs) if (until <= now) this.tabs.delete(id);
    if (!this.tabs.has(tab) && this.tabs.size >= MAX_TABS) {
      const oldest = [...this.tabs].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.tabs.delete(oldest[0]);
    }
    this.tabs.set(tab, now + this.ttlMs);
    this.askAfter = 0;
  }

  /** Abas com sinal ainda válido. */
  open(): number {
    const now = this.now();
    return [...this.tabs.values()].filter((until) => until > now).length;
  }

  /** Alguma aba já deu sinal desde o boot e a última deixou de valer há pelo menos a carência. */
  private due(now: number): boolean {
    if (this.tabs.size === 0) return false;
    return now >= Math.max(...this.tabs.values()) + this.graceMs;
  }

  /** A máquina dormiu (ou o servidor ficou preso): as abas não puderam dar sinal, então valem de novo por um prazo inteiro. */
  private forgive(now: number): void {
    for (const id of this.tabs.keys()) this.tabs.set(id, now + this.ttlMs);
  }

  /** Uma conferência: para o servidor (uma vez) se a opção está ligada e a carência passou. Devolve se pediu para parar. */
  async tick(): Promise<boolean> {
    if (this.stopping || this.ticking) return false;
    const now = this.now();
    const gap = this.lastTick === null ? 0 : now - this.lastTick;
    this.lastTick = now;
    if (gap > STALL_MS) this.forgive(now);
    if (!this.due(now) || now < this.askAfter) return false;
    this.ticking = true;
    try {
      const on = await this.o.enabled().catch(() => false);
      if (!on) {
        this.askAfter = this.now() + OFF_RECHECK_MS;
        return false;
      }
      // A leitura da configuração é assíncrona: uma aba pode ter dado sinal (o F5 acabou de voltar) nesse meio-tempo.
      if (!this.due(this.now())) return false;
      this.stopping = true;
      this.o.stop();
      return true;
    } finally {
      this.ticking = false;
    }
  }

  start(everyMs = TAB_CHECK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }

  halt(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
