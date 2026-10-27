import type { LiveSession } from '../shared/model';

// "Terminou": quando uma sessão passa de trabalhando para parada (o turno acabou), fica registrado
// aqui por um tempo, para o navegador avisar ("Giovana terminou"). Vale para as conversas do MyCo
// e para sessões no terminal ou no app do Claude: todas escrevem o status em ~/.claude/sessions.
// Ir para "esperando você" não conta: isso já é a caixa "precisa de mim".

export interface TurnDone {
  id: string;
  sessionId: string;
  at: string;
  /** Começo da última resposta, quando a conversa é do MyCo (as de fora não dão acesso ao texto). */
  text: string | null;
}

const KEEP = 50;

export class TurnWatcher {
  private readonly status = new Map<string, string | null>();
  private readonly done: TurnDone[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly listLive: () => Promise<LiveSession[]>,
    /** Última resposta de uma conversa aberta no MyCo (null se não for do MyCo). */
    private readonly lastText: (sessionId: string) => string | null,
    /** Avisado a cada turno que termina (as tarefas andam de "fazendo" para "revisão"). */
    private readonly onDone?: (sessionId: string) => void,
  ) {}

  start(intervalMs = 4000) {
    this.timer = setInterval(() => void this.tick().catch(() => {}), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<void> {
    const live = (await this.listLive()).filter((l) => l.alive);
    const seen = new Set<string>();
    for (const l of live) {
      seen.add(l.sessionId);
      const prev = this.status.get(l.sessionId);
      if (prev === 'busy' && l.status === 'idle') {
        this.done.push({ id: `${l.sessionId}:${now.getTime()}`, sessionId: l.sessionId, at: now.toISOString(), text: firstLine(this.lastText(l.sessionId)) });
        if (this.done.length > KEEP) this.done.splice(0, this.done.length - KEEP);
        this.onDone?.(l.sessionId);
      }
      this.status.set(l.sessionId, l.status);
    }
    for (const id of this.status.keys()) if (!seen.has(id)) this.status.delete(id);
  }

  /** Turnos que terminaram depois de `since` (ISO); sem `since`, nada (a página acabou de abrir). */
  since(since: string | null): TurnDone[] {
    return since ? this.done.filter((d) => d.at > since) : [];
  }
}

function firstLine(text: string | null): string | null {
  const line = text?.split(/\r?\n/).find((l) => l.trim())?.trim();
  if (!line) return null;
  const plain = line.replace(/[*_`#>]/g, '').trim();
  return plain.length > 140 ? `${plain.slice(0, 139)}…` : plain;
}
