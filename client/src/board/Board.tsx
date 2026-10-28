import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  Panel,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  getViewportForBounds,
  type FinalConnectionState,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppConfig, Board, BoardBackground, CostReport, GitState, InboxItem, ProjectColor, SendPriority, UiLevel, UsageStop } from '../../../shared/model';
import { InboxMenu } from '../inbox/InboxMenu';
import type { InboxView } from '../inbox/useInbox';
import { EdgeActions, edgeTypes } from './edges';
import { buildGraph, HANDLE, RANKING_ID, roomFrame, type BoardNode, type StaffLink } from './layout';
import { nodeTypes } from './nodes';
import { ChartIcon } from '../icons';
import { SettingsMenu } from '../toolbar/SettingsMenu';
import { AuthBadge, CompanyTitle, UsageMeters } from '../toolbar/Toolbar';
import { t } from '../i18n';

// Posições arrastadas ficam no navegador por enquanto; vão para `.myco/` quando houver escrita no disco.
// v3: as salas passaram a formar uma grade; as posições da v2 (uma linha só) não servem mais.
const POSITIONS_KEY = 'myco.positions.v3';
/** Estantes abertas e salas dobradas: conveniência por navegador. */
const SHELVES_KEY = 'myco.shelves';
const COLLAPSED_KEY = 'myco.collapsedRooms';

function loadList(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function saveList(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // armazenamento indisponível: vale só nesta aba
  }
}

const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((s) => s !== id) : [...list, id]);

function loadPositions(): Record<string, XYPosition> {
  try {
    return JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? '{}') as Record<string, XYPosition>;
  } catch {
    return {};
  }
}

function savePositions(positions: Record<string, XYPosition>) {
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  } catch {
    // armazenamento indisponível: as posições valem só nesta aba
  }
}

interface BoardViewProps {
  board: Board;
  config: AppConfig | null;
  costs: CostReport | null;
  /** Estado do código por projeto, para o cabeçalho das salas. */
  git: Record<string, GitState>;
  /** Tarefas em aberto por projeto (chip no cabeçalho, que abre o quadro de tarefas). */
  tasks: Record<string, { open: number; review: number }>;
  onOpenTasks: (projectId: string) => void;
  showWorktrees: boolean;
  onToggleWorktrees: (value: boolean) => void;
  showArchived: boolean;
  onToggleArchived: (value: boolean) => void;
  animations: boolean;
  onToggleAnimations: (value: boolean) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** A caixa "precisa de mim" (lida no App, que também mostra as notificações). */
  inbox: InboxView;
  onOpenInbox: (item: InboxItem) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onRename: (name: string) => Promise<void>;
  onUsageStop: (stop: UsageStop) => Promise<void>;
  onSendWhileBusy: (p: SendPriority) => Promise<void>;
  onUiLevel: (level: UiLevel) => Promise<void>;
  onProjectColor: (projectId: string, color: ProjectColor | null) => Promise<void>;
  onBoardBackground: (bg: Partial<BoardBackground>) => Promise<void>;
  onProjectBudget: (projectId: string, budget: number | null) => Promise<void>;
  /** URL da imagem de cada projeto. */
  images: Record<string, string>;
  /** "+" solto no vazio (ou clicado): contratar no projeto, reportando a `managerId` (null = você). */
  onHireFrom: (projectId: string, managerId: string | null) => void;
  /** "+" de um funcionário solto sobre outro: `managerId` passa a também chamar `staffId`. */
  onLink: (projectId: string, staffId: string, managerId: string) => void;
  /** Botão na linha entre dois funcionários: `managerId` deixa de chamar `staffId`. */
  onUnlink: (link: StaffLink) => void;
}

/** De onde saiu o "+": projeto (`p:<id>`) ou funcionário com ficha (`h:<projeto>:<ficha>`). */
function parseHireSource(nodeId: string): { projectId: string; staffId: string | null } | null {
  if (nodeId.startsWith('p:')) return { projectId: nodeId.slice(2), staffId: null };
  const m = /^h:([^:]+):(.+)$/.exec(nodeId);
  return m ? { projectId: m[1]!, staffId: m[2]! } : null;
}

