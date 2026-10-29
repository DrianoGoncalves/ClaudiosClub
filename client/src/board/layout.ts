import type { Edge, Node } from '@xyflow/react';
import type {
  Agent,
  AppConfig,
  Board,
  CostReport,
  CostSummary,
  GitState,
  LiveSession,
  Project,
  ProjectColor,
  Session,
  Skill,
  StaffProfile,
} from '../../../shared/model';

// Organograma: cada projeto é uma sala com moldura, e as salas formam uma grade (planta do escritório),
// quebrando linha para caber na tela mesmo com muitos projetos.
// - Hierarquia de cima para baixo: a linha sai da base do gestor e entra no topo do subordinado.
// - O que é paralelo fica de lado: agents e skills ao lado do projeto, ligados pela lateral,
//   e chamadas entre funcionários do mesmo nível. Quando são muitos, ficam guardados numa
//   "estante" (um nó só, com as contagens) que abre ao clicar.
// - Um funcionário pode ter vários gestores: o primeiro define onde ele fica; os demais viram
//   ligações extras (tracejadas).
// - Vínculos de symlink/junction são curvas tracejadas entre salas.

/**
 * Cabeçalho da sala: a cor da parede, onde sai a linha para a coluna de recursos (px da esquerda),
 * se a sala está dobrada (só o cabeçalho) e quantos agents/skills ela guarda (para o resumo dobrado).
 */
export type HeaderData = { color: ProjectColor | null; sideAt: number | null; collapsed: boolean; resources: number };
export type UserNodeData = { agentCount: number; skillCount: number; header: HeaderData };
export type ProjectNodeData = {
  project: Project;
  live: LiveSession[];
  cost: CostSummary | null;
  archived: boolean;
  /** URL da imagem do projeto (logo ou print), se houver. */
  image: string | null;
  header: HeaderData;
  /** Parte do projeto no consumo total (0–1), para o resumo da sala dobrada. */
  costShare: number | null;
  /** Estado do código (null: não é repositório git ou ainda não foi lido). */
  git: GitState | null;
  /** Tarefas em aberto e quantas esperam revisão (null: nenhuma). */
  tasks: { open: number; review: number } | null;
};
export type EmployeeNodeData = {
  /** A sessão mais recente; null para quem foi contratado e ainda não abriu sessão. */
  session: Session | null;
  /** Ficha, quando contratado pelo Claudio’s Club; null para sessões abertas fora dele. */
  staff: StaffProfile | null;
  projectId: string;
  /** Soma de todas as sessões do funcionário. */
  costUsd: number | null;
  /** Parte do funcionário no consumo total (0 a 1). */
  costShare: number | null;
  archived: boolean;
};
/** `share`: parte do agent no consumo de todos os subagents (0 a 1). */
export type AgentNodeData = { agent: Agent; cost: { usd: number; runs: number; share: number } | null };
export type SkillNodeData = { skill: Skill };
export type SyncedNodeData = { skills: Skill[] };
export type ShelfNodeData = { agents: number; skills: number; expanded: boolean };
/**
 * Moldura da sala: `owner` é o nó do projeto (ou "você"); `members`, os nós dentro dela;
 * `color`, a caneta escolhida para a parede (null = a padrão).
 */
export type RoomNodeData = { owner: string; members: string[]; color: ProjectColor | null };

export type BoardNode =
  | Node<UserNodeData, 'user'>
  | Node<ProjectNodeData, 'project'>
  | Node<EmployeeNodeData, 'employee'>
  | Node<AgentNodeData, 'agent'>
  | Node<SkillNodeData, 'skill'>
  | Node<SyncedNodeData, 'synced'>
  | Node<ShelfNodeData, 'shelf'>
  | Node<RoomNodeData, 'room'>;

export type BoardNodeType = NonNullable<BoardNode['type']>;

/** contains = hierarquia; side = recurso ao lado do projeto; calls = gestor extra; borrow = vínculo entre salas. */
/** `active`: o funcionário na ponta está trabalhando (a linha ganha a bolinha animada). */
/** Vínculo gestor → subordinado entre dois funcionários com ficha (pode ser desfeito no quadro). */
export type StaffLink = { projectId: string; staffId: string; managerId: string };
export type BoardEdgeData = { kind: 'contains' | 'side' | 'calls' | 'borrow' | 'delegates'; active?: boolean; link?: StaffLink };
export type BoardEdge = Edge<BoardEdgeData, 'rough'>;

