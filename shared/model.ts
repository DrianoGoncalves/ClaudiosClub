// Modelo de dados exposto pela API, preenchido a partir do Claude Code (via adaptador).

import type { Personality } from './personality';

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
  /** `effort` do frontmatter; null = sem ajuste (vale o padrão do Claude Code para o modelo). */
  effort: string | null;
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
  /** Skills sincronizadas da conta são gerenciadas fora do Claudio’s Club. */
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
  /**
   * Assunto: o título da tarefa que abriu a conversa, ou o começo da 1ª mensagem sua. As conversas de
   * um funcionário têm o mesmo `title` (o nome dele), então é isto que as diferencia na lista.
   */
  topic: string | null;
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

/** Arquivo sem commit do projeto. `also`: nomes das outras conversas que também o editaram (recentes). */
export interface UncommittedFile {
  path: string;
  status: string;
  also: string[];
}

/** Uma conversa do projeto que editou arquivos que ainda estão sem commit. */
export interface UncommittedConversation {
  sessionId: string;
  /** Null em conversa sem ficha: não recebe pedido de commit. */
  staffId: string | null;
  /** Nome do funcionário, ou o assunto/título da conversa sem ficha. */
  name: string;
  topic: string | null;
  files: UncommittedFile[];
}

/** Arquivos sem commit do projeto agrupados pela conversa que os editou (ver server/uncommitted.ts). */
export interface UncommittedReport {
  total: number;
  /** Janela das conversas que contam (dias de atividade). */
  recentDays: number;
  conversations: UncommittedConversation[];
  /** Sem conversa recente que os editou: à mão, ou em conversa antiga. */
  unowned: UncommittedFile[];
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
  /** Folga de cota ligada agora (só com "otimizar assinatura" no config; ver server/quotaBoost.ts). */
  boost?: QuotaBoost | null;
  /** Limites do Codex (OpenAI), no mesmo formato dos do Claude. Só vem com "segunda opinião do Codex" ligada no config. */
  codex?: CodexUsage;
}

export type CodexUsageReason = 'not_installed' | 'not_logged_in' | 'error' | 'loading';

export interface CodexVersion {
  /** Versão do `codex` instalado (ex.: `0.167.0`); null se não deu para ler. */
  installed: string | null;
  /** Última versão conhecida (o próprio Codex grava em ~/.codex/version.json); null se não se sabe. */
  latest: string | null;
  /** `installed` é mais velha que `latest`. */
  outdated: boolean;
}

/**
 * Consumo do Codex, espelhando AccountUsage: `limits` usa os mesmos `kind` (`five_hour`, `seven_day`), `percentUsed`
 * e `resetsAt` (ISO) dos limites do Claude, então o mesmo medidor serve. Chega em `GET /api/usage`, no campo `codex`.
 */
export interface CodexUsage {
  /** Instalado, com login e com os limites lidos. */
  connected: boolean;
  /** Por que não está conectado; null quando conectado. `loading`: a primeira leitura ainda está em andamento. */
  reason: CodexUsageReason | null;
  /** Texto curto do erro, quando há. */
  detail: string | null;
  limits: UsageLimit[];
  /** Quando os limites foram lidos (ISO); null sem leitura. */
  updatedAt: string | null;
  version: CodexVersion | null;
  /** Comando que atualiza o Codex (`mise upgrade codex` se veio do mise, senão `codex update`); null sem o CLI. */
  upgradeCommand: string | null;
}

/** Folga de cota: até o reset da cota de 7 dias, conversas no Opus em esforço máximo. */
export interface QuotaBoost {
  /** O reset da cota de 7 dias (ISO), quando a folga acaba de vez. */
  until: string;
  /** Uso projetado no reset, no ritmo da semana (%). */
  projected: number;
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
  /**
   * Gasto do Sistema (o gerador oculto da vitrine: sem transcript). Já está em `total`, em `models` e em `projects[id]`
   * do projeto a que pertence; aqui é só a parte dele. `projects` por id de projeto. Ausente sem nenhuma linha no período.
   */
  system?: CostSummary & { runs: number; projects: Record<string, number> };
}

/** Configuração do Claudio’s Club (~/.myco/config.json). */
/**
 * Simples: contratar com nome, cargo e primeira tarefa (o resto vem do cargo), painel do
 * funcionário só com o chat e config só com o essencial. Avançado: cada detalhe.
 */
export type UiLevel = 'simple' | 'advanced';

/** Prévia da exclusão da retenção (só leitura): o que a próxima varredura apagaria, sem apagar nada. */
export interface RetentionPreview {
  /** Dias para apagar (0 = desligado). */
  deleteAfterDays: number;
  /** Quando a exclusão foi confirmada no navegador (ISO); null = não ligada. */
  enabledAt: string | null;
  claude: { count: number; bytes: number };
  codex: { count: number; bytes: number };
  /** Atividade mais antiga entre os candidatos (ISO), ou null sem candidatos. */
  oldest: string | null;
  /** Nomes dos projetos pulados (ficha ou tarefas ilegíveis): a tela avisa que a prévia deles não está completa. */
  skipped: string[];
}

