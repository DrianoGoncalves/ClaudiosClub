import type { Autonomy, Engine, EngineOverride, StaffProfile, Task, TaskFallback } from '../shared/model';
import type { LimitHit } from './chat/usageLimit';

// Troca de motor por tarefa: a ficha do funcionário tem um motor secundário (`fallback`), e a tarefa que bate no limite
// do motor principal passa a rodar nele, em conversa nova. Aqui só a decisão e o override, sem IO.

/** Reset mais perto que isto: a tarefa espera, a troca não compensa. */
export const FALLBACK_MIN_WAIT_MS = 15 * 60_000;

/**
 * O limite do motor secundário: `LimitHit` se está esgotado, null se não está, ou 'unknown' se não deu para ler
 * (sem leitura, não se sabe: não troca).
 */
export type OtherEngineReading = LimitHit | null | 'unknown';

export interface FallbackDecision {
  ok: boolean;
  /** Para o histórico e o log: por que troca, ou por que espera. */
  reason: string;
}

const wait = (reason: string): FallbackDecision => ({ ok: false, reason });

/**
 * A tarefa deve trocar para o motor secundário da ficha? Só se a ficha tem `fallback` (de outro motor), a tarefa ainda não
 * trocou, o reset do limite é longo (ou desconhecido) e o secundário não está no limite. Senão, espera como antes.
 */
export function shouldFallback(input: {
  task: Pick<Task, 'fallback'>;
  profile: Pick<StaffProfile, 'fallback'>;
  /** O motor principal, o que estourou o limite. */
  engine: Engine;
  hit: LimitHit;
  otherEngineHit: OtherEngineReading;
  now: number;
}): FallbackDecision {
  const { task, profile, engine, hit, otherEngineHit, now } = input;
  const secondary = profile.fallback;
  if (!secondary) return wait('a ficha não tem motor secundário');
  if (secondary.engine === engine) return wait('o motor secundário é o mesmo da ficha');
  if (task.fallback) return wait('a tarefa já trocou de motor: não troca de novo');
  if (hit.resetsAt !== null && hit.resetsAt - now <= FALLBACK_MIN_WAIT_MS) return wait('o limite volta em menos de 15 min: espera');
  if (otherEngineHit === 'unknown') return wait(`não sei se ${secondary.engine} está no limite (leitura indisponível): espera`);
  if (otherEngineHit) return wait(`${secondary.engine} também está no limite`);
  return { ok: true, reason: `${engine} no limite; troca para ${secondary.engine}` };
}

export const ENGINE_LABEL: Record<Engine, string> = { claude: 'Claude', codex: 'Codex' };

/** O modo do Claude Code de volta para a autonomia da ficha (o inverso de `CLI_MODE` no manager). Modo desconhecido = undefined. */
const AUTONOMY_OF_MODE = new Map<string, Autonomy>([
  ['plan', 'plan'],
  ['default', 'manual'],
  ['acceptEdits', 'acceptEdits'],
  ['auto', 'auto'],
  ['bypassPermissions', 'bypassPermissions'],
]);
export const autonomyOfMode = (mode: string | null | undefined): Autonomy | undefined => (mode ? AUTONOMY_OF_MODE.get(mode) : undefined);

/** Quanto a autonomia deixa o Claude agir sem perguntar. `plan` e `acceptEdits` estão no mesmo degrau. */
const RANK: Record<Autonomy, number> = { manual: 0, plan: 1, acceptEdits: 1, auto: 2, bypassPermissions: 3 };

/** O menor dos dois: a autonomia da conversa nunca passa do teto (a da ficha). Empate (plan/acceptEdits): o candidato. */
export const atMostAutonomy = (candidate: Autonomy, ceiling: Autonomy): Autonomy => (RANK[candidate] <= RANK[ceiling] ? candidate : ceiling);

/**
 * O modo que a tarefa executa depois do plano aprovado: a ficha de plano executa em "aceitar edições", as outras no próprio
 * modo. É o mesmo mapeamento do "Aprovar e executar" do cartão de plano (client/src/chat/ChatView.tsx).
 */
export const executeAutonomyOf = (ficha: Autonomy): Autonomy => (ficha === 'plan' ? 'acceptEdits' : ficha);

/** O outro motor (o secundário, para quem está no principal). */
export const otherEngine = (e: Engine): Engine => (e === 'claude' ? 'codex' : 'claude');

/** Hora de volta do limite, como aparece no texto (HH:MM); sem hora, '' (quem chama decide a frase). */
export function atHour(resetsAt: number | null): string {
  return resetsAt === null ? '' : new Date(resetsAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** O override com que a conversa da tarefa roda depois da troca (o secundário da ficha, ou o da tarefa já trocada). */
export function overrideOfFallback(f: EngineOverride): EngineOverride {
  return { engine: f.engine, model: f.model, ...(f.effort && { effort: f.effort }) };
}
