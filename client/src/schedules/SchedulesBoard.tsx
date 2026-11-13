import { useCallback, useEffect, useState } from 'react';
import type { StaffProfile } from '../../../shared/model';
import { api } from '../api';
import { pollVisible } from '../usePoll';
import { t } from '../i18n';
import { countdown, type Schedule, scheduleKey, whenParts } from './scheduleView';

// Agendamentos pendentes de um projeto: os despertadores que os funcionários pediram e os "continue" automáticos do
// limite de uso. Cada um mostra quem, quando (hora + contagem regressiva) e o que será feito; dá para abrir a
// conversa e cancelar (com confirmação na própria linha, sem diálogo do navegador).

/** O texto do despertador é do funcionário: sempre como texto puro (o React escapa; nada de markdown nem HTML). */
function Scheduled({ s, now, who }: { s: Schedule; now: number; who: string }) {
  const wake = s.kind === 'wake';
  const { date, time } = whenParts(s.at, now);
  const at = date ? t('schedules.atDate', { date, time }) : t('schedules.at', { time });
  return (
    <>
      <div className="sched-top">
        <strong className="sched-who">{who}</strong>
        <span className="sched-kind" title={t(wake ? 'schedules.kindWakeHint' : 'schedules.kindContinueHint')}>
          {t(wake ? 'schedules.kindWake' : 'schedules.kindContinue')}
        </span>
      </div>
      <p className="sched-when">
        <time dateTime={s.at}>{at}</time> · <span className="sched-eta">{countdown(s.at, now)}</span>
      </p>
      <p className="sched-text">{wake ? s.text.trim() || t('schedules.noText') : t('schedules.continueText')}</p>
    </>
  );
}

interface ListProps {
  items: Schedule[];
  now: number;
  nameOf: (staffId: string | null) => string;
  /** A linha que pede confirmação para cancelar (pela chave). */
  confirming: string | null;
  /** A linha cujo cancelamento está em andamento. */
  busy: string | null;
  /** Erro do cancelamento, por linha. */
  errors: Record<string, string>;
  onAsk: (key: string | null) => void;
  onCancel: (s: Schedule) => void;
  onOpen: (s: Schedule) => void;
}

export function ScheduleList({ items, now, nameOf, confirming, busy, errors, onAsk, onCancel, onOpen }: ListProps) {
  return (
    <ul className="sched-list">
      {items.map((s) => {
        const key = scheduleKey(s);
        return (
          <li key={key} className="sched-item" data-kind={s.kind}>
            <Scheduled s={s} now={now} who={nameOf(s.staffId)} />
            {errors[key] && <p className="error sched-error">{errors[key]}</p>}
            {confirming === key ? (
              <div className="sched-confirm" role="group" aria-label={t('schedules.confirmAsk')}>
                <p>{t('schedules.confirmAsk')}</p>
                <div className="sched-actions">
                  <button type="button" className="btn-secondary is-danger" disabled={busy === key} onClick={() => onCancel(s)}>
                    {busy === key ? t('schedules.cancelling') : t('schedules.confirmYes')}
                  </button>
                  <button type="button" className="btn-secondary" autoFocus disabled={busy === key} onClick={() => onAsk(null)}>
                    {t('schedules.confirmNo')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="sched-actions">
                <button type="button" className="btn-secondary" onClick={() => onOpen(s)}>
                  {t('schedules.openChat')}
                </button>
                <button type="button" className="btn-secondary is-danger" onClick={() => onAsk(key)}>
                  {t('schedules.cancel')}
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface Props {
  projectId: string;
  projectName: string;
  /** Funcionários com ficha deste projeto (o nome vem do `staffId`). */
  staff: StaffProfile[];
  onClose: () => void;
  /** Abre a conversa do agendamento (`staffId` null = conversa sem ficha). */
  onOpenConversation: (staffId: string | null, sessionId: string) => void;
  /** Volta ao quadro de tarefas do projeto. */
  onOpenTasks?: () => void;
}

const POLL_MS = 5000;

export function SchedulesBoard({ projectId, projectName, staff, onClose, onOpenConversation, onOpenTasks }: Props) {
  const [items, setItems] = useState<Schedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  /** Relê a lista; devolve o que veio (ou null se falhou). */
  const load = useCallback(
    () =>
      api.schedules(projectId).then(
        (r) => {
          const next = r.items ?? [];
          setItems(next);
          setError(null);
          return next;
        },
        (e: Error) => {
          setError(e.message);
          return null;
        },
      ),
    [projectId],
  );

  // Os agendamentos disparam e somem sozinhos: relê de tempos em tempos; a contagem desce de segundo em segundo.
  useEffect(() => {
    void load();
    const stopPoll = pollVisible(() => void load(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopPoll();
      clearInterval(tick);
    };
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (confirming ? setConfirming(null) : onClose());
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, confirming]);

  // O aviso de sucesso some sozinho (igual ao do canto da tela).
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  const nameOf = (staffId: string | null) =>
    staffId === null ? t('board.ghostName') : (staff.find((p) => p.id === staffId)?.name ?? staffId);

  const cancel = async (s: Schedule) => {
    const key = scheduleKey(s);
    setBusy(key);
    setErrors((e) => ({ ...e, [key]: '' }));
    try {
      const done = s.kind === 'wake' ? await api.chatCancelWake(projectId, s.sessionId) : await api.chatCancelAutoContinue(projectId, s.sessionId);
      setConfirming(null);
      setItems((list) => list && list.filter((i) => scheduleKey(i) !== key));
      setNotice(t(done.ok ? 'schedules.cancelled' : 'schedules.gone'));
      void load();
    } catch (e) {
      // 404 e falha de rede chegam como o mesmo erro: relê a lista para saber se o agendamento ainda existe.
      const fresh = await load();
      if (fresh && !fresh.some((i) => scheduleKey(i) === key)) {
        setConfirming(null);
        setNotice(t('schedules.gone'));
      } else {
        const message = (e as Error).message;
        // Recusa por pareamento vem sem texto: o aviso do App já explica.
        if (message) setErrors((prev) => ({ ...prev, [key]: t('schedules.cancelFailed', { error: message }) }));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sched-modal" role="dialog" aria-label={t('schedules.dialogLabel', { name: projectName })}>
        <header className="tasks-head">
          <h2>{t('schedules.title', { name: projectName })}</h2>
          <span className="tasks-head-actions">
            {onOpenTasks && (
              <button type="button" className="btn-secondary" onClick={onOpenTasks}>
                {t('schedules.tasks')}
              </button>
            )}
            <button type="button" className="drawer-close in-head" onClick={onClose} aria-label={t('schedules.close')}>
              ×
            </button>
          </span>
        </header>
        <p className="muted sched-intro">{t('schedules.intro')}</p>
        {error && <p className="error">{t('schedules.loadFailed', { error })}</p>}
        {notice && (
          <p className="muted sched-notice" role="status">
            {notice}
          </p>
        )}
        {items === null ? (
          !error && <p className="muted">{t('schedules.loading')}</p>
        ) : items.length === 0 ? (
          <div className="sched-empty">
            <p>{t('schedules.empty')}</p>
            <p className="muted">{t('schedules.emptyHint')}</p>
          </div>
        ) : (
          <ScheduleList
            items={items}
            now={now}
            nameOf={nameOf}
            confirming={confirming}
            busy={busy}
            errors={errors}
            onAsk={setConfirming}
            onCancel={(s) => void cancel(s)}
            onOpen={(s) => onOpenConversation(s.staffId, s.sessionId)}
          />
        )}
      </div>
    </div>
  );
}
