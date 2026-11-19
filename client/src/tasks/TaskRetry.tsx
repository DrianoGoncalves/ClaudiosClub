import type { TaskRetry } from '../../../shared/model';
import { retryLabelText } from '../chat/retryNotice';
import { clockHM } from '../chat/wakeCountdown';
import { t } from '../i18n';
import { countdown } from '../schedules/scheduleView';

// A conversa de uma tarefa em Fazendo caiu por falha passageira (ou o processo caiu no meio) e volta sozinha (`Task.retry`, derivado no servidor).
// O `error` do servidor vem em pt-BR: o motivo sai do texto conhecido (`retryLabelText`), o resto da frase segue o idioma da tela.

export interface RetryText {
  /** O selo do cartão: "Retomando em 42s · 2/3" ("agora" quando passou da hora e o envio está em curso). */
  head: string;
  /** A frase inteira: o motivo, o horário e como cancelar (title do selo e linha do detalhe). */
  hint: string;
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1;

/** Os textos do selo; sem a marca, ou com tentativa/horário que não dá para ler: sem selo. */
export function retryText(retry: TaskRetry | undefined, now: number): RetryText | null {
  if (!retry || !count(retry.attempt) || !count(retry.max)) return null;
  const at = Date.parse(retry.at);
  if (!Number.isFinite(at)) return null;
  return {
    head: t('tasks.retryHead', { when: countdown(retry.at, now), n: retry.attempt, max: retry.max }),
    hint: t('tasks.retryHint', { label: retryLabelText(retry.error), time: clockHM(at), n: retry.attempt, max: retry.max }),
  };
}

/** Selo no cartão (família do "na fila": tracejado, sem laranja) e, no detalhe (`withHint`), a frase inteira embaixo. */
export function RetryBadge({ retry, now, withHint }: { retry?: TaskRetry; now: number; withHint?: boolean }) {
  const text = retryText(retry, now);
  if (!text) return null;
  return (
    <>
      <span className="task-queue task-retry small" title={text.hint}>
        {text.head}
      </span>
      {withHint && <span className="muted small">{text.hint}</span>}
    </>
  );
}
