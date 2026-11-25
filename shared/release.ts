import type { PublishGate, Task, TaskStatus } from './model';

// Versão com escopo (ver server/release.ts): o dono escolhe as tarefas pendentes que entram, as de fora esperam, e quando todas ficam prontas o Club prepara
// o commit da versão; publicar (push e PR) e criar a tag são botões dele. Aqui o que a tela e o servidor calculam igual: número, escopo com dependências e progresso.

/** Quem fez: um funcionário (pela API, com a permissão) ou null = você, pela tela (ou o próprio Club, na preparação automática). */
export type ReleaseActor = { staffId: string; name: string } | null;

/** As provas da preparação: checagem de tipos e testes relacionados aos arquivos da versão. `none` = o projeto não tem; `skipped` = você mandou preparar sem elas. */
export interface ReleaseProof {
  typecheck: 'ok' | 'none' | 'skipped';
  tests: 'ok' | 'none' | 'skipped';
  /** Quantos arquivos de código mudaram desde a última tag (os testes relacionados vêm deles); null = rodou a suíte inteira. */
  related: number | null;
}

/** Uma linha do registro da versão (o rastro: quem abriu, preparou, publicou, pediu a tag, furou com hotfix). */
export interface ReleaseLogEntry {
  at: string;
  action: 'opened' | 'scope' | 'hotfix' | 'prepared' | 'prepare-failed' | 'discarded' | 'published' | 'tag-requested' | 'tag-declined' | 'tagged';
  by: ReleaseActor;
  detail?: string;
}

/** O que `<projeto>/.myco/release.json` guarda: a versão aberta (uma por projeto). Sem arquivo = nenhuma versão aberta. */
export interface ReleaseState {
  /** "1.5.2" (sem o "v"). */
  version: string;
  /** O escopo: as tarefas marcadas e as bloqueadoras que vieram junto. */
  taskIds: string[];
  /** Hotfix: furam a versão aberta (começam e mesclam), mas a versão não espera por elas. */
  hotfixes: string[];
  /** O card de manual e doc criado ao abrir (começa quando as outras ficam prontas); null = não pedido. */
  docsTaskId: string | null;
  openedAt: string;
  /** O commit local da versão (número novo no package.json e no lock). Com ele, a versão sai da frente: a fila e as mesclas de fora voltam. */
  prepared: { at: string; sha: string; branch: string; proof: ReleaseProof } | null;
  /** A última preparação que falhou (testes vermelhos, package.json mexido): a automática não tenta de novo sozinha. */
  prepareError: { at: string; message: string; testsOutput?: string } | null;
  /** Push do commit da versão para `release/<versão>` e o PR para a branch padrão. */
  published: { at: string; branch: string; pr: string; by: ReleaseActor } | null;
  /** Um funcionário pediu a tag (modo staff-pr): espera o seu ok. */
  tagRequest: { at: string; by: { staffId: string; name: string } } | null;
  log: ReleaseLogEntry[];
}

/**
 * Quem publica no projeto: o portão `publish` da política de fluxo (`FlowGates.publish`, em `~/.myco/flow-policies.json`; só você muda, pela tela):
 * - `manual`: só você (o padrão);
 * - `staff-pr`: o funcionário com "Pode versionar e fazer deploy" publica o PR; a tag pede o seu ok;
 * - `staff-all`: ele publica o PR e a tag sozinho, e você é avisado.
 */
export type ReleaseMode = PublishGate;
export const RELEASE_MODES: ReleaseMode[] = ['manual', 'staff-pr', 'staff-all'];

/** Como cada tarefa do escopo está: pronta, andando, cancelada (sai da conta) ou travada por uma bloqueadora cancelada. */
export type ReleaseTaskState = 'done' | 'pending' | 'cancelled' | 'stuck';

export interface ReleaseTaskView {
  id: string;
  title: string;
  status: TaskStatus | null;
  staffId: string | null;
  state: ReleaseTaskState;
  /** Quantas vezes voltou da revisão. */
  rejections: number;
}

/** `GET /api/projects/:id/release`. */
export interface ReleaseView {
  release: ReleaseState | null;
  /** Quem publica neste projeto (vale com ou sem versão aberta). */
  mode: ReleaseMode;
  tasks: ReleaseTaskView[];
  /** Prontas e total (sem as canceladas). */
  done: number;
  total: number;
  /** Todas prontas e nenhuma travada: pode preparar. */
  ready: boolean;
  /** A preparação está rodando agora (testes, commit). */
  preparing: boolean;
}

