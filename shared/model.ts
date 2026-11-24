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
  /**
   * Título gerado por IA (só conversa do Club com assunto livre; ver server/titles/generator.ts). Contrato: texto puro (nunca
   * HTML), uma linha, até 60 caracteres. Null ou ausente = sem título gerado (tarefa, assunto vago, falha, ainda gerando,
   * conversa fora do Club). A tela usa: título manual > aiTitle > topic > title.
   */
  aiTitle?: string | null;
  /**
   * Título da tarefa em revisão, quando a conversa começou com o pedido de revisão (`[Revisão da tarefa "<título>"]`) e ainda
   * não mudou de assunto. Texto puro (nunca HTML), uma linha, até 80 caracteres, sem prefixo: a tela monta "<coluna Revisão> -
   * <título>" no idioma dela. Null ou ausente = não é conversa de revisão (ou já virou outro assunto; ou fora do Club).
   * A tela usa: título manual > reviewTask > aiTitle > topic > title.
   */
  reviewTask?: string | null;
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
  /**
   * A conversa que caiu por falha passageira (API sobrecarregada, 5xx, limite de taxa, falha de conexão) ou cujo processo morreu no meio do
   * turno segue sozinha, com espera crescente e no máximo 3 tentativas por turno (1 se a causa é desconhecida). Não retoma se a ação cortada
   * mexia fora do projeto. Ver server/chat/turnRetry.ts. Ligado por padrão.
   */
  autoRetry: boolean;
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
  /** Títulos de conversa gerados por IA (Haiku) para as conversas do Club com assunto livre. Ligado por padrão; desligado, nenhuma chamada ao modelo e a lista volta ao assunto (o cache não aparece). Títulos manuais seguem valendo. Lido a cada lista. */
  aiTitles: boolean;
  /** Parar o Claudio’s Club sozinho quando a última aba dele fechar (mesmo caminho do botão Parar), depois de uma carência sem nenhuma aba. Desligado por padrão: fechar o navegador deixa o servidor em segundo plano. Lido a cada checagem (server/tabPresence.ts). */
  stopOnTabClose: boolean;
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

/**
 * Quando uma rotina roda, no horário desta máquina. É uma união: `cron` (5 campos, o formato antigo) ou calendário
 * (`once` | `daily` | `weekly` | `monthly`). Quinzenal = `weekly` com `interval: 2`. Regras (shared/recurrence.ts):
 * - `time` 'HH:MM' e `start` 'YYYY-MM-DD' (hora e dia locais); `until` 'YYYY-MM-DD' é inclusivo (o dia dele ainda roda).
 * - `interval` ≥ 1: de quantos em quantos dias/semanas/meses, contando de `start`. `once` não tem intervalo nem `until`.
 * - `weekly`: `weekdays` 0 (domingo) a 6 (sábado), padrão o dia de `start`. A semana vai de domingo a sábado e a de `start` é a primeira
 *   (com `interval: 2`, ela roda, a seguinte não, a outra roda).
 * - `monthly`: `monthDay` 1 a 31, padrão o dia de `start`; mês sem esse dia roda no último (31 em abril = 30).
 */
export interface CronRecurrence {
  kind: 'cron';
  expr: string;
}
export interface CalendarRecurrence {
  kind: 'once' | 'daily' | 'weekly' | 'monthly';
  interval: number;
  weekdays?: number[];
  monthDay?: number;
  time: string;
  start: string;
  until?: string;
}
export type Recurrence = CronRecurrence | CalendarRecurrence;

/** Teto de `Routine.catchUpHours` (7 dias). */
export const CATCH_UP_MAX_HOURS = 168;
/** Quantas execuções o histórico de cada rotina guarda (as mais recentes). */
export const ROUTINE_HISTORY_MAX = 50;
/** Maior janela de ocorrências que `GET /schedules?from&to` devolve. */
export const SCHEDULE_WINDOW_MAX_DAYS = 62;

/** Ficha do funcionário: `<projeto>/.myco/staff/<id>.json`. */
/**
 * Rotina de um funcionário: no horário (hora desta máquina), o Claudio’s Club manda a
 * mensagem para ele, como se você tivesse digitado. `continue`: na última conversa; `new`: numa nova; `task`: cria uma
 * tarefa no quadro, na ficha, com a mensagem como descrição (ver `TaskService.createFromRoutine`).
 *
 * Quando roda: `recurrence` (calendário) ou, nas fichas antigas e quando é cron, `schedule` (cron de 5 campos). O servidor grava uma só:
 * cron → só `schedule`; calendário → `recurrence` e `schedule: ''`. Para ler, use `recurrenceOf(routine)` (shared/recurrence.ts) ou o campo
 * `recurrence` já resolvido de `RoutineSchedule`.
 *
 * `catchUpHours`: execução atrasada. Com o Claudio’s Club fechado (ou parado) na hora, ao voltar roda UMA vez a ocorrência mais recente
 * perdida se ela passou há no máximo isso (inclusive); as outras e as fora do limite são descartadas, com registro. 0 ou ausente = desligada
 * (só roda no minuto marcado); máximo `CATCH_UP_MAX_HOURS`.
 */
export interface Routine {
  id: string;
  name: string;
  schedule: string;
  recurrence?: Recurrence;
  catchUpHours?: number;
  message: string;
  mode: 'continue' | 'new' | 'task';
  enabled: boolean;
}

/**
 * Colunas do quadro de tarefas, na ordem. "waiting" (Aguardar) não é ocupado nem entra na fila. "cancelled" não é coluna: é a tarefa
 * fechada sem entrega (ver `isClosed` e `satisfiesDependency`).
 */
export const TASK_STATUSES = ['waiting', 'todo', 'planning', 'doing', 'review', 'done', 'cancelled'] as const;

/** Temporário (contratado por outro funcionário) parado há mais que isso sai do quadro. */
export const TEMP_IDLE_DAYS = 3;
/** Por quantos dias "Continuar esperando" esconde da caixa o aviso de uma bloqueadora cancelada; passado o prazo, o item volta (ver `stuckDependencies`). */
export const ACK_CANCELLED_DAYS = 7;
/** Quantas revisões automáticas uma tarefa pede antes de ficar com o dono (o servidor limita; a tela mostra `n/AUTO_REVIEW_ROUNDS`). */
export const AUTO_REVIEW_ROUNDS = 3;
/** Teto da lista de arquivos de um card automático (`Task.changedFiles`); passando disso, os arquivos novos não entram na lista. */
export const CHANGED_FILES_MAX = 300;
/** Quantos commits de entrega o card guarda (`Task.checkpoints`): o card reprovado tantas vezes assim já parou no limite de revisões. */
export const CHECKPOINTS_MAX = 20;

/** Teto de `Task.fileOverlaps` por tarefa; passando disso, o par novo não é registrado (nem avisado). */
export const FILE_OVERLAPS_MAX = 50;

/**
 * Um arquivo que esta tarefa e OUTRA tarefa aberta, de outra pessoa, alteraram no mesmo projeto (`Task.fileOverlaps`). Gravado nas duas tarefas, uma entrada por (arquivo, outra
 * tarefa), na hora em que a segunda delas registra a edição (ver `TaskService.onCodeEdit`). O registro fica mesmo depois de a outra tarefa fechar: o diff deste arquivo pode ter
 * mudança dela, e o pedido de revisão cita isso.
 */
export interface FileOverlap {
  /** O arquivo, como esta tarefa o tem em `changedFiles` (relativo, com "/"). */
  file: string;
  /** A outra tarefa e o responsável por ela. */
  taskId: string;
  staffId: string;
  /** Quando o Claudio’s Club viu os dois com o arquivo em `changedFiles`. */
  at: string;
  /** Quando o aviso chegou à conversa de trabalho DESTA tarefa. Ausente = ainda não (espera a tarefa estar em "fazendo" ou "planejando", ou a próxima tentativa). */
  toldAt?: string;
}

/**
 * Revisão do quadro de um projeto (`<projeto>/.myco/board.json`): com ela ligada, a tarefa que chega em "revisão" é revisada por
 * `reviewerId`, a não ser que a tarefa aponte outro revisor ou que ele mesmo a tenha executado (aí fica com o dono). Vale para
 * tarefas manuais e para os cards automáticos (`Task.autoCreated`). Desligada, nada muda: só revisa quem a tarefa aponta.
 */
export interface BoardConfig {
  autoReview: boolean;
  /** O funcionário responsável pela revisão; null = ninguém (com `autoReview` ligado não existe: o servidor recusa). */
  reviewerId: string | null;
}

/**
 * Commit automático do projeto (também em `<projeto>/.myco/board.json`, na chave `autoCommit`; desligado por padrão): quando uma tarefa fica pronta, o Club faz
 * UM commit local só com os arquivos que ela alterou (ver `Task.commit` e server/autoCommit.ts). Nunca faz push. Só liga e desliga pela tela.
 */
export interface BoardCommitConfig {
  autoCommit: boolean;
}

/**
 * Um escritor por vez no checkout principal (também em `<projeto>/.myco/board.json`, na chave `singleWriter`; desligado por padrão): com ela ligada, só um card por vez fica com a "vaga de
 * escrita" do projeto, e o outro que iria implementar espera na fila com o motivo (`Task.resourceWait`). Quem trabalha em worktree própria e a fase de plano não entram na conta
 * (ver `TaskService.writeSlot`). Só liga e desliga pela tela.
 */
export interface BoardWriterConfig {
  singleWriter: boolean;
}

/**
 * Worktree por card (também em `<projeto>/.myco/board.json`, na chave `cardWorktree`; LIGADA por padrão: só o `false` gravado desliga): cada card que edita código trabalha numa cópia git
 * só dele e o Club a junta no principal na aprovação (ver server/cardWorktree.ts). Ligada, a vaga de escrita (`BoardWriterConfig`) não se aplica aos cards que ganham worktree. Só liga e desliga pela tela.
 */
export interface BoardCardWorktreeConfig {
  cardWorktree: boolean;
}

/**
 * Política de fluxo do projeto (fonte única de quanto do fluxo é automático): `mode` diz de onde vêm os portões. 'auto', 'supervised' e 'manual' são presets (`FLOW_PRESETS`); 'custom' é o que
 * sobra quando o dono mexe num portão sozinho (ou o valor de um projeto que ainda não tem política, ver `FlowPolicy.source`).
 */
export type FlowMode = 'auto' | 'supervised' | 'manual' | 'custom';

/**
 * Os portões. `plan`: quem aprova o plano de um card que pede plano primeiro; 'owner' = como hoje (quem pediu o card ou o dono decide), 'ai' fica só guardado (a aprovação por IA é de outro
 * card e ainda não age). `completion`: quem leva uma tarefa em revisão a "pronto"; 'ai' = o veredito APROVADO do revisor (e, sem revisor, a tarefa espera o dono), 'owner' = só o dono, pela tela.
 * `commit`: o commit automático local da tarefa pronta (o `autoCommit` de sempre).
 */
export interface FlowGates {
  plan: 'owner' | 'ai';
  completion: 'ai' | 'owner';
  commit: boolean;
}

/**
 * Os valores de cada preset, o ÚNICO lugar onde eles moram (servidor e tela leem daqui).
 * - auto: plano e conclusão pela IA, commit automático. A conclusão por IA exige revisor configurado: sem ele a tarefa fica em "revisão" com a nota e um item na caixa do dono, e nunca vai a
 *   "pronto" sozinha sem revisão.
 * - supervised: plano pela IA, conclusão do dono (a aprovação do revisor IA não leva a "pronto"), commit automático depois da aprovação do dono (o commit roda quando a tarefa fica pronta).
 * - manual: plano e conclusão do dono, commit desligado.
 * `bypassPermissions` não entra em nenhum preset.
 */
export const FLOW_PRESETS: Record<'auto' | 'supervised' | 'manual', FlowGates> = {
  auto: { plan: 'ai', completion: 'ai', commit: true },
  supervised: { plan: 'ai', completion: 'owner', commit: true },
  manual: { plan: 'owner', completion: 'owner', commit: false },
};

/**
 * A política vigente do projeto. Gravada pelo dono (`source: 'stored'`, em `~/.myco/flow-policies.json`, fora do projeto: o agente não grava) ou, sem entrada, o que o projeto já fazia
 * (`source: 'default'`: mode 'custom', plan 'owner', completion 'ai' e commit = o `autoCommit` do `board.json`). A política virtual não gera alerta nem muda o comportamento.
 */
export interface FlowPolicy extends FlowGates {
  mode: FlowMode;
  source: 'default' | 'stored';
  /** O dono escolheu a conclusão (um preset, ou `completion` no corpo): só então 'ai' sem revisor vira aviso na caixa. Sempre false na política virtual. */
  completionChosen: boolean;
}

/** Quantos arquivos do commit e quantos deixados de fora uma tarefa guarda (`TaskCommit.files` e `left`); o resto só entra na contagem da nota. */
export const COMMIT_LIST_MAX = 100;

/**
 * Por que o commit automático deixou um arquivo da tarefa de fora (código estável; a tela monta a frase no idioma dela e o servidor, a dele em pt-BR para o histórico e a caixa):
 * `blocked` segredo, dependência ou caminho inválido; `conflict` em conflito no git; `staged` staged por você e com mudança nova por cima; `owner` você gravou depois no editor do Club;
 * `shared` outra tarefa que ainda não terminou também o alterou (`by` = o id dela).
 */
export type CommitWhy = 'blocked' | 'conflict' | 'staged' | 'owner' | 'shared';

/** Um arquivo da tarefa que o commit automático deixou de fora (ver `TaskCommit.left`) e o motivo. */
export interface TaskCommitLeft {
  path: string;
  why: CommitWhy;
  /** Com `shared`: o id da outra tarefa. */
  by?: string;
}

/**
 * O resultado do commit automático de uma tarefa (ver `Task.commit`). `committed`: tudo o que a tarefa alterou e ainda estava no git entrou. `partial`: um
 * commit saiu, mas ficou arquivo de fora (`left`). `none`: nada foi commitado e não houve erro (`note` diz por quê). `failed`: o git recusou (hook, identidade,
 * repositório no meio de merge…); `note` leva a primeira linha do erro.
 */
