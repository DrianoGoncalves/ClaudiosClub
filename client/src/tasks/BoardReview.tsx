import { useCallback, useEffect, useId, useState } from 'react';
import type { BoardCommitConfig, BoardConfig, BoardWriterConfig, FlowGates, FlowPolicy, StaffProfile } from '../../../shared/model';
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
  /** true quando o servidor gravou (false: o erro está em `error`). */
  save: (next: BoardConfig) => Promise<boolean>;
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
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
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

export interface FlowCompletionState {
  /** A política lida do servidor; null = ainda lendo, falhou ou o servidor não tem a rota. */
  policy: FlowPolicy | null;
  error: string | null;
  saving: boolean;
  save: (completion: FlowGates['completion']) => Promise<void>;
}

const isPolicy = (x: unknown): x is FlowPolicy =>
  typeof x === 'object' && x !== null && ((x as FlowPolicy).completion === 'ai' || (x as FlowPolicy).completion === 'owner') && typeof (x as FlowPolicy).completionChosen === 'boolean';

/** Lê a política de fluxo e grava só o portão da conclusão (`{ completion }`). Sem estado otimista: a tela mostra o que o servidor devolveu; se a gravação falha, relê o GET para mostrar o estado real. */
export function useFlowCompletion(projectId: string): FlowCompletionState {
  const [policy, setPolicy] = useState<FlowPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setPolicy(null);
    setError(null);
    api.flowPolicy(projectId).then(
      (p) => live && isPolicy(p) && setPolicy(p),
      (e: Error) => live && !/: 404$/.test(e.message) && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [projectId]);

  const save = useCallback(
    async (completion: FlowGates['completion']) => {
      setSaving(true);
      setError(null);
      try {
        const saved = await api.setFlowCompletion(projectId, completion);
        setPolicy(isPolicy(saved) ? saved : await api.flowPolicy(projectId));
      } catch (e) {
        setError((e as Error).message);
        await api.flowPolicy(projectId).then((p) => isPolicy(p) && setPolicy(p), () => undefined);
      } finally {
        setSaving(false);
      }
    },
    [projectId],
  );

  return { policy, error, saving, save };
}

/** "Ligado" só quando o servidor mescla de fato (`autoMergeOn`): política gravada pelo dono, conclusão 'ai' e escolhida. O 'ai' herdado do projeto antigo (padrão/legado) não mescla, então aparece desligado. */
export const completionIsOn = (policy: FlowPolicy | null): boolean => !!policy && policy.source === 'stored' && policy.completion === 'ai' && policy.completionChosen;

/** Ao ligar a revisão ou escolher o revisor, a conclusão automática vem marcada, mas só se o dono ainda não escolheu (uma escolha já gravada, inclusive "só eu", não é sobrescrita). */
export const completionDefaultOnReviewer = (policy: FlowPolicy | null): 'ai' | null => (policy && !policy.completionChosen ? 'ai' : null);

/** Grava a revisão do quadro e, ao ligá-la ou trocar o revisor, marca a conclusão automática (ver `completionDefaultOnReviewer`). Se a revisão não gravou, a política não é tocada. */
export async function saveWithCompletionDefault(saveReview: BoardReviewState['save'], flow: FlowCompletionState | undefined, next: BoardConfig): Promise<void> {
  const ok = await saveReview(next);
  const def = completionDefaultOnReviewer(flow?.policy ?? null);
  if (ok && next.autoReview && def && flow) await flow.save(def);
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
  /** A conclusão automática (portão `completion` da política de fluxo), junto do revisor; sem `policy` (lendo, ou servidor sem a rota) a linha não aparece. */
  flow?: FlowCompletionState;
  /** Funcionários do projeto, na ordem da hierarquia. */
  staff: StaffProfile[];
}

export function BoardReview({ review, commit, writer, flow, staff }: Props) {
  const { config, missing, error, saving, save: saveReview } = review;
  const labelId = useId();
  const flowLabelId = useId();
  const commitLabelId = useId();
  const writerLabelId = useId();
  if (missing || (!config && !error)) return null;
  const on = !!config?.autoReview;
  const reviewerId = config?.reviewerId ?? null;
  const known = staff.some((s) => s.id === reviewerId);
  const name = staff.find((s) => s.id === reviewerId)?.name ?? reviewerId ?? '';
  const commitOn = !!commit?.config?.autoCommit;
  const writerOn = !!writer?.config?.singleWriter;
  const policy = flow?.policy ?? null;
  const finishOn = completionIsOn(policy);
  const save = (next: BoardConfig) => saveWithCompletionDefault(saveReview, flow, next);
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
          {flow && (policy || flow.error) && (
            <>
              <div className="board-review-row board-commit-row">
                <span id={flowLabelId}>{t('tasks.flowCompletion')}</span>
                {policy && (
                  <button
                    type="button"
                    className="btn-secondary btn-toggle"
                    aria-pressed={finishOn}
                    aria-labelledby={flowLabelId}
                    disabled={flow.saving}
                    onClick={() => void flow.save(finishOn ? 'owner' : 'ai')}
                  >
                    {finishOn ? t('tasks.boardReviewOn') : t('tasks.boardReviewOff')}
                  </button>
                )}
              </div>
              {policy && (
                <>
                  <p className="muted small">{t(finishOn ? 'tasks.flowCompletionAi' : 'tasks.flowCompletionOwner')}</p>
                  {!on && <p className="muted small">{t('tasks.flowCompletionNoReviewer')}</p>}
                  {(policy.source !== 'stored' || !policy.completionChosen) && <p className="muted small">{t('tasks.flowCompletionDefault')}</p>}
                </>
              )}
            </>
          )}
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
      {(error || commit?.error || writer?.error || flow?.error) && (
        <p className="error small" role="alert">
          {error ?? commit?.error ?? writer?.error ?? flow?.error}
        </p>
      )}
    </details>
  );
}