export interface GraphOptions {
  showWorktrees: boolean;
  /** Mostra (esmaecidos) projetos e funcionários arquivados. */
  showArchived?: boolean;
  archived?: AppConfig['archived'];
  costs?: CostReport | null;
  /** Estantes abertas (ids `sh:...`). */
  expandedShelves?: string[];
  /** Cor da parede da sala, por id de projeto. */
  projectColors?: AppConfig['projectColors'];
  /** Salas dobradas (ids do cabeçalho: `p:<projeto>` ou `u`): só o cabeçalho aparece. */
  collapsedRooms?: string[];
  /** Estado do código por id de projeto (ver /api/git). */
  git?: Record<string, GitState>;
  /** Tarefas em aberto por id de projeto (ver /api/tasks/summary). */
  tasks?: Record<string, { open: number; review: number }>;
  /**
   * Proporção (largura/altura) da área visível do quadro. Tela deitada: a grade cresce para a
   * direita; em pé: cresce para baixo. Sem ela, a de uma tela larga.
   */
  aspect?: number;
}

/**
 * Tamanho fixo de cada tipo de nó. A sala não tem tamanho próprio: envolve os nós dela. Projeto e
 * "você" são o cabeçalho da sala: a largura aqui é a mínima; no layout eles esticam até a sala.
 */
export const SIZES: Record<BoardNodeType, { w: number; h: number }> = {
  user: { w: 300, h: 64 },
  project: { w: 300, h: 64 },
  employee: { w: 220, h: 66 },
  agent: { w: 210, h: 64 },
  skill: { w: 180, h: 54 },
  synced: { w: 210, h: 64 },
  shelf: { w: 210, h: 64 },
  room: { w: 0, h: 0 },
};

const GAP_X = 28;
const LEVEL_GAP = 70;
const SIDE_GAP = 46;
const SIDE_ROW_GAP = 12;
/** Folga entre a moldura da sala e os nós dela. */
export const ROOM_PAD = 26;
const ROOM_GAP_X = 56;
const ROOM_GAP_Y = 56;
/** Proporção (largura/altura) que a grade de salas procura quando a da tela não é informada. */
const GRID_ASPECT = 16 / 10;
/** Limites da proporção da tela: evita uma fila só (ou uma coluna só) em janelas extremas. */
const ASPECT_MIN = 0.4;
const ASPECT_MAX = 4;
/** Até quantos agents/skills ficam soltos ao lado do projeto; acima disso, vão para a estante. */
const SHELF_MAX_LOOSE = 3;

export const USER_NODE_ID = 'u';
/** Não é um nó: abre o ranking de custo no painel lateral. */
export const RANKING_ID = 'ranking';
export const SYNCED_NODE_ID = 'sg';
export const projectNodeId = (projectId: string) => `p:${projectId}`;
export const employeeNodeId = (sessionId: string) => `e:${sessionId}`;
export const staffNodeId = (projectId: string, staffId: string) => `h:${projectId}:${staffId}`;
/** Chave de arquivamento: a ficha, para contratados; a sessão, para os demais. */
export const archiveKey = (d: { staff: StaffProfile | null; session: Session | null }) =>
  d.staff ? `staff:${d.staff.id}` : d.session!.id;
export const agentNodeId = (agent: Agent) => `a:${agent.id}`;
export const skillNodeId = (skill: Skill) => `s:${skill.id}`;
/** Estante e moldura da sala, pelo nó dono (projeto ou "você"). */
export const shelfNodeId = (ownerId: string) => `sh:${ownerId}`;
export const roomNodeId = (ownerId: string) => `r:${ownerId}`;

/**
 * Ids das alças dos nós (ver nodes.tsx). Cada lateral tem uma de entrada e uma de saída: o
 * React Flow só liga a saída de um nó à entrada de outro.
 */
