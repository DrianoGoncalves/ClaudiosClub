import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { writeAtomic } from '../atomicWrite';

// O registro das consultas entre projetos (`MYCO_HOME/consult/records.json`): o que sobrevive a um reinício. Guarda quem, para quem, em que estado e até quando;
// o texto da pergunta NÃO é gravado (só o hash, para a idempotência) e a resposta só fica aqui entre `answered` e `delivered`.

export const CONSULT_STATES = ['running', 'answered', 'delivered', 'failed', 'expired', 'cancelled', 'undeliverable'] as const;
export type ConsultState = (typeof CONSULT_STATES)[number];

/** Os estados em que a consulta ainda pode mudar (a conversa trabalha, ou a resposta espera entrega). */
export const OPEN_STATES: readonly ConsultState[] = ['running', 'answered'];
export const isOpen = (r: Pick<ConsultRecord, 'state'>): boolean => OPEN_STATES.includes(r.state);

export interface ConsultRecord {
  /** `c-` + 6 hex. */
  id: string;
  /** Quem pergunta: o projeto, o funcionário e a conversa dele, todos do token (nunca do corpo do pedido). */
  from: { projectId: string; staffId: string; sessionId: string };
  to: { projectId: string; staffId: string };
  /** A chave de idempotência do remetente e o hash do conteúdo (destino, funcionário e texto): mesma chave com outro conteúdo é 409. */
  key: string;
  contentHash: string;
  state: ConsultState;
  /** O motivo curto de `failed`, `expired`, `cancelled` e `undeliverable` (sem conteúdo da pergunta nem da resposta). */
  reason?: string;
  /** A conversa de consulta, no projeto de destino. */
  sessionId?: string;
  createdAt: string;
  deadlineAt: string;
  answeredAt?: string;
  deliveredAt?: string;
  /** O aviso curto (sem conteúdo) de que a consulta não deu resposta já foi entregue. */
  notifiedAt?: string;
  /** A resposta final (já limpa e cortada), só entre `answered` e `delivered`. */
  answer?: string;
  /** Quantos trechos com cara de segredo a plataforma tirou da resposta, e se ela foi cortada no teto (para a mensagem de entrega dizer). */
  removed?: number;
  cut?: boolean;
  /** Tentativas de entrega, e a próxima (backoff com jitter). */
  attempts: number;
  nextTryAt?: string;
}

const Id = z.string().min(1).max(300);
const RecordSchema = z.object({
  id: z.string().regex(/^c-[0-9a-f]{6}$/),
  from: z.object({ projectId: Id, staffId: Id, sessionId: Id }),
  to: z.object({ projectId: Id, staffId: Id }),
  key: z.string().max(100),
  contentHash: z.string().max(100),
  state: z.enum(CONSULT_STATES),
  reason: z.string().max(300).optional(),
  sessionId: z.string().max(100).optional(),
  createdAt: z.string(),
  deadlineAt: z.string(),
  answeredAt: z.string().optional(),
  deliveredAt: z.string().optional(),
  notifiedAt: z.string().optional(),
  answer: z.string().max(20_000).optional(),
  removed: z.number().int().min(0).max(10_000).optional(),
  cut: z.boolean().optional(),
  attempts: z.number().int().min(0).max(1000),
  nextTryAt: z.string().optional(),
});
const FileSchema = z.object({ version: z.literal(1), records: z.array(RecordSchema) });

/** Retenção: o que já terminou sai depois de 30 dias, e o arquivo guarda no máximo 500 (saem os terminados mais antigos). */
export const RETENTION_MS = 30 * 24 * 60 * 60_000;
export const MAX_RECORDS = 500;

export const newId = (): string => `c-${randomBytes(3).toString('hex')}`;

/** O conteúdo da consulta para a idempotência: destino, funcionário e texto (o texto em si não é gravado). */
export function contentHashOf(c: { targetProjectId: string; staffId: string; text: string }): string {
  return createHash('sha256').update(JSON.stringify([c.targetProjectId, c.staffId, c.text])).digest('hex');
}

/** Tira o que terminou há mais de `RETENTION_MS` e, passando de `MAX_RECORDS`, os terminados mais antigos. */
export function pruned(records: ConsultRecord[], now: number): ConsultRecord[] {
  const fresh = records.filter((r) => isOpen(r) || now - Date.parse(r.deliveredAt ?? r.answeredAt ?? r.createdAt) < RETENTION_MS);
  if (fresh.length <= MAX_RECORDS) return fresh;
  const done = fresh.filter((r) => !isOpen(r)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const drop = new Set(done.slice(0, fresh.length - MAX_RECORDS).map((r) => r.id));
  return fresh.filter((r) => !drop.has(r.id));
}

export class ConsultStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void = (line) => console.warn(line),
    private readonly clock: () => number = Date.now,
  ) {}

  async list(): Promise<ConsultRecord[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`[consulta] não consegui ler ${this.file}: ${(err as Error).message}`);
      return [];
    }
    try {
      const parsed = FileSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data.records;
    } catch {
      // cai no aviso abaixo
    }
    // Estragado: o que não dá para ler fica de lado (renomeado), e o serviço segue com o registro vazio, em vez de travar toda consulta nova.
    const aside = `${this.file}.estragado-${this.clock()}`;
    await fs.rename(this.file, aside).catch(() => undefined);
    this.log(`[consulta] ${this.file} estava estragado e foi guardado como ${aside}: o registro recomeça vazio`);
    return [];
  }

  async get(id: string): Promise<ConsultRecord | null> {
    return (await this.list()).find((r) => r.id === id) ?? null;
  }

  /**
   * Lê, muda e grava numa fila só: `fn` é síncrona e devolve os registros novos e o resultado, então a checagem de limite e a gravação do registro novo
   * não têm um `await` no meio (duas consultas juntas não furam o limite). Os registros vencidos saem aqui.
   */
  update<T>(fn: (records: ConsultRecord[], now: number) => { records: ConsultRecord[]; result: T }): Promise<T> {
    const run = this.queue.then(async () => {
      const now = this.clock();
      const { records, result } = fn(await this.list(), now);
      await writeAtomic(this.file, JSON.stringify({ version: 1, records: pruned(records, now) }, null, 2) + '\n');
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Muda um registro (se ele ainda está no estado esperado). Devolve o registro novo, ou null se sumiu ou já mudou. */
  patch(id: string, expect: readonly ConsultState[], change: (r: ConsultRecord) => ConsultRecord): Promise<ConsultRecord | null> {
    return this.update((records) => {
      const at = records.findIndex((r) => r.id === id);
      const current = records[at];
      if (!current || !expect.includes(current.state)) return { records, result: null };
      const next = change(current);
      return { records: records.map((r, i) => (i === at ? next : r)), result: next };
    });
  }
}
