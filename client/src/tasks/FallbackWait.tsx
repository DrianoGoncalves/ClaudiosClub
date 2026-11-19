import type { Task } from '../../../shared/model';
import { clockHM } from '../chat/wakeCountdown';
import { locale, t, type MsgKey } from '../i18n';
import { engineName } from '../staff/fallbackEngine';
import { waitClass } from './waitTone';

// A tarefa não caiu no motor secundário porque a pré-checagem da troca falhou (`Task.fallbackBlocked`): ela espera o limite do motor da ficha
// voltar. Mostra o porquê no cartão e no detalhe. O `detail` vem do servidor em pt-BR e não é traduzido; o resto da frase segue o idioma.

type Blocked = NonNullable<Task['fallbackBlocked']>;

const REASON: Record<Blocked['reason'], MsgKey> = {
  sandbox: 'tasks.fbWaitSandbox',
  agents: 'tasks.fbWaitAgents',
  model: 'tasks.fbWaitModel',
  other: 'tasks.fbWaitOther',
};

export interface FallbackWaitText {
  /** O selo do cartão: "Sem troca: espera o limite do Claude voltar". */
  head: string;
  /** A frase inteira: o limite, o motor que não serve e o motivo (title do selo e linha do detalhe). */
  hint: string;
}

/** Quando o limite volta: a hora se for hoje; senão dia/mês e hora. Sem `until` (ou ilegível), vazio. */
function untilText(until: string | null, now: number): string {
  const at = until === null ? NaN : Date.parse(until);
  if (!Number.isFinite(at)) return '';
  const today = new Date(now).toDateString() === new Date(at).toDateString();
  const when = today ? clockHM(at) : new Date(at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return t('tasks.fbWaitUntil', { when });
}

/**
 * Os textos da espera. Passou do `until`, não vale mais (o limite baixou e a fila anda; mesma regra do servidor, `fallbackWait`):
 * sem selo. Sem `until`, vale até a tarefa começar.
 */
export function fallbackWaitText(wait: Task['fallbackBlocked'], now: number): FallbackWaitText | null {
  if (!wait) return null;
  if (wait.until !== null && now >= Date.parse(wait.until)) return null;
  const from = t(engineName(wait.from));
  const why = t(REASON[wait.reason] ?? REASON.other);
  return {
    head: t('tasks.fbWaitHead', { from }),
    hint: t('tasks.fbWaitHint', { from, until: untilText(wait.until, now), engine: t(engineName(wait.engine)), reason: wait.detail ? `${why} (${wait.detail})` : why }),
  };
}

/** Selo do cartão (família do "na fila": quebra linha, o motivo é o que importa). Laranja só em A fazer (`warm`, ver waitTone.ts). */
export function FallbackWaitBadge({ wait, now, warm }: { wait: Task['fallbackBlocked']; now: number; warm?: boolean }) {
  const text = fallbackWaitText(wait, now);
  if (!text) return null;
  return (
    <span className={`task-queue task-fbwait${waitClass(warm)} small`} title={text.hint}>
      {text.head}
    </span>
  );
}