export interface TaskCommit {
  /** O `at` da entrada "pronto" do histórico que motivou este commit: a mesma entrega nunca é commitada duas vezes. */
  for: string;
  at: string;
  status: 'committed' | 'partial' | 'none' | 'failed';
  /** O commit (SHA curto); null quando nada foi commitado. */
  sha: string | null;
  files: string[];
  left: TaskCommitLeft[];
  note: string | null;
  /** Precisa de você (falhou, ficou arquivo de fora ou a lista passou do limite): vira item na caixa até você ver. */
  alert: boolean;
  /**
   * Com a vaga de escrita (ver `BoardWriterConfig`), quantos dos arquivos commitados vieram de fora de `Task.changedFiles`: o que a tarefa mudou por shell ou script e o Club não viu,
   * achado pela foto do que já estava sujo quando ela ocupou a vaga (`server/slotSnapshot.ts`). 0 = a foto valeu e não achou nada por fora; ausente = sem foto (sem vaga, ou card que não a ocupou).
   */
  extra?: number;
  /** Você viu o aviso da caixa (o item some; o cartão segue mostrando o resultado). */
  ack?: boolean;
  /**
   * Os commits complementares das sobras (`left`) que você mandou refazer pelo botão (ver `TaskService.redoLeftovers`): um por vez, do mais antigo ao mais novo (teto `COMMIT_REDOS_MAX`). `sha`,
   * `for` e `files` seguem sendo os do commit original; `left`, `status` e `alert` refletem o que ainda ficou de fora. Só o servidor grava.
   */
  redos?: CommitRedo[];
  /**
   * A tentativa AUTOMÁTICA de commitar as sobras que não commitou nada (ver `TaskService.leftoversSoon`): uma por `key` (a entrega mais as sobras de agora), então o Club não repete em laço. Com `note`, o git
   * falhou (hook, repositório fora de condição): o aviso vira `failed` com ela, e o botão do dono segue valendo. Sem `note`, nada podia ir sozinho agora (arquivo ficou em conflito, staged ou editado por você).
   * Sai quando o `left` muda (outro commit, o botão). Só o servidor grava.
   */
  auto?: { key: string; at: string; note?: string };
}

/** Quantos commits complementares uma tarefa guarda em `TaskCommit.redos`. */
export const COMMIT_REDOS_MAX = 20;

/** Um commit complementar das sobras do commit automático (ver `TaskCommit.redos`). */
export interface CommitRedo {
  at: string;
  sha: string;
  files: string[];
  /** Saiu sozinho, quando o último card que travava as sobras ficou pronto (e não pelo botão). */
  auto?: true;
}

/**
 * O estado do aviso de commit parcial, derivado pelo servidor (ver `CommitLeft` e server/commitLeft.ts): `waiting` algum arquivo de fora ainda é tocado por card aberto (só ciência: o refazer
 * espera esses cards fecharem); `ready` nenhum card aberto toca os arquivos de fora e eles seguem com mudança no git (decisão do dono: refazer o commit ou ignorar); `failed` o git falhou ou o repositório
 * não estava em condição (erro). Tom na tela: `ready` = decisão (amarelo), `failed` = erro, `waiting` não entra na caixa.
 */
export type CommitLeftState = 'waiting' | 'ready' | 'failed';

/** Um arquivo que o commit automático deixou de fora, como está agora (ver `CommitLeft.files`). */
export interface CommitLeftFile {
  path: string;
  /** O motivo de agora: o de `TaskCommitLeft.why`, trocado por `blocked`, `conflict` ou `staged` quando o arquivo está assim neste momento (os que o botão nunca leva). */
  why: CommitWhy;
  /** Os ids dos cards ABERTOS que ainda tocam o arquivo (`changedFiles`); vazio fora de `waiting`. */
  by: string[];
  /** Os ids de cards CANCELADOS que o tocaram: a mudança deles pode estar no disco, e o commit leva o arquivo inteiro. */
  cancelledBy?: string[];
  /** O botão "refazer o commit das sobras" leva este arquivo? Falso: segredo, conflito ou staged por você (resolva no git). */
  redo: boolean;
}

/** Um card aberto que trava as sobras de outro (ver `CommitLeft.blockers`). */
export interface CommitLeftBlocker {
  id: string;
  title: string;
  status: TaskStatus;
  /** Os arquivos de fora que ele toca. */
  paths: string[];
}

/**
 * O aviso de commit parcial de uma tarefa pronta, calculado a cada leitura (`Task.commitLeft`; o item da caixa leva os mesmos campos em `InboxItem.autoCommit`). Só existe com o aviso de pé
 * (`commit.alert`) e enquanto alguma sobra ainda tem mudança no git: sem isso, o problema passou.
 */
export interface CommitLeft {
  state: CommitLeftState;
  /** O sha do commit original (nunca muda; null se nada foi commitado). */
  sha: string | null;
  /** Até `COMMIT_LIST_MAX` arquivos. */
  files: CommitLeftFile[];
  /** Os cards abertos que travam, um por card; só em `waiting`. */
  blockers: CommitLeftBlocker[];
  /** Só em `ready` (ou em `failed` por uma tentativa automática que o git recusou, ver `TaskCommit.auto`), com pelo menos um arquivo `redo`: a tela pode oferecer o botão. */
  canRedo: boolean;
  /** A lista de sobras bateu no teto (`COMMIT_LIST_MAX`): pode haver mais arquivos de fora do que os listados. */
  truncated?: true;
  /** Em `failed`: o motivo (a primeira linha do erro do git, ou a razão de o commit não ter saído). */
  note?: string;
}

/** Um arquivo do preview do "refazer" (`CommitLeftovers`): a mudança no git e o diff que entraria no commit. */
export interface CommitLeftoverFile extends CommitLeftFile {
  /** `A` = arquivo novo (sem rastreio), `D` = apagado, `M` = alterado. */
  status: 'M' | 'A' | 'D';
  /** O diff contra o HEAD, texto puro (arquivo do projeto: a tela não o interpreta). Vazio em binário e em arquivo que o botão não leva (`redo` falso); nunca vem de segredo. */
  diff: string;
  binary?: true;
  /** O diff foi cortado (64 KB por arquivo, 400 KB no total). */
  diffTruncated?: true;
}

/** O que a tela mostra antes de o dono confirmar o "refazer" (`GET /api/projects/:id/tasks/:taskId/commit-leftovers`) e o `digest` que ele devolve no POST. */
export interface CommitLeftovers {
  taskId: string;
  /** `undefined`: as sobras já não têm mudança no git (nada a refazer). */
  state?: CommitLeftState;
  sha: string | null;
  canRedo: boolean;
  /** O HEAD curto quando o preview foi montado. */
  head: string;
  /** Vale só para o que está na tela: HEAD mais o conteúdo de cada arquivo que o botão levaria. Mudou algo, o POST recusa (409) e a tela relê o preview. Vazio se `canRedo` é falso. */
  digest: string;
  files: CommitLeftoverFile[];
  blockers: CommitLeftBlocker[];
  /** Arquivos de fora que já não têm mudança no git. */
  dropped: string[];
  truncated?: true;
}

/** O resultado de refazer o commit das sobras (`POST /api/projects/:id/tasks/:taskId/commit-leftovers`). */
export interface CommitLeftoversDone {
  ok: true;
  /** O sha do commit complementar. */
  sha: string;
  files: string[];
  /** O que ainda ficou de fora (vazio = tudo entrou). */
  left: TaskCommitLeft[];
  commit: TaskCommit;
}

/** Quantas tarefas esperam, por projeto, outro card terminar para as sobras poderem ser commitadas (`GET /api/inbox/commit-waiting`). Só ciência: não entra na lista da caixa nem no sino. */
export interface CommitWaitingSummary {
  total: number;
  projects: Array<{ projectId: string; projectName: string; count: number }>;
}
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Encerrada: pronta ('done') ou cancelada. Não é aberta (não entra em fila, contagem de abertas nem rotina em andamento). */
export const isClosed = (t: { status: TaskStatus }): boolean => t.status === 'done' || t.status === 'cancelled';

/**
 * A tarefa cumpre a dependência de quem espera por ela? Só a pronta ('done'): a cancelada fecha sem entrega e CONTINUA bloqueando
 * (o dono decide: liberar, cancelar junto ou seguir esperando; ver `TaskService.resolveCancelledBlocker`).
 */
