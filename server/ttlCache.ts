/**
 * Cache em memória por chave, com validade curta. Guarda a promessa (chamadas simultâneas dividem a mesma leitura)
 * e descarta a que falhou. `invalidate()` esquece tudo: uma leitura que ainda estava em curso não volta a ser servida.
 * A validade conta a partir do fim da leitura: uma leitura lenta (segundos) não gasta o prazo antes de chegar.
 */
export class TtlCache<T> {
  private entries = new Map<string, { at: number; value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    // Em curso (`at` infinito) vale para quem chegar: só uma leitura por vez.
    const entry = { at: Infinity, value: load() };
    this.entries.set(key, entry);
    entry.value.then(
      () => {
        entry.at = this.now();
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return entry.value;
  }

  invalidate(): void {
    this.entries.clear();
  }
}