export const HANDLE = {
  top: 't',
  bottom: 'b',
  leftIn: 'li',
  leftOut: 'lo',
  rightIn: 'ri',
  rightOut: 'ro',
  hire: 'hire',
  /** Na base do cabeçalho, alinhada com a coluna de recursos (ver HeaderData.sideAt). */
  side: 'sd',
} as const;

interface Tree {
  node: BoardNode;
  /** Ao lado do nó, empilhados (recursos paralelos). */
  side: BoardNode[];
  children: Tree[];
}

export function buildGraph(
  board: Board,
  opts: GraphOptions,
  images: Record<string, string> = {},
): { nodes: BoardNode[]; edges: BoardEdge[] } {
  const projectKeys = new Set(board.projects.map((p) => pathKey(p.path)));
  const worktreesByParent = new Map<string, Project[]>();
  for (const p of board.projects) {
    if (!p.worktreeOf) continue;
    const k = pathKey(p.worktreeOf);
    worktreesByParent.set(k, [...(worktreesByParent.get(k) ?? []), p]);
  }

  const archivedProjects = new Set(opts.archived?.projects ?? []);
  const archivedSessions = new Set(opts.archived?.sessions ?? []);
  const visibleProject = (p: Project) => opts.showArchived || !archivedProjects.has(p.id);
  const liveById = new Map(board.live.map((s) => [s.sessionId, s]));
  const costs = opts.costs ?? null;
  const totalUsd = costs?.total.usd ?? 0;
  const agentsUsd = Object.values(costs?.agents ?? {}).reduce((s, a) => s + a.usd, 0);
  const share = (usd: number | null, total: number) => (usd === null || !total ? null : usd / total);
  const extraManagers: Array<{ projectId: string; staff: StaffProfile; managerId: string }> = [];

  const agentNode = (a: Agent): BoardNode => {
    const c = costs?.agents[a.name];
    return node(agentNodeId(a), 'agent', {
      agent: a,
      cost: c ? { usd: c.usd, runs: c.runs, share: share(c.usd, agentsUsd) ?? 0 } : null,
    });
  };
  const skillNode = (s: Skill): BoardNode => node(skillNodeId(s), 'skill', { skill: s });
  const withLive = (s: Session): Session => ({ ...s, live: liveById.get(s.id) ?? s.live });

  const expanded = new Set(opts.expandedShelves ?? []);
  const collapsed = new Set(opts.collapsedRooms ?? []);
  /** Itens guardados numa estante fechada: o empréstimo passa a sair (ou chegar) pela estante. */
  const shelved: Array<{ item: BoardNode; shelfId: string }> = [];
  /** Coluna lateral: poucos itens ficam soltos; muitos vão para a estante (aberta, ela vem antes deles). */
  const sideOf = (ownerId: string, items: BoardNode[]): BoardNode[] => {
    if (items.length <= SHELF_MAX_LOOSE) return items;
    const id = shelfNodeId(ownerId);
    const open = expanded.has(id);
    const shelf = node(id, 'shelf', {
      agents: items.filter((n) => n.type === 'agent').length,
      skills: items.reduce((sum, n) => sum + (n.type === 'skill' ? 1 : n.type === 'synced' ? n.data.skills.length : 0), 0),
      expanded: open,
    });
    if (open) return [shelf, ...items];
    for (const item of items) shelved.push({ item, shelfId: id });
    return [shelf];
  };

  /**
   * Funcionários do projeto: cada ficha (com a sessão mais recente dela) e cada sessão aberta
   * fora do Claudio’s Club. Quem reporta a outro funcionário fica pendurado no primeiro gestor.
   */
  const employeeTrees = (p: Project): Tree[] => {
    const sessions = board.sessions[p.id] ?? [];
    const sessionCost = (id: string) => costs?.projects[p.id]?.sessions[id];
    const staff = (board.staff ?? []).filter((s) => s.projectId === p.id);
    const ownedBy = new Map<string, StaffProfile>();
    for (const st of staff) for (const s of st.sessions) ownedBy.set(s.id, st);

    const byId = new Map<string, Tree>();
    const trees: Tree[] = [];
    for (const st of staff) {
      const mine = st.sessions.map((s) => s.id);
      // A lista de sessões já vem da mais recente para a mais antiga.
      const latest = sessions.find((s) => mine.includes(s.id)) ?? null;
      const costsOfMine = mine.map(sessionCost).filter((c): c is number => c !== undefined);
      const costUsd = costsOfMine.length ? costsOfMine.reduce((a, b) => a + b, 0) : null;
      const data: EmployeeNodeData = {
        session: latest ? withLive(latest) : null,
        staff: st,
        projectId: p.id,
        costUsd,
        costShare: share(costUsd, totalUsd),
        archived: archivedSessions.has(`staff:${st.id}`),
      };
      if (data.archived && !opts.showArchived) continue;
      const tree: Tree = { node: node(staffNodeId(p.id, st.id), 'employee', data), side: [], children: [] };
      byId.set(st.id, tree);
      trees.push(tree);
    }
    for (const s of sessions) {
      if (ownedBy.has(s.id)) continue;
      const archived = archivedSessions.has(s.id);
      if (archived && !opts.showArchived) continue;
      trees.push({
        node: node(employeeNodeId(s.id), 'employee', {
          session: withLive(s),
          staff: null,
          projectId: p.id,
          costUsd: sessionCost(s.id) ?? null,
          costShare: share(sessionCost(s.id) ?? null, totalUsd),
          archived,
        }),
        side: [],
        children: [],
      });
    }

    // Hierarquia pelo primeiro gestor visível; os outros gestores viram ligações extras.
    const roots: Tree[] = [];
    for (const t of trees) {
      const st = (t.node.data as EmployeeNodeData).staff;
      const managers = (st?.reportsTo ?? []).filter((id) => byId.has(id) && id !== st!.id);
      const primary = managers[0] ? byId.get(managers[0]) : undefined;
      if (primary && !isAncestor(t, primary)) primary.children.push(t);
      else roots.push(t);
      for (const extra of managers.slice(primary ? 1 : 0)) extraManagers.push({ projectId: p.id, staff: st!, managerId: extra });
    }
    return roots;
  };

  const projectTree = (p: Project): Tree => {
    const inv = board.inventories[p.id] ?? { agents: [], skills: [] };
    const worktrees = opts.showWorktrees ? (worktreesByParent.get(pathKey(p.path)) ?? []).filter(visibleProject) : [];
    const id = projectNodeId(p.id);
    const folded = collapsed.has(id);
    return {
      node: node(id, 'project', {
        project: p,
        live: liveFor(board.live, p.path),
        cost: costs?.projects[p.id] ?? null,
        archived: archivedProjects.has(p.id),
        image: images[p.id] ?? null,
        header: { color: opts.projectColors?.[p.id] ?? null, sideAt: null, collapsed: folded, resources: inv.agents.length + inv.skills.length },
        costShare: share(costs?.projects[p.id]?.usd ?? null, totalUsd),
        git: opts.git?.[p.id] ?? null,
        tasks: opts.tasks?.[p.id] ?? null,
      }),
      // Dobrada: só o cabeçalho, com o resumo; nada de equipe, recursos ou worktrees.
      side: folded ? [] : sideOf(id, [...inv.agents.map(agentNode), ...inv.skills.map(skillNode)]),
      children: folded ? [] : [...employeeTrees(p), ...worktrees.map(projectTree)],
    };
  };

  const userSkills = board.user.skills.filter((s) => s.scope !== 'synced');
  const synced = board.user.skills.filter((s) => s.scope === 'synced');
  const userFolded = collapsed.has(USER_NODE_ID);
  const userTree: Tree = {
    node: node(USER_NODE_ID, 'user', {
      agentCount: board.user.agents.length,
      skillCount: board.user.skills.length,
      header: { color: null, sideAt: null, collapsed: userFolded, resources: board.user.agents.length + board.user.skills.length },
    }),
    side: userFolded ? [] : sideOf(USER_NODE_ID, [
      ...board.user.agents.map(agentNode),
      ...userSkills.map(skillNode),
      // As skills da conta são muitas e somente leitura: um nó só.
      ...(synced.length ? [node(SYNCED_NODE_ID, 'synced', { skills: synced })] : []),
    ]),
    children: [],
  };

  const rooms = [
    userTree,
    ...board.projects
      .filter(visibleProject)
      .filter((p) => !p.worktreeOf || (opts.showWorktrees && !projectKeys.has(pathKey(p.worktreeOf))))
      .map(projectTree),
  ];

  const nodes: BoardNode[] = [];
  const edges: BoardEdge[] = [];
  const frames: BoardNode[] = [];
  const memo = new Map<Tree, Box>();
  const spots = gridSpots(
    rooms.map((r) => {
      const b = measure(r, memo);
      return { w: b.w + ROOM_PAD * 2, h: b.h + ROOM_PAD * 2 };
    }),
    Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, opts.aspect ?? GRID_ASPECT)),
  );
  rooms.forEach((room, i) => {
    const start = nodes.length;
    place(room, spots[i]!.x + ROOM_PAD, spots[i]!.y + ROOM_PAD, memo, nodes, edges);
    const color = room.node.type === 'project' ? (opts.projectColors?.[room.node.data.project.id] ?? null) : null;
    frames.push(roomNode(room.node.id, nodes.slice(start), color));
  });
  edges.push(...managerEdges(extraManagers, nodes));
  edges.push(...borrowEdges(nodes, shelved));
  edges.push(...delegateEdges(nodes, shelved, board.projects));
  markActive(edges, nodes);
  markStaffLinks(edges, nodes);
  // As molduras vêm primeiro: ficam por baixo de tudo.
  return { nodes: [...frames, ...nodes], edges };
}

