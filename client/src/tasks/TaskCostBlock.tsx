import type { TaskCost, TaskCostNode, TaskSession } from '../../../shared/model';
import { api } from '../api';
import { locale, t } from '../i18n';
import { bucketMeta, costText, coverageNote, reviewsText, reworkText } from '../taskCost';
import { useScanPoll } from '../useScanPoll';

// Custo da tarefa no detalhe: o total e a divisão em fazer, revisar e dúvida, com as voltas de retrabalho e a lista das
// conversas. Os números vêm de GET /api/projects/:id/tasks/:taskId/cost; as regras de exibição (US$ só do Claude,
// "indisponível" em vez de zero, total parcial) estão em `taskCost.ts`.

const ROLES: Array<[TaskSession['role'], string]> = [
  ['work', t('taskCost.roleWork')],
  ['review', t('taskCost.roleReview')],
  ['question', t('taskCost.roleQuestion')],
];

const ENGINE: Record<TaskCostNode['engine'], string> = { claude: t('toolbar.claudeName'), codex: t('toolbar.codexName') };

const when = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

/** O bloco, puro: o custo já lido (ou `null` enquanto carrega) e o erro. `nameOf` dá o nome de quem fez cada conversa. */
export function TaskCostView({
  cost,
  error,
  nameOf,
  open,
}: {
  cost: TaskCost | null;
  error: string | null;
  nameOf: (staffId: string | null) => string;
  /** Já abre expandido (tarefa em revisão ou pronta). */
  open?: boolean;
}) {
  if (error) return <p className="error small">{error}</p>;
  const total = cost ? costText(cost) : null;
  const note = cost ? coverageNote(cost.coverage) : null;
  return (
    <details className="collapse task-cost" open={open}>
      <summary>
        {t('taskCost.heading')}
        {' · '}
        {total ? total.main : t('taskCost.loading')}
      </summary>
      {cost && total && (
        <>
          {cost.scanning && <p className="muted small">{t('taskCost.scanning')}</p>}
          {note && <p className="muted small task-cost-note">{note}</p>}
          <dl className="stats">
            <div className="is-wide" title={total.detail ?? undefined}>
              <dt>{t('taskCost.total')}</dt>
              <dd>
                {total.main}
                {total.sub && <span className="task-cost-sub muted small">{total.sub}</span>}
              </dd>
            </div>
            {ROLES.map(([role, label]) => {
              const bucket = cost.byRole[role];
              const c = costText(bucket);
              return (
                <div key={role} title={c.detail ?? undefined}>
                  <dt>{label}</dt>
                  <dd>
                    {bucket.sessions === 0 ? '—' : c.main}
                    <span className="task-cost-sub muted small">{bucketMeta(bucket)}</span>
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className="muted small">
            {reworkText(cost.reworkRounds)}
            {cost.reviewRounds > 0 && ` · ${reviewsText(cost.reviewRounds)}`}
          </p>
          {cost.nodes.length > 0 && (
            <details className="collapse">
              <summary>{t('taskCost.conversations', { n: cost.nodes.length })}</summary>
              <ul className="task-cost-nodes small">
                {cost.nodes.map((n) => {
                  const c = costText(n);
                  return (
                    <li key={n.sessionId} title={c.detail ?? undefined}>
                      <span className="task-cost-node-who">
                        <b>{ROLES.find(([r]) => r === n.role)?.[1] ?? n.role}</b>
                        {' · '}
                        {nameOf(n.staffId)}
                        {' · '}
                        {ENGINE[n.engine] ?? n.engine}
                        {' · '}
                        {when(n.at)}
                      </span>
                      <span className="task-cost-node-value">
                        {c.main}
                        {c.sub && <span className="muted"> · {c.sub}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </>
      )}
    </details>
  );
}

/** Lê o custo da tarefa; relê quando ela muda (`version`) e enquanto os transcripts ainda estão sendo lidos. */
export function TaskCostBlock({
  projectId,
  taskId,
  version,
  nameOf,
  open,
}: {
  projectId: string;
  taskId: string;
  version: string;
  nameOf: (staffId: string | null) => string;
  open?: boolean;
}) {
  const { data, error } = useScanPoll(() => api.taskCost(projectId, taskId), `${projectId}:${taskId}`, null, version);
  return <TaskCostView cost={data} error={error} nameOf={nameOf} open={open} />;
}
