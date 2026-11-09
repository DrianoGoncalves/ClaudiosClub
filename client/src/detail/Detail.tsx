import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  Agent,
  CostReport,
  CostSummary,
  InboxItem,
  LinkInfo,
  LiveSession,
  Project,
  ProjectColor,
  ProjectDetail,
  SavingsReport,
  Session,
  Skill,
  StaffProfile,
  TaskSummary,
  UserScope,
} from '../../../shared/model';
import { TEMP_IDLE_DAYS } from '../../../shared/model';
import { alertError, api, isPairingError } from '../api';
import { RoomColorPicker } from '../board/colors';
import { portraitUrl } from '../board/nodes';
import { idleUnseen, showsStatus, useSeeIdle, useSeenIdle } from '../board/unread';
import { ChatView, type MoreTab } from '../chat/ChatView';
import type { ChatFocus } from '../chat/chatFocus';
import { MoreTabs } from '../chat/MoreTabs';
import { BrowserCheck } from '../staff/BrowserCheck';
import type { StaffFormTab } from '../staff/HireForm';
import { StaffHistory } from '../staff/StaffHistory';
import { MAX_INPUT_BYTES, PROJECT_IMAGE_MAX, shrinkImage } from '../lib/shrinkImage';
import { Attachments } from './Attachments';
import { ProjectGuide } from './ProjectGuide';
import { ProjectName } from './ProjectName';
import { Routines } from './Routines';
import { WorthIt } from './WorthIt';
import { effortLabel, employeeName, ENTRYPOINT_LABEL, folderName, formatPercent, formatShare, formatUsd, STATUS_LABEL } from '../format';
import { isLoss, type RankingGroup, type RankingRow, rankingRows, savingsList, teamSavings } from '../ranking';
import { t, locale } from '../i18n';
import { ServerLog } from '../office/ServerLog';
import { ArchiveIcon, ArchiveRestoreIcon, CopyIcon, FolderIcon, GhostIcon, MessageIcon, PlusIcon, TasksIcon, UserPlusIcon } from '../icons';
import { CopyToLibrary, SkillLibrary } from '../office/SkillLibrary';

// Painel lateral: o que o nó selecionado no quadro tem por trás.

type ProjectCost = CostSummary & { sessions: Record<string, number> };

