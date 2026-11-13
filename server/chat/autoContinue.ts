import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { writeAtomic } from '../staff/store';
import { resumePlan } from './usageLimit';

// Conversa que bateu no limite de uso da assinatura: espera o limite voltar e manda "continue".
// As pendências ficam em disco (sobrevivem a reiniciar o servidor); um temporizador confere as vencidas.
// O despertador (ver wake.ts) é uma segunda instância desta classe, com arquivo próprio: cada pendência leva o
// `text` a mandar, e as duas instâncias nunca se apagam uma à outra.

/** A mensagem que o Claudio’s Club manda sozinho. Sempre esta. */
export const CONTINUE_TEXT = 'continue';

/** Uma conversa esperando o limite voltar. */
export interface Pending {
  projectId: string;
  sessionId: string;
  /** De quem é a conversa: o "continue" reabre com a ficha dele (sem isso reabriria como conversa avulsa). */
  staffId: string | null;
  /** Quando mandar o "continue" (ms): a volta do limite mais a folga. */
  at: number;
  /** Quando o limite volta (ms), para o aviso na conversa. */
  resetsAt: number;
  /** O que mandar na conversa (despertador). Sem ele, quem manda decide: o "continue" do limite. */
  text?: string;
  /** Motor da conversa (ausente = claude): a trava de consumo confere o uso desse motor, não o do outro. */
  engine?: 'claude' | 'codex';
}

export type AutoContinueEvent =
  | { type: 'cancelled'; by: 'user' | 'message' | 'staff' | 'fallback' | 'cap'; pending: Pending }
  /** A opção foi desligada: a pendência saiu sem mandar (todas, de uma vez). */
  | { type: 'dropped'; pending: Pending }
  /** A linha de parada do usuário ainda barra: nova hora. */
  | { type: 'deferred'; pending: Pending }
  | { type: 'sent'; pending: Pending }
  /** Não saiu: o envio falhou, ou (`gaveUp`) o limite estourou vezes demais seguidas e ele desistiu. */
  | { type: 'failed'; pending: Pending; error: string; gaveUp?: true };

export interface AutoContinueOptions {
  /** Onde guardar as pendências (em MYCO_HOME). */
  file: string;
  /** A opção `autoContinue` do config, conferida na hora de agendar e na hora de mandar. */
  enabled: () => Promise<boolean>;
  /**
   * A linha de parada do usuário (5h/7d da conta, orçamento do projeto) barra agora? Devolve onde ela volta. `engine` é o
   * motor da conversa: o uso conferido é o dele (a conta do Codex não é barrada pelo consumo do Claude, nem o contrário).
   */
  stopHit: (projectId: string, staffId: string | null, engine: 'claude' | 'codex') => Promise<{ resetsAt: string | null } | null>;
  /** Resets (5h/7d) que o app conhece, para reagendar quando a linha de parada barra. */
  knownResets: () => Promise<ReadonlyArray<{ kind: string; resetsAt: string | null }>>;
  /** Manda o "continue" (ou o `text` da pendência) na conversa, acordando-a se estiver fechada. */
  send: (p: Pending) => Promise<void>;
  now?: () => number;
  /** Entre um "continue" e o seguinte, quando várias vencem juntas. */
  spacingMs?: number;
  /** De quanto em quanto tempo o temporizador confere. */
  tickMs?: number;
  log?: (line: string) => void;
}

const PendingEntry = z.object({
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  staffId: z.string().nullable().catch(null),
  at: z.string(),
  resetsAt: z.string(),
  text: z.string().optional(),
  engine: z.enum(['claude', 'codex']).optional().catch(undefined),
});

export class AutoContinue {
  private readonly items = new Map<string, Pending>();
  private readonly listeners = new Set<(e: AutoContinueEvent) => void>();
  private loading: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastSentAt = -Infinity;
  /** Parado (reinício): nada mais sai até o `start` do boot. */
  private halted = false;

  constructor(private readonly opts: AutoContinueOptions) {}

