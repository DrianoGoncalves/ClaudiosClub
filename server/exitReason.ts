import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

// "A saída anterior foi limpa?" O vigia (scripts/daemon.ts) grava `run/daemon.session.json` ao subir e o renova a cada 30 s; só uma parada de verdade
// (botão Parar, `daily stop`, sinal de término) o marca como limpo. Se na subida seguinte ele ainda diz "no ar" e o processo morreu, alguém matou o
// Claudio’s Club por baixo: em 27/11/2026 o systemd-oomd matou o escopo inteiro por falta de memória e o log ficou mudo das 08:56 às 09:39.
// Aqui ficam o marcador, o diagnóstico (a causa provável) e o relatório que o log e a página de início mostram. Nada daqui roda no caminho quente do servidor.

export interface SessionMarker {
  pid: number;
  /** ISO: quando este vigia subiu. */
  startedAt: string;
  /** ISO: o último sinal de vida (renovado a cada 30 s). */
  lastBeat: string;
  /** O escopo do systemd em que o vigia rodava (`app-claudios-<hora>.scope`), para achar o registro do kill no journal; null fora do Linux ou sem escopo. */
  unit: string | null;
  /** Parou de propósito (Parar, `daily stop`, sinal de término). */
  clean: boolean;
  /** Memória livre (% do total) e pressão de memória (`some avg10` do PSI, %, só no Linux) no último sinal. */
  freePct: number | null;
  pressure: number | null;
}

export type ExitCause = 'oom' | 'memory-low' | 'reboot' | 'unknown';

export interface ExitReport {
  cause: ExitCause;
  /** ISO: quando morreu (a hora do registro do sistema) ou, sem ela, o último sinal de vida. */
  at: string;
  lastBeat: string;
  unit: string | null;
  /** Frase para o log e para a página de início. */
  message: string;
  /** Vai para a página de início? Reinício do computador só vai para o log: todo login depois de desligar a máquina seria aviso. */
  banner: boolean;
  /** ISO: quando o vigia seguinte percebeu. */
  detectedAt: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown) => (isNum(v) ? v : null);
const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** Lê o marcador; ausente, ilegível ou fora do formato = null (primeira vez, ou queda de energia no meio da gravação: não há o que dizer). */
export function readSession(file: string): SessionMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!isNum(raw.pid) || !isIso(raw.startedAt) || !isIso(raw.lastBeat) || typeof raw.clean !== 'boolean') return null;
    return {
      pid: raw.pid,
      startedAt: raw.startedAt,
      lastBeat: raw.lastBeat,
      unit: typeof raw.unit === 'string' ? raw.unit : null,
      clean: raw.clean,
      freePct: numOrNull(raw.freePct),
      pressure: numOrNull(raw.pressure),
    };
  } catch {
    return null;
  }
}

/** Grava o marcador por arquivo temporário + rename (nunca meio escrito), sem fsync: é um sinal de vida, não o quadro; perder a última gravação numa queda de energia só atrasa o "último sinal". */
export function writeSession(file: string, marker: SessionMarker): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marker));
  fs.renameSync(tmp, file);
}

/** Marca o marcador como parada limpa (se ele existe e ainda não estava). Nunca lança. */
export function markSessionClean(file: string, now = new Date()): void {
  try {
    const m = readSession(file);
    if (m && !m.clean) writeSession(file, { ...m, clean: true, lastBeat: now.toISOString() });
  } catch {
    // o marcador é um aviso: não impede parar
  }
}

/**
 * Parada de propósito (`daily stop`): o marcador diz "limpo" e o aviso de uma saída anterior some. Quem parou foi o usuário, então a página de início não pode
 * mostrar "Por que parou" (nem o `scripts/log.js` gravado logo depois). Nunca lança.
 */
export function markCleanStop(sessionFile: string, lastExitFile: string, now = new Date()): void {
  markSessionClean(sessionFile, now);
  try {
    saveLastExit(lastExitFile, null);
  } catch {
    // o aviso é só informação: não impede parar
  }
}

