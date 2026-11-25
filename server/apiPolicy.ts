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
  // Follow-up de revisão: quem revisou (ou fez) a tarefa registra o ajuste posterior (a rota confere o token e que ele revisou ou faz a tarefa), e o gestor que pediu a tarefa o
  // decide: virou card ou descartado (a rota confere o token e quem pediu; o autor e o resto levam 403). Registrar não cria card nem muda a tarefa.
  new RegExp(`^/api/projects/${ID}/tasks/${ID}/followup$`),
  new RegExp(`^/api/projects/${ID}/tasks/${ID}/followup/${ID}/resolve$`),
  // Criar o card do follow-up em um passo (cria a tarefa e marca o follow-up como resolvido): a mesma regra do `resolve` (o gestor que pediu a tarefa, com o token; o resto leva 403).
  new RegExp(`^/api/projects/${ID}/tasks/${ID}/followup/${ID}/card$`),
  // Mandar revisar mesmo assim o card marcado "sem código" (quem pediu a tarefa, com o token; a rota confere que é ele e que o card espera a decisão; o resto leva 403).
  new RegExp(`^/api/projects/${ID}/tasks/${ID}/review-anyway$`),
  // Decidir o plano do card que ele pediu (`planWait`: aprovar ou recusar; quem pediu o card, com o token; `decidePlan` confere que é ele e que o card espera o plano; o responsável, o revisor e o resto levam 403).
  new RegExp(`^/api/projects/${ID}/tasks/${ID}/plan$`),
  // Consultar um funcionário de outro projeto vinculado pelo dono (server/consult/). A rota é do projeto de ORIGEM (o do token: o gate recusa o resto) e a origem e o remetente vêm do token; o vínculo
  // (só a tela grava: `/api/consult/links*` fica FORA desta lista) e os limites são conferidos pelo serviço. A conversa de consulta não tem token, então nunca chega aqui.
  new RegExp(`^/api/projects/${ID}/consult$`),
  // Pausa de versão: ligar (com prazo) e encerrar a que ele ligou. A rota é do projeto do token e o serviço exige o token da conversa e a permissão "Pode versionar e fazer deploy" na ficha (403 sem ela);
  // a pausa comum (`/pause`, `/resume`) fica FORA desta lista: é só da tela.
  new RegExp(`^/api/projects/${ID}/version-pause(?:/end)?$`),
  // Versão com escopo (server/release.ts): publicar (push e PR) e pedir/criar a tag. O serviço exige o token da conversa, a permissão "Pode versionar e fazer deploy", autonomia auto
  // ou sem travas e o modo do projeto que deixa (o padrão, manual, recusa); quem roda o git é o servidor. Abrir, mudar, preparar, descartar e o modo ficam FORA: são só da tela.
  new RegExp(`^/api/projects/${ID}/release/(?:publish|tag)$`),
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

/** GETs liberados à sandbox do Codex: o `health`, a lista de tarefas do próprio projeto (a ficha manda conferir como estão) e o diretório de consulta (só id, nome e cargo; ver server/consult/). */
const SANDBOX_GETS: RegExp[] = [/^\/api\/health$/, new RegExp(`^/api/projects/${ID}/tasks$`), new RegExp(`^/api/projects/${ID}/consult/directory$`), new RegExp(`^/api/projects/${ID}/release$`)];

const PROJECT_OF = new RegExp(`^/api/projects/(${ID})(?:/|$)`);

/** O projeto de uma rota `/api/projects/<id>/…` (null nas outras). */
export function projectOfPath(pathname: string): string | null {
  return PROJECT_OF.exec(pathname)?.[1] ?? null;
}

/**
 * A sandbox do Codex (conversa do projeto `projectId`) pode pedir `method pathname`? `null` = pode. Os POSTs são os mesmos da lista dos
 * funcionários (`staffMayPost`); a rota ainda confere o resto (quem é o gestor, de quem é a conversa).
 */
export function sandboxVerdict(method: string, pathname: string, projectId: string): { status: 403; error: string } | null {
  const allowed = method === 'GET' ? SANDBOX_GETS.some((r) => r.test(pathname)) : method === 'POST' && staffMayPost(pathname);
  if (!allowed) return { status: 403, error: 'a sandbox do Codex não pode usar esta rota (só tarefas, editar tarefa que ainda não começou, ordem da fila, cancelar a própria tarefa ou pedir o cancelamento de uma que você pediu, revisar mesmo assim o card sem código que você pediu, decidir o plano do card que você pediu, follow-up de revisão, consulta a outro projeto vinculado e o diretório dela, contratar, mensagem, despertador, ligar e encerrar a pausa de versão, ler, publicar e pedir a tag da versão e encerrar quem você contratou)' };
  const target = PROJECT_OF.exec(pathname)?.[1];
  if (target && target !== projectId) return { status: 403, error: 'a sandbox do Codex só fala com o projeto da própria conversa' };
  return null;
}

// ---- quem chega por 127.0.0.1 com o token de uma conversa (o funcionário do Claude, ou o do Codex fora da sandbox) ----
//
// Só o próprio projeto: o token diz de qual projeto é a conversa, e o resto da API (outros projetos, quadro, busca, caixa, custos, o stream de
// conversas) não é dele. A sandbox do Codex continua mais estreita (`sandboxVerdict`, conferido antes): esta regra nunca amplia o que ela barra.

/** GETs fora de projeto que quem tem token alcança: só o `health`. */
const TOKEN_GETS: RegExp[] = [/^\/api\/health$/];

export interface ScopeVerdict {
  status: 403;
  /** O motivo curto, para o log da recusa. */
  reason: 'outro-projeto' | 'rota-fora-do-projeto';
  error: string;
}

/** Quem tem o token do projeto `projectId` pode pedir `method pathname`? `null` = pode (a própria árvore `/api/projects/<projectId>/` e o `health`). */
export function projectScopeVerdict(method: string, pathname: string, projectId: string): ScopeVerdict | null {
  const target = projectOfPath(pathname);
  if (target) {
    if (target === projectId) return null;
    return {
      status: 403,
      reason: 'outro-projeto',
      error: `o token da sua conversa é do projeto ${projectId} e só fala com ele: esta rota é de outro projeto. Se precisa de algo de lá, peça ao usuário`,
    };
  }
  if (method === 'GET' && TOKEN_GETS.some((r) => r.test(pathname))) return null;
  return {
    status: 403,
    reason: 'rota-fora-do-projeto',
    error: `com o token da sua conversa você alcança só /api/projects/${projectId}/… e /api/health; esta rota é de fora do seu projeto. Se precisa dela, peça ao usuário`,
  };
}

// ---- GET sem token (a tela e o curl à mão) ----
//
// O GET da tela não manda `Origin`: o que a distingue de um curl é o cookie do pareamento (ver gate.ts). Sem ele e sem token de projeto, a leitura
// de /api/* é recusada, fora estes: o servidor está de pé (`health`: o vigia, o `daily` e a página de reinício perguntam sem cookie). O resto do
// pareamento (GET /api/pair com o código, POST request/claim) é resolvido antes, em pairing.ts `admit`.

/** GETs de /api/* que passam sem cookie e sem token. */
const OPEN_GETS: RegExp[] = [/^\/api\/health$/];

/** O GET em `pathname` passa sem o cookie do pareamento e sem token? */
export function anonymousGetMay(pathname: string): boolean {
  return OPEN_GETS.some((r) => r.test(pathname));
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
