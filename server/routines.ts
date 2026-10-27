import { promises as fs } from 'node:fs';
import { cronMatches, parseCron } from '../shared/cron';
import type { Routine, RoutineRun, StaffProfile } from '../shared/model';
import { writeAtomic } from './staff/store';

// Agendador das rotinas: a cada ~20 s confere, no horário desta máquina, quais rotinas batem com o
// minuto atual e manda a mensagem ao funcionário (o mesmo caminho do chat do painel). Só roda com o
// MyCo ligado; horário perdido com ele desligado não é recuperado depois.
// A última execução de cada rotina fica em ~/.myco/routines.json: um reinício no meio do minuto não
// dispara de novo, e o painel mostra quando rodou e como foi.

export const routineKey = (projectId: string, staffId: string, routineId: string) => `${projectId}:${staffId}:${routineId}`;

/** Resultado de uma tentativa: começou, ou foi pulada (com o porquê). */
export interface RoutineOutcome {
  ok: boolean;
  text: string;
}

/** Algo que deu errado numa rotina, para a caixa "precisa de mim". */
export interface RoutineAlert {
  id: string;
  projectId: string;
  staffId: string;
  staffName: string;
  routineName: string;
  text: string;
  at: string;
}

export interface RoutineSchedulerOptions {
  file: string;
  /** Fichas de todos os projetos (as arquivadas ficam de fora). */
  listStaff: () => Promise<StaffProfile[]>;
  /** Manda a mensagem da rotina; devolve se começou ou por que foi pulada. */
  run: (profile: StaffProfile, routine: Routine) => Promise<RoutineOutcome>;
  log?: (line: string) => void;
}

const MAX_ALERTS = 30;

export class RoutineScheduler {
  private runs: Record<string, RoutineRun & { minute?: string }> | null = null;
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

  /** Confere o minuto atual; cada rotina dispara no máximo uma vez por minuto que bate. */
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const minute = minuteKey(now);
      const runs = await this.load();
      for (const profile of await this.opts.listStaff()) {
        for (const r of profile.routines ?? []) {
          if (!r.enabled) continue;
          let matches = false;
          try {
            matches = cronMatches(parseCron(r.schedule), now);
          } catch {
            continue; // horário inválido (ficha editada à mão): ignora
          }
          const key = routineKey(profile.projectId, profile.id, r.id);
          if (!matches || runs[key]?.minute === minute) continue;
          runs[key] = { ...(runs[key] ?? { at: now.toISOString(), ok: true, text: '' }), minute };
          await this.save();
          await this.execute(profile, r, now, minute);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** "Rodar agora", pelo painel. */
  async runNow(profile: StaffProfile, routineId: string): Promise<RoutineOutcome | null> {
    const r = profile.routines?.find((x) => x.id === routineId);
    if (!r) return null;
    await this.load();
    return this.execute(profile, r, new Date(), undefined);
  }

  async state(): Promise<Record<string, RoutineRun>> {
    const runs = await this.load();
    return Object.fromEntries(Object.entries(runs).map(([k, { at, ok, text }]) => [k, { at, ok, text }]));
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

  private async execute(profile: StaffProfile, r: Routine, now: Date, minute: string | undefined): Promise<RoutineOutcome> {
    let outcome: RoutineOutcome;
    try {
      outcome = await this.opts.run(profile, r);
    } catch (err) {
      outcome = { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
    const runs = await this.load();
    runs[routineKey(profile.projectId, profile.id, r.id)] = { at: now.toISOString(), ok: outcome.ok, text: outcome.text, ...(minute && { minute }) };
    await this.save();
    this.log(`rotina "${r.name}" de ${profile.name}: ${outcome.ok ? 'começou' : 'não rodou'} (${outcome.text})`);
    if (!outcome.ok) {
      this.alertList.push({
        id: `${routineKey(profile.projectId, profile.id, r.id)}:${now.getTime()}`,
        projectId: profile.projectId,
        staffId: profile.id,
        staffName: profile.name,
        routineName: r.name,
        text: outcome.text,
        at: now.toISOString(),
      });
      if (this.alertList.length > MAX_ALERTS) this.alertList.splice(0, this.alertList.length - MAX_ALERTS);
    }
    return outcome;
  }

  private async load() {
    if (this.runs) return this.runs;
    const raw = await fs.readFile(this.opts.file, 'utf8').catch(() => null);
    try {
      // Editado à mão no Windows, o arquivo pode vir com BOM.
      const data = raw ? (JSON.parse(raw.replace(/^﻿/, '')) as unknown) : {};
      this.runs = data && typeof data === 'object' && !Array.isArray(data) ? (data as typeof this.runs & object) : {};
    } catch {
      this.runs = {};
    }
    return this.runs!;
  }

  private async save() {
    if (this.runs) await writeAtomic(this.opts.file, JSON.stringify(this.runs, null, 2) + '\n').catch(() => {});
  }

  private log(line: string) {
    (this.opts.log ?? ((l: string) => console.log(`[rotina] ${l}`)))(line);
  }
}

/** "2026-10-26T08:00" no horário local: identifica o minuto que disparou. */
function minuteKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
