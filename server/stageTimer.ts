/**
 * Quanto cada etapa de um pedido levou, em ordem. Só escreve no log quando o total passa do limite (`slowMs`, 2 s): o pedido normal não
 * faz barulho, e o lento diz onde o tempo foi (ver `TaskService.start`). Etapas em sequência: `stage` fecha a anterior e abre a próxima.
 */
export class StageTimer {
  private readonly totals = new Map<string, number>();
  private current: { name: string; at: number } | null = null;
  private readonly t0: number;
  private done = false;
  /** O pedido já foi respondido antes de acabar (passou do prazo): o fim do log diz que o resto seguiu em segundo plano. */
  answeredEarly = false;

  constructor(
    private readonly label: string,
    private readonly log: (line: string) => void = (line) => console.warn(line),
    private readonly slowMs = 2_000,
    private readonly now: () => number = Date.now,
  ) {
    this.t0 = this.now();
  }

  /** Fecha a etapa que estava aberta e abre `name` (de novo o mesmo nome soma ao que já tinha). */
  stage(name: string): void {
    if (this.done) return;
    this.close();
    this.current = { name, at: this.now() };
  }

  /** A etapa aberta agora e há quanto tempo, para dizer onde o pedido está parado. */
  where(): { name: string; ms: number } | null {
    return this.current ? { name: this.current.name, ms: this.now() - this.current.at } : null;
  }

  /** Quanto o pedido leva até agora. */
  elapsed(): number {
    return this.now() - this.t0;
  }

  /** Fecha a etapa aberta e escreve o log se o total passou do limite. Só vale a primeira vez. */
  finish(): void {
    if (this.done) return;
    this.close();
    this.done = true;
    const total = this.elapsed();
    if (total < this.slowMs) return;
    const parts = [...this.totals].map(([name, ms]) => `${name} ${ms} ms`).join(', ');
    this.log(`[tarefas] ${this.label}: ${total} ms (${parts})${this.answeredEarly ? '; respondeu na fila, o resto seguiu em segundo plano' : ''}`);
  }

  private close(): void {
    if (!this.current) return;
    this.totals.set(this.current.name, (this.totals.get(this.current.name) ?? 0) + (this.now() - this.current.at));
    this.current = null;
  }
}
