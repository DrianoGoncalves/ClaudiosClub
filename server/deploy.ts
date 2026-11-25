import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DEPLOY_ENVS, isRunning, type DeployEnv, type DeployInfo, type DeployRecord, type DeployState } from '../shared/deploy';
import type { Task } from '../shared/model';
import { GitHubError, type GitHubActionsClient, type WorkflowRun } from './adapters/github/client';
import { writeAtomic } from './atomicWrite';

// Deploy como código (contrato em docs/deploy.md): se o projeto tem `.github/workflows/deploy.yml` e o origin é do GitHub, o "Pedir deploy" do cartão e o deploy da versão
// disparam esse workflow (`workflow_dispatch` com `ref` e `ambiente`) pelo adaptador do GitHub, com o token do `gh` do dono (só no servidor), e acompanham a execução: só
// enquanto ela roda, no máximo uma consulta a cada CHECK_MS por deploy (a rotina de fundo e a tela juntas), com o retry, o disjuntor e o prazo do adaptador. O disparo vai
// uma vez só (repetir publicaria duas vezes). Produção só com o ok do dono (`confirm`). Rollback: o mesmo workflow com a tag anterior. Sem o workflow, ou fora do GitHub,
// `available` é false e o "Pedir deploy" segue pela conversa SSH de sempre.
//
// Registro em `~/.myco/deploys/<projeto>.json` (fora do projeto, onde o agente não grava; a ficha nega a escrita), os 50 mais novos.

export class DeployError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const WORKFLOW_FILE = 'deploy.yml';
const WORKFLOW_PATH = path.join('.github', 'workflows', WORKFLOW_FILE);
/** Entre uma consulta ao GitHub e a próxima, para o mesmo deploy. */
export const CHECK_MS = 30_000;
/** A execução não apareceu no GitHub em tanto tempo: o Club para de procurar. */
const FIND_MS = 10 * 60_000;
/** Rodando há tanto tempo: o Club para de acompanhar (o log segue no GitHub). */
const RUN_MAX_MS = 90 * 60_000;
const KEEP = 50;
const ID = /^t-[0-9a-z]{4,20}$/;
const REF = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const PROJECT_FILE_ID = /^[A-Za-z0-9-]{1,100}$/;

