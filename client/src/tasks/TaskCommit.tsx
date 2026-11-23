import type { Task, TaskCommitLeft } from '../../../shared/model';
import { t } from '../i18n';
import { cardTone } from '../inbox/alertTone';

// O commit automático da tarefa pronta (`Task.commit`, ver server/autoCommit.ts): selo no cartão (o SHA, "commit parcial" ou "sem commit") e, no detalhe, o que entrou e o que ficou de fora
// e por quê. É sempre um commit LOCAL: o Club nunca faz push. Os motivos chegam como código (`TaskCommitLeft.why`) e saem aqui no idioma da página; a `note` do servidor é texto em pt-BR.

type CommitTask = Pick<Task, 'status' | 'commit'>;

/** O motivo de um arquivo ter ficado de fora, no idioma da página. */
export const whyText = (l: TaskCommitLeft): string => t(`tasks.commitWhy.${l.why}`, { task: l.by ?? '' });

/**
 * Selo do cartão de tarefa pronta: o SHA (tudo entrou), "commit parcial" (ficou arquivo de fora) ou "sem commit" (falhou ou não coube). Amarelo (.is-waiting) enquanto espera o seu olho,
 * isto é, até você ignorar o aviso da caixa; depois fica neutro. Sem resultado (desligado, ou nada a commitar), não há selo. Só texto: o cartão é um botão.
 */
export function CommitBadge({ task }: { task: CommitTask }) {
  const c = task.commit;
  if (!c || task.status !== 'done') return null;
  const warm = c.alert && !c.ack ? ` ${cardTone('owner')}` : '';
  if (c.status === 'committed' && c.sha) {
    return (
      <span className="task-badge task-commit small" title={t('tasks.commitHint', { sha: c.sha, n: c.files.length })}>
        {t('tasks.commitSha', { sha: c.sha })}
      </span>
    );
  }
  if (c.status === 'partial' && c.sha) {
    return (
      <span className={`task-badge task-commit small${warm}`} title={t('tasks.commitPartialHint', { sha: c.sha, n: c.left.length })}>
        {t('tasks.commitPartial')}
      </span>
    );
  }
  if (c.alert) {
    return (
      <span className={`task-badge task-commit small${warm}`} title={t('tasks.commitNoneHint')}>
        {t('tasks.commitNone')}
      </span>
    );
  }
  return null;
}

/** No detalhe: o resultado do commit, os arquivos que ficaram de fora com o motivo e a nota do servidor (o erro do git, ou por que nada foi commitado). */
export function CommitBlock({ task }: { task: CommitTask }) {
  const c = task.commit;
  if (!c) return null;
  return (
    <div className="task-commit-box small">
      <strong>{t('tasks.commitTitle')}</strong>
      {c.sha ? <span>{t('tasks.commitDone', { sha: c.sha, n: c.files.length })}</span> : <span>{t('tasks.commitNoneLine')}</span>}
      {c.left.length > 0 && (
        <>
          <span>{t('tasks.commitLeftTitle', { n: c.left.length })}</span>
          <ul>
            {c.left.map((l) => (
              <li key={l.path}>
                <code>{l.path}</code> · {whyText(l)}
              </li>
            ))}
          </ul>
        </>
      )}
      {c.note && <span className="muted">{c.note}</span>}
      <span className="muted">{t('tasks.commitLocal')}</span>
    </div>
  );
}
