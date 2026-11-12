import os from 'node:os';
import path from 'node:path';
import type {
  CostReport,
  LiveSession,
  Project,
  ProjectDetail,
  ProjectInventory,
  Session,
  UserScope,
} from '../../../shared/model';
import type { ToolAdapter } from '../types';
import { markDuplicates, readAgentsDir } from './agents';
import { CostIndex, systemCostsPath } from './costs';
import { defaultLocations, worktreeParent, type ClaudeLocations } from './paths';
import {
  discoverProjects,
  projectClaudeDir,
  summarizeProject,
  type DiscoverOptions,
  type ProjectRef,
} from './projects';
import { readLiveSessions, readProjectSessions } from './sessions';
import { readSkillsDir, readSyncedSkills } from './skills';

export interface ClaudeAdapterOptions extends DiscoverOptions {
  locations?: ClaudeLocations;
  /** Por quanto tempo a lista de projetos descobertos é reaproveitada. */
  discoveryTtlMs?: number;
  /** Onde guardar o cache dos custos lidos dos transcripts. */
  costCacheFile?: string;
  /** Ledger do gasto do Sistema (padrão: logs/system-costs.jsonl em MYCO_HOME). */
  systemCostsFile?: string;
  /** Intervalo mínimo entre releituras de custo. */
  costTtlMs?: number;
  /** Apelidos de exibição por id de projeto (lidos a cada chamada: mudam sem reiniciar). */
  projectNames?: () => Promise<Record<string, string>>;
  /**
   * Dos projetos descobertos, os que entram no quadro (a lista, as sessões, os custos e o ranking só
   * olham esses). Sem isto, entram todos. Roda junto com a descoberta, dentro do cache.
   */
  onBoard?: (refs: ProjectRef[]) => Promise<ProjectRef[]>;
}

/** Leitura (somente) do que o Claude Code grava em ~/.claude e nas pastas `.claude/` dos projetos. */
export class ClaudeAdapter implements ToolAdapter {
  readonly id = 'claude';
  private readonly loc: ClaudeLocations;
  private readonly opts: ClaudeAdapterOptions;
  private discovery: { at: number; all: Promise<ProjectRef[]>; board: Promise<ProjectRef[]> } | null = null;