/**
 * Delegação ao vivo: funcionário → agent que está trabalhando para ele agora (orquestrador
 * mandando tarefa ao executor). O agent do próprio projeto (ou do usuário) é procurado pelo nome;
 * guardado numa estante fechada, a linha vai até a estante. Agents embutidos (Explore,
 * general-purpose) não têm nó: aparecem só no cartão do funcionário.
 */
function delegateEdges(nodes: BoardNode[], shelved: Array<{ item: BoardNode; shelfId: string }>, projects: Project[]): BoardEdge[] {
  const projectPath = new Map(projects.map((p) => [p.id, pathKey(p.path)]));
  const agents = [...nodes.map((n) => ({ item: n, id: n.id })), ...shelved.map((s) => ({ item: s.item, id: s.shelfId }))].filter(
    (x): x is { item: Extract<BoardNode, { type: 'agent' }>; id: string } => x.item.type === 'agent',
  );
  const out: BoardEdge[] = [];
  for (const n of nodes) {
    if (n.type !== 'employee') continue;
    const live = n.data.session?.live;
    if (!live?.alive || !live.activeAgents?.length) continue;
    const root = projectPath.get(n.data.projectId) ?? '';
    for (const type of live.activeAgents) {
      const candidates = agents.filter((a) => a.item.data.agent.name === type);
      // O do projeto vence o do usuário, como no Claude Code.
      const target =
        candidates.find((a) => a.item.data.agent.scope === 'project' && pathKey(a.item.data.agent.filePath).startsWith(`${root}/`)) ??
        candidates.find((a) => a.item.data.agent.scope === 'user');
      if (!target) continue;
      const e = edge(n.id, target.id, 'delegates', HANDLE.rightOut, HANDLE.leftIn);
      out.push({ ...e, id: `d:${n.id}->${target.id}`, data: { kind: 'delegates', active: true } });
    }
  }
  return out;
}

