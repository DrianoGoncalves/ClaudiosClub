import { KeyringError, type Keyring, type KeyringReason } from '../../server/secretKeyring';

/** Chaveiro de memória para os testes do cofre: nunca toca o chaveiro de verdade da máquina. */
export interface FakeKeyring extends Keyring {
  items: Map<string, string>;
  /** Cada chamada, na ordem (só o nome da operação e o id; nunca o valor). */
  calls: string[];
  /** Enquanto tiver um motivo, toda operação (inclusive o `probe`) falha com ele. */
  down: KeyringReason | null;
  /** Ganchos para provocar casos de borda (devolver outro valor, mexer no arquivo no meio da migração). */
  onLookup?: (id: string) => Promise<string | null | undefined> | string | null | undefined;
  onStore?: (id: string, value: string) => void | Promise<void>;
}

export function fakeKeyring(): FakeKeyring {
  const k: FakeKeyring = {
    items: new Map(),
    calls: [],
    down: null,
    async store(id, value) {
      k.calls.push(`store:${id}`);
      if (k.down) throw new KeyringError(k.down);
      await k.onStore?.(id, value);
      k.items.set(id, value);
    },
    async lookup(id) {
      k.calls.push(`lookup:${id}`);
      if (k.down) throw new KeyringError(k.down);
      const hooked = await k.onLookup?.(id);
      if (hooked !== undefined) return hooked;
      return k.items.get(id) ?? null;
    },
    async clear(id) {
      k.calls.push(`clear:${id}`);
      if (k.down) throw new KeyringError(k.down);
      k.items.delete(id);
    },
    async probe() {
      k.calls.push('probe');
      if (k.down) throw new KeyringError(k.down);
    },
  };
  return k;
}
