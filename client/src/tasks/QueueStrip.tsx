import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StaffQueue } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';
import { cardTone } from '../inbox/alertTone';
import { pollVisible } from '../usePoll';
import type { QueueDot } from './queueState';

// Quem está ocupado em Fazendo e em Revisão, em bolinhas no topo da coluna (as mesmas `.dot` das conversas ativas do cabeçalho do projeto no organograma). A frase de cada um
// (estado da fila, trava, detalhe) só aparece ao passar o mouse, focar ou tocar na bolinha; a fila travada ganha o tom de alerta já na bolinha. A lógica está em `queueState.ts` (testada sem tela).

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

function QueueDotButton({ dot }: { dot: QueueDot }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
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
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !btn.current?.contains(e.target as Node)) close();
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
        className="queue-dot"
        aria-label={label}
        aria-describedby={at ? tipId : undefined}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        onClick={open}
      >
        <span className={`dot ${dot.tone === 'stuck' ? `dot-stuck ${cardTone('queue')}` : 'dot-busy'}`} />
      </button>
      {at &&
        createPortal(
          <div id={tipId} role="tooltip" className={`queue-tip ${dot.tone === 'stuck' ? cardTone('queue') : ''}`} style={{ left: at.left, top: at.top, width: TIP_W }}>
            <strong>{dot.text}</strong>
            {dot.detail && <span className="queue-detail">{dot.detail}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}

export function QueueDots({ dots }: { dots: QueueDot[] }) {
  if (!dots.length) return null;
  return (
    <span className="queue-dots" role="group" aria-label={t('tasks.queueLabel')}>
      {dots.map((d) => (
        <QueueDotButton key={`${d.column}:${d.staffId}`} dot={d} />
      ))}
    </span>
  );
}
