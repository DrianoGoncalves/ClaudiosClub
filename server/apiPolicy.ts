// Quem pode fazer POST sem ser o navegador pareado (um funcionário pela API: x-myco, sem Origin). Lista fechada: só o
// que a ficha manda usar (server/staff/ficha.ts). Toda rota nova nasce "só pelo Claudio’s Club"; liberar para os
// funcionários é decisão explícita, aqui.

const ID = '[A-Za-z0-9-]+';

const STAFF_POSTS: RegExp[] = [
  // Passar tarefa a quem reporta a ele (a rota confere requestedBy).
  new RegExp(`^/api/projects/${ID}/tasks$`),
  // Editar tarefa que ele pediu (ou de quem reporta a ele) enquanto está em Aguardar ou A fazer (a rota exige o token e confere quem pediu e a coluna).
  new RegExp(`^/api/projects/${ID}/tasks/${ID}$`),
  // Contratar subfuncionário (o serviço exige gestor que pode contratar e limita a autonomia).
  new RegExp(`^/api/projects/${ID}/staff$`),
  // Mensagem a quem ele contratou.
  new RegExp(`^/api/projects/${ID}/chat/send$`),
  // Despertador da própria conversa (agendar e desfazer; o "Cancelar" do aviso, user-cancel, fica de fora).
  new RegExp(`^/api/projects/${ID}/chat/${ID}/wake(?:/cancel)?$`),
  // Encerrar temporário que ele contratou (a rota confere hiredBy).
  new RegExp(`^/api/projects/${ID}/staff/${ID}/done$`),
  // Responder à dúvida de uma tarefa que ele pediu (a rota confere o gestor e a conversa dele).
  new RegExp(`^/api/projects/${ID}/tasks/${ID}/answer$`),
  // Cancelar a própria tarefa quando o usuário pede (a rota confere que o token é o da conversa atual da tarefa). Reabrir e as ações de
  // quem espera uma cancelada ficam de fora: são só da tela. A sandbox do Codex usa esta mesma lista nos POSTs (ver sandboxVerdict).
  new RegExp(`^/api/projects/${ID}/tasks/${ID}/cancel$`),
  // Pedido de cancelamento de tarefa que já começou (quem a pediu, com o token) e recusa dele (o responsável, pela conversa atual da tarefa). A rota
  // `cancel` acima também serve a quem pediu a tarefa que nunca começou. O revisor não cancela nem pede: o serviço confere o token e quem pediu.
  new RegExp(`^/api/projects/${ID}/tasks/${ID}/cancel-request(?:/refuse)?$`),
  // Ordem da fila: o gestor sobe ou desce os cards que pediu, e o responsável só sugere (a rota confere o token, quem pediu e quem faz; o resto é 403).
  new RegExp(`^/api/projects/${ID}/tasks/${ID}/order$`),
];

/** O POST em `pathname` pode vir de um funcionário pela API? */
export function staffMayPost(pathname: string): boolean {
  return STAFF_POSTS.some((r) => r.test(pathname));
}

// ---- quem chega pela sandbox do Codex (socket 127.0.0.2, ver server/callers.ts) ----
//
// Só o que a ficha do Codex manda usar, e só no projeto da própria conversa. Lista fechada, de leitura e de escrita: nada de config, ficha,
// projetos, arquivos, git, terminal, importar, anexos, conversas dos outros, quadro, busca ou fichas de outros projetos. Quem chama sem estar nela
// recebe 403 (os GETs que sobram expõem segredos, conversas ou fichas de outros projetos, e os POSTs mudam coisas).

/** GETs liberados à sandbox do Codex: o `health` e a lista de tarefas do próprio projeto (a ficha manda conferir como estão). */
const SANDBOX_GETS: RegExp[] = [/^\/api\/health$/, new RegExp(`^/api/projects/${ID}/tasks$`)];

const PROJECT_OF = new RegExp(`^/api/projects/(${ID})(?:/|$)`);

/**
 * A sandbox do Codex (conversa do projeto `projectId`) pode pedir `method pathname`? `null` = pode. Os POSTs são os mesmos da lista dos
 * funcionários (`staffMayPost`); a rota ainda confere o resto (quem é o gestor, de quem é a conversa).
 */
export function sandboxVerdict(method: string, pathname: string, projectId: string): { status: 403; error: string } | null {
  const allowed = method === 'GET' ? SANDBOX_GETS.some((r) => r.test(pathname)) : method === 'POST' && staffMayPost(pathname);
  if (!allowed) return { status: 403, error: 'a sandbox do Codex não pode usar esta rota (só tarefas, editar tarefa que ainda não começou, ordem da fila, cancelar a própria tarefa ou pedir o cancelamento de uma que você pediu, contratar, mensagem, despertador e encerrar quem você contratou)' };
  const target = PROJECT_OF.exec(pathname)?.[1];
  if (target && target !== projectId) return { status: 403, error: 'a sandbox do Codex só fala com o projeto da própria conversa' };
  return null;
}

// ---- a extensão do Chrome (server/extension/, ver gate.ts) ----
//
// Só estas rotas, com o método exato. O Origin `chrome-extension://…` é o da extensão; o token dela (pareado) é conferido no gate. Nenhuma
// rota da tela ou dos funcionários entra aqui: a extensão não vê o resto da API.

export const EXT_PREFIX = '/api/ext/';

const EXTENSION_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> = [
  { method: 'POST', path: '/api/ext/v1/pair' },
  { method: 'GET', path: '/api/ext/v1/inbox' },
  { method: 'GET', path: '/api/ext/v1/projects' },
  { method: 'POST', path: '/api/ext/v1/tasks' },
];

/** A extensão pode pedir `method pathname`? Lista fechada, sem prefixo nem barra final. */
export function extensionMay(method: string, pathname: string): boolean {
  return EXTENSION_ROUTES.some((r) => r.method === method && r.path === pathname);
}
