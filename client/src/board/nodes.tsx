import { Handle, Position, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { GitState, LiveSession } from '../../../shared/model';
import { employeeName, ENTRYPOINT_LABEL, formatAgo, formatShare, initials, STATUS_LABEL } from '../format';
import { BranchIcon, TasksIcon } from '../icons';
import {
  HANDLE,
  SIZES,
  type AgentNodeData,
  type BoardNodeType,
  type EmployeeNodeData,
  type HeaderData,
  type ProjectNodeData,
  type RoomNodeData,
  type ShelfNodeData,
  type SkillNodeData,
  type SyncedNodeData,
  type UserNodeData,
} from './layout';
import { Sketch, type SketchVariant } from './sketch';

function Frame(props: {
  id: string;
  type: BoardNodeType;
  variant: SketchVariant;
  selected: boolean;
  className?: string;
  title?: string;
  /** Mostra o "+" (ao passar o mouse) para arrastar e contratar um subordinado. */
  canHire?: boolean;
  /** Largura dada pelo layout (o cabeçalho da sala estica até as bordas); sem ela, a fixa do tipo. */
  width?: number;
  /** Variáveis CSS do cabeçalho (a cor da parede). */
  style?: CSSProperties;
  /** Cabeçalho: onde sai a linha para a coluna de recursos (px da esquerda). */
  sideAt?: number | null;
  children: ReactNode;
}) {
  const w = props.width ?? SIZES[props.type].w;
  const h = SIZES[props.type].h;
  return (
    <div
      className={`bn bn-${props.type} ${props.selected ? 'is-selected' : ''} ${props.className ?? ''}`}
      style={{ width: w, height: h, ...props.style }}
      title={props.title}
    >
      <Sketch variant={props.variant} width={w} height={h} seed={props.id} />
      <Handle id={HANDLE.top} type="target" position={Position.Top} isConnectable={false} />
      <Handle id={HANDLE.leftIn} type="target" position={Position.Left} isConnectable={false} />
      <Handle id={HANDLE.leftOut} type="source" position={Position.Left} isConnectable={false} />
      <Handle id={HANDLE.rightIn} type="target" position={Position.Right} isConnectable={false} />
      <Handle id={HANDLE.rightOut} type="source" position={Position.Right} isConnectable={false} />
      <div className="bn-body">{props.children}</div>
      <Handle id={HANDLE.bottom} type="source" position={Position.Bottom} isConnectable={false} />
      {props.sideAt != null && (
        <Handle id={HANDLE.side} type="source" position={Position.Bottom} isConnectable={false} style={{ left: props.sideAt }} />
      )}
      {props.canHire && (
        <Handle
          id={HANDLE.hire}
          type="source"
          position={Position.Bottom}
          className="bn-hire"
          title="Arraste para contratar um subordinado (ou solte sobre um funcionário para ligar)"
        >
          +
        </Handle>
      )}
    </div>
  );
}

function Portrait({ id, label, src }: { id: string; label: string; src?: string | null }) {
  // O servidor reinicia a cada arquivo salvo em desenvolvimento: uma foto pedida nessa hora falha.
  // Tenta de novo duas vezes; depois, mostra as iniciais em vez do ícone de imagem quebrada.
  const [tries, setTries] = useState(0);
  useEffect(() => setTries(0), [src]);
  const shown = src && tries <= 2 ? (tries ? `${src}${src.includes('?') ? '&' : '?'}retry=${tries}` : src) : null;
  return (
    <div className="bn-portrait">
      {shown ? (
        <img src={shown} alt="" draggable={false} onError={() => setTimeout(() => setTries((t) => t + 1), 1500 * (tries + 1))} />
      ) : (
        <span>{initials(label)}</span>
      )}
      <Sketch variant="portrait" shape="ellipse" width={40} height={40} seed={`${id}:p`} />
    </div>
  );
}

export const portraitUrl = (projectId: string, staffId: string) => `/api/projects/${projectId}/staff/${staffId}/portrait`;

/** Cor da parede da sala no cabeçalho (`--room-wall`); sem cor escolhida, o CSS usa a parede padrão. */
const headerStyle = (h: HeaderData): CSSProperties | undefined =>
  h.color ? ({ '--room-wall': `var(--pen-${h.color})` } as CSSProperties) : undefined;

/** Seta de dobrar/abrir a sala; o clique é tratado no quadro (Board.tsx), pela classe. */
function CollapseToggle({ collapsed }: { collapsed: boolean }) {
  return (
    <button
      type="button"
      className="bn-collapse nodrag"
      title={collapsed ? 'Abrir a sala' : 'Dobrar a sala (fica só o cabeçalho)'}
      aria-label={collapsed ? 'Abrir a sala' : 'Dobrar a sala'}
      aria-expanded={!collapsed}
    >
      {collapsed ? '▸' : '▾'}
    </button>
  );
}

const resourcesText = (n: number) => (n ? ` · ${n} ${n === 1 ? 'agent/skill' : 'agents/skills'}` : '');

/** Cabeçalho da sala "você", colado nas bordas, como o do projeto. */
function UserNode({ id, data, selected, width }: NodeProps<Node<UserNodeData, 'user'>>) {
  return (
    <Frame id={id} type="user" variant="header" selected={selected} width={width} style={headerStyle(data.header)} sideAt={data.header.sideAt}>
      <div className="bn-header">
        <CollapseToggle collapsed={data.header.collapsed} />
        <div className="bn-header-text">
          <div className="bn-title">~ você</div>
          <div className="bn-meta">global · {data.agentCount} agents · {data.skillCount} skills</div>
        </div>
      </div>
    </Frame>
  );
}

/** Cabeçalho da sala: faixa colada nas bordas, na cor da parede, com nome à esquerda e quem está ao vivo à direita. */
function ProjectNode({ id, data, selected, width }: NodeProps<Node<ProjectNodeData, 'project'>>) {
  const p = data.project;
  return (
    <Frame
      id={id}
      type="project"
      variant="header"
      selected={selected}
      className={`${p.exists ? '' : 'is-missing'} ${data.archived ? 'is-archived' : ''} ${data.image ? 'has-image' : ''} ${data.header.color ? 'has-color' : ''}`}
      title={p.path}
      canHire={p.exists}
      width={width}
      style={headerStyle(data.header)}
      sideAt={data.header.sideAt}
    >
      <div className="bn-header">
        <CollapseToggle collapsed={data.header.collapsed} />
        {data.image && <img className="bn-header-img" src={data.image} alt="" draggable={false} />}
        <div className="bn-header-text">
          <div className="bn-title">
            {p.worktreeOf && <span className="bn-tag">worktree</span>}
            {data.archived && <span className="bn-tag">arquivado</span>}
            {p.name}
          </div>
          <div className="bn-meta">
            {p.sessionCount} {p.sessionCount === 1 ? 'funcionário' : 'funcionários'}
            {data.header.collapsed && resourcesText(data.header.resources)}
            {data.header.collapsed && data.costShare !== null && (
              <span title="Parte do projeto no consumo total"> · {formatShare(data.costShare, 1)}</span>
            )}
            {!p.exists && ' · pasta não existe'}
          </div>
        </div>
        <TasksChip tasks={data.tasks} />
        {data.git && <GitBadge git={data.git} />}
        {data.live.length > 0 && <LiveDots live={data.live} />}
      </div>
    </Frame>
  );
}

function EmployeeNode({ id, data, selected }: NodeProps<Node<EmployeeNodeData, 'employee'>>) {
  const { session: s, staff } = data;
  const name = staff?.name ?? (s ? employeeName(s) : '?');
  const live = s?.live?.alive ? s.live : null;
  const busy = live?.status === 'busy';
  const state = data.archived ? 'is-archived' : busy ? 'is-busy' : live?.status === 'waiting' ? 'is-waiting' : live ? '' : 'is-away';
  return (
    <Frame
      id={id}
      type="employee"
      variant={live?.status === 'waiting' ? 'warn' : busy ? 'busy' : 'agent'}
      selected={selected}
      className={state}
      title={staff ? `${staff.name} — ${staff.role}` : name}
      canHire={!!staff && !data.archived}
    >
      <div className="bn-agent">
        <div className="bn-portrait-wrap">
          <Portrait id={id} label={name} src={staff?.portrait ? portraitUrl(data.projectId, staff.id) : null} />
          {/* Lápis que "escreve" enquanto a sessão trabalha. */}
          {busy && <span className="bn-pencil" aria-hidden="true">✎</span>}
        </div>
        <div className="bn-agent-text">
          <div className="bn-title bn-title-sm">{name}</div>
          <div className="bn-meta">
            {staff && <span className="bn-role">{staff.role} · </span>}
            {live ? (
              <>
                <span className={`dot dot-${live.status ?? 'unknown'}`} />{' '}
                {busy ? <span className="bn-working">trabalhando</span> : (STATUS_LABEL[live.status ?? ''] ?? live.status)}
                {/* Delegando agora: para quem (inclui agents embutidos, que não têm nó no quadro). */}
                {live.activeAgents && live.activeAgents.length > 0 && (
                  <span className="bn-delegating" title={`Delegando para: ${live.activeAgents.join(', ')}`}>
                    {' '}→ {live.activeAgents.join(', ')}
                  </span>
                )}
              </>
            ) : s ? (
              formatAgo(Date.now() - Date.parse(s.updatedAt))
            ) : (
              'contratado, sem sessão'
            )}
            {data.costShare !== null && (
              <span title="Parte deste funcionário no consumo total"> · {formatShare(data.costShare, 1)}</span>
            )}
            {!staff && s?.entrypoint && <> · {ENTRYPOINT_LABEL[s.entrypoint] ?? s.entrypoint}</>}
          </div>
        </div>
      </div>
    </Frame>
  );
}

function AgentNode({ id, data, selected }: NodeProps<Node<AgentNodeData, 'agent'>>) {
  const a = data.agent;
  const borrowed = a.link.kind !== 'file';
  return (
    <Frame
      id={id}
      type="agent"
      variant={a.duplicate || a.error ? 'warn' : 'agent'}
      selected={selected}
      className="bn-agent-def"
      title={a.description ?? a.name}
    >
      <div className="bn-agent">
        <Portrait id={id} label={a.name} />
        <div className="bn-agent-text">
          <div className="bn-title bn-title-sm">{a.name}</div>
          <div className="bn-meta">
            {borrowed && <span className="bn-flag bn-flag-link">↪ emprestado</span>}
            {a.duplicate && <span className="bn-flag bn-flag-warn">nome repetido</span>}
            {a.error && <span className="bn-flag bn-flag-warn">erro</span>}
            {!borrowed && !a.duplicate && !a.error && 'agent'}
            {data.cost && (
              <span title="Parte deste agent no consumo de todos os subagents">
                {' '}· {formatShare(data.cost.share, 1)} em {data.cost.runs} {data.cost.runs === 1 ? 'execução' : 'execuções'}
              </span>
            )}
          </div>
        </div>
      </div>
    </Frame>
  );
}

function SkillNode({ id, data, selected }: NodeProps<Node<SkillNodeData, 'skill'>>) {
  const s = data.skill;
  return (
    <Frame id={id} type="skill" variant={s.error ? 'warn' : 'skill'} selected={selected} title={s.description ?? s.name}>
      <div className="bn-title bn-title-sm">{s.name}</div>
      <div className="bn-meta">{s.link.kind !== 'file' ? <span className="bn-flag bn-flag-link">↪ emprestada</span> : 'skill'}</div>
    </Frame>
  );
}

function SyncedNode({ id, data, selected }: NodeProps<Node<SyncedNodeData, 'synced'>>) {
  return (
    <Frame id={id} type="synced" variant="synced" selected={selected} title={data.skills.map((s) => s.name).join(', ')}>
      <div className="bn-title bn-title-sm">{data.skills.length} skills da conta</div>
      <div className="bn-meta">sincronizadas · somente leitura</div>
    </Frame>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Estante: agents e skills guardados num nó só; clicar abre ou fecha (ver Board.tsx). */
function ShelfNode({ id, data, selected }: NodeProps<Node<ShelfNodeData, 'shelf'>>) {
  const { w, h } = SIZES.shelf;
  return (
    <div className="bn-shelf-wrap">
      {/* Uma segunda folha por trás, deslocada: lê como pilha de cartões. */}
      {!data.expanded && <Sketch className="bn-shelf-back" variant="agent" width={w} height={h} seed={`${id}:back`} />}
      <Frame id={id} type="shelf" variant="agent" selected={selected} className={data.expanded ? 'is-open' : ''}>
        <div className="bn-title bn-title-sm">
          {data.agents > 0 && <span>{plural(data.agents, 'agent', 'agents')}</span>}
          {data.agents > 0 && data.skills > 0 && ' · '}
          {data.skills > 0 && <span className="bn-shelf-skills">{plural(data.skills, 'skill', 'skills')}</span>}
        </div>
        <div className="bn-meta">{data.expanded ? '▴ guardar na estante' : '▾ abrir a estante'}</div>
      </Frame>
    </div>
  );
}

/** Moldura da sala: só a parede; o tamanho acompanha os nós de dentro. */
function RoomNode({ id, data, width, height }: NodeProps<Node<RoomNodeData, 'room'>>) {
  const w = width ?? 0;
  const h = height ?? 0;
  const style = { width: w, height: h, ...(data.color ? { '--room-wall': `var(--pen-${data.color})` } : {}) } as CSSProperties;
  return (
    <div className={`bn-room ${data.color ? 'has-color' : ''}`} style={style}>
      <Sketch variant={data.color ? 'room-color' : 'room'} width={w} height={h} seed={id} />
    </div>
  );
}

/** Tarefas do projeto no cabeçalho; o clique abre o quadro de tarefas (tratado no Board, pela classe). */
function TasksChip({ tasks }: { tasks: { open: number; review: number } | null }) {
  const label = tasks ? `${tasks.open} ${tasks.open === 1 ? 'tarefa' : 'tarefas'}` : 'tarefas';
  return (
    <button
      type="button"
      className={`bn-tasks nodrag ${tasks?.review ? 'has-review' : ''} ${tasks ? '' : 'is-empty'}`}
      title={tasks?.review ? `${tasks.review} em revisão: abrir o quadro de tarefas` : 'Abrir o quadro de tarefas'}
    >
      <TasksIcon /> {label}
      {tasks?.review ? <span className="bn-tasks-review">{tasks.review} p/ revisar</span> : null}
    </button>
  );
}

/** Estado do código no cabeçalho: branch, arquivos sem commit e distância do remoto. */
function GitBadge({ git }: { git: GitState }) {
  const parts = [
    git.dirty ? `${git.dirty} sem commit` : 'limpo',
    git.ahead ? `↑${git.ahead}` : null,
    git.behind ? `↓${git.behind}` : null,
  ].filter(Boolean);
  const tip = [
    `branch ${git.branch ?? '(destacado)'}`,
    git.dirty ? `${git.dirty} ${git.dirty === 1 ? 'arquivo alterado' : 'arquivos alterados'} sem commit` : 'nada sem commit',
    git.upstream ? `${git.ahead} à frente e ${git.behind} atrás de ${git.upstream}` : 'sem remoto configurado',
  ].join('\n');
  return (
    <div className={`bn-git ${git.dirty ? 'is-dirty' : ''} ${git.behind ? 'is-behind' : ''}`} title={tip}>
      <span className="bn-git-branch">
        <BranchIcon /> {git.branch ?? 'destacado'}
      </span>
      <span className="bn-git-state">{parts.join(' ')}</span>
    </div>
  );
}

function LiveDots({ live }: { live: LiveSession[] }) {
  const waiting = live.filter((s) => s.status === 'waiting').length;
  return (
    <div className="bn-live" title={live.map((s) => `${s.name ?? s.sessionId.slice(0, 8)}: ${STATUS_LABEL[s.status ?? ''] ?? s.status}`).join('\n')}>
      {live.map((s) => (
        <span key={s.sessionId} className={`dot dot-${s.status ?? 'unknown'}`} />
      ))}
      <span>{waiting > 0 ? `${waiting} aguardando você` : `${live.length} ao vivo`}</span>
    </div>
  );
}

export const nodeTypes: NodeTypes = {
  user: UserNode,
  project: ProjectNode,
  employee: EmployeeNode,
  agent: AgentNode,
  skill: SkillNode,
  synced: SyncedNode,
  shelf: ShelfNode,
  room: RoomNode,
};
