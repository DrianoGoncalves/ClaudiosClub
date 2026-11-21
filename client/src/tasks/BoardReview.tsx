import { useCallback, useEffect, useId, useState } from 'react';
import type { BoardCommitConfig, BoardConfig, BoardWriterConfig, StaffProfile } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';
import { ReviewIcon } from '../icons';

// Revisão automática do quadro (`<projeto>/.myco/board.json`): liga/desliga e o funcionário responsável. Quem revisa cada tarefa
// está em reviewRule.ts; a opção por tarefa (formulário e detalhe) continua valendo e tem prioridade sobre esta.
// Ao lado dela, o commit automático (a chave `autoCommit` do mesmo arquivo): um commit LOCAL por tarefa que fica pronta, nunca push.

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

export interface BoardCommitState {
  /** null = ainda lendo, falhou ou o servidor não tem a rota. */
  config: BoardCommitConfig | null;
  error: string | null;
  saving: boolean;
  save: (autoCommit: boolean) => Promise<void>;
}

const isCommitConfig = (x: unknown): x is BoardCommitConfig => typeof x === 'object' && x !== null && typeof (x as BoardCommitConfig).autoCommit === 'boolean';

/** Lê o commit automático do projeto e grava o que o servidor devolve. Servidor sem a rota (404): o controle some, como as outras opções que um servidor velho não conhece. */
export function useBoardCommit(projectId: string): BoardCommitState {
  const [config, setConfig] = useState<BoardCommitConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setConfig(null);
    setError(null);
    api.boardCommit(projectId).then(
      (c) => live && isCommitConfig(c) && setConfig(c),
      (e: Error) => live && !/: 404$/.test(e.message) && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [projectId]);

  const save = useCallback(
    async (autoCommit: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const saved = await api.saveBoardCommit(projectId, { autoCommit });
        setConfig(isCommitConfig(saved) ? saved : await api.boardCommit(projectId));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [projectId],
  );

  return { config, error, saving, save };
}

export interface BoardWriterState {
  /** null = ainda lendo, falhou ou o servidor não tem a rota. */
  config: BoardWriterConfig | null;
  error: string | null;
  saving: boolean;
  save: (singleWriter: boolean) => Promise<void>;
}

const isWriterConfig = (x: unknown): x is BoardWriterConfig => typeof x === 'object' && x !== null && typeof (x as BoardWriterConfig).singleWriter === 'boolean';

/** Lê "um card escrevendo por vez" (a vaga de escrita do projeto) e grava o que o servidor devolve. Servidor sem a rota (404): o controle some. */
export function useBoardWriter(projectId: string): BoardWriterState {
  const [config, setConfig] = useState<BoardWriterConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setConfig(null);
    setError(null);
    api.boardWriter(projectId).then(
      (c) => live && isWriterConfig(c) && setConfig(c),
      (e: Error) => live && !/: 404$/.test(e.message) && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [projectId]);

  const save = useCallback(
    async (singleWriter: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const saved = await api.saveBoardWriter(projectId, { singleWriter });
        setConfig(isWriterConfig(saved) ? saved : await api.boardWriter(projectId));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [projectId],
  );

  return { config, error, saving, save };
}

/** O funcionário que passa a ser o responsável ao ligar: o que já estava gravado (se ainda é do projeto) ou o primeiro da hierarquia. */
export function reviewerToTurnOn(config: BoardConfig, staff: Pick<StaffProfile, 'id'>[]): string | null {
  return staff.some((s) => s.id === config.reviewerId) ? config.reviewerId : (staff[0]?.id ?? null);
}

interface Props {
  review: BoardReviewState;
  /** O commit automático; sem ele (ou sem `config`: lendo, ou servidor sem a rota) o controle não aparece. */
  commit?: BoardCommitState;
  /** "Um card escrevendo por vez", junto do commit automático; mesma regra: sem `config` o controle não aparece. */
  writer?: BoardWriterState;
  /** Funcionários do projeto, na ordem da hierarquia. */
  staff: StaffProfile[];
}

export function BoardReview({ review, commit, writer, staff }: Props) {
  const { config, missing, error, saving, save } = review;
  const labelId = useId();
  const commitLabelId = useId();
  const writerLabelId = useId();
  if (missing || (!config && !error)) return null;
  const on = !!config?.autoReview;
  const reviewerId = config?.reviewerId ?? null;
  const known = staff.some((s) => s.id === reviewerId);
  const name = staff.find((s) => s.id === reviewerId)?.name ?? reviewerId ?? '';
  const commitOn = !!commit?.config?.autoCommit;
  const writerOn = !!writer?.config?.singleWriter;
  return (
    <details className="collapse board-review">
      <summary>
        <ReviewIcon /> {on ? t('tasks.boardReviewSummaryOn', { name }) : t('tasks.boardReviewSummaryOff')}
        {commitOn && ` · ${t('tasks.boardCommitSummaryOn')}`}
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
          {commit?.config && (
            <>
              <div className="board-review-row board-commit-row">
                <span id={commitLabelId}>{t('tasks.boardCommit')}</span>
                <button
                  type="button"
                  className="btn-secondary btn-toggle"
                  aria-pressed={commitOn}
                  aria-labelledby={commitLabelId}
                  disabled={commit.saving}
                  onClick={() => void commit.save(!commitOn)}
                >
                  {commitOn ? t('tasks.boardReviewOn') : t('tasks.boardReviewOff')}
                </button>
              </div>
              <p className="muted small">{t('tasks.boardCommitRule')}</p>
            </>
          )}
          {writer?.config && (
            <>
              <div className="board-review-row board-commit-row">
                <span id={writerLabelId}>{t('tasks.boardWriter')}</span>
                <button
                  type="button"
                  className="btn-secondary btn-toggle"
                  aria-pressed={writerOn}
                  aria-labelledby={writerLabelId}
                  disabled={writer.saving}
                  onClick={() => void writer.save(!writerOn)}
                >
                  {writerOn ? t('tasks.boardReviewOn') : t('tasks.boardReviewOff')}
                </button>
              </div>
              <p className="muted small">{t('tasks.boardWriterRule')}</p>
            </>
          )}
        </div>
      )}
      {(error || commit?.error || writer?.error) && (
        <p className="error small" role="alert">
          {error ?? commit?.error ?? writer?.error}
        </p>
      )}
    </details>
  );
}
