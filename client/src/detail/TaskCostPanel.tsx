import { useState, type ReactNode } from 'react';
import type { ExecutorCostRow, ManagerCostRow, TaskCostBucket, TaskCostRankRow, TaskCostRanking } from '../../../shared/model';
import { api } from '../api';
import { formatPercent } from '../format';
import { locale, t } from '../i18n';
import { RANKING_PERIODS } from '../ranking';
import { barSizes, bucketMeta, costText, coverageNote, coverageTag, reworkText, tasksText, type StaffIndex } from '../taskCost';
import { useScanPoll } from '../useScanPoll';

// Aba "Tarefas" do ranking: onde o consumo vai, por tarefa concluída, por executor (média e retrabalho) e por gestor
// (o que pediu e as revisões e dúvidas dele). Os números vêm de GET /api/task-costs; as regras de exibição (US$ só do
// Claude, "indisponível" em vez de zero) estão em `taskCost.ts`.

type Person = { projectId: string; staffId: string };

/** Uma linha da lista: a posição, o nome, duas linhas de apoio, o valor e a barra. Sem `onClick`, não abre nada. */
function CostRow({
  pos,
  name,
  lines,
  value,
  valueTitle,
  bar,
  title,
  onClick,
}: {
  pos: number;
  name: string;
  lines: ReactNode[];
  value: ReactNode;
  valueTitle?: string | null;
  /** Tamanho da barra, de 0 a 1. */
  bar: number;
  title?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="ranking-pos">{pos}</span>
      <span className="ranking-text">
        <span className="ranking-name is-wrap" title={name}>
          {name}
        </span>
        {lines.map((line, i) => (
          <span key={i} className="muted small">
            {line}
          </span>
        ))}
      </span>
      <span className="ranking-value" title={valueTitle ?? undefined}>
        {value}
      </span>
      <span className="ranking-bar" style={{ width: `${bar * 100}%` }} />
    </>
  );
  return <li>{onClick ? <button className="ranking-row" title={title} onClick={onClick}>{body}</button> : <div className="ranking-row">{body}</div>}</li>;
}

/** "texto · texto", pulando o que não existe. */
const joined = (parts: Array<string | null | false | undefined>) => parts.filter(Boolean).join(' · ');

const day = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' });
};

function TaskRows({ rows, limit, staff, onOpenTask }: { rows: TaskCostRankRow[]; limit: number; staff: StaffIndex; onOpenTask: (projectId: string, taskId: string) => void }) {
  const shown = rows.slice(0, limit);
  const bars = barSizes(shown.map((r) => r.usd));
  return (
    <ol className="ranking">
      {shown.map((r, i) => {
        const cost = costText(r);
        const tag = coverageTag(r.coverage);
        return (
          <CostRow
            key={`${r.projectId}:${r.taskId}`}
            pos={i + 1}
            name={r.title}
            lines={[
              joined([staff.nameOf(r.staffId, r.projectId), staff.projectName(r.projectId), day(r.completedAt)]),
              <>
                {joined([cost.sub, r.reworkRounds > 0 && reworkText(r.reworkRounds)])}
                {tag && (
                  <span className="badge dim ranking-tag" title={coverageNote(r.coverage) ?? undefined}>
                    {tag}
                  </span>
                )}
              </>,
            ]}
            value={cost.main}
            valueTitle={cost.detail}
            bar={bars[i]!}
            title={t('taskCost.openTask')}
            onClick={() => onOpenTask(r.projectId, r.taskId)}
          />
        );
      })}
    </ol>
  );
}

function ExecutorRows({ rows, staff, onOpenPerson }: { rows: ExecutorCostRow[]; staff: StaffIndex; onOpenPerson: (p: Person) => void }) {
  const bars = barSizes(rows.map((r) => r.usdAvg));
  return (
    <ol className="ranking">
      {rows.map((r, i) => {
        const avg = costText({ usd: r.usdAvg, tokens: r.tokensAvg });
        const total = costText(r);
        const person = staff.personOf(r.staffId);
        return (
          <CostRow
            key={r.staffId}
            pos={i + 1}
            name={staff.nameOf(r.staffId)}
            lines={[
              joined([tasksText(r.tasks), t('taskCost.reworkShare', { pct: formatPercent(r.reworkShare), n: r.reworkTasks, total: r.tasks })]),
              joined([avg.sub, `${t('taskCost.totalWord')} ${total.main}`]),
            ]}
            value={
              <>
                {avg.main}
                {(r.usdAvg !== null || r.tokensAvg !== null) && <span className="small"> {t('taskCost.perTask')}</span>}
              </>
            }
            valueTitle={avg.detail}
            bar={bars[i]!}
            title={person ? t('detail.openInHr') : undefined}
            onClick={person ? () => onOpenPerson(person) : undefined}
          />
        );
      })}
    </ol>
  );
}

