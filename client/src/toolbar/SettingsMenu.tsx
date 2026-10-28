import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AppConfig, BoardBackground, Project, ProjectColor, SendPriority, UiLevel, UsageStop, Workspace } from '../../../shared/model';
import { DemoButton, WorkspacesEditor } from '../office/WorkspacesSettings';
import { api } from '../api';
import { BackgroundPicker, RoomColorPicker, useSystemTheme } from '../board/colors';
import { useChatDetail } from '../chat/chatDetail';
import { LOCALES, locale, setLocale, t, type Locale, type MsgKey } from '../i18n';
import { RolesEditor } from './RolesEditor';

// Configurações do MyCo, no jeito das do VS Code: busca no topo, grupos à esquerda e cada item
// com título, descrição e o controle logo abaixo. Abre pelo botão "config" ou com Ctrl+,.

interface Props {
  showWorktrees: boolean;
  onToggleWorktrees: (v: boolean) => void;
  showArchived: boolean;
  onToggleArchived: (v: boolean) => void;
  archivedCount: number;
  animations: boolean;
  onToggleAnimations: (v: boolean) => void;
  onRefresh: () => void;
  refreshing: boolean;
  usageStop: UsageStop | null;
  onUsageStop: (stop: UsageStop) => Promise<void>;
  sendWhileBusy: SendPriority | null;
  onSendWhileBusy: (p: SendPriority) => Promise<void>;
  uiLevel: UiLevel | null;
  onUiLevel: (level: UiLevel) => Promise<void>;
  /** Salas de projeto no quadro agora (as que podem ganhar cor). */
  rooms: Array<{ id: string; name: string }>;
  projectColors: Record<string, ProjectColor> | null;
  onProjectColor: (projectId: string, color: ProjectColor | null) => Promise<void>;
  boardBackground: BoardBackground | null;
  onBoardBackground: (bg: Partial<BoardBackground>) => Promise<void>;
  /** Orçamento por projeto: % da cota de 7 dias. */
  projectBudgets: Record<string, number> | null;
  onProjectBudget: (projectId: string, budget: number | null) => Promise<void>;
  /** Todos os projetos (o demo já existe?). */
  projects: Project[];
  /** Workspaces (abas do quadro) e o de cada projeto. */
  workspaces: Workspace[] | null;
  projectWorkspaces: Record<string, string> | null;
  onConfig: (config: AppConfig) => void;
  /** Abre a sala de um projeto (o demo, depois de criado). */
  onOpenProject: (projectId: string) => void;
}

type GroupId = 'board' | 'look' | 'chat' | 'roles' | 'usage';

const GROUPS: Array<{ id: GroupId; label: string; intro: string }> = [
  { id: 'board', label: t('toolbar.groupBoard'), intro: t('toolbar.groupBoardIntro') },
  { id: 'look', label: t('toolbar.groupLook'), intro: t('toolbar.groupLookIntro') },
  { id: 'chat', label: t('toolbar.groupChat'), intro: t('toolbar.groupChatIntro') },
  { id: 'roles', label: t('toolbar.groupRoles'), intro: t('toolbar.groupRolesIntro') },
  { id: 'usage', label: t('toolbar.groupUsage'), intro: t('toolbar.groupUsageIntro') },
];

/** Singular ou plural da chave conforme n. */
const plural = (n: number, one: MsgKey, other: MsgKey) => t(n === 1 ? one : other, { n });

interface Setting {
  id: string;
  group: GroupId;
  title: string;
  description: string;
  /** Palavras a mais para a busca (sinônimos, o nome antigo do item). */
  keywords?: string;
  /** Selo ao lado do título (ex.: "em uso agora"). */
  badge?: string;
  /** Liga/desliga: a descrição vira o rótulo da caixinha, como no VS Code. */
  toggle?: { checked: boolean; onChange: (v: boolean) => void };
  control?: ReactNode;
  /** Só aparece no nível avançado. */
  advanced?: boolean;
}

