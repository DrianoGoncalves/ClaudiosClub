import type {
  CostReport,
  LiveSession,
  Project,
  ProjectDetail,
  ProjectInventory,
  Session,
  UserScope,
} from '../../shared/model';
import type { FileCost, TranscriptCost } from './claude/costs';

/**
 * Contrato da ferramenta de agentes (o Claude Code): isola os formatos não documentados dele.
 * Somente leitura nesta fase; a escrita (vínculos, CLAUDE.md) vem em outro módulo.
 */
export interface ToolAdapter {
  readonly id: string;
  /** Os projetos do quadro. */
  listProjects(): Promise<Project[]>;
  /** Projetos do Claude Code que ainda estão fora do quadro (para importar). */
  listImportable(): Promise<Project[]>;
  /** Id e pasta de tudo que o Claude Code conhece e está fora do quadro (worktrees inclusive), sem ler nada deles. */
  offBoardRefs(): Promise<Array<{ id: string; path: string }>>;
  /** A próxima leitura descobre os projetos de novo (um projeto acabou de ser criado). */
  forgetProjects(): void;
  getProject(id: string): Promise<ProjectDetail | null>;
  /** Agents e skills de um projeto, sem ler sessões. */
  getProjectInventory(id: string): Promise<ProjectInventory | null>;
  /** Sessões (= funcionários) de um projeto, sem custo. */
  getProjectSessions(id: string): Promise<Session[] | null>;
  getUserScope(): Promise<UserScope>;
  listLiveSessions(): Promise<LiveSession[]>;
  /**
   * Custos equivalentes em API. Não espera a leitura dos transcripts: devolve o que já foi
   * somado, com `scanning: true` enquanto a primeira varredura não terminou.
   */
  getCosts(): Promise<CostReport>;
  /** Custo e tokens por transcript de uma sessão (principal e subagents), para o "valeu a pena?". */
  getSessionCostFiles(sessionId: string): Promise<{ files: FileCost[]; scanning: boolean }>;
  /** Todos os transcripts com o gasto a partir de `since` (AAAA-MM-DD local; null = tudo), para o ranking de economia. */
  getSavingsFiles(since: string | null): Promise<{ files: TranscriptCost[]; scanning: boolean }>;
}