export const satisfiesDependency = (t: { status: TaskStatus }): boolean => t.status === 'done';

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
  /** Dependências: tarefas do mesmo projeto que precisam estar prontas ('done') antes de esta começar (ver `blockers` em server/tasks.ts). Cancelada bloqueia. */
  blockedBy?: string[];
  /**
   * Dependências canceladas que o dono já viu e mandou continuar esperando, com o momento em que mandou: o aviso some da caixa por
   * ACK_CANCELLED_DAYS e depois volta, ou até a bloqueadora ser reaberta (ver `stuckDependencies`).
   */
  ackCancelled?: Array<{ id: string; at: string }>;
  /** Último motivo avisado aos gestores de quem espera esta tarefa (ver TaskService.doWarnDependents); limpo quando ela volta a andar ou fica pronta. */
  blockAlert?: string | null;
  status: TaskStatus;
  /** Funcionário com ficha que cuida dela; null = ninguém ainda. */
  staffId: string | null;
  /** A conversa da tarefa (aberta ao começar). */
  sessionId: string | null;
  /** Todas as conversas que já foram da tarefa (trabalho, revisão, dúvida ao gestor), a mais antiga primeiro; no máximo 50. */
  sessions?: TaskSession[];
  /** Troca de motor da tarefa (ausente = ainda no motor da ficha). Ver `TaskFallback`. */
  fallback?: TaskFallback;
  /**
   * O motor da ficha está no limite e a troca para o secundário não serve agora (a pré-checagem falhou): a tarefa espera o limite baixar,
   * em vez de cair no secundário. `engine` é o secundário que não serve; `from`, o motor no limite; `detail`, a mensagem do erro; `until`,
   * o fim do limite (ISO) ou null. `since`: desde quando. Limpo ao começar ou quando o limite passa (ver `startPlan`, `stuckState`).
   */
  fallbackBlocked?: { reason: 'sandbox' | 'agents' | 'model' | 'other'; detail: string; engine: Engine; from: Engine; since: string; until: string | null };
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
  /** Cancelamento (status 'cancelled'): quando, o motivo (opcional) e quem cancelou ('user' = você pela tela, ou o id do funcionário). Limpos ao reabrir. */
  cancelledAt?: string;
  cancelReason?: string | null;
  cancelledBy?: string;
  /**
   * Pedido de cancelamento de quem pediu a tarefa (`requestedBy`), quando ela já começou e por isso ele não a cancela sozinho: o responsável decide
   * (ver `CancelRequest` e `TaskService.requestCancel`). Só o último pedido; cada passo também fica no histórico. Limpo ao reabrir.
   */
  cancelRequest?: CancelRequest;
  /**
   * Follow-ups: melhorias que quem revisou (ou fez) a tarefa registrou depois de aprovar, sem poder criar card (ver `FollowUp` e `TaskService.createFollowUp`). Os
   * mais antigos primeiro. Só o servidor grava, pelas rotas `.../followup` e `.../followup/:id/resolve`; nenhuma edição (tela ou API) aceita este campo.
   */
  followUps?: FollowUp[];
  /**
   * Chave de idempotência do POST que criou a tarefa (ver `TaskService.create`): quem pediu, a chave que mandou e a impressão do conteúdo. O mesmo
   * `by` + `key` com o mesmo `hash` devolve esta tarefa em vez de criar outra; com outro `hash`, 409. Só o servidor grava.
   */
  createKey?: { by: string; key: string; hash: string };
  /** Mudanças de coluna, a mais recente por último (no máximo 30). */
  history: Array<{ at: string; status: TaskStatus; by: 'you' | 'auto'; note?: string }>;
  /** Revisão pedida a outro funcionário (a conversa dele). */
  review?: TaskHandoff | null;
  /** Revisor automático: quando a tarefa é entregue, ele revisa sozinho; null/ausente = sem revisão automática. */
  reviewerId?: string | null;
  /** Rodadas de revisão automática já pedidas (no máximo AUTO_REVIEW_ROUNDS). */
  reviewRounds?: number;
  /** Reprovações que devolveram a tarefa para ajuste (manuais ou automáticas). Ausente = nenhuma. */
  reworkRounds?: number;
  /** As últimas reprovações com os 🔴 e a resposta do executor (ver `Rejection`); o pedido de revisão da rodada seguinte as leva. Só o servidor grava. */
  rejections?: Rejection[];
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
  /**
   * Onde o código DESTE card é escrito, gravado quando a conversa de trabalho abre (ver `TaskService.startNow`): `project` = o checkout principal; `worktree` = a do funcionário,
   * no `branch`. A mescla e a aprovação decidem por isto, não pela worktree que o funcionário tem agora (ela pode ter sido criada depois, para outro card). Ausente (card
   * anterior a este campo) = vale a worktree atual dele (ver `locateTaskCode`). Só o servidor grava: nenhuma edição (tela ou API) aceita este campo.
   * Worktree DO CARD (ver server/cardWorktree.ts): `path` é a pasta dela e `card: true`; `port` a porta de servidor de tela reservada ao card; `base` o HEAD de onde partiu. Card que ficou no principal
   * porque a worktree não deu (sem git, sem commit, disco, falha): `why` diz o motivo. `cleanup`: a limpeza da pasta (card junto ou cancelado) não terminou e é refeita.
   */
  codeAt?: { where: 'worktree' | 'project'; branch: string | null; path?: string; card?: true; port?: number; base?: string | null; why?: string; cleanup?: { reason: string; since: string } };
  /** Último teste rodado pelo Claudio’s Club para esta tarefa. */
  tests?: TestRun | null;
  /** Segunda opinião do Codex sobre o diff (Markdown), quando você pediu. */
  secondOpinion?: { at: string; text: string } | null;
  /** Gestor (funcionário) que pediu a tarefa pela API; recebe o resumo quando ela é entregue. */
  requestedBy?: string | null;
  /** A conversa do gestor em que ele pediu: a entrega volta para ela. */
  requestedSession?: string | null;
  /**
   * O card de que esta tarefa é subtarefa: gravado na criação, sozinho, quando a tarefa é pedida pela API com o token da conversa de trabalho de um card (o
   * `requestedBy` é o responsável dele). Tarefa pedida de outra conversa (ou pela tela) não tem. Só o servidor grava: nenhuma edição (tela ou API) aceita este campo.
   */
  parentTaskId?: string;
  /**
   * O fim de turno do card (em "fazendo") achou subtarefa aberta (ver `parentTaskId`): ele não vai para revisão, fica em "fazendo" aguardando, e não ocupa o
   * funcionário (a fila dele anda, como a tarefa parada por dúvida). `since`: desde quando. Só existe enquanto alguma subtarefa está aberta (a listagem tira a marca
   * quando todas fecham); mensagem sua na conversa a desfaz (ele volta a trabalhar), e o próximo fim de turno decide de novo. Só o servidor grava.
   */
  awaitingSubtasks?: { since: string };
  /**
   * Card = código: o fim de turno do card (em "fazendo") não achou nenhuma edição (`changedFiles` vazio e nada alterado no projeto desde que ele começou) e ele não delegou
   * subtarefa: não vai para revisão como entrega normal. Fica em "fazendo", marcado "sem código", e não ocupa o funcionário (a fila dele anda). Quem pediu a tarefa decide:
   * cancelar com motivo (`POST .../tasks/:id/cancel`, que aqui vale também para o gestor que pediu) ou devolver ao responsável (uma mensagem na conversa de trabalho, `sessionId`,
   * que desfaz a marca: o próximo fim de turno confere de novo). Mover o card de coluna também a desfaz. Só o servidor grava.
   */
  noCode?: TaskNoCode;
  /**
   * O card pede o plano primeiro (planejar antes de editar). `true`: o fim de turno em que o responsável entrega só o plano (nenhuma edição) não é entrega: o card vai para
   * "planejando" com o plano pendente de quem pediu (`planWait`), sem revisão, sem rodada e sem reprovação. `false`: nunca espera plano, mesmo que a descrição peça. Ausente: o
   * servidor lê a descrição e a meta (frases como "comece pelo plano" ou "plano primeiro"; ver `wantsPlan` em server/tasks.ts). Aceito na criação e na edição da tarefa.
   */
  planFirst?: boolean;
  /**
   * O plano que o responsável entregou num card que pedia plano primeiro (`planFirst`), esperando a decisão de quem pediu: aprovar (o card segue em "fazendo", no mesmo card,
   * com o plano gravado em `plan`) ou recusar com o motivo (volta ao responsável, em "fazendo"). Só existe com o card em "planejando"; sair de lá (decisão, mensagem na conversa do
   * card, cancelamento) a desfaz. Só o servidor grava.
   */
  planWait?: TaskPlanWait;
  /**
   * A tarefa em "revisão" espera a aprovação do dono (política de fluxo com conclusão 'owner', ou 'ai' sem revisor configurado): só a EXIBIÇÃO (a nota e o item na caixa). Quem autoriza a ir
   * a "pronto" é a política lida de `~/.myco` e o pedido do dono pela tela, nunca este campo. Vale só para a entrega `deliveryAt`; entrega nova, ou sair de "revisão", o desfaz. Só o servidor grava.
   */
  ownerGate?: TaskOwnerGate;
  /**
   * A mescla automática desta entrega (ver `TaskService.mergeSoon`): gravada na aprovação, na mesma escrita da nota, quando o projeto escolheu a conclusão por IA e o código está numa worktree.
   * É o que a fila e o reinício leem: nada se mescla sem ela, e ela só vale para a entrega aprovada (`verdict` + `sha`); entrega nova, mescla feita ou saída de "revisão" a desfazem. Só o servidor grava.
   */
  autoMerge?: TaskAutoMerge;
  /**
   * O fim de turno do card (em "fazendo") achou agent ou comando ainda rodando em segundo plano: não é entrega. Sem revisão, sem resumo gravado e sem aviso a quem pediu; o card
   * segue em "fazendo" (e ocupando o funcionário) até o turno que vem depois do término. Vencido o prazo (`BACKGROUND_WAIT_MS`) sem o segundo plano terminar, a entrega segue como
   * sempre, com uma nota no histórico (`expiredAt`). Sai quando o card sai de "fazendo" ou quando o fim de turno acha o segundo plano vazio. Só o servidor grava.
   */
  backgroundWait?: TaskBackgroundWait;
  /**
   * O card voltou de "revisão" para "fazendo" por mensagem na conversa de trabalho (nota "você respondeu"): o turno que vem responde a ela, e resposta não é entrega. Se esse turno não
   * editou arquivo (`edited` marca a edição que o Club viu) nem trouxe a entrega no formato, o card volta para "revisão" com a entrega ANTERIOR (sem resumo novo, sem rodada de revisão nova,
   * sem aviso a quem pediu). `kept`: o que a revisão tinha antes de sair (a espera pelo dono, a mescla automática, o retry), devolvido junto. Some quando o card sai de "fazendo". Só o servidor grava.
   */
  reopened?: { at: string; edited?: true; kept?: Pick<Task, 'ownerGate' | 'autoMerge' | 'reviewRetry'> };
  /**
   * O card foi para Aguardar porque a conversa "parou no meio" de uma ação com efeito fora do projeto (`TurnCapHit` `restart`, ou `retry` com `why: 'cut'`): uma parada PRESUMIDA, lida do
   * transcript. Se o turno da conversa terminar normal depois (a parada era falsa, ou ela seguiu por mensagem), o card sai de Aguardar e o fim do turno decide como em "fazendo": a entrega
   * é gravada e ele vai para revisão. Some quando o card sai de Aguardar. Só o servidor grava.
   */
  waitCut?: { at: string };
  /**
   * O turno de trabalho terminou em erro do motor (autenticação, ou o erro do turno que não é passageiro nem foi retomado: ver `TurnCapHit` `engine`) e o card foi para Aguardar em vez de
   * revisão: não há entrega. Quem pediu o card é avisado (gestor, na conversa em que pediu; o usuário, pela caixa, que também recebe o item do erro). Some quando o card sai de Aguardar.
   * Só o servidor grava.
   */
  engineStop?: TaskEngineStop;
  /** Só na listagem (derivado, não gravado): as subtarefas do card (as de `parentTaskId` igual a este id), na ordem do quadro, as encerradas também. Ausente = sem subtarefa. */
  subtasks?: TaskSubtaskRef[];
  /** Aprovada, mas o aviso ao gestor (`requestedBy`) ficou retido: sai junto com o da última tarefa aberta dele (ver TaskService.settleRequester). */
  outcomeHeld?: boolean;
  /** Quando o aviso passou a ficar retido: depois de 2 h o tick o solta, mesmo com tarefa dele ainda aberta. */
  outcomeHeldAt?: string;
  /** O aviso ao gestor saiu e falhou (a conversa dele não abriu): o tick reenvia quando `nextAt` chegar. Junto de `outcomeHeld`. */
  outcomePending?: RetryState;
  /** A revisão automática não começou (limite de consumo, conversa fechando…): o tick tenta de novo até 30 min, e depois a tarefa é sua (ver `stuckState`). */
  reviewRetry?: RetryState & { deliveryAt: string | null; expired?: boolean };
  /**
   * Na fila do funcionário: começa sozinha quando ele terminar a tarefa atual (uma por vez, na
   * ordem do quadro).
   */
  queuedAt?: string | null;
  /**
   * Posição explícita na fila do responsável, de quem reordenou (o usuário, ou o gestor que pediu o card; ver `TaskService.reorder`): menor = antes.
   * Depois de uma reordenação todo card da fila tem uma (1, 2, 3…); o que entra depois não tem e vai para o fim, por `queuedAt`. Sai junto com a fila.
   * Só o servidor grava: nenhuma edição (tela ou API) aceita este campo.
   */
  queueRank?: number;
  /** Só na listagem (derivado, não gravado): a posição do card na fila do responsável (1 = a próxima), contando também as bloqueadas e as em espera. Ausente fora da fila. */
  queuePos?: number;
  /** Começar mesmo com o limite de consumo batido (você confirmou ao pôr na fila). */
  queuedForce?: boolean;
  /**
   * Na fila, a partida foi segurada pelo gate de recursos (ver server/resourceGate.ts) ou pela vaga de escrita do projeto (ver `BoardWriterConfig`): o motivo e desde quando. Limpo ao começar.
   * `holder`: só na espera pela vaga de escrita, o id do card que a ocupa.
   */
  resourceWait?: { reason: string; since: string; holder?: string } | null;
  /** Na fila, a partida falhou por motivo da própria tarefa (ficha, worktree, branch…): a fila segue sem ela e ela espera `nextAt` (ver `takeNext`). Limpo ao começar ou sair da fila. */
  startRetry?: RetryState;
  /** Você tirou a tarefa da fila de propósito ("tirar da fila"): a varredura do tick não a põe de volta (ver `enqueueIdle`). Sai ao entrar na fila, mudar de coluna ou de responsável. */
  unqueued?: boolean;
  /**
   * Você levou o card (que já tinha conversa) para "A fazer" pela tela: vale como ciência do corte guardado (reinício, retomada de turno ou transcript), e a vez dele
   * retoma a conversa sem a checagem de ação cortada (ver `TaskService.resumeTodo`). Só o servidor grava, e só a partir da tela; não muda o limite de consumo
   * (`queuedForce`). Sai ao usar ou quando o card muda de coluna.
   */
  cutAck?: boolean;
  /** Motivo de estar em Aguardar (opcional, texto puro, até 200 caracteres). Limpo ao sair da coluna. */
  waitReason?: string | null;
  /** Mensagens suas nesta conversa esperando o funcionário terminar outra tarefa. */
  held?: HeldMessage[];
  /**
   * Commit da entrega na worktree, feito quando ela foi para revisão. A mescla vai até aqui: o que
   * vem depois é da próxima tarefa dele, que já pode ter começado na mesma worktree.
   */
  checkpoint?: { sha: string; at: string } | null;
  /**
   * Todos os commits de entrega deste card (o mais novo é o de `checkpoint`; no máximo `CHECKPOINTS_MAX`). `checkpoint` é sobrescrito a cada entrega, e o card reprovado que entrega de novo
   * perde o commit da entrega reprovada, que segue no branch: a mescla automática (ver `TaskService.mergeSoon`) usa esta lista para saber de quem é cada commit do caminho.
   */
  checkpoints?: string[];
  /** Entrega (quando foi para revisão): o resumo da conversa e, se a ficha pediu, o porquê de cada arquivo. */
  delivery?: TaskDelivery;
  /** Dúvida do funcionário numa tarefa pedida por gestor: vai para o gestor (ou, escalada, para você). A mais recente. */
  question?: TaskQuestion;
  /** Quantas dúvidas a tarefa já levou ao gestor (no máximo 3). */
  questionCount?: number;
  /**
   * Card criado sozinho pelo Claudio’s Club: uma conversa de funcionário, sem tarefa, editou arquivo do projeto (ver
   * TaskService.onCodeEdit). Nasce em "fazendo", ligado à conversa (`sessionId`), sem `requestedBy`; vai para "revisão" quando o turno
   * termina. Ausente = tarefa comum.
   */
  autoCreated?: boolean;
  /**
   * Os arquivos que a conversa de trabalho alterou, relativos à pasta onde ela trabalha (a worktree dele ou o projeto), com "/", na
   * ordem em que foram editados: no card automático e na tarefa comum (esta é a prova de "nada editado ainda" da dúvida escalada, ver
   * `TaskPause`). Fora: o que está em `.myco/` e o que fica fora do projeto. No máximo `CHANGED_FILES_MAX`. Edição só por shell (sed,
   * node -e, scripts) não entra: o Club só vê as ferramentas de edição.
   */
  changedFiles?: string[];
  /**
   * Os arquivos de `changedFiles` que outra tarefa aberta, de OUTRA pessoa, também alterou (no mesmo momento ou depois): o diff deles pode trazer mudança da outra tarefa, e as duas
   * conversas são avisadas ("releia antes de editar e não desfaça mudança alheia"), uma vez por par de tarefas e arquivo. Mesma pessoa não conta (a fila dela já serializa), nem tarefa
   * fechada, nem quem trabalha numa worktree (a cópia dela é outra). No máximo `FILE_OVERLAPS_MAX`. Só o servidor grava.
   */
  fileOverlaps?: FileOverlap[];
  /** O aviso de `fileOverlaps` que ainda não chegou falhou ao enviar: tentativas e a próxima hora (o tick refaz). Some quando chega. Só o servidor grava. */
  overlapRetry?: RetryState;
  /**
   * O commit local que o Club fez quando a tarefa ficou pronta, com o commit automático do projeto ligado (ver `BoardCommitConfig` e server/autoCommit.ts). Ausente: ligado
   * depois, desligado, ou a tarefa ainda não ficou pronta. Só o servidor grava; nenhuma edição (tela ou API) aceita este campo.
   */
  commit?: TaskCommit;
  /**
   * O aviso de que o commit automático deixou arquivo de fora por outra tarefa (`why: 'shared'`) chegou a quem pediu (`requestedBy`): `key` é o conjunto de arquivo, motivo e tarefa que barrou,
   * e o mesmo motivo não avisa de novo. Só é gravado quando o aviso chegou. Só o servidor grava.
   */
  commitNotice?: { key: string; at: string };
  /**
   * Só na listagem e na caixa (derivado, não gravado): o estado do aviso de commit parcial (ver `CommitLeft`): `waiting` (só ciência, algum card aberto ainda toca as sobras), `ready` (decisão do
   * dono) ou `failed` (erro). Existe só com `commit.alert` ainda não ignorado (`commit.ack`: nada na tela lê o estado do aviso ignorado, e calculá-lo custa git) e enquanto alguma sobra ainda tem mudança no git.
   */
  commitLeft?: CommitLeft;
  /**
   * Só na listagem (derivado, não gravado): a dúvida da tarefa está escalada a você (`question.status === 'escalated'`) e isso decide se
   * ela prende o funcionário. Ausente = dúvida com o gestor, respondida ou sem dúvida (a fila não muda).
   */
  pause?: TaskPause;
  /**
   * Só na listagem (derivado, não gravado): a conversa que está "fazendo" caiu por falha passageira (ou o processo morreu no meio) e a retomada
   * automática está marcada. A tarefa segue em "fazendo" até lá. Some quando a retomada sai, é cancelada (Parar, mensagem sua, teto) ou esgota
   * (aí a tarefa vai para Aguardar e a caixa de entrada avisa). Ver server/chat/turnRetry.ts.
   */
  retry?: TaskRetry;
  /**
   * Só na listagem (derivado do processo da conversa de trabalho, não gravado): a tarefa está em "fazendo" ou "planejando" e a conversa espera você
   * responder um pedido de permissão (cartão `permission` pendente na conversa). Some quando você permite ou nega, ou a conversa fecha. Ausente = nada
   * pendente. Pergunta com opções não entra (o gestor a responde). Passados 15 min a tarefa conta como parada (`stuck`) e o gestor que pediu recebe um aviso.
   */
  permissionWait?: PermissionWait;
  /**
   * Só na listagem (derivado, não gravado; não confundir com `pause`, a dúvida escalada): o projeto está pausado (ver `ProjectPause`) e esta tarefa, ainda aberta, não
   * começa nem segue sozinha até ele ser retomado. Ausente = projeto rodando (ou tarefa encerrada).
   */
  projectPaused?: ProjectPause;
  /**
   * Só na listagem (derivado dos itens da caixa de entrada, não gravado): o card está parado esperando alguém agir num item da caixa que se refere a ele (ver `InboxWait`). Some sozinho
   * quando o item é resolvido, dispensado ou deixa de valer. Ausente = nada o prende (um aviso na caixa que não trava o card não conta). Com mais de um item, vale o de maior prioridade.
   */
  inboxWait?: InboxWait;
}

