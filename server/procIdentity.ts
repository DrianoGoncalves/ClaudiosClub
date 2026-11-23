import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// O Claudio’s Club guarda o pid das conversas que abriu (~/.myco/run/chats.json) e o Claude guarda o dele em ~/.claude/sessions.
// Depois de reiniciar o PC esses números não são mais de ninguém: o sistema reaproveita o pid para outro processo, e "pid vivo"
// já não quer dizer "a conversa". Aqui ficam as duas conferências que a vivacidade por pid não faz.

/** Folga na comparação com a hora do boot (relógio acertado pela rede logo depois de ligar; o processo nunca nasce antes do boot). */
const BOOT_SLACK_MS = 5_000;
/** Quanto a hora de criação do processo pode diferir da gravada: o registro nasce na hora do spawn, o arquivo do Claude até ~1 min depois (medido: 2 s a 47 s). */
const START_SLACK_MS = 120_000;
/** Imagens que uma conversa do Claude ou do Codex pode ter (`claude.exe`, `node.exe` com o cli.js, `codex.exe`). */
const CHAT_IMAGE = /^(claude|node|codex)(\.exe)?$/i;

const toMs = (v: number | string | null | undefined): number | null => {
  const ms = typeof v === 'string' ? Date.parse(v) : v;
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
};

/** Quando o sistema ligou (epoch ms): agora menos o tempo ligado. */
export function bootTime(now = Date.now(), uptimeSec = os.uptime()): number {
  return now - uptimeSec * 1000;
}

/**
 * O processo começou antes de o sistema ligar: é de antes de um reinício do PC, está morto, e o pid que o registro guarda é de outro
 * processo agora. Hora ausente ou ilegível = não dá para dizer (false).
 */
export function startedBeforeBoot(startedAt: number | string | null | undefined, boot = bootTime()): boolean {
  const ms = toMs(startedAt);
  return ms !== null && ms < boot - BOOT_SLACK_MS;
}

export interface ProcInfo {
  /** Nome da imagem (`claude.exe`, `node`…). */
  name: string;
  /** Hora de criação (epoch ms); null quando o sistema não mostra (processo de outro usuário). */
  startedAt: number | null;
}

/** Olha um pid no sistema: null = o pid não existe; rejeitar = não deu para olhar. Os testes trocam. */
export type ProcLister = (pid: number) => Promise<ProcInfo | null>;

export type ProcIdentity = 'same' | 'other' | 'gone' | 'unknown';

/**
 * O pid ainda é o processo da conversa? `same` = nome de imagem de conversa (claude/node/codex) e, se as duas horas existem, criado
 * perto da gravada; `other` = o pid é de outro processo (reaproveitado); `gone` = não existe mais; `unknown` = não deu para olhar
 * (quem chama não encerra nada nesse caso).
 */
export async function confirmProcess(pid: number, startedAt: number | string | null | undefined, lister: ProcLister = inspectProcess): Promise<ProcIdentity> {
  let info: ProcInfo | null;
  try {
    info = await lister(pid);
  } catch {
    return 'unknown';
  }
  if (!info) return 'gone';
  if (!CHAT_IMAGE.test(path.basename(info.name.replace(/\\/g, '/')))) return 'other';
  const want = toMs(startedAt);
  if (want !== null && info.startedAt !== null && Math.abs(info.startedAt - want) > START_SLACK_MS) return 'other';
  return 'same';
}

/** Lê nome e hora de criação do pid: Get-Process no Windows (~0,7 s, só antes de encerrar algo), `ps` nos outros. */
export function inspectProcess(pid: number): Promise<ProcInfo | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  if (process.platform === 'win32') {
    const exe = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){$t='';try{$t=$p.StartTime.ToUniversalTime().ToString('o')}catch{}; $p.ProcessName+'|'+$t}`;
    return run(exe, ['-NoProfile', '-NonInteractive', '-Command', script]).then((out) => {
      const [name, start] = out.trim().split('|');
      return name ? { name, startedAt: toMs(start || null) } : null;
    });
  }
  // `etime` ([[dd-]hh:]mm:ss desde a criação) existe no Linux e no macOS; `lstart` depende do idioma.
  return run('ps', ['-o', 'etime=', '-o', 'comm=', '-p', String(pid)]).then((out) => {
    const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.+?)\s*$/.exec(out);
    if (!m) return null;
    const secs = Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4]);
    return { name: m[5]!, startedAt: Date.now() - secs * 1000 };
  });
}

/** Saída do comando; exit 1 (o `ps` de pid que não existe) vira texto vazio. Falha de verdade (sem o programa, tempo esgotado) rejeita. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { windowsHide: true, timeout: 8_000 }, (err, stdout) => {
      if (err && (err as { code?: unknown }).code !== 1) return reject(err);
      resolve(String(stdout ?? ''));
    }),
  );
}