export interface AppConfig {
  /** Nome exibido no topo do quadro; "Claudio’s Club" por padrão. */
  companyName: string;
  /** Nível da interface; quem já usava o Claudio’s Club antes desta opção fica no avançado. */
  uiLevel: UiLevel;
  /** Escondidos do quadro (nada é apagado do Claude Code). */
  archived: {
    /** Ids de projeto. */
    projects: string[];
    /** Ids de sessão (= funcionário). */
    sessions: string[];
    /** Id da conversa → quando foi arquivada (ISO). Só some do seletor de conversas; volta se ela tiver atividade depois dessa data. */
    conversations: Record<string, string>;
  };
  /** Título que você deu à conversa (id da sessão → título). Sem entrada, vale o último assunto. */
  conversationTitles?: Record<string, string>;
  /** Linha de parada do consumo da conta: passar dela pede confirmação antes de trabalhar. */
  usageStop: UsageStop;
  /** O que acontece com a mensagem mandada enquanto o funcionário trabalha. */
  sendWhileBusy: SendPriority;
  /** Cor da parede da sala de cada projeto, por id de projeto; sem entrada = cor padrão. */
  projectColors: Record<string, ProjectColor>;
  /** Apelido de exibição por id de projeto; sem entrada = nome da pasta. A pasta nunca muda de nome. */
  projectNames: Record<string, string>;
  /** Fundo do quadro em cada tema do sistema. */
  boardBackground: BoardBackground;
  /**
   * Orçamento por projeto: quanto (1–100) da cota de 7 dias da conta o projeto pode usar. A parte
   * do projeto é estimada pelo custo dele nos últimos 7 dias. Sem entrada = sem orçamento.
   */
  projectBudgets: Record<string, number>;
  /**
   * Conversa nova quando o assunto fecha: `auto` segue sozinho numa nova depois do ponto de corte
   * (quando compensa), `suggest` só avisa, `off` deixa como está.
   */
  contextSwitch: ContextSwitch;
  /**
   * Otimizar assinatura: perto do reset, com cota sobrando no ritmo da semana, as conversas vão para
   * o Opus em esforço máximo e os agents pensam mais (ver server/quotaBoost.ts).
   */
  optimizeQuota: boolean;
  /**
   * O limite de uso da assinatura acabou no meio de uma conversa: espera o limite voltar e manda "continue"
   * nela (ver server/chat/autoContinue.ts). Ligado por padrão.
   */
  autoContinue: boolean;
  /** Mostrar no quadro a sala do escopo do usuário (agents e skills de ~/.claude); desligado por padrão. */
  showUserScope: boolean;
  /**
   * Usar o Codex (GPT): a segunda opinião nas tarefas (o diff vai para a OpenAI), a ferramenta `perguntar_gpt` dos funcionários,
   * os funcionários no motor Codex e os limites de uso do GPT. Desligada até você ligar; desligada, o Claudio’s Club nem chama o
   * `codex` (ver server/adapters/codex.ts). O nome da chave é de quando só havia a revisão.
   */
  codexReview: boolean;
  /** Modelo do Codex para o `perguntar_gpt` (slug do catálogo, ex.: `gpt-6-sol`); vazio = o padrão do Codex. */
  codexModel: string;
  /** Permitir acesso à internet: funcionários Claude e Codex e o `perguntar_gpt` podem pesquisar na web. Ligado por padrão. */
  internetAccess: boolean;
  /**
   * "Permitir que o GPT use meu Chrome": funcionário no Codex (com "Navegador" na ficha) usa o Chrome do usuário, com as abas e os logins
   * dele, pelo Playwright MCP em modo extensão (ver `codexChromeMcpArgs`). Desligada até você ligar; lida ao abrir a conversa.
   */
  codexBrowser: boolean;
  /**
   * "Bloquear a tela do Claudio’s Club no navegador dos funcionários": o navegador deles não abre o Club (o hook club-guard e o
   * --blocked-origins do Codex, ver server/clubAddress.ts). Ligado por padrão; desligado, o funcionário com Navegador age na tela
   * com os seus poderes (aprova, mescla). Lida ao abrir a conversa.
   */
  clubGuard: boolean;
  /**
   * Freela (conversa sem ficha) não efetivado e parado há esta quantidade de dias é arquivado sozinho
   * (ver server/freelaSweep.ts). Inteiro de 0 a 90; 0 = nunca. Padrão 3.
   */
  freelaArchiveDays: number;
  /**
   * Controle da varredura acima: sessão arquivada sozinha → `updatedAt` dela naquele momento. Se você
   * desarquivar, ela só é arquivada de novo depois de atividade nova (o `updatedAt` muda). Não é para editar.
   */
  freelaAutoArchived: Record<string, string>;
  /**
   * Retenção: conversa sem atividade há mais de N dias sai da lista (o arquivo nem é lido). Inteiro 0–365; 0 = desligado. Padrão 7.
   * Arquivar não apaga nada; a conversa volta com `?old=1` (ver server/adapters/claude/sessions.ts).
   */
  archiveAfterDays: number;
  /**
   * Retenção: conversa lançada pelo Claudio’s Club (registro em sessions-registry.json) sem atividade há mais de N dias pode ser apagada
   * (etapa posterior, ainda sem exclusão). Inteiro 0–365; 0 = desligado. Padrão 30. Com os dois ligados, passa do `archiveAfterDays`.
   */
  deleteAfterDays: number;
  /** Quando a exclusão foi ligada (ISO); null = nunca. Só a rota própria grava (fora do config genérico). */
  retentionDeleteEnabledAt: string | null;
  /** Workspaces: abas do quadro que agrupam os projetos como você quiser (cliente, área, tipo…). */
  workspaces: Workspace[];
  /** Workspace de cada projeto, por id de projeto; sem entrada = sem workspace. */
  projectWorkspaces: Record<string, string>;
  /**
   * Gate de recursos da fila: o início automático da próxima tarefa espera RAM livre, e a CPU se `cpuGate`, e o teto de
   * conversas (ver server/resourceGate.ts). Começar à mão não passa por ele.
   */
  resourceGate: boolean;
  /** RAM livre mínima para começar, em GB (0 = não olha a RAM). */
  minFreeRamGb: number;
  /** Também segura o início quando a CPU média dos últimos 2 min está alta (90% ou mais). */
  cpuGate: boolean;
  /** Conversas rodando ao mesmo tempo, em todos os projetos, antes de começar outra (0 = sem teto). */
  maxActiveChats: number;
  /** Teto de ferramentas por turno (0 = desligado): passou disso, o turno é interrompido e você é avisado. Lido a cada turno. */
  maxTurnTools: number;
  /** Teto de minutos por turno (0 = desligado), sem contar o tempo esperando sua permissão ou resposta. Lido a cada turno. */
  maxTurnMinutes: number;
}

export const CONTEXT_SWITCHES = ['auto', 'suggest', 'off'] as const;
export type ContextSwitch = (typeof CONTEXT_SWITCHES)[number];

/** Um workspace: o nome vai para a ficha de quem trabalha nos projetos dele, como contexto. */
export interface Workspace {
  id: string;
  name: string;
  /** Fundo do quadro na aba dele, por tema; null = o fundo geral. */
  background: BoardBackground;
}

