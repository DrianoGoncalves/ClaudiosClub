import { useCallback, useEffect, useId, useState } from 'react';
import type { BoardConfig, StaffProfile } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';
import { ReviewIcon } from '../icons';

// Revisão automática do quadro (`<projeto>/.myco/board.json`): liga/desliga e o funcionário responsável. Quem revisa cada tarefa
// está em reviewRule.ts; a opção por tarefa (formulário e detalhe) continua valendo e tem prioridade sobre esta.

export interface BoardReviewState {
  /** null = ainda lendo, falhou ou o servidor não tem a rota. */
  config: BoardConfig | null;
  /** Servidor sem a rota (404): o bloco some, como nas outras opções que um servidor velho não conhece. */
  missing: boolean;
  error: string | null;
  saving: boolean;
  save: (next: BoardConfig) => Promise<void>;
}

const isConfig = (x: unknown): x is BoardConfig =>
  typeof x === 'object' && x !== null && typeof (x as BoardConfig).autoReview === 'boolean' && ((x as BoardConfig).reviewerId === null || typeof (x as BoardConfig).reviewerId === 'string');

/** Lê a configuração do projeto e grava o estado inteiro; o que vale é o que o servidor devolve. */
export function useBoardReview(projectId: string): BoardReviewState {
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setConfig(null);
    setMissing(false);
    setError(null);
    api.boardReview(projectId).then(
      (c) => live && (isConfig(c) ? setConfig(c) : setMissing(true)),
      (e: Error) => live && (/: 404$/.test(e.message) ? setMissing(true) : setError(e.message)),
    );
    return () => {
      live = false;
    };
  }, [projectId]);

  const save = useCallback(
    async (next: BoardConfig) => {
      setSaving(true);
      setError(null);
      try {
        const saved = await api.saveBoardReview(projectId, next);
        setConfig(isConfig(saved) ? saved : await api.boardReview(projectId));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [projectId],
  );

  return { config, missing, error, saving, save };
}

/** O funcionário que passa a ser o responsável ao ligar: o que já estava gravado (se ainda é do projeto) ou o primeiro da hierarquia. */
export function reviewerToTurnOn(config: BoardConfig, staff: Pick<StaffProfile, 'id'>[]): string | null {
  return staff.some((s) => s.id === config.reviewerId) ? config.reviewerId : (staff[0]?.id ?? null);
}

interface Props {
  review: BoardReviewState;
  /** Funcionários do projeto, na ordem da hierarquia. */
  staff: StaffProfile[];
}

export function BoardReview({ review, staff }: Props) {
  const { config, missing, error, saving, save } = review;
  const labelId = useId();
  if (missing || (!config && !error)) return null;
  const on = !!config?.autoReview;
  const reviewerId = config?.reviewerId ?? null;
  const known = staff.some((s) => s.id === reviewerId);
  const name = staff.find((s) => s.id === reviewerId)?.name ?? reviewerId ?? '';
  return (
    <details className="collapse board-review">
      <summary>
        <ReviewIcon /> {on ? t('tasks.boardReviewSummaryOn', { name }) : t('tasks.boardReviewSummaryOff')}
      </summary>
      {config && (
        <div className="board-review-body">
          <div className="board-review-row">
            <span id={labelId}>{t('tasks.autoReview')}</span>
            <button
              type="button"
              className="btn-secondary btn-toggle"
              aria-pressed={on}
              aria-labelledby={labelId}
              disabled={saving || (!on && !staff.length)}
              title={!on && !staff.length ? t('tasks.boardReviewNobody') : undefined}
              onClick={() => void save({ autoReview: !on, reviewerId: on ? reviewerId : reviewerToTurnOn(config, staff) })}
            >
              {on ? t('tasks.boardReviewOn') : t('tasks.boardReviewOff')}
            </button>
          </div>
          {on && (
            <label>
              {t('tasks.boardReviewWho')}
              <select value={reviewerId ?? ''} disabled={saving} onChange={(e) => void save({ autoReview: true, reviewerId: e.target.value })}>
                {/* Responsável que saiu do projeto: aparece como está, em vez de fingir que é o primeiro da lista. */}
                {!known && reviewerId && <option value={reviewerId}>{reviewerId}</option>}
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.role}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="muted small">{t('tasks.boardReviewRule')}</p>
          {!staff.length && <p className="muted small">{t('tasks.boardReviewNobody')}</p>}
        </div>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