/** Sem acento e sem caixa: "animacoes" acha "Animações". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const matches = (text: string, words: string[]) => {
  const t = fold(text);
  return words.every((w) => t.includes(w));
};

export function SettingsMenu(props: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<GroupId>('board');
  const [top, setTop] = useState(64);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const theme = useSystemTheme();
  const queryRef = useRef(query);
  queryRef.current = query;

  // Ctrl+, abre e fecha, como no VS Code.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Fecha ao clicar fora e com Esc. Só na busca com texto o Esc limpa primeiro, como no VS Code.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const inSearch = (e.target as Element | null)?.closest?.('.settings-search');
      if (inSearch && queryRef.current) return setQuery('');
      setOpen(false);
      // O foco volta para a engrenagem, para quem navega pelo teclado não se perder.
      root.current?.querySelector<HTMLButtonElement>('.settings-button')?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // O topo pode quebrar em duas linhas: o painel abre logo abaixo dele.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const bar = root.current?.closest('.toolbar') ?? root.current;
      if (bar) setTop(Math.round(bar.getBoundingClientRect().bottom + 8));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  const words = fold(query).split(/\s+/).filter(Boolean);
  const chatDetail = useChatDetail();
  const all = buildSettings(props, theme, () => setOpen(false), words, chatDetail);
  // No simples, só o essencial; o resto continua lá, no avançado.
  const settings = props.uiLevel === 'simple' ? all.filter((s) => !s.advanced) : all;
  const hidden = all.length - settings.length;
  const groupLabel = (id: GroupId) => GROUPS.find((g) => g.id === id)!.label;
  const visible = settings.filter(
    (s) => !words.length || matches(`${groupLabel(s.group)} ${s.title} ${s.description} ${s.keywords ?? ''}`, words),
  );
  const count = (g: GroupId) => visible.filter((s) => s.group === g).length;

  const goTo = (g: GroupId) => {
    setActive(g);
    list.current?.querySelector(`[data-group="${g}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  // O grupo marcado à esquerda acompanha a rolagem.
  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    const sections = [...el.querySelectorAll<HTMLElement>('[data-group]')];
    let current = sections[0]?.dataset.group as GroupId | undefined;
    for (const s of sections) if (s.offsetTop <= el.scrollTop + 16) current = s.dataset.group as GroupId;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) current = sections.at(-1)?.dataset.group as GroupId | undefined;
    if (current && current !== active) setActive(current);
  };

  const menu = (
    <div
      ref={panel}
      className="settings-menu"
      role="dialog"
      aria-label={t('toolbar.settingsDialog')}
      style={{ '--settings-top': `${top}px` } as CSSProperties}
    >
      <div className="settings-search">
        <input
          type="search"
          value={query}
          placeholder={t('toolbar.searchSettings')}
          aria-label={t('toolbar.searchSettings')}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted small">
          {words.length
            ? t('toolbar.ofTotal', { n: visible.length, total: settings.length })
            : plural(settings.length, 'toolbar.settingsCountOne', 'toolbar.settingsCountOther')}
        </span>
      </div>
      <div className="settings-body">
        <nav className="settings-nav" aria-label={t('toolbar.groupsNav')}>
          {/* No simples, grupos sem nada essencial nem aparecem. */}
          {GROUPS.filter((g) => props.uiLevel !== 'simple' || words.length || count(g.id)).map((g) => (
            <button
              key={g.id}
              type="button"
              className={`settings-nav-item ${active === g.id && count(g.id) ? 'is-active' : ''}`}
              disabled={!count(g.id)}
              onClick={() => goTo(g.id)}
            >
              {g.label}
              {words.length > 0 && <span className="muted small">{count(g.id)}</span>}
            </button>
          ))}
        </nav>
        <div className="settings-list" ref={list} onScroll={onScroll}>
          {GROUPS.filter((g) => count(g.id)).map((g) => (
            <section key={g.id} data-group={g.id} className="settings-group">
              <h3 className="settings-group-title">{g.label}</h3>
              <p className="muted small settings-group-intro">{g.intro}</p>
              {visible
                .filter((s) => s.group === g.id)
                .map((s) => (
                  <SettingRow key={s.id} setting={s} />
                ))}
            </section>
          ))}
          {!visible.length && (
            <p className="muted settings-empty">
              {t('toolbar.noResults', { q: query.trim() })}{' '}
              <button type="button" className="link" onClick={() => setQuery('')}>
                {t('toolbar.clearSearch')}
              </button>
            </p>
          )}
          {hidden > 0 && (
            <p className="muted small settings-more">
              {plural(hidden, 'toolbar.moreOne', 'toolbar.moreOther')}{' '}
              <button type="button" className="link" onClick={() => void props.onUiLevel('advanced')}>
                {t('toolbar.showAll')}
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="settings" ref={root}>
      <button
        className="settings-button toolbar-icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('toolbar.settingsButton')}
        title={t('toolbar.settingsTitle')}
        onClick={() => setOpen(!open)}
      >
        <GearIcon />
        {props.archivedCount > 0 && props.showArchived && <span className="settings-dot" aria-hidden="true" />}
      </button>
      {/* No body: o painel do topo do React Flow prende o z-index, e o painel lateral cobriria o menu. */}
      {open && createPortal(menu, document.body)}
    </div>
  );
}

