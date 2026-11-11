import path from 'node:path';
import type { ChatAttachment, ChatSnapshot, Engine, EngineOverride, SendPriority, StaffProfile, UsageStopHit } from '../shared/model';
import type { LimitHit } from './chat/usageLimit';
import { buildChatHandoff, oldConversationExtract, type GitSnapshot } from './fallbackHandoff';
import { atHour, ENGINE_LABEL, limitOfStop, limitReading, overrideOfFallback, shouldFallback } from './taskFallback';
import { UsageStopError } from './usageStop';

// Conversa direta no limite de uso: o dono escreve para um funcionário fora de tarefa, pela tela, e a linha de parada 5h/7d (ou o
// orçamento) barra. Se a ficha tem secundário e a janela é o motivo, a mensagem vai para uma conversa NOVA no secundário, com um
// handoff da antiga (que fica como está). É a troca de tarefa (taskFallback.ts) sem a tarefa. Aqui só a decisão e o envio; a rota
// (server/index.ts) chama e devolve.

/** Para a tela abrir a conversa nova: de qual veio (null se não havia conversa) e o motor/modelo dela. */
export interface DirectFallbackInfo {
  movedFrom: string | null;
  engine: Engine;
  model: string;
}

export interface DirectSent {
  sessionId: string;
  fallback: DirectFallbackInfo;
}

/**
 * Pode trocar de motor este envio? Só o dono, pela tela (`fromBrowser`), sem `force` (com ele, o dono já escolheu passar da trava),
 * para um funcionário, numa conversa que ainda não roda no secundário e não é de tarefa. A API (funcionário, gestor) nunca troca.
 */
export function ownerMaySwitch(c: {
  fromBrowser: boolean;
  force: boolean;
  staffId: string | null;
  onFallback: boolean;
  taskConversation: boolean;
}): boolean {
  return c.fromBrowser && !c.force && !!c.staffId && !c.onFallback && !c.taskConversation;
}

export interface DirectFallbackDeps {
  readProfile(projectId: string, staffId: string): Promise<StaffProfile | null>;
  /** O limite do provedor (100%) do motor agora; 'unknown' se não deu para ler (não troca às cegas). */
  readLimit(engine: Engine): Promise<LimitHit | null | 'unknown'>;
  /** A linha de parada 5h/7d do motor para este funcionário (null = sem trava). Erro = 'unknown' (ver `usageStopHit`). */
  stopHit(projectId: string, staffId: string, engine: Engine): Promise<UsageStopHit | null>;
  /** As barreiras do envio no motor `override`, sem gravar nada (ver StaffService.assertOverrideRunnable). Lança o erro que a conversa daria. */
  assertRunnable(projectId: string, staffId: string, override: EngineOverride): Promise<void>;
  snapshot(projectId: string, sessionId: string): Promise<Pick<ChatSnapshot, 'history' | 'live'> | null>;
  git(projectId: string, staffId: string): Promise<GitSnapshot | null>;
  /** Tira o "continue" agendado da conversa antiga (motivo 'fallback', como na tarefa). Só depois que a conversa nova abriu. */
  cancelContinue(sessionId: string): Promise<void>;
  /** Manda a mensagem (sessionId null = conversa nova, com o motor `override`); devolve a sessão. */
  send(
    projectId: string,
    sessionId: string | null,
    staffId: string,
    text: string,
    priority: SendPriority | undefined,
    images: string[],
    files: ChatAttachment[],
    override?: EngineOverride,
  ): Promise<string>;
  log(line: string): void;
}

/** Quantas trocas guardar para o envio repetido (a tela ainda não trocou de conversa). Passou disso, sai a mais antiga. */
const MAX_MOVED = 200;

export class DirectFallback {
  /** Conversa antiga → a troca feita. O 2º envio seguido da tela, ainda na antiga, vai para a conversa nova (sem trocar de novo). */
  private readonly moved = new Map<string, DirectSent>();
  /** Fila por funcionário: uma troca (e um envio) por vez, para dois envios rápidos não abrirem duas conversas novas. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: DirectFallbackDeps) {}

  /**
   * O envio do dono foi barrado pela trava de consumo (`barred`). Se a ficha tem secundário e a janela 5h/7d é o motivo, abre
   * uma conversa nova no secundário com o handoff e a mensagem, e devolve o envio. Senão (o orçamento do projeto, sem secundário,
   * o secundário também no limite, a pré-checagem não abre, a conversa nova falha), lança `barred`: o erro de antes, sem nada
   * enviado. A conversa antiga não é tocada (só lida).
   */
  switchOnLimit(input: {
    projectId: string;
    sessionId: string | null;
    staffId: string;
    text: string;
    priority?: SendPriority;
    images: string[];
    files: ChatAttachment[];
    barred: UsageStopError;
  }): Promise<DirectSent> {
    return this.locked(`${input.projectId}:${input.staffId}`, () => this.decide(input));
  }

