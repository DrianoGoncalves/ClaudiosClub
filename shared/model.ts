// Modelo de dados exposto pela API. Não usa termos de uma ferramenta específica:
// hoje só o Claude Code o preenche; o Codex entra depois como outro adaptador.

export type LinkKind = 'file' | 'symlink' | 'hardlink';

export interface LinkInfo {
  kind: LinkKind;
  /** Caminho absoluto do destino de um symlink/junction. Hardlinks não têm destino conhecido. */
  target: string | null;
}

export interface Agent {
  id: string;
  /** Identificador real: `name` do frontmatter (ou nome do arquivo, se faltar). */
  name: string;
  description: string | null;
  tools: string[] | null;
  model: string | null;
  scope: 'user' | 'project';
  filePath: string;
  link: LinkInfo;
  /** Outro agent visível no mesmo projeto tem o mesmo `name`; só um deles é carregado. */
  duplicate: boolean;
  error: string | null;
}

export interface Skill {
  id: string;
  /** Identificador real: nome da pasta. */
  name: string;
  /** `name` do frontmatter, usado só como rótulo. */
  label: string | null;
  description: string | null;
  scope: 'user' | 'project' | 'synced';
  /** Skills sincronizadas da conta são gerenciadas fora do MyCo. */
  readOnly: boolean;
  dirPath: string;
  link: LinkInfo;
  error: string | null;
}

/** Valores vistos: busy, idle, waiting. Outros podem aparecer. */
export type SessionStatus = 'busy' | 'idle' | 'waiting' | (string & {});

export interface LiveSession {
  sessionId: string;
  pid: number;
  cwd: string | null;
  name: string | null;
  status: SessionStatus | null;
  /** O processo ainda existe (o arquivo pode ficar órfão após um encerramento forçado). */
  alive: boolean;
  entrypoint: string | null;
  kind: string | null;
  startedAt: string | null;
  statusUpdatedAt: string | null;
  /** Tipos de subagent trabalhando agora para esta sessão (transcript do subagent mexido há pouco). */
  activeAgents?: string[];
  /** O trabalho atual foi pedido por outro funcionário (delegação), e não por você no chat. */
  delegated?: boolean;
}

export interface Session {
  id: string;
  title: string | null;
  /** Origem: claude-desktop, cli, sdk-cli… */
  entrypoint: string | null;
  gitBranch: string | null;
  version: string | null;
  startedAt: string | null;
  updatedAt: string;
  sizeBytes: number;
  subagentCount: number;
  live: LiveSession | null;
}

export interface Project {
  /** Nome da pasta em ~/.claude/projects (estável e seguro para URL). */
  id: string;
  path: string;
  name: string;
  exists: boolean;
  /** Caminho do projeto-pai quando é um worktree em `.claude/worktrees/`. */
  worktreeOf: string | null;
  hasClaudeMd: boolean;
  agentCount: number;
  skillCount: number;
  sessionCount: number;
  lastActivityAt: string | null;
}

