// Formatação compartilhada pelo quadro, painel e topo.
import { locale, t } from './i18n';

/** Nome da empresa no topo e na aba: o padrão do servidor (`server/config.ts`) sai no idioma da interface;
 *  um nome dado pelo usuário fica como está. */
export function companyName(name: string | undefined): string {
  return !name || name === 'Claudio’s Club' ? t('app.name') : name;
}

/** Parte de `value` em `total`: "42%", "3,5%", "< 0,1%". */
export function formatShare(value: number, total: number): string {
  if (!total || value <= 0) return '0%';
  const pct = (value / total) * 100;
  if (pct < 0.1) return t('app.belowShare');
  return `${pct.toLocaleString(locale(), { maximumFractionDigits: pct < 10 ? 1 : 0 })}%`;
}

/** 2d4h, 3h05, 12min. */
export function formatDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  return `${m}min`;
}

/** "há 12min", "há 3h05"; de 24h em diante, só os dias ("há 2d", não "há 2d19h"). */
export function formatAgo(ms: number): string {
  if (ms < 60_000) return t('app.now');
  const days = Math.floor(Math.round(ms / 60_000) / 1440); // mesmo arredondamento do formatDuration
  return t('app.ago', { dur: days > 0 ? `${days}d` : formatDuration(ms) });
}

/** Nível de esforço como aparece na tela, sem a palavra "esforço": "high" → "High", "xhigh" → "XHigh". */
export function effortLabel(effort: string): string {
  if (effort === 'xhigh') return 'XHigh';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export const STATUS_LABEL: Record<string, string> = {
  busy: t('app.statusBusy'),
  idle: t('app.statusIdle'),
  waiting: t('app.statusWaiting'),
};

export const ENTRYPOINT_LABEL: Record<string, string> = { 'claude-desktop': 'app', cli: 'cli', 'sdk-cli': 'headless' };

export function initials(name: string): string {
  const parts = name.split(/[-_\s]+/).filter((p) => /[\p{L}\p{N}]/u.test(p));
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/** Última pasta de um caminho ("C:\\www\\MyCo" → "MyCo"): o nome de verdade, sem apelido. */
export function folderName(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
}

/** Nome do funcionário: o título da sessão, ou o começo do id. */
export function employeeName(session: { id: string; title: string | null }): string {
  return session.title?.trim() || `sessão ${session.id.slice(0, 8)}`;
}
