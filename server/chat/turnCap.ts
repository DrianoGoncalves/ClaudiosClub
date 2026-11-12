import type { TurnCapHit } from '../../shared/model';

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

/** O aviso do teto, no chat e na caixa de entrada. */
export function capText(hit: TurnCapHit): string {
  return `Turno parado: passou de ${hit.limit} ${hit.kind === 'tools' ? 'ferramentas' : 'minutos'} (limite em Configurações)`;
}