/** Cor (#rrggbb) do fundo do quadro no tema claro e no escuro; null = a padrão. */
export interface BoardBackground {
  light: string | null;
  dark: string | null;
}

/** Cores de caneta para o projeto (cada uma tem um tom claro e um escuro no CSS). */
export const PROJECT_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
export type PenColor = (typeof PROJECT_COLORS)[number];
/** Uma caneta ou uma cor personalizada (#rrggbb, a mesma nos dois temas). */
export type ProjectColor = PenColor | `#${string}`;
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** O valor CSS da cor: a variável da caneta ou o hex. */
export const colorCss = (c: ProjectColor) => (c.startsWith('#') ? c : `var(--pen-${c})`);

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

/** Ranking de economia: o "valeu a pena?" de uma sessão em US$, só no período pedido. */
export interface SessionSavings {
  projectId: string;
  sessionId: string;
  /** US$ no período: transcript principal e subagents. */
  usd: number;
  /** Parte de `usd` gasta pelos subagents. */
  executorUsd: number;
  /**
   * Quanto custaria se o modelo do planejador fizesse também o trabalho dos subagents; igual a
   * `usd` sem subagents. Conta só os tokens dos modelos com preço (os mesmos de `usd`); null se o
   * modelo do planejador não tem preço.
   */
  asPlannerUsd: number | null;
  /** Parte de `usd` em entregas marcadas como descartadas. */
  discardedUsd: number;
  /** Subagents com gasto no período. */
  runs: number;
}

export interface SavingsReport {
  /** Primeiro dia do período (AAAA-MM-DD, hora local); null = desde sempre. */
  since: string | null;
  /** Só sessões com gasto no período. */
  sessions: SessionSavings[];
  /** A leitura dos transcripts ainda está em andamento. */
  scanning: boolean;
}

/** Login do `claude` (CLI) que o Claudio’s Club usa para abrir sessões. */
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

/** Anexo do projeto: arquivo guardado em `<projeto>/.myco/attachments/` (sem subpastas). */
export interface ProjectAttachment {
  name: string;
  size: number;
  mtimeMs: number;
  /** Tipo MIME inferido pela extensão (`application/octet-stream` se desconhecida). */
  type: string;
  /** Raster (png, jpg, gif, webp): o download pode ser mostrado inline como pré-visualização. */
  previewable: boolean;
}

/** Resposta do envio: `name` pode diferir do pedido (nome limpo ou com sufixo " (2)"). */
export interface ProjectAttachmentUpload extends ProjectAttachment {
  renamed: boolean;
}

/** Nível de autonomia da ficha → `--permission-mode` do Claude Code. */
export type Autonomy = 'plan' | 'manual' | 'acceptEdits' | 'auto' | 'bypassPermissions';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Esforço de quem roda no Codex: o `ultra` só existe lá (os modelos Sol aceitam; os Luna vão até `max`). O Claude nunca recebe `ultra`. */
export type CodexEffort = Effort | 'ultra';

/**
 * Quem roda o funcionário: o Claude Code (padrão, e o que vale quando a ficha não diz) ou o Codex (CLI da OpenAI,
 * pela cota do ChatGPT). Com `codex`, `model` e `effort` da ficha são os do Codex (slug `gpt-…`, esforço low a max).
 */
export type Engine = 'claude' | 'codex';

/**
 * Motor e modelo de uma conversa que não é o da ficha (o secundário, ver `StaffProfile.fallback`). Vale para a conversa inteira:
 * sem `effort`, é o padrão do motor (não o da ficha). Ver `ChatManager.send` (server/chat/manager.ts).
 */
export interface EngineOverride {
  engine: Engine;
  model: string;
  effort?: CodexEffort;
  /**
   * Modo de execução da conversa, quando ela não é o da ficha (a troca no meio da tarefa: a conversa nova abre no modo que a
   * antiga tinha, não no da ficha). Ausente = o da ficha. Não entra em `TaskFallback`: lá o modo vem da ficha atual.
   */
  autonomy?: Autonomy;
}

/**
 * Troca de motor de uma tarefa (ver `server/taskFallback.ts`): ela passou a rodar no secundário da ficha, em conversa nova
 * (o transcript não migra). Presente = a tarefa já trocou e não troca de novo, nem depois de reiniciar. `fromSession`: a
 * conversa do motor da ficha, que ficou para trás.
 */
export interface TaskFallback extends EngineOverride {
  from: Engine;
  at: number;
  fromSession: string | null;
  reason: 'limit-start' | 'limit-mid';
}

/** Ficha do funcionário: `<projeto>/.myco/staff/<id>.json`. */
/**
 * Rotina de um funcionário: no horário (cron de 5 campos, hora desta máquina), o Claudio’s Club manda a
 * mensagem para ele, como se você tivesse digitado. `continue`: na última conversa; `new`: numa nova; `task`: cria uma
 * tarefa no quadro, na ficha, com a mensagem como descrição (ver `TaskService.createFromRoutine`).
 */
export interface Routine {
  id: string;
  name: string;
  schedule: string;
  message: string;
  mode: 'continue' | 'new' | 'task';
  enabled: boolean;
}