/** Uma versão fechada, lida da tag anotada `vX.Y.Z`. Tag antiga (de antes da ferramenta) vem sem tarefas. */
export interface ReleaseHistoryEntry {
  tag: string;
  version: string;
  date: string;
  sha: string;
  subject: string;
  summary: string;
  tasks: Array<{ id: string; title: string }>;
}

/** `GET /api/projects/:id/releases`: as versões fechadas (mais nova primeiro) e o número sugerido para a próxima. */
export interface ReleaseHistory {
  entries: ReleaseHistoryEntry[];
  suggested: string;
}

/** Teto do escopo: versão grande demais trava a fila por tempo demais. */
export const RELEASE_MAX_TASKS = 50;

const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** "1.5.2" → [1, 5, 2]; null se não for X.Y.Z. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0];
  const y = parseVersion(b) ?? [0, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** A próxima versão (correção) depois da maior das conhecidas (tags `vX.Y.Z` e o package.json); sem nenhuma, 0.1.0. */
export function nextVersion(known: string[]): string {
  const valid = known.map((k) => k.replace(/^v/, '')).filter((k) => parseVersion(k));
  if (!valid.length) return '0.1.0';
  const [a, b, c] = parseVersion(valid.sort(compareVersions).at(-1)!)!;
  return `${a}.${b}.${c + 1}`;
}

const isOpen = (t: Pick<Task, 'status'>) => t.status !== 'done' && t.status !== 'cancelled';

/** As marcadas mais as bloqueadoras abertas delas, em cadeia (bloqueadora pronta não precisa entrar; cancelada não entra e trava quem depende). Ordem: a das marcadas, depois as puxadas. */
export function expandScope(tasks: Array<Pick<Task, 'id' | 'status' | 'blockedBy'>>, ids: string[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [...ids];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = byId.get(id);
    if (!t) continue;
    out.push(id);
    for (const dep of t.blockedBy ?? []) {
      const d = byId.get(dep);
      if (d && isOpen(d) && !seen.has(dep)) queue.push(dep);
    }
  }
  return out;
}

/** O progresso do escopo, derivado das tarefas (nada disto é gravado). */
export function releaseProgress(
  tasks: Array<Pick<Task, 'id' | 'title' | 'status' | 'staffId' | 'blockedBy' | 'reworkRounds'>>,
  state: Pick<ReleaseState, 'taskIds'>,
): Pick<ReleaseView, 'tasks' | 'done' | 'total' | 'ready'> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const views: ReleaseTaskView[] = state.taskIds.map((id) => {
    const t = byId.get(id);
    if (!t) return { id, title: id, status: null, staffId: null, state: 'cancelled', rejections: 0 };
    const stuck = t.status !== 'done' && t.status !== 'cancelled' && (t.blockedBy ?? []).some((b) => byId.get(b)?.status === 'cancelled');
    const s: ReleaseTaskState = t.status === 'done' ? 'done' : t.status === 'cancelled' ? 'cancelled' : stuck ? 'stuck' : 'pending';
    return { id, title: t.title, status: t.status, staffId: t.staffId ?? null, state: s, rejections: t.reworkRounds ?? 0 };
  });
  const counted = views.filter((v) => v.state !== 'cancelled');
  const done = counted.filter((v) => v.state === 'done').length;
  return { tasks: views, done, total: counted.length, ready: counted.length > 0 && done === counted.length };
}

/** Linha de tarefa no corpo da tag (e do PR): `- t-abc123 Título`. É dela que o histórico lê as tarefas de volta. */
export const taskLine = (t: { id: string; title: string }): string => `- ${t.id} ${t.title.replace(/\s+/g, ' ').trim()}`;
const TASK_LINE = /^- (t-[0-9a-z]{4,20}) (.+)$/;

/** O corpo da tag: o resumo e uma linha por tarefa. */
export function releaseBody(summary: string, tasks: Array<{ id: string; title: string }>): string {
  return [summary.trim(), tasks.length ? ['Tarefas:', ...tasks.map(taskLine)].join('\n') : ''].filter(Boolean).join('\n\n');
}

/** O contrário de `releaseBody`: as linhas de tarefa e o resto como resumo. */
export function parseReleaseBody(body: string): { summary: string; tasks: Array<{ id: string; title: string }> } {
  const tasks: Array<{ id: string; title: string }> = [];
  const rest: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = TASK_LINE.exec(line.trim());
    if (m) tasks.push({ id: m[1]!, title: m[2]! });
    else if (line.trim() !== 'Tarefas:') rest.push(line);
  }
  return { summary: rest.join('\n').trim(), tasks };
}