export function BoardView(props: BoardViewProps) {
  const { board, config, costs, git, tasks, showWorktrees, showArchived, selectedId, onSelect } = props;
  const [shelves, setShelves] = useState(() => loadList(SHELVES_KEY));
  const [collapsed, setCollapsed] = useState(() => loadList(COLLAPSED_KEY));
  // Proporção da tela usada na planta: medida na abertura e a cada "reorganizar" (não a cada
  // redimensionamento, para o quadro não se rearrumar sozinho enquanto você mexe na janela).
  const [aspect, setAspect] = useState(measureAspect);
  const graph = useMemo(
    () =>
      buildGraph(
        board,
        {
          showWorktrees,
          showArchived,
          archived: config?.archived,
          costs,
          expandedShelves: shelves,
          projectColors: config?.projectColors,
          collapsedRooms: collapsed,
          git,
          tasks,
          aspect,
        },
        props.images,
      ),
    [board, showWorktrees, showArchived, config?.archived, costs, shelves, props.images, config?.projectColors, collapsed, git, tasks, aspect],
  );
  // Salas de projeto no quadro agora, na ordem da planta: as que o menu de cores lista.
  const rooms = useMemo(
    () =>
      graph.nodes.flatMap((n) => {
        if (n.type !== 'room' || !n.data.owner.startsWith('p:')) return [];
        const id = n.data.owner.slice(2);
        return [{ id, name: board.projects.find((p) => p.id === id)?.name ?? id }];
      }),
    [graph, board.projects],
  );
  const toggleShelf = (id: string) =>
    setShelves((prev) => {
      const next = toggleIn(prev, id);
      saveList(SHELVES_KEY, next);
      return next;
    });
  const toggleRoom = (id: string) =>
    setCollapsed((prev) => {
      const next = toggleIn(prev, id);
      saveList(COLLAPSED_KEY, next);
      return next;
    });

  /** Fim do último arrasto do "+": o clique que vem logo depois não deve contratar de novo. */
  const connectEndedAt = useRef(0);

  // O "+" é uma alça de conexão: arrastar mostra a linha; soltar decide o que fazer.
  // Solto sobre outro funcionário com ficha (do mesmo projeto) = vínculo; solto no vazio ou só
  // clicado = contratar um novo, já subordinado.
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.fromHandle?.id !== HANDLE.hire || !state.fromNode) return;
      const from = parseHireSource(state.fromNode.id);
      if (!from) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      // Todos os elementos sob o ponteiro: a linha arrastada ou um rótulo podem estar por cima do cartão.
      const under = point ? document.elementsFromPoint(point.clientX, point.clientY) : [];
      const dropId =
        under
          .map((el) => el.closest('.react-flow__node')?.getAttribute('data-id') ?? null)
          .find((id) => id && id !== state.fromNode!.id && !id.startsWith('r:')) ?? null;
      const onto = dropId ? parseHireSource(dropId) : null;
      connectEndedAt.current = Date.now();
      if (from.staffId && onto?.staffId && onto.projectId === from.projectId) props.onLink(from.projectId, onto.staffId, from.staffId);
      else props.onHireFrom(from.projectId, from.staffId);
    },
    [props.onLink, props.onHireFrom],
  );
  const archivedCount = (config?.archived.projects.length ?? 0) + (config?.archived.sessions.length ?? 0);
  const [saved, setSaved] = useState(loadPositions);
  const [nodes, setNodes] = useState<BoardNode[]>(() => fitRooms(withSaved(graph.nodes, saved)));
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const { getNodes, getNodesBounds, setViewport } = useReactFlow();

  useEffect(() => {
    setNodes(fitRooms(withSaved(graph.nodes, saved)));
  }, [graph, saved]);

  // A grade de salas cabe na tela: enquadra o escritório inteiro.
  const nodesReady = useNodesInitialized();
  // O topo (nome, consumo, menu) fica por cima do quadro: enquadra só na área abaixo dele,
  // senão as salas da primeira linha ficam escondidas atrás.
  const fitStart = useCallback(() => {
    const all = getNodes();
    const container = document.querySelector<HTMLElement>('.react-flow');
    if (!all.length || !container) return;
    const area = container.getBoundingClientRect();
    const toolbar = container.querySelector<HTMLElement>('.toolbar');
    const top = toolbar ? Math.max(0, toolbar.getBoundingClientRect().bottom - area.top) + 8 : 0;
    const vp = getViewportForBounds(getNodesBounds(all), area.width, Math.max(100, area.height - top), 0.1, 1, 0.06);
    void setViewport({ x: vp.x, y: vp.y + top, zoom: vp.zoom }, { duration: 300 });
  }, [getNodes, getNodesBounds, setViewport]);
  // Enquadra uma vez, na abertura. `nodesReady` volta a piscar (false → true) a cada atualização ao
  // vivo e ao abrir uma estante; reenquadrar nessas horas tiraria o zoom de quem está lendo uma sala.
  const fitted = useRef(false);
  useEffect(() => {
    if (!nodesReady || fitted.current) return;
    fitted.current = true;
    fitStart();
  }, [nodesReady, fitStart]);
  // Mostrar/esconder worktrees ou arquivados é um pedido explícito: aí, sim, reenquadra.
  const toggles = useRef({ showWorktrees, showArchived });
  useEffect(() => {
    const prev = toggles.current;
    toggles.current = { showWorktrees, showArchived };
    if (fitted.current && (prev.showWorktrees !== showWorktrees || prev.showArchived !== showArchived)) setTimeout(fitStart, 50);
  }, [showWorktrees, showArchived, fitStart]);

  // A seleção é controlada pelo App (painel lateral); aqui só entram arrastos e medições.
  // Arrastar a sala leva junto tudo que está dentro dela; a moldura sempre se reajusta aos nós.
  const onNodesChange = useCallback((changes: NodeChange<BoardNode>[]) => {
    setNodes((ns) => {
      const byId = new Map(ns.map((n) => [n.id, n]));
      const relevant = changes.filter((c) => c.type === 'position' || c.type === 'dimensions');
      const moved: NodeChange<BoardNode>[] = [];
      for (const c of relevant) {
        const room = c.type === 'position' && c.position ? byId.get(c.id) : undefined;
        if (room?.type !== 'room' || c.type !== 'position' || !c.position) continue;
        const dx = c.position.x - room.position.x;
        const dy = c.position.y - room.position.y;
        for (const id of room.data.members) {
          const m = byId.get(id);
          if (m) moved.push({ type: 'position', id, position: { x: m.position.x + dx, y: m.position.y + dy } });
        }
      }
      return fitRooms(applyNodeChanges([...relevant, ...moved], ns));
    });
  }, []);

  const onNodeDragStop = useCallback((_: unknown, __: BoardNode, dragged: BoardNode[]) => {
    // A sala não tem posição própria: salva a dos nós de dentro.
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
    const toSave = dragged.flatMap((n) =>
      n.type === 'room' ? n.data.members.map((id) => byId.get(id)).filter((m): m is BoardNode => !!m) : [n],
    );
    setSaved((prev) => {
      const next = { ...prev };
      for (const n of toSave) next[n.id] = n.position;
      savePositions(next);
      return next;
    });
  }, []);

  const onNodeClick = (event: React.MouseEvent, n: BoardNode) => {
    // Clique simples no "+" (sem arrastar): o React Flow não chama onConnectEnd, então contrata aqui.
    if ((event.target as Element).closest('.bn-hire')) {
      const from = parseHireSource(n.id);
      if (from && Date.now() - connectEndedAt.current > 300) props.onHireFrom(from.projectId, from.staffId);
      return;
    }
    // Seta do cabeçalho: dobra ou abre a sala, sem abrir o painel do projeto.
    if ((event.target as Element).closest('.bn-collapse')) return toggleRoom(n.id);
    // Chip de tarefas do cabeçalho: abre o quadro de tarefas do projeto.
    if ((event.target as Element).closest('.bn-tasks') && n.id.startsWith('p:')) return props.onOpenTasks(n.id.slice(2));
    if (n.type === 'shelf') toggleShelf(n.id);
    // Clicar na parede da sala é clicar no projeto dela.
    else if (n.type === 'room') onSelect(n.data.owner);
    else onSelect(n.id);
  };

  const resetLayout = () => {
    savePositions({});
    setSaved({});
    setAspect(measureAspect());
    setTimeout(fitStart, 80);
  };

  const displayNodes = useMemo(
    () => nodes.map((n) => (n.selected === (n.id === selectedId) ? n : { ...n, selected: n.id === selectedId })),
    [nodes, selectedId],
  );

  const edgeActions = useMemo(() => ({ onUnlink: props.onUnlink }), [props.onUnlink]);

  return (
    <EdgeActions.Provider value={edgeActions}>
    <ReactFlow
      nodes={displayNodes}
      edges={graph.edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={onNodeClick}
      onPaneClick={() => onSelect(null)}
      // Só o "+" conecta; nenhuma aresta é criada pelo React Flow (o MyCo decide no onConnectEnd).
      nodesConnectable
      // Clicar no "+" é contratar (ver onNodeClick), não o modo "clique para ligar" do React Flow.
      connectOnClick={false}
      isValidConnection={() => false}
      onConnectEnd={onConnectEnd}
      connectionLineStyle={{ stroke: 'var(--ink-blue)', strokeWidth: 2, strokeDasharray: '6 5' }}
      deleteKeyCode={null}
      minZoom={0.1}
      maxZoom={2}
      colorMode="system"
    >
      <Background variant={BackgroundVariant.Dots} gap={28} size={1.2} />
      <Controls showInteractive={false}>
        {/* Logo depois de "enquadrar": desfaz os arrastos e volta à grade de salas. */}
        <ControlButton onClick={resetLayout} title={t('board.resetLayoutTitle')} aria-label={t('board.resetLayout')}>
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect x="3" y="3" width="11" height="11" rx="2" />
            <rect x="18" y="3" width="11" height="11" rx="2" />
            <rect x="3" y="18" width="11" height="11" rx="2" />
            <rect x="18" y="18" width="11" height="11" rx="2" />
          </svg>
        </ControlButton>
      </Controls>
      <Panel position="top-left" className="toolbar">
        <CompanyTitle name={config?.companyName ?? 'MyCo'} onRename={props.onRename} />
        <UsageMeters />
        <AuthBadge />
        <span className="toolbar-sep" />
        <InboxMenu inbox={props.inbox} onOpen={props.onOpenInbox} />
        <button className="toolbar-icon" onClick={() => onSelect(RANKING_ID)} title={t('board.rankingTitle')} aria-label={t('board.ranking')}>
          <ChartIcon />
        </button>
        <SettingsMenu
          showWorktrees={showWorktrees}
          onToggleWorktrees={props.onToggleWorktrees}
          showArchived={showArchived}
          onToggleArchived={props.onToggleArchived}
          archivedCount={archivedCount}
          animations={props.animations}
          onToggleAnimations={props.onToggleAnimations}
          onRefresh={props.onRefresh}
          refreshing={props.refreshing}
          usageStop={config?.usageStop ?? null}
          onUsageStop={props.onUsageStop}
          sendWhileBusy={config?.sendWhileBusy ?? null}
          onSendWhileBusy={props.onSendWhileBusy}
          uiLevel={config?.uiLevel ?? null}
          onUiLevel={props.onUiLevel}
          rooms={rooms}
          projectColors={config?.projectColors ?? null}
          onProjectColor={props.onProjectColor}
          boardBackground={config?.boardBackground ?? null}
          onBoardBackground={props.onBoardBackground}
          projectBudgets={config?.projectBudgets ?? null}
          onProjectBudget={props.onProjectBudget}
        />
      </Panel>
      <Panel position="bottom-right" className="legend">
        <span className="legend-item legend-project">{t('board.legendProject')}</span>
        <span className="legend-item legend-agent">{t('board.legendEmployee')}</span>
        <span className="legend-item legend-skill">{t('board.skillWord')}</span>
        <span className="legend-item legend-calls">{t('board.alsoCalls')}</span>
        <span className="legend-item legend-borrow">{t('board.legendBorrow')}</span>
      </Panel>
    </ReactFlow>
    </EdgeActions.Provider>
  );
}