const RecordSchema = z.object({
  id: z.string().max(60),
  ref: z.string().regex(REF),
  environment: z.enum(DEPLOY_ENVS as [DeployEnv, ...DeployEnv[]]),
  taskId: z.string().regex(ID).nullable(),
  rollbackFrom: z.string().regex(REF).nullable(),
  at: z.string(),
  state: z.enum(['queued', 'running', 'success', 'failure', 'unknown']),
  runId: z.number().int().nullable(),
  runUrl: z.string().regex(/^https:\/\/github\.com\//).nullable(),
  finishedAt: z.string().nullable(),
  reason: z.string().max(500).optional(),
  checkedAt: z.number().optional(),
});
const FileSchema = z.object({ records: z.array(RecordSchema).max(KEEP).default([]) });
type Stored = DeployRecord & { checkedAt?: number };

const Body = z.object({
  environment: z.enum(DEPLOY_ENVS as [DeployEnv, ...DeployEnv[]]).default('staging'),
  /** Deploy da tarefa: o commit mesclado dela (ou o do commit automático). */
  taskId: z.string().regex(ID).optional(),
  /** Deploy de uma versão: a tag (uma das tags `vX.Y.Z` do projeto). */
  tag: z.string().regex(/^v\d+\.\d+\.\d+$/).optional(),
  /** Voltar para a versão anterior: a tag antes da mais nova. */
  rollback: z.boolean().default(false),
  /** Produção: o ok do dono, dado na tela. */
  confirm: z.boolean().default(false),
});

export interface DeployDeps {
  stateDir: string;
  projectPath: (projectId: string) => Promise<string | null>;
  /** O `owner/repo` do origin (só GitHub). */
  repoOf: (projectId: string) => Promise<{ owner: string; repo: string } | null>;
  /** A branch padrão do origin (de onde o GitHub lê o workflow). */
  defaultBranch: (projectId: string) => Promise<string>;
  /** O commit completo de um SHA (curto ou não) no repositório do projeto; null se não existe. */
  resolveCommit: (projectId: string, sha: string) => Promise<string | null>;
  /** As tags `vX.Y.Z` do projeto, a mais nova primeiro. */
  tags: (projectId: string) => Promise<string[]>;
  readTasks: (dir: string) => Promise<Task[]>;
  /** O token do `gh` do dono; null = sem login. */
  token: () => Promise<string | null>;
  client: GitHubActionsClient;
  /** Aviso para a caixa (deploy no ar, falhou). */
  notify: (projectId: string, text: string) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
}

const ENV_NAME: Record<DeployEnv, string> = { staging: 'staging', producao: 'produção' };
const firstLine = (err: unknown) => ((err as Error)?.message ?? String(err)).split(/\r?\n/).find((l) => l.trim())?.slice(0, 300) ?? 'falhou';

export class DeployService {
  private cache = new Map<string, Stored[]>();
  /** Projetos com deploy rodando (a rotina só olha estes). Semeado na primeira rodada pela pasta de registros. */
  private active = new Set<string>();
  private seeded = false;
  private sweeping = false;
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: DeployDeps) {}

  private now = () => this.deps.now?.() ?? Date.now();
  private log = (line: string) => (this.deps.log ?? ((l) => console.warn(`[deploy] ${l}`)))(line);

  private locked<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(projectId, run.catch(() => {}));
    return run;
  }

  private fileOf(projectId: string): string {
    if (!PROJECT_FILE_ID.test(projectId)) throw new DeployError(400, 'projeto inválido');
    return path.join(this.deps.stateDir, `${projectId}.json`);
  }

  private async load(projectId: string): Promise<Stored[]> {
    const had = this.cache.get(projectId);
    if (had) return had;
    const file = this.fileOf(projectId);
    let records: Stored[] = [];
    const raw = await fs.readFile(file, 'utf8').catch(() => null);
    if (raw) {
      try {
        records = FileSchema.parse(JSON.parse(raw.replace(/^﻿/, ''))).records as Stored[];
      } catch {
        await fs.rename(file, `${file}.bad`).catch(() => {});
        this.log(`${file} estragado; guardado em ${file}.bad`);
      }
    }
    this.cache.set(projectId, records);
    if (records.some(isRunning)) this.active.add(projectId);
    return records;
  }

  private async save(projectId: string, records: Stored[]): Promise<void> {
    const kept = records.slice(0, KEEP);
    const file = this.fileOf(projectId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, JSON.stringify({ records: kept }, null, 2) + '\n');
    this.cache.set(projectId, kept);
    if (kept.some(isRunning)) this.active.add(projectId);
    else this.active.delete(projectId);
  }

  /** Dá para disparar? O workflow no checkout do projeto e o origin no GitHub. Sem isso, o "Pedir deploy" segue pela conversa SSH. */
  async available(projectId: string): Promise<{ ok: boolean; reason?: string }> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return { ok: false, reason: 'projeto não encontrado' };
    if (!(await fs.access(path.join(dir, WORKFLOW_PATH)).then(() => true, () => false))) return { ok: false, reason: 'o projeto não tem .github/workflows/deploy.yml (contrato em docs/deploy.md)' };
    if (!(await this.deps.repoOf(projectId).catch(() => null))) return { ok: false, reason: 'o origin do projeto não é do GitHub' };
    return { ok: true };
  }

  /** Os deploys (do cartão, ou todos) e as tags da versão e do rollback. Com deploy rodando, atualiza do GitHub (no máximo 1x a cada CHECK_MS por deploy). Null = projeto não existe. */
  async info(projectId: string, taskId?: string | null): Promise<DeployInfo | null> {
    if (!(await this.deps.projectPath(projectId))) return null;
    const av = await this.available(projectId);
    await this.refresh(projectId).catch((err) => this.log(`deploys de ${projectId} não atualizados: ${firstLine(err)}`));
    const all = await this.load(projectId);
    const records = (taskId ? all.filter((r) => r.taskId === taskId) : all).map(({ checkedAt: _c, ...r }) => r);
    const tags = taskId ? [] : await this.deps.tags(projectId).catch(() => [] as string[]);
    return { available: av.ok, ...(av.reason && { reason: av.reason }), records, latestTag: tags[0] ?? null, previousTag: tags[1] ?? null };
  }

  /**
   * Dispara o deploy (só você, pela tela): do cartão (o commit mesclado dele), de uma versão (a tag) ou o rollback (a tag anterior). Produção exige `confirm`. Um deploy por
   * ambiente de cada vez. O commit tem de estar no GitHub. Devolve o registro (ainda `queued`: a execução aparece no GitHub em segundos).
   */
  async dispatch(projectId: string, body: unknown, fromBrowser: boolean): Promise<DeployRecord> {
    if (!fromBrowser) throw new DeployError(403, 'só você, pelo Claudio’s Club, dispara um deploy');
    const r = Body.safeParse(body ?? {});
    if (!r.success) throw new DeployError(400, r.error.issues[0]?.message ?? 'dados inválidos');
    const b = r.data;
    if ([b.taskId, b.tag, b.rollback || undefined].filter(Boolean).length !== 1) throw new DeployError(400, 'diga o que publicar: a tarefa, a tag da versão ou o rollback');
    if (b.environment === 'producao' && !b.confirm) throw new DeployError(409, 'produção pede o seu ok: confirme na tela');
    return this.locked(projectId, async () => {
      const dir = await this.deps.projectPath(projectId);
      if (!dir) throw new DeployError(404, 'projeto não encontrado');
      const av = await this.available(projectId);
      if (!av.ok) throw new DeployError(409, `${av.reason}: o deploy segue pela conversa com o funcionário de infra`);
      const repo = (await this.deps.repoOf(projectId))!;
      const records = await this.load(projectId);
      if (records.some((x) => x.environment === b.environment && isRunning(x))) throw new DeployError(409, `já há um deploy em ${ENV_NAME[b.environment]} rodando: espere ele terminar`);
      const token = await this.deps.token().catch(() => null);
      if (!token) throw new DeployError(409, 'para disparar o deploy, o gh desta máquina precisa estar logado (gh auth login, com a permissão "workflow")');

      let ref: string;
      let rollbackFrom: string | null = null;
      if (b.taskId) {
        const task = (await this.deps.readTasks(dir)).find((t) => t.id === b.taskId);
        if (!task) throw new DeployError(404, 'tarefa não encontrada');
        if (task.status === 'cancelled') throw new DeployError(409, 'a tarefa foi cancelada: não há o que publicar');
        const sha = task.merged?.sha ?? task.commit?.sha ?? null;
        if (!sha || !SHA.test(sha)) throw new DeployError(409, 'a tarefa ainda não tem commit (mescla ou commit automático) para publicar');
        const full = await this.deps.resolveCommit(projectId, sha);
        if (!full) throw new DeployError(409, `o commit ${sha} não está neste repositório`);
        if (!(await this.deps.client.commitExists(repo.owner, repo.repo, full, token).catch((err) => this.githubFail(err)))) {
          throw new DeployError(409, `o commit ${full.slice(0, 7)} ainda não está no GitHub: faça o push antes do deploy`);
        }
        ref = full;
      } else {
        const tags = await this.deps.tags(projectId);
        if (b.rollback) {
          if (!tags[1]) throw new DeployError(409, 'não há versão anterior (tag) para voltar');
          ref = tags[1];
          rollbackFrom = tags[0]!;
        } else {
          if (!tags.includes(b.tag!)) throw new DeployError(409, `a tag ${b.tag} não existe neste projeto`);
          ref = b.tag!;
        }
      }
      if (!REF.test(ref) || ref.includes('..') || ref.startsWith('-')) throw new DeployError(400, 'referência inválida');
      const base = await this.deps.defaultBranch(projectId);
      await this.deps.client.dispatchWorkflow(repo.owner, repo.repo, WORKFLOW_FILE, base, { ref, ambiente: b.environment }, token).catch((err) => this.githubFail(err));
      const rec: Stored = {
        id: randomUUID().slice(0, 12),
        ref,
        environment: b.environment,
        taskId: b.taskId ?? null,
        rollbackFrom,
        at: new Date(this.now()).toISOString(),
        state: 'queued',
        runId: null,
        runUrl: null,
        finishedAt: null,
      };
      await this.save(projectId, [rec, ...records]);
      const { checkedAt: _c, ...out } = rec;
      return out;
    });
  }

  private githubFail(err: unknown): never {
    throw new DeployError(409, err instanceof GitHubError ? err.message : `o GitHub falhou: ${firstLine(err)}`);
  }

  /** Atualiza os deploys que rodam: acha a execução (a mais nova criada depois do disparo e ainda sem dono) e lê o estado dela. Sem token ou com o GitHub fora: fica como está, com o motivo. */
  async refresh(projectId: string): Promise<void> {
    const records = await this.load(projectId);
    if (!records.some(isRunning)) return;
    await this.locked(projectId, async () => {
      const list = await this.load(projectId);
      const now = this.now();
      const due = list.filter((x) => isRunning(x) && (!x.checkedAt || now - x.checkedAt >= CHECK_MS));
      if (!due.length) return;
      const repo = await this.deps.repoOf(projectId).catch(() => null);
      const token = await this.deps.token().catch(() => null);
      const next = list.map((x) => ({ ...x }));
      const finished: Stored[] = [];
      let runs: WorkflowRun[] | null = null;
      for (const rec of next.filter((x) => due.some((d) => d.id === x.id))) {
        rec.checkedAt = now;
        if (!repo || !token) {
          rec.reason = !repo ? 'o origin do projeto não é do GitHub' : 'o gh desta máquina não está logado: não dá para acompanhar';
          continue;
        }
        try {
          if (rec.runId === null) {
            runs ??= await this.deps.client.workflowRuns(repo.owner, repo.repo, WORKFLOW_FILE, token);
            const taken = new Set(next.map((x) => x.runId).filter((id): id is number => id !== null));
            const since = Date.parse(rec.at) - 15_000;
            const found = runs.filter((r) => !taken.has(r.id) && Date.parse(r.createdAt) >= since).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
            if (!found) {
              if (now - Date.parse(rec.at) > FIND_MS) Object.assign(rec, this.final('unknown', now), { reason: 'a execução não apareceu no GitHub: confira a aba Actions' });
              continue;
            }
            rec.runId = found.id;
            rec.runUrl = found.url;
            this.apply(rec, found, now);
          } else {
            this.apply(rec, await this.deps.client.workflowRun(repo.owner, repo.repo, rec.runId, token), now);
          }
          delete rec.reason;
          if (isRunning(rec) && now - Date.parse(rec.at) > RUN_MAX_MS) Object.assign(rec, this.final('unknown', now), { reason: 'rodando há mais de 90 min: o Club parou de acompanhar; veja o log no GitHub' });
        } catch (err) {
          rec.reason = err instanceof GitHubError ? err.message : firstLine(err);
        }
        if (!isRunning(rec)) finished.push(rec);
      }
      await this.save(projectId, next);
      for (const rec of finished) {
        const what = rec.rollbackFrom ? `rollback de ${rec.rollbackFrom} para ${rec.ref}` : `deploy de ${rec.ref.length === 40 ? rec.ref.slice(0, 7) : rec.ref}`;
        const how = rec.state === 'success' ? 'no ar (smoke ok)' : rec.state === 'failure' ? 'falhou' : 'sem resposta';
        await this.deps.notify(projectId, `${what} em ${ENV_NAME[rec.environment]}: ${how}${rec.runUrl ? ` (${rec.runUrl})` : ''}`).catch(() => {});
      }
    });
  }

  private final(state: DeployState, now: number): Partial<Stored> {
    return { state, finishedAt: new Date(now).toISOString() };
  }

  private apply(rec: Stored, run: WorkflowRun, now: number): void {
    if (run.url) rec.runUrl = run.url;
    if (run.status !== 'completed') {
      rec.state = 'running';
      return;
    }
    Object.assign(rec, this.final(run.conclusion === 'success' ? 'success' : 'failure', now));
  }

  /** A rotina (a cada minuto, uma por vez): só os projetos com deploy rodando. Na primeira, acha-os pela pasta de registros. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      if (!this.seeded) {
        this.seeded = true;
        const files = await fs.readdir(this.deps.stateDir).catch(() => [] as string[]);
        for (const f of files) if (f.endsWith('.json')) await this.load(f.slice(0, -5)).catch(() => {});
      }
      for (const projectId of [...this.active]) await this.refresh(projectId).catch((err) => this.log(`deploys de ${projectId} não atualizados: ${firstLine(err)}`));
    } finally {
      this.sweeping = false;
    }
  }
}
