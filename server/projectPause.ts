import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { ProjectPause } from '../shared/model';
import { writeAtomic } from './atomicWrite';

// Projeto pausado: nada de execução começa sozinho nele (a fila, o ajuste da reprovação, as rotinas, o despertador, o "continue", a retomada do reinício e a troca de motor);
// o que já roda termina o turno e para ali, e as ações manuais do dono seguem valendo. A revisão automática da entrega já feita NÃO é barrada: o veredito é gravado. O estado é por projeto, em `~/.myco/paused-projects.json` (da máquina, não do
// repositório: pausar é decisão de quem paga o consumo aqui), e sobrevive a reinício. Um só lugar responde "este projeto está pausado?": todo ponto de partida
// automática pergunta a este arquivo (`isPaused`), e nenhum guarda cópia.
//
// Pausa de versão (`mode: 'version'`): o mesmo mecanismo, com prazo. `isPaused` responde true para os dois modos, então todo ponto de partida que já pergunta continua barrado; quem
// diferencia o modo é só o ajuste em voo (ver `TaskService.holdsAuto`). Ela sai sozinha em `until`: o vencimento é conferido em toda pergunta (então a liberação é no instante), grava a saída
// uma vez e guarda o aviso de saída (`ended`, até `ENDED_KEEP_MS`) para a caixa do dono. A pausa comum segue exatamente `{ at }`.

/** Prazo da pausa de versão quando o dono (tela) não diz; o funcionário (API) sempre diz. */
export const VERSION_PAUSE_DEFAULT_MINUTES = 30;
/** Teto do prazo da pausa de versão. */
export const VERSION_PAUSE_MAX_MINUTES = 120;
/** Quanto tempo o aviso de saída fica na caixa do dono se ele não o dispensar. */
export const ENDED_KEEP_MS = 24 * 60 * 60_000;

export type PauseBy = NonNullable<ProjectPause['by']>;
/** Como a pausa de versão acabou: o prazo venceu, quem ligou encerrou, o dono retomou o projeto, ou o dono pausou "comum" por cima (a de versão virou comum). */
export type PauseEndReason = 'expired' | 'ended' | 'resumed' | 'standard';
/** A saída de uma pausa de versão (só dela): quando, por quê, a pausa que acabou e quem a encerrou (funcionário que ligou; ausente = prazo ou o dono). */
export interface ProjectPauseEnd {
  at: string;
  reason: PauseEndReason;
  pause: ProjectPause;
  endedBy?: PauseBy;
}

const By = z.object({ staffId: z.string().min(1).max(40), name: z.string().min(1).max(100) });
const Entry = z
  .object({ at: z.string().datetime(), mode: z.literal('version').optional(), until: z.string().datetime().optional(), by: By.optional() })
  .refine((e) => e.mode !== 'version' || !!e.until, 'pausa de versão sem prazo');
const Ended = z.object({ at: z.string().datetime(), reason: z.enum(['expired', 'ended', 'resumed', 'standard']), pause: Entry, endedBy: By.optional() });

/** O que o arquivo guarda vira o que a API mostra: a pausa comum é só `{ at }`; o resto é da de versão. */
function normalize(e: z.infer<typeof Entry>): ProjectPause {
  return e.mode === 'version' ? { at: e.at, mode: 'version', until: e.until!, ...(e.by && { by: { ...e.by } }) } : { at: e.at };
}

/** A hora do dia (HH:MM, a da máquina) de um horário ISO, para as mensagens da pausa de versão. */
export function clockOf(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
}

const copy = (p: ProjectPause): ProjectPause => ({ ...p, ...(p.by && { by: { ...p.by } }) });

export class ProjectPauses {
  private loading: Promise<Map<string, ProjectPause>> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private ended = new Map<string, ProjectPauseEnd>();