/** Estado do código de um projeto (git), para o cabeçalho da sala. */
export interface GitState {
  /** null: HEAD destacado. */
  branch: string | null;
  /** Arquivos alterados ou novos, sem commit. */
  dirty: number;
  /** Remoto acompanhado (`origin/main`…); null quando não há. */
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface ProjectInventory {
  agents: Agent[];
  skills: Skill[];
}

export interface ProjectDetail extends ProjectInventory {
  project: Project;
  sessions: Session[];
}

export type UserScope = ProjectInventory;

export interface UsageLimit {
  /** `five_hour`, `seven_day` ou `spend_limit`. */
  kind: string;
  /** 0 a 100. */
  percentUsed: number;
  resetsAt: string | null;
}

/** Consumo da conta, gravado pelo mod myco-tap em ~/.myco/usage.json. */
export interface AccountUsage {
  /** O mod está instalado em ~/.claude/mods/myco-tap. */
  tapInstalled: boolean;
  limits: UsageLimit[];
  /** Quando alguma sessão leu os limites pela última vez; null antes da primeira leitura. */
  updatedAt: string | null;
}

/** Um esforço (effort) de um modelo no Artificial Analysis. */
export interface ModelVariant {
  id: string;
  /** low, medium, high, xhigh, max…; null quando o nome não diz. */
  effort: string | null;
  /** Artificial Analysis Coding Index: o do modelo, não o de agentes (que a API não traz). */
  codingIndex: number;
  /** US$ por 1M tokens, na mistura de 3 de entrada para 1 de saída. */
  priceBlended: number;
}

/**
 * Um modelo no ranking de código do Artificial Analysis (API gratuita deles). Os números são os do
 * esforço padrão (a variante principal do AA); `variants` traz todos, do menor esforço ao maior.
 */
export interface ModelBenchmark extends ModelVariant {
  name: string;
  creator: string;
  variants: ModelVariant[];
}

export interface ModelBenchmarks {
  /** Sem chave no .env: o painel explica como criar. */
  configured: boolean;
  /** Os de maior índice de código. */
  models: ModelBenchmark[];
  /** Quando os dados vieram da API; null antes da primeira leitura que deu certo. */
  fetchedAt: string | null;
  /** A última busca falhou: os dados, se houver, são da anterior. */
  error: string | null;
}

/** US$ equivalentes em API (estimativa: as sessões rodam pela assinatura). */
export interface CostSummary {
  usd: number;
  today: number;
  last7d: number;
  /** Mês corrente. */
  month: number;
}

export interface CostReport {
  generatedAt: string;
  /** Data da tabela de preços usada. */
  pricingAsOf: string;
  /** A primeira leitura dos transcripts ainda está em andamento: os números vão crescer. */
  scanning: boolean;
  total: CostSummary;
  /** Por id de projeto; `sessions` traz o total de cada sessão (= funcionário), subagents incluídos. */
  projects: Record<string, CostSummary & { sessions: Record<string, number> }>;
  /** Por tipo de subagent (`Explore`, `meta-business-chrome`…). */
  agents: Record<string, CostSummary & { runs: number; projects: Record<string, number> }>;
  /** US$ por modelo. */
  models: Record<string, number>;
  /** Modelos vistos sem preço na tabela (ficam fora dos totais). */
  unpricedModels: string[];
}

/** Configuração do MyCo (~/.myco/config.json). */
/**
 * Simples: contratar com nome, cargo e primeira tarefa (o resto vem do cargo), painel do
 * funcionário só com o chat e config só com o essencial. Avançado: cada detalhe.
 */
export type UiLevel = 'simple' | 'advanced';

export interface AppConfig {
  /** Nome exibido no topo do quadro; "MyCo" por padrão. */
  companyName: string;
  /** Nível da interface; quem já usava o MyCo antes desta opção fica no avançado. */
  uiLevel: UiLevel;
  /** Escondidos do quadro (nada é apagado do Claude Code). */
  archived: {
    /** Ids de projeto. */
    projects: string[];
    /** Ids de sessão (= funcionário). */
    sessions: string[];
  };
  /** Linha de parada do consumo da conta: passar dela pede confirmação antes de trabalhar. */
  usageStop: UsageStop;
  /** O que acontece com a mensagem mandada enquanto o funcionário trabalha. */
  sendWhileBusy: SendPriority;
  /** Cor da parede da sala de cada projeto, por id de projeto; sem entrada = cor padrão. */
  projectColors: Record<string, ProjectColor>;
  /** Fundo do quadro em cada tema do sistema. */
  boardBackground: BoardBackground;
  /**
   * Orçamento por projeto: quanto (1–100) da cota de 7 dias da conta o projeto pode usar. A parte
   * do projeto é estimada pelo custo dele nos últimos 7 dias. Sem entrada = sem orçamento.
   */
  projectBudgets: Record<string, number>;
}

/** Cor (#rrggbb) do fundo do quadro no tema claro e no escuro; null = a padrão. */
export interface BoardBackground {
  light: string | null;
  dark: string | null;
}

/** Cores de caneta para a sala do projeto (cada uma tem um tom claro e um escuro no CSS). */
export const PROJECT_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];

