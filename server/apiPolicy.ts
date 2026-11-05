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
