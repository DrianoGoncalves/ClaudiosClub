import type { TurnCapHit } from '../../shared/model';
import { maskSecretQuery } from './secrets';

// Teto por turno: um turno de conversa que passa de N ferramentas ou de M minutos é interrompido (como o botão Parar) e o
// dono é avisado (ver process.ts e codexProcess.ts). Aqui só a conta: sem processo e sem relógio próprio (o relógio entra
// de fora, e os testes o trocam). Ferramenta conta uma vez por id, mesmo que o evento chegue de novo. O tempo parado
// esperando sua permissão ou resposta não conta.

export interface TurnCaps {
  /** Ferramentas por turno; 0 = sem teto. */
  maxTools: number;
  /** Minutos por turno; 0 = sem teto. */
  maxMinutes: number;
}

export class TurnBudget {
  private ids = new Set<string>();
  private startedAt: number | null = null;
  private pausedMs = 0;
  private pausedAt: number | null = null;
  private caps: TurnCaps | null = null;
  private fired = false;

  /** Há turno sendo contado agora. */
  get active(): boolean {
    return this.startedAt !== null;
  }

  /** Começa a contar do zero. Se já há turno contado, não faz nada (a mensagem que entra na fila segue o mesmo turno). */
  begin(now: number): void {
    if (this.startedAt !== null) return;
    this.startedAt = now;
    this.ids.clear();
    this.pausedMs = 0;
    this.pausedAt = null;
    this.fired = false;
  }

  /** O turno acabou: para de contar. */
  end(): void {
    this.startedAt = null;
    this.ids.clear();
    this.pausedMs = 0;
    this.pausedAt = null;
  }

  /** Os tetos de agora (lidos da configuração a cada turno). */
  setCaps(caps: TurnCaps): void {
    this.caps = caps;
  }

  /** Conta uma ferramenta do turno (o id dedupa). */
  countTool(id: string): void {
    if (this.startedAt !== null) this.ids.add(id);
  }

  /** Pausa enquanto há pedido seu pendente (permissão ou pergunta); volta a contar quando não há mais. */
  setPaused(paused: boolean, now: number): void {
    if (this.startedAt === null) return;
    if (paused && this.pausedAt === null) this.pausedAt = now;
    else if (!paused && this.pausedAt !== null) {
      this.pausedMs += now - this.pausedAt;
      this.pausedAt = null;
    }
  }

  /** Tempo contado do turno (sem a pausa), em ms. */
  elapsedMs(now: number): number {
    if (this.startedAt === null) return 0;
    const paused = this.pausedMs + (this.pausedAt === null ? 0 : now - this.pausedAt);
    return Math.max(0, now - this.startedAt - paused);
  }

  /** Estourou algum teto? Devolve o teto uma vez só por turno (depois disso, null). */
  check(now: number): TurnCapHit | null {
    if (this.startedAt === null || this.fired || !this.caps) return null;
    const { maxTools, maxMinutes } = this.caps;
    if (maxTools > 0 && this.ids.size > maxTools) return this.hit({ kind: 'tools', limit: maxTools });
    if (maxMinutes > 0 && this.elapsedMs(now) > maxMinutes * 60_000) return this.hit({ kind: 'minutes', limit: maxMinutes });
    return null;
  }

  private hit(h: TurnCapHit): TurnCapHit {
    this.fired = true;
    return h;
  }
}

const ENGINE_NAME = { claude: 'Claude', codex: 'Codex' } as const;
/** Como o dono entra de novo no motor: o comando do CLI dele. */
const LOGIN_HINT = { claude: 'rode `claude` no terminal e use /login', codex: 'rode `codex login` no terminal' } as const;

/**
 * A parada é presumida (lida do transcript: a última ação ficou sem resultado) e não um fato do motor ou do teto? "Parou no meio de…" depois do reinício (`restart`) ou da queda (`retry` com
 * `why: 'cut'`). Um turno que termina normal depois dela a desmente.
 */
export const presumedStop = (hit: TurnCapHit | null | undefined): boolean => hit?.kind === 'restart' || (hit?.kind === 'retry' && hit.why === 'cut');

/** O aviso do teto (ou do corte pelo reinício, ou do erro do motor), no chat e na caixa de entrada. */
export function capText(hit: TurnCapHit): string {
  if (hit.kind === 'engine') {
    return hit.why === 'auth'
      ? `Erro de autenticação do ${ENGINE_NAME[hit.engine]} (${hit.error}): o turno não foi entregue. Entre de novo (${LOGIN_HINT[hit.engine]}) e mande mensagem para seguir`
      : `O ${ENGINE_NAME[hit.engine]} terminou o turno com erro (${hit.error}): o turno não foi entregue. Mande mensagem para seguir`;
  }
  if (hit.kind === 'restart') return `Não retomada: a conversa parou no meio de "${maskSecretQuery(hit.action)}". Confira se aconteceu e mande mensagem para seguir`;
  if (hit.kind === 'retry') {
    return hit.why === 'cut'
      ? `Não retomada sozinha (${hit.error}): a conversa parou no meio de "${maskSecretQuery(hit.action)}". Confira se aconteceu e mande mensagem para seguir`
      : `A conversa caiu (${hit.error}) e não voltou depois de ${hit.attempts} ${hit.attempts === 1 ? 'tentativa' : 'tentativas'} automáticas. Mande mensagem para seguir`;
  }
  return `Turno parado: passou de ${hit.limit} ${hit.kind === 'tools' ? 'ferramentas' : 'minutos'} (limite em Configurações)`;
}

/** O motivo curto, na tarefa que vai para Aguardar. */
export function capReason(hit: TurnCapHit): string {
  if (hit.kind === 'engine') {
    return hit.why === 'auth'
      ? `erro de autenticação do ${ENGINE_NAME[hit.engine]} (${hit.error}): sem entrega; o dono precisa entrar de novo no ${ENGINE_NAME[hit.engine]}`
      : `o ${ENGINE_NAME[hit.engine]} terminou o turno com erro (${hit.error}): sem entrega`;
  }
  if (hit.kind === 'restart') return `a conversa parou no meio de "${maskSecretQuery(hit.action)}": confira se aconteceu antes de retomar`;
  if (hit.kind === 'retry') {
    return hit.why === 'cut'
      ? `a conversa caiu (${hit.error}) no meio de "${maskSecretQuery(hit.action)}": confira se aconteceu antes de retomar`
      : `a conversa caiu (${hit.error}) e não voltou depois de ${hit.attempts} ${hit.attempts === 1 ? 'tentativa' : 'tentativas'} automáticas`;
  }
  return `turno parado: passou de ${hit.limit} ${hit.kind === 'tools' ? 'ferramentas' : 'minutos'}`;
}