/** Colunas do quadro de tarefas, na ordem. "waiting" (Aguardar) não é ocupado nem entra na fila. */
export const TASK_STATUSES = ['waiting', 'todo', 'planning', 'doing', 'review', 'done'] as const;

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
  /** Meta: o porquê da tarefa, em uma frase. Vai ao funcionário no início. */
  goal?: string | null;
  /** Critério de aceite: como quem revisa confere que a entrega está pronta. */
  acceptance?: string | null;
  /** Dependências: tarefas do mesmo projeto que precisam estar prontas ('done') antes de esta começar (ver `blockers` em server/tasks.ts). */
  blockedBy?: string[];
  status: TaskStatus;
  /** Funcionário com ficha que cuida dela; null = ninguém ainda. */
  staffId: string | null;
  /** A conversa da tarefa (aberta ao começar). */
  sessionId: string | null;
  /** Troca de motor da tarefa (ausente = ainda no motor da ficha). Ver `TaskFallback`. */
  fallback?: TaskFallback;
  /** O plano aprovado no cartão de plano, em Markdown. */
  plan: string | null;
  branch: string | null;
  /** Link do PR. */
  pr: string | null;
  createdAt: string;
  updatedAt: string;
  /** Só na listagem (derivado, não gravado): Pronto sem mudança há mais de 7 dias. A tela esconde por padrão. */
  archived?: boolean;
  /** Quando passou a contar como arquivada (updatedAt + 7 dias); só presente se `archived`. */
  archivedAt?: string;
  /** Mudanças de coluna, a mais recente por último (no máximo 30). */
  history: Array<{ at: string; status: TaskStatus; by: 'you' | 'auto'; note?: string }>;
  /** Revisão pedida a outro funcionário (a conversa dele). */
  review?: TaskHandoff | null;
  /** Revisor automático: quando a tarefa é entregue, ele revisa sozinho; null/ausente = sem revisão automática. */
  reviewerId?: string | null;
  /** Rodadas de revisão automática já pedidas (no máximo 3). */
  reviewRounds?: number;
  /** Quando a rede de segurança retomou a conversa que parou no meio do turno (uma vez só; ver TaskService.tick). */
  resumedAt?: string | null;
  /** Tentativa corrente (ver server/taskRuns.ts): aberta ao começar ou retomar, fechada na entrega, na parada ou no cancelamento. */
  runId?: string | null;
  /** Criada por uma rotina de tarefa (`mode: 'task'`): o id da rotina. Ausente = tarefa comum. Quem começa pela fila usa o gatilho 'routine'. */
  routineId?: string;
  /** Chave de idempotência da rotina (`rotina:<ficha>:<rotina>:<minuto>`): o mesmo minuto não cria a tarefa de novo. */
  idemKey?: string;
  /** Deploy pedido ao funcionário de infra. */
  deploy?: TaskHandoff | null;
  /** A worktree foi mesclada no projeto. */
  merged?: { at: string; sha: string; branch: string; base: string } | null;
  /** Último teste rodado pelo Claudio’s Club para esta tarefa. */
  tests?: TestRun | null;
  /** Segunda opinião do Codex sobre o diff (Markdown), quando você pediu. */
  secondOpinion?: { at: string; text: string } | null;
  /** Gestor (funcionário) que pediu a tarefa pela API; recebe o resumo quando ela é entregue. */
  requestedBy?: string | null;
  /** A conversa do gestor em que ele pediu: a entrega volta para ela. */
  requestedSession?: string | null;
  /**
   * Na fila do funcionário: começa sozinha quando ele terminar a tarefa atual (uma por vez, na
   * ordem do quadro).
   */
  queuedAt?: string | null;
  /** Começar mesmo com o limite de consumo batido (você confirmou ao pôr na fila). */
  queuedForce?: boolean;
  /** Na fila, a partida foi segurada pelo gate de recursos (ver server/resourceGate.ts): o motivo e desde quando. Limpo ao começar. */
  resourceWait?: { reason: string; since: string } | null;
  /** Motivo de estar em Aguardar (opcional, texto puro, até 200 caracteres). Limpo ao sair da coluna. */
  waitReason?: string | null;
  /** Mensagens suas nesta conversa esperando o funcionário terminar outra tarefa. */
  held?: HeldMessage[];
  /**
   * Commit da entrega na worktree, feito quando ela foi para revisão. A mescla vai até aqui: o que
   * vem depois é da próxima tarefa dele, que já pode ter começado na mesma worktree.
   */
  checkpoint?: { sha: string; at: string } | null;
  /** Entrega (quando foi para revisão): o resumo da conversa e, se a ficha pediu, o porquê de cada arquivo. */
  delivery?: TaskDelivery;
  /** Dúvida do funcionário numa tarefa pedida por gestor: vai para o gestor (ou, escalada, para você). A mais recente. */
  question?: TaskQuestion;
  /** Quantas dúvidas a tarefa já levou ao gestor (no máximo 3). */
  questionCount?: number;
}

/**
 * Dúvida de uma tarefa pedida por gestor. `ask`: a pergunta com opções (AskUserQuestion); `text`: a linha `DÚVIDA:` do
 * funcionário. Ver TaskService.onAsk e answerQuestion.
 */
export interface TaskQuestion {
  /** requestId do AskUserQuestion, ou `q-` + aleatório na dúvida escrita. */
  id: string;
  source: 'ask' | 'text';
  questions?: Array<{ question: string; options: string[]; multiSelect?: boolean }>;
  /** Da dúvida escrita: do marcador até o fim, cortado em ~2000 caracteres. */
  text?: string;
  /** open: com o gestor; escalated: com você; answered: resolvida. */
  status: 'open' | 'escalated' | 'answered';
  askedAt: string;
  /** Conversa nova do gestor em que a dúvida chegou. */
  managerSession?: string;
  answeredBy?: 'manager' | 'user';
  answeredAt?: string;
  /** Resumo curto da resposta. */
  answer?: string;
}

export interface TaskDelivery {
  at: string;
  /** Última mensagem do funcionário, cortada em 1500 caracteres. */
  summary: string;
  /** Caminho relativo do arquivo → por que mudou (texto puro, até 200 caracteres). Ausente sem lista. */
  notes?: Record<string, string>;
}

export interface HeldMessage {
  id: string;
  at: string;
  text: string;
  images?: string[];
  /** Por que está esperando ("Bia está em “Exportar CSV”"). */
  reason: string;
  /** Carimbo de quem mandou (outro funcionário): vai junto quando a mensagem for enviada (ver server/chat/origin.ts). */
  origin?: string;
}

/** Tarefas de um projeto para o cabeçalho: abertas (tudo que não é pronto) e em revisão. */
export interface TaskSummary {
  open: number;
  review: number;
}