/**
 * Prioridade de uma mensagem mandada com o turno em andamento (a mesma do Claude Code):
 * `now` interrompe e responde já; `next` entra entre uma ferramenta e outra, sem parar o
 * trabalho; `later` espera o turno acabar e vira o próximo.
 */
export type SendPriority = 'now' | 'next' | 'later';

/** Percentuais (0 a 100) dos limites 5h e 7d; null = sem trava naquele limite. */
export interface UsageStop {
  fiveHour: number | null;
  sevenDay: number | null;
}

/**
 * O consumo passou da linha de parada (resposta 409 com `code: 'usage-stop'`). `project_week`: o
 * projeto passou do orçamento dele (parte da cota de 7 dias).
 */
export interface UsageStopHit {
  kind: 'five_hour' | 'seven_day' | 'project_week';
  percentUsed: number;
  limit: number;
  resetsAt: string | null;
  /** A linha veio da ficha do funcionário, e não da empresa. */
  fromProfile: boolean;
  /** Em `project_week`: o nome do projeto. */
  projectName?: string;
}

export type Playbook = 'plan-big-execute-small' | 'scout-then-build' | 'review-gate';

/** Como o usuário avaliou a entrega de um subagent. */
export type RunMark = 'used' | 'partial' | 'discarded';

/** Uma execução de subagent dentro da sessão de um funcionário. */
export interface OrchestrationRun {
  /** Nome do transcript (`agent-…`), estável. */
  id: string;
  agentType: string;
  description: string | null;
  /** Modelo que mais gastou nesta execução. */
  model: string | null;
  /** Parte do consumo total da sessão (0 a 1). */
  share: number;
  /** Quanto custaria a mais no modelo do planejador, relativo ao que custou (0,8 = 80% a mais); null sem preço. */
  extraIfPlanner: number | null;
  at: string | null;
  mark: RunMark | null;
}

/** "Valeu a pena?": a orquestração de uma sessão, só em proporções. */
export interface OrchestrationReport {
  sessionId: string;
  plannerModel: string | null;
  /** Parte do planejador (o transcript principal) no consumo da sessão. */
  plannerShare: number;
  executorShare: number;
  /**
   * Economia em relação a tudo rodar no modelo do planejador (0,4 = gastou 40% a menos);
   * negativa se os executores usaram modelo mais caro; null sem subagents ou sem preço.
   */
  savings: number | null;
  /** Parte do consumo em entregas marcadas como descartadas. */
  wasteShare: number;
  runs: OrchestrationRun[];
  /** A leitura dos transcripts ainda está em andamento. */
  scanning: boolean;
}

/** Login do `claude` (CLI) que o MyCo usa para abrir sessões. */
export interface AuthStatus {
  /** O executável `claude` foi encontrado no PATH. */
  cliFound: boolean;
  loggedIn: boolean;
  /** Como o CLI se autentica (ex.: `none`, `claude.ai`, `console`). */
  authMethod: string | null;
  /** Logado pela assinatura (limites 5h/7d), e não pela API (cobrança por token). */
  subscription: boolean;
  error: string | null;
  checkedAt: string;
}

/** Nível de autonomia da ficha → `--permission-mode` do Claude Code. */
export type Autonomy = 'plan' | 'manual' | 'acceptEdits' | 'auto' | 'bypassPermissions';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Ficha do funcionário: `<projeto>/.myco/staff/<id>.json`. */
/**
 * Rotina de um funcionário: no horário (cron de 5 campos, hora desta máquina), o MyCo manda a
 * mensagem para ele, como se você tivesse digitado. `continue`: na última conversa; `new`: numa nova.
 */
