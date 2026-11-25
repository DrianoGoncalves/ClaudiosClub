import { TAREFA_MCP_NAME, type StaffProfile } from '../../shared/model';
import { codexMcpAccess } from './mcpAccess';
import type { TarefaTool } from './tarefaMcp';

// Os textos que mandam cancelar uma tarefa (aviso de pedido de cancelamento, "sem código", parada pelo erro do motor, a linha da tarefa, o aviso de duplicata
// e a seção da ficha de quem pede tarefas): no Claude com o MCP `myco-tarefa`, apontam a ferramenta (o curl de cancelar é negado pelo classificador do modo
// auto e vira pedido de permissão nos outros) e deixam o curl como alternativa; no Codex (onde não há classificador) seguem só com o curl. As duas portas chegam
// à mesma rota, então o resultado é o mesmo nos dois motores. A decisão de "tem o MCP" é pela ficha (a conversa de revisão, que não o recebe, usa `FichaContext.tarefa`).

/** O nome da ferramenta como o Claude a vê. */
export const tarefaToolName = (tool: TarefaTool): string => `mcp__${TAREFA_MCP_NAME}__${tool}`;

/** O funcionário (Claude, com o acesso ao `myco-tarefa` ligado na ficha) recebe o MCP? Ver `tarefaLaunchOf`. */
export function tarefaMcpOn(profile: Pick<StaffProfile, 'engine' | 'mcpAccess'> | null | undefined): boolean {
  if (!profile || (profile.engine ?? 'claude') !== 'claude') return false;
  return codexMcpAccess(profile.mcpAccess, TAREFA_MCP_NAME, [], null).attached;
}

/**
 * A mesma frase para a decisão do limite de revisões (`tarefa_decidir_limite`: `tarefa`, `decisao` e `texto`): `decisao` é aceitar, reabrir ou cancelar, e `texto`, o que cada uma pede
 * (justificativa, instrução, motivo). Sem a ferramenta, só o curl.
 */
export function limitWith(use: boolean, taskId: string, decisao: 'aceitar' | 'reabrir' | 'cancelar', texto: string, curl: string): string {
  if (!use) return `com \`${curl}\``;
  return `com a ferramenta \`${tarefaToolName('tarefa_decidir_limite')}\` (\`tarefa\`: \`${taskId}\`, \`decisao\`: \`${decisao}\`, \`texto\`: ${texto}); se ela faltar ou falhar, use o curl \`${curl}\``;
}

/**
 * "com a ferramenta `mcp__myco-tarefa__…` (tarefa, motivo)" seguido do curl como alternativa (`curlNote`: a frase que acompanha o curl, ex.: o token e as aspas), ou
 * só "com `curl`" quando a ferramenta não vale (Codex, acesso desligado, conversa sem o MCP). `use`: o MCP chega a quem vai ler (ver `tarefaMcpOn`).
 */
export function cancelWith(use: boolean, tool: TarefaTool, taskId: string, motivo: string, curl: string, curlNote = ''): string {
  const note = curlNote ? ` ${curlNote}` : '';
  if (!use) return `com \`${curl}\`${note}`;
  return `com a ferramenta \`${tarefaToolName(tool)}\` (\`tarefa\`: \`${taskId}\`, \`motivo\`: ${motivo}); se ela faltar ou falhar, use o curl \`${curl}\`${note}`;
}