/** Trabalho passado a outro funcionário (revisão, deploy): quem, em qual conversa e quando. */
export interface TaskHandoff {
  staffId: string;
  sessionId: string;
  at: string;
  /** Quando o turno dele terminou (a resposta está na conversa). */
  doneAt?: string;
  /** Veredito da revisão (primeira linha da resposta: APROVADO ou REPROVADO); null = a resposta não trouxe um. */
  verdict?: 'approved' | 'rejected' | null;
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

/**
 * Política de uma ferramenta MCP na ficha (`StaffProfile.mcpPolicy`). `allow` segue a autonomia (não libera nada além dela);
 * `ask` pergunta sempre, em qualquer autonomia; `off` tira a ferramenta da sessão. No Codex, `ask` vira `off` (não há pergunta).
 */
export type McpPolicy = 'allow' | 'ask' | 'off';

export interface StaffProfile {
  id: string;
  projectId: string;
  /**
   * Mesma pessoa em mais de uma ficha (cópias entre projetos): o mesmo `personId`. Ausente em fichas antigas
   * e em fichas sem cópia. Só o Claudio’s Club grava (copiar, ligar, desligar).
   */
  personId?: string;
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
  /**
   * Política por ferramenta MCP. Chave `mcp__servidor` (todas as ferramentas dele) ou `mcp__servidor__ferramenta`; ausente = sem
   * política. Entre a regra do servidor e a da ferramenta vale a mais restritiva (off > ask > allow). Ver server/staff/mcpPolicy.ts.
   */
  mcpPolicy?: Record<string, McpPolicy>;
  /**
   * Escrita por MCP (nome → política), só no motor Claude: as ferramentas sem `readOnlyHint` pedem antes (`ask`) ou ficam
   * bloqueadas (`deny`), em qualquer autonomia (no "sem travas", o pedido vira bloqueio). Ausente (ou o MCP fora do mapa) = livre, como antes.
   */
  mcpWrite?: Record<string, McpWritePolicy>;
  /** Arquivos e pastas para ler antes de começar. */
  knowledge: string[];
  rules: string[];
  doneWhen: string;
  /** Motor do funcionário; ausente = `claude`. */
  engine?: Engine;
  /** Alias (`opus`, `sonnet`…) ou id completo; null = padrão do Claude Code. Com `engine: 'codex'`, o slug do Codex (`gpt-6-sol`…). */
  model: string | null;
  /** `ultra` só com `engine: 'codex'` (o servidor recusa nas outras). */
  effort: CodexEffort | null;
  /** Estilo de comunicação (seção na ficha, ver shared/personality.ts); ausente ou null = sem estilo. */
  personality?: Personality | null;
  /**
   * Motor secundário (fallback quando o principal bate o limite de uso). Ausente = sem secundário. Por enquanto só o dado:
   * nada o usa. Motor diferente do principal; `ultra` só com o Codex; com Codex, sem servidores na ficha.
   */
  fallback?: { engine: Engine; model: string; effort?: CodexEffort };
  /**
   * Último modelo/esforço escolhido no seletor do chat deste funcionário. Só vale para conversa nova
   * quando a ficha não tem `model`/`effort`. Gravado pelo Claudio’s Club, fora do questionário.
   */
  lastModel?: string;
  lastEffort?: CodexEffort;
  /** Pode contratar subfuncionários (subsessões) pelo Claudio’s Club. */
  canHire: boolean;
  /** Roteiro de trabalho (orquestração); null = nenhum. */
  playbook: Playbook | null;
  /** Trabalha numa worktree git própria (escritores em paralelo sem pisar um no outro). */
  worktree: boolean;
  /** Servidores (nomes de ServerInfo) que pode acessar, por SSH ou FTP; vazio = nenhum. */
  servers: string[];
  /** Conexões SSH de `servers` com escrita liberada (ssh_executar no MCP myco-ssh, no Codex). Subconjunto de `servers`; ausente = nenhuma. */
  sshWrite?: string[];
  /** Usa o seu Chrome pela extensão Claude in Chrome (`--chrome`). */
  browser: boolean;
  /** Rotinas agendadas (o Claudio’s Club manda a mensagem no horário). Só pelo Claudio’s Club; fichas antigas não têm. */
  routines?: Routine[];
  /** Quem contratou pela API (id do funcionário); ausente = você, pelo Claudio’s Club. */
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
   * sessão roda (a worktree, se a ficha pede uma): retomar exige a mesma pasta. `model`/`effort`: o
   * que foi escolhido no chat desta conversa (vale ao reabrir); ausente = o da ficha.
   */
  sessions: { id: string; startedAt: string; cwd?: string; model?: string; effort?: CodexEffort; fallback?: { engine: Engine; model: string; effort?: CodexEffort } }[];
  createdAt: string;
  updatedAt: string;
}

/** O que o questionário de contratação envia. */
export type StaffInput = Omit<StaffProfile, 'id' | 'projectId' | 'portrait' | 'sessions' | 'lastModel' | 'lastEffort' | 'createdAt' | 'updatedAt' | 'fallback'> & {
  /** Motor secundário: ausente = mantém o da ficha; `null` (na edição) tira; objeto = troca. */
  fallback?: StaffProfile['fallback'] | null;
  /** Retrato como data URL (png, jpeg ou webp). */
  portraitDataUrl?: string | null;
  /** Abrir a primeira sessão logo após contratar. */
  launch?: boolean;
  /** Sessão criada fora do Claudio’s Club que passa a ter esta ficha. */
  adoptSessionId?: string;
  /** Abrir mesmo acima da linha de parada do consumo (confirmado pelo usuário). */
  force?: boolean;
};

/**
 * Achado da revisão de custo (regra fixa, sem IA). `id` é estável: a tela traduz o título pelo id;
 * `evidence` e `suggestion` já vêm em português, com os números reais do período.
 */
export interface CostReviewFinding {
  id: string;
  severity: 'high' | 'medium' | 'low';
  evidence: string;
  suggestion: string;
  /** Ajuste que o botão "Aplicar" faz (só pelo Claudio’s Club). Ausente = o achado é só leitura (comportamento ou processo). */
  fix?: CostReviewFix;
}

/** O ajuste de um achado. `ficha`: muda só `model`/`effort` (os campos presentes); `rule`: acrescenta a regra às regras da ficha; `task`: cria tarefa para o próprio funcionário. */
export type CostReviewFix =
  | { kind: 'ficha'; model?: 'sonnet'; effort?: 'high' }
  | { kind: 'rule'; text: string }
  | { kind: 'task'; title: string; description: string };

/** Ids de todos os achados da revisão (server/costReview.ts). A rota de aplicar só aceita estes. */
export const COST_REVIEW_FINDING_IDS = [
  'long-context',
  'ignored-context-warning',
  'heavy-model-on-implementation',
  'no-model',
  'big-memory',
  'big-tool-output',
  'repeated-reads',
  'inherited-model-agents',
  'rework',
] as const;

/** Um ajuste feito pelo `POST …/cost-review/apply`. `before`/`after` só dos campos da ficha que mudaram; `taskId` na tarefa criada. */
export interface CostReviewApplied {
  id: string;
  kind: CostReviewFix['kind'];
  before?: { model?: string | null; effort?: CodexEffort | null };
  after?: { model?: string | null; effort?: CodexEffort | null };
  taskId?: string;
}

/** Resposta do apply: o que foi feito e o que ficou de fora (com o motivo, em pt-BR). */
export interface CostReviewApplyResult {
  applied: CostReviewApplied[];
  skipped: Array<{ id: string; reason: string }>;
}

/** Uma conversa do funcionário no período (principal e subagents somados), para o top de cache-read. */
export interface CostReviewSession {
  id: string;
  /** Primeiro pedido da conversa (ou a tarefa que a abriu), até 80 caracteres; null se não há ou se parece segredo. */
  title: string | null;
  /** Respostas do modelo (cada uma conta uma vez, mesmo com o streaming repetindo a linha). */
  calls: number;
  cacheRead: number;
  /** Maior contexto de uma chamada (entrada + escrita e leitura de cache), em tokens. */
  maxContext: number;
  model: string | null;
  /** Último registro da conversa no período (ISO). */
  lastAt: string | null;
}

/** Revisão de custo de um funcionário (`GET …/staff/<id>/cost-review?days=N`): só leitura, sem chamar IA. */
export interface CostReview {
  staffId: string;
  days: number;
  totals: { sessions: number; calls: number; cacheRead: number; cacheWrite: number; output: number; maxContext: number };
  /** As 5 conversas com mais cache-read. */
  sessions: CostReviewSession[];
  /** Tarefas do funcionário criadas no período: `rework` = "Complemento de…"; `reopened` = voltaram de revisão para execução. */
  tasks: { total: number; rework: number; reopened: number };
  /** `bytes`/`lines` do índice (`<id>.memory.md`, o que entra no contexto); `detailBytes` da pasta `<id>.memory/`. */
  memory: { bytes: number; lines: number; detailBytes: number };
  ficha: { model: string | null; effort: CodexEffort | null; engine: Engine };
  /** Ordenados por severidade (alta, média, baixa). Sem achados = lista vazia. */
  findings: CostReviewFinding[];
}

/** Servidor MCP disponível num projeto (só nome e origem: a configuração pode ter segredos). */
export interface McpServerInfo {
  name: string;
  /** `club` = biblioteca do Claudio’s Club; `project` = .mcp.json; `local` = só este projeto; `user` = todos os projetos. */
  source: 'club' | 'project' | 'local' | 'user';
  transport: string | null;
  /** Do último teste na biblioteca (ver server/staff/mcpTools.ts): total e quantas são de escrita. Ausente = nunca testado ou mudou desde o teste. */
  tools?: { total: number; write: number };
}

/** Política de escrita de um MCP na ficha: `ask` = as ferramentas de escrita pedem antes; `deny` = bloqueadas. Ausente = livre. */
export type McpWritePolicy = 'ask' | 'deny';

export type McpScope = 'club' | 'user' | 'project' | 'local';
export type McpType = 'http' | 'sse' | 'stdio';

/** MCP para a tela de biblioteca. Nunca traz valor de env/cabeçalho: só o nome e se está preenchido. */
export interface McpServerView {
  name: string;
  scope: McpScope;
  projectId?: string;
  type: McpType;
  url?: string;
  command?: string;
  args?: string[];
  /** Algum argumento tinha segredo: vem trocado pelo marcador `••••`. */
  argsMasked?: boolean;
  env: Array<{ key: string; set: boolean }>;
  headers: Array<{ key: string; set: boolean }>;
}

/** `ssh` = .vps/config.json (chave); `ftps` = FTP com TLS explícito; `ftp` = FTP puro, sem criptografia. */
export type ConnectionProtocol = 'ssh' | 'ftps' | 'ftp';

/**
 * Servidor que um funcionário pode acessar: uma conexão completa do projeto (sem usuário, chave nem senha).
 * SSH: completa = com usuário e chave. FTP: completa = com senha no cofre.
 */
export interface ServerInfo {
  /** Nome da conexão (.vps/config.json para SSH, .vps/ftp.json para FTP); único entre os dois. */
  name: string;
  /** `vps` = SSH (.vps/config.json); `ftp` = FTP/FTPS (.vps/ftp.json). */
  source: 'vps' | 'ftp';
  protocol: ConnectionProtocol;
  /** Endereço do servidor. */
  host: string;
  /** Pasta do projeto no servidor. */
  remoteRoot: string | null;
}

/**
 * Skill da biblioteca da conta (`~/.myco/skills`): nenhuma sessão vê sozinha; só quem a tem na
 * ficha, carregada como `myco:<nome>` na conversa dele.
 */
export interface LibrarySkill {
  name: string;
  description: string;
  /** Outros arquivos da pasta (scripts, modelos): o Claudio’s Club não edita. */
  files: string[];
  updatedAt: string;
}

/** Um comando de acesso remoto que um funcionário rodou (tirado do transcript dele). */
export interface ServerAccess {
  at: string;
  sessionId: string;
  /** Conexão usada, quando dá para saber pelo comando. */
  connection: string | null;
  command: string;
  /** Deu certo? null = sem resultado no transcript (interrompido, ou ainda rodando). */
  ok: boolean | null;
}

/**
 * Conexão SSH de um projeto, como o Claudio’s Club mostra para você editar (`<projeto>/.vps/config.json`, o
 * mesmo formato da skill vps). O conteúdo da chave nunca é lido: só o caminho.
 */
export interface ProjectConnection {
  protocol: 'ssh';
  name: string;
  host: string;
  port: number;
  user: string | null;
  identityFile: string | null;
  remoteRoot: string | null;
  /** Válida e com usuário e chave: só estas entram no ssh_config que os funcionários usam. */
  complete: boolean;
  /** O arquivo da chave existe nesta máquina. */
  keyFound: boolean;
}

/**
 * Conexão FTP do projeto (`.vps/ftp.json`, fora do git). A senha fica no cofre do sistema
 * (`~/.myco/secrets`) e nunca volta: a tela só sabe se ela existe.
 */
export interface FtpConnection {
  /** `ftps` = TLS explícito (padrão); `ftp` = sem criptografia (a senha e os arquivos passam abertos). */
  protocol: 'ftps' | 'ftp';
  name: string;
  host: string;
  port: number;
  user: string;
  /** Pasta onde o funcionário fica preso no servidor; null = sem limite (a pasta de login). */
  remoteRoot: string | null;
  hasPassword: boolean;
}

/** Nome do MCP de FTP na sessão do funcionário: as ferramentas aparecem como `mcp__myco-ftp__ftp_*`. */
export const FTP_MCP_NAME = 'myco-ftp';

/** MCP que leva uma pergunta ao GPT (Codex): a ferramenta aparece como `mcp__myco-gpt__perguntar_gpt`. */
export const GPT_MCP_NAME = 'myco-gpt';
export const GPT_TOOL_NAME = 'perguntar_gpt';

/** Item de `POST /api/projects/:id/connections/list`: SSH e FTP juntos, pelo `protocol`. */
export type AnyConnection = ProjectConnection | FtpConnection;

/** Corpo de `POST /api/projects/:id/connections/ftp` (criar ou editar). */
export interface FtpConnectionInput {
  name: string;
  protocol: 'ftps' | 'ftp';
  host: string;
  /** Padrão 21. */
  port?: number;
  user: string;
  remoteRoot?: string | null;
  /** Obrigatória ao criar; na edição, ausente ou vazia mantém a que está no cofre. */
  password?: string;
  /** A conexão que está sendo editada (renomear leva a senha e o acesso nas fichas). */
  originalName?: string;
}

/** Página da extensão Claude in Chrome na Chrome Web Store (sem parâmetros de rastreio). */
export const CHROME_EXTENSION_URL = 'https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn';

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
      /** Guardada pelo Claudio’s Club até o funcionário terminar a outra tarefa (o motivo). */
      held?: string;
      /** Quem mandou foi outro funcionário (pela API), não você. */
      fromStaff?: boolean;
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
      /** Pergunta com opções (AskUserQuestion): as perguntas já validadas; o cartão deixa responder. */
      questions?: AskedQuestion[];
      /** Perguntas respondidas (texto da pergunta → resposta); `{}` = você pulou. Só depois de responder. */
      answers?: QuestionAnswers;
    }
  | {
      kind: 'notice';
      id: string;
      text: string;
      tone: 'info' | 'warn' | 'error';
      at: string | null;
      /**
       * O aviso leva um botão: `cancel-auto-continue` desfaz o "continue" agendado para quando o limite de uso voltar;
       * `cancel-wake` desfaz o despertador.
       */
      action?: 'cancel-auto-continue' | 'cancel-wake';
      /** Aviso do despertador: em que pé está. `waiting` tem a contagem regressiva (o cliente faz, com `wakeAt`). */
      wake?: 'waiting' | 'sent' | 'cancelled' | 'failed';
      /** Despertador: o instante (ms) da volta (`waiting`) ou em que voltou/foi desfeito (os demais). */
      wakeAt?: number;
      /** Ferramenta negada: a ferramenta, e quem barrou (`denial`, a dica que a tela mostra). */
      tool?: string;
      denial?: DenialInfo;
      /** O turno parou no teto (ferramentas ou minutos): o aviso diz qual e quanto era. */
      cap?: TurnCapHit;
    };

