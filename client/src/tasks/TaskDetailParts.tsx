import type { ReactNode } from 'react';
import type { TaskStatus } from '../../../shared/model';
import { t } from '../i18n';
import { cardTone } from '../inbox/alertTone';
import { ActionBar, type BarAction, type MenuItem } from '../lib/ActionBar';
import type { AskCard, FooterAction, FooterPlan, OwnerAsk } from './detailActions';

// Pedaços do painel da tarefa: a faixa "Precisa de você" (o que é decisão do dono, com atalho até o cartão) e o rodapé fixo (as ações,
// fora da rolagem). A regra de quais ações existem fica em ./detailActions; o desenho da barra, em lib/ActionBar.

/** Faixa do topo: o que espera a SUA decisão, uma linha por motivo; cada uma rola até o cartão. Sem nada, não aparece. */
export function NeedsYouStrip({ asks, onGo }: { asks: OwnerAsk[]; onGo: (card: AskCard) => void }) {
  if (!asks.length) return null;
  return (
    <section className={`task-asks ${cardTone('owner')}`} aria-label={t('tasks.asksTitle', { n: asks.length })}>
      <b>{t('tasks.asksTitle', { n: asks.length })}</b>
      <ul>
        {asks.map((a) => (
          <li key={a.card}>
            <button type="button" className="link task-asks-go" onClick={() => onGo(a.card)}>
              {t(a.reason, a.params)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface FooterProps {
  plan: FooterPlan;
  /** Colunas do "Mover para" (o status que o seletor aplica e o texto da opção). */
  columns: { status: TaskStatus; label: string }[];
  /** A coluna em que a tarefa está agora (null: fora delas). */
  column: TaskStatus | null;
  /** Começar (ou Enfileirar): o texto, a dica e o motivo de estar desligado (sem responsável). */
  start: { label: string; title: string; disabledReason: string | null };
  /** O envio do "Devolver" está em andamento. */
  givingBack: boolean;
  /** O texto de "Abrir a conversa com …" (null: sem responsável). */
  chatLabel: string | null;
  /** O seletor de revisor + pedido (o ReviewDelegate, sem o cabeçalho): o painel de "Delegar revisão". */
  delegate: ReactNode;
  /** A etiqueta de "Delegar revisão" (muda se já houve um pedido). */
  delegateLabel: string;
  onStart: () => void;
  onReopen: () => void;
  onApprove: () => void;
  onGoPermission: () => void;
  onGoCard: (card: AskCard) => void;
  onGiveBack: () => void;
  onOpenChat: () => void;
  onUnqueue: () => void;
  onMove: (status: TaskStatus) => void;
  onCancel: () => void;
  onDelete: () => void;
}

/**
 * O rodapé do painel: fica fora da rolagem (o corpo rola, ele não). Entrega ao ActionBar a ação principal do estado, as secundárias e o "⋯".
 * "Reprovar" tem lugar reservado (`data-slot="reject"`, vazio): o botão vem em outro card e entra ali, ao lado do Aprovar.
 */
export function TaskDetailFooter(p: FooterProps) {
  const { plan } = p;
  const action = (id: FooterAction): BarAction | null => {
    switch (id) {
      case 'start':
        return { id, label: p.start.label, title: p.start.title, onClick: p.onStart, disabled: !!p.start.disabledReason, disabledReason: p.start.disabledReason ?? undefined };
      case 'reopen':
        return { id, label: t('tasks.reopen'), title: t('tasks.reopenHint'), onClick: p.onReopen };
      case 'approve':
        return { id, label: t('tasks.approve'), onClick: p.onApprove };
      case 'goPermission':
        return { id, label: t('tasks.permOpen'), title: t('tasks.permOpenTitle'), onClick: p.onGoPermission };
      case 'goCard':
        return { id, label: t(plan.goCard === 'followup' ? 'tasks.footGoFollowUp' : 'tasks.footGoDoubt'), onClick: () => plan.goCard && p.onGoCard(plan.goCard) };
      case 'giveBack':
        return { id, label: t('tasks.noCodeGiveBack'), title: t('tasks.noCodeGiveBackTitle'), onClick: p.onGiveBack, busy: p.givingBack, busyLabel: t('tasks.footGivingBack') };
      case 'openChat':
        return p.chatLabel ? { id, label: p.chatLabel, onClick: p.onOpenChat } : null;
      case 'delegate':
        return { id, label: p.delegateLabel, panel: p.delegate };
      default:
        return null;
    }
  };
  const menu = (id: FooterAction): MenuItem | null => {
    switch (id) {
      case 'move':
        return {
          id,
          node: (
            <label>
              <span>{t('tasks.moveTo')}</span>
              <select className="task-move" value={p.column ?? ''} onChange={(e) => p.onMove(e.target.value as TaskStatus)}>
                {p.columns.map((c) => (
                  <option key={c.status} value={c.status}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ),
        };
      case 'unqueue':
        return { id, label: t('tasks.unqueueMenu'), onClick: p.onUnqueue };
      case 'cancel':
        return { id, label: t('tasks.cancelTask'), title: t('tasks.cancelTaskHint'), onClick: p.onCancel, danger: true };
      case 'delete':
        return { id, label: t('tasks.deleteTask'), onClick: p.onDelete, danger: true };
      default:
        return null;
    }
  };
  const isBar = (a: BarAction | null): a is BarAction => !!a;
  const isMenu = (m: MenuItem | null): m is MenuItem => !!m;
  return (
    <footer className="task-detail-foot">
      <ActionBar
        label={t('tasks.footLabel')}
        moreLabel={t('tasks.moreTitle')}
        primary={plan.primary ? action(plan.primary) : null}
        secondary={plan.secondary.map(action).filter(isBar)}
        more={plan.more.map(menu).filter(isMenu)}
        reserved={plan.primary === 'approve' || plan.secondary.includes('approve') ? 'reject' : undefined}
      />
    </footer>
  );
}
