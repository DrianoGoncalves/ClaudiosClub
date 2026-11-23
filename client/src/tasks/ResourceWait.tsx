import type { Task, TaskStatus } from '../../../shared/model';
import { formatAgo } from '../format';
import { t } from '../i18n';
import { waitClass } from './waitTone';

// Tarefa na fila segurada pelo gate de recursos (RAM, CPU ou teto de conversas) ou pela vaga de escrita do projeto: motivo e há quanto tempo espera.
// O `reason` do gate vem do servidor em pt-BR e não é traduzido; o resto da frase segue o idioma. A espera pela vaga (`wait.holder`) tem texto próprio, montado aqui.

type Wait = NonNullable<Task['resourceWait']>;

/** O card que ocupa a vaga de escrita. `title` e `column` null: o card não está na lista (o id é o que resta). */
export interface SlotHolder {
  id: string;
  title: string | null;
  column: string | null;
}

/** Quem ocupa a vaga que `wait` espera; null se a espera não é pela vaga (é do gate de recursos). */
export function slotHolder(wait: Task['resourceWait'], tasks: Pick<Task, 'id' | 'title' | 'status'>[], labels: Record<TaskStatus, string>): SlotHolder | null {
  if (!wait?.holder) return null;
  const card = tasks.find((x) => x.id === wait.holder);
  return { id: wait.holder, title: card?.title ?? null, column: card ? labels[card.status] : null };
}

function agoOf(since: string, now: number): string {
  const at = Date.parse(since);
  return Number.isFinite(at) ? ` · ${formatAgo(Math.max(0, now - at))}` : '';
}

/** O card que ocupa a vaga, em palavras: “Título” (t-xxxx, Fazendo); sem o título, só o id. */
export function slotHolderLabel(holder: SlotHolder): string {
  const where = holder.column ? `${holder.id}, ${holder.column}` : holder.id;
  return holder.title === null ? holder.id : `“${holder.title}” (${where})`;
}

/** "Aguardando recursos: RAM disponível 1,2 GB (reserva 1,5 GB) · há 4 min"; sem `since` válido, sem o tempo. Com `holder` (a vaga de escrita), o texto próprio dela. */
export function resourceWaitText(wait: Wait, now: number, holder?: SlotHolder | null): string {
  const ago = agoOf(wait.since, now);
  if (holder) return t('tasks.slotWait', { holder: slotHolderLabel(holder), ago });
  return t('tasks.resourceWait', { reason: wait.reason, ago });
}

/** A dica do selo e a frase que fecha o aviso do detalhe: o que a espera é e como ignorá-la. */
export const resourceWaitHint = (holder?: SlotHolder | null): string => t(holder ? 'tasks.slotWaitHint' : 'tasks.resourceWaitHint');

/**
 * Selo discreto do cartão (mesma família do "na fila"): quebra linha em vez de cortar, o motivo é o que importa. Com `onOpen` e o card que ocupa na lista, o selo leva o link "Abrir t-xxxx"
 * para ele. O cartão é um `<button>`, então o link é um `span role="link"` (botão dentro de botão é HTML inválido); o clique e Enter/Espaço não chegam ao cartão.
 */
export function ResourceWaitBadge({ wait, now, warm, holder, onOpen }: { wait?: Task['resourceWait']; now: number; warm?: boolean; holder?: SlotHolder | null; onOpen?: (id: string) => void }) {
  if (!wait) return null;
  const open = holder && holder.title !== null && onOpen ? () => onOpen(holder.id) : null;
  return (
    <span className={`task-queue task-resource${waitClass(warm)} small`} title={resourceWaitHint(holder)}>
      {resourceWaitText(wait, now, holder)}
      {open && holder && (
        <span
          role="link"
          tabIndex={0}
          className="task-slot-open"
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            open();
          }}
        >
          {t('tasks.slotWaitOpen', { id: holder.id })}
        </span>
      )}
    </span>
  );
}
