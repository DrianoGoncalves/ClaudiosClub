import type { CodexEffort, Engine, StaffProfile, TaskFallback } from '../../../shared/model';
import type { MsgKey } from '../i18n';
import { CODEX_EFFORTS, effortsOfModel, type CodexCatalog } from './codexEngine';

// Motor secundário da ficha (quando o principal bate o limite de uso): o que a tela mostra e manda. Lógica pura (testada em
// tests/fallbackEngine.test.ts); as regras que valem de verdade são as do servidor (`fallbackError`, server/staff/store.ts).

type Fallback = NonNullable<StaffProfile['fallback']>;

/** O que o formulário guarda do secundário: ligado ou não, e os campos (o motor não entra: é sempre o outro). */
export interface FallbackDraft {
  on: boolean;
  model: string;
  effort: '' | CodexEffort;
}

export const draftOf = (saved: Fallback | undefined): FallbackDraft => ({ on: !!saved, model: saved?.model ?? '', effort: saved?.effort ?? '' });

/** O secundário nunca é o mesmo motor do principal (o servidor recusa): só há um outro. */
export const otherEngine = (main: Engine): Engine => (main === 'claude' ? 'codex' : 'claude');

/** Mesma regra do modelo da ficha no servidor (`ModelSchema`): o nome vai para a linha de comando do motor. */
export const FALLBACK_MODEL = /^[\w.[\]-]{1,60}$/;

/**
 * O campo aparece quando dá para usar: com o Codex como principal (o secundário é o Claude, sempre disponível), com o Codex ligado
 * nas configurações, ou quando a ficha já tem um secundário (para dar para tirar).
 */
export function showFallbackField(codexReview: boolean | null | undefined, main: Engine, saved: boolean): boolean {
  return main === 'codex' || codexReview === true || saved;
}

/** Os esforços do secundário: os do motor (o `ultra` só existe no Codex); com o modelo no catálogo da conta, só os que ele aceita. */
export function fallbackEfforts(engine: Engine, model: string, catalog: CodexCatalog | null): CodexEffort[] {
  if (engine === 'claude') return CODEX_EFFORTS.filter((e) => e !== 'ultra');
  return catalog?.some((m) => m.slug === model) ? effortsOfModel(catalog, model) : [...CODEX_EFFORTS];
}

/** Trocou o modelo: o esforço fica se o motor aceita neste modelo; senão limpa. */
export const keepFallbackEffort = (effort: '' | CodexEffort, allowed: readonly CodexEffort[]): '' | CodexEffort =>
  effort && allowed.includes(effort) ? effort : '';

/**
 * O pedido: ligado manda o secundário; desligado tira o que a ficha tinha (`null`); desligado sem nada salvo, ou com o campo
 * escondido, não manda a chave (o servidor mantém o que está).
 */
export function fallbackToSend(draft: FallbackDraft, main: Engine, saved: boolean, shown: boolean): { fallback?: Fallback | null } {
  if (!shown) return {};
  if (!draft.on) return saved ? { fallback: null } : {};
  return { fallback: { engine: otherEngine(main), model: draft.model.trim(), ...(draft.effort && { effort: draft.effort }) } };
}

/** O que está errado antes de mandar (a chave da mensagem), ou null. O servidor confere de novo. */
export function fallbackProblem(draft: FallbackDraft): MsgKey | null {
  if (!draft.on) return null;
  const model = draft.model.trim();
  if (!model) return 'staff.errFallbackModel';
  return FALLBACK_MODEL.test(model) ? null : 'staff.errFallbackModelBad';
}

/** As chaves dos textos de ajuda: a regra comum e a do motor em que o secundário roda. */
export function fallbackHelpKeys(main: Engine): MsgKey[] {
  return main === 'codex' ? ['staff.fallbackHelp', 'staff.fallbackClaudeNote'] : ['staff.fallbackHelp', 'staff.fallbackCodexNote'];
}

/** O nome do motor na tela (o Codex é o GPT da OpenAI). */
export const engineName = (e: Engine): MsgKey => (e === 'claude' ? 'staff.engineClaude' : 'staff.engineCodex');

/** Por que a tarefa foi para o secundário (a chave do tooltip). */
export const fallbackReasonKey = (reason: TaskFallback['reason']): MsgKey => (reason === 'limit-start' ? 'tasks.fallbackLimitStart' : 'tasks.fallbackLimitMid');
