import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeAtomic } from '../staff/store';
import { RESTART_PENDING_TEXT, RESTART_TEXT } from './items';

// Reinício pelo navegador: as conversas que estavam no meio de um turno voltam sozinhas quando o servidor sobe.
// O pedido (run/resume.json) é gravado logo antes de sair e apagado pelo boot ou por Parar. Não é o agendador do
// limite de uso: nada de fila nem de repetição, uma tentativa por conversa.

/** Conversa que estava no meio de um turno quando o servidor saiu para reiniciar. */
export interface ResumeEntry {
  projectId: string;
  sessionId: string;
  staffId: string | null;
  engine: 'claude' | 'codex';
  cwd: string;
  /** Havia pedido de permissão ou pergunta sem resposta: o aviso manda refazer o pedido. */
  hadPending: boolean;
}

/** Pedido com mais que isso não é retomado (o servidor demorou demais, ou o arquivo é de outra vez). */
export const RESUME_MAX_AGE_MS = 30 * 60_000;

/** O que o Claudio’s Club manda na conversa retomada (os textos ficam em items.ts, junto dos avisos injetados). */
export function resumeText(hadPending: boolean): string {
  return hadPending ? RESTART_PENDING_TEXT : RESTART_TEXT;
}

const Entry = z.object({
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  staffId: z.string().nullable(),
  engine: z.enum(['claude', 'codex']),
  cwd: z.string(),
  hadPending: z.boolean(),
});
const Body = z.object({ savedAt: z.string(), sessions: z.array(z.unknown()) });

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Lê e apaga o pedido do reinício. Devolve as conversas válidas. Arquivo estragado, sem o formato ou velho não retoma
 * nada (o motivo vai para o log). Lido ou não, o arquivo sai aqui: só existe uma tentativa.
 */
export async function takeResume(file: string, now: number, log: (line: string) => void): Promise<ResumeEntry[]> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return [];
  await fs.rm(file, { force: true }).catch(() => {});
  let body: unknown;
  try {
    body = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    log('resume.json estragado, ignorado');
    return [];
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    log('resume.json sem o formato esperado, ignorado');
    return [];
  }
  const age = now - Date.parse(parsed.data.savedAt);
  // NaN (data inválida) não passa; nem data do futuro.
  if (!(age >= 0 && age <= RESUME_MAX_AGE_MS)) {
    log(`resume.json de ${parsed.data.savedAt} fora da janela de 30 min, ignorado`);
    return [];
  }
  const out: ResumeEntry[] = [];
  for (const [i, item] of parsed.data.sessions.entries()) {
    const e = Entry.safeParse(item);
    if (e.success) out.push(e.data);
    else log(`entrada ${i + 1} inválida, ignorada`);
  }
  return out;
}

/**
 * O pedido do reinício no disco. Parar apaga e cancela qualquer gravação em curso: parar nunca agenda retomada.
 */
export class ResumeFile {
  private stopAsked = false;

  constructor(readonly file: string) {}

  async stop(): Promise<void> {
    this.stopAsked = true;
    await fs.rm(this.file, { force: true });
  }

  /** Grava as conversas em turno (lista vazia também: o boot só apaga). Devolve false se Parar chegou antes ou durante. */
  async save(sessions: ResumeEntry[], now: number): Promise<boolean> {
    if (this.stopAsked) return false;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeAtomic(this.file, JSON.stringify({ savedAt: new Date(now).toISOString(), sessions }, null, 2) + '\n');
    if (this.stopAsked) {
      await fs.rm(this.file, { force: true });
      return false;
    }
    return true;
  }
}

export interface ResumeDeps {
  file: string;
  /** O limite de uso da conversa barra agora? Mesmo critério do "continue" (ver usageStopHit). Devolve onde volta, ou null. */
  stopHit: (projectId: string, staffId: string | null, engine: 'claude' | 'codex') => Promise<{ resetsAt: string | null } | null>;
  /** Reabre a conversa e manda o aviso (ChatManager.resumeChat). */
  send: (entry: ResumeEntry) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Boot, com o servidor ouvindo e os motores prontos: retoma cada conversa que estava em turno. Confere o limite antes
 * (barrado: não envia). Uma tentativa por conversa; se o envio falhar, segue sem repetir.
 */
export async function resumeAfterRestart(d: ResumeDeps): Promise<void> {
  const log = d.log ?? ((line: string) => console.log(`[retomar] ${line}`));
  const entries = await takeResume(d.file, d.now?.() ?? Date.now(), log);
  for (const e of entries) {
    let stop: { resetsAt: string | null } | null;
    try {
      stop = await d.stopHit(e.projectId, e.staffId, e.engine);
    } catch (err) {
      log(`${e.sessionId}: não retomada: não consegui conferir o limite de uso (${errorText(err)})`);
      continue;
    }
    if (stop) {
      log(`${e.sessionId}: não retomada: limite de uso${stop.resetsAt ? ` (volta às ${stop.resetsAt})` : ''}`);
      continue;
    }
    try {
      await d.send(e);
      log(`${e.sessionId}: retomada (${e.engine}${e.hadPending ? ', com pedido pendente' : ''})`);
    } catch (err) {
      log(`${e.sessionId}: não retomada: ${errorText(err)}`);
    }
  }
}

/**
 * Boot: retoma as conversas em turno e só então chama `startTimers` (o "continue", o despertador e a fila, que mandam
 * mensagem). Assim nenhum deles manda de novo numa conversa que a retomada ainda está abrindo.
 */
export async function bootResume(d: ResumeDeps, startTimers: () => void): Promise<void> {
  try {
    await resumeAfterRestart(d);
  } finally {
    startTimers();
  }
}