export interface Routine {
  id: string;
  name: string;
  schedule: string;
  message: string;
  mode: 'continue' | 'new';
  enabled: boolean;
}

/** Colunas do quadro de tarefas, na ordem. */
export const TASK_STATUSES = ['todo', 'planning', 'doing', 'review', 'done', 'live'] as const;

/** Temporário (contratado por outro funcionário) parado há mais que isso sai do quadro. */
export const TEMP_IDLE_DAYS = 3;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Tarefa de um projeto (`<projeto>/.myco/tasks.json`), entregue a um funcionário. Guarda o que se
 * perderia entre conversas: a conversa em que ela anda, o plano aprovado, a branch e o PR.
 */
export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Funcionário com ficha que cuida dela; null = ninguém ainda. */
  staffId: string | null;
  /** A conversa da tarefa (aberta ao começar). */
  sessionId: string | null;
  /** O plano aprovado no cartão de plano, em Markdown. */
  plan: string | null;
  branch: string | null;
  /** Link do PR. */
  pr: string | null;
  createdAt: string;
  updatedAt: string;
  /** Mudanças de coluna, a mais recente por último (no máximo 30). */
  history: Array<{ at: string; status: TaskStatus; by: 'you' | 'auto'; note?: string }>;
  /** Revisão pedida a outro funcionário (a conversa dele). */
  review?: TaskHandoff | null;
  /** Deploy pedido ao funcionário de infra. */
  deploy?: TaskHandoff | null;
  /** A worktree foi mesclada no projeto. */
  merged?: { at: string; sha: string; branch: string; base: string } | null;
  /** Último teste rodado pelo MyCo para esta tarefa. */
  tests?: TestRun | null;
  /** Gestor (funcionário) que pediu a tarefa pela API; recebe o resumo quando ela é entregue. */
  requestedBy?: string | null;
  /**
   * Na fila do funcionário: começa sozinha quando ele terminar a tarefa atual (uma por vez, na
   * ordem do quadro).
   */
  queuedAt?: string | null;
  /** Começar mesmo com o limite de consumo batido (você confirmou ao pôr na fila). */
  queuedForce?: boolean;
  /** Mensagens suas nesta conversa esperando o funcionário terminar outra tarefa. */
  held?: HeldMessage[];
  /**
   * Commit da entrega na worktree, feito quando ela foi para revisão. A mescla vai até aqui: o que
   * vem depois é da próxima tarefa dele, que já pode ter começado na mesma worktree.
   */
  checkpoint?: { sha: string; at: string } | null;
}

export interface HeldMessage {
  id: string;
  at: string;
  text: string;
  images?: string[];
  /** Por que está esperando ("Bia está em “Exportar CSV”"). */
  reason: string;
}

/** Tarefas de um projeto para o cabeçalho: abertas, em revisão e o último deploy. */
export interface TaskSummary {
  open: number;
  review: number;
  /** A tarefa que foi para "no ar" por último (by: o funcionário de infra, se o deploy foi pedido a ele). */
  lastDeploy: { title: string; at: string; by: string | null } | null;
}

/** Trabalho passado a outro funcionário (revisão, deploy): quem, em qual conversa e quando. */
export interface TaskHandoff {
  staffId: string;
  sessionId: string;
  at: string;
  /** Quando o turno dele terminou (a resposta está na conversa). */
  doneAt?: string;
}

export interface TestRun {
  command: string;
  ok: boolean;
  /** Fim da saída (até ~6 mil caracteres). */
  output: string;
  ms: number;
  at: string;
}

export interface TaskCodeFile {
  path: string;
  /** A, M, D, R… do git; "?" = arquivo novo ainda fora do git. */
  status: string;
  add: number;
  del: number;
}