/**
 * O tipo do item da caixa que prende um card (`InboxWait.kind`): `plan` plano pronto para aprovar; `permission` pedido de permissão de ferramenta; `question` dúvida por opções (ou escrita, depois
 * de escalada) sem resposta; `review` revisão automática que não começou ou ficou sem veredito; `resend` ajuste guardado que não chega ao funcionário; `noCode` card que terminou sem editar
 * código, esperando decisão; `blocked` o card espera outra tarefa empacada (`blockerId`). Não prendem (só avisam): cartão esquecido em "a fazer" (`notStarted`), follow-up de revisão, ação barrada (`denied`),
 * erro (commit automático, fila desligada, teto do turno, sandbox), segredo, sessão esperando em outro lugar (`waiting`), processo órfão, rotina, consumo, e as paradas que se resolvem sozinhas
 * (espera do limite do motor, dúvida a caminho do gestor).
 */
export type InboxWaitKind = 'plan' | 'permission' | 'question' | 'review' | 'resend' | 'noCode' | 'blocked';

/** Por que um card está parado esperando a caixa de entrada (`Task.inboxWait`). Sem texto livre: a tela monta a frase no idioma da página a partir de `kind`. */
export interface InboxWait {
  kind: InboxWaitKind;
  /** De quem é a ação: `owner` o dono (você), pela caixa; `manager` o gestor (ou o revisor que reprovou), que responde a dúvida por opções antes de ela escalar a você. */
  by: 'owner' | 'manager';
  /** O `InboxItem.id` do item que o prende, para a tela abri-lo na caixa. */
  itemId: string;
  /** Desde quando o item espera (ISO; o `at` do item, ou a última mudança do card se o item não tem hora). */
  since: string;
  /** Só em `blocked`: a tarefa empacada que ele espera. */
  blockerId?: string;
}

/** A permissão que a conversa de uma tarefa espera de você (`Task.permissionWait`). Só o nome da ferramenta: o comando e os arquivos ficam no cartão da conversa. */
export interface PermissionWait {
  /** A ferramenta que pediu (a mais antiga, se houver mais de uma pendente). */
  tool: string;
  /** Desde quando o pedido espera (ISO). */
  since: string;
  /** Passou o prazo (15 min): a tarefa conta como parada. Calculado na leitura; o motivo em pt-BR sai em `stuckState` (server/tasks.ts). */
  stuck: boolean;
}

/**
 * A marca "sem código" de um card (`Task.noCode`). O aviso vai a quem pediu o card (`to`): o gestor, na conversa em que pediu, ou o usuário, pelo item 'stuck' da caixa
 * (`InboxItem.stuck.noCode`), quando o card foi pedido por ele, o gestor saiu do projeto ou o aviso a ele não chegou em 30 min (`escalatedAt`).
 */
export interface TaskBackgroundWait {
  /** Quando o primeiro fim de turno achou o segundo plano pendente (ISO): o prazo conta daqui. */
  since: string;
  /** Os ids do que rodava em segundo plano (`BackgroundTask.id`): o que sobrar de outro conjunto é segundo plano novo, e o prazo recomeça. */
  ids: string[];
  /** O que rodava, em uma linha (rótulo do primeiro item, até 120 caracteres): texto da conversa, a tela o mostra como texto puro. */
  label: string;
  /** Quando o prazo venceu e o card deixou de esperar (ISO). Enquanto o mesmo segundo plano seguir pendente, não espera de novo. */
  expiredAt?: string;
}

export interface TaskNoCode {
  /** Quando o turno terminou sem edição (ISO). */
  since: string;
  /** O que o responsável disse ao terminar (até 1500 caracteres): é dele, e a tela o mostra como texto puro. A análise ou a resposta pode estar aqui. */
  summary?: string;
  /** Quem recebe o aviso: o gestor que pediu o card (`Task.requestedBy`) ou o usuário (caixa). */
  to: 'manager' | 'owner';
  /** Quando o aviso chegou à conversa do gestor (ISO). Ausente com `to: 'owner'` e enquanto não chegou. */
  deliveredAt?: string;
  /** O aviso ao gestor ainda não chegou (conversa fechando, limite de consumo…): tentativas e a próxima (backoff); o tick refaz. Some ao entregar ou ao ir para o usuário. */
  notifyRetry?: RetryState;
  /** Quando o aviso ao gestor foi dado como perdido e o card passou a `to: 'owner'` (ISO). */
  escalatedAt?: string;
}

/** A mescla automática de uma entrega aprovada (`Task.autoMerge`). */
export interface TaskAutoMerge {
  /** A revisão (conversa) e a entrega (`delivery.at`) que o revisor aprovou. */
  verdict: { sessionId: string; deliveryAt: string | null };
  /** O commit da entrega (`checkpoint.sha`): a mescla vai até ele. Null: a entrega não tem commit, e a mescla é recusada (nunca leva o branch inteiro). */
  sha: string | null;
  /** O nome de quem aprovou. */
  by: string;
  since: string;
  /** Desde quando a mescla toca o checkout principal (gravado ANTES de mexer): se o processo cair no meio, o reinício vê o marcador sem execução viva e desfaz o que ficou pela metade. */
  merging?: string;
  /** Esperando para tentar de novo: o motivo, e quando; `retry` só conta as falhas que se repetem (principal sujo, testes cortados no tempo), com teto. */
  wait?: { why: 'open-card' | 'main-dirty' | 'retry'; detail: string; since: string };
  retry?: RetryState;
  /** A mescla automática parou e só o dono segue (mescla pelo card): o motivo e quando. */
  stopped?: { detail: string; at: string };
  /**
   * O pedido é do DONO ("Aprovar entrega" num card de worktree por card): vale sem veredito de revisão nem a política de conclusão por IA, e a junção que não pôde rodar (principal sujo nos arquivos
   * do card, testes cortados) espera aqui, com o motivo em `wait`, e roda sozinha depois; `verdict` é só o da revisão que havia (pode não existir).
   */
  byOwner?: true;
}

/** A espera pela aprovação do dono (`Task.ownerGate`). */
export interface TaskOwnerGate {
  /** A entrega (`Task.delivery.at`) a que a espera pertence; null = a tarefa não tinha entrega gravada. */
  deliveryAt: string | null;
  /** Quando a espera começou (ISO). */
  since: string;
  /** 'approved': o revisor aprovou e falta o dono; 'no-reviewer': a política manda a IA concluir e não há revisor configurado. */
  why: 'approved' | 'no-reviewer';
  /** O nome de quem aprovou (com `why: 'approved'`). */
  by?: string;
}

/** O plano que espera decisão (`Task.planWait`). */
export interface TaskPlanWait {
  /** Quando o plano foi entregue (ISO); também identifica esta espera (a decisão só vale para ela). */
  since: string;
  /** O plano, como o responsável o escreveu ao terminar o turno (Markdown, até 8000 caracteres): é dele, e a tela o mostra como texto. */
  text: string;
  /** Quem decide: o gestor que pediu o card (`Task.requestedBy`) ou o usuário (caixa). */
  to: 'manager' | 'owner';
  /** Quando o aviso chegou à conversa do gestor (ISO). Ausente com `to: 'owner'` e enquanto não chegou. */
  deliveredAt?: string;
  /** O aviso ao gestor ainda não chegou (conversa fechando, limite de consumo…): tentativas e a próxima (backoff); o tick refaz. Some ao entregar ou ao ir para o usuário. */
  notifyRetry?: RetryState;
  /** Quando o aviso ao gestor foi dado como perdido e o plano passou a `to: 'owner'` (ISO). */
  escalatedAt?: string;
  /**
   * O plano veio pelo cartão ExitPlanMode da conversa (ficha `plan`, Claude; ver `TaskService.onPlan`): o id do pedido pendente (`requestId`). O processo está vivo esperando o cartão,
   * então o card segue ocupando o funcionário, e quem decide (a rota `/plan`) responde o cartão. Decidir pelo cartão da conversa também encerra esta espera. Ausente: o plano é o fim de turno
   * (ficha que edita) e a decisão vai como mensagem.
   */
  card?: string;
}

/** A parada do card por erro do motor (`Task.engineStop`). `why`/`engine`/`error` são os do `TurnCapHit` `engine` que o originou. */
export interface TaskEngineStop {
  /** Quando o turno terminou em erro (ISO). */
  since: string;
  why: 'auth' | 'error';
  engine: 'claude' | 'codex';
  /** O erro como o motor o deu (até 200 caracteres): texto do motor, não do funcionário. */
  error: string;
  /** Quando o aviso chegou à conversa de quem pediu (ISO). Ausente enquanto não chegou, e quando o card foi pedido pelo usuário (a caixa dele já mostra o erro). */
  deliveredAt?: string;
  /** O aviso a quem pediu ainda não chegou: tentativas e a próxima (backoff); o tick refaz até chegar ou passar 30 min. Some ao entregar ou ao desistir. */
  notifyRetry?: RetryState;
}

/** Uma subtarefa de um card (`Task.subtasks`): o que a tela precisa para mostrar "aguardando subtarefas" (aberta = `status` fora de 'done' e 'cancelled', ver `isClosed`). */
export interface TaskSubtaskRef {
  id: string;
  title: string;
  status: TaskStatus;
  /** Quem faz; null = sem responsável. */
  staffId: string | null;
}

/**
 * O pedido de cancelamento de uma tarefa que já começou (`Task.cancelRequest`). Quem pediu a tarefa (`by`, sempre o dono do token) manda o pedido com
 * o motivo; ele chega na conversa do responsável, que decide: aceita cancelando a tarefa (`POST .../cancel`, `status` vira 'accepted') ou recusa dizendo
 * por quê (`POST .../cancel-request/refuse`, `status` vira 'refused', `answer` guarda o porquê e o solicitante é avisado). Cancelar a tarefa pela tela
 * também fecha o pedido como 'accepted' (`decidedBy: 'user'`).
 */
export interface CancelRequest {
  /** Quem pediu: o id do funcionário (= `Task.requestedBy`). */
  by: string;
  /** Por quê (uma linha, até 300 caracteres). */
  reason: string;
  /** Quando pediu (ISO). */
  at: string;
  /**
   * pending: esperando a decisão do responsável; accepted: a tarefa foi cancelada; refused: o responsável recusou (veja `answer`); moot: a tarefa ficou
   * pronta sem decisão (não há mais o que cancelar).
   */
  status: 'pending' | 'accepted' | 'refused' | 'moot';
  /** Quando chegou à conversa do responsável (ISO). Ausente = ainda não chegou: o tick tenta de novo (ver `retry` e `waiting`). */
  deliveredAt?: string;
  /** A conversa em que chegou. Se a tarefa trocar de conversa (troca de motor) ou o servidor reiniciar com o pedido ainda aberto, ele é entregue de novo. */
  deliveredSession?: string;
  /** Ainda não entregue porque o responsável está em outra tarefa (o pedido espera a vez dele; em pt-BR, ex.: "Ana está em “Exportar CSV”"). Limpo ao entregar. */
  waiting?: string;
  /** A entrega falhou (limite de consumo, conversa fechando…): tentativas e a próxima (backoff). Limpo ao entregar. */
  retry?: RetryState;
  /** Quando foi decidido (ISO). */
  decidedAt?: string;
  /** Quem decidiu: o id do responsável, ou 'user' (a tarefa foi cancelada pela tela). */
  decidedBy?: string;
  /** Só em 'refused': o porquê da recusa (uma linha, até 300 caracteres). */
  answer?: string;
  /** Só em 'refused': o aviso da recusa ao solicitante não chegou; o tick reenvia com backoff. Ausente = avisado. */
  notifyRetry?: RetryState;
}

/**
 * O ajuste de acompanhamento de uma tarefa (`Task.followUps`): o achado e o plano que o revisor (ou o responsável) deixou DEPOIS de aprovar, sem poder criar card
 * (só gestor passa trabalho). É gravado na tarefa ANTES de qualquer aviso, e o aviso vai a quem decide (`to`): o gestor que pediu a tarefa, na conversa em que pediu, ou o
 * usuário (item 'followUp' da caixa) quando ela foi pedida por ele ou o gestor não pode receber. Quem decide cria o card em um passo (`POST .../followup/:fid/card`, que também
 * marca `resolution: 'card'` e `cardId`), ou pelo fluxo de sempre e marca o `resolve`, ou descarta; nada vira card sozinho. Quem decide é quem pediu a tarefa (`Task.requestedBy`) ou o usuário: o autor que não pediu não decide, mas o gestor que pediu
 * e também revisou a tarefa (`by` igual a `requestedBy`) decide o próprio follow-up (e não recebe aviso: ver `deliveredAt`). O `text` é de outro funcionário e vai à conversa de
 * quem decide como dado, não como instrução (ver `untrustedBlock` em server/tasks.ts).
 */
