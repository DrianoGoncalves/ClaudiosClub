import type { ChatItem, InboxItem, SecretHint, SecretKind, SecretReason, SecretSource, SecretVerdict } from '../shared/model';
import { secretFile } from './chat/codeEdits';
import { secretAlert } from './chat/secrets';
import { isBlockedRel } from './projectFiles';
import type { NotStartedTask, OwnAlert, StuckDependency } from './tasks';

// Avisos da caixa "precisa de mim" que vêm de uma conversa do Claudio’s Club e levam ao ponto dela que
// os causou (`itemId`, `quote`): ao clicar, a conversa rola até lá.

type Place = Pick<InboxItem, 'projectId' | 'projectName' | 'sessionId' | 'staffId' | 'name'>;

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
 * Tarefa parada que só você destrava (kind 'stuck', ver ownAlerts): revisão que não começou ou ficou sem veredito, ajuste que não chega.
 * Com `humanAction` null é só o aviso da espera do limite da ficha (id `stuck:<id>:fallback`): some sozinho quando o limite baixa.
 * Nada é gravado: some quando a tarefa anda (revisão começa, veredito, ajuste enviado ou reenviado) ou é encerrada. O alvo é a tarefa.
 */
export function stuckInboxItem({ task, state }: OwnAlert, w: Place): InboxItem {
  return {
    id: `stuck:${task.id}:${state.humanAction ?? 'fallback'}`,
    kind: 'stuck',
    ...w,
    summary: `“${task.title}” está parada: ${state.reason}`,
    at: state.since,
    stuck: { taskId: task.id, taskTitle: task.title, reason: state.reason, selfHeals: state.selfHeals, humanAction: state.humanAction, since: state.since },
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
      ...(file && { file, ...(isBlockedRel(file) && { fileBlocked: true as const }) }),
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