/** `some avg10` do PSI de memória (%, só no Linux). */
export function readMemoryPressure(file = '/proc/pressure/memory'): number | null {
  try {
    const m = /^some .*?avg10=([\d.]+)/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** A amostra de memória do sinal de vida. */
export function memorySample(): Pick<SessionMarker, 'freePct' | 'pressure'> {
  const total = os.totalmem();
  return { freePct: total > 0 ? Math.round((os.freemem() / total) * 1000) / 10 : null, pressure: readMemoryPressure() };
}

/** Indício de memória curta no último sinal: livre abaixo de 8% do total ou pressão (PSI avg10) de 30% ou mais. */
export const LOW_FREE_PCT = 8;
export const HIGH_PRESSURE = 30;

export interface OomEvidence {
  /** epoch ms do registro. */
  at: number;
  by: 'oomd' | 'kernel';
}

/** `MESSAGE_ID` do systemd: "systemd-oomd killed one or more processes in unit" e "A process of unit has been killed by the OOM killer". */
const OOMD_KILL = 'd989611b15e44c9dbf31e3c81256e4ed';
const KERNEL_OOM_KILL = 'fe6faa94e7774663a0da52717891d8ef';

export type JournalRunner = (args: string[], timeoutMs: number) => Promise<string>;

const journalctl: JournalRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('journalctl', args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 256 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/**
 * O journal do usuário tem o registro do kill daquele escopo? O gerenciador de usuário escreve "<unidade>: systemd-oomd killed N process(es) in this
 * unit" (e o do kernel) com a unidade em `USER_UNIT`; o `journalctl --user` lê sem ser do grupo systemd-journal. Qualquer falha (sem journalctl,
 * journal sem acesso, demora) = sem evidência, e o diagnóstico segue por outros indícios.
 */
export async function journalOomEvidence(unit: string, sinceMs: number, run: JournalRunner = journalctl): Promise<OomEvidence | null> {
  if (process.platform !== 'linux' || !/^[\w.@:\\-]+\.scope$/.test(unit)) return null;
  const out = await run(
    ['--user', '--no-pager', '-o', 'json', '-n', '1', `--since=@${Math.max(0, Math.floor(sinceMs / 1000) - 60)}`, `USER_UNIT=${unit}`, `MESSAGE_ID=${OOMD_KILL}`, `MESSAGE_ID=${KERNEL_OOM_KILL}`],
    5_000,
  ).catch(() => '');
  const line = out.split('\n').find((l) => l.trim());
  if (!line) return null;
  try {
    const e = JSON.parse(line) as { __REALTIME_TIMESTAMP?: string; MESSAGE_ID?: string };
    const at = Number(e.__REALTIME_TIMESTAMP) / 1000;
    return Number.isFinite(at) ? { at, by: e.MESSAGE_ID === KERNEL_OOM_KILL ? 'kernel' : 'oomd' } : null;
  } catch {
    return null;
  }
}

export interface DiagnoseContext {
  /** Epoch ms de agora. */
  now: number;
  /** Segundos desde que o computador ligou (`os.uptime()`). */
  uptimeSec: number;
  /** O PID deste vigia: o marcador dele mesmo não conta. */
  selfPid: number;
  /** Procura o registro do sistema que matou aquele escopo. */
  oomEvidence: (unit: string, sinceMs: number) => Promise<OomEvidence | null>;
  /** Hora local "HH:MM" de um instante (os testes fixam). */
  clock?: (ms: number) => string;
}

const localClock = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * O que houve com o vigia anterior, dado o marcador que ele deixou. Null = não há o que dizer (primeira subida, parada limpa, ou o marcador é deste
 * mesmo processo). Ordem: o computador reiniciou desde o último sinal → `reboot` (só log); o journal tem o kill daquele escopo → `oom` com a hora;
 * a memória estava curta no último sinal → `memory-low` (provável); senão `unknown`. O motivo é um indício, não uma prova: as frases dizem "provável"
 * quando não há registro do sistema.
 */
export async function diagnoseExit(prev: SessionMarker | null, ctx: DiagnoseContext): Promise<ExitReport | null> {
  if (!prev || prev.clean || prev.pid === ctx.selfPid) return null;
  const clock = ctx.clock ?? localClock;
  const beat = Date.parse(prev.lastBeat);
  const base = { lastBeat: prev.lastBeat, unit: prev.unit, detectedAt: new Date(ctx.now).toISOString() };

  const bootMs = ctx.now - ctx.uptimeSec * 1000;
  if (beat < bootMs - 5_000) {
    return { ...base, cause: 'reboot', at: prev.lastBeat, banner: false, message: `o computador foi reiniciado ou desligado desde o último sinal do Claudio’s Club (${clock(beat)}); subindo de novo` };
  }

  const evidence = prev.unit ? await ctx.oomEvidence(prev.unit, Date.parse(prev.startedAt)).catch(() => null) : null;
  if (evidence) {
    const who = evidence.by === 'oomd' ? 'systemd-oomd' : 'o kernel';
    return {
      ...base,
      cause: 'oom',
      at: new Date(evidence.at).toISOString(),
      banner: true,
      message: `a saída anterior não foi limpa: encerrado pelo sistema por falta de memória (${who}) às ${clock(evidence.at)}`,
    };
  }

  const low = (prev.freePct !== null && prev.freePct < LOW_FREE_PCT) || (prev.pressure !== null && prev.pressure >= HIGH_PRESSURE);
  if (low) {
    const sample = [prev.freePct !== null ? `${prev.freePct}% da RAM livre` : null, prev.pressure !== null ? `pressão de memória ${prev.pressure}%` : null].filter(Boolean).join(', ');
    return {
      ...base,
      cause: 'memory-low',
      at: prev.lastBeat,
      banner: true,
      message: `a saída anterior não foi limpa: provavelmente falta de memória (no último sinal, às ${clock(beat)}: ${sample})`,
    };
  }

  return {
    ...base,
    cause: 'unknown',
    at: prev.lastBeat,
    banner: true,
    message: `a saída anterior não foi limpa: o vigia parou sem aviso (último sinal às ${clock(beat)}); motivo não identificado`,
  };
}

/** Relatório com mais de 24 h não vai mais para a página. */
export const EXIT_REPORT_TTL_MS = 24 * 60 * 60_000;

/** O relatório que a página de início mostra: o gravado, se pedir aviso e for recente. */
export function readLastExit(file: string, now = Date.now()): ExitReport | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ExitReport>;
    if (!r || typeof r.message !== 'string' || !isIso(r.detectedAt) || r.banner !== true) return null;
    if (now - Date.parse(r.detectedAt) > EXIT_REPORT_TTL_MS) return null;
    return {
      cause: r.cause ?? 'unknown',
      at: isIso(r.at) ? r.at : r.detectedAt,
      lastBeat: isIso(r.lastBeat) ? r.lastBeat : r.detectedAt,
      unit: typeof r.unit === 'string' ? r.unit : null,
      message: r.message,
      banner: true,
      detectedAt: r.detectedAt,
    };
  } catch {
    return null;
  }
}

/** Guarda o relatório (ou apaga o anterior, quando a saída passada foi limpa): a página só mostra o da subida em curso. */
export function saveLastExit(file: string, report: ExitReport | null): void {
  if (!report) {
    fs.rmSync(file, { force: true });
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report));
  fs.renameSync(tmp, file);
}
