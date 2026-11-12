// Freio contra laço entre funcionários: uma mensagem de funcionário (com token) para uma conversa conta nessa conversa.
// Passou do máximo na janela, a rota responde 429. Em memória: reinício zera a contagem. Mensagens internas do Club
// (revisão, desfecho, continue, despertador) não passam por aqui.

export const STAFF_SEND_MAX = 20;
export const STAFF_SEND_WINDOW_MS = 30 * 60_000;

/** A conversa de destino já recebeu funcionários demais na janela (a rota responde 429, com `Retry-After`). */
export class StaffSendLimitError extends Error {
  constructor(
    /** Segundos até a mensagem mais antiga da janela sair dela (o cabeçalho `Retry-After`). */
    readonly retryAfter: number,
  ) {
    super(`muitas mensagens de funcionários para esta conversa (${STAFF_SEND_MAX} em 30 min); peça ao usuário antes de continuar`);
  }
}

/**
 * Chave da conversa de destino. Sem sessão (conversa nova da ficha), vale a ficha: a conversa nova não escapa do freio
 * (cada mensagem abriria uma conversa zerada).
 */
export function sendTargetKey(projectId: string, sessionId: string | null, staffId: string | null): string {
  return `${projectId}:${sessionId ?? `nova:${staffId ?? ''}`}`;
}

export class StaffSendRate {
  private readonly sent = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Conta uma mensagem de funcionário para a conversa `key`. A (MAX+1)ª na janela lança `StaffSendLimitError` e não entra na conta.
   */
  count(key: string): void {
    const t = this.now();
    const recent = this.prune(key, t);
    if (recent.length >= STAFF_SEND_MAX) {
      // A mais antiga sai quando passarem os 30 min dela; arredonda para cima para não avisar antes da hora.
      const leavesAt = recent[0]! + STAFF_SEND_WINDOW_MS;
      throw new StaffSendLimitError(Math.ceil((leavesAt - t) / 1000));
    }
    recent.push(t);
    this.sent.set(key, recent);
  }

  /** Mensagem do dono para a conversa: zera a janela dela (as outras conversas seguem como estão). */
  reset(key: string): void {
    this.sent.delete(key);
  }

  /** Tira da conta o que já saiu da janela; a chave some quando não sobra nada. */
  private prune(key: string, t: number): number[] {
    const recent = (this.sent.get(key) ?? []).filter((at) => t - at < STAFF_SEND_WINDOW_MS);
    if (recent.length) this.sent.set(key, recent);
    else this.sent.delete(key);
    return recent;
  }
}
