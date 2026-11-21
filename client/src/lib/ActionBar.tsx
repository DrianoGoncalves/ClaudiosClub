import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { t } from '../i18n';

// Barra de ações dos painéis (tarefa, e depois funcionário e projeto). Aplica por construção a regra de hierarquia dos botões:
//  - uma só primária (`primary` é um objeto, não uma lista): a ação que destrava o fluxo ou depende do dono;
//  - secundárias (contorno): alternativas; "⋯" (`more`): ações raras; destrutiva (`danger`): contorno vermelho, nunca primária, dentro do "⋯";
//  - ordem fixa [⋯] [secundárias] [reservado] [primária]: a primária à direita no desktop; no celular, largura inteira e embaixo;
//  - primária desligada mostra o motivo ao lado (`disabledReason`); durante o envio (`busy`) o rótulo vira "enviando…" e o botão não clica de novo.
// A confirmação da ação destrutiva é de quem passa o `onClick` (o diálogo de cancelar, o "tem certeza?").

export interface BarAction {
  id: string;
  /** Verbo + objeto ("Aprovar entrega"), nunca "OK" ou "Confirmar" soltos. */
  label: string;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
  /** Por que está desligado: na primária, aparece ao lado do botão (e o leitor de tela lê como descrição). */
  disabledReason?: string;
  /** Enviando: desliga o botão e troca o rótulo por `busyLabel` ("enviando…"). */
  busy?: boolean;
  busyLabel?: string;
  /** Destrutiva: `btn-secondary is-danger`. Nunca vale na primária (o componente a ignora lá). */
  danger?: boolean;
  /** Só nas secundárias: em vez de agir, o botão abre este painel (ex.: escolher quem revisa) acima da barra. */
  panel?: ReactNode;
}

/** Um item do "⋯": uma ação, ou um nó livre (ex.: o seletor "Mover para"). */
export type MenuItem = BarAction | { id: string; node: ReactNode };

export interface ActionBarProps {
  /** O nome da região, para o leitor de tela. */
  label: string;
  /** A ação principal (no máximo uma; sem pendência do dono, a próxima ação natural). */
  primary?: BarAction | null;
  secondary?: BarAction[];
  more?: MenuItem[];
  /** O nome do botão "⋯" para o leitor de tela. */
  moreLabel: string;
  /** Lugar vazio, entre as secundárias e a primária, que outro card preenche (`data-slot`). */
  reserved?: string;
}

const isNode = (i: MenuItem): i is { id: string; node: ReactNode } => 'node' in i;

/** Fecha o painel aberto da barra ao clicar fora ou com Esc (e devolve o foco ao botão que o abriu). */
function useDismiss(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const open = () => Array.from(root.current?.querySelectorAll<HTMLDetailsElement>('details.action-bar-pop[open]') ?? []);
    const down = (e: PointerEvent) => open().forEach((d) => !d.contains(e.target as Node) && d.removeAttribute('open'));
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const d = open();
      if (!d.length) return;
      e.stopPropagation(); // o Esc do quadro fecharia o painel inteiro
      d.forEach((x) => {
        x.removeAttribute('open');
        x.querySelector('summary')?.focus();
      });
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key, true);
    };
  }, [root]);
}

const closeMenu = (el: HTMLElement) => el.closest('details')?.removeAttribute('open');

function ActionButton({ a, kind, inMenu = false }: { a: BarAction; kind: 'primary' | 'secondary'; inMenu?: boolean }) {
  const danger = a.danger && kind === 'secondary';
  const cls = `${kind === 'primary' ? 'btn-primary' : 'btn-secondary'}${danger ? ' is-danger' : ''}${inMenu ? ' action-bar-item' : ''}`;
  return (
    <button
      type="button"
      className={cls}
      title={a.title}
      disabled={a.disabled || a.busy}
      aria-busy={a.busy || undefined}
      aria-describedby={kind === 'primary' && a.disabledReason ? `${a.id}-why` : undefined}
      onClick={(e) => {
        if (a.busy) return;
        if (inMenu) closeMenu(e.currentTarget);
        a.onClick?.();
      }}
    >
      {a.busy ? (a.busyLabel ?? t('actionBar.sending')) : a.label}
    </button>
  );
}

export function ActionBar({ label, primary, secondary = [], more = [], moreLabel, reserved }: ActionBarProps) {
  const root = useRef<HTMLDivElement>(null);
  useDismiss(root);
  return (
    <div className="action-bar" ref={root} role="group" aria-label={label}>
      {more.length > 0 && (
        <details className="action-bar-pop action-bar-more">
          <summary className="btn-secondary" aria-label={moreLabel} title={moreLabel}>
            ⋯
          </summary>
          <div className="action-bar-panel is-menu">
            {more.map((i) =>
              isNode(i) ? (
                <div key={i.id} className="action-bar-move">
                  {i.node}
                </div>
              ) : (
                <ActionButton key={i.id} a={i} kind="secondary" inMenu />
              ),
            )}
          </div>
        </details>
      )}
      {secondary.map((a) =>
        a.panel ? (
          <details key={a.id} className="action-bar-pop">
            <summary className="btn-secondary" title={a.title}>
              {a.label}
            </summary>
            <div className="action-bar-panel">{a.panel}</div>
          </details>
        ) : (
          <ActionButton key={a.id} a={a} kind="secondary" />
        ),
      )}
      {reserved && <span data-slot={reserved} />}
      {primary?.disabledReason && (primary.disabled || primary.busy) && (
        <p id={`${primary.id}-why`} className="action-bar-why">
          {primary.disabledReason}
        </p>
      )}
      {primary && <ActionButton a={primary} kind="primary" />}
    </div>
  );
}