/**
 * Turno parado que não volta sozinho: pelo teto (ver server/chat/turnCap.ts: o que passou do limite e quanto era) ou pelo
 * reinício, que cortou no meio uma ação com efeito fora do projeto (ver server/chat/cutAction.ts: `action`, o resumo dela).
 * Fica na caixa (e põe a tarefa em Aguardar) até você mandar mensagem nova.
 */
export type TurnCapHit = { kind: 'tools' | 'minutes'; limit: number } | { kind: 'restart'; action: string };

/** Quem barrou uma ferramenta: `layer`; `reason` é o motivo dado (sem ele, ausente). `safety` = checagem embutida
 *  do Claude Code (ex.: Remove-Item em caminho do sistema); `settings` = arquivo ou pasta negado nas regras de permissão. */
export interface DenialInfo {
  layer: 'classifier' | 'classifierError' | 'club' | 'safety' | 'settings' | 'other';
  reason?: string;
  /** `servers`: dar acesso a servidores; `autonomy`: o classificador do Autônomo barrou; `retry`: tentar de novo. */
  hint: 'servers' | 'autonomy' | 'retry' | null;
}

/** Uma opção de uma pergunta do Claude (`preview`: HTML de exemplo que o cartão mostra ao marcar). */
export interface AskedOption {
  label: string;
  description: string;
  preview?: string;
}

