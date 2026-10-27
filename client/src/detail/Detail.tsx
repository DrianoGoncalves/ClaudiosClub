import { useEffect, useState } from 'react';
import type {
  Agent,
  CostReport,
  CostSummary,
  LinkInfo,
  LiveSession,
  Project,
  LaunchResult,
  ProjectColor,
  ProjectDetail,
  Session,
  Skill,
  StaffProfile,
  TaskSummary,
  UserScope,
} from '../../../shared/model';
import { TEMP_IDLE_DAYS } from '../../../shared/model';
import { api } from '../api';
import { RoomColorPicker } from '../board/colors';
import { portraitUrl } from '../board/nodes';
import { ChatView } from '../chat/ChatView';
import { BrowserCheck } from '../staff/BrowserCheck';
import { MAX_INPUT_BYTES, PROJECT_IMAGE_MAX, shrinkImage } from '../lib/shrinkImage';
import { Routines } from './Routines';
import { WorthIt } from './WorthIt';
import { employeeName, ENTRYPOINT_LABEL, formatShare, STATUS_LABEL } from '../format';

// Painel lateral: o que o nó selecionado no quadro tem por trás.

type ProjectCost = CostSummary & { sessions: Record<string, number> };

function ArchiveButton({
  archived,
  onArchive,
  what,
  restoreLabel = 'Desarquivar',
}: {
  archived: boolean;
  onArchive: (v: boolean) => Promise<void>;
  what: string;
  restoreLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const click = async () => {
    setBusy(true);
    setError(null);
    try {
      await onArchive(!archived);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="btn-secondary"
        onClick={click}
        disabled={busy}
        title={archived ? `Volta a mostrar ${what} no quadro` : `Esconde ${what} do quadro (nada é apagado do Claude Code)`}
      >
        {archived ? restoreLabel : 'Arquivar'}
      </button>
      {error && <span className="error">{error}</span>}
    </>
  );
}

export function EmployeePanel(props: {
  session: Session | null;
  staff: StaffProfile | null;
  managers: StaffProfile[];
  project: Project | null;
  costUsd: number | null;
  /** Consumo de todos, para mostrar a parte deste funcionário. */
  totalUsd: number;
  archived: boolean;
  onArchive: (v: boolean) => Promise<void>;
  onLaunch: (resume: boolean) => Promise<LaunchResult>;
  onHireSub: () => void;
  onEdit: () => void;
  onSessionStarted?: (sessionId: string) => void;
  /** A ficha mudou por aqui (rotinas): o quadro relê. */
  onChanged?: () => void;
}) {
  const { session: s, staff, project } = props;
  const live = s?.live?.alive ? s.live : null;
  const name = staff?.name ?? (s ? employeeName(s) : '?');
  return (
    <>
      <header className="header employee-header">
        {staff?.portrait && project && (
          <img className="employee-portrait" src={portraitUrl(project.id, staff.id)} alt={`Retrato de ${staff.name}`} />
        )}
        <div>
          <p className="kicker">funcionário{project ? ` · ${project.name}` : ''}</p>
          <h2>{name}</h2>
          {staff && <p className="employee-role">{staff.role}</p>}
          <p className="badges">
            {live ? (
              <span className="badge">
                <span className={`dot dot-${live.status ?? 'unknown'}`} /> {STATUS_LABEL[live.status ?? ''] ?? live.status}
              </span>
            ) : (
              <span className="badge dim">{s ? 'fora do expediente' : 'ainda sem sessão'}</span>
            )}
            {s?.entrypoint && <span className="badge">{ENTRYPOINT_LABEL[s.entrypoint] ?? s.entrypoint}</span>}
            {s?.gitBranch && <span className="badge dim">{s.gitBranch}</span>}
            {!staff && <span className="badge dim">sem ficha</span>}
            {staff?.temporary && <span className="badge warn">temporário</span>}
            {props.archived && <span className="badge dim">arquivado</span>}
          </p>
        </div>
        <button
          className="btn-secondary employee-edit"
          onClick={props.onEdit}
          title={staff ? 'Editar nome, retrato e ficha' : 'Dar nome, retrato e ficha a este funcionário (a sessão continua a mesma)'}
        >
          Editar
        </button>
      </header>
      {staff?.temporary && project && (
        <TempNotice staff={staff} managers={props.managers} projectId={project.id} archived={props.archived} onArchive={props.onArchive} onChanged={props.onChanged} />
      )}
      {staff?.browser && <BrowserCheck />}
      {project && (
        <ChatView
          key={`${s?.id ?? 'novo'}:${staff?.id ?? ''}`}
          projectId={project.id}
          sessionId={s?.id ?? null}
          staffId={staff?.id ?? null}
          name={name}
          autonomy={staff?.autonomy ?? null}
          disabled={!project.exists ? 'a pasta do projeto não existe' : null}
          onSessionStarted={props.onSessionStarted}
        />
      )}

      {/* O chat fica em primeiro plano; o resto, guardado num só acordeão. */}
      <details className="collapse collapse-group">
        <summary>Avançado</summary>
        <details className="collapse">
          <summary>Expediente</summary>
          <dl className="stats">
            <div><dt>do consumo total</dt><dd>{props.costUsd === null ? '—' : formatShare(props.costUsd, props.totalUsd)}</dd></div>
            <div><dt>subagents</dt><dd>{s?.subagentCount ?? 0}</dd></div>
            <div><dt>início</dt><dd>{s?.startedAt ? formatDate(s.startedAt) : '—'}</dd></div>
            <div><dt>última atividade</dt><dd>{s ? formatDate(s.updatedAt) : '—'}</dd></div>
          </dl>
          {s && <p className="muted mono">sessão {s.id}</p>}
          {staff && staff.sessions.length > 1 && <p className="muted small">{staff.sessions.length} sessões desde a contratação, somadas.</p>}
          <p className="muted small">Parte deste funcionário no consumo de todos, com os subagents que ele chamou.</p>
        </details>
        {s && <WorthIt key={s.id} sessionId={s.id} />}

        {staff && project && (
          <details className="collapse">
            <summary>Rotinas{staff.routines?.length ? ` (${staff.routines.filter((r) => r.enabled).length} ligada${staff.routines.filter((r) => r.enabled).length === 1 ? '' : 's'})` : ''}</summary>
            <Routines projectId={project.id} staff={staff} onChanged={props.onChanged} />
          </details>
        )}

        {staff ? (
          <details className="collapse">
            <summary>Ficha</summary>
            <StaffSheet staff={staff} managers={props.managers} />
            <p className="actions">
              <button className="btn-secondary" onClick={props.onEdit}>
                Editar ficha
              </button>
            </p>
          </details>
        ) : (
          <p className="muted small">
            Aberto fora do MyCo, ainda sem ficha (missão, regras, memória, MCPs). Use <b>Editar</b> para dar nome, retrato e ficha.
          </p>
        )}

        <details className="collapse">
          <summary>Mais ações</summary>
          {staff && <LaunchButtons hasSession={!!s} working={!!live} onLaunch={props.onLaunch} />}
          <p className="actions">
            {staff?.canHire && (
              <button className="btn-secondary" onClick={props.onHireSub}>
                Contratar subordinado
              </button>
            )}
            <ArchiveButton
              archived={props.archived}
              onArchive={props.onArchive}
              what="este funcionário"
              restoreLabel={staff?.temporary ? 'Restaurar' : 'Desarquivar'}
            />
          </p>
        </details>
      </details>
    </>
  );
}

/**
 * Temporário (contratado por outro funcionário): quem contratou, quando sai do quadro e, encerrado,
 * por quê. "Efetivar" o torna funcionário do projeto; "Restaurar" o traz de volta como temporário.
 */
function TempNotice(props: {
  staff: StaffProfile;
  managers: StaffProfile[];
  projectId: string;
  archived: boolean;
  onArchive: (v: boolean) => Promise<void>;
  onChanged?: () => void;
}) {
  const { staff } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hirer = props.managers.find((m) => m.id === staff.hiredBy)?.name ?? 'outro funcionário';
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      props.onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="temp-notice small">
      {props.archived && staff.ended ? (
        <span>
          Encerrado em {formatDate(staff.ended.at)}: {staff.ended.reason}. Ficha, memória e conversas continuam guardadas.
        </span>
      ) : (
        <span>
          Temporário, contratado por {hirer} em {formatDate(staff.createdAt)}. Sai do quadro quando {hirer} encerrar ou depois de {TEMP_IDLE_DAYS} dias
          parado.
        </span>
      )}
      <span className="temp-notice-actions">
        {props.archived && (
          <button className="btn-secondary" disabled={busy} onClick={() => void run(() => props.onArchive(false))} title="Volta ao quadro como temporário">
            Restaurar
          </button>
        )}
        <button
          className="btn-primary"
          disabled={busy}
          onClick={() => void run(() => api.keepStaff(props.projectId, staff.id))}
          title="Passa a ser funcionário do projeto: não sai mais do quadro sozinho"
        >
          Efetivar
        </button>
      </span>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

function LaunchButtons({ hasSession, working, onLaunch }: { hasSession: boolean; working: boolean; onLaunch: (resume: boolean) => Promise<LaunchResult> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = async (resume: boolean) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await onLaunch(resume));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="section launch">
      <div className="actions">
        {hasSession ? (
          <>
            <button
              className="btn-primary"
              onClick={() => go(true)}
              disabled={busy || working}
              title={working ? 'Já está trabalhando numa sessão aberta' : 'Retoma a última sessão, com o histórico'}
            >
              Chamar de volta
            </button>
            <button className="btn-secondary" onClick={() => go(false)} disabled={busy} title="Abre uma sessão nova com a mesma ficha e memória">
              Nova sessão
            </button>
          </>
        ) : (
          <button className="btn-primary" onClick={() => go(false)} disabled={busy}>
            Abrir sessão
          </button>
        )}
      </div>
      {working && <p className="muted small">Já está trabalhando: a janela do terminal dele está aberta.</p>}
      {result?.ok && <p className="ok small">Sessão aberta numa janela de terminal nova.</p>}
      {result && !result.ok && (
        <div className="error small">
          <p>Não abriu sozinha: {result.error}. Rode no terminal:</p>
          <code className="mono block">{result.command}</code>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

const AUTONOMY_TEXT: Record<string, string> = {
  plan: 'Só planeja',
  manual: 'Pede tudo',
  acceptEdits: 'Edita sozinho',
  auto: 'Autônomo',
  bypassPermissions: 'Sem travas',
};

function StaffSheet({ staff, managers }: { staff: StaffProfile; managers: StaffProfile[] }) {
  const list = (items: string[]) => (items.length ? items.join(', ') : '—');
  return (
    <section className="section">
      <dl className="sheet">
        <dt>Missão</dt>
        <dd>{staff.mission}</dd>
        {staff.firstTask && (
          <>
            <dt>Primeira tarefa</dt>
            <dd>{staff.firstTask}</dd>
          </>
        )}
        <dt>Reporta a</dt>
        <dd>{managers.length ? managers.map((m) => `${m.name} (${m.role})`).join(', ') : 'Você'}</dd>
        <dt>Autonomia</dt>
        <dd>{AUTONOMY_TEXT[staff.autonomy]}</dd>
        <dt>Agents / skills</dt>
        <dd>
          {list(staff.agents)} / {list(staff.skills)}
        </dd>
        <dt>MCPs</dt>
        <dd>{staff.mcps === null ? 'Todos os configurados' : list(staff.mcps)}</dd>
        {staff.knowledge.length > 0 && (
          <>
            <dt>Conhecimento</dt>
            <dd className="mono">{staff.knowledge.join(' · ')}</dd>
          </>
        )}
        {staff.rules.length > 0 && (
          <>
            <dt>Regras</dt>
            <dd>
              <ul className="plain">
                {staff.rules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {staff.doneWhen && (
          <>
            <dt>Pronto quando</dt>
            <dd>{staff.doneWhen}</dd>
          </>
        )}
        <dt>Modelo / esforço</dt>
        <dd>
          {staff.model ?? 'padrão'} / {staff.effort ?? 'padrão'}
        </dd>
        <dt>Contratar</dt>
        <dd>{staff.canHire ? 'Pode contratar subfuncionários' : 'Não'}</dd>
        {staff.servers.length > 0 && (
          <>
            <dt>Servidores</dt>
            <dd>{staff.servers.join(', ')}</dd>
          </>
        )}
        <dt>Navegador</dt>
        <dd>{staff.browser ? 'Usa o seu Chrome (Claude in Chrome)' : 'Não'}</dd>
      </dl>
      <p className="muted small mono">
        .myco/staff/{staff.id}.md · memória em .myco/staff/{staff.id}.memory.md
      </p>
    </section>
  );
}

export function ProjectPanel({
  id,
  live,
  cost,
  archived,
  onArchive,
  onHire,
  image,
  onImage,
  color,
  onColor,
  totalUsd,
  onNewAgent,
  onEditAgent,
  onTasks,
  tasks,
}: {
  onNewAgent?: () => void;
  onEditAgent?: (name: string) => void;
  /** Abre o quadro de tarefas do projeto. */
  onTasks?: () => void;
  /** Tarefas abertas, em revisão e o último deploy. */
  tasks?: TaskSummary | null;
  id: string;
  live: LiveSession[];
  cost: ProjectCost | null;
  totalUsd: number;
  archived: boolean;
  onArchive: (v: boolean) => Promise<void>;
  onHire: () => void;
  image: string | null;
  onImage: (dataUrl: string | null) => Promise<void>;
  /** Cor da parede da sala; null = a padrão. */
  color: ProjectColor | null;
  onColor: (color: ProjectColor | null) => Promise<void>;
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    api.project(id).then(setDetail, (e: Error) => setError(e.message));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!detail) return <p className="muted">Carregando…</p>;

  // O status ao vivo vem do polling; o detalhe pode estar alguns segundos atrasado.
  const liveById = new Map(live.map((s) => [s.sessionId, s]));
  const sessions = detail.sessions.map((s) => ({ ...s, live: liveById.get(s.id) ?? s.live }));
  const { project } = detail;

  return (
    <>
      <header className="header">
        <p className="kicker">projeto</p>
        <h2>{project.name}</h2>
        <p className="muted mono">{project.path}</p>
        <p className="badges">
          {project.hasClaudeMd ? <span className="badge">CLAUDE.md</span> : <span className="badge dim">sem CLAUDE.md</span>}
          {project.worktreeOf && <span className="badge">worktree de {basename(project.worktreeOf)}</span>}
          {!project.exists && <span className="badge warn">pasta não existe</span>}
          {archived && <span className="badge dim">arquivado</span>}
        </p>
        <p className="actions">
          {project.exists && (
            <button className="btn-primary" onClick={onHire}>
              Contratar funcionário
            </button>
          )}
          {project.exists && onTasks && (
            <button className="btn-secondary" onClick={onTasks} title="Quadro de tarefas do projeto">
              Tarefas
            </button>
          )}
          <ArchiveButton archived={archived} onArchive={onArchive} what="este projeto e seus funcionários" />
        </p>
        {tasks && (
          <p className="muted small">
            {tasks.open} {tasks.open === 1 ? 'tarefa aberta' : 'tarefas abertas'}
            {tasks.review ? `, ${tasks.review} em revisão` : ''}
            {tasks.lastDeploy &&
              ` · último deploy ${new Date(tasks.lastDeploy.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}: ${tasks.lastDeploy.title}`}
          </p>
        )}
      </header>
      <section className="section">
        <h3>Cor da sala</h3>
        <RoomColorPicker value={color} onChange={onColor} />
        <p className="muted small">
          {project.worktreeOf
            ? 'Vale quando este worktree aparece numa sala própria; dentro do projeto principal, a sala é a dele.'
            : 'A parede da sala no quadro. Cada cor tem um tom para o tema claro e outro para o escuro.'}
        </p>
      </section>
      {project.exists && <ImagePicker image={image} onChange={onImage} />}
      <SessionList sessions={sessions} costs={cost?.sessions ?? {}} totalUsd={totalUsd} />
      <AgentList
        agents={detail.agents}
        empty="Nenhum agent em .claude/agents."
        onNew={project.exists ? onNewAgent : undefined}
        onEdit={project.exists ? onEditAgent : undefined}
      />
      <SkillList skills={detail.skills} />
    </>
  );
}

/** Logo ou print do projeto (fica em .myco/ do projeto). */
function ImagePicker({ image, onChange }: { image: string | null; onChange: (dataUrl: string | null) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (dataUrl: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(dataUrl);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError('Use PNG, JPEG ou WebP.');
    if (file.size > MAX_INPUT_BYTES) return setError('Máximo de 20 MB.');
    // Reduzida aqui antes de subir: o arquivo fica dentro da pasta do projeto.
    shrinkImage(file, PROJECT_IMAGE_MAX).then((url) => run(url), () => setError('Não foi possível ler a imagem.'));
  };
  return (
    <section className="section">
      <h3>Imagem do projeto</h3>
      {image && <img className="project-image" src={image} alt="Imagem do projeto" />}
      <p className="actions">
        <label className="btn-secondary file-btn">
          {image ? 'Trocar imagem' : 'Adicionar logo ou print'}
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        {image && (
          <button className="btn-secondary" disabled={busy} onClick={() => void run(null)}>
            Remover
          </button>
        )}
      </p>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** Regras que valem para todas as sessões de todos os projetos: ~/.claude/CLAUDE.md. */
function AccountRules() {
  const [data, setData] = useState<{ path: string; text: string | null } | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    api.accountRules().then(
      (d) => {
        setData(d);
        setDraft(d.text ?? '');
      },
      (e: Error) => setMsg({ tone: 'error', text: e.message }),
    );
  }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await api.saveAccountRules(draft);
      setData(d);
      setMsg({ tone: 'ok', text: 'Salvo. Vale para as sessões abertas a partir de agora.' });
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const dirty = data !== null && draft !== (data.text ?? '');
  return (
    <section className="section">
      <h3>Regras da conta</h3>
      <p className="muted small">
        Valem para todas as sessões, em todos os projetos (<span className="mono">{data?.path ?? '~/.claude/CLAUDE.md'}</span>).
        {data && data.text === null && ' O arquivo ainda não existe: salvar cria.'} A versão anterior vai para ~/.myco/backups.
      </p>
      <textarea
        className="rules-editor mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={10}
        placeholder={'# Regras gerais\n- Responda em português\n- Nunca faça push sem pedir'}
        disabled={data === null}
      />
      <p className="actions">
        <button className="btn-primary" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? 'Salvando…' : 'Salvar regras'}
        </button>
        {dirty && (
          <button className="btn-secondary" onClick={() => setDraft(data?.text ?? '')} disabled={busy}>
            Descartar
          </button>
        )}
      </p>
      {msg && <p className={msg.tone === 'ok' ? 'ok small' : 'error small'}>{msg.text}</p>}
    </section>
  );
}

export function UserPanel({
  scope,
  onNewAgent,
  onEditAgent,
}: {
  scope: UserScope;
  onNewAgent?: () => void;
  onEditAgent?: (name: string) => void;
}) {
  return (
    <>
      <header className="header">
        <p className="kicker">escopo do usuário</p>
        <h2>~ você</h2>
        <p className="muted">Visível em todos os projetos (~/.claude)</p>
      </header>
      <AccountRules />
      <AgentList agents={scope.agents} empty="Nenhum agent em ~/.claude/agents." onNew={onNewAgent} onEdit={onEditAgent} />
      <SkillList skills={scope.skills} />
    </>
  );
}

export interface RankingEntry {
  /** Nó do quadro a selecionar ao clicar. */
  nodeId: string;
  name: string;
  detail: string;
  usd: number;
}

/**
 * Comparação de quem mais gasta. Os valores são equivalentes em API (estimativa): servem para
 * comparar funcionários e agents entre si, não como conta a pagar.
 */
export function RankingPanel({
  employees,
  agents,
  scanning,
  onSelect,
}: {
  employees: RankingEntry[];
  agents: Array<{ type: string; usd: number; runs: number }>;
  scanning: boolean;
  onSelect: (nodeId: string) => void;
}) {
  const [limit, setLimit] = useState(10);
  const topEmployee = employees[0]?.usd ?? 0;
  const topAgent = agents[0]?.usd ?? 0;
  // Participação de cada um no gasto da lista (funcionários entre si; agents entre si).
  const employeesTotal = employees.reduce((s, e) => s + e.usd, 0);
  const agentsTotal = agents.reduce((s, a) => s + a.usd, 0);
  return (
    <>
      <header className="header">
        <p className="kicker">comparação</p>
        <h2>Quem mais gasta</h2>
        <p className="muted small">
          Parte de cada um no consumo total, só para comparar (as sessões rodam pela assinatura).
          {scanning && ' Ainda lendo os transcripts: os números vão crescer.'}
        </p>
      </header>
      <section className="section">
        <h3>Funcionários</h3>
        {employees.length === 0 && <p className="muted">Nenhum custo registrado ainda.</p>}
        <ol className="ranking">
          {employees.slice(0, limit).map((e, i) => (
            <li key={e.nodeId}>
              <button className="ranking-row" onClick={() => onSelect(e.nodeId)} title="Mostrar no quadro">
                <span className="ranking-pos">{i + 1}</span>
                <span className="ranking-text">
                  <span className="ranking-name">{e.name}</span>
                  <span className="muted small">{e.detail}</span>
                </span>
                <span className="ranking-value">{formatShare(e.usd, employeesTotal)}</span>
                <span className="ranking-bar" style={{ width: `${topEmployee ? (e.usd / topEmployee) * 100 : 0}%` }} />
              </button>
            </li>
          ))}
        </ol>
        {employees.length > limit && (
          <button className="btn-secondary" onClick={() => setLimit(limit + 20)}>
            Mostrar mais ({employees.length - limit})
          </button>
        )}
      </section>
      <section className="section">
        <h3>Agents (subagents chamados pelos funcionários)</h3>
        {agents.length === 0 && <p className="muted">Nenhum subagent usado ainda.</p>}
        <ol className="ranking">
          {agents.map((a, i) => (
            <li key={a.type}>
              <div className="ranking-row">
                <span className="ranking-pos">{i + 1}</span>
                <span className="ranking-text">
                  <span className="ranking-name">{a.type}</span>
                  <span className="muted small">
                    {a.runs} {a.runs === 1 ? 'execução' : 'execuções'} · {formatShare(a.usd / Math.max(1, a.runs), agentsTotal)} por execução
                  </span>
                </span>
                <span className="ranking-value">{formatShare(a.usd, agentsTotal)}</span>
                <span className="ranking-bar" style={{ width: `${topAgent ? (a.usd / topAgent) * 100 : 0}%` }} />
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

export function SyncedPanel({ skills }: { skills: Skill[] }) {
  return (
    <>
      <header className="header">
        <p className="kicker">skills da conta</p>
        <h2>{skills.length} sincronizadas</h2>
        <p className="muted">Gerenciadas pela sua conta Claude; o MyCo só lê.</p>
      </header>
      <SkillList skills={skills} />
    </>
  );
}

export function AgentPanel({
  agent,
  cost,
  agentsUsd,
  onEdit,
}: {
  agent: Agent;
  cost: (CostSummary & { runs: number }) | null;
  /** Consumo de todos os subagents, para mostrar a parte deste. */
  agentsUsd: number;
  onEdit?: () => void;
}) {
  return (
    <>
      <header className="header">
        <p className="kicker">agent · {agent.scope === 'user' ? 'usuário' : 'projeto'}</p>
        <h2>{agent.name}</h2>
        <p className="muted mono">{agent.filePath}</p>
        <p className="badges">
          <LinkBadge link={agent.link} />
          <span className="badge">{agent.model ? `modelo: ${agent.model}` : 'modelo de quem chama'}</span>
          {agent.duplicate && <span className="badge warn">nome repetido: só um é carregado</span>}
        </p>
        {onEdit && !agent.error && (
          <p className="actions">
            <button className="btn-secondary" onClick={onEdit}>
              Editar agent
            </button>
          </p>
        )}
      </header>
      {agent.error && <p className="error">{agent.error}</p>}
      {cost && (
        <section className="section">
          <h3>Consumo como subagent</h3>
          <dl className="stats">
            <div><dt>dos subagents</dt><dd>{formatShare(cost.usd, agentsUsd)}</dd></div>
            <div><dt>por execução</dt><dd>{formatShare(cost.usd / Math.max(1, cost.runs), agentsUsd)}</dd></div>
          </dl>
          <p className="muted small">
            {cost.runs} {cost.runs === 1 ? 'execução' : 'execuções'}, somando todos os projetos. Parte no consumo de todos os subagents.
          </p>
        </section>
      )}
      {agent.link.target && <Field label="origem do vínculo" mono value={agent.link.target} />}
      {agent.description && <Field label="descrição" value={agent.description} />}
      <section className="section">
        <h3>Ferramentas</h3>
        {agent.tools ? (
          <ul className="chips">
            {agent.tools.map((t) => (
              <li key={t} className="chip mono">{t}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">Todas (sem lista no frontmatter).</p>
        )}
      </section>
    </>
  );
}

export function SkillPanel({ skill }: { skill: Skill }) {
  return (
    <>
      <header className="header">
        <p className="kicker">skill · {skill.scope === 'project' ? 'projeto' : skill.scope === 'user' ? 'usuário' : 'conta'}</p>
        <h2>{skill.name}</h2>
        <p className="muted mono">{skill.dirPath}</p>
        <p className="badges">
          <LinkBadge link={skill.link} />
          {skill.label && skill.label !== skill.name && <span className="badge dim">rótulo: {skill.label}</span>}
          {skill.readOnly && <span className="badge dim">somente leitura</span>}
        </p>
      </header>
      {skill.error && <p className="error">{skill.error}</p>}
      {skill.link.target && <Field label="origem do vínculo" mono value={skill.link.target} />}
      {skill.description && <Field label="descrição" value={skill.description} />}
    </>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <section className="section">
      <h3>{label}</h3>
      <p className={mono ? 'mono' : 'prose'}>{value}</p>
    </section>
  );
}

function AgentList({
  agents,
  empty,
  onNew,
  onEdit,
}: {
  agents: Agent[];
  empty: string;
  onNew?: () => void;
  onEdit?: (name: string) => void;
}) {
  return (
    <section className="section">
      <h3 className="section-head">
        Agents ({agents.length})
        {onNew && (
          <button className="btn-secondary" onClick={onNew}>
            Novo agent
          </button>
        )}
      </h3>
      {agents.length === 0 && <p className="muted">{empty}</p>}
      <ul className="cards">
        {agents.map((a) => (
          <li key={a.id} className={`card ${a.error ? 'card-error' : ''}`}>
            <div className="card-title">
              {a.name}
              {a.model && <span className="badge">{a.model}</span>}
              <LinkBadge link={a.link} />
              {a.duplicate && <span className="badge warn">nome repetido</span>}
              {onEdit && !a.error && (
                <button className="btn-secondary card-action" onClick={() => onEdit(a.name)}>
                  Editar
                </button>
              )}
            </div>
            {a.description && <p className="card-desc">{a.description}</p>}
            {a.error && <p className="error">{a.error}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SkillList({ skills }: { skills: Skill[] }) {
  return (
    <section className="section">
      <h3>Skills ({skills.length})</h3>
      {skills.length === 0 && <p className="muted">Nenhuma skill.</p>}
      <ul className="cards">
        {skills.map((s) => (
          <li key={s.id} className={`card ${s.error ? 'card-error' : ''}`}>
            <div className="card-title">
              {s.name}
              <LinkBadge link={s.link} />
              {s.readOnly && <span className="badge dim">sincronizada</span>}
            </div>
            {s.description && <p className="card-desc">{s.description}</p>}
            {s.error && <p className="error">{s.error}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SessionList({ sessions, costs, totalUsd }: { sessions: Session[]; costs: Record<string, number>; totalUsd: number }) {
  return (
    <section className="section">
      <h3>Funcionários ({sessions.length})</h3>
      {sessions.length === 0 && <p className="muted">Nenhuma sessão registrada.</p>}
      <ul className="rows">
        {sessions.map((s) => (
          <li key={s.id} className="row">
            <span className="row-title">
              {s.live?.alive && <span className={`dot dot-${s.live.status ?? 'unknown'}`} title={STATUS_LABEL[s.live.status ?? ''] ?? ''} />}
              {s.title ?? <span className="muted mono">{s.id.slice(0, 8)}</span>}
            </span>
            <span className="row-meta">
              {s.entrypoint && <span className="badge">{ENTRYPOINT_LABEL[s.entrypoint] ?? s.entrypoint}</span>}
              {s.gitBranch && <span className="badge dim">{s.gitBranch}</span>}
              {s.subagentCount > 0 && <span className="badge dim">{s.subagentCount} subagents</span>}
              {costs[s.id] !== undefined && <span title="Parte no consumo total">{formatShare(costs[s.id]!, totalUsd)}</span>}
              <span className="muted">{formatDate(s.updatedAt)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}


function LinkBadge({ link }: { link: LinkInfo }) {
  if (link.kind === 'file') return null;
  return (
    <span className="badge link" title={link.target ?? undefined}>
      {link.kind === 'symlink' ? 'vinculado' : 'hardlink'}
    </span>
  );
}

function basename(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function formatDate(isoDate: string) {
  return new Date(isoDate).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