/** O código de uma tarefa: onde está, o que mudou e se dá para mesclar. */
export interface TaskCode {
  where: 'worktree' | 'project';
  path: string;
  branch: string | null;
  /** Branch atual do projeto principal (para onde a worktree é mesclada). */
  base: string | null;
  files: TaskCodeFile[];
  commits: Array<{ sha: string; subject: string }>;
  uncommitted: number;
  diff: string;
  truncated: boolean;
  /** Comando de testes achado no projeto (npm test, composer test, phpunit). */
  test: string | null;
  canMerge: boolean;
  whyNot: string | null;
}

/** Última vez que uma rotina rodou (ou foi pulada), por `<projeto>:<ficha>:<rotina>`. */
export interface RoutineRun {
  at: string;
  ok: boolean;
  text: string;
}

export interface StaffProfile {
  id: string;
  projectId: string;
  name: string;
  role: string;
  /** Nome do arquivo do retrato ao lado da ficha, se houver. */
  portrait: string | null;
  /**
   * Funcionários que chamam este (gestores). Vazio = reporta ao usuário. O primeiro define a
   * posição no organograma; os demais aparecem como ligações extras.
   */
  reportsTo: string[];
  mission: string;
  firstTask: string;
  autonomy: Autonomy;
  /** Agents e skills indicados na ficha (o Claude Code continua vendo todos os do projeto). */
  agents: string[];
  skills: string[];
  /** MCPs ligados; null = todos os configurados (inclusive os conectores da conta). */
  mcps: string[] | null;
  /** Arquivos e pastas para ler antes de começar. */
  knowledge: string[];
  rules: string[];
  doneWhen: string;
  /** Alias (`opus`, `sonnet`…) ou id completo; null = padrão do Claude Code. */
  model: string | null;
  effort: Effort | null;
  /** Pode contratar subfuncionários (subsessões) pelo MyCo. */
  canHire: boolean;
  /** Linha de parada própria; null = a da empresa (configurações). */
  usageStop: UsageStop | null;
  /** Roteiro de trabalho (orquestração); null = nenhum. */
  playbook: Playbook | null;
  /** Trabalha numa worktree git própria (escritores em paralelo sem pisar um no outro). */
  worktree: boolean;
  /** Servidores (nomes de ServerInfo) que pode acessar por SSH; vazio = nenhum. */
  servers: string[];
  /** Usa o seu Chrome pela extensão Claude in Chrome (`--chrome`). */
  browser: boolean;
  /** Rotinas agendadas (o MyCo manda a mensagem no horário). Só pelo MyCo; fichas antigas não têm. */
  routines?: Routine[];
  /** Quem contratou pela API (id do funcionário); ausente = você, pelo MyCo. */
  hiredBy?: string | null;
  /**
   * Contratado por outro funcionário: sai do quadro (arquivado, nada apagado) quando o gestor
   * encerra ou depois de dias parado. "Efetivar" tira isso.
   */
  temporary?: boolean;
  /** Quando e por que o temporário foi encerrado. */
  ended?: { at: string; reason: string } | null;
  /**
   * Sessões abertas para este funcionário, a mais recente por último. `cwd` é a pasta onde a
   * sessão roda (a worktree, se a ficha pede uma): retomar exige a mesma pasta.
   */
  sessions: { id: string; startedAt: string; cwd?: string }[];
  createdAt: string;
  updatedAt: string;
}

/** O que o questionário de contratação envia. */
export type StaffInput = Omit<StaffProfile, 'id' | 'projectId' | 'portrait' | 'sessions' | 'createdAt' | 'updatedAt'> & {
  /** Retrato como data URL (png, jpeg ou webp). */
  portraitDataUrl?: string | null;
  /** Abrir a primeira sessão logo após contratar. */
  launch?: boolean;
  /** Sessão criada fora do MyCo que passa a ter esta ficha. */
  adoptSessionId?: string;
  /** Abrir mesmo acima da linha de parada do consumo (confirmado pelo usuário). */
  force?: boolean;
};