export interface FollowUp {
  /** `f-` + 6 hex, único na tarefa. */
  id: string;
  /** Quem registrou: o id do funcionário, sempre o dono do token (nunca o corpo do pedido). */
  by: string;
  /** Quando registrou (ISO). */
  at: string;
  /** O achado e o plano, texto puro (até 4000 caracteres): o detalhe técnico. */
  text: string;
  /**
   * Os campos estruturados que o revisor preenche ao registrar (todos opcionais: follow-up antigo, e o de quem não os mandou, não os tem e segue válido; a tela cai no
   * `text`). `recommendation`: `worth` (vale fazer) ou `optional`. `title`: o assunto em linguagem leiga, uma linha (até 120 caracteres). `impact`: o que acontece se não for
   * feito, em linguagem de usuário (até 400). `size`: `small`, `medium` ou `large`. `staffId`: quem faria (funcionário do projeto; vira o responsável sugerido do card).
   */
  recommendation?: 'worth' | 'optional';
  title?: string;
  impact?: string;
  size?: 'small' | 'medium' | 'large';
  staffId?: string;
  /** open: esperando a decisão; resolved: virou card ou foi descartado (ver `resolution`). */
  status: 'open' | 'resolved';
  /**
   * Quem recebe o aviso. manager: o gestor que pediu a tarefa (`Task.requestedBy`), na conversa em que pediu; owner: o usuário, pelo item 'followUp' da caixa
   * (a tarefa foi pedida por ele, ou o gestor saiu do projeto, ou o aviso a ele não chegou em 30 min: `escalatedAt`).
   */
  to: 'manager' | 'owner';
  /** Quando o aviso chegou à conversa do gestor (ISO). Quem registra o que ele mesmo pediu não recebe aviso: vale `at`. Ausente com `to: 'owner'` e se ainda não chegou. */
  deliveredAt?: string;
  /** O aviso ao gestor ainda não chegou (conversa fechando, limite de consumo…): tentativas e a próxima (backoff); o tick refaz. Some ao entregar ou ao ir para o usuário. */
  notifyRetry?: RetryState;
  /** Quando o aviso ao gestor foi dado como perdido e o follow-up passou a `to: 'owner'` (ISO). */
  escalatedAt?: string;
  /** Só em `resolved`: virou um card (`cardId` é a tarefa nova) ou foi descartado. */
  resolution?: 'card' | 'discarded';
  /** Quando foi decidido (ISO). */
  resolvedAt?: string;
  /** Quem decidiu: o id do gestor, ou 'you' (o usuário, pela tela). */
  resolvedBy?: string;
  /** O card criado a partir dele (`resolution: 'card'`; opcional se o decisor não disse qual). */
  cardId?: string;
  /** O porquê do descarte (uma linha, até 300 caracteres; opcional). */
  note?: string;
  /** Chave de idempotência do POST que o registrou e a impressão do texto (por autor, dentro da tarefa): a mesma chave com o mesmo texto devolve este registro; com outro, 409. */
  key?: string;
  hash?: string;
}

/** O que `POST .../followup` devolve: o registro, e `idempotentReplay` quando o pedido repetiu uma chave já usada com o mesmo texto (nada foi gravado nem avisado de novo). */
export interface FollowUpResult extends FollowUp {
  taskId: string;
  idempotentReplay?: true;
}

/**
 * O que `POST .../tasks/:id/followup/:fid/card` devolve: o card criado e o follow-up já resolvido (`resolution: 'card'`, `cardId`). `idempotentReplay`: o follow-up já tinha virado
 * card e esta é a resposta de antes (nada foi criado nem gravado de novo). `task.startError` (só com `start: true`): o começo falhou depois de o card ser gravado; a fila o retoma
 * sozinha e o card não deve ser criado de novo.
 */
export interface FollowUpCardResult {
  task: Task & { startError?: string };
  followUp: FollowUpResult;
  idempotentReplay?: true;
}

/** Aviso na resposta de criar a tarefa (ver `TaskCreateResult`). */
export interface TaskCreateWarning {
  /** `possible-duplicate`: o mesmo solicitante passou há pouco uma tarefa de título parecido ao mesmo responsável. A tarefa foi criada mesmo assim. */
  code: 'possible-duplicate';
  /** O aviso em pt-BR, com o que fazer. */
  message: string;
  /** A tarefa parecida. */
  taskId: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
}

/**
 * O que `POST .../tasks` devolve: a tarefa, com campos que só existem nesta resposta (derivados, nunca gravados). Responde 200 mesmo quando o começo
 * falhou, desde que a tarefa tenha sido gravada: quem recebe nunca deve criar de novo.
 */
export interface TaskCreateResult extends Task {
  /** `true`: o pedido repetiu uma `idempotencyKey` já usada com o mesmo conteúdo; esta é a tarefa de antes (nada foi criado nem começado de novo). */
  idempotentReplay?: true;
  /** Possíveis duplicatas (só aviso). Ausente = nenhuma. Nunca presente em `idempotentReplay`. */
  warnings?: TaskCreateWarning[];
  /** O começo falhou depois de a tarefa ser gravada (esta resposta é a tarefa gravada): o motivo. A fila a retoma sozinha; não crie outra. */
  startError?: string;
}

/** A retomada automática marcada para a conversa da tarefa (`Task.retry`). */
export interface TaskRetry {
  /** A tentativa que vai sair (1 a `max`) e o teto do turno (3 para erro passageiro, 1 para processo que caiu sem causa). */
  attempt: number;
  max: number;
  /** Quando a mensagem de retomada sai (ISO). Passou da hora e ainda aparece: o envio está em curso, ou a linha de parada de consumo adiou. */
  at: string;
  /** `transient`: erro passageiro do modelo; `unknown`: o processo caiu sem causa conhecida. */
  kind: 'transient' | 'unknown';
  /** O motivo em poucas palavras, em português ("API sobrecarregada", "o processo caiu sem aviso"). */
  error: string;
}

/**
 * O que a dúvida escalada a você faz com a fila do funcionário (`Task.pause`). `released`: nada foi editado (sem `changedFiles` nem
 * `checkpoint`), então a tarefa espera a sua resposta sem ocupá-lo e a próxima da fila dele começa; a tela mostra "pausada esperando você;
 * <nome> seguiu para <tarefa>" (`movedTo`). `holding`: já há edição, ele fica nesta tarefa até você responder. Ter worktree não muda
 * nada (ela é do funcionário, não da tarefa). Quando a sua resposta chega com ele em outra tarefa, ela fica guardada em `Task.held` e
 * vai antes da próxima da fila, quando ele ficar livre.
 */
export interface TaskPause {
  state: 'released' | 'holding';
  /** Em pt-BR, para mostrar como está ("dúvida com edição em andamento"). */
  reason: string;
  /** Desde quando a dúvida está com você (`question.escalatedAt`). */
  since: string;
  /** Só em `released`: a tarefa em que o funcionário está agora; null = nenhuma (está livre ou a fila dele está vazia). */
  movedTo: { id: string; title: string } | null;
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
  /** O envio ao gestor ainda não deu certo (sem `managerSession`): o tick tenta de novo com backoff. Continua depois de escalada. */
  pending?: RetryState;
  /** Quando a dúvida foi para você (sem resposta do gestor no prazo, ou ele recusou, ou o envio não tinha como dar certo). */
  escalatedAt?: string;
  /** Conversa nova do gestor em que a dúvida chegou. */
  managerSession?: string;
  answeredBy?: 'manager' | 'user';
  answeredAt?: string;
  /** Resumo curto da resposta. */
  answer?: string;
  /**
   * `reviewer`: a dúvida é sobre um 🔴 da última reprovação e vai ao revisor que reprovou (`reviewerId`), não a quem pediu a tarefa (ver `Rejection` e `doubtHeld`).
   * Ausente = vai a quem pediu (`requestedBy`). Só o servidor grava.
   */
  to?: 'reviewer';
  reviewerId?: string;
}

/** Um 🔴 da reprovação, de uma linha do bloco `[BLOQUEADORES]` do revisor (ver server/reviewBlockers.ts). `id` (R1, R2…) é o mesmo de uma rodada à outra enquanto o item segue aberto. */
export interface ReviewBlocker {
  id: string;
  /** arquivo:linha */
  where: string;
  problem: string;
  /** Como provar que foi corrigido. */
  proof: string;
}

/**
 * Uma reprovação da revisão (ver `TaskService.reject`): os 🔴, a resposta do executor e a quem a dúvida sobre eles vai. Fica no card (sobrevive a reinício) para o pedido
 * da rodada seguinte levar o que o revisor pediu e o que o executor respondeu. Mais antigas primeiro, no máximo 10. Só o servidor grava.
 */
export interface Rejection {
  /** 1 = a primeira reprovação do card (`reworkRounds` + 1 na hora). */
  round: number;
  at: string;
  /** `delivery.at` da entrega que foi reprovada: a resposta do executor é a da entrega seguinte a ela. */
  deliveryAt: string | null;
  reviewer: { staffId: string; name: string; sessionId: string };
  /** Como veio o bloco de bloqueadores: `ok` (os `blockers`); `absent` ou `malformed` (o texto do revisor segue cru, em `raw`). */
  block: 'ok' | 'absent' | 'malformed';
  blockers: ReviewBlocker[];
  /** Por que o bloco veio malformado, ou o que não bateu (id reaproveitado). */
  warnings?: string[];
  /** Só sem bloco válido: o texto do revisor que foi ao executor (a parte sem 🔴 pode ter sido cortada). */
  raw?: string;
  /** A resposta do executor, ao fim do turno que seguiu a reprovação (a entrega seguinte). `cited`: os ids Rn que ela cita, lidos antes do corte. */
  reply?: { at: string; text: string; cut?: true; cited: string[] };
}

export interface TaskDelivery {
  at: string;
  /** Última mensagem do funcionário; passando de 2500 caracteres, cortada em fim de linha com uma marca de corte no fim. */
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
  /** Envios que falharam (limite de consumo, conversa fechada…). Com 5, deixa de ir sozinha e a tarefa fica parada (ver `stuckState`). */
  attempts?: number;
  /** Próxima tentativa (backoff com jitter); antes disso a fila não a manda. */
  nextAt?: string;
  /**
   * Resposta sua (ou do gestor) a uma pergunta por opções que ficou pendente na conversa enquanto o funcionário estava em outra tarefa:
   * quando a mensagem vai, ela responde a pergunta (`requestId`); se a pergunta já não está pendente (a conversa reabriu), `text` segue
   * como mensagem comum.
   */
  ask?: { requestId: string; answers: Record<string, string | string[]>; by: 'manager' | 'user' };
  /** É a resposta à dúvida escalada (texto ou opções): só ela deixa a tarefa parada sem ocupar o funcionário (ver `parked` em server/tasks.ts). */
  doubt?: true;
  /** Veio de um funcionário ou de uma decisão automática (reprovação da revisão, resposta do gestor, mensagem de outro funcionário), não de você: com o projeto pausado ela espera (ver `ProjectPause`); a sua segue. */
  auto?: true;
}

/** Pendência de uma tentativa que falhou e vai ser repetida (ver server/retryPolicy.ts): quantas já foram, a próxima, a primeira e o último erro. */
export interface RetryState {
  attempts: number;
  nextAt: string;
  firstAt: string;
  lastError?: string;
}

/** O que só você resolve numa tarefa parada (ver `stuckState` em server/tasks.ts): responder a dúvida, revisar, reenviar o ajuste ou decidir. */
export type HumanAction = 'answer' | 'review' | 'resend' | 'decide';

/** Progresso do kanban: pontos ganhos sobre o máximo, 3 por tarefa na conta (ver shared/kanbanProgress.ts). */
export interface TaskProgress {
  points: number;
  max: number;
}

/**
 * Projeto pausado (ver server/projectPause.ts): nada de execução começa sozinho nele (fila, ajuste da reprovação, rotinas, despertador, "continue", retomada do reinício, troca de
 * motor); a revisão automática da entrega já feita roda. O que já roda termina o turno e para; as suas ações manuais (chat, mover cartão, "Começar") seguem. Só você pausa e despausa, pelo navegador.
 */
export interface ProjectPause {
  /** Quando pausou (ISO). */
  at: string;
  /**
   * Ausente = pausa comum. `version` = pausa de versão (montar uma versão do working tree compartilhado): nada novo começa (fila, início de tarefa, rotinas, "continue", despertador,
   * órfãs, troca de motor), mas o que já está em voo termina (turno, revisão da entrega e o ajuste de um card já em fazendo, planejando ou revisão, como a reprovação). Sai sozinha em `until`.
   */
  mode?: 'version';
  /** Só na pausa de versão: até quando (ISO); passado esse horário o projeto volta ao normal sozinho. */
  until?: string;
  /** Só na pausa de versão: quem ligou (funcionário com `canRelease`); ausente = você, pela tela. */
  by?: { staffId: string; name: string };
}

/**
 * O que a fila de um funcionário faz agora (`GET /api/projects/:id/queues`, ver `TaskService.queueStates`). Na ordem em que vale quando mais de um é verdade: `paused` (o projeto
 * está pausado), `busy` (ele trabalha num card ou numa conversa), `resource-wait` (o gate de recursos segurou a partida), `usage-limit` (a trava de consumo barra o motor dele),
 * `delivering` (uma entrega dele ainda está sendo processada), `heavy-wait` (essa entrega espera a vez da suíte de testes: outra validação pesada roda na máquina) e `free`.
 * `delivering` e `heavy-wait` só aparecem com ele sem card em andamento: se ele já pegou o próximo, o estado é `busy` e a entrega segue em `deliveries`.
 * `busy` sem `taskId` é um turno rodando numa conversa sem card; conversa aberta sem turno (só segundo plano, ou parada) não é `busy` (ver `StaffQueue.column` para onde cai no quadro).
 */
export type QueueState = 'free' | 'busy' | 'delivering' | 'heavy-wait' | 'resource-wait' | 'usage-limit' | 'paused';

/**
 * O que a entrega de uma tarefa faz agora, depois de o card ir para revisão: `saving` (resumo e commit, ainda na vez do funcionário: a fila dele espera), `tests` (rodando a suíte), `heavy-wait`
 * (a suíte espera a vez: outra validação pesada roda na máquina), `notice` (o aviso a quem pediu) e `review` (o pedido da revisão). Só `saving` segura a fila; as outras seguem em paralelo.
 */
