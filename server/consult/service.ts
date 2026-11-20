import { z } from 'zod';
import type { ConsultStamp } from '../../shared/model';
import { ConsultLinkError, type ConsultLink, type ConsultLinks } from './links';
import { contentHashOf, isOpen, newId, type ConsultRecord, type ConsultState, type ConsultStore } from './store';
import { REASONS, answerMessage, cleanAnswer, consultPrompt, noticeMessage } from './text';

// A consulta de funcionário a funcionário entre projetos (decisão do dono, opção B): o funcionário da ORIGEM pergunta, o do DESTINO responde numa conversa nova só de leitura, e a plataforma
// entrega a resposta final na conversa de quem perguntou. Tudo que importa vem do servidor, nunca do corpo do pedido:
// - quem pergunta (projeto, funcionário, conversa) é o dono do token; o vínculo (só a tela grava) diz quem da origem pode consultar o destino, e vale na hora (cada pedido lê o arquivo);
// - a conversa de consulta não tem token nem ferramenta de escrita (ver StaffService.consultSpawn): um salto só, sem delegar, sem tarefa, sem nova consulta;
// - limites, prazo e idempotência vêm do registro persistente (store.ts), então sobrevivem a um reinício.

export const TEXT_MAX_BYTES = 4 * 1024;
export const DEADLINE_MS = 10 * 60_000;
export const PAIR_INTERVAL_MS = 60_000;
export const PAIR_PER_HOUR = 6;
export const SENDER_PER_HOUR = 10;
export const OPEN_PER_TARGET_PROJECT = 3;
/** A entrega da resposta (ou do aviso) tenta de novo com backoff por até este tempo; depois a consulta fica `undeliverable`. */
export const DELIVERY_GIVE_UP_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/** Recusa com o status HTTP (a rota responde com ele): 400 pedido inválido, 403 sem direito, 404 não existe, 409 conflito, 429 limite, 503 tente de novo. */
export class ConsultError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429 | 503,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Sem vínculo, remetente fora da lista e vínculo revogado dão a MESMA resposta: a recusa não serve para descobrir vínculos. */
const NO_LINK = 'esta consulta não está liberada: o dono não ligou esse vínculo entre os projetos para você';

const ProjectId = z.string().regex(/^[A-Za-z0-9-]{1,300}$/, 'targetProjectId inválido');
const StaffId = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, 'staffId inválido');
const StartBody = z
  .object({
    targetProjectId: ProjectId,
    staffId: StaffId,
    text: z.string(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/, 'idempotencyKey: de 8 a 100 caracteres (letras, números e . _ : -)'),
  })
  .strict();
const LinkBody = z.object({ fromProjectId: ProjectId, toProjectId: ProjectId, staff: z.union([z.literal('all'), z.array(StaffId).max(200)]) }).strict();
const RevokeBody = z.object({ fromProjectId: ProjectId, toProjectId: ProjectId }).strict();

/** Quem chama: o dono do token (ver server/callers.ts). */
export interface ConsultCaller {
  staffId: string | null;
  projectId: string;
  sessionId: string;
}

