import { useEffect, useState } from 'react';
import { api, type TaskRunEvent } from '../api';
import { formatDuration } from '../format';
import { locale, t } from '../i18n';

// Execuções da tarefa no detalhe: uma linha por tentativa (começo, gatilho, desfecho e duração), a mais recente primeiro.
// O servidor guarda eventos soltos (`start` e `end` com o mesmo runId); aqui eles viram tentativas.

/** Quantas tentativas ficam à mostra; o resto, em "ver todas". */
const SHOWN = 5;

export interface TaskRun {
  runId: string;
  /** Quando abriu (sem o `start`, a tentativa mais antiga já girou do arquivo: vale o fim). */
  at: string;
  /** O `start` foi lido; sem ele, `at` é o fim e não dá para contar a duração. */
  started: boolean;
  trigger: NonNullable<TaskRunEvent['trigger']> | null;
  /** Como fechou; null = ainda aberta. */
  outcome: NonNullable<TaskRunEvent['outcome']> | null;
  /** Fim da tentativa; null = ainda aberta. */
  endedAt: string | null;
  note: string;
}

/** Junta `start` e `end` de cada runId; a tentativa mais recente (pelo começo) vem primeiro. */
export function groupRuns(events: TaskRunEvent[]): TaskRun[] {
  const byRun = new Map<string, { start?: TaskRunEvent; end?: TaskRunEvent }>();
  for (const ev of events) {
    const cur = byRun.get(ev.runId) ?? {};
    if (ev.ev === 'start') cur.start = ev;
    else cur.end = ev;
    byRun.set(ev.runId, cur);
  }
  const at = (r: TaskRun) => Date.parse(r.at) || 0;
  return [...byRun.entries()]
    .map(([runId, { start, end }]) => ({
      runId,
      at: (start ?? end)!.at,
      started: !!start,
      trigger: start?.trigger ?? null,
      outcome: end?.outcome ?? null,
      endedAt: end?.at ?? null,
      note: end?.note ?? start?.note ?? '',
    }))
    .sort((a, b) => at(b) - at(a));
}

/** Duração da tentativa ("12min"); aberta, o tempo até agora; sem começo conhecido (só o fim), nada. */
export function runDuration(run: TaskRun, now: number): string | null {
  if (!run.started) return null;
  const from = Date.parse(run.at);
  const to = run.endedAt ? Date.parse(run.endedAt) : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return formatDuration(Math.max(0, to - from));
}

const TRIGGER: Record<NonNullable<TaskRun['trigger']>, string> = {
  queue: t('tasks.runTriggerQueue'),
  manual: t('tasks.runTriggerManual'),
  resume: t('tasks.runTriggerResume'),
  adjust: t('tasks.runTriggerAdjust'),
  routine: t('tasks.runTriggerRoutine'),
};

const OUTCOME: Record<NonNullable<TaskRun['outcome']>, string> = {
  delivered: t('tasks.runOutcomeDelivered'),
  stopped: t('tasks.runOutcomeStopped'),
  limit: t('tasks.runOutcomeLimit'),
  cancelled: t('tasks.runOutcomeCancelled'),
  failed: t('tasks.runOutcomeFailed'),
};

/** Um valor que o servidor passou a mandar e esta tela não conhece aparece como veio, em vez de sumir. */
const label = <K extends string>(table: Record<K, string>, key: string | null) => (key === null ? '—' : ((table as Record<string, string>)[key] ?? key));

/** Tentativas de uma tarefa. Relê quando a tarefa muda (nova tentativa, entrega, parada); sem nenhuma tentativa, não desenha nada. */
export function TaskRuns({ projectId, taskId, version }: { projectId: string; taskId: string; version: string }) {
  const [events, setEvents] = useState<TaskRunEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let alive = true;
    api.taskRuns(projectId, taskId).then(
      (r) => alive && (setEvents(r ?? []), setError(null)),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [projectId, taskId, version]);

  if (error) return <p className="error small">{error}</p>;
  if (!events?.length) return null;
  const runs = groupRuns(events);
  const shown = all ? runs : runs.slice(0, SHOWN);
  const now = Date.now();
  return (
    <details className="collapse">
      <summary>{t('tasks.runs', { n: runs.length })}</summary>
      <ul className="task-runs small">
        {shown.map((r) => {
          const dur = runDuration(r, now);
          return (
            <li key={r.runId}>
              <span className="task-run-line">
                {new Date(r.at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                {' · '}
                {label(TRIGGER, r.trigger)}
                {' · '}
                <b className={r.outcome === 'delivered' ? 'ok' : r.outcome === 'failed' ? 'fail' : undefined}>{r.outcome ? label(OUTCOME, r.outcome) : t('tasks.runOpen')}</b>
                {dur && ` · ${dur}`}
              </span>
              {r.note && (
                <span className="task-run-note muted" title={r.note}>
                  {r.note}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {runs.length > SHOWN && (
        <button type="button" className="link small" onClick={() => setAll((v) => !v)}>
          {all ? t('tasks.runsLess') : t('tasks.runsAll', { n: runs.length })}
        </button>
      )}
    </details>
  );
}