/** Servidor MCP disponível num projeto (só nome e origem: a configuração pode ter segredos). */
export interface McpServerInfo {
  name: string;
  /** `project` = .mcp.json; `local` = só este projeto; `user` = todos os projetos. */
  source: 'project' | 'local' | 'user';
  transport: string | null;
}

/** Servidor acessível por SSH (só nome e destino: chaves e senhas ficam no ssh-agent, fora da IA). */
export interface ServerInfo {
  /** Apelido do ~/.ssh/config ou nome da conexão no .vps/config.json do projeto. */
  name: string;
  source: 'ssh-config' | 'vps';
  /** Alias ou endereço que o `ssh` recebe. */
  host: string;
  /** Pasta do projeto no servidor (conexões da skill vps). */
  remoteRoot: string | null;
}

/** Pré-requisitos do Claude in Chrome nesta máquina; null = não dá para conferir neste sistema. */
export interface BrowserStatus {
  /** A extensão está instalada em algum perfil do navegador. */
  extension: boolean | null;
  /** A ponte do CLI está registrada (`claude --chrome` já rodou uma vez). */
  bridge: boolean | null;
  installUrl: string;
}

export interface LaunchResult {
  ok: boolean;
  sessionId: string | null;
  /** O comando que o terminal recebeu (para rodar à mão se a janela não abrir). */
  command: string;
  error: string | null;
}

// ---- conversa com o funcionário ----

export type ChatItem =
  /** `queued`: mandada com o turno em andamento, com esta prioridade. */
  /** `images`: quantas imagens (prints colados) foram junto com o texto. */
  | {
      kind: 'user';
      id: string;
      text: string;
      at: string | null;
      queued?: SendPriority;
      images?: number;
      /** Nomes dos arquivos anexados (texto, PDF). */
      files?: string[];
      /** Id da mensagem no transcript: dá para "voltar até aqui" (desfazer as edições depois dela). */
      uuid?: string;
      /** Guardada pelo MyCo até o funcionário terminar a outra tarefa (o motivo). */
      held?: string;
    }
  | { kind: 'assistant'; id: string; text: string; at: string | null }
  | {
      kind: 'tool';
      id: string;
      name: string;
      /** Resumo curto (arquivo, comando, padrão…). */
      summary: string;
      input: string;
      result: string | null;
      isError: boolean;
      at: string | null;
    }
  | {
      kind: 'permission';
      id: string;
      tool: string;
      summary: string;
      description: string | null;
      input: string;
      status: 'pending' | 'allowed' | 'denied';
      at: string | null;
      /** Fim do modo plano (ExitPlanMode): o plano em Markdown, para aprovar e executar. */
      plan?: string;
      /** Aprovado "sempre": nesta conversa ou no projeto. */
      remembered?: 'session' | 'project';
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'warn' | 'error'; at: string | null };

/** O que espera você, de todas as salas (a caixa "precisa de mim"). */
export type InboxKind = 'plan' | 'permission' | 'secret' | 'waiting' | 'error' | 'routine' | 'orphan';

/** Um turno que acabou (trabalhando → parado): vira o aviso "Fulano terminou". */
export interface TurnNotice {
  id: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  staffId: string | null;
  name: string;
  /** Começo da última resposta (só nas conversas do MyCo). */
  text: string | null;
  at: string;
}

export interface InboxItem {
  /** Estável enquanto o item existir (o navegador avisa só o que é novo). */
  id: string;
  kind: InboxKind;
  projectId: string;
  projectName: string;
  sessionId: string;
  /** Com ficha: id do funcionário; sem ficha: null (sessão solta). */
  staffId: string | null;
  name: string;
  summary: string;
  at: string | null;
}

export interface ContextUsage {
  /** Tokens de entrada da última resposta (com cache), ou seja, o que está ocupado. */
  used: number;
  window: number;
  percent: number;
}

