import type { ChatItem, InboxItem, SecretHint, SecretKind, SecretReason, SecretSource, SecretVerdict } from '../shared/model';
import { leftText } from './autoCommit';
import { secretFile } from './chat/codeEdits';
import { PASSWORD_POLICY_FIX, PASSWORD_POLICY_ID, type PasswordPolicyAlert } from './codexPasswordPolicy';
import type { DeniedInfo } from './chat/denied';
import { secretAlert } from './chat/secrets';
import { isBlockedRel } from './projectFiles';
import type { CommitAlert, FollowUpAlert, NotStartedTask, OwnAlert, StuckDependency } from './tasks';

// Avisos da caixa "precisa de mim" que vêm de uma conversa do Claudio’s Club e levam ao ponto dela que
// os causou (`itemId`, `quote`): ao clicar, a conversa rola até lá.

export type Place = Pick<InboxItem, 'projectId' | 'projectName' | 'sessionId' | 'staffId' | 'name'>;

/** Pedido de permissão (ou plano, ou pergunta com opções) sem resposta: o alvo é o cartão dele na lista. */
export function permissionInboxItem(p: Extract<ChatItem, { kind: 'permission' }>, w: Place): InboxItem {
  const plan = p.plan !== undefined;
  return {
    id: `perm:${p.id}`,
    kind: plan ? 'plan' : 'permission',
    ...w,
    summary: plan ? 'plano pronto para aprovar' : p.questions ? `pergunta para você: ${p.summary}` : `${p.tool} ${p.summary}`,
    at: p.at,
    itemId: p.id,
  };
}

/** Turno que acabou perguntando: o alvo é o balão da resposta, e a pergunta serve para achar o trecho nele. */
/** A frase em pt-BR (a tela monta a dela no idioma da página). Bloqueadora cancelada: "que foi cancelada (motivo)", sem dois-pontos duplos. */
function blockedSummary(s: StuckDependency): string {
  const head = `“${s.task.title}” espera “${s.blocker.title}”`;
  if (s.blocker.status !== 'cancelled') return `${head}: ${s.reason}`;
  const why = /^cancelada: ([\s\S]+)$/.exec(s.reason)?.[1];
  return `${head}, que foi cancelada${why ? ` (${why})` : ''}`;
}

/**
 * Tarefa que espera outra empacada (ver stuckDependencies). Nada é gravado: some quando a bloqueadora anda ou fica pronta. O alvo é a
 * tarefa que espera, no quadro (sem conversa, `sessionId` vazio).
 */
export function blockedInboxItem(s: StuckDependency, w: Place): InboxItem {
  return {
    id: `blocked:${s.task.id}:${s.blocker.id}`,
    kind: 'blocked',
    ...w,
    summary: blockedSummary(s),
    at: s.blocker.updatedAt,
    blocked: {
      taskId: s.task.id,
      taskTitle: s.task.title,
      blockerId: s.blocker.id,
      blockerTitle: s.blocker.title,
      blockerStatus: s.blocker.status,
      reason: s.reason,
      selfHeals: s.selfHeals,
      humanAction: s.humanAction,
    },
  };
}

/** O que a dúvida da caixa leva do agente: o texto, as perguntas e cada opção são cortados (a tela mostra como texto puro, e o servidor não repassa o que o agente quiser). */
const DOUBT_TEXT_MAX = 2000;
const DOUBT_PART_MAX = 500;
const DOUBT_QUESTIONS_MAX = 10;
const DOUBT_OPTIONS_MAX = 20;

/** A primeira linha do que foi perguntado, cortada: o `summary` em pt-BR. */
function firstAsked(q: NonNullable<InboxItem['question']>): string {
  const first = (q.questions?.[0]?.question ?? q.text ?? '').trim().split(/\r?\n/)[0]!.trim();
  return first.length > 140 ? `${first.slice(0, 139)}…` : first;
}