export interface ConsultDeps {
  links: ConsultLinks;
  store: ConsultStore;
  /** O projeto (null se não existe). */
  project: (projectId: string) => Promise<{ id: string; name: string } | null>;
  /** O funcionário do projeto (null se não existe). `ended`: temporário já encerrado. */
  staff: (projectId: string, staffId: string) => Promise<{ id: string; name: string; role: string; ended?: boolean } | null>;
  /** Os funcionários do projeto que podem responder (o diretório devolve só id, nome e cargo deles). */
  listStaff: (projectId: string) => Promise<Array<{ id: string; name: string; role: string }>>;
  paused: (projectId: string) => Promise<boolean>;
  /** A trava de uso do projeto destino (UsageStopError quando barra). */
  checkUsage: (projectId: string, staffId: string) => Promise<void>;
  /** Abre a conversa de consulta no destino e manda a 1ª mensagem; devolve o id da conversa. */
  openConsult: (projectId: string, staffId: string, text: string, stamp: ConsultStamp) => Promise<string>;
  /** A conversa é de consulta, entre as abertas neste servidor? */
  isConsultSession: (sessionId: string) => boolean;
  /** A última mensagem de texto do funcionário na conversa (só ela: nunca histórico, raciocínio nem saída de ferramenta). */
  lastText: (sessionId: string) => string | null;
  /** Como o turno acabou: com erro do motor (`failed`), ou parado esperando o "continue" do limite (`waiting`). */
  turn: (sessionId: string) => Promise<{ failed: boolean; waiting: boolean }>;
  /** Fecha a conversa de consulta que terminou (libera o processo). */
  closeSession: (sessionId: string) => Promise<void>;
  /** Interrompe a conversa de consulta (prazo, vínculo desfeito, cancelamento). */
  stopSession: (sessionId: string) => void;
  /** Entrega o texto na conversa de quem perguntou (espera a vez se ele está em outra tarefa; reabre a conversa se fechou). Rejeita quando não deu: a entrega tenta de novo. */
  deliver: (to: { projectId: string; staffId: string; sessionId: string }, text: string) => Promise<void>;
  /** O servidor está fechando para reiniciar (a saída das conversas não é falha da consulta). */
  isClosing?: () => boolean;
  now?: () => number;
  rand?: () => number;
  log?: (line: string) => void;
}

/** O que a rota devolve de uma consulta (nunca o texto da pergunta nem a resposta). */
export interface PublicConsult {
  id: string;
  state: ConsultState;
  deadlineAt: string;
  from: { projectId: string; staffId: string };
  to: { projectId: string; staffId: string };
  createdAt: string;
  reason?: string;
}

export interface DirectoryEntry {
  projectId: string;
  projectName: string;
  staff: Array<{ id: string; name: string; role: string }>;
}

export const viewOf = (r: ConsultRecord): PublicConsult => ({
  id: r.id,
  state: r.state,
  deadlineAt: r.deadlineAt,
  from: { projectId: r.from.projectId, staffId: r.from.staffId },
  to: r.to,
  createdAt: r.createdAt,
  ...(r.reason && { reason: r.reason }),
});

