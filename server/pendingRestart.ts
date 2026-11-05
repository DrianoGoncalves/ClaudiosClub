import fs from 'node:fs';
import path from 'node:path';
import { bundleInputs, bundleStale } from '../scripts/bundle';
import { clientChanged, filesUnder } from '../scripts/lib';
import type { PendingReason, PendingRestart } from '../shared/model';
import { ROOT } from './root';

// "Mudanças pendentes": o código no disco está à frente do que está no ar? Código novo só entra pelo botão
// Reiniciar (o vigia não reinicia sozinho por mudança), então a tela avisa. Barato: ~100 stat por conferência, no
// máximo uma a cada 30 s (cache), e só quando alguém pergunta (GET /api/server).

export interface PendingOptions {
  root?: string;
  /** O arquivo que este processo carregou (import.meta.filename do index): o pacote .mjs ou o .ts pelo tsx. */
  entry: string;
  /** Quando o servidor subiu (ms). */
  startedAt: number;
}

const mtime = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;

/**
 * Marco do código no ar: o mtime do pacote carregado (o que mudou depois dele não entrou) ou, pelo tsx, a hora da
 * subida. Lido uma vez, na subida: um `npm run build` depois disso troca o pacote no disco, não o que está no ar.
 */
export function loadedMark(entry: string, startedAt: number): number {
  return entry.endsWith('.mjs') ? (mtime(entry) ?? startedAt) : startedAt;
}

/** Algum arquivo do servidor (ou o próprio pacote, refeito por um build) é mais novo que o código no ar? */
function serverAhead(root: string, mark: number): boolean {
  const bundle = path.join(root, 'dist', 'server.mjs');
  const inputs =
    bundleInputs(bundle) ??
    // Sem a lista do pacote (nunca empacotado): o código que o servidor importa.
    ['server', 'shared', 'scripts'].flatMap((d) => {
      const dir = path.join(root, d);
      return fs.existsSync(dir) ? filesUnder(dir).map((f) => path.relative(root, f)) : [];
    });
  // Arquivo apagado conta como mudança (como em bundleStale).
  const ahead = (f: string) => (mtime(path.join(root, f)) ?? Infinity) > mark;
  return [...inputs, 'package-lock.json'].some(ahead) || (mtime(bundle) ?? 0) > mark;
}

export function pendingChanges(opts: { root: string; mark: number }): PendingRestart {
  const { root, mark } = opts;
  const reasons: PendingReason[] = [];
  const safe = (fn: () => boolean) => {
    try {
      return fn();
    } catch {
      return false;
    }
  };
  if (safe(() => serverAhead(root, mark))) reasons.push('server');
  if (safe(() => clientChanged(root))) reasons.push('client');
  // O MCP de FTP que as sessões sobem: o reinício refaz o pacote. Sem pacote, elas usam o .ts (nada pendente).
  const ftp = path.join(root, 'dist', 'ftp-mcp.mjs');
  if (safe(() => fs.existsSync(ftp) && bundleStale(ftp, root))) reasons.push('ftpMcp');
  return { pendingRestart: reasons.length > 0, pendingReasons: reasons };
}

/** Conferência com cache de `ttlMs`: a tela pode perguntar a cada poucos segundos sem custo. */
export function pendingRestartCheck(opts: PendingOptions, ttlMs = 30_000, now = Date.now): () => PendingRestart {
  const root = opts.root ?? ROOT;
  const mark = loadedMark(opts.entry, opts.startedAt);
  let cached: { at: number; value: PendingRestart } | null = null;
  return () => {
    if (!cached || now() - cached.at >= ttlMs) cached = { at: now(), value: pendingChanges({ root, mark }) };
    return cached.value;
  };
}
