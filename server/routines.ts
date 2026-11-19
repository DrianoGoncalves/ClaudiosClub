import { promises as fs } from 'node:fs';
import { ROUTINE_HISTORY_MAX, type Recurrence, type Routine, type RoutineHistoryEntry, type RoutineOutcomeState, type RoutineRun, type StaffProfile } from '../shared/model';
import { lastOccurrence, occurrencesIn, recurrenceError, recurrenceKey, recurrenceOf } from '../shared/recurrence';
import { writeAtomic } from './atomicWrite';

// Agendador das rotinas: a cada ~20 s confere, no horário desta máquina, o que cada rotina ligada deixou de tratar e manda a mensagem ao
// funcionário (o mesmo caminho do chat do painel). Só roda com o Claudio’s Club ligado.
//
// Estado por rotina em ~/.myco/routines.json (`RoutineState`):
// - `cursor`: o horário PREVISTO já tratado (rodou, falhou ou foi descartado). Nada previsto até ele volta a ser olhado: um reinício no
//   meio do minuto não dispara de novo e a deduplicação da tarefa de rotina usa o horário previsto, não o real.
// - `last` e `history`: o que aconteceu (o "Rodar agora" entra aí, mas nunca mexe no cursor).
// - `pending`: horário reservado e ainda não terminado. A reserva é gravada ANTES de executar; se a gravação falhar, não executa. Se o
//   processo cair no meio, o próximo boot marca a ocorrência como `uncertain` e não tenta de novo sozinho.
// Todo tick calcula, do cursor até agora, a ocorrência mais recente ainda não tratada: se passou há no máximo `catchUpHours` (ou ainda está
// no minuto dela), roda UMA vez; as anteriores e as fora do limite viram `discarded`, com registro. Isso cobre reinício, suspensão e travamento.
// Marco inicial: rotina nova, ligada de novo (estava desligada) ou com a recorrência editada começa no minuto atual, sem recuperar o passado.

export const routineKey = (projectId: string, staffId: string, routineId: string) => `${projectId}:${staffId}:${routineId}`;

/** Resultado de uma tentativa: começou, ou foi pulada (com o porquê). */
export interface RoutineOutcome {
  ok: boolean;
  text: string;
}

/** Algo que deu errado numa rotina, para a caixa "precisa de mim". `uncertain`: a execução ficou incerta (queda no meio), não "não rodou". */
export interface RoutineAlert {
  id: string;
  projectId: string;
  staffId: string;
  staffName: string;
  routineName: string;
  text: string;
  at: string;
  uncertain?: true;
}

export interface RoutineSchedulerOptions {
  file: string;
  /** Fichas de todos os projetos (as arquivadas ficam de fora). */
  listStaff: () => Promise<StaffProfile[]>;
  /** Manda a mensagem da rotina (ou cria a tarefa, no modo `task`); devolve se começou ou por que foi pulada. `minute`: o minuto PREVISTO da ocorrência (ver minuteKey). */
  run: (profile: StaffProfile, routine: Routine, minute: string) => Promise<RoutineOutcome>;
  /**
   * O projeto da rotina está pausado (ver server/projectPause.ts)? Então a ocorrência não roda (nada começa sozinho num projeto pausado) e vira `discarded` no histórico, sem
   * alerta (pausar foi escolha do dono) e sem voltar depois, mesmo com a execução atrasada ligada: ao retomar, vale a próxima. O "Rodar agora" é manual e roda. Sem a opção, nenhum projeto
   * é pausado; erro ao perguntar: a ocorrência espera o próximo ciclo, sem rodar nem ser tratada.
   */
  paused?: (projectId: string) => Promise<boolean>;
  /** Grava o arquivo de estado (a gravação atômica; os testes trocam por uma que falha). */
  write?: (file: string, text: string) => Promise<void>;
  log?: (line: string) => void;
}

/** O estado de uma rotina (em `routines.json`, `version: 2`). */
export interface RoutineState {
  /** Impressão digital da recorrência a que o cursor pertence; null = ainda não conferida (arquivo antigo). */
  fp: string | null;
  /** Horário previsto (ms) já tratado; null = desarmada (desligada ou ainda não vista). */
  cursor: number | null;
  /** Desde quando vale (ms): o começo do minuto do marco. */
  since: number | null;
  /** Reservada e ainda não terminada. */
  pending: { due: number; at: string } | null;
  last: RoutineRun | null;
  /** Do mais antigo ao mais novo (a tela recebe o contrário). */
  history: RoutineHistoryEntry[];
}

