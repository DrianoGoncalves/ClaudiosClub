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
  /** O fechamento cortou no meio esta ação com efeito fora do projeto (ver cutAction.ts): não retoma sozinha, vai para você. */
  cut?: string;
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
  cut: z.string().min(1).max(200).optional(),
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
  /** Conversa cortada numa ação com efeito fora do projeto (`cut`): não envia; segura para você (ChatManager.holdCut). */
  hold?: (entry: ResumeEntry & { cut: string }) => void;
  /**
   * Conversa de tarefa que estava no motor secundário, com o principal já liberado: devolve a tarefa a ele numa conversa nova, que leva o aviso do reinício
   * (TaskService.resumeOnPrimary). True = devolvida: a antiga não é retomada. Erro ou false: retoma como sempre.
   */
  redirect?: (entry: ResumeEntry) => Promise<boolean>;
  /**
   * O projeto da conversa está pausado (ver server/projectPause.ts)? Então ela não é retomada (o pedido do reinício é de uma tentativa só e já foi lido: a conversa de tarefa
   * volta pela retomada das órfãs quando o projeto for retomado; as outras, quando você mandar mensagem). Erro ao perguntar: não retoma.
   */
  paused?: (projectId: string) => Promise<boolean>;
  /**
   * Esta instância manda no projeto da conversa (ver server/projectOwner.ts)? Quem não manda nele não a retoma, nem a segura nem a devolve ao principal: o reinício é de quem
   * tem a conversa, e retomar uma conversa que está viva em outro servidor a duplicaria. Sem a opção, vale.
   */
  owns?: (projectId: string) => Promise<boolean>;
  /**
   * Antes de abrir qualquer conversa: encerra o que sobrou do servidor anterior (os escopos de conversa do systemd que ficaram vivos, sem dono). Sem isto, a
   * conversa sem dono seguiria o turno por conta própria e a retomada abriria outro `claude` na mesma sessão: dois processos no mesmo jsonl. Erro não impede a retomada.
   */
  beforeResume?: () => Promise<unknown>;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Boot, com o servidor ouvindo e os motores prontos: retoma cada conversa que estava em turno. Antes, o corte (ação com efeito
 * fora do projeto pela metade: segura para você), o projeto pausado e o limite (barrado: não envia). Uma tentativa por conversa; se o envio falhar,
 * segue sem repetir.
 */
export async function resumeAfterRestart(d: ResumeDeps): Promise<void> {
  const log = d.log ?? ((line: string) => console.log(`[retomar] ${line}`));
  const entries = await takeResume(d.file, d.now?.() ?? Date.now(), log);
  for (const e of entries) {
    if (d.owns && !(await d.owns(e.projectId).catch(() => false))) {
      log(`${e.sessionId}: não retomada: este servidor não manda no projeto (é de outra instância)`);
      continue;
    }
    // Ninguém sabe se a ação cortada chegou a acontecer: retomar sozinho poderia repeti-la (push, deploy, comando no servidor).
    if (e.cut) {
      try {
        d.hold?.({ ...e, cut: e.cut });
      } catch (err) {
        log(`${e.sessionId}: não consegui avisar o corte: ${errorText(err)}`);
      }
      log(`${e.sessionId}: não retomada: o reinício cortou "${e.cut}" no meio (vai para você)`);
      continue;
    }
    // Projeto pausado: nada começa sozinho, nem a devolução ao motor principal (conversa nova) nem a retomada da antiga.
    if (await d.paused?.(e.projectId).catch(() => true)) {
      log(`${e.sessionId}: não retomada: o projeto está pausado`);
      continue;
    }
    // Antes do limite: o que barra é o do motor da conversa antiga, e a devolvida abre no principal (que já foi conferido como livre).
    try {
      if (await d.redirect?.(e)) {
        log(`${e.sessionId}: o motor principal da ficha já está liberado: a tarefa voltou a ele, em conversa nova`);
        continue;
      }
    } catch (err) {
      log(`${e.sessionId}: não consegui devolver ao motor principal (${errorText(err)}); retoma como estava`);
    }
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
    await Promise.resolve(d.beforeResume?.()).catch((err: unknown) => (d.log ?? ((line: string) => console.log(`[retomar] ${line}`)))(`não consegui encerrar o que sobrou do servidor anterior: ${errorText(err)}`));
    await resumeAfterRestart(d);
  } finally {
    startTimers();
  }
}
