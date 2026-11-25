// Conversa parada fecha mais cedo quando falta memória. Cada conversa aberta do Claude segura o processo do Claude Code (~580 MB, fora os MCPs) até 15 min depois
// do último turno. Em 25/11/2026, com 7 abertas (4 paradas) numa máquina de 8 GB, o Windows paginava sem parar no HDD. Com a RAM livre abaixo do mínimo da config
// (`minFreeRamGb`, o mesmo da fila):
//   - a rodada do `reap` (a cada minuto) fecha a parada há mais tempo (`pickIdleForMemory`);
//   - antes de abrir uma conversa nova do Claude, `makeRoom` fecha até `ROOM_CLOSE_MAX` paradas e espera elas saírem.
// A sessão fica no disco: a próxima mensagem reabre a conversa (~14 s no HDD), sem custo extra de tokens (o cache do prompt expira em minutos de qualquer jeito).
// Conversa do Codex não entra: parada, ela não segura processo (o Codex abre um por mensagem), e fechá-la não devolve memória.

/** Conversa parada há menos que isso não fecha por memória: o dono pode estar lendo a resposta que acabou de chegar. */
export const MEMORY_PRESSURE_IDLE_MS = 2 * 60_000;

export interface ReapCandidate {
  sessionId: string;
  running: boolean;
  /** Turno em andamento, pergunta ou permissão sem resposta, ou tarefa em segundo plano: fechar interromperia. */
  working: boolean;
  lastActivity: number;
  /** Já pedimos para fechar e o processo ainda não saiu: fechar de novo não devolveria nada. */
  isClosing?: boolean;
}

/** A conversa a fechar quando falta memória: aberta, parada há mais de `minIdleMs`, a parada há mais tempo primeiro; null se nenhuma pode sair. */
export function pickIdleForMemory<T extends ReapCandidate>(chats: Iterable<T>, now: number, minIdleMs = MEMORY_PRESSURE_IDLE_MS): T | null {
  let best: T | null = null;
  for (const c of chats) {
    if (!c.running || c.working || c.isClosing || now - c.lastActivity < minIdleMs) continue;
    if (!best || c.lastActivity < best.lastActivity) best = c;
  }
  return best;
}

/** Memória agora: livre e o mínimo da config, em bytes. Null quando a regra está desligada (`minFreeRamGb` 0 ou o portão de recursos desligado). */
export type MemoryReading = { freeBytes: number; minBytes: number } | null;

/** Quantas conversas paradas uma abertura fecha, no máximo, para caber (cada uma devolve ~580 MB). */
export const ROOM_CLOSE_MAX = 2;
/** Depois que o processo sai, o Windows leva alguns segundos para devolver a memória dele (e dos MCPs filhos): relida antes disso, ela pareceria ainda curta. */
export const ROOM_SETTLE_MS = 3_000;
/** Teto da espera pelo processo fechado sair: se ele não sair (killTree falhou), a abertura segue em vez de travar. */
export const ROOM_STOP_MAX_MS = 15_000;

export const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

/** Espera que não segura o processo do servidor no desligamento. */
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms).unref?.();
  });

/** `work` até `ms`, sem deixar timer vivo depois (o da espera é limpo quando `work` termina antes). */
async function upTo(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work.then(() => undefined, () => undefined),
    new Promise<void>((r) => {
      timer = setTimeout(r, ms);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Antes de abrir uma conversa nova do Claude (um processo a mais): com a RAM livre abaixo do mínimo, fecha a conversa parada há mais tempo, espera ela sair (até
 * `ROOM_STOP_MAX_MS`) e dá `ROOM_SETTLE_MS` para a memória voltar, até `ROOM_CLOSE_MAX` vezes ou até a memória bastar. Nunca lança: falha ao ler a memória ou ao
 * fechar só deixa abrir como antes. Devolve o que fechou e a última leitura (null = regra desligada ou leitura falhou).
 */
export async function makeRoom<T extends ReapCandidate & { stopAndWait(): Promise<void> }>(
  chats: () => Iterable<T>,
  memory: () => Promise<MemoryReading>,
  o: { now?: () => number; log?: (line: string) => void; settleMs?: number; stopMaxMs?: number } = {},
): Promise<{ closed: string[]; reading: MemoryReading }> {
  const read = () => memory().catch(() => null);
  let reading = await read();
  const closed: string[] = [];
  while (reading && reading.freeBytes < reading.minBytes && closed.length < ROOM_CLOSE_MAX) {
    const victim = pickIdleForMemory(chats(), (o.now ?? Date.now)());
    if (!victim) break;
    o.log?.(`memória: ${gb(reading.freeBytes)} GB livres (mínimo ${gb(reading.minBytes)}): fecho ${victim.sessionId}, parada, para abrir outra conversa`);
    closed.push(victim.sessionId);
    await upTo(victim.stopAndWait(), o.stopMaxMs ?? ROOM_STOP_MAX_MS);
    await sleep(o.settleMs ?? ROOM_SETTLE_MS);
    reading = await read();
  }
  return { closed, reading };
}

/** A leitura diz que falta memória (abaixo do mínimo). Null (regra desligada ou leitura falhou) não é falta. */
export const stillShort = (r: MemoryReading): boolean => !!r && r.freeBytes < r.minBytes;

/**
 * Prazo de conversa parada de tarefa (trabalho, revisão, deploy): o próximo passo dela vem do Club (testes, revisão, fila), minutos ou horas depois, e ela reabre
 * sozinha quando ele chega. A sua conversa (e a de card automático, que é conversa direta) segue com os 15 min. Em 25/11/2026 a maioria das conversas abertas
 * paradas era de tarefa, segurando ~580 MB cada.
 */
export const TASK_CHAT_IDLE_MS = 2 * 60_000;

/** As conversas de tarefa paradas há mais de `idleMs`, para fechar já. `isTask` responde por conversa (o quadro sabe); erro nela conta como "não é" (fica). */
export async function idleTaskChats<T extends ReapCandidate>(chats: Iterable<T>, now: number, isTask: (sessionId: string) => Promise<boolean>, idleMs = TASK_CHAT_IDLE_MS): Promise<T[]> {
  const out: T[] = [];
  for (const c of chats) {
    if (!c.running || c.working || c.isClosing || now - c.lastActivity < idleMs) continue;
    if (await isTask(c.sessionId).catch(() => false)) out.push(c);
  }
  return out;
}
