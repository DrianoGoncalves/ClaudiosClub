import type { Task } from '../../../shared/model';
import { t } from '../i18n';
import { noCodeOf } from './noCode';

// Card sem código (ver ./noCode.ts): selo no cartão e bloco no detalhe, com o que o responsável disse ao terminar e, quando quem decide é você, as duas saídas.

type NameOf = (id: string | null) => string | null;

/** Selo do cartão: "Sem código". Amarelo quando espera você (o aviso foi para a sua caixa); senão neutro. Só texto: o cartão é um botão. */
export function NoCodeBadge({ task }: { task: Pick<Task, 'noCode' | 'status'> }) {
  const n = noCodeOf(task);
  if (!n) return null;
  return (
    <span className={`task-badge task-nocode small${n.to === 'owner' ? ' is-waiting' : ''}`} title={t('tasks.noCodeBadgeHint')}>
      {t('tasks.noCodeBadge')}
    </span>
  );
}

/**
 * Bloco do detalhe: por que o card está parado em "fazendo", com quem está a decisão e o que o responsável disse ao terminar (a análise ou a resposta pode estar aí; texto puro). Com a decisão
 * sua (`to: 'owner'`): "Cancelar" (abre o diálogo de cancelar, com o motivo) e "Devolver ao responsável" (uma mensagem na conversa dele). Com o gestor, só o aviso: ele decide pela conversa dele.
 */
export function NoCodeBlock({ task, nameOf, busy = false, onCancel, onGiveBack }: { task: Task; nameOf: NameOf; busy?: boolean; onCancel: () => void; onGiveBack: () => void }) {
  const n = noCodeOf(task);
  if (!n) return null;
  const manager = n.to === 'manager' ? ((task.requestedBy && nameOf(task.requestedBy)) || t('tasks.fuManagerFallback')) : null;
  return (
    <section className="task-nocode-box" aria-label={t('tasks.noCodeTitle')}>
      <header className="task-doubt-head">
        <b>{t('tasks.noCodeTitle')}</b>
        <span className={`task-badge small${n.to === 'owner' ? ' is-waiting' : ''}`}>{t('tasks.noCodeBadge')}</span>
      </header>
      <p className="muted small">{manager ? t('tasks.noCodeManager', { name: manager }) : t('tasks.noCodeOwner')}</p>
      {n.summary && (
        <details className="fu-details" open>
          <summary>{t('tasks.noCodeSaid')}</summary>
          <p className="fu-text">{n.summary}</p>
        </details>
      )}
      {n.to === 'owner' && (
        <p className="task-fu-actions">
          <button type="button" className="btn-secondary" title={t('tasks.noCodeCancelTitle')} disabled={busy} onClick={onCancel}>
            {t('tasks.noCodeCancel')}
          </button>
          <button type="button" className="btn-primary" title={t('tasks.noCodeGiveBackTitle')} disabled={busy} onClick={onGiveBack}>
            {t('tasks.noCodeGiveBack')}
          </button>
        </p>
      )}
    </section>
  );
}
