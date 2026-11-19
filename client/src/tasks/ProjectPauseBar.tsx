import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectPause } from '../../../shared/model';
import { t } from '../i18n';
import { PauseIcon, PlayIcon } from '../icons';
import { pollVisible } from '../usePoll';
import { createPauseController, pausedHeading, pausedTip, type PauseView } from './pauseState';

// Pausar o projeto: o botão (Pausar ⇄ Retomar, no mesmo lugar), o selo e a faixa do quadro que dizem que está pausado, desde quando e o que isso faz.
// O estado vem de `GET /api/projects/:id/pause` (lido de tempos em tempos: outra aba também pausa) e da resposta de quem pausou; a lógica está em
// `createPauseController` (pauseState.ts, testada sem tela) e o hook só a liga ao React.

export interface ProjectPauseState extends PauseView {
  toggle: () => void;
}

/** Lê a pausa do projeto e muda ela. `onChanged` avisa o App (o resumo das salas relê). `initial` só para teste: o render no servidor não roda o efeito que lê. */
export function useProjectPause(projectId: string, projectName: string, onChanged: () => void, initial?: ProjectPause | null): ProjectPauseState {
  const [view, setView] = useState<PauseView>({ pause: initial, busy: false, error: null });
  // O `onChanged` do App é uma função nova a cada render: o controlador chama a última, sem ser refeito por isso.
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const controller = useMemo(
    () => createPauseController({ projectId, name: projectName, initial, onView: setView, onChanged: () => changed.current() }),
    // `initial` só vale na montagem (é de teste).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, projectName],
  );

  useEffect(() => {
    setView(controller.view);
    void controller.read();
    return pollVisible(() => void controller.read(), 5000);
  }, [controller]);

  return { ...view, toggle: () => void controller.toggle() };
}

/** Pausar projeto ⇄ Retomar projeto. Retomar é o botão cheio (é a ação que o dono quer quando vê a faixa). `iconOnly` para o painel estreito; no cabeçalho do quadro o CSS tira o texto em tela estreita (o nome fica no aria-label e no title). */
export function PauseButton({ paused, busy, onClick, iconOnly }: { paused: boolean; busy?: boolean; onClick: () => void; iconOnly?: boolean }) {
  const label = t(paused ? 'tasks.projectResumeBtn' : 'tasks.projectPauseBtn');
  const size = iconOnly ? 16 : 14;
  return (
    <button
      type="button"
      className={`${paused ? 'btn-primary' : 'btn-secondary'} ${iconOnly ? 'btn-icon' : 'btn-with-icon'} project-pause-btn`}
      disabled={busy}
      onClick={onClick}
      title={t(paused ? 'tasks.projectResumeTitle' : 'tasks.projectPauseTitle')}
      aria-label={label}
    >
      {paused ? <PlayIcon size={size} /> : <PauseIcon size={size} />}
      {!iconOnly && <span className="project-pause-label">{label}</span>}
    </button>
  );
}

/** O selo "Pausado" (com a dica de desde quando e o que a pausa faz): no título da sala (`bn-tag`) e no painel do projeto (`badge`); a `className` é de quem usa. */
export function PausedTag({ pause, now, className }: { pause: ProjectPause; now: number; className: string }) {
  return (
    <span className={className} title={pausedTip(pause, now)}>
      <PauseIcon size={10} /> {t('tasks.projectPausedTag')}
    </span>
  );
}

/** A faixa do quadro: pausado desde quando e o que isso faz (nada novo começa sozinho, o que roda termina o turno). Azul, não amarelo nem laranja: é um estado seu, não um pedido de ação. */
export function PausedBanner({ pause, now }: { pause: ProjectPause; now: number }) {
  return (
    <section className="project-paused" role="status">
      <PauseIcon size={18} />
      <div className="project-paused-text">
        <strong>{pausedHeading(pause, now)}</strong>
        <p>{t('tasks.projectPausedBody')}</p>
      </div>
    </section>
  );
}