export type DeliveryPhase = 'saving' | 'tests' | 'heavy-wait' | 'notice' | 'review';

/** Uma entrega em processamento de um funcionário (ver `DeliveryPhase`). */
export interface QueueDelivery {
  taskId: string;
  phase: DeliveryPhase;
  /** Desde quando a entrega está nesta fase (ISO). */
  since: string;
  /** Desde quando a entrega está em processamento (ISO): o card foi para revisão. */
  startedAt: string;
  /** Em `heavy-wait`: o nome de quem segura a fila da suíte agora. */
  holder?: string;
}

/** A coluna do quadro em que o que o funcionário faz agora cai (ver `StaffQueue.column`): "Fazendo", "Revisão" ou "A fazer". */
export type QueueColumn = 'doing' | 'review' | 'todo';

/** Uma revisão que o funcionário conduz com o turno rodando agora: o card em Revisão e desde quando o pedido foi feito (ISO). */
export interface QueueReview {
  taskId: string;
  since: string;
}

/** O card que a fila de um funcionário espera (`StaffQueue.waitingOn`): quem o faz e quantos outros cards da fila dele esperam também. */
export interface QueueWait {
  /** O card esperado (`blockedBy` ainda aberto) do primeiro card da fila dele. */
  taskId: string;
  /** O título dele, curto. */
  title: string;
  /** Quem faz o card esperado; ausente se ele não tem responsável. */
  staffId?: string;
  /** Quantos outros cards da fila dele também esperam outro card (0 = só o primeiro). */
  more: number;
}

/** A fila de um funcionário: o estado (ver `QueueState`), o card que o explica, desde quando e o que mais importa dele. */
export interface StaffQueue {
  staffId: string;
  state: QueueState;
  /**
   * Onde ele está de fato ocupado, para as bolinhas do quadro (o `state` diz o que a FILA faz; isto, o que ELE faz): `doing` = um turno de card dele roda (`taskId`); `todo` = parado em
   * "A fazer" por um motivo (`resource-wait`, `usage-limit`, ou todos os cards da fila esperando outro card, ver `waitingOn`); `review` = só revisa (`state: 'free'`, `taskId` = o card
   * em Revisão); `null` = nada em coluna nenhuma: livre, conversa sem card, conversa aberta sem turno rodando, ou entrega que o Club processa (`delivering`, `heavy-wait`: não é turno dele).
   * Ausente: servidor sem este campo (quem lê cai no `state`).
   */
  column?: QueueColumn | null;
  /** As revisões que ele conduz com o turno rodando agora (a lista completa de Revisão, também quando `column` é outra). Ausente = nenhuma. */
  reviewing?: QueueReview[];
  /** Em `column: 'todo'` por dependência: o card que a fila dele espera. O motivo em palavras vai em `detail`. */
  waitingOn?: QueueWait;
  /** O card que explica o estado: o que ele faz (`busy`), a que espera (`resource-wait`, `usage-limit`) ou o que entrega (`delivering`, `heavy-wait`). */
  taskId?: string;
  /** Desde quando está assim (ISO), quando o estado tem começo conhecido: o card entrou em andamento, a espera começou, a entrega começou (`delivering`) ou a suíte começou a esperar (`heavy-wait`). */
  since?: string;
  /** Em `delivering` e `heavy-wait`: a fase da entrega que explica o estado. */
  phase?: DeliveryPhase;
  /** O motivo em palavras: o do gate de recursos, a linha de parada de consumo, quem segura a suíte. */
  detail?: string;
  /** Quantos cards ele tem na fila ("a fazer"), de qualquer ordem. */
  queued: number;
  /** As entregas dele em processamento agora (a mais antiga primeiro), também quando o estado é outro (ele já pegou o próximo card). */
  deliveries: QueueDelivery[];
}

/** Tarefas de um projeto para o cabeçalho: abertas (tudo que não está encerrado: nem pronto nem cancelado) e em revisão. */
export interface TaskSummary {
  open: number;
  review: number;
  /** Progresso do kanban (a barra do cabeçalho); ausente num servidor antigo, e nesse caso a barra some. */
  progress?: TaskProgress | null;
  /** O projeto está pausado (ver `ProjectPause`): presente só então, também com `open` em 0. Ausente = rodando. */
  paused?: ProjectPause;
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
  /** Revisão automática sem veredito (ou revisor que não respondeu): quando re-pedir; depois de `reasked`, quando foi re-pedido. */
  reaskAt?: string;
  /** O re-pedido ("responda com APROVADO ou REPROVADO") já foi feito, uma vez só. */
  reasked?: boolean;
  /** A tarefa foi entregue de novo depois deste pedido: é de uma rodada anterior e não decide mais nada (fica só no histórico). */
  superseded?: boolean;
}

/** Uma conversa que foi da tarefa: o trabalho, a revisão ou a dúvida ao gestor. `staffId` é quem conversa nela. */
export interface TaskSession {
  id: string;
  role: 'work' | 'review' | 'question';
  staffId: string | null;
  engine: Engine;
  at: string;
}

export interface TestRun {
  command: string;
  ok: boolean;
  /** Fim da saída (até ~6 mil caracteres). */
  output: string;
  ms: number;
  at: string;
  /** Quantos arquivos de teste rodaram (a linha "Test Files" do vitest); ausente se a saída não é a do vitest. */
  files?: number;
  /** Os arquivos de teste com falha e quantas falhas cada um teve, lidos da saída inteira (não só do fim); ausente se não deu para ler. */
  failedFiles?: TestFailedFile[];
  /** A nova rodada só dos arquivos que falharam (ver `isolateFailures`); só na validação da entrega. */
  isolated?: TestIsolation;
  /**
   * A rodada foi cortada no tempo-limite (`limitMs`) sem terminar: `ok` é false, mas NÃO é falha de teste, e o resultado não diz nada sobre o código.
   * Ausente = a suíte terminou (passou ou falhou). Quem mostra o resultado separa "tempo esgotado" de "falhou".
   */
  timedOut?: boolean;
  /** O tempo-limite que valia, em ms; vem junto com `timedOut`. */
  limitMs?: number;
}

export interface TestFailedFile {
  file: string;
  failed: number;
}

/** O resultado de rodar de novo, uma vez, só os arquivos que falharam na suíte. */
export interface TestIsolation {
  /** O comando da nova rodada; ausente se ela não rodou (`skipped`). */
  command?: string;
  ms?: number;
  /** Por que não rodou. */
  skipped?: string;
  files: TestIsolatedFile[];
}

export interface TestIsolatedFile {
  file: string;
  /** Falhas na suíte inteira. */
  failed: number;
  /** `pass`: passou isolado; `fail`: falhou de novo; `unknown`: sem resultado (não rodou ou a rodada não terminou). */
  status: 'pass' | 'fail' | 'unknown';
  /** Falhas isoladas (só em `fail`). */
  isolatedFailed?: number;
  /** Em `fail`: o arquivo da entrega que ele é ou importa (direta ou indiretamente); ausente = não toca a entrega (ou a tarefa não tem lista de arquivos). */
  touches?: string;
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

/** Última vez que uma rotina rodou (ou foi pulada), por `<projeto>:<ficha>:<rotina>`. Inclui o "Rodar agora". */
export interface RoutineRun {
  at: string;
  ok: boolean;
  text: string;
}

/**
 * O que aconteceu com uma ocorrência prevista: `ran` (começou), `failed` (pulada ou erro: `text` diz o porquê), `discarded` (perdida e
 * fora do limite de atraso, ou superada por uma mais recente), `uncertain` (o Claudio’s Club caiu depois de reservar o horário e antes
 * de terminar: não se sabe se começou, e ele não tenta de novo sozinho).
 */
export type RoutineOutcomeState = 'ran' | 'failed' | 'discarded' | 'uncertain';

/** Uma linha do histórico da rotina (as `ROUTINE_HISTORY_MAX` mais recentes). */
export interface RoutineHistoryEntry {
  state: RoutineOutcomeState;
  /** Horário previsto (ISO). Em descarte em lote, o da mais recente descartada. No "Rodar agora": a hora em que rodou. */
  due: string;
  /** Descarte em lote: o horário previsto da mais antiga descartada. */
  from?: string;
  /** Quantas ocorrências a linha cobre (descarte em lote); ausente = 1. Com `more`, são pelo menos tantas. */
  count?: number;
  more?: true;
  /** Quando o servidor tratou (ISO). */
  at: string;
  text: string;
  /** Execução atrasada: minutos entre o horário previsto e a partida. */
  lateMin?: number;
  /** "Rodar agora": não é ocorrência prevista e não mexe no que já foi tratado. */
  manual?: true;
}

/** Uma rotina de um funcionário do projeto, como a tela central a vê (`GET /api/projects/:pid/schedules`). */
export interface RoutineSchedule {
  projectId: string;
  staffId: string;
  staffName: string;
  routineId: string;
  name: string;
  message: string;
  mode: Routine['mode'];
  enabled: boolean;
  /** Já resolvida: ficha antiga com `schedule` cron vem como `{ kind: 'cron', expr }`. */
  recurrence: Recurrence;
  /** Texto curto em português ("a cada 2 semanas (seg, qua) às 09:00"). */
  description: string;
  /** Recorrência que não dá para ler (ficha editada à mão): o motivo; a rotina não roda e não tem ocorrências. */
  invalid: string | null;
  /** 0 = execução atrasada desligada. */
  catchUpHours: number;
  /** Próxima ocorrência (ISO); null se desligada, inválida ou sem mais nenhuma. */
  next: string | null;
  /** Desde quando vale (ISO): ocorrências anteriores não existem para esta rotina (criação, edição da recorrência ou ativação). */
  armedAt: string | null;
  /** Reservou um horário e ainda não terminou de rodar (horário previsto, ISO). */
  inFlight: string | null;
  /** Última execução, inclusive "Rodar agora". */
  last: RoutineRun | null;
  /** Mais recente primeiro. */
  history: RoutineHistoryEntry[];
}

/** Uma ocorrência no calendário. `upcoming` = ainda por vir; `unknown` = passada que o histórico (limitado) já não lembra. */
export interface RoutineOccurrence {
  staffId: string;
  routineId: string;
  /** ISO. */
  at: string;
  state: RoutineOutcomeState | 'upcoming' | 'unknown';
}

/** Despertador ou "continue" do limite de uso pendente (só listados; este fluxo é de `ChatManager`, ver `listSchedules`). */
export interface ScheduleItem {
  kind: 'wake' | 'continue';
  sessionId: string;
  /** null = conversa sem ficha (Freela). */
  staffId: string | null;
  at: string;
  text: string;
}

/**
 * Resposta de `GET /api/projects/:pid/schedules?from=<ISO>&to=<ISO>` (só pelo Claudio’s Club). `items` é o que sempre veio;
 * `routines` são TODAS as rotinas das fichas do projeto (ligadas ou não); `occurrences`, as das rotinas ligadas dentro da janela
 * [from, to) (sem `from`/`to`: do começo de hoje até 31 dias depois; máximo `SCHEDULE_WINDOW_MAX_DAYS`, senão 400).
 * `window.truncated`: passou do teto de ocorrências (500 por rotina, 5000 no total) e a lista ficou incompleta.
 * `stateWarning`: o arquivo de estado das rotinas estava corrompido e recomeçou (nada foi repetido, mas atrasos antigos não voltam).
 */
export interface SchedulesResponse {
  items: ScheduleItem[];
  routines: RoutineSchedule[];
  occurrences: RoutineOccurrence[];
  window: { from: string; to: string; truncated: boolean };
  stateWarning: string | null;
}

/**
 * Acesso de um MCP na ficha (`StaffProfile.mcpAccess`, chave = nome do MCP). Da mais solta para a mais fechada: `free` (sem regra,
 * segue a autonomia), `ask` (só as de leitura passam; o resto pede antes), `readonly` (só as de leitura passam; o resto é bloqueado),
 * `off` (o MCP inteiro fica de fora). No Codex, `ask` vira `readonly` (não há como perguntar). Ver server/staff/mcpAccess.ts.
 */
export type McpAccess = 'off' | 'readonly' | 'ask' | 'free';

/** legado: só a tela atual e a leitura de fichas antigas usam (`mcp__servidor`, `mcp__servidor__ferramenta`). */
export type McpPolicy = 'allow' | 'ask' | 'off';

/** Quem perguntou numa conversa de consulta (gravado na entrada da sessão do funcionário consultado; a tela só lê). */
export interface ConsultStamp {
  /** O id da consulta (`c-<6 hex>`, ver server/consult/store.ts). */
  id: string;
  fromProjectId: string;
  fromProjectName: string;
  fromStaffId: string;
  fromStaffName: string;
}

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
  /** Agents indicados na ficha (o Claude Code continua vendo todos os do projeto). */
  agents: string[];
  /** Skills marcadas: `global:<nome>` ou `project:<nome>` (ver server/skillAccess.ts). Nome sem escopo é o formato antigo, convertido ao salvar. */
  skills: string[];
  /** MCPs ligados; null = todos os configurados (inclusive os conectores da conta). */
  mcps: string[] | null;
  /**
   * Acesso por MCP (nome na ficha → `McpAccess`). Ausente = tudo `free` (segue a autonomia). Entre o que a ficha pede e o que o
   * gestor tem, vale o mais restrito (ver server/staff/mcpAccess.ts). Só guarda o que não é `free`.
   */
  mcpAccess?: Record<string, McpAccess>;
  /** @deprecated legado, sempre ausente na leitura (a ficha antiga vira `mcpAccess`, ver server/staff/store.ts). */
  mcpPolicy?: Record<string, McpPolicy>;
  /** @deprecated legado, sempre ausente na leitura (a ficha antiga vira `mcpAccess`, ver server/staff/store.ts). */
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
  /**
   * O modelo `model` não existe mais na conta (o motor recusou). A conversa roda no padrão do motor; a marca some quando a
   * ficha troca de modelo ou de motor. Só o Claudio’s Club grava, fora do questionário.
   */
  modelObsolete?: { model: string; engine: Engine; at: string };
  /** Pode contratar subfuncionários (subsessões) pelo Claudio’s Club. */
  canHire: boolean;
  /**
   * "Pode versionar e fazer deploy": liga e encerra a pausa de versão pela API (ver `ProjectPause`). Padrão desligado; só você liga, pela tela. Ausente = desligado (fichas antigas);
   * opcional no tipo porque o client monta fichas sem ele.
   */
  canRelease?: boolean;
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
   * que foi escolhido no chat desta conversa (vale ao reabrir); ausente = o da ficha. `readOnly`: conversa de revisão de tarefa, que não
   * edita arquivos do projeto (ver `chatSpawn`); vale também ao reabrir. `consult`: conversa aberta pela consulta de um funcionário de outro projeto
   * (ver server/consult/): só leitura da pasta do projeto, sem token, sem MCP; o carimbo diz quem perguntou e de qual projeto.
   */
  sessions: { id: string; startedAt: string; cwd?: string; model?: string; effort?: CodexEffort; fallback?: { engine: Engine; model: string; effort?: CodexEffort }; readOnly?: boolean; consult?: ConsultStamp }[];
  createdAt: string;
  updatedAt: string;
}

