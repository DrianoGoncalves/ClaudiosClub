import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { FLOW_PRESETS, type FlowGates, type FlowMode, type FlowPolicy, type Task, type TaskOwnerGate } from '../shared/model';
import { writeAtomic } from './atomicWrite';

// A política de fluxo do projeto (quanto do fluxo é automático: ver `FlowPolicy` e `FLOW_PRESETS` em shared/model.ts). Fica em `~/.myco/flow-policies.json`, da máquina e FORA do
// repositório, como a pausa de projeto (server/projectPause.ts): o `<projeto>/.myco/board.json` o agente consegue editar (as regras de negação de server/staff/ficha.ts cobrem os arquivos
// de `~/.myco`, não esse), e uma política que ele pudesse ampliar não seria política. Quem grava é só a rota `flow-policy` (que confere `fromBrowser`); o arquivo vai na lista de negação
// de escrita da ficha. Projeto sem entrada não é migrado em disco: `legacyPolicy` devolve o que ele já fazia (apagar o arquivo é o caminho de volta). Entrada inválida (ou arquivo estragado)
// vira a política mais restritiva, nunca o padrão legado: o que não dá para ler não amplia a automação.

/** O que vale quando não dá para ler a política: nada automático além do commit desligado, o dono decide tudo. */
export const RESTRICTIVE_GATES: FlowGates = { plan: 'owner', completion: 'owner', commit: false };

/** Projeto sem política gravada: o que ele já fazia (plano de quem pediu, conclusão pelo revisor, commit pelo `autoCommit` do board.json). Não gera alerta nem muda comportamento. */
export const legacyPolicy = (commit: boolean): FlowPolicy => ({ mode: 'custom', plan: 'owner', completion: 'ai', commit, source: 'default', completionChosen: false });

/**
 * A espera pela aprovação do dono que ainda vale: a tarefa está em "revisão" e na entrega a que a marca pertence (entrega nova a invalida). Só exibição (a nota e o item na caixa): quem
 * autoriza ir a "pronto" é a política lida de `~/.myco` e o pedido do dono, nunca esta marca (ver `TaskService.approve`).
 */
export function ownerGateOf(t: Task): TaskOwnerGate | undefined {
  return t.status === 'review' && t.ownerGate && t.ownerGate.deliveryAt === (t.delivery?.at ?? null) ? t.ownerGate : undefined;
}

const GatesShape = z.object({ plan: z.enum(['owner', 'ai']), completion: z.enum(['ai', 'owner']), commit: z.boolean() });

const Entry = GatesShape.extend({
  mode: z.enum(['auto', 'supervised', 'manual', 'custom']),
  completionChosen: z.boolean(),
  at: z.string().datetime(),
});

/** O que fica gravado por projeto. */
type Stored = z.infer<typeof Entry>;

/**
 * O corpo de `POST /api/projects/:id/flow-policy`: um preset (`mode`) OU um ou mais portões (`plan`, `completion`, `commit`), nunca os dois, e nenhum campo a mais. Mexer num portão grava
 * 'custom'; 'custom' não se pede (só vem de mexer num portão).
 */
export const FlowPolicyInput = z
  .object({
    mode: z.enum(['auto', 'supervised', 'manual'], { message: "mode: use 'auto', 'supervised' ou 'manual' ('custom' só vem de alterar um portão)" }).optional(),
    plan: z.enum(['owner', 'ai'], { message: "plan: use 'owner' ou 'ai'" }).optional(),
    completion: z.enum(['ai', 'owner'], { message: "completion: use 'ai' ou 'owner'" }).optional(),
    commit: z.boolean({ message: 'commit: use true ou false' }).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const gates = v.plan !== undefined || v.completion !== undefined || v.commit !== undefined;
    if (v.mode === undefined && !gates) ctx.addIssue({ code: 'custom', message: 'mande um preset (mode) ou um portão (plan, completion, commit)' });
    if (v.mode !== undefined && gates) ctx.addIssue({ code: 'custom', message: 'mande um preset (mode) ou os portões, não os dois' });
  });
export type FlowPolicyInput = z.infer<typeof FlowPolicyInput>;

/** A política como o resto do servidor e a tela a leem: sem a hora da gravação. */
const viewOf = ({ mode, plan, completion, commit, completionChosen }: Stored): FlowPolicy => ({ mode, plan, completion, commit, completionChosen, source: 'stored' });

const sameGates = (a: FlowGates, b: FlowGates): boolean => a.plan === b.plan && a.completion === b.completion && a.commit === b.commit;

/**
 * A política que sai de aplicar `input` sobre a vigente. Preset: os portões do preset, `completionChosen` ligado (o dono escolheu a conclusão ao escolher o preset). Portões: mesclam sobre
 * os vigentes e o modo vira 'custom' (se nada mudou de fato e o modo já era um preset, fica como está). `completionChosen` só liga quando a conclusão veio no corpo (um 'custom' que herdou
 * 'ai' do projeto antigo não conta como escolha do dono: ver o aviso "sem revisor" em TaskService).
 */
