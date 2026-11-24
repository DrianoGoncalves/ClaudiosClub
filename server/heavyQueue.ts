import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { acquire, currentHolder, isHeavyCommand, release } from '../scripts/hooks/heavy-lock.mjs';

// A fila de validação pesada por máquina, do lado do servidor: a suíte que o Claudio’s Club roda (runTests: testes da entrega, da
// revisão e da mescla) entra na mesma fila do terminal dos funcionários (hook scripts/hooks/heavy-guard.mjs). A lógica e o formato
// da trava estão em scripts/hooks/heavy-lock.mjs; aqui só o encaixe no servidor.

/** A pasta da trava: uma por máquina (`<MYCO_HOME>/run/heavy`). O MYCO_HOME de teste a isola. */
export function heavyLockDir(): string {
  return path.join(process.env.MYCO_HOME ?? path.join(os.homedir(), '.myco'), 'run', 'heavy');
}

/** Quanto o servidor espera pela vez antes de rodar mesmo assim: 3 suítes inteiras na frente (10 min cada) já é fila demais. */
export const HEAVY_WAIT_MAX_MS = 30 * 60_000;

/** A variável com a chave da trava no ambiente do que o servidor rodou sob ela: quem nasce ali dentro é parte da mesma validação. */
export const HEAVY_HELD_ENV = 'MYCO_HEAVY_HELD';

/**
 * Quem pediu a validação sabe que ela está esperando a vez: `{ since, holder }` ao começar a esperar (`holder`: o nome de quem segura a fila agora) e `null` quando a espera acaba
 * (a vez chegou, o prazo passou ou a fila falhou). Só informa: erro aqui não derruba a validação (ver `safely`).
 */
export type HeavyWaitFn = (wait: { since: string; holder: string } | null) => void;

/** `signal` abortado antes de a validação rodar: a vez foi desistida, nada rodou. */
export class HeavyAbortedError extends Error {
  constructor() {
    super('a espera pela fila de validação foi cancelada');
    this.name = 'HeavyAbortedError';
  }
}

const safely = (fn: () => void): void => {
  try {
    fn();
  } catch {
    /* quem observa a espera não derruba a validação */
  }
};

/**
 * Roda `run` na fila quando `command` é validação pesada (suíte completa, tsc do projeto); senão, direto. `run` recebe a chave da trava que
 * este servidor segura (o que ele abrir deve levá-la em `HEAVY_HELD_ENV`) ou null, sem trava. `leaseMs`: o prazo da trava (o tempo que `run`
 * pode levar): passou dele, a trava vale como órfã. Sem a fila (disco, tempo de espera esgotado) roda do mesmo jeito.
 * Quem roda DENTRO de uma validação que já tem a trava não espera por ela (esperaria a si mesmo, até o prazo): a suíte do Club tem testes que
 * chamam o runTests de verdade. Reconhece pela chave em `HEAVY_HELD_ENV` (a suíte que o servidor abriu) ou pela conversa dona da trava, que o
 * hook do terminal registra pelo MYCO_SESSION_ID (a suíte que um funcionário abriu).
 * `signal`: quem pediu desiste da vez (o orçamento das provas da entrega, ver deliveryProofs.ts): a espera acaba e `run` NÃO roda, com `HeavyAbortedError`; sem isso a validação
 * que já estourou o orçamento rodaria depois, ocupando a fila. Abortar com `run` já em andamento é de `run` (ver `spawnTests`).
 */
export async function withHeavyLock<T>(
  command: string,
  run: (held: string | null) => Promise<T>,
  o: { label: string; leaseMs: number; dir?: string; maxWaitMs?: number; onWait?: HeavyWaitFn; signal?: AbortSignal },
): Promise<T> {
  if (o.signal?.aborted) throw new HeavyAbortedError();
  if (!isHeavyCommand(command)) return run(null);
  const dir = o.dir ?? heavyLockDir();
  const key = `server:${process.pid}:${randomUUID()}`;
  let held = false;
  try {
    const session = process.env.MYCO_SESSION_ID;
    const heldKey = process.env[HEAVY_HELD_ENV];
    const mine = session || heldKey ? await currentHolder(dir) : null;
    const nested = !!mine && ((!!heldKey && mine.key === heldKey) || (!!session && !!mine.owner && (mine.owner === session || mine.owner.startsWith(`${session}:`))));
    if (!nested) {
      const got = await acquire({
        dir,
        key,
        pid: process.pid,
        label: o.label,
        leaseMs: o.leaseMs,
        maxWaitMs: o.maxWaitMs ?? HEAVY_WAIT_MAX_MS,
        signal: o.signal,
        onWait: (holder) => {
          console.log(`[fila] ${o.label}: esperando a vez (outra validação pesada roda: ${holder.label || 'sem nome'})`);
          safely(() => o.onWait?.({ since: new Date().toISOString(), holder: holder.label || 'sem nome' }));
        },
      });
      held = got.acquired;
      if (got.aborted) {
        safely(() => o.onWait?.(null));
        throw new HeavyAbortedError();
      }
      if (!got.acquired) console.warn(`[fila] ${o.label}: esperou ${Math.round(got.waitedMs / 1000)} s e a fila não andou; roda sem trava`);
    }
  } catch (err) {
    if (err instanceof HeavyAbortedError) throw err;
    console.warn(`[fila] ${o.label}: sem a fila (${err instanceof Error ? err.message : String(err)}); roda sem trava`);
  }
  // Desistiu entre pegar a vez e rodar: solta e não roda.
  if (o.signal?.aborted) {
    if (held) await release(dir, key).catch(() => {});
    safely(() => o.onWait?.(null));
    throw new HeavyAbortedError();
  }
  // Acabou a espera (pegou a vez, esgotou o prazo ou a fila falhou): a suíte vai rodar.
  safely(() => o.onWait?.(null));
  try {
    return await run(held ? key : null);
  } finally {
    if (held) await release(dir, key).catch(() => {});
  }
}