/**
 * Linhas que chegam a um funcionário trabalhando numa tarefa delegada por outro funcionário: a
 * conversa está passando por elas. Se foi você que pediu no chat, só a borda do cartão anima.
 */
function markActive(edges: BoardEdge[], nodes: BoardNode[]) {
  const busy = new Set(
    nodes
      .filter((n) => {
        const live = n.type === 'employee' ? n.data.session?.live : null;
        return live?.alive && live.status === 'busy' && live.delegated;
      })
      .map((n) => n.id),
  );
  for (const e of edges) {
    if (e.data && (e.data.kind === 'contains' || e.data.kind === 'calls') && busy.has(e.target)) e.data = { ...e.data, active: true };
  }
}

/** Linhas de hierarquia entre dois funcionários com ficha: guardam o vínculo, para poder desfazê-lo. */
function markStaffLinks(edges: BoardEdge[], nodes: BoardNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (!e.data || (e.data.kind !== 'contains' && e.data.kind !== 'calls')) continue;
    const from = byId.get(e.source);
    const to = byId.get(e.target);
    if (from?.type !== 'employee' || to?.type !== 'employee' || !from.data.staff || !to.data.staff) continue;
    e.data = { ...e.data, link: { projectId: to.data.projectId, staffId: to.data.staff.id, managerId: from.data.staff.id } };
  }
}