/** "3 conversas · US$ 0,40"; "—" sem nenhuma conversa. */
function bucketLine(label: string, b: TaskCostBucket): string {
  return `${label}: ${b.sessions === 0 ? '—' : joined([bucketMeta(b), costText(b).main])}`;
}

function ManagerRows({ rows, staff, onOpenPerson }: { rows: ManagerCostRow[]; staff: StaffIndex; onOpenPerson: (p: Person) => void }) {
  const bars = barSizes(rows.map((r) => r.usd));
  return (
    <ol className="ranking">
      {rows.map((r, i) => {
        const cost = costText(r);
        const person = staff.personOf(r.staffId);
        return (
          <CostRow
            key={r.staffId}
            pos={i + 1}
            name={staff.nameOf(r.staffId)}
            lines={[
              joined([t('taskCost.managerRequested', { tasks: tasksText(r.tasksRequested) }), cost.sub]),
              bucketLine(t('taskCost.managerReviews'), r.review),
              bucketLine(t('taskCost.managerQuestions'), r.question),
            ]}
            value={cost.main}
            valueTitle={cost.detail}
            bar={bars[i]!}
            title={person ? t('detail.openInHr') : undefined}
            onClick={person ? () => onOpenPerson(person) : undefined}
          />
        );
      })}
    </ol>
  );
}

/** A tela da aba, pura: o relatório (ou `null` enquanto carrega), o erro, o seletor de período e as ações. */
export function TaskCostView({
  ranking,
  error,
  staff,
  period,
  limit,
  onMore,
  onOpenTask,
  onOpenPerson,
}: {
  ranking: TaskCostRanking | null;
  error: string | null;
  staff: StaffIndex;
  /** O seletor de período, no cabeçalho da primeira lista. */
  period: ReactNode;
  limit: number;
  onMore: () => void;
  onOpenTask: (projectId: string, taskId: string) => void;
  onOpenPerson: (person: Person) => void;
}) {
  const waiting = error ? <p className="error small">{error}</p> : !ranking ? <p className="muted small">{t('detail.calculating')}</p> : null;
  return (
    <>
      <p className="muted small">
        {t('taskCost.note')}
        {ranking?.scanning && ` ${t('detail.stillScanning')}`}
      </p>
      <section className="section">
        <div className="ranking-head">
          <h3>{t('taskCost.topTasks')}</h3>
          {period}
        </div>
        {waiting}
        {ranking && ranking.tasks.length === 0 && <p className="muted">{t('taskCost.noTasks')}</p>}
        {ranking && ranking.tasks.length > 0 && <TaskRows rows={ranking.tasks} limit={limit} staff={staff} onOpenTask={onOpenTask} />}
        {ranking && ranking.tasks.length > limit && (
          <button className="btn-secondary" onClick={onMore}>
            {t('detail.showMore', { n: ranking.tasks.length - limit })}
          </button>
        )}
      </section>
      {ranking && ranking.executors.length > 0 && (
        <section className="section">
          <div className="ranking-head">
            <h3>{t('taskCost.byExecutor')}</h3>
          </div>
          <p className="muted small">{t('taskCost.executorHint')}</p>
          <ExecutorRows rows={ranking.executors} staff={staff} onOpenPerson={onOpenPerson} />
        </section>
      )}
      {ranking && ranking.managers.length > 0 && (
        <section className="section">
          <div className="ranking-head">
            <h3>{t('taskCost.byManager')}</h3>
          </div>
          <p className="muted small">{t('taskCost.managerHint')}</p>
          <ManagerRows rows={ranking.managers} staff={staff} onOpenPerson={onOpenPerson} />
        </section>
      )}
    </>
  );
}

/** A aba Tarefas: lê o custo do período escolhido e rebusca enquanto os transcripts são lidos. */
export function TaskCostPanel({ staff, onOpenTask, onOpenPerson }: { staff: StaffIndex; onOpenTask: (projectId: string, taskId: string) => void; onOpenPerson: (person: Person) => void }) {
  const [limit, setLimit] = useState(10);
  const [period, setPeriod] = useState('90');
  const days = RANKING_PERIODS.find(([k]) => k === period)?.[1] ?? null;
  const { data, error } = useScanPoll(() => api.taskCosts(days), period);
  return (
    <TaskCostView
      ranking={data}
      error={error}
      staff={staff}
      period={
        <select className="ranking-period" value={period} onChange={(e) => (setPeriod(e.target.value), setLimit(10))} aria-label={t('detail.period')}>
          {RANKING_PERIODS.map(([k, , label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      }
      limit={limit}
      onMore={() => setLimit(limit + 20)}
      onOpenTask={onOpenTask}
      onOpenPerson={onOpenPerson}
    />
  );
}
