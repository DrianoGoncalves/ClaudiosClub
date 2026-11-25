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
/** Opções de listagem de sessões: `includeOld` traz também as antigas (arquivadas pela retenção; ver sessions.ts). */
export interface SessionQuery {
  includeOld?: boolean;
}

/** Um projeto do quadro só com o que a caixa, os avisos e os agendamentos usam: sem a contagem de conversas e a última atividade (ver `listProjectsLite`). */
export type ProjectLite = Pick<Project, 'id' | 'path' | 'name' | 'exists' | 'worktreeOf'>;

export interface ToolAdapter {
  readonly id: string;
  /** Os projetos do quadro, com o resumo (contagem de conversas, última atividade): `stat` de todo transcript. Fora de caminho de polling (SPEC "Desempenho" 2). */
  listProjects(): Promise<Project[]>;
  /**
   * Os mesmos projetos, na mesma ordem da descoberta, sem o resumo: só a descoberta e um `access` por pasta. É o que rota chamada em polling usa (caixa, aviso de
   * commit, turnos, git, agendamentos). Opcional: sem ele, quem chama usa o `listProjects`.
   */
  listProjectsLite?(): Promise<ProjectLite[]>;
  /** A pasta de um projeto do quadro que existe (null: fora do quadro ou apagado), sem o resumo do `listProjects`: o caminho quente das tarefas. */
  projectPath(id: string): Promise<string | null>;
  /** Ids dos projetos do quadro que existem e não são worktree, sem o resumo do `listProjects`. */
  boardProjectIds(): Promise<string[]>;
  /** Projetos do Claude Code que ainda estão fora do quadro (para importar). */
  listImportable(): Promise<Project[]>;
  /** Id e pasta de tudo que o Claude Code conhece e está fora do quadro (worktrees inclusive), sem ler nada deles. */
  offBoardRefs(): Promise<Array<{ id: string; path: string }>>;
  /** A próxima leitura descobre os projetos de novo (um projeto acabou de ser criado). */
  forgetProjects(): void;
  getProject(id: string, query?: SessionQuery): Promise<ProjectDetail | null>;
  /** Agents e skills de um projeto, sem ler sessões. */
  getProjectInventory(id: string): Promise<ProjectInventory | null>;
  /** Sessões (= funcionários) de um projeto, sem custo. Sem `includeOld`, as antigas (retenção) ficam de fora sem ser lidas. */
  getProjectSessions(id: string, query?: SessionQuery): Promise<Session[] | null>;
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
  /** Todos os transcripts, sem filtro de quadro: a conversa de uma tarefa pode estar numa worktree fora do quadro. */
  getAllSessionCostFiles(): Promise<{ files: TranscriptCost[]; scanning: boolean }>;
}