function ArchiveButton({
  archived,
  onArchive,
  what,
  restoreLabel = t('detail.unarchive'),
  iconOnly = false,
  confirm = false,
}: {
  archived: boolean;
  onArchive: (v: boolean) => Promise<void>;
  what: string;
  restoreLabel?: string;
  /** Só o ícone (com o texto no title e no aria-label). */
  iconOnly?: boolean;
  /** Pede confirmação antes de arquivar (desarquivar não pergunta) e pinta o botão de vermelho. */
  confirm?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const click = async () => {
    if (confirm && !archived && !window.confirm(t('detail.archiveConfirm', { what }))) return;
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
        className={['btn-secondary', iconOnly && 'btn-icon', confirm && !archived && 'is-danger'].filter(Boolean).join(' ')}
        onClick={click}
        disabled={busy}
        aria-label={iconOnly ? (archived ? restoreLabel : t('detail.archive')) : undefined}
        title={archived ? t('detail.showOnBoard', { what }) : t('detail.hideFromBoard', { what })}
      >
        {iconOnly ? archived ? <ArchiveRestoreIcon /> : <ArchiveIcon /> : archived ? restoreLabel : t('detail.archive')}
      </button>
      {error && <span className="error">{error}</span>}
    </>
  );
}

export function EmployeePanel(props: {
  session: Session | null;
  /** Sessões vivas: a conversa aberta, parada, conta como vista (tira a bolinha de ocioso do quadro). */
  live?: LiveSession[];
  staff: StaffProfile | null;
  managers: StaffProfile[];
  project: Project | null;
  costUsd: number | null;
  /** Consumo de todos, para mostrar a parte deste funcionário. */
  totalUsd: number;
  archived: boolean;
  onArchive: (v: boolean) => Promise<void>;
  onHireSub: () => void;
  /** Editar a ficha; sem ficha, dar uma para a conversa aberta (`sessionId`). */
  onEdit: (sessionId: string | null) => void;
  /**
   * A ficha editável (o formulário embutido), repartida nas abas Ficha e Projeto do "Mais": recebe a aba do formulário
   * (`null` = a aberta é outra: fica escondido, sem perder o que foi digitado) e como pedir a troca de aba.
   */
  sheetForm?: (tab: StaffFormTab | null, onTab: (tab: StaffFormTab) => void) => ReactNode;
  /** A ficha voltou a uma versão do histórico: o quadro relê. */
  onRestored?: (profile: StaffProfile) => void;
  /** Funcionário fantasma: as conversas sem ficha do projeto, num nó só. */
  ghost?: boolean;
  onSessionStarted?: (sessionId: string) => void;
  /** Arquivo citado numa resposta do chat: abre no editor de arquivos do projeto (relativo à raiz). */
  onOpenFile?: (path: string) => void;
  /** A ficha mudou por aqui (rotinas): o quadro relê. */
  onChanged?: () => void;
  /** Nível simples: o painel fica só com a conversa. */
  simple?: boolean;
  onShowAdvanced?: () => void;
  /** Conversas do funcionário, da mais recente à mais antiga. */
  conversations?: Array<{ id: string; title: string | null; updatedAt: string | null }>;
  /** Abrir nesta conversa (achada na busca do Ctrl+K). */
  initialConversation?: string | null;
  /** Clique num aviso da caixa "precisa de mim": a conversa do aviso e o balão a mostrar nela. */
  focus?: ChatFocus | null;
  onFocusDone?: () => void;
  /** A caixa "precisa de mim": conversa com aviso nela abre no fim, como antes. */
  inbox?: InboxItem[];
  /**
   * Editando pelo RH: as mesmas abas do "Mais", mas no lugar da conversa, com o seletor de projeto (a mesma pessoa em
   * outros projetos) e o "Conversar", que abre o painel dela no chat do projeto escolhido.
   */
  manage?: {
    /** As fichas da pessoa, uma por projeto (a deste painel inclusive). */
    copies: Array<{ projectId: string; staffId: string; projectName: string }>;
    tab: string;
    onTab: (tab: string) => void;
    onProject: (projectId: string) => void;
    onChat: () => void;
    onBack: () => void;
  };
}) {
  const { session: s, staff, project } = props;
  // Qual conversa está aberta: a mais recente, outra da lista, ou uma nova (ainda sem sessão).
  // A conversa pedida (busca) só vale se for deste funcionário.
  // A do aviso (caixa "precisa de mim") também vale se for deste funcionário, mesmo criada agora, antes de o quadro relê-la.
  const noticed =
    props.focus && props.focus.projectId === project?.id && props.focus.staffId === (staff?.id ?? null) ? props.focus.sessionId : null;
  const wanted =
    props.initialConversation && (props.initialConversation === noticed || props.conversations?.some((c) => c.id === props.initialConversation))
      ? props.initialConversation
      : null;
  const [picked, setPicked] = useState<string | null>(wanted ?? s?.id ?? null);
  const [fresh, setFresh] = useState(false);
  // A conversa nova, depois da primeira mensagem, já tem sessão: o ChatView segue nela sem remontar (fica com a
  // chave de "nova"), e ela entra na lista na hora, para dar para trocar de conversa e voltar antes do quadro
  // reler as fichas e os transcripts.
  const [freshId, setFreshId] = useState<string | null>(null);
  const [freshN, setFreshN] = useState(0);
  // A conversa do aviso, criada agora, entra na lista como uma recém-começada (o quadro a repete ali quando relê, e a repetida sai daqui).
  const [started, setStarted] = useState<Array<{ id: string; title: string; updatedAt: string }>>(() =>
    noticed ? [{ id: noticed, title: t('detail.newConversation'), updatedAt: new Date().toISOString() }] : [],
  );
  const first = useRef(true);
  useEffect(() => {
    // Na primeira vez vale a conversa pedida (busca). Depois, só adota a mais recente se não há conversa aberta:
    // trocar sozinho com uma aberta remonta o chat e apaga o rascunho que o user estava digitando.
    if (first.current) {
      first.current = false;
      return;
    }
    if (picked !== null || fresh) return;
    setPicked(s?.id ?? null);
    setFresh(false);
    setFreshId(null);
  }, [s?.id]);
  /** A sessão que o ChatView abre: nenhuma na conversa nova (mesmo depois que ela ganhou id). */
  const opened = fresh ? null : picked;
  const current = fresh ? freshId : picked;
  // Conversa na tela (sem projeto não há chat): parada, já foi vista.
  useSeeIdle(project && current && !props.manage ? (props.live?.find((l) => l.sessionId === current) ?? (current === s?.id ? s.live : null)) : null);
  // Conversa parada e ainda não vista (a da tela não conta): o select põe "● " no nome, para lembrar o que falta ler.
  const seen = useSeenIdle();
  const unread = (id: string) => {
    const l = id !== current ? props.live?.find((x) => x.sessionId === id) : undefined;
    return !!l && idleUnseen(seen, l);
  };
  // Sem ficha, a lista é a própria conversa: dá para abrir uma nova (a pesada fica no quadro) e voltar a ela.
  const listed = props.conversations?.length
    ? props.conversations
    : !staff && s
      ? [{ id: s.id, title: s.topic ?? s.title, updatedAt: s.updatedAt }]
      : [];
  const conversations = [...started.filter((c) => !listed.some((l) => l.id === c.id)), ...listed];
  const sessionStarted = (id: string) => {
    if (fresh) setFreshId(id);
    setStarted((prev) => (prev.some((c) => c.id === id) ? prev : [{ id, title: t('detail.newConversation'), updatedAt: new Date().toISOString() }, ...prev]));
    props.onSessionStarted?.(id);
  };
  const pick = (id: string) => {
    setFresh(false);
    setFreshId(null);
    setPicked(id);
  };
  // Clique num aviso com o painel já aberto (e talvez em outra conversa): vai para a conversa do aviso.
  // Só depende do aviso de propósito: com `conversations`/`current` aqui, trocar de conversa à mão voltaria para a do aviso.
  useEffect(() => {
    const want = props.focus?.sessionId;
    if (want && want !== current && conversations.some((c) => c.id === want)) pick(want);
  }, [props.focus]);
  const [convBusy, setConvBusy] = useState(false);
  const duplicate = async () => {
    if (!project || !current) return;
    setConvBusy(true);
    try {
      const r = await api.chatFork(project.id, current, staff?.id ?? null);
      pick(r.sessionId);
      props.onSessionStarted?.(r.sessionId);
    } catch (e) {
      alertError(e);
    } finally {
      setConvBusy(false);
    }
  };
  const live = s?.live?.alive ? s.live : null;
  const name = staff?.name ?? (props.ghost ? t('detail.ghostName') : s ? employeeName(s) : '?');
  const showConvos = !!project && (conversations.length > 0 || fresh);
  const statusInfo = live
    ? { dot: `dot dot-${live.status ?? 'unknown'}`, text: STATUS_LABEL[live.status ?? ''] ?? live.status }
    : { dot: 'dot', text: s ? t('detail.offShift') : t('detail.noSessionYet') };
  // Topo compacto: quem é e como está. Logo abaixo, a conversa (linha 2) e os avisos que pedem ação.
  const top = (
    <>
      <div className="employee-top">
        {staff?.portrait && project && <img className="employee-portrait" src={portraitUrl(project.id, staff)} alt={t('detail.portraitOf', { name: staff.name })} />}
        {props.ghost && (
          <span className="employee-portrait employee-ghost" aria-hidden="true">
            <GhostIcon size={30} />
          </span>
        )}
        <div className="employee-ident">
          <h2 className="employee-name" title={name}>
            {name}
          </h2>
          <span className="badge">
            <span className={statusInfo.dot} /> {statusInfo.text}
          </span>
          {staff?.temporary && <span className="badge warn">{t('detail.temporary')}</span>}
          {(staff || project) && (
            <span className="employee-cargo" title={[staff?.role, project?.name].filter(Boolean).join(' · ')}>
              {[staff?.role, project?.name].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
      </div>
      {showConvos && !props.manage && (
        <div className="chat-convos">
          <select
            aria-label={t('detail.conversation')}
            value={current ?? ''}
            onChange={(e) => pick(e.target.value)}
          >
            {fresh && !freshId && <option value="">{t('detail.newConversation')}</option>}
            {byDay(conversations).map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map(({ c }) => (
                  <option key={c.id} value={c.id}>
                    {(unread(c.id) ? '● ' : '') + conversationLabel(c)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            type="button"
            className="btn-secondary chat-icon-btn"
            disabled={(fresh && !freshId) || convBusy}
            onClick={() => {
              setFresh(true);
              setFreshId(null);
              setFreshN((n) => n + 1);
            }}
            aria-label={t('detail.newConversation')}
            title={t('detail.newConversationTitle')}
          >
            <PlusIcon />
          </button>
          {/* Duplicar (o nome da conversa vem sozinho da primeira mensagem). */}
          <button
            type="button"
            className="btn-secondary chat-icon-btn"
            disabled={!current || convBusy}
            onClick={() => void duplicate()}
            aria-label={t('detail.duplicate')}
            title={t('detail.duplicateTitle')}
          >
            <CopyIcon />
          </button>
        </div>
      )}
      {staff?.temporary && project && (
        <TempNotice staff={staff} managers={props.managers} projectId={project.id} archived={props.archived} onArchive={props.onArchive} onChanged={props.onChanged} />
      )}
      {staff?.browser && !props.manage && <BrowserCheck />}
    </>
  );
  const enabledRoutines = staff?.routines?.filter((r) => r.enabled).length ?? 0;
  // As abas do funcionário no "Mais": Ficha e Projeto (a edição da ficha, repartida), Desempenho (consumo e atividade)
  // e Ações (rotinas, contratar, arquivar, histórico). Sem ficha, a aba Ficha só oferece dar uma.
  const editable = !!staff && !!project && !!props.sheetForm;
  const formTab: Record<string, StaffFormTab | undefined> = { ficha: 'sheet', projeto: 'project' };
  const sheetTabId = (tab: StaffFormTab) => (tab === 'sheet' ? 'ficha' : 'projeto');
  const performance = (
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
      {(s?.entrypoint || s?.gitBranch || !staff || props.archived) && (
        <p className="badges">
          {s?.entrypoint && <span className="badge">{ENTRYPOINT_LABEL[s.entrypoint] ?? s.entrypoint}</span>}
          {s?.gitBranch && <span className="badge dim">{s.gitBranch}</span>}
          {!staff && <span className="badge dim">{t('detail.noSheet')}</span>}
          {props.archived && <span className="badge dim">{t('detail.archived')}</span>}
        </p>
      )}
      {s && <p className="muted small mono">{t('detail.sessionId', { id: s.id })}</p>}
      {staff && staff.servers.length > 0 && (
        <>
          <h4>{t('detail.servers')}</h4>
          <ServerLog projectId={staff.projectId} staffId={staff.id} />
        </>
      )}
    </>
  );
  const actions = (
    <>
      {staff && project && (
        <>
          <h4>{enabledRoutines ? t('detail.routinesCount', { n: enabledRoutines }) : t('detail.tabRoutines')}</h4>
          <Routines projectId={project.id} staff={staff} onChanged={props.onChanged} />
        </>
      )}
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
      {staff && project && (
        <StaffHistory key={staff.updatedAt} projectId={project.id} staffId={staff.id} onRestored={(profile) => props.onRestored?.(profile)} />
      )}
    </>
  );
  /**
   * O que a aba mostra. O formulário da ficha é o mesmo elemento em toda aba (escondido nas que não são dele), então
   * trocar de Ficha para Projeto, ou ir ver o Desempenho, não perde o que foi digitado e ainda não salvo.
   */
  const page = (id: string, select: (id: string) => void): ReactNode => (
    <>
      {id === 'ficha' && props.simple && (
        <p className="muted small simple-more">
          {t('detail.simpleMore')}{' '}
          {props.onShowAdvanced && (
            <button type="button" className="link" onClick={props.onShowAdvanced}>
              {t('detail.show')}
            </button>
          )}
        </p>
      )}
      {editable ? (
        props.sheetForm!(formTab[id] ?? null, (tab) => select(sheetTabId(tab)))
      ) : (
        id === 'ficha' && (
          <>
            <p className="muted small">{t(props.ghost ? 'detail.ghostAbout' : 'detail.outsideMyco')}</p>
            <div className="chat-more-row">
              <button type="button" className="btn-secondary" onClick={() => props.onEdit(current)} title={t('detail.giveProfileTitle')}>
                {t('detail.giveProfile')}
              </button>
            </div>
          </>
        )
      )}
      {id === 'desempenho' && performance}
      {id === 'acoes' && actions}
    </>
  );
  const tabs: MoreTab[] = [
    { id: 'ficha', label: t('detail.tabSheet') },
    // No nível simples o painel fica só com a Ficha (o formulário põe o projeto embaixo, com "Mostrar todos os campos").
    ...(editable && !props.simple ? [{ id: 'projeto', label: t('detail.tabProject') }] : []),
    ...(props.simple
      ? []
      : [
          { id: 'desempenho', label: t('detail.tabPerformance') },
          { id: 'acoes', label: t('detail.tabActions') },
        ]),
  ].map((tab) => ({ ...tab, content: (select: (id: string) => void) => page(tab.id, select) }));
  if (props.manage && project && staff) {
    const m = props.manage;
    return (
      <section className="chat manage">
        <div className="chat-top">{top}</div>
        <div className="manage-bar">
          <button type="button" className="link manage-back" onClick={m.onBack} title={t('hr.backTitle')} aria-label={t('hr.backTitle')}>
            ‹ {t('hr.back')}
          </button>
          <div className="manage-project">
            <label>
              <span className="muted small">{t('hr.manageProject')}</span>
              <select className="setting-select" value={project.id} disabled={m.copies.length < 2} onChange={(e) => m.onProject(e.target.value)}>
                {m.copies.map((c) => (
                  <option key={c.projectId} value={c.projectId}>
                    {c.projectName}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn-secondary btn-with-icon" onClick={m.onChat} title={t('hr.chatTitle', { name: staff.name, project: project.name })}>
              <MessageIcon /> {t('hr.chat')}
            </button>
          </div>
          <p className="muted small">{t('hr.manageHint')}</p>
        </div>
        <div className="manage-body">
          <MoreTabs tabs={tabs} active={m.tab} onActive={m.onTab} label={t('chat.moreOptions')} />
        </div>
      </section>
    );
  }
  // Sem projeto não há conversa (nem "Mais"): o topo e as abas, uma embaixo da outra, com rolagem própria.
  if (!project) {
    return (
      <div className="employee-scroll">
        {top}
        {tabs.map((tab) => (
          <section key={tab.id} className="section">
            <h3>{tab.label}</h3>
            {typeof tab.content === 'function' ? tab.content(() => {}) : tab.content}
          </section>
        ))}
      </div>
    );
  }
  // Com o chat fechado, o seletor mostra o que a conversa vai usar ao abrir: o escolhido nela > o da ficha > o último escolhido no chat.
  const chosen = opened ? staff?.sessions.find((x) => x.id === opened) : undefined;
  const opening = staff
    ? { model: chosen?.model ?? staff.model ?? staff.lastModel ?? null, effort: chosen?.effort ?? staff.effort ?? staff.lastEffort ?? null }
    : null;
  return (
    <ChatView
      key={`${opened ?? `novo${freshN}`}:${staff?.id ?? ''}`}
      projectId={project.id}
      sessionId={opened}
      staffId={staff?.id ?? null}
      name={name}
      autonomy={staff?.autonomy ?? null}
      disabled={!project.exists ? t('detail.projectFolderMissing') : null}
      onSessionStarted={sessionStarted}
      projectRoot={project.path}
      onOpenFile={props.onOpenFile}
      level={props.simple ? 'simple' : 'advanced'}
      fichaModel={opening?.model ?? null}
      fichaEffort={opening?.effort ?? null}
      engine={staff?.engine ?? 'claude'}
      top={top}
      moreTabs={tabs}
      focus={props.focus}
      onFocusDone={props.onFocusDone}
      awaiting={!!opened && !!props.inbox?.some((i) => i.sessionId === opened)}
    />
  );
}

/** "14:05 — Ajustar o header da sala" (o dia vem do grupo). */
function conversationLabel(c: { title: string | null; updatedAt: string | null }): string {
  const title = (c.title ?? t('detail.untitledConversation')).replace(/\s+/g, ' ').slice(0, 48);
  const when = c.updatedAt ? new Date(c.updatedAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : '';
  return when ? `${when} — ${title}` : title;
}

/** As conversas por dia (Hoje, Ontem, depois a data), na ordem da lista; `i` é a posição na lista toda. */
function byDay<T extends { updatedAt: string | null }>(list: T[]): Array<{ label: string; items: Array<{ c: T; i: number }> }> {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOf(new Date());
  const groups: Array<{ label: string; items: Array<{ c: T; i: number }> }> = [];
  list.forEach((c, i) => {
    const at = c.updatedAt ? new Date(c.updatedAt) : null;
    const day = at ? startOf(at) : null;
    const label =
      day === null
        ? t('detail.untitledConversation')
        : day >= today
          ? t('detail.today')
          : day >= today - 86_400_000
            ? t('detail.yesterday')
            : at!.toLocaleDateString(locale(), { weekday: 'short', day: '2-digit', month: '2-digit' });
    const last = groups.at(-1);
    if (last?.label === label) last.items.push({ c, i });
    else groups.push({ label, items: [{ c, i }] });
  });
  return groups;
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

/** Um funcionário no painel do projeto, com as conversas dele somadas (ver projectTeam no App). */
export interface TeamRow {
  staff: StaffProfile;
  conversations: number;
  lastAt: string | null;
  /** Status da conversa aberta mais ocupada (trabalhando > esperando > parada); null = nenhuma aberta. */
  status: string | null;
  costUsd: number | null;
}

export function ProjectPanel({
  id,
  live,
  team,
  owned,
  onOpenStaff,
  onOpenSession,
  hiddenSessions,
  cost,
  archived,
  onArchive,
  onHire,
  image,
  onImage,
  color,
  onColor,
  onName,
  totalUsd,
  onNewAgent,
  onEditAgent,
  onTasks,
  onFiles,
  onOpenFile,
  onOpenConversation,
  tasks,
  office,
}: {
  /** Abre um arquivo do projeto direto no editor de Arquivos (ex.: o guia SPEC.md). */
  onOpenFile?: (path: string) => void;
  /** Abre uma conversa nova de um funcionário no painel dele (ex.: o pedido do guia SPEC.md). */
  onOpenConversation?: (staffId: string, sessionId: string) => void;
  /** Empresa e servidores do projeto (ver office/ProjectOffice.tsx). */
  office?: React.ReactNode;
  onNewAgent?: () => void;
  onEditAgent?: (name: string) => void;
  /** Abre o quadro de tarefas do projeto. */
  onTasks?: () => void;
  /** Abre os arquivos do projeto (árvore + editor). */
  onFiles?: () => void;
  /** Tarefas abertas, em revisão e o último deploy. */
  tasks?: TaskSummary | null;
  id: string;
  live: LiveSession[];
  /** Uma linha por funcionário; clicar abre o painel dele. */
  team: TeamRow[];
  /** Sessões que têm dono (ficha): as outras aparecem à parte, como conversas sem ficha. */
  owned: Set<string>;
  onOpenStaff: (staffId: string) => void;
  /** Abre uma conversa sem ficha no painel do fantasma (o mesmo do cartão no quadro). */
  onOpenSession?: (sessionId: string) => void;
  /** Conversas sem ficha que não aparecem (arquivadas, com "mostrar arquivados" desligado). */
  hiddenSessions?: Set<string>;
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
  /** Apelido do projeto (só na tela); null volta ao nome da pasta. */
  onName: (name: string | null) => Promise<void>;
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A aba fica ao trocar de projeto (o painel não remonta), como a do ⋯ do funcionário.
  const [tab, setTab] = useState<ProjectTab>('project');

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

  // Depois de salvar, o detalhe é relido: o cabeçalho mostra o apelido novo.
  const rename = async (name: string | null) => {
    await onName(name);
    api.project(id).then(setDetail, (e: Error) => setError(e.message));
  };

  return (
    <>
      <header className="header">
        <p className="kicker">{t('detail.kickerProject')}</p>
        <h2>
          <ProjectName name={project.name} folder={folderName(project.path)} onRename={rename} />
        </h2>
        <p className="muted mono">{project.path}</p>
        <p className="badges">
          {project.hasClaudeMd ? <span className="badge">CLAUDE.md</span> : <span className="badge dim">{t('detail.noClaudeMd')}</span>}
          {project.worktreeOf && <span className="badge">{t('detail.worktreeOf', { name: basename(project.worktreeOf) })}</span>}
          {!project.exists && <span className="badge warn">{t('detail.folderMissing')}</span>}
          {archived && <span className="badge dim">{t('detail.archived')}</span>}
        </p>
        <p className="actions">
          {project.exists && (
            <button className="btn-primary btn-with-icon" onClick={onHire} title={t('detail.hireEmployee')}>
              <UserPlusIcon />
              {t('detail.employee')}
            </button>
          )}
          {project.exists && onTasks && (
            <button className="btn-secondary btn-icon" onClick={onTasks} aria-label={t('detail.tasks')} title={t('detail.boardTasksTitle')}>
              <TasksIcon size={16} />
            </button>
          )}
          {project.exists && onFiles && (
            <button className="btn-secondary btn-icon" onClick={onFiles} aria-label={t('files.open')} title={t('files.openTitle')}>
              <FolderIcon size={16} />
            </button>
          )}
          <ArchiveButton archived={archived} onArchive={onArchive} what={t('detail.whatProjectAndStaff')} iconOnly confirm />
        </p>
        {tasks && (
          <p className="muted small">
            {tasks.open === 1 ? t('detail.taskOpenOne', { n: tasks.open }) : t('detail.taskOpenOther', { n: tasks.open })}
            {tasks.review ? `, ${t('detail.inReview', { n: tasks.review })}` : ''}
          </p>
        )}
      </header>
      <div className="tabs" role="tablist" aria-label={t('detail.kickerProject')}>
        {PROJECT_TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`project-tab-${k}`}
            aria-selected={tab === k}
            aria-controls="project-tab-panel"
            className={`tab ${tab === k ? 'is-active' : ''}`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="project-tab-panel" aria-labelledby={`project-tab-${tab}`}>
        {tab === 'project' && (
          <>
            {project.exists && (
              <ProjectGuide
                projectId={project.id}
                staff={team.map((r) => r.staff)}
                onOpen={onOpenFile}
                onOpenConversation={onOpenConversation}
              />
            )}
            {project.exists && !project.worktreeOf && office}
            {project.exists && <Attachments projectId={project.id} />}
          </>
        )}
        {tab === 'team' && (
          <>
            <TeamList rows={team} totalUsd={totalUsd} onOpen={onOpenStaff} />
            <SessionList
              sessions={sessions.filter((s) => !owned.has(s.id) && !hiddenSessions?.has(s.id))}
              costs={cost?.sessions ?? {}}
              totalUsd={totalUsd}
              onOpen={onOpenSession}
            />
          </>
        )}
        {tab === 'tools' && (
          <>
            <AgentList
              agents={detail.agents}
              empty={t('detail.noAgentsProject')}
              onNew={project.exists ? onNewAgent : undefined}
              onEdit={project.exists ? onEditAgent : undefined}
            />
            <SkillList skills={detail.skills} />
          </>
        )}
        {tab === 'look' && (
          <>
            <section className="section">
              <h3>{t('detail.roomColor')}</h3>
              <RoomColorPicker value={color} onChange={onColor} />
              <p className="muted small">
                {project.worktreeOf ? t('detail.worktreeRoomNote') : t('detail.roomColorNote')}
              </p>
            </section>
            {project.exists && <ImagePicker image={image} onChange={onImage} />}
          </>
        )}
      </div>
    </>
  );
}

type ProjectTab = 'project' | 'team' | 'tools' | 'look';
const PROJECT_TABS: Array<[ProjectTab, string]> = [
  ['project', t('detail.tabProject')],
  ['team', t('detail.tabTeam')],
  ['tools', t('detail.tabTools')],
  ['look', t('detail.tabLook')],
];

/** Logo do projeto (fica em .myco/ do projeto). */
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
      if (!isPairingError(e)) setMsg({ tone: 'error', text: (e as Error).message });
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

type RankingTab = 'cost' | 'savings';
const RANKING_TABS: Array<[RankingTab, string]> = [['cost', t('detail.tabCost')], ['savings', t('detail.tabSavings')]];

/** Período do ranking em dias (null = tudo); o padrão são os últimos 3 meses. */
const RANKING_PERIODS: Array<[string, number | null, string]> = [['90', 90, t('detail.periodLast3Months')], ['all', null, t('detail.periodAll')]];

/** Uma linha do ranking de funcionários; arquivado fica apagado e com a etiqueta. */
function RankingItem({
  pos,
  row,
  sub,
  value,
  bad,
  bar,
  saving,
  onSelect,
  onOpenPerson,
}: {
  pos: number;
  row: RankingRow;
  sub?: ReactNode;
  value: ReactNode;
  bad?: boolean;
  /** Tamanho da barra, de 0 a 1. */
  bar: number;
  saving?: boolean;
  onSelect: (nodeId: string) => void;
  onOpenPerson: (person: { projectId: string; staffId: string }) => void;
}) {
  const person = row.person;
  return (
    <li>
      <button
        className={`ranking-row ${row.archived ? 'is-archived' : ''}`}
        onClick={() => (person ? onOpenPerson(person) : onSelect(row.nodeId))}
        title={person ? t('detail.openInHr') : t('detail.showOnBoardLink')}
      >
        <span className="ranking-pos">{pos}</span>
        <span className="ranking-text">
          <span className="ranking-name">{row.name}</span>
          <span className="muted small">
            {row.detail}
            {row.archived && <span className="badge dim ranking-tag">{t('detail.archived')}</span>}
            {sub}
          </span>
        </span>
        <span className={`ranking-value ${bad ? 'worth-bad' : ''}`}>{value}</span>
        <span className={`ranking-bar ${saving ? 'is-saving' : ''}`} style={{ width: `${bar * 100}%` }} />
      </button>
    </li>
  );
}

/**
 * Ranking, em abas: quem mais gasta e quem mais economiza (funcionários, no período escolhido) e os
 * agents. Os gastos são equivalentes em API
 * (estimativa): servem para comparar, não como conta a pagar.
 */
export function RankingPanel({
  groups,
  agents,
  scanning,
  onSelect,
  onOpenPerson,
}: {
  groups: RankingGroup[];
  agents: Array<{ type: string; usd: number; runs: number }>;
  scanning: boolean;
  /** O fantasma (conversas sem ficha): seleciona o nó dele no quadro. */
  onSelect: (nodeId: string) => void;
  /** Quem tem ficha: abre no RH, no projeto da linha. */
  onOpenPerson: (person: { projectId: string; staffId: string }) => void;
}) {
  const [tab, setTab] = useState<RankingTab>('cost');
  const [limit, setLimit] = useState(10);
  const [period, setPeriod] = useState('90');
  const [report, setReport] = useState<SavingsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Carrega ao abrir e ao trocar o período, e rebusca: a cada 5 s enquanto os transcripts são lidos,
  // senão no ritmo do polling de custos do App (30 s). `alive` descarta a resposta de um período já
  // trocado. O refresh não zera o relatório: o "Calculando…" só aparece na primeira carga do período.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loaded = false;
    const days = RANKING_PERIODS.find(([k]) => k === period)?.[1] ?? null;
    setReport(null);
    setError(null);
    const tick = () =>
      api.savings(days).then(
        (r) => {
          if (!alive) return;
          loaded = true;
          setError(null);
          setReport((prev) => (prev && JSON.stringify(prev) === JSON.stringify(r) ? prev : r));
          timer = setTimeout(tick, r.scanning ? 5_000 : 30_000);
        },
        (e: Error) => {
          if (!alive) return;
          // Falha num refresh mantém o que já está na tela; só a primeira carga mostra o erro.
          if (!loaded) setError(e.message);
          timer = setTimeout(tick, 30_000);
        },
      );
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [period]);
  const rows = report ? rankingRows(groups, report) : null;
  const topEmployee = rows?.[0]?.usd ?? 0;
  const topAgent = agents[0]?.usd ?? 0;
  // Participação de cada um no gasto da lista (funcionários entre si; agents entre si).
  const employeesTotal = rows?.reduce((s, e) => s + e.usd, 0) ?? 0;
  const agentsTotal = agents.reduce((s, a) => s + a.usd, 0);
  const savers = rows ? savingsList(rows) : [];
  const team = rows ? teamSavings(rows) : null;
  const topSaved = savers.reduce((m, r) => Math.max(m, Math.abs(r.savedUsd)), 0);
  const idle = rows ? rows.length - savers.length : 0;
  const employeesHead = (
    <div className="ranking-head">
      <h3>{t('detail.employees')}</h3>
      <select className="ranking-period" value={period} onChange={(e) => (setPeriod(e.target.value), setLimit(10))} aria-label={t('detail.period')}>
        {RANKING_PERIODS.map(([k, , label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
  // O que mostrar no lugar da lista enquanto não há dados (ou se deu erro).
  const waiting = error ? <p className="error small">{error}</p> : !rows ? <p className="muted small">{t('detail.calculating')}</p> : null;
  return (
    <>
      <header className="header">
        <p className="kicker">{t('detail.kickerRanking')}</p>
        <h2>{tab === 'cost' ? t('detail.topSpenders') : t('detail.topSavers')}</h2>
        {tab === 'cost' && (
          <p className="muted small">
            {t('detail.costNote')}
            {(scanning || report?.scanning) && ` ${t('detail.stillScanning')}`}
          </p>
        )}
        {tab === 'savings' && report?.scanning && <p className="muted small">{t('detail.stillReading')}</p>}
      </header>
      <div className="tabs" role="tablist">
        {RANKING_TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'is-active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'savings' ? (
        <section className="section">
          {employeesHead}
          {waiting}
          {rows && rows.length === 0 && <p className="muted">{t('detail.noCostYet')}</p>}
          {rows && rows.length > 0 && savers.length === 0 && <p className="muted">{t('detail.noSubagentsInPeriod')}</p>}
          {savers.length > 0 && (
            <>
              <p className={`ranking-total ${team && isLoss(team.savedUsd) ? 'worth-bad' : ''}`}>
                {team === null
                  ? t('detail.noPriceNote')
                  : isLoss(team.savedUsd)
                    ? t('detail.teamSpentMore', { usd: formatUsd(-team.savedUsd), pct: formatPercent(-team.savedPct) })
                    : t('detail.teamSaved', { usd: formatUsd(Math.max(0, team.savedUsd)), pct: formatPercent(Math.max(0, team.savedPct)) })}
              </p>
              <p className="muted small">{t('detail.savingsEstimate')}</p>
              <ol className="ranking">
                {savers.slice(0, limit).map((e, i) => {
                  const loss = isLoss(e.savedUsd);
                  const sign = loss ? '+' : '';
                  return (
                    <RankingItem
                      key={e.nodeId}
                      pos={i + 1}
                      row={e}
                      sub={
                        <>
                          {loss && <span className="worth-bad"> · {t('detail.moreExpensive')}</span>}
                          {e.discardedUsd > 0 && ` · ${t('detail.discardedLabel')} ${formatShare(e.discardedUsd, e.usd)}`}
                        </>
                      }
                      value={
                        e.savedPct === null ? (
                          '—'
                        ) : (
                          <>
                            {sign}
                            {formatUsd(Math.abs(e.savedUsd))} <span className="small">({sign}{formatPercent(Math.abs(e.savedPct))})</span>
                          </>
                        )
                      }
                      bad={loss}
                      saving={!loss}
                      bar={topSaved ? Math.abs(e.savedUsd) / topSaved : 0}
                      onSelect={onSelect}
                      onOpenPerson={onOpenPerson}
                    />
                  );
                })}
              </ol>
              {savers.length > limit && (
                <button className="btn-secondary" onClick={() => setLimit(limit + 20)}>
                  {t('detail.showMore', { n: savers.length - limit })}
                </button>
              )}
              {idle > 0 && <p className="muted small">{idle === 1 ? t('detail.noSubagentEmployeesOne', { n: idle }) : t('detail.noSubagentEmployeesOther', { n: idle })}</p>}
            </>
          )}
        </section>
      ) : (
        <>
          <section className="section">
            {employeesHead}
            {waiting}
            {rows && rows.length === 0 && <p className="muted">{t('detail.noCostYet')}</p>}
            <ol className="ranking">
              {rows?.slice(0, limit).map((e, i) => (
                <RankingItem key={e.nodeId} pos={i + 1} row={e} value={formatShare(e.usd, employeesTotal)} bar={topEmployee ? e.usd / topEmployee : 0} onSelect={onSelect} onOpenPerson={onOpenPerson} />
              ))}
            </ol>
            {rows && rows.length > limit && (
              <button className="btn-secondary" onClick={() => setLimit(limit + 20)}>
                {t('detail.showMore', { n: rows.length - limit })}
              </button>
            )}
          </section>
          <section className="section">
            <div className="ranking-head">
              <h3>{t('detail.agentsSubagentsHeading')}</h3>
              {/* Vem de `costs.agents`, que não segue o período do seletor. */}
              <span className="muted small">{t('detail.agentsAllTime')}</span>
            </div>
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
          <span className="badge">{agent.effort ? t('detail.effortOf', { effort: effortLabel(agent.effort) }) : t('detail.defaultEffort')}</span>
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
              {(a.model || a.effort) && <span className="badge">{[a.model, a.effort && effortLabel(a.effort)].filter(Boolean).join(' / ')}</span>}
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

/** A equipe do projeto: uma linha por funcionário, com as conversas dele somadas. Clicar abre o painel. */
function TeamList({ rows, totalUsd, onOpen }: { rows: TeamRow[]; totalUsd: number; onOpen: (staffId: string) => void }) {
  return (
    <section className="section">
      <h3>{t('detail.teamCount', { n: rows.length })}</h3>
      {rows.length === 0 && <p className="muted">{t('detail.noTeam')}</p>}
      <ul className="rows">
        {rows.map((r) => (
          <li key={r.staff.id}>
            <button type="button" className="row row-button" onClick={() => onOpen(r.staff.id)} title={t('detail.openEmployee', { name: r.staff.name })}>
              <span className="row-title">
                <span className={`dot ${r.status ? `dot-${r.status}` : ''}`} title={r.status ? (STATUS_LABEL[r.status] ?? '') : t('detail.offShift')} />
                {r.staff.name}
                <span className="muted small">{r.staff.role}</span>
              </span>
              <span className="row-meta">
                <span>{t(r.conversations === 1 ? 'detail.convOne' : 'detail.convOther', { n: r.conversations })}</span>
                {r.costUsd !== null && <span title={t('detail.inTotalUsage')}>{formatShare(r.costUsd, totalUsd)}</span>}
                {r.lastAt && <span className="muted">{formatDate(r.lastAt)}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Quantas conversas sem ficha ficam à mostra; o resto, em "ver todas". */
const LOOSE_SHOWN = 5;

/**
 * Conversas sem ficha (abertas no terminal, no app do Claude ou soltas), à parte da equipe: as mais
 * recentes à mostra, o resto recolhido. Clicar abre a conversa no painel do fantasma, para continuar aqui.
 */
function SessionList({
  sessions,
  costs,
  totalUsd,
  onOpen,
}: {
  sessions: Session[];
  costs: Record<string, number>;
  totalUsd: number;
  onOpen?: (sessionId: string) => void;
}) {
  const seen = useSeenIdle();
  if (!sessions.length) return null;
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const row = (s: Session) => {
    const body = (
      <>
        <span className="row-title">
          {/* Ocioso só até você ver a conversa, como no quadro. */}
          {s.live?.alive && showsStatus(seen, s.live) && (
            <span className={`dot dot-${s.live.status ?? 'unknown'}`} title={STATUS_LABEL[s.live.status ?? ''] ?? ''} />
          )}
          {s.topic ?? s.title ?? <span className="muted mono">{s.id.slice(0, 8)}</span>}
        </span>
        <span className="row-meta">
          {s.entrypoint && <span className="badge">{ENTRYPOINT_LABEL[s.entrypoint] ?? s.entrypoint}</span>}
          {s.gitBranch && <span className="badge dim">{s.gitBranch}</span>}
          {s.subagentCount > 0 && <span className="badge dim">{t('detail.subagentsCount', { n: s.subagentCount })}</span>}
          {costs[s.id] !== undefined && <span title={t('detail.inTotalUsage')}>{formatShare(costs[s.id]!, totalUsd)}</span>}
          <span className="muted">{formatDate(s.updatedAt)}</span>
        </span>
      </>
    );
    return onOpen ? (
      <li key={s.id}>
        <button type="button" className="row row-button" onClick={() => onOpen(s.id)} title={t('detail.openLoose')}>
          {body}
        </button>
      </li>
    ) : (
      <li key={s.id} className="row">
        {body}
      </li>
    );
  };
  const rest = sorted.slice(LOOSE_SHOWN);
  return (
    <section className="section">
      <h3>{t('detail.looseCount', { n: sessions.length })}</h3>
      {onOpen && <p className="muted small">{t('detail.looseNote')}</p>}
      <ul className="rows">{sorted.slice(0, LOOSE_SHOWN).map(row)}</ul>
      {rest.length > 0 && (
        <details className="collapse">
          <summary>{t('detail.looseMore', { n: rest.length })}</summary>
          <ul className="rows">{rest.map(row)}</ul>
        </details>
      )}
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