const MAX_ALERTS = 30;
/** Uma ocorrência ainda no minuto dela conta como "na hora", mesmo com a execução atrasada desligada (o tick é de ~20 s). */
const GRACE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Quantas ocorrências descartadas se contam uma a uma (passou disso, o registro diz "pelo menos"). */
const DISCARD_SCAN_MAX = 500;
const STATES: ReadonlySet<string> = new Set<RoutineOutcomeState>(['ran', 'failed', 'discarded', 'uncertain']);

const blank = (): RoutineState => ({ fp: null, cursor: null, since: null, pending: null, last: null, history: [] });
const floorMinute = (d: Date) => Math.floor(d.getTime() / 60_000) * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

export class RoutineScheduler {
  private states: Record<string, RoutineState> | null = null;
  private dirty = false;
  private warn: string | null = null;
  /** Ocorrências que o boot achou incertas: viram aviso no primeiro tick que conhece a ficha. */
  private uncertain: Array<{ key: string; due: number }> = [];
  private readonly alertList: RoutineAlert[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly opts: RoutineSchedulerOptions) {}

  start(intervalMs = 20_000) {
    this.timer = setInterval(() => void this.tick().catch((err) => this.log(`erro no agendador: ${String(err)}`)), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Trata, de cada rotina ligada, o que ficou para trás até `now` (ver o cabeçalho). Se o estado não puder ser lido ou gravado, nada executa. */
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const state = await this.load(now);
      const staff = await this.opts.listStaff();
      this.raiseUncertain(staff, now);
      for (const profile of staff) {
        for (const r of profile.routines ?? []) await this.consider(state, profile, r, now);
      }
      await this.flush();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * A ficha mudou (a tela gravou rotinas): arma, desarma e esquece o que foi apagado agora, sem esperar o próximo tick. Uma rotina nova,
   * ligada de novo ou com a recorrência editada começa a valer neste minuto (não recupera nada de antes).
   */
  async sync(profile: StaffProfile, now = new Date()): Promise<void> {
    const state = await this.load(now);
    const prefix = routineKey(profile.projectId, profile.id, '');
    const ids = new Set((profile.routines ?? []).map((r) => r.id));
    for (const key of Object.keys(state)) {
      if (key.startsWith(prefix) && !ids.has(key.slice(prefix.length))) {
        delete state[key];
        this.dirty = true;
      }
    }
    for (const r of profile.routines ?? []) {
      const key = routineKey(profile.projectId, profile.id, r.id);
      if (!r.enabled) this.disarm(key);
      else if (!recurrenceError(recurrenceOf(r))) this.arm((state[key] ??= blank()), recurrenceOf(r), now);
    }
    await this.flush();
  }

  /** "Rodar agora", pelo painel: roda já, registra, e não mexe no que já foi tratado (nem no cursor). */
  async runNow(profile: StaffProfile, routineId: string): Promise<RoutineOutcome | null> {
    const r = profile.routines?.find((x) => x.id === routineId);
    if (!r) return null;
    const now = new Date();
    await this.load(now);
    return this.execute(profile, r, now, null);
  }

  /** A última execução de cada rotina (a que o painel da ficha mostra), por `routineKey`. */
  async state(): Promise<Record<string, RoutineRun>> {
    const state = await this.load(new Date());
    return Object.fromEntries(Object.entries(state).flatMap(([k, v]) => (v.last ? [[k, { ...v.last }]] : [])));
  }

  /** O estado de uma rotina para a tela (histórico do mais recente ao mais antigo); null se o servidor ainda não a viu. */
  async snapshot(key: string): Promise<{ last: RoutineRun | null; history: RoutineHistoryEntry[]; armedAt: string | null; inFlight: string | null; cursor: number | null } | null> {
    const st = (await this.load(new Date()))[key];
    if (!st) return null;
    return {
      last: st.last && { ...st.last },
      history: st.history.map((h) => ({ ...h })).reverse(),
      armedAt: st.since === null ? null : iso(st.since),
      inFlight: st.pending ? iso(st.pending.due) : null,
      cursor: st.cursor,
    };
  }

  /** O arquivo de estado estava corrompido e recomeçou (null = tudo certo). */
  warning(): string | null {
    return this.warn;
  }

  alerts(): RoutineAlert[] {
    return [...this.alertList];
  }

  dismissAlert(id: string): boolean {
    const i = this.alertList.findIndex((a) => a.id === id);
    if (i === -1) return false;
    this.alertList.splice(i, 1);
    return true;
  }

  private async consider(state: Record<string, RoutineState>, profile: StaffProfile, r: Routine, now: Date): Promise<void> {
    const key = routineKey(profile.projectId, profile.id, r.id);
    if (!r.enabled) return this.disarm(key);
    const rec = recurrenceOf(r);
    if (recurrenceError(rec)) return; // recorrência inválida (ficha editada à mão): ignora
    const st = (state[key] ??= blank());
    this.arm(st, rec, now);
    const cursor = st.cursor!;
    const last = lastOccurrence(rec, now, new Date(cursor));
    if (!last) return;
    const due = last.getTime();
    const age = now.getTime() - due;
    const limit = (r.catchUpHours ?? 0) * HOUR_MS;
    // Perdidas antes da última (a que vale rodar): contam e viram descarte.
    const { items: older, truncated } = occurrencesIn(rec, new Date(cursor + 1), last, { limit: DISCARD_SCAN_MAX });
    const at = now.toISOString();
    const paused = await this.opts.paused?.(profile.projectId).catch((err: unknown) => {
      this.log(`rotina "${r.name}" de ${profile.name}: não consegui ler se o projeto está pausado (${err instanceof Error ? err.message : String(err)}); espero o próximo ciclo`);
      return null;
    });
    if (paused === null) return;
    if (paused) {
      this.record(st, discard(older, last, truncated, 'pulada: o projeto está pausado', at));
      st.cursor = due;
      this.dirty = true;
      this.log(`rotina "${r.name}" de ${profile.name}: ${older.length + 1}${truncated ? '+' : ''} ocorrência(s) pulada(s) (o projeto está pausado)`);
      return;
    }
    if (age >= GRACE_MS && age > limit) {
      const why =
        limit > 0
          ? `perdida: passou do limite de ${r.catchUpHours} h de atraso (${lateText(age)})`
          : 'perdida: o Claudio’s Club estava fechado ou parado na hora e a execução atrasada está desligada';
      this.record(st, discard(older, last, truncated, why, at));
      st.cursor = due;
      this.dirty = true;
      this.log(`rotina "${r.name}" de ${profile.name}: ${older.length + 1}${truncated ? '+' : ''} ocorrência(s) descartada(s) (${why})`);
      return;
    }
    // Reserva gravada antes de executar; se não gravou, não executa (e o cursor volta: o próximo tick tenta de novo).
    const before = { cursor: st.cursor, pending: st.pending };
    st.cursor = due;
    st.pending = { due, at };
    if (!(await this.save())) {
      st.cursor = before.cursor;
      st.pending = before.pending;
      this.log(`rotina "${r.name}" de ${profile.name}: não consegui gravar a reserva do horário; não rodou (tento de novo no próximo ciclo)`);
      return;
    }
    if (older.length) this.record(st, discard(older, null, truncated, 'perdida: uma ocorrência mais recente rodou no lugar', at));
    await this.execute(profile, r, now, due);
  }

  /** `dueMs` null = "Rodar agora". */
  private async execute(profile: StaffProfile, r: Routine, now: Date, dueMs: number | null): Promise<RoutineOutcome> {
    const key = routineKey(profile.projectId, profile.id, r.id);
    let outcome: RoutineOutcome;
    try {
      outcome = await this.opts.run(profile, r, minuteKey(new Date(dueMs ?? now.getTime())));
    } catch (err) {
      // Erro do servidor (não é "pulada"): vira aviso na caixa, com esse rótulo para não se confundir com a trava.
      outcome = { ok: false, text: `erro do servidor: ${err instanceof Error ? err.message : String(err)}` };
    }
    const state = await this.load(now);
    const st = (state[key] ??= blank());
    const at = now.toISOString();
    const age = dueMs === null ? 0 : now.getTime() - dueMs;
    if (dueMs !== null) st.pending = null;
    st.last = { at, ok: outcome.ok, text: outcome.text };
    this.record(st, {
      state: outcome.ok ? 'ran' : 'failed',
      due: iso(dueMs ?? now.getTime()),
      at,
      text: outcome.text,
      ...(age >= GRACE_MS && { lateMin: Math.floor(age / 60_000) }),
      ...(dueMs === null && { manual: true as const }),
    });
    this.dirty = true;
    await this.flush();
    this.log(`rotina "${r.name}" de ${profile.name}: ${outcome.ok ? 'começou' : 'não rodou'} (${outcome.text})`);
    if (!outcome.ok) this.pushAlert({ id: `${key}:${now.getTime()}`, projectId: profile.projectId, staffId: profile.id, staffName: profile.name, routineName: r.name, text: outcome.text, at });
    return outcome;
  }

  /**
   * Começa a valer neste minuto (o minuto atual ainda conta) se for nova, estiver desarmada ou a recorrência mudou; senão não mexe no cursor.
   * Depois de um arquivo de estado corrompido vale a partir de agora, sem o minuto atual: o que rodou neste minuto pode ter se perdido com ele.
   */
  private arm(st: RoutineState, rec: Recurrence, now: Date) {
    const fp = recurrenceKey(rec);
    const start = this.warn ? now.getTime() + 1 : floorMinute(now);
    if (st.cursor === null || (st.fp !== null && st.fp !== fp)) {
      st.cursor = start - 1;
      st.since = start;
      this.dirty = true;
    }
    if (st.fp !== fp) {
      st.fp = fp;
      this.dirty = true;
    }
    if (st.since === null) {
      st.since = start;
      this.dirty = true;
    }
  }

  /** Desligada: esquece o marco. Ao ligar de novo, o que passou enquanto estava desligada não volta. */
  private disarm(key: string) {
    const st = this.states?.[key];
    if (!st || (st.cursor === null && st.since === null && st.fp === null)) return;
    st.cursor = null;
    st.since = null;
    st.fp = null;
    this.dirty = true;
  }

  private record(st: RoutineState, entry: RoutineHistoryEntry) {
    st.history.push(entry);
    if (st.history.length > ROUTINE_HISTORY_MAX) st.history.splice(0, st.history.length - ROUTINE_HISTORY_MAX);
    this.dirty = true;
  }

  private pushAlert(alert: RoutineAlert) {
    this.alertList.push(alert);
    if (this.alertList.length > MAX_ALERTS) this.alertList.splice(0, this.alertList.length - MAX_ALERTS);
  }

  private raiseUncertain(staff: StaffProfile[], now: Date) {
    const queue = this.uncertain.splice(0);
    for (const { key, due } of queue) {
      for (const profile of staff) {
        const r = (profile.routines ?? []).find((x) => key === routineKey(profile.projectId, profile.id, x.id));
        if (!r) continue;
        this.pushAlert({
          id: `${key}:${due}:uncertain`,
          projectId: profile.projectId,
          staffId: profile.id,
          staffName: profile.name,
          routineName: r.name,
          text: `a execução de ${new Date(due).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} ficou incerta: o Claudio’s Club caiu antes de terminar. Confira se começou; não tento de novo sozinho`,
          at: now.toISOString(),
          uncertain: true,
        });
      }
    }
  }

  /**
   * Lê o estado uma vez. Arquivo ausente = estado vazio. Arquivo que existe e não dá para ler (corrompido, vazio) NÃO vira estado vazio calado:
   * a cópia fica em `<arquivo>.corrompido-<hora>`, `warning()` conta, e as rotinas recomeçam do minuto atual (nada repete). Erro de leitura que
   * não é "ausente" (permissão, disco) lança: o tick não executa nada e tenta de novo no próximo ciclo.
   */
  private async load(now: Date): Promise<Record<string, RoutineState>> {
    if (this.states) return this.states;
    let raw: string | null;
    try {
      raw = await fs.readFile(this.opts.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      raw = null;
    }
    const state = raw === null ? {} : await this.parse(raw, now);
    for (const [key, st] of Object.entries(state)) {
      if (!st.pending) continue;
      // O processo caiu depois da reserva e antes do fim: não sei se começou. Registra e não tenta de novo.
      const at = now.toISOString();
      this.record(st, {
        state: 'uncertain',
        due: iso(st.pending.due),
        at,
        text: 'o Claudio’s Club caiu depois de reservar este horário e antes de terminar: não sei se a rotina chegou a começar (não tento de novo sozinho)',
      });
      this.uncertain.push({ key, due: st.pending.due });
      st.pending = null;
    }
    this.states = state;
    return state;
  }

  private async parse(raw: string, now: Date): Promise<Record<string, RoutineState>> {
    let data: unknown;
    try {
      // Editado à mão no Windows, o arquivo pode vir com BOM.
      data = JSON.parse(raw.replace(/^﻿/, ''));
    } catch {
      data = undefined;
    }
    const obj = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    if (!obj || (obj.version !== undefined && (obj.version !== 2 || !isObject(obj.routines)))) {
      const copy = `${this.opts.file}.corrompido-${now.getTime()}`;
      await fs.writeFile(copy, raw, 'utf8').catch(() => undefined);
      this.warn = `o arquivo de estado das rotinas estava corrompido (cópia em ${copy}); recomecei sem repetir nada, mas atrasos antigos não voltam`;
      this.log(this.warn);
      this.dirty = true;
      return {};
    }
    const out: Record<string, RoutineState> = {};
    if (obj.version === 2) {
      for (const [key, v] of Object.entries(obj.routines as Record<string, unknown>)) {
        const st = sanitize(v);
        if (st) out[key] = st;
      }
      return out;
    }
    // Arquivo antigo (sem `version`): `{ chave: { at, ok, text, minute? } }`. Migra: o último minuto que disparou segura o cursor, para a
    // ocorrência desse minuto não rodar de novo; o resto começa no marco normal.
    const start = floorMinute(now);
    for (const [key, v] of Object.entries(obj)) {
      if (!isObject(v) || typeof v.at !== 'string' || typeof v.ok !== 'boolean' || typeof v.text !== 'string') continue;
      const fired = typeof v.minute === 'string' ? new Date(v.minute).getTime() : NaN;
      out[key] = { ...blank(), last: { at: v.at, ok: v.ok, text: v.text }, ...(Number.isFinite(fired) && fired >= start && { cursor: fired, since: start }) };
    }
    this.dirty = true;
    return out;
  }

  private async flush() {
    if (this.dirty) await this.save();
  }

  /** Grava o estado; false se não conseguiu (quem reserva horário não executa). */
  private async save(): Promise<boolean> {
    if (!this.states) return true;
    try {
      await (this.opts.write ?? writeAtomic)(this.opts.file, JSON.stringify({ version: 2, routines: this.states }, null, 2) + '\n');
      this.dirty = false;
      return true;
    } catch (err) {
      this.log(`não consegui gravar ${this.opts.file}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private log(line: string) {
    (this.opts.log ?? ((l: string) => console.log(`[rotina] ${l}`)))(line);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Lê uma entrada do arquivo sem confiar nela: o que não é do formato some (a rotina recomeça do marco, sem repetir). */
function sanitize(v: unknown): RoutineState | null {
  if (!isObject(v)) return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const run = (x: unknown): RoutineRun | null => (isObject(x) && typeof x.at === 'string' && typeof x.ok === 'boolean' && typeof x.text === 'string' ? { at: x.at, ok: x.ok, text: x.text } : null);
  const history: RoutineHistoryEntry[] = [];
  for (const h of Array.isArray(v.history) ? v.history : []) {
    if (!isObject(h) || typeof h.state !== 'string' || !STATES.has(h.state) || typeof h.due !== 'string' || typeof h.at !== 'string' || typeof h.text !== 'string') continue;
    const count = num(h.count);
    const late = num(h.lateMin);
    history.push({
      state: h.state as RoutineOutcomeState,
      due: h.due,
      at: h.at,
      text: h.text,
      ...(typeof h.from === 'string' && { from: h.from }),
      ...(count !== null && { count }),
      ...(h.more === true && { more: true as const }),
      ...(late !== null && { lateMin: late }),
      ...(h.manual === true && { manual: true as const }),
    });
  }
  const due = isObject(v.pending) ? num(v.pending.due) : null;
  return {
    fp: typeof v.fp === 'string' ? v.fp : null,
    cursor: num(v.cursor),
    since: num(v.since),
    pending: due !== null && isObject(v.pending) && typeof v.pending.at === 'string' ? { due, at: v.pending.at } : null,
    last: run(v.last),
    history: history.slice(-ROUTINE_HISTORY_MAX),
  };
}

/** Uma linha de descarte: `last` é a mais recente do lote (ou, sem ela, a última de `older`). */
function discard(older: Date[], last: Date | null, truncated: boolean, text: string, at: string): RoutineHistoryEntry {
  const dues = last ? [...older, last] : older;
  const first = dues[0]!;
  const latest = dues.at(-1)!;
  return {
    state: 'discarded',
    due: latest.toISOString(),
    at,
    text,
    ...(dues.length > 1 && { from: first.toISOString(), count: dues.length, ...(truncated && { more: true as const }) }),
  };
}

function lateText(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 120 ? `${min} min depois` : `${Math.round(min / 60)} h depois`;
}

/** "2026-10-26T08:00" no horário local: identifica o minuto previsto da ocorrência. */
function minuteKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
