import type { EngineOverride, TaskFallback } from '../../../shared/model';
import { msgTimeFull } from '../chat/timeLabel';
import { locale, t } from '../i18n';
import { engineName, fallbackReasonKey, otherEngine } from './fallbackEngine';

// Selos discretos de "rodando no motor secundário": no cartão e no detalhe da tarefa (com o motivo e a hora da troca) e no topo da conversa.

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

/** A conversa roda no secundário da ficha (o principal estava no limite): o motor e o modelo, e no tooltip o porquê. */
export function ChatFallbackBadge({ fallback }: { fallback: EngineOverride }) {
  return (
    <p className="fallback-badge small chat-fallback" title={t('chat.fallbackHint', { from: t(engineName(otherEngine(fallback.engine))) })}>
      {t('chat.fallbackBadge', { engine: t(engineName(fallback.engine)), model: fallback.model })}
    </p>
  );
}