  private readonly costs: CostIndex;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.opts = opts;
    this.loc = opts.locations ?? defaultLocations();
    const mycoHome = process.env.MYCO_HOME ?? path.join(os.homedir(), '.myco');
    this.costs = new CostIndex(
      path.join(this.loc.home, 'projects'),
      opts.costCacheFile ?? path.join(mycoHome, 'cache', 'claude-costs.json'),
      opts.systemCostsFile ?? systemCostsPath(mycoHome),
    );
  }

  async listProjects(): Promise<Project[]> {
    const [refs, names] = await Promise.all([this.refs(), this.displayNames()]);
    const projects = await Promise.all(refs.map((r) => summarizeProject(this.loc, r, names[r.id])));
    return projects.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  }

  /** Tudo que o Claude Code conhece e está fora do quadro (worktrees de pais fora inclusive), só id e pasta: barato. */
  async offBoardRefs(): Promise<ProjectRef[]> {
    const found = this.discover();
    const [all, board] = await Promise.all([found.all, found.board]);
    const onBoard = new Set(board.map((r) => r.id));
    return all.filter((r) => !onBoard.has(r.id));
  }

  /** Projetos que o Claude Code conhece e ainda estão fora do quadro (só pastas que existem; worktree não conta). */
  async listImportable(): Promise<Project[]> {
    const [off, names] = await Promise.all([this.offBoardRefs(), this.displayNames()]);
    const refs = off.filter((r) => !worktreeParent(r.path));
    const projects = await Promise.all(refs.map((r) => summarizeProject(this.loc, r, names[r.id])));
    return projects
      .filter((p) => p.exists)
      .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.name.localeCompare(b.name));
  }

  async getProject(id: string): Promise<ProjectDetail | null> {
    const ref = await this.ref(id);
    if (!ref) return null;
    const [project, inventory, live] = await Promise.all([
      this.displayNames().then((names) => summarizeProject(this.loc, ref, names[ref.id])),
      this.inventory(ref),
      this.liveById(),
    ]);
    const sessions = await readProjectSessions(path.join(this.loc.home, 'projects', ref.id), live);
    return { project, ...inventory, sessions };
  }

  async getProjectInventory(id: string): Promise<ProjectInventory | null> {
    const ref = await this.ref(id);
    return ref ? this.inventory(ref) : null;
  }

  private async inventory(ref: ProjectRef): Promise<ProjectInventory> {
    const claudeDir = projectClaudeDir(this.loc, ref.path);
    const [projectAgents, userAgents, skills] = await Promise.all([
      claudeDir ? readAgentsDir(path.join(claudeDir, 'agents'), 'project') : [],
      readAgentsDir(path.join(this.loc.home, 'agents'), 'user'),
      claudeDir ? readSkillsDir(path.join(claudeDir, 'skills'), 'project') : [],
    ]);
    // Colisões contam os agents do usuário também: todos ficam visíveis na mesma sessão.
    const agents = markDuplicates([...projectAgents, ...userAgents]).filter((a) => a.scope === 'project');
    return { agents, skills };
  }

  private async ref(id: string): Promise<ProjectRef | undefined> {
    return (await this.refs()).find((r) => r.id === id);
  }

  async getUserScope(): Promise<UserScope> {
    const [agents, userSkills, syncedSkills] = await Promise.all([
      readAgentsDir(path.join(this.loc.home, 'agents'), 'user'),
      readSkillsDir(path.join(this.loc.home, 'skills'), 'user'),
      readSyncedSkills(this.loc.home),
    ]);
    return { agents: markDuplicates(agents), skills: [...userSkills, ...syncedSkills] };
  }

  listLiveSessions(): Promise<LiveSession[]> {
    return readLiveSessions(this.loc.home);
  }

  async getProjectSessions(id: string): Promise<Session[] | null> {
    const ref = await this.ref(id);
    if (!ref) return null;
    return readProjectSessions(path.join(this.loc.home, 'projects', ref.id), await this.liveById());
  }

  async getCosts(): Promise<CostReport> {
    const stale = Date.now() - this.costs.scannedAt > (this.opts.costTtlMs ?? 30_000);
    if (!this.costs.isScanning && stale) void this.costs.refresh();
    return this.costs.report(new Date(), await this.boardIds());
  }

  async getSessionCostFiles(sessionId: string) {
    // Depois da 1ª varredura, a releitura é incremental e rápida: espera para vir atualizado.
    // Antes dela (até ~1 min com muitos transcripts), devolve o que já tem.
    if (this.costs.scannedAt === 0) void this.costs.refresh();
    else if (!this.costs.isScanning) await this.costs.refresh();
    return { files: this.costs.sessionFiles(sessionId), scanning: this.costs.isScanning };
  }

  async getSavingsFiles(since: string | null) {
    // Mesma regra de getSessionCostFiles: só espera a releitura depois da 1ª varredura.
    if (this.costs.scannedAt === 0) void this.costs.refresh();
    else if (!this.costs.isScanning) await this.costs.refresh();
    const board = await this.boardIds();
    const files = this.costs.transcripts(since);
    return { files: board ? files.filter((f) => board.has(f.projectId)) : files, scanning: this.costs.isScanning };
  }

  forgetProjects(): void {
    this.discovery = null;
  }

  private displayNames(): Promise<Record<string, string>> {
    return this.opts.projectNames ? this.opts.projectNames() : Promise.resolve({});
  }

  /** Os projetos do quadro. */
  private refs(): Promise<ProjectRef[]> {
    return this.discover().board;
  }

  /** Ids dos projetos do quadro, para limitar custos e ranking; undefined = sem filtro (tudo conta). */
  private async boardIds(): Promise<Set<string> | undefined> {
    return this.opts.onBoard ? new Set((await this.refs()).map((r) => r.id)) : undefined;
  }

  /** Tudo que o Claude Code conhece (`all`) e a parte que entra no quadro (`board`), reaproveitados por um tempo. */
  private discover() {
    const ttl = this.opts.discoveryTtlMs ?? 10_000;
    if (!this.discovery || Date.now() - this.discovery.at > ttl) {
      const all = discoverProjects(this.loc, this.opts);
      this.discovery = { at: Date.now(), all, board: this.opts.onBoard ? all.then(this.opts.onBoard) : all };
    }
    return this.discovery;
  }

  private async liveById(): Promise<Map<string, LiveSession>> {
    return new Map((await this.listLiveSessions()).map((s) => [s.sessionId, s]));
  }
}
