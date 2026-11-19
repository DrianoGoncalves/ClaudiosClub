// O que as ações da tela de Agendamentos e da ficha fazem, sem React: ler o mês, salvar, ligar/desligar, apagar, rodar agora, cancelar um despertador e
// o que o Esc faz. A API entra por parâmetro (o teste passa uma falsa); cada função devolve o desfecho e quem chama o aplica ao estado da tela.
import type { RoutineSchedule, SchedulesResponse } from '../../../shared/model';
import { type api as realApi, isPairingError } from '../api';
import { t } from '../i18n';
import type { Tr } from '../inbox/secretText';
import { monthGrid } from './calendar';
import { type RoutineDraft, type RoutineInput, checkDraft } from './routineDraft';
import { type Schedule, scheduleKey } from './scheduleView';

export type FlowApi = Pick<typeof realApi, 'schedules' | 'saveRoutine' | 'setRoutineEnabled' | 'deleteRoutine' | 'runRoutine' | 'chatCancelWake' | 'chatCancelAutoContinue'>;

/** O desfecho de uma chamada: o valor, ou o texto do erro já pronto para a tela. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

type RoutineRef = Pick<RoutineSchedule, 'staffId' | 'routineId'>;

/**
 * O motivo de uma falha: o que o servidor disse; se vier vazio, um texto padrão. A recusa por pareamento vem sem texto de propósito (o aviso do App
 * a explica), mas esse aviso fica atrás desta tela cheia: aqui ela ganha o próprio texto.
 */
export function failureReason(e: unknown, tr: Tr = t): string {
  const message = e instanceof Error ? e.message.trim() : '';
  return message || tr(isPairingError(e) ? 'schedules.errPairing' : 'schedules.errUnknown');
}

const failed = (e: unknown, tr: Tr): { ok: false; error: string } => ({ ok: false, error: tr('schedules.actionFailed', { error: failureReason(e, tr) }) });

// ---- ler ----

/** A resposta do servidor com o que um servidor velho não manda (só `items`) preenchido. */
export function normalizeSchedules(r: Partial<SchedulesResponse> & { items?: Schedule[] }): SchedulesResponse {
  return {
    items: r.items ?? [],
    routines: r.routines ?? [],
    occurrences: r.occurrences ?? [],
    window: r.window ?? { from: '', to: '', truncated: false },
    stateWarning: r.stateWarning ?? null,
  };
}

/** Lê o mês `anchor`: pede ao servidor a janela [from, to) da grade desse mês (não a de hoje). O erro é só o motivo; a tela monta a frase. */
export async function readSchedules(api: FlowApi, projectId: string, anchor: Date, tr: Tr = t): Promise<Settled<SchedulesResponse>> {
  const { from, to } = monthGrid(anchor);
  try {
    return { ok: true, value: normalizeSchedules(await api.schedules(projectId, { from, to })) };
  } catch (e) {
    return { ok: false, error: failureReason(e, tr) };
  }
}

// ---- rotinas ----

export interface Saved {
  /** O que foi mandado ao servidor. */
  routine: RoutineInput;
  routineId: string;
  /** Rotina nova (e não edição). */
  created: boolean;
  /** Próxima execução (ISO), se a rotina tem. */
  next: string | null;
}

/** Confere o rascunho e grava a rotina. Rascunho torto volta o erro do formulário sem falar com o servidor. */
export async function saveDraft(api: FlowApi, projectId: string, draft: RoutineDraft, tr: Tr = t): Promise<Settled<Saved>> {
  const checked = checkDraft(draft);
  if (!checked.ok) return { ok: false, error: checked.error };
  try {
    const out = await api.saveRoutine(projectId, draft.staffId, checked.routine);
    return { ok: true, value: { routine: checked.routine, routineId: out.routine.routineId, created: !draft.id, next: out.routine.next ?? null } };
  } catch (e) {
    return failed(e, tr);
  }
}

