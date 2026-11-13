import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  CHROME_EXTENSION_URL,
  type Autonomy,
  type Board,
  type CodexEffort,
  type Effort,
  type Engine,
  type GitState,
  type LaunchResult,
  type McpServerInfo,
  type Playbook,
  type ServerInfo,
  type Session,
  type StaffInput,
  type StaffProfile,
} from '../../../shared/model';
import { api, withUsageConfirm, type DirectoryPerson } from '../api';
import { portraitUrl } from '../board/nodes';
import { effortLabel, employeeName, folderName } from '../format';
import { t, type MsgKey } from '../i18n';
import { MAX_INPUT_BYTES, PORTRAIT_MAX, shrinkImage } from '../lib/shrinkImage';
import { ProtocolBadge } from '../office/ProjectOffice';
import { BrowserCheck } from './BrowserCheck';
import { CopyFromCompany } from './CopyFromCompany';
import { differingFields, PERSON_FIELD_LABEL } from './directory';
import { FallbackField } from './FallbackField';
import { draftOf, fallbackProblem, fallbackToSend, showFallbackField, type FallbackDraft } from './fallbackEngine';
import {
  accessOf,
  accessToSend,
  browserAccess,
  browserAccessHints,
  hasAccessKey,
  mcpAccessHints,
  withAccess,
  withBrowserAccess,
  type McpAccessMap,
} from './mcpAccessField';
import { McpAccessHint, McpAccessSelect } from './McpAccessSelect';
import { PersonMemory } from './PersonMemory';
import { PERSONALITY_TEXT, personalityToSend } from './personalityField';
import { goneSkills, skillIsGone, type LibraryState } from './skillGone';
import { PERSONALITIES, type Personality } from '../../../shared/personality';
import type { RoleEntry } from '../../../shared/roles';
import {
  type CodexCatalog,
  canWriteSsh,
  codexAutonomyHelp,
  codexBlockedByServers,
  defaultEffortOf,
  effortsOfModel,
  engineToSend,
  isClaudeModel,
  PLAYWRIGHT_BRIDGE_URL,
  pickCodexModel,
  showEngineField,
  switchEngine,
  useCodexCatalog,
} from './codexEngine';
import { AUTONOMY_OPTIONS, EFFORT_OPTIONS, MODEL_OPTIONS, PLAYBOOK_OPTIONS } from './templates';

/** "opus" → "Opus (mais recente)"; '' → "Padrão do Claude Code"; outro id fica como está. */
export const modelLabel = (m: string) => MODEL_OPTIONS.find((o) => o.value === m)?.label ?? m;

// Questionário do funcionário: contratar (vira a ficha em <projeto>/.myco/staff/) ou editar
// (a versão anterior vai para o histórico, de onde dá para restaurar).

export type StaffFormMode =
  /** `copy`: já escolhida no organograma ("+" solto sobre ela): abre direto na confirmação de cópia. */
  | { kind: 'hire'; reportsTo: string[]; copy?: DirectoryPerson }
  | { kind: 'edit'; profile: StaffProfile }
  /** Funcionário criado fora do Claudio’s Club: ganha ficha (nome, retrato, regras) sem perder a sessão. */
  | { kind: 'adopt'; session: Session };

interface Props {
  board: Board;
  projectId: string;
  mode: StaffFormMode;
  /** Nível simples: só cargo, nome e retrato; o resto vem do cargo. */
  simple?: boolean;
  /** Dentro do "Mais" do funcionário (abas Ficha e Projeto): sem modal, sem abas próprias e "Desfazer" no lugar de "Cancelar". */
  embedded?: boolean;
  /** A aba que quem usa mostra (o "Mais" tem as abas); `null` = outra aba dele está aberta: o formulário fica escondido, com o que foi digitado. */
  tab?: Tab | null;
  /** Pede ao dono das abas para abrir uma (ex.: a que tem o campo obrigatório vazio). */
  onTab?: (tab: Tab) => void;
  /** Mexeu na ficha e ainda não salvou (alse ao salvar ou desfazer): quem troca de projeto por cima pergunta antes. */
  onDirty?: (dirty: boolean) => void;
  /** Codex (GPT) ligado nas configurações: sem isso o campo "Motor" não aparece (a não ser que a ficha já rode no Codex). */
  codexReview?: boolean | null;
  /** "Permitir que o GPT use meu Chrome" nas configurações: desligado, a caixa do Chrome da ficha Codex não vale (a ficha avisa). */
  codexBrowser?: boolean | null;
  onClose: () => void;
  onHired: (profile: StaffProfile, launch: LaunchResult | null) => void;
  onSaved: (profile: StaffProfile) => void;
}

/** Quem edita código (a autonomia deixa): no simples, ganha worktree se já há outro assim no projeto. */
const editsCode = (a: Autonomy) => a === 'acceptEdits' || a === 'auto' || a === 'bypassPermissions';

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

/** A ficha é longa: dividida em abas. A ficha (quem é) e o projeto (o que usa e como trabalha nele). */
type Tab = 'sheet' | 'project';
export type StaffFormTab = Tab;
const TABS: Array<{ id: Tab; label: string; intro: string }> = [
  { id: 'sheet', label: t('detail.tabSheet'), intro: t('staff.tabSheetIntro') },
  { id: 'project', label: t('detail.tabProject'), intro: t('staff.tabProjectIntro') },
];

/** De onde vem o MCP, na lista da ficha. */
const MCP_SOURCE_LABEL = { club: 'staff.sourceClub', user: 'staff.sourceUser', local: 'staff.sourceLocal', project: 'staff.sourceProject' } as const satisfies Record<McpServerInfo['source'], MsgKey>;

