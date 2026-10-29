import { useEffect, useRef, useState } from 'react';
import type {
  Agent,
  CostReport,
  CostSummary,
  LinkInfo,
  LiveSession,
  Project,
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
import { ChatView, type MoreTab } from '../chat/ChatView';
import { BrowserCheck } from '../staff/BrowserCheck';
import { MAX_INPUT_BYTES, PROJECT_IMAGE_MAX, shrinkImage } from '../lib/shrinkImage';
import { METRIC_LABEL, type Metric, ModelsChart } from '../toolbar/ModelsMenu';
import { Routines } from './Routines';
import { WorthIt } from './WorthIt';
import { employeeName, ENTRYPOINT_LABEL, formatShare, STATUS_LABEL } from '../format';
import { t, locale } from '../i18n';
import { ServerLog } from '../office/ServerLog';
import { CopyToLibrary, SkillLibrary } from '../office/SkillLibrary';

// Painel lateral: o que o nó selecionado no quadro tem por trás.

type ProjectCost = CostSummary & { sessions: Record<string, number> };

function ArchiveButton({
  archived,
  onArchive,
  what,
  restoreLabel = t('detail.unarchive'),
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
        title={archived ? t('detail.showOnBoard', { what }) : t('detail.hideFromBoard', { what })}
      >
        {archived ? restoreLabel : t('detail.archive')}
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
  onHireSub: () => void;
  onEdit: () => void;
  onSessionStarted?: (sessionId: string) => void;
  /** A ficha mudou por aqui (rotinas): o quadro relê. */
  onChanged?: () => void;
  /** Nível simples: o painel fica só com a conversa. */
  simple?: boolean;
  onShowAdvanced?: () => void;
  /** Conversas do funcionário, da mais recente à mais antiga. */
  conversations?: Array<{ id: string; title: string | null; updatedAt: string | null }>;
  /** Abrir nesta conversa (achada na busca do Ctrl+K). */
  initialConversation?: string | null;
}) {
  const { session: s, staff, project } = props;
  // Qual conversa está aberta: a mais recente, outra da lista, ou uma nova (ainda sem sessão).
  // A conversa pedida (busca) só vale se for deste funcionário.
  const wanted = props.initialConversation && props.conversations?.some((c) => c.id === props.initialConversation) ? props.initialConversation : null;
  const [picked, setPicked] = useState<string | null>(wanted ?? s?.id ?? null);
  const [fresh, setFresh] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    // Na primeira vez vale a conversa pedida (busca); depois, a mais recente quando ela muda.
    if (first.current) {
      first.current = false;
      return;
    }
    setPicked(s?.id ?? null);
    setFresh(false);
  }, [s?.id]);
  const current = fresh ? null : picked;
  const conversations = props.conversations ?? [];
  const [convBusy, setConvBusy] = useState(false);
  const duplicate = async () => {
    if (!project || !current) return;
    setConvBusy(true);
    try {
      const r = await api.chatFork(project.id, current, staff?.id ?? null);
      setFresh(false);
      setPicked(r.sessionId);
      props.onSessionStarted?.(r.sessionId);
    } catch (e) {
      window.alert((e as Error).message);
    } finally {
      setConvBusy(false);
    }
  };
  const live = s?.live?.alive ? s.live : null;
  const name = staff?.name ?? (s ? employeeName(s) : '?');
  const showConvos = !!staff && !!project && (conversations.length > 0 || fresh);
  const statusInfo = live
    ? { dot: `dot dot-${live.status ?? 'unknown'}`, text: STATUS_LABEL[live.status ?? ''] ?? live.status }
    : { dot: 'dot', text: s ? t('detail.offShift') : t('detail.noSessionYet') };
  // Topo compacto: quem é e como está. Logo abaixo, a conversa (linha 2) e os avisos que pedem ação.
  const top = (
    <>
      <div className="employee-top">
        {staff?.portrait && project && <img className="employee-portrait" src={portraitUrl(project.id, staff.id)} alt={t('detail.portraitOf', { name: staff.name })} />}
        <div className="employee-ident">
          <h2 className="employee-name" title={name}>
            {name}
          </h2>
          {(staff || project) && (
            <span className="employee-cargo" title={[staff?.role, project?.name].filter(Boolean).join(' · ')}>
              {[staff?.role, project?.name].filter(Boolean).join(' · ')}
            </span>
          )}
          <span className="badge">
            <span className={statusInfo.dot} /> {statusInfo.text}
          </span>
          {staff?.temporary && <span className="badge warn">{t('detail.temporary')}</span>}
        </div>
      </div>
      {showConvos && (
        <div className="chat-convos">
          <select
            aria-label={t('detail.conversation')}
            value={current ?? ''}
            onChange={(e) => {
              setFresh(false);
              setPicked(e.target.value);
            }}
          >
            {fresh && <option value="">{t('detail.newConversation')}</option>}
            {conversations.map((c, i) => (
              <option key={c.id} value={c.id}>
                {conversationLabel(c, i)}
              </option>
            ))}
          </select>
          <button type="button" className="btn-secondary" disabled={fresh || convBusy} onClick={() => setFresh(true)} title={t('detail.newConversationTitle')}>
            {t('detail.newConversationBtn')}
          </button>
        </div>
      )}
      {staff?.temporary && project && (
        <TempNotice staff={staff} managers={props.managers} projectId={project.id} archived={props.archived} onArchive={props.onArchive} onChanged={props.onChanged} />
      )}
      {staff?.browser && <BrowserCheck />}
    </>
  );
  // No "Mais", aba Conversa: duplicar (o nome da conversa vem sozinho da primeira mensagem).
  const conversationMore = showConvos ? (
    <button
      type="button"
      className="btn-secondary"
      disabled={!current || convBusy}
      onClick={() => void duplicate()}
      title={t('detail.duplicateTitle')}
    >
      {t('detail.duplicate')}
    </button>
  ) : undefined;
  const enabledRoutines = staff?.routines?.filter((r) => r.enabled).length ?? 0;
  // As abas do funcionário no "Mais". Editar a ficha é um botão só, na aba Ficha.
  const tabs: MoreTab[] = [
    {
      id: 'ficha',
      label: t('detail.tabSheet'),
      content: (
        <>
          <p className="badges">
            {s?.entrypoint && <span className="badge">{ENTRYPOINT_LABEL[s.entrypoint] ?? s.entrypoint}</span>}
            {s?.gitBranch && <span className="badge dim">{s.gitBranch}</span>}
            {!staff && <span className="badge dim">{t('detail.noSheet')}</span>}
            {props.archived && <span className="badge dim">{t('detail.archived')}</span>}
          </p>
          {staff ? (
            !props.simple && <StaffSheet staff={staff} managers={props.managers} />
          ) : (
            <p className="muted small">{t('detail.outsideMyco')}</p>
          )}
          <div className="chat-more-row">
            <button
              type="button"
              className="btn-secondary"
              onClick={props.onEdit}
              title={staff ? t('detail.editProfileTitle') : t('detail.giveProfileTitle')}
            >
              {staff ? t('detail.editProfile') : t('detail.giveProfile')}
            </button>
          </div>
          {props.simple && (
            <p className="muted small simple-more">
              {t('detail.simpleMore')}{' '}
              {props.onShowAdvanced && (
                <button type="button" className="link" onClick={props.onShowAdvanced}>
                  {t('detail.show')}
                </button>
              )}
            </p>
          )}
        </>
      ),
    },
    ...(props.simple
      ? []
      : [
          {
            id: 'expediente',
            label: t('detail.tabActivity'),
            content: (
              <>
                <dl className="stats">
                  <div><dt>{t('detail.costOfTotal')}</dt><dd>{props.costUsd === null ? '—' : formatShare(props.costUsd, props.totalUsd)}</dd></div>
                  <div><dt>{t('detail.subagents')}</dt><dd>{s?.subagentCount ?? 0}</dd></div>
                  <div><dt>{t('detail.start')}</dt><dd>{s?.startedAt ? formatDate(s.startedAt) : '—'}</dd></div>
                  <div><dt>{t('detail.lastActivity')}</dt><dd>{s ? formatDate(s.updatedAt) : '—'}</dd></div>
                </dl>
                {staff && staff.sessions.length > 1 && <p className="muted small">{t('detail.sessionsSinceHire', { n: staff.sessions.length })}</p>}
                <p className="muted small">{t('detail.shareNote')}</p>
                {s && <WorthIt key={s.id} sessionId={s.id} />}
                {s && <p className="muted small mono">{t('detail.sessionId', { id: s.id })}</p>}
              </>
            ),
          },
          ...(staff && project
            ? [
                {
                  id: 'rotinas',
                  label: enabledRoutines ? t('detail.routinesCount', { n: enabledRoutines }) : t('detail.tabRoutines'),
                  content: <Routines projectId={project.id} staff={staff} onChanged={props.onChanged} />,
                },
              ]
            : []),
          {
            id: 'acoes',
            label: t('detail.tabActions'),
            content: (
              <>
                <p className="actions">
                  {staff?.canHire && (
                    <button className="btn-secondary" onClick={props.onHireSub}>
                      {t('detail.hireSub')}
                    </button>
                  )}
                  <ArchiveButton
                    archived={props.archived}
                    onArchive={props.onArchive}
                    what={t('detail.whatEmployee')}
                    restoreLabel={staff?.temporary ? t('detail.restore') : t('detail.unarchive')}
                  />
                </p>
              </>
            ),
          },
        ]),
  ];
  // Sem projeto não há conversa (nem "Mais"): o topo e as abas, uma embaixo da outra, com rolagem própria.
  if (!project) {
    return (
      <div className="employee-scroll">
        {top}
        {tabs.map((t) => (
          <section key={t.id} className="section">
            <h3>{t.label}</h3>
            {t.content}
          </section>
        ))}
      </div>
    );
  }
  return (
    <ChatView
      key={`${current ?? 'novo'}:${staff?.id ?? ''}`}
      projectId={project.id}
      sessionId={current}
      staffId={staff?.id ?? null}
      name={name}
      autonomy={staff?.autonomy ?? null}
      disabled={!project.exists ? t('detail.projectFolderMissing') : null}
      onSessionStarted={props.onSessionStarted}
      level={props.simple ? 'simple' : 'advanced'}
      fichaModel={staff?.model ?? null}
      fichaEffort={staff?.effort ?? null}
      top={top}
      more={{ conversation: conversationMore, tabs }}
    />
  );
}

