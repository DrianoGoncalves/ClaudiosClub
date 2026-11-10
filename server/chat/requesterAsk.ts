/** Narrow limits for a Codex worker asking the manager who requested its active task. */
export const REQUESTER_ASK_MAX_BYTES = 4 * 1024;
export const REQUESTER_ASK_INTERVAL_MS = 60_000;

export type RequesterAskLimit = 'too-large' | 'attachments' | 'rate-limited';

/** One accepted text-only question per target conversation per minute. */
export class RequesterAskLimiter {
  private readonly sentAt = new Map<string, number>();

  check(
    conversationKey: string,
    text: string,
    hasAttachments: boolean,
    now = Date.now(),
  ): RequesterAskLimit | null {
    if (Buffer.byteLength(text, 'utf8') > REQUESTER_ASK_MAX_BYTES) return 'too-large';
    if (hasAttachments) return 'attachments';

    const previous = this.sentAt.get(conversationKey);
    if (previous !== undefined && now - previous < REQUESTER_ASK_INTERVAL_MS) return 'rate-limited';

    for (const [key, at] of this.sentAt) {
      if (now - at >= REQUESTER_ASK_INTERVAL_MS) this.sentAt.delete(key);
    }
    this.sentAt.set(conversationKey, now);
    return null;
  }
}
