import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { writeAtomic } from '../atomicWrite';

// Vínculos entre projetos para a consulta de funcionário a funcionário (ver server/consult/service.ts). O vínculo é do dono: só a tela grava (o serviço confere
// `fromBrowser`), é direcional (a origem pergunta, o destino responde), padrão desligado, e vale na hora (cada checagem lê o arquivo, sem cache).
// Arquivo ausente = nenhum vínculo. Arquivo estragado = nenhum vínculo também (falha fechada, nunca "todos liberados") e o aviso vai para o log.

const PROJECT_ID = /^[A-Za-z0-9-]{1,300}$/;
const STAFF_ID = /^[A-Za-z0-9._-]{1,100}$/;
export const MAX_LINKS = 500;
export const MAX_LINK_STAFF = 200;

/** Quem da origem pode consultar: `null` = todos os funcionários da origem; lista = só estes. */
export interface ConsultLink {
  from: string;
  to: string;
  staffIds: string[] | null;
  createdAt: string;
}

const LinkSchema = z.object({
  from: z.string().regex(PROJECT_ID),
  to: z.string().regex(PROJECT_ID),
  staffIds: z.array(z.string().regex(STAFF_ID)).max(MAX_LINK_STAFF).nullable(),
  createdAt: z.string(),
});
const FileSchema = z.object({ version: z.literal(1), links: z.array(LinkSchema).max(MAX_LINKS) });

/** O vínculo pedido não vale (projeto igual, id ou lista inválidos): 400 na rota. */
export class ConsultLinkError extends Error {}

export class ConsultLinks {
  private queue: Promise<unknown> = Promise.resolve();
  private warned = false;

  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  /** Os vínculos de agora (lidos do disco). Arquivo que não existe ou não se lê: nenhum. */
  async list(): Promise<ConsultLink[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.warn(`não consegui ler ${this.file}: nenhuma consulta entre projetos vale até ele voltar`);
      return [];
    }
    try {
      const parsed = FileSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data.links;
    } catch {
      // cai no aviso abaixo
    }
    this.warn(`${this.file} está estragado: nenhuma consulta entre projetos vale até ele ser refeito pela tela`);
    return [];
  }

  async get(from: string, to: string): Promise<ConsultLink | null> {
    return (await this.list()).find((l) => l.from === from && l.to === to) ?? null;
  }

  /** O funcionário `staffId` do projeto `from` pode consultar o projeto `to`? */
  async allows(from: string, to: string, staffId: string): Promise<boolean> {
    const link = await this.get(from, to);
    return !!link && (link.staffIds === null || link.staffIds.includes(staffId));
  }

  /** Os projetos que `staffId` da origem `from` pode consultar. */
  async targetsOf(from: string, staffId: string): Promise<string[]> {
    return (await this.list()).filter((l) => l.from === from && (l.staffIds === null || l.staffIds.includes(staffId))).map((l) => l.to);
  }

  /** Cria o vínculo ou troca a lista dele (um por par e direção). */
  set(input: { from: string; to: string; staffIds: string[] | null }, now = new Date()): Promise<ConsultLink> {
    if (!PROJECT_ID.test(input.from) || !PROJECT_ID.test(input.to)) return Promise.reject(new ConsultLinkError('projeto inválido'));
    if (input.from === input.to) return Promise.reject(new ConsultLinkError('o vínculo é entre dois projetos diferentes'));
    const staffIds = input.staffIds === null ? null : [...new Set(input.staffIds)];
    if (staffIds && (staffIds.length > MAX_LINK_STAFF || staffIds.some((s) => !STAFF_ID.test(s)))) return Promise.reject(new ConsultLinkError('lista de funcionários inválida'));
    return this.change((links) => {
      const rest = links.filter((l) => !(l.from === input.from && l.to === input.to));
      if (rest.length >= MAX_LINKS) throw new ConsultLinkError(`no máximo ${MAX_LINKS} vínculos`);
      const link: ConsultLink = { from: input.from, to: input.to, staffIds, createdAt: links.find((l) => l.from === input.from && l.to === input.to)?.createdAt ?? now.toISOString() };
      return { links: [...rest, link], result: link };
    });
  }

  /** Desfaz o vínculo (só nessa direção). False: não havia. */
  revoke(from: string, to: string): Promise<boolean> {
    return this.change((links) => {
      const rest = links.filter((l) => !(l.from === from && l.to === to));
      return { links: rest, result: rest.length !== links.length };
    });
  }

  /** Leitura, mudança e gravação numa fila só (duas mudanças juntas não se perdem). */
  private change<T>(fn: (links: ConsultLink[]) => { links: ConsultLink[]; result: T }): Promise<T> {
    const run = this.queue.then(async () => {
      const { links, result } = fn(await this.list());
      await writeAtomic(this.file, JSON.stringify({ version: 1, links }, null, 2) + '\n');
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private warn(line: string): void {
    if (this.warned) return;
    this.warned = true;
    this.log(`[consulta] ${line}`);
  }
}
