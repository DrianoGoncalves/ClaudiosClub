// A conversa do URL é do projeto do URL? O token de um funcionário só alcança o projeto dele (ver apiPolicy.ts `projectScopeVerdict`), mas o id da conversa
// vem do pedido: com o token certo e o id de uma conversa de OUTRO projeto, o servidor leria o histórico dela ou entregaria a mensagem lá. Quem prova de quem
// é a conversa são os registros do servidor, nunca o pedido.

export interface SessionScopeDeps {
  /** O projeto da conversa aberta agora (null: não está aberta aqui). */
  live: (sessionId: string) => string | null;
  /** A conversa tem transcript na pasta do próprio projeto. */
  transcriptIn: (projectId: string, sessionId: string) => Promise<boolean>;
  /** O projeto da tarefa cuja conversa é esta (trabalho, revisão, deploy); null se não é de tarefa. */
  taskProject: (sessionId: string) => Promise<string | null>;
  /** A conversa está na ficha de alguém do projeto (vale a de worktree do mesmo projeto, cujo transcript fica em outra pasta). */
  staffOwns: (projectId: string, sessionId: string) => Promise<boolean>;
}

/**
 * A conversa `sessionId` é do projeto `projectId`? Aberta agora: vale o projeto com que abriu. Fechada: o transcript na pasta do projeto, a tarefa
 * dela, ou a ficha de alguém do projeto (o histórico do Codex não diz o projeto, então só a ficha e a tarefa o provam). Conversa que ninguém
 * reconhece (ou que não existe) não é do projeto.
 */
export async function sessionInProject(d: SessionScopeDeps, projectId: string, sessionId: string): Promise<boolean> {
  const live = d.live(sessionId);
  if (live) return live === projectId;
  if (await d.transcriptIn(projectId, sessionId)) return true;
  const task = await d.taskProject(sessionId);
  if (task) return task === projectId;
  return d.staffOwns(projectId, sessionId);
}

/**
 * O pedido pode usar a conversa `sessionId` pelo projeto `projectId` do URL? A conversa aberta de outro projeto nunca (nem a tela, que sempre manda o
 * projeto certo). Funcionário (`withToken`): a prova completa de `sessionInProject`, também para conversa fechada. A tela (sem token) não passa por ela:
 * a conversa fechada que ela abre é a que o quadro mostra.
 */
export async function sessionAllowed(d: SessionScopeDeps, withToken: boolean, projectId: string, sessionId: string): Promise<boolean> {
  const live = d.live(sessionId);
  if (live) return live === projectId;
  return !withToken || sessionInProject(d, projectId, sessionId);
}
