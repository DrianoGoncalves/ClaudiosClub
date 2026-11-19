import type { EngineOverride, TaskFallback } from '../../../shared/model';
import { msgTimeFull } from '../chat/timeLabel';
import { locale, t } from '../i18n';
import { primaryReturnOf, type PrimaryReturn } from '../tasks/primaryReturn';
import { engineName, fallbackReasonKey, otherEngine } from './fallbackEngine';

// Selos discretos de "rodando no motor secundário": no cartão e no detalhe da tarefa (com o motivo e a hora da troca) e no topo da conversa.
// E o da volta ao principal (`PrimaryReturnBadge`), que toma o lugar do primeiro quando o limite libera.

/** A tarefa passou a rodar no secundário da ficha: o motor e o modelo, e no tooltip o motivo e desde quando. */
export function TaskFallbackBadge({ fallback }: { fallback: TaskFallback }) {
  const when = msgTimeFull(new Date(fallback.at).toISOString(), locale());
  const reason = t(fallbackReasonKey(fallback.reason), { from: t(engineName(fallback.from)) });
  return (
    <span className="fallback-badge small" title={when ? t('tasks.fallbackHint', { reason, when }) : reason}>
      {t('tasks.fallbackBadge', { engine: t(engineName(fallback.engine)), model: fallback.model })}
    </span>
  );
}

/** Dia/mês e hora, curto: cabe na linha do detalhe no celular (o tooltip do selo de troca usa a data por extenso). */
const shortWhen = (at: string): string => new Date(at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const primaryLine = (back: PrimaryReturn): string => t('tasks.primaryLine', { engine: t(engineName(back.engine)), when: shortWhen(back.at) });

/** A tarefa voltou ao principal quando o limite liberou: o selo discreto do cartão (borda contínua; o do secundário é tracejado). */
export function PrimaryReturnBadge({ task }: { task: Parameters<typeof primaryReturnOf>[0] }) {
  const back = primaryReturnOf(task);
  if (!back) return null;
  return (
    <span className="fallback-badge is-back small" title={primaryLine(back)}>
      {t('tasks.primaryBadge', { engine: t(engineName(back.engine)) })}
    </span>
  );
}

/** A mesma volta por escrito, no detalhe (o tooltip do selo não existe no toque): o motor, a hora e o que mudou. */
export function PrimaryReturnLine({ task }: { task: Parameters<typeof primaryReturnOf>[0] }) {
  const back = primaryReturnOf(task);
  return back ? <p className="muted small">{primaryLine(back)}</p> : null;
}

/** A conversa roda no secundário da ficha (o principal estava no limite): o motor e o modelo, e no tooltip o porquê. */
export function ChatFallbackBadge({ fallback }: { fallback: EngineOverride }) {
  return (
    <p className="fallback-badge small chat-fallback" title={t('chat.fallbackHint', { from: t(engineName(otherEngine(fallback.engine))) })}>
      {t('chat.fallbackBadge', { engine: t(engineName(fallback.engine)), model: fallback.model })}
    </p>
  );
}
