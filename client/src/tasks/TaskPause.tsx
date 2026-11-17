import type { TaskPause } from '../../../shared/model';
import { formatAgo } from '../format';
import { t } from '../i18n';

// Dúvida escalada a você: o que ela faz com a fila do funcionário (`Task.pause`, derivado no servidor).
// `released` = nada editado, a tarefa espera sem prender o funcionário e ele seguiu para outra; `holding` = já há edição, ele fica nela.
// O `reason` do servidor vem só em pt-BR: o texto daqui sai do `state`, que segue o idioma da tela.

export interface PauseText {
  state: TaskPause['state'];
  /** A primeira linha: o estado. */
  head: string;
  /** A segunda: para onde o funcionário foi (released) ou por que continua preso (holding). */
  body: string;
  /** Frase inteira da regra, para o `title` e o detalhe. */
  hint: string;
}

/** Os textos do aviso; `staffName` é o dono da tarefa (null = sem ficha na lista). Estado desconhecido: sem aviso. */
export function pauseText(pause: TaskPause | undefined, staffName: string | null, now: number): PauseText | null {
  if (!pause || (pause.state !== 'released' && pause.state !== 'holding')) return null;
  const name = staffName ?? t('tasks.pauseStaffFallback');
  const since = Date.parse(pause.since);
  const ago = Number.isFinite(since) ? ` · ${formatAgo(Math.max(0, now - since))}` : '';
  if (pause.state === 'holding') {
    return {
      state: 'holding',
      head: t('tasks.pauseHoldingHead', { name }),
      body: t('tasks.pauseHoldingBody', { name }),
      hint: t('tasks.pauseHoldingHint', { name }),
    };
  }
  return {
    state: 'released',
    head: t('tasks.pauseReleasedHead', { ago }),
    body: pause.movedTo ? t('tasks.pauseMoved', { name, task: pause.movedTo.title }) : t('tasks.pauseFree', { name }),
    hint: t('tasks.pauseReleasedHint', { name }),
  };
}

/** Aviso no cartão e no detalhe: uma caixa com o estado e o porquê. Pontilhada = pausada (liberou a fila); contínua = ocupando (a fila segue presa). */
export function PauseNote({ pause, staffName, now }: { pause?: TaskPause; staffName: string | null; now: number }) {
  const text = pauseText(pause, staffName, now);
  if (!text) return null;
  return (
    <span className={`task-pause is-${text.state} small`} title={text.hint}>
      <b>{text.head}</b>
      <span>{text.body}</span>
    </span>
  );
}