export class ConsultService {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: ConsultDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.warn(l)))(`[consulta] ${line}`);
  }

  // ---- o vínculo (só a tela) ----

  async listLinks(): Promise<ConsultLink[]> {
    return this.deps.links.list();
  }

  /** Liga (ou troca a lista de) um vínculo. `fromBrowser` é o do pedido (Origin local e cookie do pareamento), nunca o corpo: sem ele, 403 antes de ler qualquer coisa. */
  async setLink(fromBrowser: boolean, rawBody: unknown): Promise<ConsultLink> {
    if (!fromBrowser) throw new ConsultError(403, 'só você, pelo Claudio’s Club (a tela), liga um vínculo de consulta entre projetos');
    const b = this.parse(LinkBody, rawBody);
    const [from, to] = await Promise.all([this.deps.project(b.fromProjectId), this.deps.project(b.toProjectId)]);
    if (!from || !to) throw new ConsultError(404, 'projeto não encontrado');
    const staffIds = b.staff === 'all' ? null : b.staff;
    for (const id of staffIds ?? []) if (!(await this.deps.staff(b.fromProjectId, id))) throw new ConsultError(400, `o funcionário ${id} não é do projeto de origem`);
    let link: ConsultLink;
    try {
      link = await this.deps.links.set({ from: b.fromProjectId, to: b.toProjectId, staffIds });
    } catch (err) {
      throw err instanceof ConsultLinkError ? new ConsultError(400, err.message) : err;
    }
    // A lista encolheu: as consultas abertas de quem saiu dela não valem mais.
    await this.cancelWhere((r) => r.from.projectId === link.from && r.to.projectId === link.to && !(link.staffIds === null || link.staffIds.includes(r.from.staffId)), REASONS.revoked);
    return link;
  }

  /** Desfaz o vínculo e cancela, na hora, as consultas abertas entre os dois projetos (nenhuma resposta delas é entregue). */
  async revokeLink(fromBrowser: boolean, rawBody: unknown): Promise<{ revoked: boolean; cancelled: number }> {
    if (!fromBrowser) throw new ConsultError(403, 'só você, pelo Claudio’s Club (a tela), desfaz um vínculo de consulta entre projetos');
    const b = this.parse(RevokeBody, rawBody);
    const revoked = await this.deps.links.revoke(b.fromProjectId, b.toProjectId);
    const cancelled = await this.cancelWhere((r) => r.from.projectId === b.fromProjectId && r.to.projectId === b.toProjectId, REASONS.revoked);
    return { revoked, cancelled };
  }

  /** As consultas (sem o texto da pergunta nem a resposta), mais recentes primeiro; `projectId` filtra as que saem ou chegam nele. */
  async listRecords(projectId?: string): Promise<PublicConsult[]> {
    const all = await this.deps.store.list();
    return all
      .filter((r) => !projectId || r.from.projectId === projectId || r.to.projectId === projectId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(viewOf);
  }

  // ---- o funcionário ----

  /** Quem o funcionário pode consultar: só id, nome e cargo, dos projetos vinculados à origem dele e liberados a ele. Nada de ficha, memória nem conversa. */
  async directory(caller: ConsultCaller | null, pathProjectId: string): Promise<DirectoryEntry[]> {
    const staffId = this.sender(caller, pathProjectId);
    const out: DirectoryEntry[] = [];
    for (const projectId of await this.deps.links.targetsOf(caller!.projectId, staffId)) {
      const project = await this.deps.project(projectId);
      if (!project) continue;
      const staff = (await this.deps.listStaff(projectId)).map((s) => ({ id: s.id, name: s.name, role: s.role }));
      out.push({ projectId: project.id, projectName: project.name, staff });
    }
    return out;
  }

  /**
   * Abre a consulta. Ordem: corpo (400) → remetente do token (403) → um salto só (403) → vínculo (403) → existência (404) → idempotência (replay 200, outro conteúdo 409) → projeto destino pausado (409)
   * → trava de uso do destino → limites e registro, juntos e sem `await` no meio (409 uma aberta por par, 429 frequência) → abre a conversa (se não abrir, o registro sai e o erro volta).
   */
  async start(caller: ConsultCaller | null, pathProjectId: string, rawBody: unknown): Promise<{ replay: boolean; consult: PublicConsult }> {
    const body = this.parseStart(rawBody);
    const staffId = this.sender(caller, pathProjectId);
    const from = { projectId: caller!.projectId, staffId, sessionId: caller!.sessionId };
    if (this.deps.isConsultSession(from.sessionId) || (await this.deps.store.list()).some((r) => r.sessionId === from.sessionId)) {
      throw new ConsultError(403, 'uma conversa de consulta não consulta outro projeto nem repassa a um colega (um salto só)');
    }
    if (!(await this.deps.links.allows(from.projectId, body.targetProjectId, staffId))) throw new ConsultError(403, NO_LINK);
    const [origin, target, targetStaff, asker] = await Promise.all([
      this.deps.project(from.projectId),
      this.deps.project(body.targetProjectId),
      this.deps.staff(body.targetProjectId, body.staffId),
      this.deps.staff(from.projectId, staffId),
    ]);
    if (!origin || !target) throw new ConsultError(404, 'projeto não encontrado');
    if (!targetStaff || targetStaff.ended) throw new ConsultError(404, 'esse funcionário não está nesse projeto');
    if (!asker) throw new ConsultError(403, 'só um funcionário (com ficha) consulta outro projeto');
    const hash = contentHashOf({ targetProjectId: body.targetProjectId, staffId: body.staffId, text: body.text });
    const before = this.byKey(await this.deps.store.list(), from, body.idempotencyKey);
    if (before) return this.replay(before, hash);
    if (await this.deps.paused(body.targetProjectId)) throw new ConsultError(409, 'o projeto de destino está pausado: tente de novo quando ele for retomado');
    await this.deps.checkUsage(body.targetProjectId, body.staffId);
    const to = { projectId: body.targetProjectId, staffId: body.staffId };
    const made = await this.deps.store.update<{ created: ConsultRecord } | { again: ConsultRecord }>((records, now) => {
      const again = this.byKey(records, from, body.idempotencyKey);
      if (again) return { records, result: { again } };
      this.checkLimits(records, from, to, now);
      let id = newId();
      while (records.some((r) => r.id === id)) id = newId();
      const created: ConsultRecord = {
        id,
        from,
        to,
        key: body.idempotencyKey,
        contentHash: hash,
        state: 'running',
        createdAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + DEADLINE_MS).toISOString(),
        attempts: 0,
      };
      return { records: [...records, created], result: { created } };
    });
    if ('again' in made) return this.replay(made.again, hash);
    const rec = made.created;
    const stamp: ConsultStamp = { id: rec.id, fromProjectId: origin.id, fromProjectName: origin.name, fromStaffId: asker.id, fromStaffName: asker.name };
    let sessionId: string;
    try {
      sessionId = await this.deps.openConsult(
        body.targetProjectId,
        body.staffId,
        consultPrompt({ id: rec.id, asker: { name: asker.name, role: asker.role, projectName: origin.name }, text: body.text }),
        stamp,
      );
    } catch (err) {
      // Não abriu (trava de uso, servidor reiniciando, ficha selada…): nada fica gravado, e a mesma chave serve na próxima tentativa.
      await this.deps.store.update((records) => ({ records: records.filter((r) => r.id !== rec.id), result: null }));
      throw err;
    }
    const withSession = await this.deps.store.patch(rec.id, ['running', 'answered'], (r) => ({ ...r, sessionId: r.sessionId ?? sessionId }));
    return { replay: false, consult: viewOf(withSession ?? rec) };
  }

  // ---- o ciclo: resposta, prazo, entrega ----

  /** Uma conversa de consulta terminou o turno (ou saiu). Só `turn` e `exit` contam; o resto é segundo plano. */
  async onIdle(consultId: string, sessionId: string, reason: 'turn' | 'background' | 'exit'): Promise<void> {
    if (reason === 'background') return;
    const rec = await this.deps.store.get(consultId);
    if (!rec || rec.state !== 'running') return;
    // A saída com o servidor fechando não é falha: a conversa volta com a retomada, ou o prazo decide.
    if (reason === 'exit') {
      if (!this.deps.isClosing?.()) await this.finish(rec.id, 'failed', REASONS.failed);
      return;
    }
    const turn = await this.deps.turn(sessionId);
    if (turn.failed) return void (await this.finish(rec.id, 'failed', REASONS.failed));
    // Parada no limite de uso (ou na retomada do turno que falhou): a resposta ainda vem; o prazo decide se não vier.
    if (turn.waiting) return;
    const clean = cleanAnswer(this.deps.lastText(sessionId) ?? '');
    if (!clean.text) return void (await this.finish(rec.id, 'failed', REASONS.empty));
    const answered = await this.deps.store.patch(rec.id, ['running'], (r) => ({
      ...r,
      state: 'answered',
      answer: clean.text,
      removed: clean.removed,
      cut: clean.cut,
      answeredAt: new Date(this.now()).toISOString(),
      attempts: 0,
      nextTryAt: undefined,
    }));
    if (!answered) return;
    // Libera o processo (só parado: fechar não perde nada); a entrega não espera por isso.
    void this.deps.closeSession(sessionId).catch(() => {});
    await this.deliverOne(rec.id);
  }

  /** O relógio do serviço (chamar a cada ~15 s e no boot): vence o prazo, e entrega o que ficou esperando (resposta ou aviso), com backoff. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const r of await this.deps.store.list()) {
      try {
        if (r.state === 'running' && now > Date.parse(r.deadlineAt)) await this.finish(r.id, 'expired', REASONS.deadline);
        else if (r.state === 'answered' && this.due(r, now)) await this.deliverOne(r.id);
        else if (this.needsNotice(r) && this.due(r, now)) await this.notify(r.id);
      } catch (err) {
        this.log(`${r.id}: ${(err as Error).message}`);
      }
    }
  }

  /** Cancela as consultas abertas que casam (vínculo desfeito ou encolhido): nenhuma resposta delas é entregue. Devolve quantas. */
  private async cancelWhere(match: (r: ConsultRecord) => boolean, reason: string): Promise<number> {
    let n = 0;
    for (const r of await this.deps.store.list()) {
      if (isOpen(r) && match(r) && (await this.finish(r.id, 'cancelled', reason))) n++;
    }
    return n;
  }

  /** Fecha uma consulta aberta sem resposta (erro, prazo, cancelamento): estado, motivo, a conversa para, e o aviso curto a quem perguntou. */
  private async finish(id: string, state: 'failed' | 'expired' | 'cancelled', reason: string): Promise<boolean> {
    const done = await this.deps.store.patch(id, ['running', 'answered'], (r) => ({ ...r, state, reason, answer: undefined, removed: undefined, cut: undefined, nextTryAt: undefined, attempts: 0 }));
    if (!done) return false;
    if (done.sessionId) this.deps.stopSession(done.sessionId);
    await this.notify(id).catch((err) => this.log(`${id}: aviso não saiu agora (${(err as Error).message}): o relógio tenta de novo`));
    return true;
  }

  /** Entrega a resposta (uma vez) na conversa de quem perguntou. Vínculo desfeito no meio do caminho: nada é entregue. */
  private async deliverOne(id: string): Promise<void> {
    if (this.inFlight.has(id)) return;
    this.inFlight.add(id);
    try {
      const rec = await this.deps.store.get(id);
      if (!rec || rec.state !== 'answered' || !rec.answer) return;
      if (!(await this.deps.links.allows(rec.from.projectId, rec.to.projectId, rec.from.staffId))) {
        await this.finish(id, 'cancelled', REASONS.revoked);
        return;
      }
      const names = await this.namesOf(rec);
      const text = answerMessage({ id, target: names.target, answer: rec.answer, removed: rec.removed ?? 0, cut: rec.cut ?? false });
      try {
        await this.deps.deliver(rec.from, text);
      } catch (err) {
        await this.retryLater(rec, err);
        return;
      }
      await this.deps.store.patch(id, ['answered'], (r) => ({ ...r, state: 'delivered', deliveredAt: new Date(this.now()).toISOString(), answer: undefined, removed: undefined, cut: undefined, nextTryAt: undefined }));
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** O aviso curto (sem conteúdo) de que a consulta não deu resposta, uma vez só (`notifiedAt`). Passado o prazo de desistir, a consulta é dada como avisada sem enviar. */
  private async notify(id: string): Promise<void> {
    const key = `${id}:notice`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const rec = await this.deps.store.get(id);
      if (!rec || !this.needsNotice(rec)) return;
      if (this.now() - Date.parse(rec.deadlineAt) > DELIVERY_GIVE_UP_MS) {
        await this.deps.store.patch(id, [rec.state], (r) => ({ ...r, notifiedAt: new Date(this.now()).toISOString() }));
        return;
      }
      const names = await this.namesOf(rec);
      try {
        await this.deps.deliver(rec.from, noticeMessage({ id, target: names.target, reason: rec.reason ?? REASONS.failed }));
      } catch (err) {
        await this.retryLater(rec, err);
        return;
      }
      await this.deps.store.patch(id, [rec.state], (r) => ({ ...r, notifiedAt: new Date(this.now()).toISOString(), nextTryAt: undefined }));
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** A entrega falhou: backoff exponencial com jitter até `DELIVERY_GIVE_UP_MS`; depois a resposta vira `undeliverable` (o aviso, só desiste). */
  private async retryLater(rec: ConsultRecord, err: unknown): Promise<void> {
    const now = this.now();
    const since = Date.parse(rec.answeredAt ?? rec.deadlineAt);
    if (now - since > DELIVERY_GIVE_UP_MS) {
      this.log(`${rec.id}: desisti de entregar depois de ${rec.attempts + 1} tentativas (${(err as Error).message})`);
      if (rec.state === 'answered') await this.deps.store.patch(rec.id, ['answered'], (r) => ({ ...r, state: 'undeliverable', reason: REASONS.undeliverable, answer: undefined, removed: undefined, cut: undefined, nextTryAt: undefined }));
      else await this.deps.store.patch(rec.id, [rec.state], (r) => ({ ...r, notifiedAt: new Date(now).toISOString() }));
      return;
    }
    const attempts = rec.attempts + 1;
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1)) * (0.5 + (this.deps.rand?.() ?? Math.random()) / 2);
    await this.deps.store.patch(rec.id, [rec.state], (r) => ({ ...r, attempts, nextTryAt: new Date(now + wait).toISOString() }));
  }

  // ---- auxiliares ----

  private due(r: ConsultRecord, now: number): boolean {
    return !r.nextTryAt || now >= Date.parse(r.nextTryAt);
  }

  private needsNotice(r: ConsultRecord): boolean {
    return (r.state === 'failed' || r.state === 'expired' || r.state === 'cancelled') && !r.notifiedAt;
  }

  private async namesOf(rec: ConsultRecord): Promise<{ target: { name: string; role: string; projectName: string } }> {
    const [project, staff] = await Promise.all([this.deps.project(rec.to.projectId), this.deps.staff(rec.to.projectId, rec.to.staffId)]);
    return { target: { name: staff?.name ?? 'o funcionário', role: staff?.role ?? 'funcionário', projectName: project?.name ?? 'outro projeto' } };
  }

  /** O funcionário que chama, do token e neste projeto; sem isso, 403. */
  private sender(caller: ConsultCaller | null, pathProjectId?: string): string {
    if (!caller?.staffId || (pathProjectId !== undefined && caller.projectId !== pathProjectId)) {
      throw new ConsultError(403, 'só um funcionário, com o token da conversa dele (x-myco-token), consulta outro projeto');
    }
    return caller.staffId;
  }

  private byKey(records: ConsultRecord[], from: { projectId: string; staffId: string }, key: string): ConsultRecord | undefined {
    return records.find((r) => r.from.projectId === from.projectId && r.from.staffId === from.staffId && r.key === key);
  }

  private replay(rec: ConsultRecord, hash: string): { replay: boolean; consult: PublicConsult } {
    if (rec.contentHash !== hash) throw new ConsultError(409, 'essa idempotencyKey já foi usada com outro conteúdo: use uma chave nova para uma pergunta nova');
    return { replay: true, consult: viewOf(rec) };
  }

  /** Os limites, contra os registros (persistidos): uma aberta por par, frequência por par, teto por remetente e por projeto de destino. */
  private checkLimits(records: ConsultRecord[], from: { projectId: string; staffId: string }, to: { projectId: string; staffId: string }, now: number): void {
    const mine = records.filter((r) => r.from.projectId === from.projectId && r.from.staffId === from.staffId);
    const pair = mine.filter((r) => r.to.projectId === to.projectId && r.to.staffId === to.staffId);
    const open = pair.find(isOpen);
    if (open) throw new ConsultError(409, `já há uma consulta aberta a esse funcionário (${open.id}): espere a resposta`, { id: open.id });
    const at = (r: ConsultRecord) => Date.parse(r.createdAt);
    if (pair.some((r) => now - at(r) < PAIR_INTERVAL_MS)) throw new ConsultError(429, 'aguarde um minuto antes de perguntar de novo a esse funcionário');
    if (pair.filter((r) => now - at(r) < HOUR_MS).length >= PAIR_PER_HOUR) throw new ConsultError(429, `no máximo ${PAIR_PER_HOUR} consultas por hora a esse funcionário: junte as perguntas`);
    if (mine.filter((r) => now - at(r) < HOUR_MS).length >= SENDER_PER_HOUR) throw new ConsultError(429, `no máximo ${SENDER_PER_HOUR} consultas por hora, somando todos os projetos`);
    if (records.filter((r) => isOpen(r) && r.to.projectId === to.projectId).length >= OPEN_PER_TARGET_PROJECT) {
      throw new ConsultError(429, `o projeto de destino já tem ${OPEN_PER_TARGET_PROJECT} consultas abertas: tente de novo daqui a pouco`);
    }
  }

  private parseStart(raw: unknown): { targetProjectId: string; staffId: string; text: string; idempotencyKey: string } {
    const b = this.parse(StartBody, raw);
    const text = b.text.trim();
    if (!text) throw new ConsultError(400, 'text: escreva a pergunta');
    if (text.includes('\u0000')) throw new ConsultError(400, 'text: caractere inválido');
    if (Buffer.byteLength(text, 'utf8') > TEXT_MAX_BYTES) throw new ConsultError(400, `text: a pergunta deve ter no máximo ${TEXT_MAX_BYTES / 1024} KB`);
    return { ...b, text };
  }

  private parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
    const r = schema.safeParse(raw);
    if (r.success) return r.data;
    throw new ConsultError(400, r.error.issues.map((i) => `${i.path.join('.') || 'corpo'}: ${i.message}`).join('; '));
  }
}