  /** `onEnd`: a pausa de versão acabou (prazo, encerrada, retomada ou virou comum): quem liga isto ao serviço retoma a fila na hora. Falha dele não volta para cá. */
  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void = (line) => console.warn(`[pausa] ${line}`),
    private readonly onEnd?: (projectId: string, end: ProjectPauseEnd) => void,
  ) {}

  /** Está pausado agora (qualquer modo)? Lê o arquivo na primeira pergunta e responde da memória depois; a pausa de versão vencida sai aqui, e responde que não. */
  async isPaused(projectId: string, now = new Date()): Promise<boolean> {
    return (await this.current(projectId, now)) !== undefined;
  }

  /** O estado do projeto: null = rodando. */
  async get(projectId: string, now = new Date()): Promise<ProjectPause | null> {
    const found = await this.current(projectId, now);
    return found ? copy(found) : null;
  }

  /**
   * Pausa comum (de novo não muda o horário em que parou). Grava antes de responder: se não gravou, não pausou e o erro sobe. Por cima de uma pausa de versão ela a converte
   * (a comum é a mais estrita: sem prazo, sem sair sozinha), mantém o horário em que o projeto parou e guarda a saída da de versão (`standard`).
   */
  async pause(projectId: string, now = new Date()): Promise<ProjectPause> {
    const map = await this.load();
    const had = await this.current(projectId, now);
    if (had && had.mode !== 'version') return copy(had);
    const entry: ProjectPause = { at: had?.at ?? now.toISOString() };
    const prevEnd = this.ended.get(projectId);
    const end: ProjectPauseEnd | null = had ? { at: now.toISOString(), reason: 'standard', pause: copy(had) } : null;
    map.set(projectId, entry);
    if (end) this.ended.set(projectId, end);
    try {
      await this.save(map);
    } catch (err) {
      if (had) map.set(projectId, had);
      else map.delete(projectId);
      if (end) prevEnd ? this.ended.set(projectId, prevEnd) : this.ended.delete(projectId);
      throw err;
    }
    if (end) this.notify(projectId, end);
    return copy(entry);
  }

  /**
   * Liga a pausa de versão por `minutes` (inteiro de 1 a `VERSION_PAUSE_MAX_MINUTES`; quem chama já validou, aqui é a última trava). `ok: false`: o projeto já está em pausa comum (`standard`: a de
   * versão a soltaria sozinha no prazo, e quem pausou não pediu isso) ou em pausa de versão de outra pessoa (`other`); `pause` é a que está valendo. Quem já ligou chamando de novo
   * é um nada (`created: false`, o prazo não muda). Grava antes de responder: se não gravou, não pausou e o erro sobe.
   */
  async pauseVersion(
    projectId: string,
    input: { minutes: number; by?: PauseBy },
    now = new Date(),
  ): Promise<{ ok: true; pause: ProjectPause; created: boolean } | { ok: false; reason: 'standard' | 'other'; pause: ProjectPause }> {
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > VERSION_PAUSE_MAX_MINUTES) throw new RangeError(`prazo de 1 a ${VERSION_PAUSE_MAX_MINUTES} minutos`);
    const map = await this.load();
    const had = await this.current(projectId, now);
    if (had) {
      if (had.mode !== 'version') return { ok: false, reason: 'standard', pause: copy(had) };
      if ((had.by?.staffId ?? null) !== (input.by?.staffId ?? null)) return { ok: false, reason: 'other', pause: copy(had) };
      return { ok: true, pause: copy(had), created: false };
    }
    const entry: ProjectPause = { at: now.toISOString(), mode: 'version', until: new Date(now.getTime() + input.minutes * 60_000).toISOString(), ...(input.by && { by: { ...input.by } }) };
    map.set(projectId, entry);
    try {
      await this.save(map);
    } catch (err) {
      map.delete(projectId);
      throw err;
    }
    return { ok: true, pause: copy(entry), created: true };
  }

  /**
   * Despausa (qualquer modo). Devolve se despausou (false: não estava pausado, ou `only` recusou). Sendo a de versão, guarda a saída (`reason`: `ended` quando quem ligou encerra, `resumed` quando é o dono; `by` é quem encerrou,
   * se funcionário) e avisa `onEnd`. A que já venceu não conta como pausada: saiu sozinha antes.
   */
  async resume(projectId: string, opts: { reason?: 'ended' | 'resumed'; by?: PauseBy; now?: Date; only?: (pause: ProjectPause) => boolean } = {}): Promise<boolean> {
    const now = opts.now ?? new Date();
    const map = await this.load();
    const had = await this.current(projectId, now);
    // `only`: a conferência de quem encerra, na mesma vez da troca (de outro modo, entre a leitura e aqui, a pausa pode ter virado a comum): não passando, nada muda.
    if (!had || (opts.only && !opts.only(had))) return false;
    const end = this.drop(map, projectId, had, opts.reason ?? 'resumed', now, opts.by);
    try {
      await this.save(map);
    } catch (err) {
      map.set(projectId, had);
      if (end) end.undo();
      throw err;
    }
    if (end) this.notify(projectId, end.end);
    return true;
  }

  /** Os projetos pausados (qualquer modo, sem os vencidos), para a listagem de resumo. */
  async all(now = new Date()): Promise<Record<string, ProjectPause>> {
    const map = await this.load();
    for (const id of [...map.keys()]) await this.current(id, now);
    return Object.fromEntries([...map].map(([id, p]) => [id, copy(p)]));
  }

  /**
   * O que a caixa do dono mostra: as pausas de versão ligadas agora e as saídas de menos de `ENDED_KEEP_MS` que ele não dispensou (a pausa de versão vencida sai aqui, como em
   * `isPaused`). A pausa comum não tem aviso.
   */
  async notices(now = new Date()): Promise<{ active: Array<{ projectId: string; pause: ProjectPause }>; ended: Array<{ projectId: string; end: ProjectPauseEnd }> }> {
    const map = await this.load();
    for (const id of [...map.keys()]) await this.current(id, now);
    const active = [...map].filter(([, p]) => p.mode === 'version').map(([projectId, p]) => ({ projectId, pause: copy(p) }));
    const ended = [...this.ended]
      .filter(([, e]) => Date.parse(e.at) + ENDED_KEEP_MS > now.getTime())
      .map(([projectId, e]) => ({ projectId, end: { ...e, pause: copy(e.pause) } }));
    return { active, ended };
  }

  /** O dono dispensou o aviso de saída (o `at` dele, em ms, é o que o id da caixa leva; uma saída mais nova do mesmo projeto não sai por engano). Devolve se tirou. */
  async dismissEnd(projectId: string, atMs: number): Promise<boolean> {
    const map = await this.load();
    const found = this.ended.get(projectId);
    if (!found || Date.parse(found.at) !== atMs) return false;
    this.ended.delete(projectId);
    await this.save(map).catch((err: unknown) => this.log(`aviso de saída de ${projectId} não gravado: ${err instanceof Error ? err.message : String(err)}`));
    return true;
  }

  /** A pausa de agora: a de versão vencida sai aqui, sozinha e uma vez, e responde que não há. */
  private async current(projectId: string, now: Date): Promise<ProjectPause | undefined> {
    const map = await this.load();
    const entry = map.get(projectId);
    if (!entry?.until || Date.parse(entry.until) > now.getTime()) return entry;
    // Daqui até o `delete` é síncrono: de duas perguntas ao mesmo tempo, só a primeira tira e avisa. A gravação segue na fila; se falhar, o log conta e o reinício tira de novo a que venceu.
    const end = this.drop(map, projectId, entry, 'expired', now);
    this.save(map).catch((err: unknown) => this.log(`saída da pausa de versão de ${projectId} não gravada: ${err instanceof Error ? err.message : String(err)}`));
    if (end) this.notify(projectId, end.end);
    return undefined;
  }

  /** Tira `entry` do mapa e, sendo de versão, guarda a saída (o `at` do prazo vencido é o do prazo, não o de quando alguém perguntou). `undo` desfaz os dois se a gravação falhar. */
  private drop(map: Map<string, ProjectPause>, projectId: string, entry: ProjectPause, reason: PauseEndReason, now: Date, endedBy?: PauseBy): { end: ProjectPauseEnd; undo: () => void } | null {
    map.delete(projectId);
    if (entry.mode !== 'version') return null;
    const prev = this.ended.get(projectId);
    const end: ProjectPauseEnd = { at: reason === 'expired' ? (entry.until ?? now.toISOString()) : now.toISOString(), reason, pause: copy(entry), ...(endedBy && { endedBy: { ...endedBy } }) };
    this.ended.set(projectId, end);
    return {
      end,
      undo: () => {
        if (prev) this.ended.set(projectId, prev);
        else this.ended.delete(projectId);
      },
    };
  }

  private notify(projectId: string, end: ProjectPauseEnd): void {
    try {
      this.onEnd?.(projectId, end);
    } catch (err) {
      this.log(`aviso de saída da pausa de ${projectId} falhou: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private load(): Promise<Map<string, ProjectPause>> {
    this.loading ??= this.read().catch((err) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  /**
   * Arquivo ausente = nenhum pausado. Estragado: a cópia fica em `.bad` e o log conta (como o resto do que o Club guarda em disco); entrada por entrada, uma
   * torta não leva as outras. Erro de leitura que não é "ausente" (permissão, disco) sobe: pausa que não dá para ler não vira "tudo rodando" calado, a pergunta
   * falha e quem pergunta (a fila, o tick) tenta de novo na próxima rodada.
   */
  private async read(): Promise<Map<string, ProjectPause>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      // ENOTDIR: um pedaço do caminho é arquivo (Linux); o de pausas também não existe.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return new Map();
      throw err;
    }
    let list: unknown;
    let endedList: unknown;
    try {
      const body = JSON.parse(raw.replace(/^﻿/, '')) as { projects?: unknown; ended?: unknown } | null;
      list = body?.projects;
      endedList = body?.ended;
      if (!list || typeof list !== 'object' || Array.isArray(list)) throw new Error('falta o mapa "projects"');
    } catch (err) {
      const bad = `${this.file}.bad`;
      await fs.rename(this.file, bad).catch(() => {});
      this.log(`${this.file} estragado (${err instanceof Error ? err.message : String(err)}); guardado em ${bad}: nenhum projeto aparece pausado, pause de novo`);
      return new Map();
    }
    const map = new Map<string, ProjectPause>();
    for (const [id, value] of Object.entries(list as Record<string, unknown>)) {
      const e = Entry.safeParse(value);
      if (e.success) map.set(id, normalize(e.data));
      else this.log(`entrada de ${id} em ${this.file} inválida, ignorada`);
    }
    // Os avisos de saída são do que o dono ainda não viu: o que não lê não derruba nada (some sem log, é só aviso).
    if (endedList && typeof endedList === 'object' && !Array.isArray(endedList)) {
      for (const [id, value] of Object.entries(endedList as Record<string, unknown>)) {
        const e = Ended.safeParse(value);
        if (e.success) this.ended.set(id, { at: e.data.at, reason: e.data.reason, pause: normalize(e.data.pause), ...(e.data.endedBy && { endedBy: e.data.endedBy }) });
      }
    }
    return map;
  }

  /** Gravações em fila: duas seguidas não se atropelam. Falha sobe para quem pediu (a pausa que não gravou não vale). */
  private save(map: Map<string, ProjectPause>): Promise<void> {
    const body = { version: 1, projects: Object.fromEntries(map), ...(this.ended.size > 0 && { ended: Object.fromEntries(this.ended) }) };
    const run = this.saving.then(() => writeAtomic(this.file, JSON.stringify(body, null, 2) + '\n'));
    this.saving = run.catch(() => {});
    return run;
  }
}