  private async decide(i: Parameters<DirectFallback['switchOnLimit']>[0]): Promise<DirectSent> {
    const { projectId, sessionId, staffId, barred } = i;
    // O orçamento do projeto continua barrando: não é janela do motor.
    if (barred.hit.kind === 'project_week') throw barred;
    // Segundo envio seguido, ainda na conversa antiga: vai para a nova, sem trocar de novo. Antes, a linha de parada do secundário.
    const again = sessionId ? this.moved.get(sessionId) : undefined;
    if (again) {
      const stop = await this.deps.stopHit(projectId, staffId, again.fallback.engine);
      if (stop) throw new UsageStopError(stop);
      const sent = await this.deps.send(projectId, again.sessionId, staffId, i.text, i.priority, i.images, i.files);
      return { sessionId: sent, fallback: again.fallback };
    }
    const profile = await this.deps.readProfile(projectId, staffId);
    const secondary = profile?.fallback;
    if (!profile || !secondary) throw barred; // sem secundário: barra como antes
    const engine: Engine = profile.engine ?? 'claude';
    if (secondary.engine === engine) throw barred;
    // A janela do motor principal: o provedor (100%) ou a linha de parada 5h/7d, a que vale. O orçamento já ficou de fora.
    const provider = await this.readLimitOf(engine);
    const hit = limitReading(provider, limitOfStop(barred.hit));
    if (hit === null || hit === 'unknown') throw barred;
    const otherHit = limitReading(await this.readLimitOf(secondary.engine), await this.stopLimitOf(projectId, staffId, secondary.engine));
    const decision = shouldFallback({ task: null, profile, engine, hit, otherEngineHit: otherHit, now: Date.now() });
    if (!decision.ok) {
      this.deps.log(`${staffId}: envio barrado, sem troca (${decision.reason})`);
      throw barred;
    }
    const override = overrideOfFallback(secondary);
    try {
      await this.deps.assertRunnable(projectId, staffId, override);
    } catch (err) {
      this.deps.log(`${staffId}: troca para ${ENGINE_LABEL[secondary.engine]} não abre (${(err as Error).message}); envio barrado`);
      throw barred;
    }
    // O que a conversa antiga leva (só lida): as mensagens do dono (a 1ª também: aqui não há pedido inicial) e a última resposta.
    const snap = sessionId ? await this.deps.snapshot(projectId, sessionId).catch(() => null) : null;
    const old = snap ? oldConversationExtract(snap, { skipRequest: false }) : undefined;
    const porStop = provider === null || provider === 'unknown';
    const volta = atHour(hit.resetsAt);
    const quando = volta ? (porStop ? ` (volta às ${volta})` : ` até ${volta}`) : '';
    const text = buildChatHandoff({
      reason: `o motor ${ENGINE_LABEL[engine]} ${porStop ? 'passou da linha de parada' : 'está no limite'}${quando}`,
      to: { engine: secondary.engine, model: secondary.model },
      old: old ? { userMessages: old.userMessages, lastAssistantText: old.lastAssistantText } : undefined,
      git: await this.deps.git(projectId, staffId).catch(() => null),
      memoryPath: path.posix.join('.myco', 'staff', `${profile.id}.memory.md`),
      message: i.text,
    });
    let created: string;
    try {
      created = await this.deps.send(projectId, null, staffId, text, i.priority, i.images, i.files, override);
    } catch (err) {
      // Nada foi enviado à antiga. O erro que volta é o de limite de antes; o motivo da falha fica no log.
      this.deps.log(`${staffId}: a conversa nova no ${ENGINE_LABEL[secondary.engine]} não abriu (${(err as Error).message}); envio barrado`);
      throw barred;
    }
    const sent: DirectSent = { sessionId: created, fallback: { movedFrom: sessionId, engine: secondary.engine, model: secondary.model } };
    if (sessionId) {
      this.remember(sessionId, sent);
      // A antiga não volta sozinha: o "continue" dela sai só agora, com a nova no ar (se a nova falhasse, ele ficaria valendo).
      await this.deps.cancelContinue(sessionId).catch((err) => this.deps.log(`${sessionId}: continue não cancelado (${(err as Error).message})`));
    }
    this.deps.log(`${sessionId ?? 'conversa nova'}: ${decision.reason}; a mensagem seguiu em ${created}`);
    return sent;
  }

  private remember(sessionId: string, sent: DirectSent): void {
    this.moved.set(sessionId, sent);
    if (this.moved.size > MAX_MOVED) this.moved.delete(this.moved.keys().next().value!);
  }

  /** O limite do provedor, com erro = 'unknown' (a leitura de cada motor não derruba o envio). */
  private readLimitOf(engine: Engine): Promise<LimitHit | null | 'unknown'> {
    return this.deps.readLimit(engine).catch(() => 'unknown' as const);
  }

  /** A linha de parada 5h/7d do motor como limite (ver `limitOfStop`); erro = 'unknown'. */
  private async stopLimitOf(projectId: string, staffId: string, engine: Engine): Promise<LimitHit | null | 'unknown'> {
    const stop = await this.deps.stopHit(projectId, staffId, engine).catch(() => 'unknown' as const);
    return stop === 'unknown' ? 'unknown' : stop ? limitOfStop(stop) : null;
  }

  /** Um por vez por chave; o que falhar não trava a fila. */
  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }
}

/**
 * No boot: a conversa direta trocada (a entrada da sessão tem `fallback`) volta a rodar no secundário da ficha ATUAL, e só se o
 * motor ainda bater com o gravado. O modelo e o esforço vêm da ficha, não do arquivo. Conversa de tarefa fica com a tarefa
 * (ver `restoreFallbacks`, em server/tasks.ts). Devolve quantas conversas re-registrou.
 */
export async function restoreDirectFallbacks(deps: {
  listStaff: () => Promise<StaffProfile[]>;
  isTaskConversation: (sessionId: string) => Promise<boolean>;
  setOverride: (sessionId: string, override: EngineOverride) => void;
}): Promise<number> {
  let n = 0;
  for (const profile of await deps.listStaff()) {
    const secondary = profile.fallback;
    if (!secondary) continue;
    for (const s of profile.sessions) {
      if (s.fallback?.engine !== secondary.engine) continue;
      if (await deps.isTaskConversation(s.id)) continue;
      deps.setOverride(s.id, overrideOfFallback(secondary));
      n++;
    }
  }
  return n;
}
