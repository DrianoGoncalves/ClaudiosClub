import { t } from '../i18n';
import { ArrowDownIcon, ArrowTopIcon, ArrowUpIcon } from '../icons';
import type { OrderBody, OrderMoves } from './queueOrder';

/**
 * Os três botões de ordem da fila do funcionário: ao topo, um lugar acima, um abaixo. É o caminho do celular (arrastar não basta no toque) e o de
 * quem não arrasta. No cartão vão só os ícones (o nome fica no title e no aria-label); no detalhe, com texto. O servidor recusa o que não muda nada,
 * então o que já está no limite fica desligado.
 */
export function OrderButtons({ moves, onOrder, withText = false }: { moves: OrderMoves; onOrder: (body: OrderBody) => void; withText?: boolean }) {
  const items: { key: string; body: OrderBody; on: boolean; icon: JSX.Element; label: string }[] = [
    { key: 'top', body: { to: 'top' }, on: moves.top, icon: <ArrowTopIcon size={14} />, label: t('tasks.orderTop') },
    { key: 'up', body: { step: 'up' }, on: moves.up, icon: <ArrowUpIcon size={14} />, label: t('tasks.orderUp') },
    { key: 'down', body: { step: 'down' }, on: moves.down, icon: <ArrowDownIcon size={14} />, label: t('tasks.orderDown') },
  ];
  return (
    <span className={`task-order${withText ? ' is-text' : ''}`} role="group" aria-label={t('tasks.orderGroup')}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          className={`btn-secondary ${withText ? 'btn-with-icon' : 'btn-icon'}`}
          disabled={!it.on}
          title={it.label}
          aria-label={it.label}
          onClick={() => onOrder(it.body)}
        >
          {it.icon}
          {withText && it.label}
        </button>
      ))}
    </span>
  );
}