export function applyFlowInput(current: FlowPolicy, input: FlowPolicyInput): Omit<FlowPolicy, 'source'> {
  if (input.mode !== undefined) return { mode: input.mode, ...FLOW_PRESETS[input.mode], completionChosen: true };
  const gates: FlowGates = {
    plan: input.plan ?? current.plan,
    completion: input.completion ?? current.completion,
    commit: input.commit ?? current.commit,
  };
  const mode: FlowMode = current.source === 'stored' && current.mode !== 'custom' && sameGates(gates, current) ? current.mode : 'custom';
  return { mode, ...gates, completionChosen: current.completionChosen || input.completion !== undefined };
}

export class FlowPolicies {
  private loading: Promise<Map<string, Stored>> | null = null;
  private saving: Promise<void> = Promise.resolve();
  /** O arquivo estava estragado: projeto sem entrada não vira "padrão legado" (que amplia), vira restritivo, até esta máquina reiniciar com o arquivo refeito. */
  private corrupt = false;

  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void = (line) => console.warn(`[fluxo] ${line}`),
  ) {}

  /**
   * A política gravada do projeto; null = sem entrada (vale `legacyPolicy`). Nunca lança: arquivo que não dá para ler (permissão, disco) ou entrada inválida é a política restritiva, e a próxima
   * pergunta tenta ler de novo.
   */
  async get(projectId: string): Promise<FlowPolicy | null> {
    let map: Map<string, Stored>;
    try {
      map = await this.load();
    } catch (err) {
      this.log(`${this.file} ilegível (${err instanceof Error ? err.message : String(err)}): a política vigente é a restritiva`);
      return { mode: 'custom', ...RESTRICTIVE_GATES, source: 'stored', completionChosen: false };
    }
    const found = map.get(projectId);
    if (found) return viewOf(found);
    return this.corrupt ? { mode: 'custom', ...RESTRICTIVE_GATES, source: 'stored', completionChosen: false } : null;
  }

  /** Grava a política do projeto (a que `applyFlowInput` calculou). Grava antes de responder: se não gravou, não vale e o erro sobe. */
  async set(projectId: string, policy: Omit<FlowPolicy, 'source'>, now = new Date()): Promise<FlowPolicy> {
    const map = await this.load();
    const had = map.get(projectId);
    const entry: Stored = { mode: policy.mode, plan: policy.plan, completion: policy.completion, commit: policy.commit, completionChosen: policy.completionChosen, at: now.toISOString() };
    map.set(projectId, entry);
    try {
      await this.save(map);
    } catch (err) {
      if (had) map.set(projectId, had);
      else map.delete(projectId);
      throw err;
    }
    return viewOf(entry);
  }

  private load(): Promise<Map<string, Stored>> {
    this.loading ??= this.read().catch((err) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  /**
   * Arquivo ausente = nenhum projeto tem política (todos legados). Estragado: a cópia fica em `.bad`, o log conta e a política vira restritiva para quem não tem entrada. Entrada inválida: a
   * restritiva só para esse projeto (uma torta não leva as outras). Erro de leitura que não é "ausente" sobe (ver `get`).
   */
  private async read(): Promise<Map<string, Stored>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw err;
    }
    let list: unknown;
    try {
      list = (JSON.parse(raw.replace(/^﻿/, '')) as { projects?: unknown } | null)?.projects;
      if (!list || typeof list !== 'object' || Array.isArray(list)) throw new Error('falta o mapa "projects"');
    } catch (err) {
      const bad = `${this.file}.bad`;
      await fs.rename(this.file, bad).catch(() => {});
      this.corrupt = true;
      this.log(`${this.file} estragado (${err instanceof Error ? err.message : String(err)}); guardado em ${bad}: a política vigente é a restritiva, escolha o fluxo de novo`);
      return new Map();
    }
    const map = new Map<string, Stored>();
    for (const [id, value] of Object.entries(list as Record<string, unknown>)) {
      const e = Entry.safeParse(value);
      if (e.success) map.set(id, e.data);
      else {
        this.log(`entrada de ${id} em ${this.file} inválida: a política dele é a restritiva`);
        map.set(id, { mode: 'custom', ...RESTRICTIVE_GATES, completionChosen: false, at: new Date(0).toISOString() });
      }
    }
    return map;
  }

  /** Gravações em fila: duas seguidas não se atropelam. */
  private save(map: Map<string, Stored>): Promise<void> {
    const body = { version: 1, projects: Object.fromEntries(map) };
    const run = this.saving.then(() => writeAtomic(this.file, JSON.stringify(body, null, 2) + '\n'));
    this.saving = run.catch(() => {});
    return run;
  }
}
