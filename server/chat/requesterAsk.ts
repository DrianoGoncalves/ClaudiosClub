/** Narrow limits for a Codex worker asking the manager who requested its active task. */
export const REQUESTER_ASK_MAX_BYTES = 4 * 1024;
export const REQUESTER_ASK_INTERVAL_MS = 60_000;

export type RequesterAskLimit = 'too-large' | 'attachments' | 'rate-limited';

/** One accepted text-only question per (asking conversation, target conversation) per minute. */
export class RequesterAskLimiter {
  private readonly sentAt = new Map<string, number>();

  /** Só confere, sem gravar: o slot é reservado por reserve(), logo antes do envio. */
  check(
    conversationKey: string,
    text: string,
    hasAttachments: boolean,
    now = Date.now(),
  ): RequesterAskLimit | null {
    if (Buffer.byteLength(text, 'utf8') > REQUESTER_ASK_MAX_BYTES) return 'too-large';
    if (hasAttachments) return 'attachments';
    return this.cooling(conversationKey, now) ? 'rate-limited' : null;
  }

  /**
   * Grava o slot se o intervalo já passou. Síncrono, sem await entre a checagem e a gravação: não há rajada.
   * Devolve a função que desfaz a gravação (para quando o envio falha), ou null se ainda está no intervalo.
   */
  reserve(conversationKey: string, now = Date.now()): (() => void) | null {
    if (this.cooling(conversationKey, now)) return null;

    for (const [key, at] of this.sentAt) {
      if (now - at >= REQUESTER_ASK_INTERVAL_MS) this.sentAt.delete(key);
    }
    const previous = this.sentAt.get(conversationKey);
    this.sentAt.set(conversationKey, now);
    return () => {
      if (previous === undefined) this.sentAt.delete(conversationKey);
      else this.sentAt.set(conversationKey, previous);
    };
  }

  private cooling(conversationKey: string, now: number): boolean {
    const previous = this.sentAt.get(conversationKey);
    return previous !== undefined && now - previous < REQUESTER_ASK_INTERVAL_MS;
  }
}