/** "Ajustar o header da sala · 27/10 14:05" (a mais recente ganha "atual"). */
function conversationLabel(c: { title: string | null; updatedAt: string | null }, index: number): string {
  const title = (c.title ?? t('detail.untitledConversation')).replace(/\s+/g, ' ').slice(0, 48);
  const when = c.updatedAt ? new Date(c.updatedAt).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  return `${index === 0 ? t('detail.currentPrefix') : ''}${title}${when ? ` · ${when}` : ''}`;
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
  const hirer = props.managers.find((m) => m.id === staff.hiredBy)?.name ?? t('detail.otherEmployee');
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
        <span>{t('detail.endedOn', { date: formatDate(staff.ended.at), reason: staff.ended.reason })}</span>
      ) : (
        <span>{t('detail.tempNotice', { hirer, date: formatDate(staff.createdAt), days: TEMP_IDLE_DAYS })}</span>
      )}
      <span className="temp-notice-actions">
        {props.archived && (
          <button className="btn-secondary" disabled={busy} onClick={() => void run(() => props.onArchive(false))} title={t('detail.restoreTempTitle')}>
            {t('detail.restore')}
          </button>
        )}
        <button
          className="btn-primary"
          disabled={busy}
          onClick={() => void run(() => api.keepStaff(props.projectId, staff.id))}
          title={t('detail.keepStaffTitle')}
        >
          {t('detail.keepStaff')}
        </button>
      </span>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