/** O que o questionário de contratação envia. */
export type StaffInput = Omit<StaffProfile, 'id' | 'projectId' | 'portrait' | 'sessions' | 'lastModel' | 'lastEffort' | 'modelObsolete' | 'createdAt' | 'updatedAt' | 'fallback'> & {
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
  /** O que a ficha guarda em `mcps`: `global:<nome>` ou `project:<nome>` (ver server/mcpAccessRefs.ts). */
  ref: string;
  /** Global = `~/.claude.json` (vale também no Claude Code fora do Claudio’s Club); Projeto = `.mcp.json` e o escopo local do projeto. */
  scope: 'global' | 'project';
  /** Projeto: o servidor está no escopo local do `~/.claude.json` (não vai para o git). */
  outOfGit?: boolean;
  /**
   * @deprecated Use `scope`. Fica no tipo só até a tela trocar; o servidor só emite `user` (Global) e `project`.
   * `club` = biblioteca do Claudio’s Club; `project` = .mcp.json; `local` = só este projeto; `user` = todos os projetos.
   */
  source: 'club' | 'project' | 'local' | 'user';
  transport: string | null;
  /** Do último teste na biblioteca (ver server/staff/mcpTools.ts): total e quantas são de escrita. Ausente = nunca testado ou mudou desde o teste. */
  tools?: { total: number; write: number };
}

/** legado: só a tela atual e a leitura de fichas antigas usam (`mcpWrite`: `deny` vira `readonly`, `ask` fica `ask`). */
export type McpWritePolicy = 'ask' | 'deny';

/**
 * Escopo de um MCP. O servidor só emite e aceita `global` e `project`; `club`, `user` e `local` são os antigos e ficam no tipo só até a
 * tela trocar (a Global é o escopo `user` do ~/.claude.json, e `local` aparece como Projeto, com `outOfGit`).
 */
export type McpScope = 'global' | 'project' | /** @deprecated */ 'club' | /** @deprecated */ 'user' | /** @deprecated */ 'local';
export type McpType = 'http' | 'sse' | 'stdio';

/** MCP para a tela de biblioteca. Nunca traz valor de env/cabeçalho: só o nome e se está preenchido. */
export interface McpServerView {
  name: string;
  scope: McpScope;
  projectId?: string;
  /** Projeto: vem do escopo local do ~/.claude.json (não vai para o git). */
  outOfGit?: boolean;
  /** Global: entrada do Claudio’s Club, com os valores no cofre (o ~/.claude.json só leva o lançador e o nome do servidor). */
  managed?: boolean;
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

/**
 * MCP que grava só a memória da própria ficha (`memoria_gravar`, `memoria_apagar`): entra nas conversas em autonomia `plan`, onde a
 * edição de arquivos está bloqueada nos dois motores (no Codex a sandbox de só leitura não aceita exceção por caminho).
 */
export const MEMORIA_MCP_NAME = 'myco-memoria';

/**
 * MCP de git do Club (`git_status`, `git_diff`, `git_log`, `git_commit`, `git_push`, `git_pr_criar`), nos dois motores: roda fora da sandbox do Codex
 * (onde o `.git` é só leitura e não há rede). A chave do acesso da ficha (`mcpAccess`) é este nome.
 */
export const GIT_MCP_NAME = 'myco-git';
/** Ferramentas do `myco-git` só de leitura (a ficha com acesso `readonly` e a conversa de revisão veem só estas) e as de escrita. */
export const GIT_READ_TOOLS: string[] = ['git_status', 'git_diff', 'git_log'];
export const GIT_WRITE_TOOLS: string[] = ['git_commit', 'git_push', 'git_pr_criar'];

/**
 * MCP de tarefa do Club (`tarefa_cancelar`, `tarefa_pedir_cancelamento`, `tarefa_recusar_cancelamento`), só no Claude: outro caminho para as rotas `cancel`, `cancel-request` e
 * `cancel-request/refuse`, com o token da própria conversa (o servidor confere quem é dono da tarefa). O Codex segue pelo curl, que lá não passa por classificador.
 */
export const TAREFA_MCP_NAME = 'myco-tarefa';

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
      /** Só nas guardadas (`held`): a tarefa que guarda a mensagem, para `POST …/tasks/<id>/held/<hid>/discard` (o `<hid>` é o id do item sem o `h:`). */
      heldTaskId?: string;
      /** Só nas guardadas: dá para excluir? false na resposta a uma dúvida (a tarefa espera por ela; o servidor recusa com 409). */
      heldDiscardable?: boolean;
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
      /** Aviso da retomada automática de um turno que caiu: o estado em campos, para a tela escrever a frase no idioma dela e fazer a contagem (o `text` é só o de reserva). */
      retry?: TurnRetryNotice;
      /** Ferramenta negada: a ferramenta, e quem barrou (`denial`, a dica que a tela mostra). */
      tool?: string;
      denial?: DenialInfo;
      /** O turno parou no teto (ferramentas ou minutos): o aviso diz qual e quanto era. */
      cap?: TurnCapHit;
      /** Aviso que a tela escreve no idioma dela (o `text` é só o de reserva): `older-in-file` = o que passou do limite da conversa ao vivo só está no arquivo dela. */
      note?: 'older-in-file';
    };

/**
 * O estado de um aviso da retomada automática (`retry` do item `notice`; ver server/chat/turnRetry.ts). `state` é qual mensagem saiu:
 * `waiting` (marcada), `sent` (retomou), `cancelled` (desfeita), `failed` (o envio falhou: `error`) ou `dropped` (a opção desligou).
 * `attempt`/`max` são os da tentativa, quando o servidor os sabe; `at` é o instante da próxima tentativa (epoch ms, UTC), só em `waiting`;
 * `error` é o motivo em pt-BR (`waiting`: a queda, `failed`: o que impediu o envio), até 300 caracteres.
 */
export interface TurnRetryNotice {
  state: 'waiting' | 'sent' | 'cancelled' | 'failed' | 'dropped';
  attempt?: number;
  max?: number;
  at?: number;
  error?: string;
}

/**
 * Turno parado que não volta sozinho: pelo teto (ver server/chat/turnCap.ts: o que passou do limite e quanto era), pelo
 * reinício, que cortou no meio uma ação com efeito fora do projeto (ver server/chat/cutAction.ts: `action`, o resumo dela), ou pela
 * retomada automática que não aconteceu (ver server/chat/turnRetry.ts): `retry`/`exhausted` gastou as tentativas (`attempts`) e `retry`/`cut`
 * não tentou porque a ação cortada mexia fora do projeto (`action`); `error` é o erro que derrubou o turno, curto.
 * Também pelo erro do motor no turno de trabalho de uma tarefa (`engine`): `auth` = login do Claude/Codex expirado ou recusado (o sinal estruturado do motor: o `error`
 * `authentication_failed` da mensagem do Claude, ou o status 401), que só o dono resolve entrando de novo e que nunca é retomado sozinho; `error` = o turno falhou por outra causa
 * que não vai passar sozinha (ou a retomada está desligada). `error` é o erro do motor, curto.
 * Fica na caixa (e põe a tarefa em Aguardar) até você mandar mensagem nova.
 */
export type TurnCapHit =
  | { kind: 'tools' | 'minutes'; limit: number }
  | { kind: 'restart'; action: string }
  | { kind: 'retry'; why: 'exhausted'; attempts: number; error: string }
  | { kind: 'retry'; why: 'cut'; action: string; error: string }
  | { kind: 'engine'; why: 'auth' | 'error'; engine: 'claude' | 'codex'; error: string };

/** Quem barrou uma ferramenta: `layer`; `reason` é o motivo dado (sem ele, ausente). `safety` = checagem embutida
 *  do Claude Code (ex.: Remove-Item em caminho do sistema); `settings` = arquivo ou pasta negado nas regras de permissão. */
export interface DenialInfo {
  layer: 'classifier' | 'classifierError' | 'club' | 'safety' | 'settings' | 'other';
  reason?: string;
  /** `servers`: dar acesso a servidores; `autonomy`: o classificador do Autônomo barrou; `retry`: tentar de novo. */
  hint: 'servers' | 'autonomy' | 'retry' | null;
}

/** Quem barrou, no alerta "ação barrada" da caixa: as camadas do Claude (`DenialInfo.layer`) mais a sandbox do Codex (`sandbox`, ver server/chat/denied.ts). */
export type DeniedLayer = DenialInfo['layer'] | 'sandbox';

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
export type InboxKind = 'plan' | 'permission' | 'secret' | 'waiting' | 'error' | 'routine' | 'orphan' | 'usage' | 'blocked' | 'notStarted' | 'question' | 'stuck' | 'followUp' | 'denied';

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

/**
 * Palpite do servidor, na detecção, sobre o segredo ser de verdade (heurística local; nunca valida a credencial no provedor):
 * `example` = provável exemplo/teste; `local` = contexto local (loopback/dev), autenticidade desconhecida;
 * `exposed` = possível credencial exposta; `unknown` = não foi possível determinar.
 */
export type SecretVerdict = 'example' | 'local' | 'exposed' | 'unknown';

/** Por que o palpite saiu assim (código estável; a tela monta a frase). */
export type SecretReason =
  | 'fake-token' // token com formato de provedor, mas com cara de teste (letra repetida, alfabeto em sequência, "EXAMPLE")
  | 'placeholder' // valor de enchimento (xxxx, your-password, …)
  | 'default-password' // senha padrão conhecida (root, changeme, password, …)
  | 'example-file' // arquivo de modelo (.env.example, *.sample, *.template)
  | 'test-file' // teste ou fixture (tests/, fixtures/, *.test.ts, …)
  | 'example-host' // host reservado para exemplo (example.com, *.invalid)
  | 'local-host' // host loopback ou de desenvolvimento (localhost, 127.0.0.1, *.local, *.test)
  | 'other-host' // outro host (IP ou domínio): credencial provavelmente de verdade
  | 'provider-format' // token com o formato válido de um provedor
  | 'private-key' // chave privada
  | 'strong-value' // senha longa e variada, sem nada que a denuncie como exemplo
  | 'no-context'; // contexto insuficiente

/**
 * Dica mascarada, calculada no servidor na detecção, para o dono reconhecer o segredo sem o Club guardá-lo. Nunca mais de 4 caracteres do valor.
 * Token de provedor: `prefix` público + `tail` (4) + `length`. Senha com 12+ caracteres: `tail` (2) + `length`; com menos: só `length`.
 * Senha padrão conhecida: só `isDefault`. Chave privada: sem dica. Só vai para a tela do Club (nunca para a extensão, o log, a notificação nem o agente).
 */