export function StaffForm({ board, projectId, mode, simple = false, embedded = false, tab: tabProp, onTab, onDirty, codexReview = false, codexBrowser = false, onClose, onHired, onSaved }: Props) {
  const editing = mode.kind === 'edit' ? mode.profile : null;
  const adopting = mode.kind === 'adopt' ? mode.session : null;
  // No simples, a ficha inteira fica a um clique ("Mostrar todos os campos").
  const [full, setFull] = useState(!simple || !!adopting);
  const [git, setGit] = useState<Record<string, GitState> | null>(null);
  useEffect(() => {
    if (!full && !editing) api.git().then(setGit, () => setGit({}));
  }, [full, editing]);
  const project = board.projects.find((p) => p.id === projectId);
  const inventory = board.inventories[projectId] ?? { agents: [], skills: [] };
  const agentNames = useMemo(
    () => [...new Set([...inventory.agents, ...board.user.agents].map((a) => a.name))].sort(),
    [inventory, board.user],
  );
  // As da biblioteca do Claudio’s Club só carregam para quem tem na ficha (as do projeto e da conta, todos veem).
  const [library, setLibrary] = useState<string[]>([]);
  // Só com a biblioteca lida dá para dizer que uma skill marcada sumiu (a da biblioteca chega depois das do projeto e da conta).
  const [libraryState, setLibraryState] = useState<LibraryState>('loading');
  useEffect(() => {
    api.skillLibrary().then(
      (l) => {
        setLibrary(l.map((s) => s.name));
        setLibraryState('ok');
      },
      () => setLibraryState('failed'),
    );
  }, []);
  const skillNames = useMemo(
    () => [...new Set([...inventory.skills, ...board.user.skills.filter((s) => s.scope !== 'synced')].map((s) => s.name).concat(library))].sort(),
    [inventory, board.user, library],
  );
  // Skill que a ficha já tinha marcada e a lista não oferece mais (apagada ou renomeada; a sincronizada nunca é oferecida): continua à
  // vista para dar para desmarcar. Vem da ficha ao abrir, e não do que está marcado agora: desmarcar não faz a linha sumir.
  const gone = useMemo(() => goneSkills(editing?.skills ?? [], skillNames, libraryState), [editing, skillNames, libraryState]);
  const syncedSkills = useMemo(() => new Set(board.user.skills.filter((s) => s.scope === 'synced').map((s) => s.name)), [board.user]);
  const skillGone = (s: string) => skillIsGone(s, libraryState, syncedSkills);
  const colleagues = board.staff.filter((s) => s.projectId === projectId && s.id !== editing?.id);

  const [name, setName] = useState(editing?.name ?? (adopting ? employeeName(adopting).slice(0, 60) : ''));
  const [role, setRole] = useState(editing?.role ?? '');
  const [mission, setMission] = useState(
    editing?.mission ?? (adopting ? `Dar continuidade ao trabalho desta sessão${adopting.title ? `: ${adopting.title}` : ''}.` : ''),
  );
  const [managers, setManagers] = useState<string[]>(editing?.reportsTo ?? (mode.kind === 'hire' ? mode.reportsTo : []));
  const [autonomy, setAutonomy] = useState<Autonomy>(editing?.autonomy ?? 'manual');
  const [agents, setAgents] = useState<string[]>(editing?.agents ?? []);
  const [skills, setSkills] = useState<string[]>(editing?.skills ?? []);
  const [mcps, setMcps] = useState<McpServerInfo[] | null>(null);
  const [mcpOn, setMcpOn] = useState<Set<string>>(new Set());
  // Acesso por MCP (Livre / Pede antes de escrever / Só leitura / Desligado), nos dois motores. Guarda também as chaves que a tela não
  // mostra (MCP desmarcado, `myco-ssh`): o servidor troca o mapa todo, então elas voltam ao salvar.
  const [mcpAccess, setMcpAccess] = useState<McpAccessMap>(editing?.mcpAccess ?? {});
  const [knowledge, setKnowledge] = useState((editing?.knowledge ?? []).join('\n'));
  const [rules, setRules] = useState((editing?.rules ?? []).join('\n'));
  const [doneWhen, setDoneWhen] = useState(editing?.doneWhen ?? '');
  const [engine, setEngine] = useState<Engine>(editing?.engine ?? 'claude');
  // Ficha do Codex com um alias do Claude no modelo (sobra de antes da troca de motor): não vale para o Codex, começa sem modelo.
  const [model, setModel] = useState(editing?.engine === 'codex' && isClaudeModel(editing.model) ? '' : (editing?.model ?? ''));
  const [effort, setEffort] = useState<'' | CodexEffort>(editing?.effort ?? '');
  // Motor secundário (quando o principal bate o limite); o motor dele é sempre o outro, então não entra no estado.
  const [fallback, setFallback] = useState<FallbackDraft>(draftOf(editing?.fallback));
  const [canHire, setCanHire] = useState(editing?.canHire ?? false);
  const [playbook, setPlaybook] = useState<'' | Playbook>(editing?.playbook ?? '');
  const [personality, setPersonality] = useState<'' | Personality>(editing?.personality ?? '');
  const [worktree, setWorktree] = useState(editing?.worktree ?? false);
  const [servers, setServers] = useState<string[]>(editing?.servers ?? []);
  // Conexões SSH de `servers` com escrita liberada (o Codex roda comandos livres só nelas); desmarcar o servidor tira daqui também.
  const [sshWrite, setSshWrite] = useState<string[]>(editing?.sshWrite ?? []);
  const [browser, setBrowser] = useState(editing?.browser ?? true);
  const [serverList, setServerList] = useState<ServerInfo[] | null>(null);
  // O campo só aparece para quem é de infra (cargo pronto) ou já tem servidores.
  const [showServers, setShowServers] = useState((editing?.servers.length ?? 0) > 0);
  // undefined = manter o retrato atual; null = remover; string = trocar.
  const [portrait, setPortrait] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Contratando: do zero (a ficha abaixo) ou cópia de alguém de outro projeto.
  const preset = mode.kind === 'hire' ? mode.copy : undefined;
  const [source, setSource] = useState<'new' | 'company'>(preset ? 'company' : 'new');
  const canCopy = mode.kind === 'hire' && !embedded;
  // Editando quem tem cópias em outros projetos (mesmo personId): o que é da pessoa vai a elas ao salvar, sempre.
  const copyProfiles = useMemo(
    () => (editing?.personId ? board.staff.filter((s) => s.personId === editing.personId && !(s.projectId === projectId && s.id === editing.id)) : []),
    [board.staff, editing, projectId],
  );
  const projectNameOf = (id: string) => board.projects.find((p) => p.id === id)?.name ?? id;
  // Os campos da pessoa em que as outras fichas diferem do que está no formulário: o salvar vai trocá-los.
  const overwrites = copyProfiles.length
    ? differingFields(
        { name, role, mission, doneWhen, rules: lines(rules), model: model || null, effort: effort || null, playbook: playbook || null, personality: personality || null },
        copyProfiles,
      ).map((d) => `${t(PERSON_FIELD_LABEL[d.field])} (${[...new Set(d.others.map((o) => projectNameOf(o.projectId)))].join(', ')})`)
    : [];
  if (copyProfiles.length && portrait !== undefined) overwrites.push(`${t('hr.fieldPortrait')} (${copyProfiles.map((c) => projectNameOf(c.projectId)).join(', ')})`);
  // Ficha mexida e ainda não salva: avisa quem hospeda o formulário (a conta fica fora dos campos da memória pessoal).
  const dirty = useRef(false);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const markDirty = (e: FormEvent) => {
    if (dirty.current || (e.target as HTMLElement).closest('[data-skip-dirty]')) return;
    dirty.current = true;
    onDirtyRef.current?.(true);
  };
  useEffect(
    () => () => {
      if (dirty.current) onDirtyRef.current?.(false);
    },
    [],
  );
  const codex = engine === 'codex';
  // Conexão FTP marcada na ficha: o Codex não roda (SSH roda).
  const ftpBlocked = codexBlockedByServers(servers, serverList);
  // Quem adota uma sessão do Claude não escolhe motor; nos outros, só com o Codex ligado ou quando a ficha já é do Codex.
  const showEngine = !adopting && showEngineField(codexReview, editing?.engine ?? 'claude');
  // O secundário só aparece com a ficha inteira (no simples nem há modelo) e fora da adoção; sem o campo, o pedido não leva a chave (mantém).
  const showFallback = full && !adopting && showFallbackField(codexReview, engine, !!editing?.fallback);
  const catalog = useCodexCatalog(codex && full);
  const [ownTab, setOwnTab] = useState<Tab>('sheet');
  const tab = tabProp === undefined ? ownTab : tabProp;
  const setTab = onTab ?? setOwnTab;
  // No "Mais" do funcionário no nível simples só há a aba Ficha: com todos os campos, o projeto vem embaixo dela.
  const projectBelow = embedded && simple;
  const shows = (which: Tab) => tab === which || (which === 'project' && projectBelow && tab === 'sheet');

  useEffect(() => {
    api.mcp(projectId).then(
      (list) => {
        setMcps(list);
        // Editando: ficha sem restrição (null) = todos marcados. Contratando (ou adotando): nenhum marcado.
        setMcpOn(new Set(editing ? (editing.mcps ?? list.map((m) => m.name)) : []));
      },
      () => setMcps([]),
    );
    api.servers(projectId).then(setServerList, () => setServerList([]));
  }, [projectId, editing]);

  // Cargos da empresa (config → Cargos). Contratando, o cargo padrão já vem preenchido.
  const [roles, setRoles] = useState<RoleEntry[] | null>(null);
  const [roleId, setRoleId] = useState<string | null>(null);
  useEffect(() => {
    api.roles().then(setRoles, () => setRoles([]));
  }, []);
  const defaultApplied = useRef(false);
  useEffect(() => {
    if (!roles || editing || adopting || defaultApplied.current) return;
    defaultApplied.current = true;
    // No simples sempre há um cargo escolhido: o padrão, o orquestrador ou o primeiro.
    const d = roles.find((r) => r.isDefault) ?? (full ? undefined : (roles.find((r) => r.id === 'orquestrador') ?? roles[0]));
    if (d) applyTemplate(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles]);

  /** Preenche com o cargo: o modelo (e o esforço) vêm dele; troca só deste funcionário na ficha. */
  const applyTemplate = (tpl: RoleEntry) => {
    setRoleId(tpl.id);
    setRole(tpl.role);
    setMission(tpl.mission);
    setAutonomy(tpl.autonomy);
    setRules(tpl.rules.join('\n'));
    setDoneWhen(tpl.doneWhen);
    // Os modelos do cargo são do Claude: no Codex a escolha do modelo e do esforço fica como está.
    if (!codex) {
      setModel(tpl.model);
      setEffort(tpl.effort ?? '');
    }
    setPlaybook(tpl.playbook ?? '');
    setCanHire(!!tpl.canHire);
    if (tpl.worktree !== undefined) setWorktree(tpl.worktree);
    if (tpl.skills) setSkills([...new Set([...skills, ...tpl.skills.filter((s) => skillNames.includes(s))])]);
    setShowServers(!!tpl.servers || servers.length > 0);
    if (tpl.pickExecutors && !codex) {
      // Agents com modelo menor que o do orquestrador são os executores naturais.
      const executors = [...inventory.agents, ...board.user.agents]
        .filter((a) => a.model && /haiku|sonnet/i.test(a.model))
        .map((a) => a.name);
      setAgents([...new Set(executors)]);
      setTip(
        executors.length
          ? null
          : t('staff.tipNoExecutors', { preset: t('staff.presetExecutor'), newAgent: t('staff.newAgent') }),
      );
    }
  };
  const [tip, setTip] = useState<string | null>(null);
  const modelOf = useMemo(
    () => new Map([...inventory.agents, ...board.user.agents].map((a) => [a.name, a.model])),
    [inventory, board.user],
  );

  const pickPortrait = (file: File | undefined) => {
    setError(null);
    if (!file) return setPortrait(undefined);
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError(t('staff.errPortraitType'));
    if (file.size > MAX_INPUT_BYTES) return setError(t('staff.errPortraitSize'));
    // Reduzido aqui: o quadro mostra com 40 px e o arquivo fica na pasta do projeto.
    shrinkImage(file, PORTRAIT_MAX).then(setPortrait, () => setError(t('staff.errPortraitRead')));
  };

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const toggleServer = (name: string) => {
    toggle(servers, setServers, name);
    if (servers.includes(name)) setSshWrite((w) => w.filter((n) => n !== name));
  };

  // Lista vazia ou que não carregou não conta como "todos marcados" (senão gravaria null).
  const allMcps = mcps !== null && mcps.length > 0 && mcps.every((m) => mcpOn.has(m.name));

  /** Escolher um roteiro marca os agents que ele usa, se o projeto tiver. */
  const pickPlaybook = (value: '' | Playbook) => {
    setPlaybook(value);
    const option = PLAYBOOK_OPTIONS.find((o) => o.value === value);
    // No Codex não há agents para marcar: ele faz cada papel do roteiro sozinho.
    if (!option || codex) return setTip(null);
    const found = option.agents.filter((a) => agentNames.includes(a));
    const missing = option.agents.filter((a) => !agentNames.includes(a));
    setAgents([...new Set([...agents, ...found])]);
    setTip(
      missing.length
        ? t('staff.tipPlaybookMissing', {
            playbook: option.label,
            agents: missing.map((a) => `“${a}”`).join(', '),
            newAgent: t('staff.newAgent'),
          })
        : null,
    );
  };

  /** Trocar de motor limpa o modelo (e o esforço) que não servem ao outro. */
  const pickEngine = (next: Engine) => {
    if (next === engine) return;
    const kept = switchEngine(next, { model, effort });
    setEngine(next);
    setModel(kept.model);
    setEffort(kept.effort);
    // O secundário passa a ser o outro motor: o modelo e o esforço que estavam não servem a ele.
    setFallback((f) => ({ ...f, model: '', effort: '' }));
    setTip(null);
    // Ficha que estava salva no Codex (sai sem navegador e sem MCPs) voltando ao Claude: recomeça com o padrão dele, tudo ligado.
    if (next === 'claude' && editing?.engine === 'codex') {
      setBrowser(true);
      setMcpOn(new Set((mcps ?? []).map((m) => m.name)));
    }
  };

  // Contratando no simples: o recomendado para sair funcionando, sem perguntar.
  const simpleHire = !full && !editing && !adopting;
  const template = roles?.find((r) => r.id === roleId) ?? null;
  const autoWorktree =
    template?.worktree ??
    (editsCode(autonomy) && !!git?.[projectId] && colleagues.some((c) => editsCode(c.autonomy) && !c.temporary));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Validação própria: o navegador não consegue focar um campo obrigatório numa aba escondida.
    const noName = !name.trim() || !role.trim();
    if (noName || (!mission.trim() && full)) {
      setTab('sheet');
      return setError(noName ? (full ? t('staff.errNameRole') : t('staff.errChooseRoleName')) : t('staff.errMission'));
    }
    const fallbackIssue = showFallback ? fallbackProblem(fallback) : null;
    if (fallbackIssue) {
      setTab('sheet');
      return setError(t(fallbackIssue));
    }
    setBusy(true);
    setError(null);
    const sendEngine = engineToSend(engine, editing?.engine);
    const input: StaffInput = {
      name,
      role,
      mission: mission.trim() || `Ajudar no projeto ${project?.name ?? ''} como ${role}.`,
      // A tarefa vem pelo chat; a ficha antiga (ou de quem um gestor contratou pela API) mantém a dela.
      firstTask: editing?.firstTask ?? '',
      reportsTo: managers,
      autonomy,
      // O Codex não usa agents, skills nem MCPs: a ficha dele sai sem isso (o quadro não mostra o que ele não tem). O Chrome vale, se ligado nas configurações.
      agents: codex ? [] : agents,
      skills: codex ? [] : skills,
      // Todos marcados = não restringir (a sessão também recebe os conectores da conta). No simples,
      // nenhum: a sessão abre mais leve e rápida; quem precisa liga no avançado. Sem lista (vazia ou
      // falhou), editando mantém o que a ficha tinha; contratando, nenhum.
      mcps: codex || simpleHire ? [] : !mcps?.length ? (editing ? editing.mcps : []) : allMcps ? null : [...mcpOn],
      // Só vai se mudou (ausente mantém o salvo; `{}` limpa).
      ...accessToSend(mcpAccess, editing?.mcpAccess),
      knowledge: lines(knowledge),
      rules: lines(rules),
      doneWhen,
      model: model || null,
      effort: effort || null,
      canHire,
      playbook: playbook || null,
      // Só vai se mudou (ausente mantém o salvo; null limpa). No simples o campo nem aparece: nunca muda.
      ...(full ? personalityToSend(personality, editing?.personality) : {}),
      worktree: simpleHire ? autoWorktree : worktree,
      servers,
      sshWrite: sshWrite.filter((n) => servers.includes(n)),
      browser,
      // Claude fica sem o campo (a ficha igual à de sempre); o Codex vai explícito, e quem volta dele ao Claude também.
      ...(sendEngine ? { engine: sendEngine } : {}),
      // Ligado manda o secundário; desligado tira o que a ficha tinha (`null`); campo escondido não manda (mantém).
      ...fallbackToSend(fallback, engine, !!editing?.fallback, showFallback),
      ...(portrait !== undefined ? { portraitDataUrl: portrait } : {}),
      // A conversa é sempre pelo painel do Claudio’s Club e abre vazia, esperando você escrever.
      ...(editing ? {} : adopting ? { adoptSessionId: adopting.id, launch: false } : { launch: false }),
    };
    try {
      if (editing) onSaved(await api.updateStaff(projectId, editing.id, input));
      else if (adopting) onSaved((await api.hire(projectId, input)).profile);
      else {
        // Abrir a sessão ao contratar passa pela trava de consumo.
        const r = await withUsageConfirm((force) => api.hire(projectId, { ...input, force }));
        if (!r) return setBusy(false);
        onHired(r.profile, r.launch);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const currentPortrait = editing?.portrait && portrait === undefined ? portraitUrl(projectId, editing) : portrait;

  const head = (
    <>
      <button type="button" className="drawer-close" onClick={onClose} aria-label={t('staff.close')}>
        ×
      </button>
      <p className="kicker">
        {editing || adopting ? t('staff.kickerEdit') : t('staff.kickerHire')} · {project?.name}
      </p>
      <h2>{editing ? editing.name : adopting ? t('staff.titleAdopt') : source === 'company' ? t('staff.titleCopy') : t('staff.titleNew')}</h2>
      {canCopy && (
        <div className="templates hire-source" role="group" aria-label={t('staff.sourceLabel')}>
          {(['new', 'company'] as const).map((s) => (
            <button
              key={s}
              type="button"
              className="btn-secondary btn-toggle"
              aria-pressed={source === s}
              onClick={() => setSource(s)}
            >
              {s === 'new' ? t('staff.sourceNew') : t('staff.sourceCompany')}
            </button>
          ))}
        </div>
      )}
    </>
  );

  if (canCopy && source === 'company') {
    return (
      <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal hire">
          {head}
          <CopyFromCompany
            projectId={projectId}
            projectName={project?.name ?? ''}
            initial={preset}
            managers={colleagues.filter((s) => managers.includes(s.id))}
            onClose={onClose}
            onCopied={(profile) => onHired(profile, null)}
          />
        </div>
      </div>
    );
  }

  /** Um painel de aba: escondido, não desmontado, para não perder o que foi digitado ao trocar de aba. */
  const panel = (which: Tab) => ({
    className: 'form-panel',
    hidden: !shows(which),
    // No "Mais" quem tem o tablist (e o tabpanel) é o painel do funcionário.
    ...(embedded ? {} : { role: 'tabpanel', id: `staff-panel-${which}`, 'aria-labelledby': `staff-tab-${which}` }),
  });

  const form = (
      <form className={embedded ? 'hire-inline' : 'modal hire'} onSubmit={submit} onChange={markDirty} noValidate hidden={tab === null}>
        {!embedded && head}
        {adopting && (
          <p className="muted small">
            {t('staff.adoptNote')}
          </p>
        )}

        {editing && copyProfiles.length > 0 && shows('sheet') && (
          <p className="person-scope small">
            {t('hr.scope', { n: copyProfiles.length + 1, projects: [project?.name ?? projectId, ...copyProfiles.map((c) => projectNameOf(c.projectId))].join(', ') })}
          </p>
        )}

        {!full ? (
          <div className="form-panel simple-hire">
            {!editing && (
              <fieldset>
                <legend>{t('staff.roleLegend')}</legend>
                {!roles && <p className="muted small">{t('staff.rolesLoading')}</p>}
                <div className="templates">
                  {roles?.map((tpl) => (
                    <button
                      type="button"
                      key={tpl.id}
                      className={`btn-secondary ${roleId === tpl.id ? 'is-on' : ''}`}
                      aria-pressed={roleId === tpl.id}
                      title={tpl.mission}
                      onClick={() => applyTemplate(tpl)}
                    >
                      {tpl.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="grid2">
              <label>
                {t('staff.nameReq')}
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus={!embedded} />
              </label>
              <label>
                {t('staff.portrait')}
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => pickPortrait(e.target.files?.[0])} />
                {currentPortrait && (
                  <span className="portrait-row">
                    <img className="portrait-preview" src={currentPortrait} alt={t('staff.portrait')} />
                  </span>
                )}
              </label>
            </div>
            {editing && (
              <label>
                {t('staff.whatHeDoes')}
                <textarea value={mission} onChange={(e) => setMission(e.target.value)} rows={3} maxLength={4000} />
              </label>
            )}
            {!editing && template && (
              <p className="muted small simple-summary">
                {t('staff.fromRole', {
                  details: [
                    modelLabel(template.model),
                    template.effort ? t('staff.summaryEffort', { effort: effortLabel(template.effort) }) : null,
                    AUTONOMY_OPTIONS.find((o) => o.value === template.autonomy)?.label.toLowerCase(),
                    template.playbook ? PLAYBOOK_OPTIONS.find((o) => o.value === template.playbook)?.label.toLowerCase() : null,
                    autoWorktree ? t('staff.summaryOwnWorktree') : t('staff.summaryDirect'),
                    template.canHire ? t('staff.summaryCanHire') : null,
                    t('staff.summaryNoMcp'),
                    t('staff.summaryChat'),
                  ]
                    .filter(Boolean)
                    .join(', '),
                })}
              </p>
            )}
            <p className="small">
              <button type="button" className="link" onClick={() => setFull(true)}>
                {t('staff.showAll')}
              </button>
            </p>
          </div>
        ) : (
          <>
        {!embedded && (
          <div className="tabs" role="tablist" aria-label={t('detail.tabSheet')}>
            {TABS.map((tb) => (
              <button
                key={tb.id}
                type="button"
                role="tab"
                id={`staff-tab-${tb.id}`}
                aria-selected={tab === tb.id}
                aria-controls={`staff-panel-${tb.id}`}
                className={`tab ${tab === tb.id ? 'is-active' : ''}`}
                onClick={() => setTab(tb.id)}
              >
                {tb.label}
              </button>
            ))}
          </div>
        )}
        {tab && (
          <p className="muted small tab-intro">
            {TABS.find((tb) => tb.id === tab)?.intro}
            {editing && ` ${t('staff.editNote')}`}
          </p>
        )}

        {/* ---- Ficha: quem é e como trabalha ---- */}
        <div {...panel('sheet')}>
        {!editing && roles && roles.length > 0 && (
          <div className="templates">
            <span className="muted small" title={t('staff.cargosTitle')}>
              {t('staff.cargosLabel')}
            </span>
            {roles.map((tpl) => (
              <button
                type="button"
                key={tpl.id}
                className={`btn-secondary ${roleId === tpl.id ? 'is-on' : ''}`}
                aria-pressed={roleId === tpl.id}
                title={`${tpl.role} · ${modelLabel(tpl.model)}${tpl.isDefault ? ` · ${t('staff.defaultTag')}` : ''}`}
                onClick={() => applyTemplate(tpl)}
              >
                {tpl.label}
              </button>
            ))}
          </div>
        )}

        <div className="grid2">
          <label>
            {t('staff.nameReq')}
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus={!editing} />
          </label>
          <label>
            {t('staff.roleReq')}
            <input value={role} onChange={(e) => setRole(e.target.value)} maxLength={60} required />
          </label>
        </div>

        <label>
          {t('staff.portrait')}
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => pickPortrait(e.target.files?.[0])} />
          {currentPortrait && (
            <span className="portrait-row">
              <img className="portrait-preview" src={currentPortrait} alt={t('staff.portrait')} />
              <button type="button" className="btn-secondary" onClick={() => setPortrait(null)}>
                {t('staff.removePortrait')}
              </button>
            </span>
          )}
        </label>

        <label>
          {t('staff.missionReq')}
          <textarea value={mission} onChange={(e) => setMission(e.target.value)} rows={3} maxLength={4000} required />
        </label>
        <label>
          {t('staff.doneWhen')}
          <input value={doneWhen} onChange={(e) => setDoneWhen(e.target.value)} maxLength={2000} placeholder={t('staff.doneWhenPlaceholder')} />
        </label>
        <label>
          {t('staff.rules')}
          <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={4} placeholder={t('staff.rulesPlaceholder')} />
        </label>

        {showEngine && (
          <fieldset>
            <legend>{t('staff.engineLabel')}</legend>
            <div className="templates" role="group" aria-label={t('staff.engineLabel')}>
              {(['claude', 'codex'] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  className="btn-secondary btn-toggle"
                  aria-pressed={engine === e}
                  disabled={e === 'codex' && engine !== 'codex' && ftpBlocked}
                  onClick={() => pickEngine(e)}
                >
                  {e === 'claude' ? t('staff.engineClaude') : t('staff.engineCodex')}
                </button>
              ))}
            </div>
            <p className="muted small">
              {ftpBlocked ? t('staff.engineCodexServers', { tools: t('detail.tabProject') }) : codex ? t('staff.engineCodexHint') : t('staff.engineClaudeHint')}
            </p>
          </fieldset>
        )}

        {codex ? (
          catalog === null ? (
            <p className="muted small">{t('staff.codexModelsLoading')}</p>
          ) : catalog.models.length === 0 ? (
            // Sem lista (Codex desligado, não instalado, sem login, desatualizado): o motivo no lugar do seletor; o que a ficha já tem fica como está.
            <p className="muted small" role="note">
              {t('staff.codexNoModels', { reason: codexReview ? (catalog.reason ?? '') : t('staff.codexOffReason', { setting: t('toolbar.codexTitle') }) })}
            </p>
          ) : (
            <CodexModelEffort
              catalog={catalog.models}
              model={model}
              effort={effort}
              onModel={(r) => {
                setModel(r.model);
                setEffort(r.effort);
              }}
              onEffort={setEffort}
            />
          )
        ) : (
        <div className="grid2">
          <label>
            {t('staff.modelLabel')}
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('staff.effortLabel')}
            <select value={effort} onChange={(e) => setEffort(e.target.value as '' | Effort)}>
              {EFFORT_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v ? effortLabel(v) : t('staff.effortDefault')}
                </option>
              ))}
            </select>
          </label>
        </div>
        )}

        {showFallback && <FallbackField main={engine} servers={servers} serverList={serverList} draft={fallback} onChange={setFallback} />}

        <label>
          {t('staff.playbookLabel')}
          <select value={playbook} onChange={(e) => pickPlaybook(e.target.value as '' | Playbook)}>
            <option value="">{t('staff.playbookNone')}</option>
            {PLAYBOOK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {playbook && <p className="muted small">{codex ? t('staff.codexPlaybookNote') : PLAYBOOK_OPTIONS.find((o) => o.value === playbook)?.help}</p>}
        {tip && (
          <p className="badge warn" role="note">
            {tip}
          </p>
        )}
        <label>
          {t('staff.personalityLabel')}
          <select value={personality} onChange={(e) => setPersonality(e.target.value as '' | Personality)}>
            <option value="">{t('staff.personalityNone')}</option>
            {PERSONALITIES.map((p) => (
              <option key={p} value={p}>
                {t(PERSONALITY_TEXT[p].name)}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">{personality ? t(PERSONALITY_TEXT[personality].hint) : t('staff.personalityNoneHint')}</p>
        <p className="muted small">{t('staff.personalityHelp')}</p>
        {editing && <PersonMemory key={editing.id} projectId={projectId} staffId={editing.id} name={editing.name} />}
        </div>

        {/* ---- Projeto: com quem fala, o que usa e quanto decide sozinho ---- */}
        <div {...panel('project')}>
        <fieldset>
          <legend>{t('staff.reportsTo')}</legend>
          <p className="muted small">{t('staff.reportsToHint')}</p>
          <div className="checks">
            {colleagues.length === 0 && <span className="muted small">{t('staff.noColleagues')}</span>}
            {colleagues.map((m) => (
              <label key={m.id} className="check">
                <input type="checkbox" checked={managers.includes(m.id)} onChange={() => toggle(managers, setManagers, m.id)} /> {m.name}
                <span className="muted small"> {m.role}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label>
          {t('staff.knowledge')}
          <textarea value={knowledge} onChange={(e) => setKnowledge(e.target.value)} rows={4} placeholder={t('staff.knowledgePlaceholder')} />
        </label>

        {codex ? (
          // O Codex roda numa sandbox só com o projeto: nada disto existe lá, então os campos nem aparecem.
          <p className="muted small">{t('staff.codexToolsNote')}</p>
        ) : (
          <>
        {agentNames.length === 0 && skillNames.length === 0 && gone.length === 0 && (
          <p className="muted small">{t('staff.noAgentsSkills')}</p>
        )}
        {(agentNames.length > 0 || skillNames.length > 0 || gone.length > 0) && (
          <fieldset>
            <legend>{t('staff.suggested')}</legend>
            <p className="muted small">{t('staff.suggestedHint')}</p>
            <div className="checks">
              {agentNames.map((a) => (
                <label key={`a:${a}`} className="check">
                  <input type="checkbox" checked={agents.includes(a)} onChange={() => toggle(agents, setAgents, a)} /> {a}
                  <span className="muted small"> {t('staff.agentTag')} · {modelOf.get(a) ?? t('staff.callerModel')}</span>
                </label>
              ))}
              {skillNames.map((s) => (
                <label key={`s:${s}`} className="check">
                  <input type="checkbox" checked={skills.includes(s)} onChange={() => toggle(skills, setSkills, s)} /> {s}
                  <span className="muted small"> {library.includes(s) ? t('office.libTag') : t('staff.skillTag')}</span>
                </label>
              ))}
              {gone.map((s) => (
                <label key={`gone:${s}`} className="check">
                  <input type="checkbox" checked={skills.includes(s)} onChange={() => toggle(skills, setSkills, s)} /> {s}
                  {skillGone(s) ? (
                    <span className="badge warn">{t('staff.skillGone')}</span>
                  ) : (
                    <span className="muted small"> {syncedSkills.has(s) ? t('detail.synced') : t('staff.skillTag')}</span>
                  )}
                </label>
              ))}
            </div>
            {gone.some((s) => skillGone(s)) && <p className="muted small">{t('staff.skillGoneHint')}</p>}
          </fieldset>
        )}

        <fieldset>
          <legend>MCPs</legend>
          {mcps === null && <p className="muted small">{t('staff.loading')}</p>}
          {mcps?.length === 0 && <p className="muted small">{t('staff.mcpNone')}</p>}
          {mcps && mcps.length > 0 && (
            <>
              <div className="checks">
                {mcps.map((m) => {
                  const on = mcpOn.has(m.name);
                  const level = accessOf(mcpAccess, m.name);
                  return (
                    <div key={m.name} className={on ? 'check-server has-write' : 'check-server'}>
                      <div className="mcp-row">
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => {
                              const next = new Set(mcpOn);
                              if (next.has(m.name)) next.delete(m.name);
                              else next.add(m.name);
                              setMcpOn(next);
                            }}
                          />
                          <span>
                            {m.name}
                            <span className="muted small"> {t(MCP_SOURCE_LABEL[m.source])}</span>
                          </span>
                        </label>
                        {on && hasAccessKey(m.name) && (
                          <McpAccessSelect
                            label={t('staff.mcpAccessFor', { name: m.name })}
                            value={level}
                            onChange={(l) => setMcpAccess(withAccess(mcpAccess, m.name, l))}
                          />
                        )}
                      </div>
                      {on && !hasAccessKey(m.name) && <p className="muted small mcp-hint">{t('staff.mcpAccessNoKey')}</p>}
                      {on && <McpAccessHint hints={mcpAccessHints(level, m)} />}
                    </div>
                  );
                })}
              </div>
              <p className="muted small">{allMcps ? t('staff.mcpAllOn') : t('staff.mcpSomeOff')}</p>
              {mcps.some((m) => mcpOn.has(m.name)) && <p className="muted small">{t('staff.mcpAccessIntro')}</p>}
            </>
          )}
        </fieldset>
          </>
        )}

        {/* Servidores valem nos dois motores: o Codex usa só as conexões SSH (pelo MCP myco-ssh); FTP não funciona nele. */}
        {showServers ? (
          <fieldset id="staff-servers">
            <legend>{t('staff.sshLegend')}</legend>
            <p className="muted small">
              {t('office.hireServersNote')}{' '}
              {codex
                ? t('staff.sshCodexNote')
                : (() => {
                    // Só no "só planeja", "manual" e "edita sozinho" um comando no servidor espera você.
                    const label = AUTONOMY_OPTIONS.find((o) => o.value === autonomy)?.label ?? autonomy;
                    return autonomy === 'auto' || autonomy === 'bypassPermissions' ? (
                      <b>{t('office.hireNoApproval', { autonomy: label, manual: t('staff.autonomyManualLabel') })}</b>
                    ) : (
                      t('office.hireApproval', { autonomy: label })
                    );
                  })()}
            </p>
            {serverList === null && <p className="muted small">{t('staff.loading')}</p>}
            {serverList?.length === 0 && <p className="muted small">{t('office.hireServersEmpty')}</p>}
            <div className="checks">
              {serverList?.map((s) => {
                // A escrita só vale no Codex (no Claude o campo não muda nada hoje), por isso só aparece com ele.
                const write = codex && canWriteSsh(s, servers);
                return (
                  <div key={s.name} className={write ? 'check-server has-write' : 'check-server'}>
                    <label className="check">
                      <input type="checkbox" checked={servers.includes(s.name)} onChange={() => toggleServer(s.name)} />{' '}
                      <ProtocolBadge protocol={s.protocol} /> {s.name}
                      <span className="muted small">
                        {' '}
                        {s.host}
                        {s.remoteRoot ? ` · ${s.remoteRoot}` : ''}
                      </span>
                    </label>
                    {write && (
                      <div className="check-write">
                        <label className="check">
                          <input type="checkbox" checked={sshWrite.includes(s.name)} onChange={() => toggle(sshWrite, setSshWrite, s.name)} />{' '}
                          {t('staff.sshWrite')}
                        </label>
                        <p className="muted small">{t('staff.sshWriteHint')}</p>
                        {sshWrite.includes(s.name) && !editsCode(autonomy) && (
                          <p className="muted small">{t('staff.sshWriteAutonomy', { mode: t('staff.autonomyEditsLabel') })}</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {servers
                .filter((n) => serverList && !serverList.some((s) => s.name === n))
                .map((n) => (
                  <label key={n} className="check">
                    <input type="checkbox" checked onChange={() => toggleServer(n)} /> {n}
                    <span className="muted small"> {t('office.hireServerGone')}</span>
                  </label>
                ))}
            </div>
          </fieldset>
        ) : (
          <p className="muted small" id="staff-servers">
            <button type="button" className="link" onClick={() => setShowServers(true)}>
              {t('staff.addSsh')}
            </button>
          </p>
        )}

        <div className="check-link">
          <label className="check">
            <input type="checkbox" checked={browser} onChange={(e) => setBrowser(e.target.checked)} /> {codex ? t('staff.browserLabelCodex') : t('staff.browserLabel')}
          </label>
          <a className="link small" href={codex ? PLAYWRIGHT_BRIDGE_URL : CHROME_EXTENSION_URL} target="_blank" rel="noopener noreferrer">
            {codex ? t('staff.installLinkCodex') : t('staff.installLink')}
          </a>
        </div>
        {codex ? (
          <p className="muted small">
            {t('staff.browserHintCodex')}
            {browser && !codexBrowser && <> {t('staff.browserCodexOff', { setting: t('toolbar.codexBrowserTitle') })}</>}
          </p>
        ) : (
          <>
            <p className="muted small">
              {t('staff.browserHintA')}<code>claude --chrome</code>{t('staff.browserHintB')}
            </p>
            {browser && <BrowserCheck />}
          </>
        )}
        {/* Um seletor só: o Claude in Chrome e o Chrome do GPT são o mesmo navegador (vale o mais restritivo). */}
        {browser && (
          <div className="mcp-browser">
            <div className="mcp-row">
              <span className="mcp-row-name">{t('staff.browserAccess')}</span>
              <McpAccessSelect
                label={t('staff.browserAccess')}
                value={browserAccess(mcpAccess)}
                onChange={(l) => setMcpAccess(withBrowserAccess(mcpAccess, l))}
              />
            </div>
            <McpAccessHint hints={browserAccessHints(browserAccess(mcpAccess))} />
          </div>
        )}

        <fieldset>
          <legend>{t('staff.autonomy')}</legend>
          <div className="choices">
            {AUTONOMY_OPTIONS.map((o) => {
              const help = codex ? codexAutonomyHelp(o.value) : o.help;
              return (
                <label key={o.value} className="choice" title={help}>
                  <input type="radio" name="autonomy" checked={autonomy === o.value} onChange={() => setAutonomy(o.value)} />
                  <span>
                    <b>{o.label}</b>
                    <span className="muted small">{help}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {codex && <p className="muted small">{t('staff.codexSandboxNote')}</p>}
        </fieldset>

        <label className="check">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> {t('staff.worktreeLabel')}
          <span className="muted small">
            {' '}
            {t('staff.worktreeHintA')}<code>myco/…</code>{t('staff.worktreeHintB')}
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={canHire} onChange={(e) => setCanHire(e.target.checked)} /> {t('detail.canHire')}
          <span className="muted small"> {t('detail.canHireHint')}</span>
        </label>
        </div>
          </>
        )}

        {/* Rodapé fixo: salvar está sempre à vista, em qualquer aba. */}
        <div className="modal-footer">
        {editing && overwrites.length > 0 && (
          <p className="person-note small" role="note">
            {t('hr.overwrites', { project: project?.name ?? projectId, fields: overwrites.join(', ') })}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? t('staff.saving') : editing || adopting ? t('staff.saveProfile') : t('staff.hire')}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {embedded ? t('staff.undo') : t('staff.cancel')}
          </button>
          <span className="muted small modal-footer-note">
            {t('staff.profileIn')} <code>{project ? `${folderName(project.path)}/.myco/staff/` : '.myco/staff/'}</code>
          </span>
        </div>
        </div>
      </form>
  );
  if (embedded) return form;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {form}
    </div>
  );
}

/** Modelo e esforço do Codex: o modelo vem do catálogo da conta (nome de tela), e o esforço só tem os níveis que ele aceita. */
function CodexModelEffort({
  catalog,
  model,
  effort,
  onModel,
  onEffort,
}: {
  catalog: CodexCatalog;
  model: string;
  effort: '' | CodexEffort;
  onModel: (r: { model: string; effort: '' | CodexEffort }) => void;
  onEffort: (e: '' | CodexEffort) => void;
}) {
  // Um modelo da ficha que a lista não tem (a conta deixou de aceitar) continua aparecendo, com o esforço que já tinha.
  const known = catalog.some((m) => m.slug === model);
  const efforts = known ? effortsOfModel(catalog, model) : effort ? [effort] : [];
  const standard = defaultEffortOf(catalog, model);
  return (
    <div className="grid2">
      <label>
        {t('staff.modelLabel')}
        <select value={model} onChange={(e) => onModel(pickCodexModel(catalog, e.target.value, effort))}>
          <option value="">{t('staff.codexModelDefault')}</option>
          {model && !known && <option value={model}>{model}</option>}
          {catalog.map((m) => (
            <option key={m.slug} value={m.slug} title={m.slug}>
              {m.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('staff.effortLabel')}
        <select value={effort} disabled={!efforts.length} onChange={(e) => onEffort(e.target.value as '' | CodexEffort)}>
          <option value="">{standard ? t('staff.codexEffortDefault', { effort: effortLabel(standard) }) : t('staff.effortDefault')}</option>
          {efforts.map((v) => (
            <option key={v} value={v}>
              {effortLabel(v)}
            </option>
          ))}
        </select>
        {!model && <span className="muted small">{t('staff.codexEffortPick')}</span>}
      </label>
    </div>
  );
}
