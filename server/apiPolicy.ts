// Quem pode fazer POST sem ser o navegador pareado (um funcionário pela API: x-myco, sem Origin). Lista fechada: só o
// que a ficha manda usar (server/staff/ficha.ts). Toda rota nova nasce "só pelo Claudio’s Club"; liberar para os
// funcionários é decisão explícita, aqui.

const ID = '[A-Za-z0-9-]+';

const STAFF_POSTS: RegExp[] = [
  // Passar tarefa a quem reporta a ele (a rota confere requestedBy).
  new RegExp(`^/api/projects/${ID}/tasks$`),
  // Contratar subfuncionário (o serviço exige gestor que pode contratar e limita a autonomia).
  new RegExp(`^/api/projects/${ID}/staff$`),
  // Mensagem a quem ele contratou.
  new RegExp(`^/api/projects/${ID}/chat/send$`),
  // Despertador da própria conversa (agendar e desfazer; o "Cancelar" do aviso, user-cancel, fica de fora).
  new RegExp(`^/api/projects/${ID}/chat/${ID}/wake(?:/cancel)?$`),
  // Encerrar temporário que ele contratou (a rota confere hiredBy).
  new RegExp(`^/api/projects/${ID}/staff/${ID}/done$`),
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
  if (!allowed) return { status: 403, error: 'a sandbox do Codex não pode usar esta rota (só tarefas, contratar, mensagem, despertador e encerrar quem você contratou)' };
  const target = PROJECT_OF.exec(pathname)?.[1];
  if (target && target !== projectId) return { status: 403, error: 'a sandbox do Codex só fala com o projeto da própria conversa' };
  return null;
}