export interface SecretHint {
  /** Prefixo público do provedor ("sk-ant-", "ghp_"…); só em token. */
  prefix?: string;
  /** Últimos caracteres do valor (4 em token, 2 em senha com 12+). */
  tail?: string;
  /** Tamanho do valor, em caracteres. */
  length?: number;
  /** É uma senha padrão conhecida: a dica não mostra nada dela. */
  isDefault?: true;
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
  /**
   * Para onde a conversa rola ao clicar no aviso: o id do `ChatItem` que causou o aviso (o cartão de
   * permissão ou de plano; o balão da resposta onde a pergunta foi achada). Sem ele a conversa abre no fim.
   */
  itemId?: string;
  /** Pergunta detectada no texto da resposta: o cliente acha o trecho dentro do balão (ou nos últimos balões, sem `itemId`). */
  quote?: string;
  /** Segredo no chat: o cliente monta a frase no idioma da página (sem isso, vale `summary`, em pt-BR). Nunca traz o valor. */
  secret?: {
    kind: SecretKind;
    detail?: string;
    source?: SecretSource;
    /**
     * Palpite sobre ser real ou falso positivo (ver `SecretVerdict`). O servidor sempre o envia; o tipo é opcional só para o cliente aceitar item sem ele
     * (fixture, servidor antigo): sem `verdict`, a tela não mostra palpite. O aviso sobe de gravidade se aparecer ocorrência mais grave.
     */
    verdict?: SecretVerdict;
    /** Por que o palpite saiu assim. Vem junto com `verdict`. */
    reason?: SecretReason;
    /** Início/fim mascarado para reconhecer o segredo (ver `SecretHint`). Ausente em chave privada. Só na tela do Club. */
    hint?: SecretHint;
    /** Arquivo do segredo, relativo à raiz do projeto, separado por "/". Ausente quando não há arquivo identificável. */
    file?: string;
    /** A linha do segredo em `file` (1 = primeira), quando o servidor a achou lendo o arquivo; ausente se não deu (chave privada, arquivo comprido). Só vem junto com `file`. */
    line?: number;
    /**
     * true quando o files/read recusa esse caminho (mesma checagem): o balão mostra o caminho sem abri-lo na aba Arquivos, e o "Corrigir" abre o arquivo no editor
     * do computador (`POST /api/projects/:id/files/open-editor`). Só vem junto com `file`.
     */
    fileBlocked?: true;
  };
  /**
   * Tarefa que espera outra empacada (kind 'blocked', ver stuckDependencies em server/tasks.ts): quem espera, a bloqueadora, o estado dela e o motivo.
   * `selfHeals`: a bloqueadora se recupera sozinha; `humanAction`: o que só você resolve nela (null = nada, ou a cancelada, que tem os botões próprios).
   */
  blocked?: { taskId: string; taskTitle: string; blockerId: string; blockerTitle: string; blockerStatus: TaskStatus; reason: string; selfHeals?: boolean; humanAction?: HumanAction | null };
  /**
   * Dúvida escalada de uma tarefa (kind 'question', ver ownAlerts em server/tasks.ts): a pergunta por opções (`questions`) ou escrita (`text`), como o
   * funcionário a fez (texto do agente: a tela mostra como texto puro). Responde-se pela rota `answer` da tarefa, que a tela chama como dono.
   */
  question?: { taskId: string; taskTitle: string; questionId: string; source: 'ask' | 'text'; text?: string; questions?: Array<{ question: string; options: string[]; multiSelect?: boolean }>; escalatedAt: string };
  /** Tarefa parada que só você destrava (kind 'stuck'): revisão que não anda ou ajuste que não chega. `reason` em pt-BR; a tela monta a frase por `humanAction`. */
  stuck?: {
    taskId: string;
    taskTitle: string;
    reason: string;
    selfHeals: boolean;
    humanAction: HumanAction | null;
    since: string;
    /**
     * Card = código: o card terminou o turno sem editar código (`Task.noCode`) e quem pediu é o usuário (ou o aviso ao gestor se perdeu): `humanAction` é 'decide'. As saídas
     * são a rota `cancel` da tarefa (com o motivo) e uma mensagem na conversa de trabalho dela (`Task.sessionId`, devolver ao responsável). `summary`: o que o responsável disse
     * ao terminar (até 1500 caracteres, texto dele, puro).
     */
    noCode?: true;
    /**
     * O card pedia plano primeiro e entregou o plano (`Task.planWait`), e quem pediu é o usuário (ou o aviso ao gestor se perdeu): `humanAction` é 'decide'. A decisão é a rota
     * `POST .../tasks/<id>/plan` (`{"decision": "approve"}` ou `{"decision": "reject", "reason": "…"}`). `summary`: o começo do plano (texto do funcionário, puro).
     */
    planWait?: true;
    /**
     * A tarefa em "revisão" espera a SUA aprovação (`Task.ownerGate`; `humanAction` é 'decide'): 'approved' = o revisor IA aprovou e falta você; 'no-reviewer' = a política de fluxo
     * manda a IA concluir e não há revisor configurado. A saída é "Aprovar" no card (ou reprovar/devolver).
     */
    ownerGate?: 'approved' | 'no-reviewer';
    summary?: string;
  };
  /**
   * Cartão esquecido (kind 'notStarted', ver notStartedTasks em server/tasks.ts): tarefa em "a fazer", fora da fila e sem bloqueadora, parada há `days`
   * dias (inteiros, no mínimo 2). `staffId` é o responsável (null = sem responsável: "Começar" pede escolher um). O item não leva `staffId`
   * no topo: não é conversa esperando, e o cartão do funcionário não deve ficar amarelo por isso.
   */
  notStarted?: { taskId: string; taskTitle: string; days: number; staffId: string | null };
  /**
   * Follow-up esperando a decisão do usuário (kind 'followUp', ver followUpAlerts em server/tasks.ts): pedido por ele, ou o gestor não pôde receber. `text` é o do autor,
   * cortado em 600 caracteres (o inteiro está em `Task.followUps[].text`); texto puro. Decide-se pela rota `POST .../tasks/:taskId/followup/:followUpId/resolve` da tarefa,
   * que a tela chama como dono (descartar ou "virou o card X"), ou `.../followup/:followUpId/card` (cria o card em um passo). Nada é gravado para o item: some quando o follow-up é resolvido.
   * O item não leva `staffId` (não é conversa esperando). `sessionId` do item: a conversa de trabalho da tarefa quando o usuário a pediu e ela tem conversa (a tela mostra o achado como
   * balão nela); vazio quando a tarefa foi pedida por um gestor (o aviso a ele se perdeu) ou ainda não tem conversa (o alvo é o card).
   */
  followUp?: {
    taskId: string;
    taskTitle: string;
    followUpId: string;
    by: string;
    byName: string;
    text: string;
    at: string;
    /** Os campos estruturados do follow-up (ver `FollowUp`), só os que o revisor mandou. `staffName`: o nome de quem faria (vazio se a ficha saiu do projeto). */
    recommendation?: 'worth' | 'optional';
    title?: string;
    impact?: string;
    size?: 'small' | 'medium' | 'large';
    staffId?: string;
    staffName?: string;
  };
  /**
   * Ação barrada numa conversa de tarefa (kind 'denied', ver `deniedInboxItem` em server/inboxItems.ts): uma regra de permissão negou uma ferramenta (plano, regra do Club,
   * settings, classificador do Autônomo, sandbox do Codex). Um item por conversa e por turno, agrupado: o id é `denied:<sessão>:<turno>`, `tool`/`layer`/`reason`/`hint`/`text`
   * são os da negação que mais provavelmente trava o trabalho (a checagem `safety`, que o agente costuma contornar, só aparece se for a única), `count` conta as negações
   * do turno e `tools` as ferramentas distintas (até 5). `text` é o mesmo texto do aviso no chat (`denialNotice`; no Codex, o da sandbox) e `hint` a dica de destrave
   * (`DenialInfo.hint`: `servers`, `autonomy`, `retry`; nulo = sem dica). Texto de origem do agente/motor: a tela mostra como texto puro. Ignorar: `POST /api/denied/dismiss`
   * `{ id }` (só pela tela). Uma conversa tem no máximo um item vivo (o do turno mais recente); só na memória do servidor (some num reinício). A tarefa pode ser a de trabalho
   * ou a de deploy; conversa livre, de card automático ou de revisão não geram. Codex: só a recusa explícita da sandbox (`layer: 'sandbox'`, ver o limite em server/chat/denied.ts). É um item de conversa (leva `sessionId` e `staffId`, como o de permissão): o alvo é a conversa.
   */
  denied?: { taskId: string; taskTitle: string; tool: string; layer: DeniedLayer; reason?: string; hint: DenialInfo['hint']; text: string; count: number; tools: string[] };
  /**
   * O commit automático de uma tarefa pronta falhou, foi parcial ou não coube (kind 'error', id `commit:<tarefa>`; ver `commitInboxItem` em server/inboxItems.ts). `summary` (pt-BR)
   * traz o motivo e os arquivos que ficaram de fora. O alvo é a tarefa no quadro (sem conversa, sem `staffId`). Ignorar: `POST /api/errors/dismiss` `{ id }` (só pela tela).
   * `state` (ver `CommitLeftState`) diz o que o aviso pede e dá o tom: `ready` = decisão do dono (refazer o commit das sobras ou ignorar), `failed` = erro; ausente = o problema já passou (item
   * com `resolvedAt`). `waiting` nunca vira item (só `Task.commitLeft` e a contagem de `GET /api/inbox/commit-waiting`). Com `state`, vêm também `sha` (o commit original), `files` (cada
   * sobra com o motivo e os cards abertos que a travam), `blockers`, `canRedo`, `truncated` e `note`, os mesmos campos de `CommitLeft`; quem fez a tarefa é `name`.
   */
  autoCommit?: { taskId: string; taskTitle: string; status: TaskCommit['status']; sha?: string | null } & Partial<CommitLeft>;
  /**
   * A conta do Codex tem um `hooks.json` e a conversa de tarefa roda SEM a fila de validação pesada (kind 'error', id `guardoff:<sessão>`; ver `heavyGuardOffInboxItem` em
   * server/inboxItems.ts e `codexHeavyArgs` em server/chat/codexArgs.ts): suíte completa e `tsc` correm sem esperar a vez. Um item por conversa, uma vez (não a cada execução); some quando
   * o arquivo some (na próxima mensagem) ou ao ignorar (`POST /api/errors/dismiss` `{ id }`, só pela tela). `file` é o caminho do arquivo na máquina do servidor (só na tela do Club). Só
   * na memória do servidor; a nota da tarefa (histórico) é a que fica. É um item de conversa (leva `sessionId` e `staffId`): o alvo é a conversa.
   */
  heavyGuardOff?: { taskId: string; taskTitle: string; file: string };
  /**
   * O sandbox do Codex no Windows não consegue criar/atualizar os usuários locais dele (CodexSandboxOffline/Online), porque a política local de senha tem "duração mínima" acima de 0:
   * todo comando de terminal do Codex falha com `helper_user_create_or_update_failed` (kind 'error', id `codexsandbox:password-policy`; ver `codexSandboxInboxItem` em server/inboxItems.ts e
   * server/codexPasswordPolicy.ts). Um item por máquina, só no Windows e só quando há ficha ou conversa do Codex. Nasce da checagem prévia (ao abrir conversa Codex e ao salvar ficha do Codex;
   * `source: 'check'`) ou do erro visto na saída de uma ferramenta do Codex (`source: 'turn'`); some quando a política passa a 0 (a próxima checagem, no máximo 10 min depois) ou ao ignorar
   * (`POST /api/errors/dismiss` `{ id }`, só pela tela; volta só se a política passar a 0 e falhar de novo). `minPasswordAgeDays`: a duração lida, em dias; maior que 0 = a causa conhecida; 0 = o
   * erro veio mesmo assim, a causa é outra regra de senha (tamanho mínimo, histórico): o comando não resolve; null = a leitura não deu. `command` é o texto a copiar: o Club NUNCA o executa (exige
   * administrador e muda a política de segurança da máquina); `domainNote` é sempre true, porque em computador de domínio a política de grupo pode desfazer a mudança. Não é item de projeto nem
   * de conversa (`projectId`, `projectName` e `sessionId` vêm vazios, `staffId` null, como o aviso de consumo da conta): o alvo é a própria caixa. Só na memória do servidor.
   */
  codexSandbox?: { cause: 'password-policy'; source: 'check' | 'turn'; minPasswordAgeDays: number | null; command: string; domainNote: true };
  /**
   * O problema deste aviso de erro já passou (ver `server/inboxResolved.ts`): ISO da primeira vez que o servidor o viu resolvido. Ausente = pendente, ou tipo sem detecção; nunca vem `null` nem `false`.
   * Só aparece no kind 'error' de: commit automático (os arquivos da tarefa já não têm mudança no git, depois de visto fica), fila desligada (o `hooks.json` sumiu), sandbox do Codex (a duração mínima
   * da senha passou a 0, vale só quando a causa era a política acima de 0) e teto do turno (a tarefa da conversa foi encerrada). `error:<sessão>` nunca leva: o item some sozinho quando a conversa volta.
   * Com `resolvedAt` o item NÃO é pendência: a tela não o conta (sino, título, abas, cartão amarelo) e o mostra com a marca de finalizado, até ser ignorado (`POST /api/errors/dismiss`, a mesma rota) ou
   * passar 24 h (o servidor o tira; o relógio fica na memória, um reinício o reinicia). Vai depois dos pendentes na lista e não vai à extensão do Chrome.
   */
  resolvedAt?: string;
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

/** Tokens de uma conversa, no mesmo formato para os dois motores. `input` é sem cache; no Codex `cacheWrite` é 0. */
export interface TaskTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** complete: todas as conversas têm dado; partial: alguma não tem; none: a tarefa não tem conversas (ou nenhuma tem dado). */
export type TaskCostCoverage = 'complete' | 'partial' | 'none';

/** Soma de um grupo de conversas (um papel, ou os de um gestor). `usd`/`tokens` null = nenhum nó tem o dado. */
export interface TaskCostBucket {
  sessions: number;
  /** Quantas dessas conversas têm tokens lidos. */
  withData: number;
  usd: number | null;
  tokens: TaskTokens | null;
}

/** Uma conversa da tarefa, com o custo dela. `tokens` null = sem dado (nunca zero por falta de leitura). */
export interface TaskCostNode {
  sessionId: string;
  role: TaskSession['role'];
  staffId: string | null;
  engine: Engine;
  at: string;
  usd: number | null;
  tokens: TaskTokens | null;
}

/** Custo de uma tarefa: todas as conversas dela (`sessions`, sem repetir id). */
export interface TaskCost {
  taskId: string;
  coverage: TaskCostCoverage;
  usd: number | null;
  tokens: TaskTokens | null;
  byRole: Record<TaskSession['role'], TaskCostBucket>;
  reworkRounds: number;
  reviewRounds: number;
  nodes: TaskCostNode[];
  /** A leitura dos transcripts ainda está em andamento. */
  scanning: boolean;
}

/** Uma tarefa concluída no ranking por tarefa. */
export interface TaskCostRankRow {
  projectId: string;
  taskId: string;
  title: string;
  staffId: string | null;
  requestedBy: string | null;
  /** Início da última passagem para "pronto" (AAAA-MM-DDTHH:mm… ISO). */
  completedAt: string;
  coverage: TaskCostCoverage;
  sessions: number;
  usd: number | null;
  tokens: TaskTokens | null;
  reworkRounds: number;
  reviewRounds: number;
}

/** Executor: média por tarefa concluída (usd e tokens só das tarefas com dado). */
export interface ExecutorCostRow {
  staffId: string;
  tasks: number;
  usd: number | null;
  tokens: TaskTokens | null;
  usdAvg: number | null;
  /** Média por tarefa de cada componente, arredondada. */
  tokensAvg: TaskTokens | null;
  reworkTasks: number;
  /** Fração (0 a 1) das tarefas concluídas com retrabalho. */
  reworkShare: number;
}

/** Gestor (quem pediu a tarefa): as tarefas pedidas e o custo das conversas de revisão e dúvida que ele fez. */
export interface ManagerCostRow {
  staffId: string;
  tasksRequested: number;
  usd: number | null;
  tokens: TaskTokens | null;
  review: TaskCostBucket;
  question: TaskCostBucket;
}

/** Ranking de custo por tarefa: tarefas concluídas no período, por custo, e os agregados por funcionário e por gestor. */
export interface TaskCostRanking {
  /** Primeiro dia do período (AAAA-MM-DD, hora local); null = desde sempre. */
  since: string | null;
  tasks: TaskCostRankRow[];
  executors: ExecutorCostRow[];
  managers: ManagerCostRow[];
  /** A leitura dos transcripts ainda está em andamento. */
  scanning: boolean;
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
