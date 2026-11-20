import { useMemo } from 'react';
import type { InboxItem, Task } from '../../../shared/model';
import { formatAgo } from '../format';
import { t } from '../i18n';
import { FollowUpFieldsView } from '../tasks/FollowUpFields';
import { authorName } from '../tasks/followUp';
import { followUpTitle, fullText, taskFinished, whoWouldDo, type TeamMember } from '../tasks/followUpNotice';
import { FollowUpDecide } from '../tasks/TaskFollowUps';
import { cardTone } from '../inbox/alertTone';

/**
 * O follow-up da caixa como balão na conversa de trabalho da tarefa (o mesmo padrão do balão de segredo): o selo da recomendação (vale fazer / opcional), o título em linguagem leiga, "Se não
 * fizer: …", o tamanho, quem faria, os "Detalhes técnicos" recolhidos e as saídas: "Criar card" e "Descartar" (com a tarefa já Finalizada, o selo "Finalizado" e "Revisar" e "Concluir").
 * Só existe na tela: não é mensagem da conversa, o modelo nunca vê. Item sem os campos do revisor (follow-up antigo) mostra a primeira linha do achado como título e o texto nos detalhes.
 * `task`: a tarefa de origem, se já lida (o status e o texto inteiro; o da caixa vem cortado em 600). O texto é de outro funcionário: sempre texto puro.
 */
export function FollowUpNotice({
  item,
  task,
  team,
  now,
  loading = false,
  onChanged,
  onGone,
  onDecided,
}: {
  item: InboxItem;
  task: Task | null;
  team: readonly TeamMember[];
  now: number;
  /** A tarefa de origem ainda não foi lida (ou a leitura falhou): as saídas esperam (ver `FollowUpDecide`). */
  loading?: boolean;
  onChanged: () => void | Promise<void>;
  onGone: (message: string | null) => void;
  onDecided: (message: string | null) => void;
}) {
  const f = item.followUp!;
  const finished = taskFinished(task);
  const text = fullText(task, f.followUpId, f.text);
  const followUp = useMemo(() => ({ id: f.followUpId, title: f.title, text, staffId: f.staffId }), [f.followUpId, f.title, text, f.staffId]);
  const author = authorName(f.byName);
  return (
    <div className={`permission followup-notice${finished ? ' is-finished' : ''}`} role="group" aria-label={t('inbox.kindFollowUp')} data-item-id={item.id}>
      {finished && (
        <p className="fu-finished small">
          <span className={`task-badge small fu-done ${cardTone('resolved')}`}>{t('tasks.statusDone')}</span> <span className="muted">{t('tasks.fuFinishedHint')}</span>
        </p>
      )}
      <FollowUpFieldsView
        recommendation={f.recommendation}
        title={followUpTitle({ title: f.title, text })}
        impact={f.impact}
        size={f.size}
        who={whoWouldDo(f, team)}
        by={t('tasks.fuMetaBy', { name: author, ago: formatAgo(now - Date.parse(f.at)) })}
        text={text}
      />
      <FollowUpDecide projectId={item.projectId} taskId={f.taskId} followUp={followUp} task={task} team={team} loading={loading} onDone={onChanged} onGone={onGone} onDecided={onDecided} />
    </div>
  );
}