/**
 * Planta do escritório: as salas, na ordem recebida, preenchem linhas até a largura que deixa a
 * grade com a proporção da tela (`aspect` = largura/altura); aí quebram linha.
 */
function gridSpots(boxes: Array<{ w: number; h: number }>, aspect: number): Array<{ x: number; y: number }> {
  if (!boxes.length) return [];
  const area = boxes.reduce((s, b) => s + (b.w + ROOM_GAP_X) * (b.h + ROOM_GAP_Y), 0);
  const rowLimit = Math.max(...boxes.map((b) => b.w), Math.sqrt(area * aspect));
  const spots: Array<{ x: number; y: number }> = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const b of boxes) {
    if (x > 0 && x + b.w > rowLimit) {
      x = 0;
      y += rowH + ROOM_GAP_Y;
      rowH = 0;
    }
    spots.push({ x, y });
    x += b.w + ROOM_GAP_X;
    rowH = Math.max(rowH, b.h);
  }
  return spots;
}

function roomNode(owner: string, members: BoardNode[], color: ProjectColor | null): BoardNode {
  const n = node(roomNodeId(owner), 'room', { owner, members: members.map((m) => m.id), color });
  // Por baixo das linhas e dos cartões; clicar nela seleciona o dono (ver Board.tsx).
  return { ...n, ...roomFrame(members), selectable: false, focusable: false, zIndex: -1 } as BoardNode;
}

/** Moldura que envolve os nós da sala, com folga. Usada no layout e quando um nó é arrastado. */
export function roomFrame(members: BoardNode[]): { position: { x: number; y: number }; width: number; height: number } {
  if (!members.length) return { position: { x: 0, y: 0 }, width: 0, height: 0 };
  // O cabeçalho (projeto ou "você") já é a borda de cima da sala: sem folga em volta dele.
  const pad = (m: BoardNode) => (isHeaderNode(m) ? 0 : ROOM_PAD);
  const xs = members.map((m) => m.position.x - pad(m));
  const ys = members.map((m) => m.position.y - pad(m));
  const x2 = members.map((m) => m.position.x + sizeOf(m).w + pad(m));
  const y2 = members.map((m) => m.position.y + sizeOf(m).h + pad(m));
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { position: { x, y }, width: Math.max(...x2) - x, height: Math.max(...y2) - y };
}

// Tamanho fixo declarado: o React Flow não depende de medir o DOM (que não remede quando o nó é recriado
// a cada atualização ao vivo com o mesmo tamanho).
function node<T extends BoardNodeType>(id: string, type: T, data: Extract<BoardNode, { type?: T }>['data']): BoardNode {
  const { w, h } = SIZES[type];
  return { id, type, data, position: { x: 0, y: 0 }, width: w, height: h } as BoardNode;
}

function isAncestor(candidate: Tree, of: Tree): boolean {
  if (candidate === of) return true;
  return candidate.children.some((c) => isAncestor(c, of));
}

function liveFor(live: LiveSession[], projectPath: string): LiveSession[] {
  const k = pathKey(projectPath);
  return live.filter((s) => s.alive && s.cwd !== null && pathKey(s.cwd) === k);
}

// ---- layout ----

interface Box {
  w: number;
  h: number;
  /** Largura e altura do bloco do próprio nó (nó + coluna lateral). */
  ownW: number;
  ownH: number;
}

/** O tamanho declarado no nó (o cabeçalho do projeto é esticado no layout); senão, o fixo do tipo. */
function sizeOf(n: BoardNode) {
  const s = SIZES[n.type as BoardNodeType];
  return { w: n.width ?? s.w, h: n.height ?? s.h };
}

