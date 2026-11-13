import type { ChatItem } from '../../shared/model';

// Ação cortada pelo reinício: a ferramenta que estava rodando quando o processo da conversa caiu (sem resultado no fim da
// conversa). Se ela mexe fora do projeto (servidor, push, deploy, site, API), ninguém sabe se chegou a acontecer: a conversa
// não volta sozinha (o funcionário poderia repetir), vai para "precisa de mim" (ver TurnCapHit `restart`). O que fica no
// projeto (editar arquivo, rodar teste) se confere pelo git: retoma como sempre.
// Na dúvida, conta como efeito fora: o custo do engano é um clique seu para seguir.

/** Comando de terminal que sai do projeto: rede, servidor, publicação, nuvem, banco. */
const EXTERNAL_COMMAND =
  /\b(?:git\s+push|ssh|scp|sftp|rsync|ftp|curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|deploy|publish|release|docker\s+(?:push|login|run|stop|rm|compose\s+(?:up|down|push|stop|rm))|kubectl|helm|terraform\s+(?:apply|destroy|import)|pulumi\s+up|vercel|netlify|flyctl|fly\s+deploy|wrangler|firebase|gh\s+(?:pr|release|issue|repo|api|workflow|secret)|aws|gcloud|psql|mysql|mongosh|redis-cli|sqlcmd)\b/i;

/**
 * Ferramenta de MCP que só lê (pelo nome, sem o prefixo do serviço: `ssh_ler` → `ler`, `browser_snapshot` → `snapshot`).
 * O resto conta como efeito fora: clicar, digitar, enviar, executar, subir arquivo.
 */
const READ_ONLY_MCP =
  /^(?:get|list|listar|read|ler|search|find|query|describe|view|show|fetch|count|status|snapshot|take_screenshot|screenshot|console|network|processos|docker_(?:ps|logs|stats)|journal|servico|download|tabs_context|page_text|wait|consult|ask|perguntar)/i;

/** A ferramenta, com esta entrada, mexe fora do projeto? */
export function hasExternalEffect(name: string, input: string): boolean {
  if (name === 'Bash' || name === 'PowerShell') return EXTERNAL_COMMAND.test(input);
  if (name.startsWith('mcp__')) {
    const tool = name.slice(name.lastIndexOf('__') + 2).replace(/^(?:ssh|ftp|gpt|browser)_/i, '');
    return !READ_ONLY_MCP.test(tool);
  }
  return false;
}

const MAX_ACTION = 80;

/**
 * A ação com efeito fora do projeto que ficou sem resultado no fim da conversa (o turno foi cortado nela), em resumo curto;
 * senão, null. Só olha depois da última mensagem do usuário: o que veio antes já terminou.
 */
export function externalCut(items: readonly ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'user') break;
    if (it.kind === 'tool' && it.result === null && hasExternalEffect(it.name, it.input)) {
      const text = (it.summary || it.name).replace(/\s+/g, ' ').trim();
      return text.length > MAX_ACTION ? `${text.slice(0, MAX_ACTION - 1)}…` : text;
    }
  }
  return null;
}
