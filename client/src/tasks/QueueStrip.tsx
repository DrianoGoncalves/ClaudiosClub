import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StaffProfile, StaffQueue } from '../../../shared/model';
import { api } from '../api';
import { portraitUrl } from '../board/nodes';
import { initials } from '../format';
import { t } from '../i18n';
import { cardTone } from '../inbox/alertTone';
import { pollVisible } from '../usePoll';
import type { QueueDot } from './queueState';

// Quem está ocupado em Fazendo e em Revisão, com o retrato de cada um (iniciais se não tem) no topo da coluna, empilhados e sobrepostos para ocupar pouco. A frase de cada um
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

/** O retrato do funcionário no lugar da bolinha; sem retrato (ou com o arquivo quebrado), as iniciais. O anel leva a cor do estado: verde ocupado, laranja de espera na fila travada. */
function QueueAvatar({ name, src, className }: { name: string; src: string | null; className: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return (
    <span className={`queue-avatar ${className}`} aria-hidden="true">
      {src && !broken ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} /> : initials(name)}
    </span>
  );
}

/** `name` e `src` (o retrato) vêm da ficha do funcionário; sem ela, o id e as iniciais dele. */
function QueueDotButton({ dot, name, src }: { dot: QueueDot; name: string; src: string | null }) {
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
        <QueueAvatar name={name} src={src} className={dot.tone === 'stuck' ? `is-stuck ${cardTone('queue')}` : 'is-busy'} />
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

export function QueueDots({ dots, staff = [], projectId = '' }: { dots: QueueDot[]; staff?: Pick<StaffProfile, 'id' | 'name' | 'portrait' | 'updatedAt'>[]; projectId?: string }) {
  if (!dots.length) return null;
  return (
    <span className="queue-dots" role="group" aria-label={t('tasks.queueLabel')}>
      {dots.map((d) => {
        const s = staff.find((x) => x.id === d.staffId);
        return <QueueDotButton key={`${d.column}:${d.staffId}`} dot={d} name={s?.name ?? d.staffId} src={s?.portrait ? portraitUrl(projectId, s) : null} />;
      })}
    </span>
  );
}