/** Uma pergunta do Claude (AskUserQuestion). `choice` tem opções; `text` é caixa livre; `number` vai de min a max. */
export interface AskedQuestion {
  question: string;
  header: string;
  kind: 'choice' | 'text' | 'number';
  multiSelect: boolean;
  options: AskedOption[];
  description?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  unit?: string;
}

/** Respostas: texto da pergunta → a opção (ou várias, ou o que você escreveu). Pergunta sem resposta não entra. */
export type QuestionAnswers = Record<string, string | string[]>;
/** Extras de uma resposta: o `preview` da opção marcada. */
export type QuestionAnnotations = Record<string, { preview?: string; notes?: string }>;

/** O que espera você, de todas as salas (a caixa "precisa de mim"). */
export type InboxKind = 'plan' | 'permission' | 'secret' | 'waiting' | 'error' | 'routine' | 'orphan' | 'usage';

/** Um turno que acabou (trabalhando → parado): vira o aviso "Fulano terminou". */
export interface TurnNotice {
  id: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  staffId: string | null;
  name: string;
  /** Começo da última resposta (só nas conversas do Claudio’s Club). */
  text: string | null;
  at: string;
}

/** Tipo do segredo achado no chat (a guarda está em server/chat/secrets.ts). */
export type SecretKind = 'private-key' | 'api-key' | 'password-cli' | 'password-env' | 'password-url';

