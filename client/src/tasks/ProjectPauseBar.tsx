import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectPause } from '../../../shared/model';
import { t } from '../i18n';
import { PauseIcon, PlayIcon } from '../icons';
import { pollVisible } from '../usePoll';
import {
  createPauseController,
  isVersionPause,
  minutesLabel,
  pauseHeading,
  pausedTip,
  versionBy,
  VERSION_PAUSE_DEFAULT,
  VERSION_PAUSE_OPTIONS,
  type PauseView,
} from './pauseState';
import { clockHM } from '../chat/wakeCountdown';

// Pausar o projeto: o botão (Pausar ⇄ Retomar, no mesmo lugar), o selo e a faixa do quadro que dizem que está pausado, desde quando e o que isso faz.
// O estado vem de `GET /api/projects/:id/pause` (lido de tempos em tempos: outra aba também pausa) e da resposta de quem pausou; a lógica está em
// `createPauseController` (pauseState.ts, testada sem tela) e o hook só a liga ao React.

export interface ProjectPauseState extends PauseView {
  /** Pausa/retoma (na pausa de versão, encerra-a). */
  toggle: () => void;
  startVersion: (minutes: number) => void;
}

/** Com a pausa de versão ligada, refaz a tela de tempos em tempos para o "faltam X min" andar (a leitura do estado só muda a tela quando o estado muda). */
const VERSION_TICK_MS = 15_000;

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

  const [, setTick] = useState(0);
  const versioned = isVersionPause(view.pause);
  useEffect(() => {
    if (!versioned) return;
    const id = setInterval(() => setTick((n) => n + 1), VERSION_TICK_MS);
    return () => clearInterval(id);
  }, [versioned]);

  return { ...view, toggle: () => void controller.toggle(), startVersion: (minutes) => void controller.startVersion(minutes) };
}

/** Pausar projeto ⇄ Retomar projeto. Retomar é o botão cheio (é a ação que o dono quer quando vê a faixa). `iconOnly` para o painel estreito; no cabeçalho do quadro o CSS tira o texto em tela estreita (o nome fica no aria-label e no title). */
export function PauseButton({ paused, busy, onClick, iconOnly, version }: { paused: boolean; busy?: boolean; onClick: () => void; iconOnly?: boolean; version?: boolean }) {
  // Na pausa de versão o botão encerra a pausa (o texto diz isso), em vez de "Retomar projeto".
  const label = t(version ? 'tasks.versionPauseEnd' : paused ? 'tasks.projectResumeBtn' : 'tasks.projectPauseBtn');
  const size = iconOnly ? 16 : 14;
  return (
    <button
      type="button"
      className={`${paused ? 'btn-primary' : 'btn-secondary'} ${iconOnly ? 'btn-icon' : 'btn-with-icon'} project-pause-btn${version ? ' is-version' : ''}`}
      disabled={busy}
      onClick={onClick}
      title={t(version ? 'tasks.versionPauseEndTitle' : paused ? 'tasks.projectResumeTitle' : 'tasks.projectPauseTitle')}
      aria-label={label}
    >
      {paused ? <PlayIcon size={size} /> : <PauseIcon size={size} />}
      {!iconOnly && <span className="project-pause-label">{label}</span>}
    </button>
  );
}

/** O selo "Pausado" (com a dica de desde quando e o que a pausa faz): no título da sala (`bn-tag`) e no painel do projeto (`badge`); a `className` é de quem usa. */
export function PausedTag({ pause, now, className }: { pause: ProjectPause; now: number; className: string }) {
  // Na de versão o selo traz o que falta ("Pausa de versão · 24 min"); quem ligou e o resto ficam na dica.
  const text = isVersionPause(pause) ? `${t('tasks.versionPausedTag')} · ${minutesLabel(Math.max(0, Date.parse(pause.until) - now) / 60_000)}` : t('tasks.projectPausedTag');
  return (
    <span className={`${className}${isVersionPause(pause) ? ' is-version' : ''}`} title={pausedTip(pause, now)}>
      <PauseIcon size={10} /> {text}
    </span>
  );
}

/** "Pausa de versão" com o prazo (minutos) ao lado e o botão de ligar: só aparece com o projeto rodando. O prazo escolhido é o pedido (sem pergunta). */
export function VersionPauseControl({ busy, onStart }: { busy?: boolean; onStart: (minutes: number) => void }) {
  const [minutes, setMinutes] = useState<number>(VERSION_PAUSE_DEFAULT);
  return (
    <div className="version-pause-control" role="group" aria-label={t('tasks.versionPauseBtn')} title={t('tasks.versionPauseTitle')}>
      <span className="version-pause-label">
        <PauseIcon size={14} /> {t('tasks.versionPauseBtn')}
      </span>
      <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} disabled={busy} aria-label={t('tasks.versionPauseDeadline')}>
        {VERSION_PAUSE_OPTIONS.map((m) => (
          <option key={m} value={m}>
            {minutesLabel(m)}
          </option>
        ))}
      </select>
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => onStart(minutes)}>
        {t('tasks.versionPauseStart')}
      </button>
    </div>
  );
}

/** A faixa do quadro: pausado desde quando e o que isso faz (nada novo começa sozinho, o que roda termina o turno). Azul, não amarelo nem laranja: é um estado seu, não um pedido de ação. */
export function PausedBanner({ pause, now }: { pause: ProjectPause; now: number }) {
  const version = isVersionPause(pause);
  return (
    <section className={`project-paused${version ? ' is-version' : ''}`} role="status">
      <PauseIcon size={18} />
      <div className="project-paused-text">
        <strong>{pauseHeading(pause, now)}</strong>
        <p>{version ? `${versionBy(pause)}. ${t('tasks.versionPausedBody', { time: clockHM(Date.parse(pause.until)) })}` : t('tasks.projectPausedBody')}</p>
      </div>
    </section>
  );
}