/**
 * Cabeçalho da sala (projeto ou "você"): colado nas bordas, na largura toda; embaixo, a equipe à
 * esquerda e a coluna de recursos (agents/skills) à direita.
 */
function isHeaderNode(n: BoardNode): boolean {
  return n.type === 'project' || n.type === 'user';
}
const isHeader = (t: Tree) => isHeaderNode(t.node);

function sideBox(side: BoardNode[]) {
  if (!side.length) return { w: 0, h: 0 };
  const sizes = side.map(sizeOf);
  return {
    w: Math.max(...sizes.map((s) => s.w)),
    h: sizes.reduce((sum, s) => sum + s.h, 0) + SIDE_ROW_GAP * (side.length - 1),
  };
}

function measure(t: Tree, memo: Map<Tree, Box>): Box {
  const cached = memo.get(t);
  if (cached) return cached;
  const own = sizeOf(t.node);
  const side = sideBox(t.side);
  const kids = t.children.map((c) => measure(c, memo));
  const rowW = kids.reduce((s, b) => s + b.w, 0) + GAP_X * Math.max(0, kids.length - 1);
  const kidsH = kids.length ? Math.max(...kids.map((b) => b.h)) : 0;
  let box: Box;
  if (isHeader(t)) {
    // Cabeçalho em cima (começa na folga da moldura, por isso o -ROOM_PAD); a coluna de recursos
    // fica à direita da fileira de filhos, na mesma altura.
    const sideW = t.side.length ? side.w + (kids.length ? SIDE_GAP : 0) : 0;
    const w = Math.max(own.w, rowW + sideW);
    const below = Math.max(kidsH, side.h);
    box = { w, h: own.h - ROOM_PAD + (below ? LEVEL_GAP + below : 0), ownW: w, ownH: own.h };
  } else {
    const ownW = own.w + (t.side.length ? SIDE_GAP + side.w : 0);
    const ownH = Math.max(own.h, side.h);
    box = { w: ownW, h: ownH, ownW, ownH };
    if (kids.length) box = { w: Math.max(ownW, rowW), h: ownH + LEVEL_GAP + kidsH, ownW, ownH };
  }
  memo.set(t, box);
  return box;
}

function place(t: Tree, x: number, y: number, memo: Map<Tree, Box>, nodes: BoardNode[], edges: BoardEdge[]) {
  const box = measure(t, memo);
  const own = sizeOf(t.node);
  const kids = t.children.map((c) => measure(c, memo));
  const rowW = kids.reduce((s, b) => s + b.w, 0) + GAP_X * Math.max(0, kids.length - 1);

  if (isHeader(t)) {
    // Cabeçalho colado nas bordas da sala: ocupa a folga da moldura e vai de um lado ao outro.
    const side = sideBox(t.side);
    t.node.width = box.w + ROOM_PAD * 2;
    t.node.position = { x: x - ROOM_PAD, y: y - ROOM_PAD };
    const data = t.node.data as UserNodeData | ProjectNodeData;
    data.header = { ...data.header, sideAt: t.side.length ? box.w + ROOM_PAD - side.w / 2 : null };
    nodes.push(t.node);
    const cy = y - ROOM_PAD + own.h + LEVEL_GAP;
    // Recursos: coluna encostada na borda direita; uma linha tracejada desce do cabeçalho e passa
    // por todos eles (estante aberta primeiro, depois o que está nela).
    let sy = cy;
    let from: { id: string; handle: string } = { id: t.node.id, handle: HANDLE.side };
    for (const s of t.side) {
      s.position = { x: x + box.w - sizeOf(s).w, y: sy };
      nodes.push(s);
      edges.push(edge(from.id, s.id, 'side', from.handle, HANDLE.top));
      from = { id: s.id, handle: HANDLE.bottom };
      sy += sizeOf(s).h + SIDE_ROW_GAP;
    }
    const areaW = box.w - (t.side.length ? side.w + SIDE_GAP : 0);
    let cx = x + (areaW - rowW) / 2;
    t.children.forEach((child, i) => {
      place(child, cx, cy, memo, nodes, edges);
      edges.push(edge(t.node.id, child.node.id, 'contains', HANDLE.bottom, HANDLE.top));
      cx += kids[i]!.w + GAP_X;
    });
    return;
  }

  // O nó fica centrado sobre os filhos; a coluna lateral vai à direita dele.
  const nodeX = t.children.length ? x + (box.w - rowW) / 2 + rowW / 2 - own.w / 2 : x + (box.w - box.ownW) / 2;
  const clampedX = Math.min(Math.max(nodeX, x), x + box.w - box.ownW);
  t.node.position = { x: clampedX, y };
  nodes.push(t.node);

  let sy = y;
  for (const s of t.side) {
    s.position = { x: clampedX + own.w + SIDE_GAP, y: sy };
    nodes.push(s);
    edges.push(edge(t.node.id, s.id, 'side', HANDLE.rightOut, HANDLE.leftIn));
    sy += sizeOf(s).h + SIDE_ROW_GAP;
  }

  let cx = x + (box.w - rowW) / 2;
  const cy = y + box.ownH + LEVEL_GAP;
  t.children.forEach((child, i) => {
    place(child, cx, cy, memo, nodes, edges);
    edges.push(edge(t.node.id, child.node.id, 'contains', HANDLE.bottom, HANDLE.top));
    cx += kids[i]!.w + GAP_X;
  });
}

