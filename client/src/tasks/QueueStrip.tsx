import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StaffProfile, StaffQueue } from '../../../shared/model';
import { api } from '../api';
import { Portrait, portraitUrl } from '../board/nodes';
import { t } from '../i18n';
import { cardTone } from '../inbox/alertTone';
import { pollVisible } from '../usePoll';
import type { QueueDot } from './queueState';

// Quem está ocupado em Fazendo (executando, com o retrato de cada um, iniciais se não tem, empilhados e sobrepostos para ocupar pouco) e em Revisão (só bolinha, sem retrato: a foto serve para identificar a fila de quem executa). A frase de cada um
// (estado da fila, trava, detalhe) só aparece ao passar o mouse, focar ou tocar no retrato; a fila travada ganha o tom de alerta já no anel. A lógica está em `queueState.ts` (testada sem tela).

/** Lê o estado das filas de tempos em tempos. `undefined` até a primeira leitura; servidor sem a rota (ou fora do ar) deixa como está, sem erro na tela. `initial` só para teste. */
export function useQueues(projectId: string, initial?: StaffQueue[] | null): StaffQueue[] | null | undefined {
  const [queues, setQueues] = useState<StaffQueue[] | null | undefined>(initial);
  useEffect(() => {
    let alive = true;
    const read = () => void api.projectQueues(projectId).then((q) => alive && setQueues(q), () => undefined);
    read();
    const stop = pollVisible(read, 5000);
    return () => {
      alive = false;
      stop();
    };
  }, [projectId]);
  return queues;
}

const TIP_W = 280;

/** `name` e `src` (o retrato) vêm da ficha do funcionário; sem retrato, as iniciais (como no organograma). */
function QueueDotButton({ dot, name, src, onOpenTask }: { dot: QueueDot; name: string; src: string | null; onOpenTask?: (id: string) => void }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  /** Com link ("Abrir t-xxxx" do card que ocupa a vaga) a dica fica clicável: sair da bolinha para a dica, ou o foco ir para ela, não fecha. */
  const link = dot.openTaskId && onOpenTask ? dot.openTaskId : null;
  const inTip = (n: EventTarget | null) => n instanceof Node && !!tip.current?.contains(n);
  const tipId = useId();
  const open = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - TIP_W - 8)), top: r.bottom + 6 });
  };
  const close = () => setAt(null);
  useEffect(() => {
    if (!at) return;
    // Toque não tem "sair": fora da bolinha, tecla Esc ou rolagem (a dica é fixa na tela) fecha.
    const away = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !btn.current?.contains(e.target as Node) && !inTip(e.target)) close();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', away);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', away);
      window.removeEventListener('scroll', close, true);
    };
  }, [at]);
  const label = dot.detail ? `${dot.text}. ${dot.detail}` : dot.text;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={dot.column === 'doing' ? 'queue-dot' : 'queue-dot is-plain'}
        aria-label={label}
        aria-describedby={at ? tipId : undefined}
        onMouseEnter={open}
        onMouseLeave={(e) => !inTip(e.relatedTarget) && close()}
        onFocus={open}
        onBlur={(e) => !inTip(e.relatedTarget) && close()}
        onClick={open}
      >
        {/* Fazendo (quem executa): o retrato do organograma (foto ou iniciais, contorno à mão), menor; o traço leva a cor do estado: azul ocupado, amarelo de espera na fila travada. Revisão (quem revisa): só a bolinha, sem retrato. */}
        {dot.column === 'doing' ? (
          <Portrait id={dot.staffId} label={name} src={src} size={28} variant={dot.tone === 'stuck' ? 'waiting' : 'busy'} />
        ) : (
          <span className="dot dot-busy" />
        )}
      </button>
      {at &&
        createPortal(
          <div
            ref={tip}
            id={tipId}
            role="tooltip"
            className={`queue-tip ${dot.tone === 'stuck' ? cardTone('queue') : ''}${link ? ' has-link' : ''}`}
            style={{ left: at.left, top: at.top, width: TIP_W }}
            onMouseLeave={link ? (e) => e.relatedTarget !== btn.current && close() : undefined}
          >
            <strong>{dot.text}</strong>
            {dot.detail && <span className="queue-detail">{dot.detail}</span>}
            {link && (
              <button
                type="button"
                className="link small queue-open"
                onClick={() => {
                  close();
                  onOpenTask?.(link);
                }}
              >
                {t('tasks.slotWaitOpen', { id: link })}
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

export function QueueDots({
  dots,
  staff = [],
  projectId = '',
  onOpenTask,
}: {
  dots: QueueDot[];
  staff?: Pick<StaffProfile, 'id' | 'name' | 'portrait' | 'updatedAt'>[];
  projectId?: string;
  /** Abre o card (o link "Abrir t-xxxx" da dica da fila parada pela vaga de escrita). Sem ela, a dica não tem link. */
  onOpenTask?: (id: string) => void;
}) {
  if (!dots.length) return null;
  return (
    <span className="queue-dots" role="group" aria-label={t('tasks.queueLabel')}>
      {dots.map((d) => {
        const s = staff.find((x) => x.id === d.staffId);
        return <QueueDotButton key={`${d.column}:${d.staffId}`} dot={d} name={s?.name ?? d.staffId} src={s?.portrait ? portraitUrl(projectId, s) : null} onOpenTask={onOpenTask} />;
      })}
    </span>
  );
}