/** Liga ou desliga; o valor é o estado novo. */
export async function enableRoutine(api: FlowApi, projectId: string, ref: RoutineRef, enabled: boolean, tr: Tr = t): Promise<Settled<boolean>> {
  try {
    await api.setRoutineEnabled(projectId, ref.staffId, ref.routineId, enabled);
    return { ok: true, value: enabled };
  } catch (e) {
    return failed(e, tr);
  }
}

export async function removeRoutine(api: FlowApi, projectId: string, ref: RoutineRef, tr: Tr = t): Promise<Settled<null>> {
  try {
    await api.deleteRoutine(projectId, ref.staffId, ref.routineId);
    return { ok: true, value: null };
  } catch (e) {
    return failed(e, tr);
  }
}

/** A frase do resultado do "Rodar agora" (`null` = a rotina não existe mais). */
export function runResultText(name: string, out: { ok: boolean; text: string } | null, tr: Tr = t): string {
  if (!out) return tr('detail.routineNotFound');
  return tr('detail.routineResult', { name, result: out.ok ? out.text : tr('detail.routineNotRun', { reason: out.text.replace(/^pulada: /, '') }) });
}

/** Roda agora; o valor é a frase do resultado. */
export async function runRoutineNow(api: FlowApi, projectId: string, ref: RoutineRef, name: string, tr: Tr = t): Promise<Settled<string>> {
  try {
    return { ok: true, value: runResultText(name, await api.runRoutine(projectId, ref.staffId, ref.routineId), tr) };
  } catch (e) {
    return failed(e, tr);
  }
}

// ---- despertadores e "continue" ----

/** `gone` = o agendamento já não existe (já aconteceu, ou outra aba o cancelou). */
export type CancelOutcome = { kind: 'cancelled' } | { kind: 'gone' } | { kind: 'failed'; error: string };

/** Cancela um despertador ou um "continue". `reload` relê a lista (devolve null se não deu). */
export async function cancelSchedule(api: FlowApi, projectId: string, s: Schedule, reload: () => Promise<SchedulesResponse | null>, tr: Tr = t): Promise<CancelOutcome> {
  try {
    const done = s.kind === 'wake' ? await api.chatCancelWake(projectId, s.sessionId) : await api.chatCancelAutoContinue(projectId, s.sessionId);
    return { kind: done.ok ? 'cancelled' : 'gone' };
  } catch (e) {
    // 404 e falha de rede chegam como o mesmo erro: relê a lista para saber se o agendamento ainda existe.
    const fresh = await reload();
    const key = scheduleKey(s);
    if (fresh && !fresh.items.some((i) => scheduleKey(i) === key)) return { kind: 'gone' };
    return { kind: 'failed', error: tr('schedules.cancelFailed', { error: failureReason(e, tr) }) };
  }
}

// ---- Esc ----

export type EscStep = 'close-confirm' | 'keep-editing' | 'ask-discard' | 'close-form' | 'close-screen';

/**
 * O que o Esc faz: fecha primeiro a pergunta que estiver aberta (cancelar/apagar/rodar), depois o formulário (se o rascunho mudou, pergunta antes
 * de descartar; Esc de novo, com a pergunta aberta, volta a editar) e por último a tela.
 */
export function escapeStep(s: { confirming: boolean; form: { dirty: boolean; asking: boolean } | null }): EscStep {
  if (s.confirming) return 'close-confirm';
  if (!s.form) return 'close-screen';
  if (s.form.asking) return 'keep-editing';
  return s.form.dirty ? 'ask-discard' : 'close-form';
}

/** O que o botão Cancelar do formulário faz: a mesma regra do Esc com o formulário aberto (rascunho mudado pergunta antes de descartar). */
export const cancelFormStep = (dirty: boolean): 'ask-discard' | 'close-form' => (dirty ? 'ask-discard' : 'close-form');