function edge(source: string, target: string, kind: BoardEdgeData['kind'], sourceHandle: string, targetHandle: string): BoardEdge {
  return { id: `${kind}:${source}->${target}`, source, target, sourceHandle, targetHandle, type: 'rough', data: { kind } };
}

/** Gestores extras: lateral se estão no mesmo nível, de cima para baixo nos outros casos. */
function managerEdges(extra: Array<{ projectId: string; staff: StaffProfile; managerId: string }>, nodes: BoardNode[]): BoardEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: BoardEdge[] = [];
  for (const { projectId, staff, managerId } of extra) {
    const from = byId.get(staffNodeId(projectId, managerId));
    const to = byId.get(staffNodeId(projectId, staff.id));
    if (!from || !to) continue;
    const sameLevel = Math.abs(from.position.y - to.position.y) < 1;
    if (sameLevel) {
      const leftToRight = from.position.x < to.position.x;
      out.push(
        edge(from.id, to.id, 'calls', leftToRight ? HANDLE.rightOut : HANDLE.leftOut, leftToRight ? HANDLE.leftIn : HANDLE.rightIn),
      );
    } else {
      out.push(edge(from.id, to.id, 'calls', HANDLE.bottom, HANDLE.top));
    }
  }
  return out;
}

// ---- vínculos ----

/**
 * Liga a origem de um symlink/junction ao item emprestado, quando a origem também está no quadro.
 * Item guardado em estante fechada é representado pela estante.
 */
function borrowEdges(nodes: BoardNode[], shelved: Array<{ item: BoardNode; shelfId: string }>): BoardEdge[] {
  const items = [...nodes.map((n) => ({ item: n, id: n.id })), ...shelved.map((s) => ({ item: s.item, id: s.shelfId }))];
  const byPath = new Map<string, string>();
  for (const { item, id } of items) {
    const p = itemPath(item);
    if (p) byPath.set(pathKey(p), id);
  }
  const edges = new Map<string, BoardEdge>();
  for (const { item, id } of items) {
    const target = linkTarget(item);
    if (!target) continue;
    const origin = byPath.get(pathKey(target));
    if (!origin || origin === id) continue;
    const eid = `b:${origin}->${id}`;
    edges.set(eid, { ...edge(origin, id, 'borrow', HANDLE.bottom, HANDLE.top), id: eid });
  }
  return [...edges.values()];
}

function itemPath(n: BoardNode): string | null {
  if (n.type === 'agent') return n.data.agent.filePath;
  if (n.type === 'skill') return n.data.skill.dirPath;
  return null;
}

function linkTarget(n: BoardNode): string | null {
  if (n.type === 'agent') return n.data.agent.link.target;
  if (n.type === 'skill') return n.data.skill.link.target;
  return null;
}

/** Comparação de caminhos sem distinção de caixa nem de barra (Windows). */
export function pathKey(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}