/**
 * Dúvida de uma tarefa que só você responde (kind 'question', ver ownAlerts): escalada, sem resposta do gestor no prazo. Nada é gravado:
 * some quando alguém responde (a rota `answer` da tarefa, pela tela) ou a tarefa é cancelada. O alvo é a tarefa no quadro (sem conversa).
 */
export function taskQuestionInboxItem({ task, state }: OwnAlert, w: Place): InboxItem {
  const q = task.question!;
  const question: NonNullable<InboxItem['question']> = {
    taskId: task.id,
    taskTitle: task.title,
    questionId: q.id,
    source: q.source,
    ...(q.text && { text: q.text.slice(0, DOUBT_TEXT_MAX) }),
    ...(q.questions && {
      questions: q.questions.slice(0, DOUBT_QUESTIONS_MAX).map((x) => ({
        question: String(x.question).slice(0, DOUBT_PART_MAX),
        options: (x.options ?? []).slice(0, DOUBT_OPTIONS_MAX).map((o) => String(o).slice(0, DOUBT_PART_MAX)),
        ...(x.multiSelect && { multiSelect: true }),
      })),
    }),
    escalatedAt: q.escalatedAt ?? q.askedAt,
  };
  return {
    id: `doubt:${task.id}:${q.id}`,
    kind: 'question',
    ...w,
    summary: `“${task.title}” tem uma dúvida esperando você: ${firstAsked(question)}`,
    at: state.since,
    question,
  };
}

/**
 * Tarefa parada que só você destrava (kind 'stuck', ver ownAlerts): revisão que não começou ou ficou sem veredito, ajuste que não chega, card que terminou sem editar código
 * (`Task.noCode`, `humanAction` 'decide': cancelar com motivo ou devolver ao responsável; `stuck.noCode` e `stuck.summary` levam a marca e o que o responsável disse).
 * Com `humanAction` null é só o aviso da espera do limite da ficha (id `stuck:<id>:fallback`): some sozinho quando o limite baixa.
 * Nada é gravado: some quando a tarefa anda (revisão começa, veredito, ajuste enviado ou reenviado, mensagem na conversa do card sem código) ou é encerrada. O alvo é a tarefa.
 */
export function stuckInboxItem({ task, state }: OwnAlert, w: Place): InboxItem {
  const noCode = !!task.noCode && state.humanAction === 'decide';
  return {
    id: `stuck:${task.id}:${state.humanAction ?? 'fallback'}`,
    kind: 'stuck',
    ...w,
    summary: `“${task.title}” está parada: ${state.reason}`,
    at: state.since,
    stuck: {
      taskId: task.id,
      taskTitle: task.title,
      reason: state.reason,
      selfHeals: state.selfHeals,
      humanAction: state.humanAction,
      since: state.since,
      ...(noCode && { noCode: true as const, ...(task.noCode!.summary && { summary: task.noCode!.summary }) }),
    },
  };
}

/**
 * Cartão esquecido (ver notStartedTasks): tarefa em "a fazer" que não começou nem entrou na fila há dias. Nada é gravado: some quando
 * ela começa, é cancelada, editada ou apagada. As ações são as rotas de sempre (começar e cancelar a tarefa, só pela tela). O alvo é a
 * tarefa no quadro (sem conversa, `sessionId` vazio); o item não leva `staffId` (não pinta o cartão do funcionário), o responsável vem em `notStarted`.
 */
export function notStartedInboxItem(n: NotStartedTask, w: Omit<Place, 'staffId'>): InboxItem {
  return {
    id: `notStarted:${n.task.id}`,
    kind: 'notStarted',
    ...w,
    staffId: null,
    summary: `“${n.task.title}” está em A fazer há ${n.days} dias e não começou`,
    at: n.task.updatedAt,
    notStarted: { taskId: n.task.id, taskTitle: n.task.title, days: n.days, staffId: n.task.staffId },
  };
}

/** O texto do follow-up na caixa é cortado (o inteiro está em `Task.followUps`); o resumo de uma linha vai no `summary`. */
const FOLLOWUP_TEXT_MAX = 600;
const FOLLOWUP_LINE_MAX = 140;

