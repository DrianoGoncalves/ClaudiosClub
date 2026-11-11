import type { EngineOverride } from '../../../shared/model';
import { locale, t } from '../i18n';
import { engineName } from '../staff/fallbackEngine';
import { msgTimeFull, msgTimeLabel } from './timeLabel';

/** Rodape do balao: horario e motor secundario. */
export function MsgTime({ at, fallback }: { at: string | null | undefined; fallback?: EngineOverride | null }) {
  const label = msgTimeLabel(at, locale());
  if (!label && !fallback) return null;
  return (
    <span className="msg-time">
      {label && at && <time dateTime={at} title={msgTimeFull(at, locale()) ?? undefined}>{label}</time>}
      {fallback && <span title={t('chat.fallbackModelHint', { model: fallback.model })}>{label && ' \u00b7 '}{t('chat.fallbackMessage', { engine: t(engineName(fallback.engine)) })}</span>}
    </span>
  );
}
