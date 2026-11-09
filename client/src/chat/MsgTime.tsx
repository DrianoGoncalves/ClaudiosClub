import { locale } from '../i18n';
import { msgTimeFull, msgTimeLabel } from './timeLabel';

/** Data e hora da mensagem no rodapé do balão; não desenha nada quando a mensagem não tem horário. */
export function MsgTime({ at }: { at: string | null | undefined }) {
  const label = msgTimeLabel(at, locale());
  if (!label || !at) return null;
  return (
    <time className="msg-time" dateTime={at} title={msgTimeFull(at, locale()) ?? undefined}>
      {label}
    </time>
  );
}