/**
 * Largura/altura da área livre do quadro: a do React Flow (ou da janela, antes de ele existir),
 * descontado o topo (nome, consumo, menu), que fica por cima.
 */
function measureAspect(): number {
  const container = document.querySelector<HTMLElement>('.react-flow');
  const area = container?.getBoundingClientRect() ?? { width: window.innerWidth, height: window.innerHeight, top: 0 };
  const toolbar = container?.querySelector<HTMLElement>('.toolbar');
  const top = toolbar ? Math.max(0, toolbar.getBoundingClientRect().bottom - area.top) : 60;
  return area.width / Math.max(100, area.height - top);
}

function withSaved(nodes: BoardNode[], saved: Record<string, XYPosition>): BoardNode[] {
  return nodes.map((n) => (saved[n.id] ? { ...n, position: saved[n.id]! } : n));
}

/** Reajusta cada moldura de sala aos nós dela (depois de arrastos ou posições salvas). */
function fitRooms(nodes: BoardNode[]): BoardNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.map((n) => {
    if (n.type !== 'room') return n;
    const frame = roomFrame(n.data.members.map((id) => byId.get(id)).filter((m): m is BoardNode => !!m));
    const same = frame.position.x === n.position.x && frame.position.y === n.position.y && frame.width === n.width && frame.height === n.height;
    return same ? n : { ...n, ...frame };
  });
}
