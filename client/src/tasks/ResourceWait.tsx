import type { Task } from '../../../shared/model';
import { formatAgo } from '../format';
import { t } from '../i18n';

// Tarefa na fila segurada pelo gate de recursos (RAM, CPU ou teto de conversas): motivo e há quanto tempo espera.
// O `reason` vem do servidor em pt-BR e não é traduzido; o resto da frase segue o idioma.

/** "Aguardando recursos: RAM disponível 1,2 GB (reserva 1,5 GB) · há 4 min"; sem `since` válido, sem o tempo. */
export function resourceWaitText(wait: NonNullable<Task['resourceWait']>, now: number): string {
  const since = Date.parse(wait.since);
  const ago = Number.isFinite(since) ? ` · ${formatAgo(Math.max(0, now - since))}` : '';
  return t('tasks.resourceWait', { reason: wait.reason, ago });
}

/** Selo discreto do cartão (mesma família do "na fila"): quebra linha em vez de cortar, o motivo é o que importa. */
export function ResourceWaitBadge({ wait, now }: { wait?: Task['resourceWait']; now: number }) {
  if (!wait) return null;
  return (
    <span className="task-queue task-resource small" title={t('tasks.resourceWaitHint')}>
      {resourceWaitText(wait, now)}
    </span>
  );
}