/** De onde veio o texto com o segredo: o aviso diz isso. Sem origem, o aviso diz "no chat". */
export type SecretSource = 'owner' | 'staff-reply' | 'tool-input' | 'tool-result';

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
  /**
   * Para onde a conversa rola ao clicar no aviso: o id do `ChatItem` que causou o aviso (o cartão de
   * permissão ou de plano; o balão da resposta onde a pergunta foi achada). Sem ele a conversa abre no fim.
   */
  itemId?: string;
  /** Pergunta detectada no texto da resposta: o cliente acha o trecho dentro do balão (ou nos últimos balões, sem `itemId`). */
  quote?: string;
  /** Segredo no chat: o cliente monta a frase no idioma da página (sem isso, vale `summary`, em pt-BR). Nunca traz o valor. */
  secret?: { kind: SecretKind; detail?: string; source?: SecretSource };
}

export interface ContextUsage {
  /** Tokens de entrada da última resposta (com cache), ou seja, o que está ocupado. */
  used: number;
  window: number;
  percent: number;
}

export interface ChatState {
  /** O processo do `claude` desta conversa está aberto no Claudio’s Club. */
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
  /** Esta conversa foi trazida para cá ("Trazer"): a cópia que segue aqui. O painel abre direto nela. */
  copy?: string | null;
  /** Mensagens anteriores, do transcript (até o início do processo atual, se houver). */
  history: ChatItem[];
  /** Itens e estado do processo aberto no Claudio’s Club agora, se houver. */
  live: { items: ChatItem[]; state: ChatState; seq: number } | null;
  /** Suas mensagens guardadas até o funcionário terminar a outra tarefa (ver Task.held). */
  held?: ChatItem[];
  /** Comandos "/" conhecidos para o projeto (da última sessão aberta), para o menu antes de abrir. */
  commands?: ChatCommand[];
  /** Contexto da última resposta registrada, quando não há processo aberto. */
  context: ContextUsage | null;
  /** A sessão está aberta em outro lugar (app ou terminal): conversar daqui criaria uma cópia. */
  /** `orphan`: processo do próprio Claudio’s Club que ficou sem dono num reinício do servidor. */
  elsewhere: { pid: number; entrypoint: string | null; status: string | null; orphan: boolean } | null;
  /** A conversa roda no motor/modelo secundário (ver `EngineOverride`); ausente = o da ficha. */
  fallback?: EngineOverride;
}

/** Tudo que o quadro precisa de uma vez (sem as sessões, que são caras de ler). */
export interface Board {
  projects: Project[];
  /** Por id de projeto. */
  inventories: Record<string, ProjectInventory>;
  /** Sessões (= funcionários) por id de projeto, da mais recente à mais antiga. */
  sessions: Record<string, Session[]>;
  /** Fichas dos funcionários contratados pelo Claudio’s Club. */
  staff: StaffProfile[];
  /** URL da imagem (logo ou print) de cada projeto que tem uma. */
  images: Record<string, string>;
  user: UserScope;
  live: LiveSession[];
}

export interface UpdateCommit {
  hash: string;
  at: string;
  subject: string;
}

/** O próprio Claudio’s Club contra a versão mais nova publicada no GitHub (server/selfUpdate.ts). */
export interface UpdateStatus {
  /** É um clone git com remoto? Sem isso, não há o que buscar. */
  supported: boolean;
  /** A versão daqui (ex.: v0.2.0): a última tag no histórico, ou a do package.json. */
  current: string | null;
  /** A versão mais nova publicada (tag vX.Y.Z); null antes da primeira. */
  latest: string | null;
  /** Commits da versão mais nova que ainda não estão aqui. */
  behind: number;
  /** Este código tem commits que a versão não tem (impede o fast-forward). */
  diverged: boolean;
  /** Arquivos do Claudio’s Club mudados à mão (impedem atualizar). */
  dirty: boolean;
  /** As notas da versão (texto da tag anotada). */
  notes: string | null;
  /** O que entra, do mais novo para o mais velho (até 20). */
  commits: UpdateCommit[];
  checkedAt: string | null;
  /** A busca no remoto falhou (sem rede, sem acesso): o resto vale da última busca boa. */
  error: string | null;
  /** Rodando com o vigia: atualizar já reinicia sozinho (só na resposta da API). */
  daemon?: boolean;
}

/**
 * O que está no disco e ainda não está no ar (server/pendingRestart.ts). O vigia não reinicia por mudança de código:
 * isso só entra pelo botão Reiniciar. `server`: código do servidor (server/, shared/, scripts/ que ele importa, o
 * package-lock ou o pacote dist/server.mjs refeito); `client`: a tela (client/, shared/, vite.config.ts, o lock);
 * `ftpMcp`: o pacote do MCP de FTP dos funcionários.
 */
export type PendingReason = 'server' | 'client' | 'ftpMcp' | 'gptMcp' | 'sshMcp';

export interface PendingRestart {
  /** Há mudança que só entra reiniciando. */
  pendingRestart: boolean;
  /** Por quê; vazio quando `pendingRestart` é false. */
  pendingReasons: PendingReason[];
}

/** GET /api/server: o próprio servidor do Claudio’s Club, para Parar/Reiniciar no config. */
/** Monitor do canto superior direito: CPU e RAM da máquina inteira (bytes). `cpu` null até a 2ª leitura. */
export interface SystemStats {
  cpu: number | null;
  memTotal: number;
  memFree: number;
}

export interface AppServerInfo extends PendingRestart {
  /** Rodando pelo vigia: há "Reiniciar". */
  daemon: boolean;
  /** Quem pediu é um navegador pareado (sem isso, as ações recusam e o config mostra "Parear este navegador"). */
  paired: boolean;
  pid: number;
  port: number;
  startedAt: string;
  /** Conversas trabalhando agora (o reinício as corta). */
  working: { busy: number; background: number };
}