export interface ChatState {
  /** O processo do `claude` desta conversa está aberto no MyCo. */
  running: boolean;
  /** Um turno está em andamento. */
  busy: boolean;
  compacting: boolean;
  model: string | null;
  /** Modo de permissão em vigor no processo (`default`, `acceptEdits`, `plan`, `auto`…). */
  permissionMode: string | null;
  context: ContextUsage | null;
  error: string | null;
  /**
   * Agents e comandos que o funcionário deixou rodando em segundo plano. O turno pode ter acabado,
   * mas fechar o processo agora os mataria no meio.
   */
  background: BackgroundTask[];
  /** Comandos "/" e skills da sessão (o Claude Code manda ao abrir). */
  commands: ChatCommand[];
  /** Esforço trocado nesta conversa; null = o da ficha. */
  effort: string | null;
}

export interface ChatCommand {
  name: string;
  description: string;
}

/**
 * "O que mudou" na conversa: na worktree do funcionário, tudo desde a base; no próprio projeto,
 * só os arquivos que ele editou nesta conversa (as mudanças dos outros ficam de fora).
 */
export type ChatChanges = TaskCode & { scope: 'worktree' | 'conversation'; touched: string[] };

/** Servidor MCP de uma conversa aberta (só nome e estado: a configuração pode ter tokens). */
export interface ChatMcp {
  name: string;
  status: string;
}

/** Trecho de conversa achado na busca. */
export interface ConversationHit {
  projectId: string;
  staffId: string;
  staffName: string;
  sessionId: string;
  title: string | null;
  snippet: string;
  at: string | null;
}

/** Prévia de "voltar até aqui": o que volta. */
export interface RewindPreview {
  canRewind: boolean;
  files: string[];
  insertions: number;
  deletions: number;
  error?: string;
}

/** Arquivo anexado a uma mensagem (além das imagens): texto vai como texto; PDF, em base64. */
export interface ChatAttachment {
  name: string;
  mediaType: string;
  data: string;
}

export interface BackgroundTask {
  id: string;
  /** `agent`, `shell` ou o tipo que o Claude Code mandar. */
  kind: string;
  label: string;
}

/** Eventos que o servidor manda pelo SSE da conversa. */
export type ChatEvent =
  | { type: 'item'; seq: number; item: ChatItem }
  | { type: 'delta'; seq: number; id: string; text: string }
  | { type: 'state'; seq: number; state: ChatState };

export interface ChatSnapshot {
  sessionId: string;
  /** Mensagens anteriores, do transcript (até o início do processo atual, se houver). */
  history: ChatItem[];
  /** Itens e estado do processo aberto no MyCo agora, se houver. */
  live: { items: ChatItem[]; state: ChatState; seq: number } | null;
  /** Suas mensagens guardadas até o funcionário terminar a outra tarefa (ver Task.held). */
  held?: ChatItem[];
  /** Comandos "/" conhecidos para o projeto (da última sessão aberta), para o menu antes de abrir. */
  commands?: ChatCommand[];
  /** Contexto da última resposta registrada, quando não há processo aberto. */
  context: ContextUsage | null;
  /** A sessão está aberta em outro lugar (app ou terminal): conversar daqui criaria uma cópia. */
  /** `orphan`: processo do próprio MyCo que ficou sem dono num reinício do servidor. */
  elsewhere: { pid: number; entrypoint: string | null; status: string | null; orphan: boolean } | null;
}

/** Tudo que o quadro precisa de uma vez (sem as sessões, que são caras de ler). */
export interface Board {
  projects: Project[];
  /** Por id de projeto. */
  inventories: Record<string, ProjectInventory>;
  /** Sessões (= funcionários) por id de projeto, da mais recente à mais antiga. */
  sessions: Record<string, Session[]>;
  /** Fichas dos funcionários contratados pelo MyCo. */
  staff: StaffProfile[];
  /** URL da imagem (logo ou print) de cada projeto que tem uma. */
  images: Record<string, string>;
  user: UserScope;
  live: LiveSession[];
}