  subscribe(listener: (e: AutoContinueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Liga o temporizador (não segura o processo aberto). */
  start() {
    this.halted = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err) => this.log(`erro ao conferir: ${err instanceof Error ? err.message : String(err)}`)), this.opts.tickMs ?? 10_000);
    this.timer.unref();
  }

  /**
   * Para o temporizador e não manda mais nada (o reinício: as pendências ficam no disco e voltam no `start` do boot).
   * Um envio já conferido, mas ainda não mandado, também não sai.
   */
  stop() {
    this.halted = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Pendências, da que vence primeiro à última. */
  async list(): Promise<Pending[]> {
    await this.load();
    return [...this.items.values()].sort((a, b) => a.at - b.at).map((p) => ({ ...p }));
  }

  async get(sessionId: string): Promise<Pending | null> {
    await this.load();
    const p = this.items.get(sessionId);
    return p ? { ...p } : null;
  }

  /**
   * Agenda o "continue" desta conversa (uma pendência por conversa: a nova substitui a antiga).
   * Com a opção desligada não guarda nada e devolve false.
   */
  async schedule(p: Pending): Promise<boolean> {
    await this.load();
    if (!(await this.opts.enabled())) {
      if (this.items.delete(p.sessionId)) await this.save();
      return false;
    }
    this.items.set(p.sessionId, { ...p });
    await this.save();
    return true;
  }

  /** Tira a pendência da conversa (botão Cancelar, ou você mandou mensagem). Devolve se havia. */
  async cancel(sessionId: string, by: 'user' | 'message' | 'staff' | 'fallback' | 'cap'): Promise<boolean> {
    await this.load();
    const p = this.items.get(sessionId);
    if (!p) return false;
    this.items.delete(sessionId);
    await this.save();
    this.emit({ type: 'cancelled', by, pending: p });
    return true;
  }

  /**
   * Desiste do "continue" desta conversa (estourou o limite vezes demais seguidas): tira a pendência, se houver,
   * e avisa com `failed` (quem ouve entrega a tarefa como se o "continue" não existisse). Com a opção desligada
   * não havia nada prometido: devolve false e não avisa.
   */
  async giveUp(p: Pending, error: string): Promise<boolean> {
    await this.load();
    if (!(await this.opts.enabled())) return false;
    if (this.items.delete(p.sessionId)) await this.save();
    this.emit({ type: 'failed', pending: p, error, gaveUp: true });
    return true;
  }

  /**
   * Confere as vencidas e manda no máximo um "continue" por vez (com `spacingMs` entre eles). Opção
   * desligada: solta todas as pendências na hora (`dropped`), vencidas ou não. Linha de parada ainda
   * barrando: reagenda, sem mandar.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.load();
      if (!this.items.size) return;
      const now = () => this.opts.now?.() ?? Date.now();
      if (!(await this.opts.enabled())) {
        const all = [...this.items.values()].sort((a, b) => a.at - b.at);
        this.items.clear();
        await this.save();
        for (const p of all) this.emit({ type: 'dropped', pending: p });
        return;
      }
      if (now() - this.lastSentAt < (this.opts.spacingMs ?? 20_000)) return;
      const due = [...this.items.values()].filter((p) => p.at <= now()).sort((a, b) => a.at - b.at);
      for (const p of due) {
        // Cancelada enquanto conferia: não manda.
        if (this.items.get(p.sessionId) !== p) continue;
        // Sem conseguir conferir a linha de parada, não arrisca: espera mais um pouco.
        const stop = await this.opts.stopHit(p.projectId, p.staffId, p.engine ?? 'claude').catch((err) => {
          this.log(`${p.sessionId}: não consegui conferir a linha de parada: ${err instanceof Error ? err.message : String(err)}`);
          return { resetsAt: null };
        });
        if (this.items.get(p.sessionId) !== p) continue;
        if (stop) {
          const reset = stop.resetsAt ? Date.parse(stop.resetsAt) : NaN;
          const plan = resumePlan({ resetsAt: Number.isFinite(reset) ? reset : null, window: null }, await this.opts.knownResets(), now());
          const next = { ...p, at: plan.at, resetsAt: plan.resetsAt };
          this.items.set(p.sessionId, next);
          await this.save();
          this.emit({ type: 'deferred', pending: next });
          continue;
        }
        // Manda primeiro e só depois tira do disco: se o servidor cair entre os dois passos, o "continue" pode
        // sair de novo na volta (aceitável); perder a pendência deixaria a tarefa presa em "fazendo".
        if (this.halted) return;
        this.lastSentAt = now();
        let error: string | null = null;
        try {
          await this.opts.send(p);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          this.log(`${p.sessionId}: não consegui mandar a mensagem: ${error}`);
        }
        // Durante o envio, mensagem sua (ou outro estouro) já tirou ou trocou a pendência, e quem fez isso já
        // avisou: não apaga de novo nem repete o aviso.
        if (this.items.get(p.sessionId) === p) {
          this.items.delete(p.sessionId);
          await this.save();
          this.emit(error === null ? { type: 'sent', pending: p } : { type: 'failed', pending: p, error });
        }
        return;
      }
    } finally {
      this.ticking = false;
    }
  }

  // ---- disco ----

  private load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.opts.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // ainda não há pendência guardada
      return this.quarantine(`não consegui ler: ${err instanceof Error ? err.message : String(err)}`);
    }
    let list: unknown;
    try {
      list = (JSON.parse(raw.replace(/^\uFEFF/, '')) as { pending?: unknown } | null)?.pending;
      if (!Array.isArray(list)) throw new Error('falta a lista "pending"');
    } catch (err) {
      return this.quarantine(`arquivo estragado: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Entrada por entrada: uma estragada não leva as outras.
    for (const [i, item] of list.entries()) {
      const e = PendingEntry.safeParse(item);
      const at = e.success ? Date.parse(e.data.at) : NaN;
      const resetsAt = e.success ? Date.parse(e.data.resetsAt) : NaN;
      if (!e.success || !Number.isFinite(at) || !Number.isFinite(resetsAt)) {
        this.log(`entrada ${i + 1} de ${this.opts.file} inválida, ignorada: ${JSON.stringify(item)?.slice(0, 200)}`);
        continue;
      }
      // O que já está na memória (agendado antes de ler) vale mais que o arquivo.
      if (!this.items.has(e.data.sessionId)) {
        this.items.set(e.data.sessionId, {
          projectId: e.data.projectId,
          sessionId: e.data.sessionId,
          staffId: e.data.staffId,
          at,
          resetsAt,
          ...(e.data.text !== undefined && { text: e.data.text }),
          ...(e.data.engine !== undefined && { engine: e.data.engine }),
        });
      }
    }
  }

  /**
   * Sessões com pendência (memória + arquivo), para a exclusão da retenção. Sem quarentena: arquivo que existe e não lê, JSON
   * ruim ou entrada estragada LANÇAM (a varredura aborta em vez de apagar sem saber quem tem despertador).
   */
  async sessionIdsStrict(): Promise<string[]> {
    const ids = new Set(this.items.keys());
    let raw: string;
    try {
      raw = await fs.readFile(this.opts.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [...ids];
      throw err;
    }
    const list = (JSON.parse(raw.replace(/^﻿/, '')) as { pending?: unknown } | null)?.pending;
    if (!Array.isArray(list)) throw new Error(`${this.opts.file}: falta a lista "pending"`);
    for (const item of list) {
      const e = PendingEntry.safeParse(item);
      if (!e.success) throw new Error(`${this.opts.file}: entrada de pendência estragada`);
      ids.add(e.data.sessionId);
    }
    return [...ids];
  }

  /** Arquivo que não dá para ler: guarda como `.bad` (não é sobrescrito na próxima gravação) e segue vazio. */
  private async quarantine(why: string): Promise<void> {
    const bad = `${this.opts.file}.bad`;
    try {
      await fs.rename(this.opts.file, bad);
      this.log(`${this.opts.file}: ${why}; guardado em ${bad}, seguindo sem pendências antigas`);
    } catch (err) {
      this.log(`${this.opts.file}: ${why}; não consegui guardar como .bad (${err instanceof Error ? err.message : String(err)}), seguindo sem pendências antigas`);
    }
  }

  /** Gravações em fila: duas seguidas não se atropelam. */
  private save(): Promise<void> {
    const body = {
      pending: [...this.items.values()].map((p) => ({
        projectId: p.projectId,
        sessionId: p.sessionId,
        staffId: p.staffId,
        at: new Date(p.at).toISOString(),
        resetsAt: new Date(p.resetsAt).toISOString(),
        ...(p.text !== undefined && { text: p.text }),
        ...(p.engine !== undefined && { engine: p.engine }),
      })),
    };
    this.saving = this.saving.then(() => writeAtomic(this.opts.file, JSON.stringify(body, null, 2) + '\n')).catch((err) => this.log(`não consegui gravar as pendências: ${err instanceof Error ? err.message : String(err)}`));
    return this.saving;
  }

  private emit(e: AutoContinueEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.log(`erro ao avisar: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private log(line: string) {
    (this.opts.log ?? ((l: string) => console.log(`[continuar] ${l}`)))(line);
  }
}