const AUTONOMY_TEXT: Record<string, string> = {
  plan: t('detail.autPlan'),
  manual: t('detail.autManual'),
  acceptEdits: t('detail.autAcceptEdits'),
  auto: t('detail.autAuto'),
  bypassPermissions: t('detail.autBypass'),
};

function StaffSheet({ staff, managers }: { staff: StaffProfile; managers: StaffProfile[] }) {
  const list = (items: string[]) => (items.length ? items.join(', ') : '—');
  return (
    <section className="section">
      <dl className="sheet">
        <dt>{t('detail.mission')}</dt>
        <dd>{staff.mission}</dd>
        {staff.firstTask && (
          <>
            <dt>{t('detail.firstTask')}</dt>
            <dd>{staff.firstTask}</dd>
          </>
        )}
        <dt>{t('detail.reportsTo')}</dt>
        <dd>{managers.length ? managers.map((m) => `${m.name} (${m.role})`).join(', ') : t('detail.you')}</dd>
        <dt>{t('detail.autonomy')}</dt>
        <dd>{AUTONOMY_TEXT[staff.autonomy]}</dd>
        <dt>Agents / skills</dt>
        <dd>
          {list(staff.agents)} / {list(staff.skills)}
        </dd>
        <dt>MCPs</dt>
        <dd>{staff.mcps === null ? t('detail.allConfigured') : list(staff.mcps)}</dd>
        {staff.knowledge.length > 0 && (
          <>
            <dt>{t('detail.knowledge')}</dt>
            <dd className="mono">{staff.knowledge.join(' · ')}</dd>
          </>
        )}
        {staff.rules.length > 0 && (
          <>
            <dt>{t('detail.rules')}</dt>
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
            <dt>{t('detail.doneWhen')}</dt>
            <dd>{staff.doneWhen}</dd>
          </>
        )}
        <dt>{t('detail.modelEffort')}</dt>
        <dd>
          {staff.model ?? t('detail.default')} / {staff.effort ?? t('detail.default')}
        </dd>
        <dt>{t('detail.hire')}</dt>
        <dd>{staff.canHire ? t('detail.canHire') : t('detail.no')}</dd>
        {staff.servers.length > 0 && (
          <>
            <dt>{t('detail.servers')}</dt>
            <dd>{staff.servers.join(', ')}</dd>
          </>
        )}
        <dt>{t('detail.browser')}</dt>
        <dd>{staff.browser ? t('detail.usesChrome') : t('detail.no')}</dd>
      </dl>
      <p className="muted small mono">{t('detail.sheetFiles', { id: staff.id })}</p>
      {staff.servers.length > 0 && <ServerLog projectId={staff.projectId} staffId={staff.id} />}
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
  office,
}: {
  /** Empresa e servidores do projeto (ver office/ProjectOffice.tsx). */
  office?: React.ReactNode;
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
  if (!detail) return <p className="muted">{t('detail.loading')}</p>;

  // O status ao vivo vem do polling; o detalhe pode estar alguns segundos atrasado.
  const liveById = new Map(live.map((s) => [s.sessionId, s]));
  const sessions = detail.sessions.map((s) => ({ ...s, live: liveById.get(s.id) ?? s.live }));
  const { project } = detail;

  return (
    <>
      <header className="header">
        <p className="kicker">{t('detail.kickerProject')}</p>
        <h2>{project.name}</h2>
        <p className="muted mono">{project.path}</p>
        <p className="badges">
          {project.hasClaudeMd ? <span className="badge">CLAUDE.md</span> : <span className="badge dim">{t('detail.noClaudeMd')}</span>}
          {project.worktreeOf && <span className="badge">{t('detail.worktreeOf', { name: basename(project.worktreeOf) })}</span>}
          {!project.exists && <span className="badge warn">{t('detail.folderMissing')}</span>}
          {archived && <span className="badge dim">{t('detail.archived')}</span>}
        </p>
        <p className="actions">
          {project.exists && (
            <button className="btn-primary" onClick={onHire}>
              {t('detail.hireEmployee')}
            </button>
          )}
          {project.exists && onTasks && (
            <button className="btn-secondary" onClick={onTasks} title={t('detail.boardTasksTitle')}>
              {t('detail.tasks')}
            </button>
          )}
          <ArchiveButton archived={archived} onArchive={onArchive} what={t('detail.whatProjectAndStaff')} />
        </p>
        {tasks && (
          <p className="muted small">
            {tasks.open === 1 ? t('detail.taskOpenOne', { n: tasks.open }) : t('detail.taskOpenOther', { n: tasks.open })}
            {tasks.review ? `, ${t('detail.inReview', { n: tasks.review })}` : ''}
            {tasks.lastDeploy &&
              ` · ${t('detail.lastDeploy', {
                date: new Date(tasks.lastDeploy.at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
                title: tasks.lastDeploy.title,
              })}`}
          </p>
        )}
      </header>
      <section className="section">
        <h3>{t('detail.roomColor')}</h3>
        <RoomColorPicker value={color} onChange={onColor} />
        <p className="muted small">
          {project.worktreeOf ? t('detail.worktreeRoomNote') : t('detail.roomColorNote')}
        </p>
      </section>
      {project.exists && !project.worktreeOf && office}
      {project.exists && <ImagePicker image={image} onChange={onImage} />}
      <SessionList sessions={sessions} costs={cost?.sessions ?? {}} totalUsd={totalUsd} />
      <AgentList
        agents={detail.agents}
        empty={t('detail.noAgentsProject')}
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
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError(t('detail.usePng'));
    if (file.size > MAX_INPUT_BYTES) return setError(t('detail.max20'));
    // Reduzida aqui antes de subir: o arquivo fica dentro da pasta do projeto.
    shrinkImage(file, PROJECT_IMAGE_MAX).then((url) => run(url), () => setError(t('detail.cantReadImage')));
  };
  return (
    <section className="section">
      <h3>{t('detail.projectImage')}</h3>
      {image && <img className="project-image" src={image} alt={t('detail.projectImage')} />}
      <p className="actions">
        <label className="btn-secondary file-btn">
          {image ? t('detail.changeImage') : t('detail.addLogo')}
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        {image && (
          <button className="btn-secondary" disabled={busy} onClick={() => void run(null)}>
            {t('detail.remove')}
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
      setMsg({ tone: 'ok', text: t('detail.rulesSaved') });
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const dirty = data !== null && draft !== (data.text ?? '');
  return (
    <section className="section">
      <h3>{t('detail.rulesHeading')}</h3>
      <p className="muted small">
        {t('detail.rulesAllSessions')} (<span className="mono">{data?.path ?? '~/.claude/CLAUDE.md'}</span>).
        {data && data.text === null && ` ${t('detail.rulesNotCreated')}`} {t('detail.rulesBackup')}
      </p>
      <textarea
        className="rules-editor mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={10}
        placeholder={t('detail.rulesPlaceholder')}
        disabled={data === null}
      />
      <p className="actions">
        <button className="btn-primary" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? t('detail.saving') : t('detail.saveRules')}
        </button>
        {dirty && (
          <button className="btn-secondary" onClick={() => setDraft(data?.text ?? '')} disabled={busy}>
            {t('detail.discard')}
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
        <p className="kicker">{t('detail.kickerUserScope')}</p>
        <h2>{t('detail.userHeading')}</h2>
        <p className="muted">{t('detail.visibleAllProjects')}</p>
      </header>
      <AccountRules />
      <AgentList agents={scope.agents} empty={t('detail.noAgentsUser')} onNew={onNewAgent} onEdit={onEditAgent} />
      <SkillList skills={scope.skills} />
      <SkillLibrary />
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

type RankingTab = 'cost' | Metric;
const RANKING_TABS: Array<[RankingTab, string]> = [['cost', t('detail.tabCost')], ['index', METRIC_LABEL.index], ['price', METRIC_LABEL.price]];

/**
 * Ranking, em abas: quem mais gasta (funcionários e agents) e os modelos para código (Artificial
 * Analysis). Os gastos são equivalentes em API (estimativa): servem para comparar, não como conta a pagar.
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
  const [tab, setTab] = useState<RankingTab>('cost');
  const [limit, setLimit] = useState(10);
  const topEmployee = employees[0]?.usd ?? 0;
  const topAgent = agents[0]?.usd ?? 0;
  // Participação de cada um no gasto da lista (funcionários entre si; agents entre si).
  const employeesTotal = employees.reduce((s, e) => s + e.usd, 0);
  const agentsTotal = agents.reduce((s, a) => s + a.usd, 0);
  return (
    <>
      <header className="header">
        <p className="kicker">{t('detail.kickerRanking')}</p>
        <h2>{tab === 'cost' ? t('detail.topSpenders') : t('detail.modelsForCode')}</h2>
        {tab === 'cost' && (
          <p className="muted small">
            {t('detail.costNote')}
            {scanning && ` ${t('detail.stillScanning')}`}
          </p>
        )}
      </header>
      <div className="tabs" role="tablist">
        {RANKING_TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'is-active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab !== 'cost' ? (
        <ModelsChart metric={tab} />
      ) : (
        <>
          <section className="section">
            <h3>{t('detail.employees')}</h3>
            {employees.length === 0 && <p className="muted">{t('detail.noCostYet')}</p>}
            <ol className="ranking">
              {employees.slice(0, limit).map((e, i) => (
                <li key={e.nodeId}>
                  <button className="ranking-row" onClick={() => onSelect(e.nodeId)} title={t('detail.showOnBoardLink')}>
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
                {t('detail.showMore', { n: employees.length - limit })}
              </button>
            )}
          </section>
          <section className="section">
            <h3>{t('detail.agentsSubagentsHeading')}</h3>
            {agents.length === 0 && <p className="muted">{t('detail.noSubagentsUsed')}</p>}
            <ol className="ranking">
              {agents.map((a, i) => (
                <li key={a.type}>
                  <div className="ranking-row">
                    <span className="ranking-pos">{i + 1}</span>
                    <span className="ranking-text">
                      <span className="ranking-name">{a.type}</span>
                      <span className="muted small">
                        {a.runs === 1 ? t('detail.runOne', { n: a.runs }) : t('detail.runOther', { n: a.runs })} · {formatShare(a.usd / Math.max(1, a.runs), agentsTotal)}{' '}
                        {t('detail.perRun')}
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
      )}
    </>
  );
}

export function SyncedPanel({ skills }: { skills: Skill[] }) {
  return (
    <>
      <header className="header">
        <p className="kicker">{t('detail.kickerAccountSkills')}</p>
        <h2>{skills.length === 1 ? t('detail.syncedOne', { n: skills.length }) : t('detail.syncedOther', { n: skills.length })}</h2>
        <p className="muted">{t('detail.syncedNote')}</p>
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
        <p className="kicker">{t('detail.kickerAgent', { scope: agent.scope === 'user' ? t('detail.scopeUser') : t('detail.scopeProject') })}</p>
        <h2>{agent.name}</h2>
        <p className="muted mono">{agent.filePath}</p>
        <p className="badges">
          <LinkBadge link={agent.link} />
          <span className="badge">{agent.model ? t('detail.modelOf', { model: agent.model }) : t('detail.callerModel')}</span>
          <span className="badge">{agent.effort ? t('detail.effortOf', { effort: agent.effort }) : t('detail.defaultEffort')}</span>
          {agent.duplicate && <span className="badge warn">{t('detail.duplicateOnly')}</span>}
        </p>
        {onEdit && !agent.error && (
          <p className="actions">
            <button className="btn-secondary" onClick={onEdit}>
              {t('detail.editAgent')}
            </button>
          </p>
        )}
      </header>
      {agent.error && <p className="error">{agent.error}</p>}
      {cost && (
        <section className="section">
          <h3>{t('detail.asSubagentCost')}</h3>
          <dl className="stats">
            <div><dt>{t('detail.ofSubagents')}</dt><dd>{formatShare(cost.usd, agentsUsd)}</dd></div>
            <div><dt>{t('detail.perRun')}</dt><dd>{formatShare(cost.usd / Math.max(1, cost.runs), agentsUsd)}</dd></div>
          </dl>
          <p className="muted small">
            {cost.runs === 1 ? t('detail.runOne', { n: cost.runs }) : t('detail.runOther', { n: cost.runs })}, {t('detail.summingAll')}
          </p>
        </section>
      )}
      {agent.link.target && <Field label={t('detail.origin')} mono value={agent.link.target} />}
      {agent.description && <Field label={t('detail.description')} value={agent.description} />}
      <section className="section">
        <h3>{t('detail.tools')}</h3>
        {agent.tools ? (
          <ul className="chips">
            {agent.tools.map((t) => (
              <li key={t} className="chip mono">{t}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('detail.allTools')}</p>
        )}
      </section>
    </>
  );
}

export function SkillPanel({ skill }: { skill: Skill }) {
  return (
    <>
      <header className="header">
        <p className="kicker">
          {t('detail.kickerSkill', {
            scope: skill.scope === 'project' ? t('detail.scopeProject') : skill.scope === 'user' ? t('detail.scopeUser') : t('detail.scopeAccount'),
          })}
        </p>
        <h2>{skill.name}</h2>
        <p className="muted mono">{skill.dirPath}</p>
        <p className="badges">
          <LinkBadge link={skill.link} />
          {skill.label && skill.label !== skill.name && <span className="badge dim">{t('detail.labelOf', { label: skill.label })}</span>}
          {skill.readOnly && <span className="badge dim">{t('detail.readOnly')}</span>}
        </p>
      </header>
      {skill.error && <p className="error">{skill.error}</p>}
      {skill.link.target && <Field label={t('detail.origin')} mono value={skill.link.target} />}
      {skill.description && <Field label={t('detail.description')} value={skill.description} />}
      {/* Skill da conta aparece em todas as sessões: dá para copiar para a biblioteca (só quem tem na ficha). */}
      {skill.scope === 'user' && !skill.readOnly && !skill.link.target && <CopyToLibrary name={skill.name} />}
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
        {t('detail.agentsCount', { n: agents.length })}
        {onNew && (
          <button className="btn-secondary" onClick={onNew}>
            {t('detail.newAgent')}
          </button>
        )}
      </h3>
      {agents.length === 0 && <p className="muted">{empty}</p>}
      <ul className="cards">
        {agents.map((a) => (
          <li key={a.id} className={`card ${a.error ? 'card-error' : ''}`}>
            <div className="card-title">
              {a.name}
              {(a.model || a.effort) && <span className="badge">{[a.model, a.effort].filter(Boolean).join(' / ')}</span>}
              <LinkBadge link={a.link} />
              {a.duplicate && <span className="badge warn">{t('detail.duplicateName')}</span>}
              {onEdit && !a.error && (
                <button className="btn-secondary card-action" onClick={() => onEdit(a.name)}>
                  {t('detail.edit')}
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
      <h3>{t('detail.skillsCount', { n: skills.length })}</h3>
      {skills.length === 0 && <p className="muted">{t('detail.noSkills')}</p>}
      <ul className="cards">
        {skills.map((s) => (
          <li key={s.id} className={`card ${s.error ? 'card-error' : ''}`}>
            <div className="card-title">
              {s.name}
              <LinkBadge link={s.link} />
              {s.readOnly && <span className="badge dim">{t('detail.synced')}</span>}
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
      <h3>{t('detail.employeesCount', { n: sessions.length })}</h3>
      {sessions.length === 0 && <p className="muted">{t('detail.noSessions')}</p>}
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
              {s.subagentCount > 0 && <span className="badge dim">{t('detail.subagentsCount', { n: s.subagentCount })}</span>}
              {costs[s.id] !== undefined && <span title={t('detail.inTotalUsage')}>{formatShare(costs[s.id]!, totalUsd)}</span>}
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
      {link.kind === 'symlink' ? t('detail.linked') : 'hardlink'}
    </span>
  );
}

function basename(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function formatDate(isoDate: string) {
  return new Date(isoDate).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });
}
