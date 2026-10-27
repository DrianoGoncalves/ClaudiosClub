import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { BoardBackground, ProjectColor, SendPriority, UsageStop } from '../../../shared/model';
import { api } from '../api';
import { BackgroundPicker, RoomColorPicker, useSystemTheme } from '../board/colors';
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
  onResetLayout: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  usageStop: UsageStop | null;
  onUsageStop: (stop: UsageStop) => Promise<void>;
  sendWhileBusy: SendPriority | null;
  onSendWhileBusy: (p: SendPriority) => Promise<void>;
  /** Salas de projeto no quadro agora (as que podem ganhar cor). */
  rooms: Array<{ id: string; name: string }>;
  projectColors: Record<string, ProjectColor> | null;
  onProjectColor: (projectId: string, color: ProjectColor | null) => Promise<void>;
  boardBackground: BoardBackground | null;
  onBoardBackground: (bg: Partial<BoardBackground>) => Promise<void>;
  /** Orçamento por projeto: % da cota de 7 dias. */
  projectBudgets: Record<string, number> | null;
  onProjectBudget: (projectId: string, budget: number | null) => Promise<void>;
}

type GroupId = 'board' | 'look' | 'chat' | 'roles' | 'usage';

const GROUPS: Array<{ id: GroupId; label: string; intro: string }> = [
  { id: 'board', label: 'Quadro', intro: 'O que aparece no escritório e como ele se arruma.' },
  { id: 'look', label: 'Aparência', intro: 'Cores do fundo e das salas. Cada cor tem um tom para o tema claro e outro para o escuro.' },
  { id: 'chat', label: 'Conversa', intro: 'Como as mensagens chegam aos funcionários.' },
  { id: 'roles', label: 'Cargos', intro: 'Modelos de ficha para contratar: os prontos e os seus, cada um com o modelo em que o funcionário começa.' },
  { id: 'usage', label: 'Consumo', intro: 'Até onde a conta pode gastar antes de o MyCo perguntar.' },
];

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

  // Fecha ao clicar fora; Esc limpa a busca e, sem busca, fecha.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (queryRef.current) setQuery('');
      else setOpen(false);
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
  const settings = buildSettings(props, theme, () => setOpen(false), words);
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
      aria-label="Configurações do MyCo"
      style={{ '--settings-top': `${top}px` } as CSSProperties}
    >
      <div className="settings-search">
        <input
          type="search"
          value={query}
          placeholder="Buscar configurações"
          aria-label="Buscar configurações"
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted small">{words.length ? `${visible.length} de ${settings.length}` : `${settings.length} configurações`}</span>
      </div>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Grupos">
          {GROUPS.map((g) => (
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
              Nenhuma configuração com “{query.trim()}”.{' '}
              <button type="button" className="link" onClick={() => setQuery('')}>
                Limpar a busca
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
        className="settings-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Configurações do MyCo (Ctrl+,)"
        onClick={() => setOpen(!open)}
      >
        <GearIcon /> <span className="settings-label">config</span>
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
function buildSettings(p: Props, theme: 'light' | 'dark', close: () => void, words: string[]): Setting[] {
  const out: Setting[] = [
    {
      id: 'worktrees',
      group: 'board',
      title: 'Mostrar worktrees',
      description: 'Cópias de trabalho (.claude/worktrees) aparecem dentro da sala de cada projeto.',
      keywords: 'copias git branch',
      toggle: { checked: p.showWorktrees, onChange: p.onToggleWorktrees },
    },
    {
      id: 'archived',
      group: 'board',
      title: `Mostrar arquivados${p.archivedCount > 0 ? ` (${p.archivedCount})` : ''}`,
      description: 'Projetos e funcionários arquivados aparecem esmaecidos. Nada é apagado do Claude Code.',
      keywords: 'esconder ocultos',
      toggle: { checked: p.showArchived, onChange: p.onToggleArchived },
    },
    {
      id: 'animations',
      group: 'board',
      title: 'Animações',
      description: 'Funcionário trabalhando e conversas animadas nas linhas. O padrão segue o “reduzir animações” do sistema.',
      keywords: 'movimento reduzir',
      toggle: { checked: p.animations, onChange: p.onToggleAnimations },
    },
    {
      id: 'reset-layout',
      group: 'board',
      title: 'Reorganizar o quadro',
      description: 'Desfaz os arrastos e enquadra o escritório de novo.',
      keywords: 'layout posicoes arrastos enquadrar',
      control: (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            p.onResetLayout();
            close();
          }}
        >
          Reorganizar
        </button>
      ),
    },
    {
      id: 'refresh',
      group: 'board',
      title: 'Atualizar',
      description: 'Relê do disco os projetos, funcionários e fichas.',
      keywords: 'recarregar reler',
      control: (
        <button type="button" className="btn-secondary" onClick={p.onRefresh} disabled={p.refreshing}>
          {p.refreshing ? 'Atualizando…' : 'Atualizar agora'}
        </button>
      ),
    },
    {
      id: 'server',
      group: 'board',
      title: 'Servidor do MyCo',
      description:
        'Parar fecha as conversas abertas e desliga o MyCo (as rotinas param junto). Reiniciar só aparece com o MyCo em segundo plano (npm run daily:start ou o início automático).',
      keywords: 'parar desligar encerrar reiniciar stop restart servidor',
      control: <ServerControls />,
    },
  ];

  if (p.boardBackground) {
    const bg = p.boardBackground;
    out.push(
      {
        id: 'background-light',
        group: 'look',
        title: 'Fundo no tema claro',
        badge: theme === 'light' ? 'em uso agora' : undefined,
        description: 'Cor do quadro com o sistema no tema claro. Os cartões e os pontinhos acompanham o tom.',
        keywords: 'cor fundo quadro branco background tema claro',
        control: <BackgroundPicker theme="light" value={bg.light} onChange={(light) => p.onBoardBackground({ light })} />,
      },
      {
        id: 'background-dark',
        group: 'look',
        title: 'Fundo no tema escuro',
        badge: theme === 'dark' ? 'em uso agora' : undefined,
        description: 'Cor do quadro com o sistema no tema escuro (a lousa). Os cartões e os pontinhos acompanham o tom.',
        keywords: 'cor fundo quadro negro lousa background tema escuro',
        control: <BackgroundPicker theme="dark" value={bg.dark} onChange={(dark) => p.onBoardBackground({ dark })} />,
      },
    );
  }

  if (p.projectColors) {
    const colors = p.projectColors;
    const text = 'Cor das salas A caneta da parede de cada sala parede borda projeto';
    // Buscando pelo nome de um projeto, a lista mostra só as salas que batem.
    const rooms = words.length && !matches(text, words) ? p.rooms.filter((r) => matches(r.name, words)) : p.rooms;
    out.push({
      id: 'room-colors',
      group: 'look',
      title: 'Cor das salas',
      description: 'A caneta da parede de cada sala no quadro. Também dá para trocar no painel do projeto.',
      keywords: `parede borda projeto ${p.rooms.map((r) => r.name).join(' ')}`,
      control: rooms.length ? (
        <ul className="room-colors">
          {rooms.map((r) => (
            <li key={r.id}>
              <span className="room-colors-name" title={r.name}>
                {r.name}
              </span>
              <RoomColorPicker small value={colors[r.id] ?? null} label={`Cor da sala ${r.name}`} onChange={(c) => p.onProjectColor(r.id, c)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Nenhuma sala de projeto no quadro agora.</p>
      ),
    });
  }

  if (p.sendWhileBusy) {
    out.push({
      id: 'send-while-busy',
      group: 'chat',
      title: 'Mensagem durante o trabalho',
      description: `O que acontece com a mensagem mandada com o funcionário trabalhando: ${SEND_HELP[p.sendWhileBusy]}. Vale para todos os funcionários.`,
      keywords: 'fila interromper prioridade enviar mandar ocupado',
      control: <SendWhileBusyEditor value={p.sendWhileBusy} onSave={p.onSendWhileBusy} />,
    });
  }

  out.push({
    id: 'roles',
    group: 'roles',
    title: 'Cargos para contratar',
    description:
      'Cada cargo preenche a ficha de quem é contratado com ele, inclusive o modelo e o esforço. Para mudar só um funcionário, edite a ficha dele. O cargo marcado como padrão já vem preenchido ao contratar.',
    keywords: 'cargo template modelo funcionario contratar padrao papel orquestrador desenvolvedor revisor infra opus sonnet haiku',
    control: <RolesEditor />,
  });

  if (p.usageStop) {
    const stop = p.usageStop;
    out.push(
      {
        id: 'usage-stop-5h',
        group: 'usage',
        title: 'Trava de consumo: 5 horas',
        description: 'Passando deste percentual do limite de 5h, o MyCo pergunta antes de conversar ou abrir sessão. Vazio = sem trava. Cada ficha pode ter a sua.',
        keywords: 'limite parada 5h gasto',
        control: <UsageStopInput field="fiveHour" value={stop} onSave={p.onUsageStop} />,
      },
      {
        id: 'usage-stop-7d',
        group: 'usage',
        title: 'Trava de consumo: 7 dias',
        description: 'O mesmo, para o limite semanal (7d).',
        keywords: 'limite parada 7d semana gasto',
        control: <UsageStopInput field="sevenDay" value={stop} onSave={p.onUsageStop} />,
      },
    );
  }

  if (p.projectBudgets) {
    const budgets = p.projectBudgets;
    const text = 'Orçamento por projeto cota semanal 7 dias limite projeto';
    const rooms = words.length && !matches(text, words) ? p.rooms.filter((r) => matches(r.name, words)) : p.rooms;
    out.push({
      id: 'project-budgets',
      group: 'usage',
      title: 'Orçamento por projeto',
      description:
        'Quanto da cota de 7 dias cada projeto pode usar, estimado pela parte dele no custo da semana. Passando, o MyCo pergunta antes de conversar ou abrir sessão naquele projeto. Vazio = sem orçamento.',
      keywords: `cota semana limite gasto ${p.rooms.map((r) => r.name).join(' ')}`,
      control: rooms.length ? (
        <ul className="room-colors">
          {rooms.map((r) => (
            <li key={r.id}>
              <span className="room-colors-name" title={r.name}>
                {r.name}
              </span>
              <BudgetInput value={budgets[r.id] ?? null} label={`Orçamento de ${r.name}`} onSave={(b) => p.onProjectBudget(r.id, b)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Nenhuma sala de projeto no quadro agora.</p>
      ),
    });
  }
  return out;
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
    const ask =
      action === 'stop'
        ? 'Parar o MyCo? As conversas abertas fecham e as rotinas param até ele voltar.'
        : 'Reiniciar o MyCo? As conversas abertas fecham e ele volta em alguns segundos.';
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
    setError('o MyCo não voltou em 1 min e meio: veja o log com npm run daily:status');
    setState('idle');
  };

  return (
    <>
      <span className="setting-buttons">
        {info?.daemon && (
          <button type="button" className="btn-secondary" disabled={state !== 'idle'} onClick={() => void act('restart')}>
            Reiniciar
          </button>
        )}
        <button type="button" className="btn-secondary setting-danger" disabled={state !== 'idle'} onClick={() => void act('stop')}>
          Parar o MyCo
        </button>
      </span>
      {info && (
        <span className="muted small">
          {info.daemon ? 'Em segundo plano, com vigia' : 'Rodando em primeiro plano (sem vigia)'} · desde{' '}
          {new Date(info.startedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
      {error && <span className="error small">{error}</span>}
      {state !== 'idle' &&
        createPortal(
          <div className="server-overlay" role="alertdialog" aria-live="assertive">
            <div className="server-overlay-card">
              {state === 'restarting' && <h2>Reiniciando o MyCo…</h2>}
              {state === 'stopping' && <h2>Parando o MyCo…</h2>}
              {state === 'stopped' && (
                <>
                  <h2>O MyCo está parado</h2>
                  <p>As conversas foram fechadas (continuam salvas) e as rotinas não rodam até ele voltar.</p>
                  <p>
                    Para ligar de novo: abra o atalho <b>MyCo</b> do Menu Iniciar (página de início, com o botão "Iniciar"), ou rode{' '}
                    <code>npm run daily:start</code> na pasta do MyCo.
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
  next: 'entra no trabalho em andamento, entre uma ferramenta e outra, sem parar',
  later: 'espera o funcionário terminar e vira a próxima mensagem',
  now: 'interrompe o que ele está fazendo e responde já',
};

/** Mensagem mandada com o funcionário trabalhando: vale para todas as conversas. */
function SendWhileBusyEditor({ value, onSave }: { value: SendPriority; onSave: (p: SendPriority) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <select
        className="setting-select"
        value={value}
        aria-label="Mensagem durante o trabalho"
        onChange={(e) => {
          setError(null);
          onSave(e.target.value as SendPriority).catch((err: Error) => setError(err.message));
        }}
      >
        <option value="next">entra no meio</option>
        <option value="later">vai para a fila</option>
        <option value="now">interrompe</option>
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
        aria-label={field === 'fiveHour' ? 'Trava de 5 horas, em %' : 'Trava de 7 dias, em %'}
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