/**
 * Follow-up de revisão que espera o usuário (ver followUpAlerts): a tarefa foi pedida por ele, ou o gestor não pôde receber. Nada é gravado para o item: some quando o
 * follow-up é resolvido (virou tarefa ou descartado, pela rota `followup/:id/resolve` da tarefa, ou criado o card pela `followup/:id/card`, que a tela chama como dono).
 * O alvo é a conversa de trabalho da tarefa (`sessionId`, para a tela mostrar o achado como balão nela) quando o usuário pediu a tarefa e ela tem conversa; senão (pedida por um gestor
 * cujo aviso se perdeu, ou ainda sem conversa) é a tarefa no quadro, `sessionId` vazio. Sem `staffId` (não é conversa esperando: o cartão de ninguém fica amarelo), o autor vem em
 * `followUp`. `byName` vazio se a ficha dele sumiu; `staffName` é o de quem o revisor sugeriu para fazer (vazio se não sugeriu ou se a ficha sumiu).
 */
export function followUpInboxItem({ task, followUp: f }: FollowUpAlert, w: Omit<Place, 'staffId'>, byName: string, staffName = ''): InboxItem {
  const line = (f.title ?? f.text.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  const first = line.length > FOLLOWUP_LINE_MAX ? `${line.slice(0, FOLLOWUP_LINE_MAX - 1)}…` : line;
  // O usuário pediu a tarefa (sem gestor) e ela tem conversa: o achado é um balão dessa conversa. Com `sessionId` já dado em `w`, vale o dado.
  const sessionId = w.sessionId || (!task.requestedBy && task.sessionId ? task.sessionId : '');
  return {
    id: `followup:${task.id}:${f.id}`,
    kind: 'followUp',
    ...w,
    sessionId,
    staffId: null,
    summary: `“${task.title}” tem um follow-up de ${byName || 'revisão'} esperando você: ${first}`,
    at: f.at,
    followUp: {
      taskId: task.id,
      taskTitle: task.title,
      followUpId: f.id,
      by: f.by,
      byName,
      text: f.text.length > FOLLOWUP_TEXT_MAX ? `${f.text.slice(0, FOLLOWUP_TEXT_MAX - 1)}…` : f.text,
      at: f.at,
      ...(f.recommendation && { recommendation: f.recommendation }),
      ...(f.title && { title: f.title }),
      ...(f.impact && { impact: f.impact }),
      ...(f.size && { size: f.size }),
      ...(f.staffId && { staffId: f.staffId, staffName }),
    },
  };
}

/**
 * O commit automático de uma tarefa pronta que falhou, foi parcial ou não coube (ver commitAlerts). Reaproveita o kind 'error' (a tela já o ignora por `/api/errors/dismiss`, que aceita o id
 * `commit:<projeto>:<tarefa>`). Nada é gravado para o item além do `ack` da tarefa: some ao ignorar. O alvo é a tarefa no quadro (sem conversa, sem `staffId`: não pinta o cartão de ninguém).
 * Os caminhos e o motivo são texto de arquivo e de erro do git: a tela os mostra como texto puro.
 */
export function commitInboxItem({ task, commit: c }: CommitAlert, w: Omit<Place, 'staffId'>): InboxItem {
  const what =
    c.status === 'failed'
      ? `o commit automático falhou: ${c.note}`
      : c.status === 'partial'
        ? `o commit automático foi parcial (${c.sha}): de fora ${leftText(c.left)}`
        : `o commit automático não foi feito: ${c.note}${c.left.length ? `; de fora ${leftText(c.left)}` : ''}`;
  return {
    id: `commit:${w.projectId}:${task.id}`,
    kind: 'error',
    ...w,
    staffId: null,
    summary: `“${task.title}” ficou pronta, mas ${what}`,
    at: c.at,
    autoCommit: { taskId: task.id, taskTitle: task.title, status: c.status },
  };
}

/** A ação barrada como o `ChatManager.deniedHits` a guarda (a negação mostrada, a contagem do turno e a tarefa). */
export interface DeniedHit {
  id: string;
  sessionId: string;
  taskId: string;
  taskTitle: string;
  shown: DeniedInfo;
  count: number;
  tools: string[];
  at: string;
}

/**
 * Ação barrada numa conversa de tarefa (ver `ChatManager.noteDenied`): um item por conversa e por turno, com a ferramenta, quem barrou, o motivo e a dica de destrave
 * (o contrato está em `InboxItem.denied`). O `summary` é o texto do aviso no chat, em pt-BR (a tela monta o dela a partir de `denied`). Dispensa: `POST /api/denied/dismiss`.
 * O alvo é a conversa (rola ao fim dela: o aviso não aponta um balão).
 */
export function deniedInboxItem(d: DeniedHit, w: Place): InboxItem {
  const { shown } = d;
  return {
    id: d.id,
    kind: 'denied',
    ...w,
    summary: `“${d.taskTitle}”: ${shown.text}${d.count > 1 ? ` (+${d.count - 1} neste turno)` : ''}`,
    at: d.at,
    denied: {
      taskId: d.taskId,
      taskTitle: d.taskTitle,
      tool: shown.tool,
      layer: shown.layer,
      ...(shown.reason && { reason: shown.reason }),
      hint: shown.hint,
      text: shown.text,
      count: d.count,
      tools: d.tools,
    },
  };
}

/** A fila desligada como o `ChatManager.guardOffHits` a guarda (a tarefa e o `hooks.json` da conta). */
export interface HeavyGuardOffHit {
  id: string;
  sessionId: string;
  taskId: string;
  taskTitle: string;
  file: string;
  at: string;
}

/**
 * A conversa de tarefa roda sem a fila de validação pesada porque a conta do Codex tem `hooks.json` (ver `ChatManager.noteGuardOff`): um item por conversa, kind 'error' (como o do commit
 * automático: a tela já o ignora por `/api/errors/dismiss`, que aceita o id `guardoff:`). O `summary` é pt-BR e sem o caminho (o contrato está em `InboxItem.heavyGuardOff`, onde ele vai
 * só para a tela). O alvo é a conversa.
 */
export function heavyGuardOffInboxItem(g: HeavyGuardOffHit, w: Place): InboxItem {
  return {
    id: g.id,
    kind: 'error',
    ...w,
    summary: `“${g.taskTitle}” roda sem a fila de validação pesada: a conta do Codex tem um hooks.json. Apague ou renomeie o arquivo para a fila voltar na próxima mensagem; até lá a suíte completa roda sem esperar a vez.`,
    at: g.at,
    heavyGuardOff: { taskId: g.taskId, taskTitle: g.taskTitle, file: g.file },
  };
}

/**
 * O sandbox do Codex no Windows não abre por causa da política de senha (ver `CodexPasswordPolicy`): um item por máquina, kind 'error' (a tela já o ignora por `/api/errors/dismiss`, que aceita
 * o id `codexsandbox:`). Sem projeto nem conversa, como o aviso de consumo da conta. O `summary` é pt-BR e traz o comando, o "como administrador" e a nota do domínio; o contrato está em
 * `InboxItem.codexSandbox`. O Club só avisa: nunca roda o comando.
 */
export function codexSandboxInboxItem(a: PasswordPolicyAlert): InboxItem {
  const age = a.minPasswordAgeDays;
  const what =
    age !== null && age > 0
      ? `O sandbox do Codex não consegue atualizar a senha dos usuários locais dele porque a política de senha do Windows exige duração mínima de ${age} ${age === 1 ? 'dia' : 'dias'}: todo comando de terminal do Codex falha. Abra o PowerShell como administrador e rode ${PASSWORD_POLICY_FIX}.`
      : age === 0
        ? `O sandbox do Codex não consegue criar ou atualizar os usuários locais dele (código 2224/2245): todo comando de terminal do Codex falha. A duração mínima da senha já está em 0, então o motivo é outra regra de senha do Windows (tamanho mínimo, histórico): confira com net accounts.`
        : `O sandbox do Codex não consegue criar ou atualizar os usuários locais dele (código 2224/2245): todo comando de terminal do Codex falha. A causa mais comum é a duração mínima da senha: confira com net accounts e, se for maior que 0, abra o PowerShell como administrador e rode ${PASSWORD_POLICY_FIX}.`;
  return {
    id: PASSWORD_POLICY_ID,
    kind: 'error',
    projectId: '',
    projectName: '',
    sessionId: '',
    staffId: null,
    name: 'Sandbox do Codex',
    summary: age === 0 ? what : `${what} Em computador de domínio, a política de grupo pode desfazer a mudança.`,
    at: a.at,
    codexSandbox: { cause: 'password-policy', source: a.source, minPasswordAgeDays: age, command: PASSWORD_POLICY_FIX, domainNote: true },
    // A política passou a 0 depois de falhar (ver `CodexPasswordPolicy.resolve`): o item segue na caixa como resolvido, sem contar como pendência.
    ...(a.resolvedAt && { resolvedAt: a.resolvedAt }),
  };
}

/** O segredo como o `ChatManager.secretHits` o guarda: `file` e `cwd` (como o motor deu) ficam no servidor e saem daqui só como caminho do projeto. */
export interface SecretHit {
  id: string;
  sessionId: string;
  label: string;
  kind: SecretKind;
  detail?: string;
  verdict: SecretVerdict;
  reason: SecretReason;
  hint?: SecretHint;
  source?: SecretSource;
  file?: string;
  /** A linha do segredo em `file` (1 = primeira), quando o servidor a achou lendo o arquivo (ver `locateSecretFile`). */
  line?: number;
  cwd?: string;
  at: string;
}

/**
 * Segredo achado numa conversa. `file` só vai quando o arquivo cai dentro do projeto (`projectDir`, a pasta que o `files/read` abre): relativo,
 * com "/", nunca absoluto nem com o valor. `fileBlocked` vem da mesma checagem da leitura (`isBlockedRel`): .env, chave e certificado não abrem
 * pela tela. Sem `projectDir` (projeto desconhecido) ou com caminho que não vale, o item sai sem arquivo.
 */
export function secretInboxItem(s: SecretHit, w: Place, projectDir: string | null): InboxItem {
  const file = s.file && s.cwd && projectDir ? secretFile(s.file, s.cwd, projectDir) : null;
  return {
    id: `secret:${s.id}`,
    kind: 'secret',
    ...w,
    // `summary` é o fallback em pt-BR; o cliente monta a frase no idioma da página a partir de `secret`.
    summary: secretAlert(s.label, s.source),
    // `summary` e a extensão não levam `verdict`, `reason` nem `hint`: a dica mascarada é só para a tela do Club (ver `SecretHint`).
    secret: {
      kind: s.kind,
      ...(s.detail && { detail: s.detail }),
      ...(s.source && { source: s.source }),
      verdict: s.verdict,
      reason: s.reason,
      ...(s.hint && { hint: s.hint }),
      ...(file && { file, ...(s.line && { line: s.line }), ...(isBlockedRel(file) && { fileBlocked: true as const }) }),
    },
    at: s.at,
  };
}

/**
 * Tira `verdict`, `reason` e `hint` do aviso de segredo: quem não é a tela do Club (um agente ou o curl de alguém, sem o cookie do pareamento) não
 * recebe o palpite nem a dica mascarada do valor.
 */
export function withoutSecretHint(items: InboxItem[]): InboxItem[] {
  return items.map((i) => {
    if (!i.secret) return i;
    const { verdict: _v, reason: _r, hint: _h, ...secret } = i.secret;
    return { ...i, secret };
  });
}

export function questionInboxItem(q: { sessionId: string; text: string; at: string; itemId?: string }, w: Place): InboxItem {
  return {
    id: `question:${q.sessionId}:${q.at}`,
    kind: 'waiting',
    ...w,
    summary: `perguntou: ${q.text}`,
    at: q.at,
    ...(q.itemId && { itemId: q.itemId }),
    quote: q.text,
  };
}