function SettingRow({ setting: s }: { setting: Setting }) {
  return (
    <div className="setting" id={`setting-${s.id}`}>
      <div className="setting-title">
        {s.title}
        {s.badge && <span className="badge">{s.badge}</span>}
      </div>
      {s.toggle ? (
        <label className="setting-check">
          <input type="checkbox" checked={s.toggle.checked} onChange={(e) => s.toggle!.onChange(e.target.checked)} />
          <span className="setting-desc">{s.description}</span>
        </label>
      ) : (
        <>
          <p className="setting-desc">{s.description}</p>
          <div className="setting-control">{s.control}</div>
        </>
      )}
    </div>
  );
}

/** A lista de configurações; itens que dependem do config.json só entram depois que ele chega. */
function buildSettings(p: Props, theme: 'light' | 'dark', close: () => void, words: string[], [chatDetail, setChatDetail]: [boolean, (v: boolean) => void]): Setting[] {
  const out: Setting[] = [
    ...(p.uiLevel
      ? [
          {
            id: 'ui-level',
            group: 'board' as const,
            title: t('toolbar.uiLevelTitle'),
            description: t('toolbar.uiLevelDesc'),
            keywords: t('toolbar.uiLevelKeywords'),
            control: <UiLevelPicker value={p.uiLevel} onChange={p.onUiLevel} />,
          },
        ]
      : []),
    {
      id: 'worktrees',
      group: 'board',
      title: t('toolbar.worktreesTitle'),
      description: t('toolbar.worktreesDesc'),
      keywords: t('toolbar.worktreesKeywords'),
      toggle: { checked: p.showWorktrees, onChange: p.onToggleWorktrees },
      advanced: true,
    },
    ...(p.workspaces && p.projectWorkspaces
      ? [
          {
            id: 'workspaces',
            group: 'board' as const,
            title: t('office.workspacesTitle'),
            description: t('office.workspacesDesc'),
            keywords: t('office.workspacesKeywords'),
            control: <WorkspacesEditor workspaces={p.workspaces} projectWorkspaces={p.projectWorkspaces} onConfig={p.onConfig} />,
          },
        ]
      : []),
    {
      id: 'demo',
      group: 'board',
      title: t('office.demoTitle'),
      description: t('office.demoDesc'),
      keywords: t('office.demoKeywords'),
      control: (() => {
        const demo = p.projects.find((x) => /[\\/]\.myco[\\/]demo[\\/]cafe-demo$/i.test(x.path));
        return demo ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              close();
              p.onOpenProject(demo.id);
            }}
          >
            {t('office.demoOpen')}
          </button>
        ) : (
          <DemoButton
            onOpen={(id) => {
              close();
              p.onOpenProject(id);
            }}
          />
        );
      })(),
    },
    {
      id: 'archived',
      group: 'board',
      title: `${t('toolbar.archivedTitle')}${p.archivedCount > 0 ? ` (${p.archivedCount})` : ''}`,
      description: t('toolbar.archivedDesc'),
      keywords: t('toolbar.archivedKeywords'),
      toggle: { checked: p.showArchived, onChange: p.onToggleArchived },
    },
    {
      id: 'animations',
      group: 'board',
      title: t('toolbar.animationsTitle'),
      description: t('toolbar.animationsDesc'),
      keywords: t('toolbar.animationsKeywords'),
      toggle: { checked: p.animations, onChange: p.onToggleAnimations },
    },
    {
      id: 'refresh',
      group: 'board',
      title: t('toolbar.refreshTitle'),
      description: t('toolbar.refreshDesc'),
      keywords: t('toolbar.refreshKeywords'),
      control: (
        <button type="button" className="btn-secondary" onClick={p.onRefresh} disabled={p.refreshing}>
          {p.refreshing ? t('toolbar.refreshing') : t('toolbar.refreshNow')}
        </button>
      ),
    },
    {
      id: 'server',
      group: 'board',
      title: t('toolbar.serverTitle'),
      description: t('toolbar.serverDesc'),
      keywords: t('toolbar.serverKeywords'),
      control: <ServerControls />,
    },
  ];

  // Idioma: a escolha vale para a página toda e recarrega.
  out.push({
    id: 'language',
    group: 'look',
    title: t('toolbar.languageTitle'),
    description: t('toolbar.languageDesc'),
    keywords: t('toolbar.languageKeywords'),
    control: (
      <select className="setting-select" value={locale()} aria-label={t('toolbar.languageTitle')} onChange={(e) => setLocale(e.target.value as Locale)}>
        {LOCALES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    ),
  });

  if (p.boardBackground) {
    const bg = p.boardBackground;
    out.push(
      {
        id: 'background-light',
        group: 'look',
        title: t('toolbar.bgLightTitle'),
        badge: theme === 'light' ? t('toolbar.inUseNow') : undefined,
        description: t('toolbar.bgLightDesc'),
        keywords: t('toolbar.bgLightKeywords'),
        control: <BackgroundPicker theme="light" value={bg.light} onChange={(light) => p.onBoardBackground({ light })} />,
        advanced: true,
      },
      {
        id: 'background-dark',
        group: 'look',
        title: t('toolbar.bgDarkTitle'),
        badge: theme === 'dark' ? t('toolbar.inUseNow') : undefined,
        description: t('toolbar.bgDarkDesc'),
        keywords: t('toolbar.bgDarkKeywords'),
        control: <BackgroundPicker theme="dark" value={bg.dark} onChange={(dark) => p.onBoardBackground({ dark })} />,
        advanced: true,
      },
    );
  }

  if (p.projectColors) {
    const colors = p.projectColors;
    const text = t('toolbar.roomColorsSearch');
    // Buscando pelo nome de um projeto, a lista mostra só as salas que batem.
    const rooms = words.length && !matches(text, words) ? p.rooms.filter((r) => matches(r.name, words)) : p.rooms;
    out.push({
      id: 'room-colors',
      group: 'look',
      title: t('toolbar.roomColorsTitle'),
      description: t('toolbar.roomColorsDesc'),
      keywords: `${t('toolbar.roomColorsKeywords')} ${p.rooms.map((r) => r.name).join(' ')}`,
      control: rooms.length ? (
        <ul className="room-colors">
          {rooms.map((r) => (
            <li key={r.id}>
              <span className="room-colors-name" title={r.name}>
                {r.name}
              </span>
              <RoomColorPicker small value={colors[r.id] ?? null} label={t('toolbar.roomColorOf', { name: r.name })} onChange={(c) => p.onProjectColor(r.id, c)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{t('toolbar.noRooms')}</p>
      ),
      advanced: true,
    });
  }

  out.push({
    id: 'chat-detail',
    group: 'chat',
    title: t('toolbar.chatDetailTitle'),
    description: t('toolbar.chatDetailDesc'),
    keywords: t('toolbar.chatDetailKeywords'),
    toggle: { checked: chatDetail, onChange: setChatDetail },
  });

  if (p.sendWhileBusy) {
    out.push({
      id: 'send-while-busy',
      group: 'chat',
      title: t('toolbar.sendBusyTitle'),
      description: t('toolbar.sendBusyDesc', { how: SEND_HELP[p.sendWhileBusy] }),
      keywords: t('toolbar.sendBusyKeywords'),
      control: <SendWhileBusyEditor value={p.sendWhileBusy} onSave={p.onSendWhileBusy} />,
      advanced: true,
    });
  }

  out.push({
    id: 'roles',
    group: 'roles',
    title: t('toolbar.rolesTitle'),
    description: t('toolbar.rolesDesc'),
    keywords: t('toolbar.rolesKeywords'),
    control: <RolesEditor />,
    advanced: true,
  });

  if (p.usageStop) {
    const stop = p.usageStop;
    out.push(
      {
        id: 'usage-stop-5h',
        group: 'usage',
        title: t('toolbar.stop5hTitle'),
        description: t('toolbar.stop5hDesc'),
        keywords: t('toolbar.stop5hKeywords'),
        control: <UsageStopInput field="fiveHour" value={stop} onSave={p.onUsageStop} />,
      },
      {
        id: 'usage-stop-7d',
        group: 'usage',
        title: t('toolbar.stop7dTitle'),
        description: t('toolbar.stop7dDesc'),
        keywords: t('toolbar.stop7dKeywords'),
        control: <UsageStopInput field="sevenDay" value={stop} onSave={p.onUsageStop} />,
      },
    );
  }

  if (p.projectBudgets) {
    const budgets = p.projectBudgets;
    const text = t('toolbar.budgetsSearch');
    const rooms = words.length && !matches(text, words) ? p.rooms.filter((r) => matches(r.name, words)) : p.rooms;
    out.push({
      id: 'project-budgets',
      group: 'usage',
      title: t('toolbar.budgetsTitle'),
      description: t('toolbar.budgetsDesc'),
      keywords: `${t('toolbar.budgetsKeywords')} ${p.rooms.map((r) => r.name).join(' ')}`,
      control: rooms.length ? (
        <ul className="room-colors">
          {rooms.map((r) => (
            <li key={r.id}>
              <span className="room-colors-name" title={r.name}>
                {r.name}
              </span>
              <BudgetInput value={budgets[r.id] ?? null} label={t('toolbar.budgetOf', { name: r.name })} onSave={(b) => p.onProjectBudget(r.id, b)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{t('toolbar.noRooms')}</p>
      ),
      advanced: true,
    });
  }
  return out;
}

function UiLevelPicker({ value, onChange }: { value: UiLevel; onChange: (level: UiLevel) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const pick = async (level: UiLevel) => {
    if (level === value) return;
    setBusy(true);
    try {
      await onChange(level);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="segmented" aria-label={t('toolbar.uiLevelTitle')}>
      {(
        [
          ['simple', t('toolbar.levelSimple')],
          ['advanced', t('toolbar.levelAdvanced')],
        ] as const
      ).map(([level, label]) => (
        <button key={level} type="button" className="btn-toggle" aria-pressed={value === level} disabled={busy} onClick={() => void pick(level)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** % da cota de 7 dias de um projeto; grava ao sair do campo. */
function BudgetInput({ value, label, onSave }: { value: number | null; label: string; onSave: (b: number | null) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="setting-number">
      <input
        key={String(value)}
        type="number"
        min={1}
        max={100}
        defaultValue={value ?? ''}
        placeholder="—"
        aria-label={label}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        onBlur={async (e) => {
          const raw = e.target.value.trim();
          const n = raw === '' ? null : Math.min(100, Math.max(1, Math.round(Number(raw))));
          if (n !== null && !Number.isFinite(n)) return;
          if (n === value) return;
          setError(null);
          await onSave(n).catch((err: Error) => setError(err.message));
        }}
      />
      %{error && <span className="error small">{error}</span>}
    </span>
  );
}

/** Parar (e, com o vigia, reiniciar) o servidor do MyCo. Depois, a tela mostra como voltar. */
function ServerControls() {
  const [info, setInfo] = useState<{ daemon: boolean; startedAt: string } | null>(null);
  const [state, setState] = useState<'idle' | 'stopping' | 'stopped' | 'restarting'>('idle');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.serverInfo().then(setInfo, () => {});
  }, []);

  const act = async (action: 'stop' | 'restart') => {
    // Na hora do clique, não de quando o menu abriu: quem está trabalhando agora perde o que faz.
    const working = await api.serverInfo().then((i) => i.working, () => null);
    const cut = [
      working?.busy ? t('toolbar.cutBusy', { n: working.busy }) : '',
      working?.background ? t('toolbar.cutBackground', { n: working.background }) : '',
    ].filter(Boolean);
    const warn = cut.length ? `\n\n${t('toolbar.warnCut', { cut: cut.join(` ${t('toolbar.and')} `) })}` : '';
    const ask = (action === 'stop' ? t('toolbar.askStop') : t('toolbar.askRestart')) + warn;
    if (!window.confirm(ask)) return;
    setError(null);
    setState(action === 'stop' ? 'stopping' : 'restarting');
    try {
      await api.serverAction(action);
    } catch (e) {
      setError((e as Error).message);
      setState('idle');
      return;
    }
    if (action === 'stop') {
      // Espera o servidor sumir de verdade antes de dizer que parou.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (!(await fetch('/api/health').then((r) => r.ok, () => false))) break;
      }
      setState('stopped');
      return;
    }
    // Reiniciando: espera ele sair e voltar, e recarrega a página.
    await new Promise((r) => setTimeout(r, 2500));
    for (let i = 0; i < 60; i++) {
      if (await fetch('/api/health').then((r) => r.ok, () => false)) return window.location.reload();
      await new Promise((r) => setTimeout(r, 1500));
    }
    setError(t('toolbar.serverNotBack'));
    setState('idle');
  };

  return (
    <>
      <span className="setting-buttons">
        {info?.daemon && (
          <button type="button" className="btn-secondary" disabled={state !== 'idle'} onClick={() => void act('restart')}>
            {t('toolbar.restartBtn')}
          </button>
        )}
        <button type="button" className="btn-secondary setting-danger" disabled={state !== 'idle'} onClick={() => void act('stop')}>
          {t('toolbar.stopBtn')}
        </button>
      </span>
      {info && (
        <span className="muted small">
          {info.daemon ? t('toolbar.daemonOn') : t('toolbar.daemonOff')} · {t('toolbar.since')}{' '}
          {new Date(info.startedAt).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
      {error && <span className="error small">{error}</span>}
      {state !== 'idle' &&
        createPortal(
          <div className="server-overlay" role="alertdialog" aria-live="assertive">
            <div className="server-overlay-card">
              {state === 'restarting' && <h2>{t('toolbar.restartingTitle')}</h2>}
              {state === 'stopping' && <h2>{t('toolbar.stoppingTitle')}</h2>}
              {state === 'stopped' && (
                <>
                  <h2>{t('toolbar.stoppedTitle')}</h2>
                  <p>{t('toolbar.stoppedBody')}</p>
                  <p>
                    {t('toolbar.startAgainA')} <b>MyCo</b> {t('toolbar.startAgainB')}{' '}
                    <code>npm run daily:start</code> {t('toolbar.startAgainC')}
                  </p>
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

const SEND_HELP: Record<SendPriority, string> = {
  next: t('toolbar.sendNextHelp'),
  later: t('toolbar.sendLaterHelp'),
  now: t('toolbar.sendNowHelp'),
};

/** Mensagem mandada com o funcionário trabalhando: vale para todas as conversas. */
function SendWhileBusyEditor({ value, onSave }: { value: SendPriority; onSave: (p: SendPriority) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <select
        className="setting-select"
        value={value}
        aria-label={t('toolbar.sendBusyTitle')}
        onChange={(e) => {
          setError(null);
          onSave(e.target.value as SendPriority).catch((err: Error) => setError(err.message));
        }}
      >
        <option value="next">{t('toolbar.sendNextLabel')}</option>
        <option value="later">{t('toolbar.sendLaterLabel')}</option>
        <option value="now">{t('toolbar.sendNowLabel')}</option>
      </select>
      {error && <span className="error small">{error}</span>}
    </>
  );
}

/** Linha de parada da empresa: acima dela, o MyCo pergunta antes de mandar trabalho novo. */
function UsageStopInput({ field, value, onSave }: { field: keyof UsageStop; value: UsageStop; onSave: (stop: UsageStop) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FocusEvent<HTMLInputElement>) => {
    const raw = e.target.value.trim();
    const n = raw === '' ? null : Math.min(100, Math.max(1, Math.round(Number(raw))));
    if (n !== null && !Number.isFinite(n)) return;
    if (n === value[field]) return;
    setError(null);
    await onSave({ ...value, [field]: n }).catch((err: Error) => setError(err.message));
  };
  return (
    <span className="setting-number">
      <input
        key={String(value[field])}
        type="number"
        min={1}
        max={100}
        defaultValue={value[field] ?? ''}
        placeholder="—"
        aria-label={field === 'fiveHour' ? t('toolbar.stopAria5h') : t('toolbar.stopAria7d')}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      %{error && <span className="error small">{error}</span>}
    </span>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
