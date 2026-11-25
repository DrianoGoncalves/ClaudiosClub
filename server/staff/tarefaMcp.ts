import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { TAREFA_MCP_NAME } from '../../shared/model';
import { ROOT } from '../root';

// MCP de tarefa do Claudio’s Club: um servidor stdio (JSON-RPC por linha) que a conversa do Claude sobe para cancelar uma tarefa sem passar pelo terminal. O curl
// para `.../tasks/<id>/cancel` é negado como "destrutivo" pelo classificador do modo auto (e vira pedido de permissão nos outros modos), e o card que todos
// concordam em cancelar ficava preso. Este MCP é só OUTRO CAMINHO para as MESMAS rotas HTTP (`cancel`, `cancel-request`, `cancel-request/refuse`), com o
// `MYCO_TOKEN` da própria conversa: quem decide é o servidor (token, quem pediu, responsável atual, pedido pending, coluna), e o erro dele (403, 409…) volta
// como está. O MCP não escolhe quem é: o token sai do ambiente que o Club deu à conversa, nunca do modelo nem da linha de comando.
//
// Sem o SDK oficial de propósito (ver ftpMcp.ts): o protocolo usado é pequeno: initialize, ping, tools/list e tools/call.

export { TAREFA_MCP_NAME };
export const TAREFA_TOOLS = ['tarefa_cancelar', 'tarefa_pedir_cancelamento', 'tarefa_recusar_cancelamento'] as const;
export type TarefaTool = (typeof TAREFA_TOOLS)[number];

const VERSION = '1.0.0';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Id de projeto e de tarefa como as rotas os leem (`ID` em server/index.ts): nada de barra, ponto ou `..` que mude o caminho. */
const SAFE_ID = /^[A-Za-z0-9-]{1,200}$/;
/** Caracteres de controle (tab e quebra de linha passam: o servidor limpa o motivo para uma linha). */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
/** O motivo, como `reasonRequest` o aceita (até 2000 caracteres). */
const REASON_MAX = 2000;
/** A rota espera a vez do funcionário até 8 s (LOCK_DEADLINE_MS) e o pedido de cancelamento ainda tenta entregar: 20 s cobrem os dois. */
export const TAREFA_TIMEOUT_MS = 20_000;
/** 503 = a vez de quem faz a tarefa estava ocupada e NADA foi gravado (o servidor diz que repetir é seguro): até 2 repetições. */
const BUSY_RETRIES = 2;
const BUSY_WAIT_MS = 2_000;

export class TarefaError extends Error {}

/** Cada ferramenta e a rota que ela chama (o sufixo depois de `/tasks/<id>`). Nenhuma outra rota é alcançável por aqui. */
const ROUTE: Record<TarefaTool, { path: string; what: string }> = {
  tarefa_cancelar: { path: 'cancel', what: 'do cancelamento' },
  tarefa_pedir_cancelamento: { path: 'cancel-request', what: 'do pedido de cancelamento' },
  tarefa_recusar_cancelamento: { path: 'cancel-request/refuse', what: 'da recusa' },
};

export interface TarefaMcpOptions {
  /** Endereço do Claudio’s Club (http://127.0.0.1:<porta>): vem da linha de comando montada pelo Club. Só loopback: o token nunca sai da máquina. */
  api: string;
  /** O projeto da conversa (o do token: a rota de outro projeto é recusada pelo gate). */
  projectId: string;
  /** O token da conversa; padrão `MYCO_TOKEN` do ambiente (lido a cada chamada). Os testes trocam. */
  token?: () => string | undefined;
  /** `fetch`; os testes trocam. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Espera antes de repetir um 503; os testes zeram. */
  busyWaitMs?: number;
}

/** O endereço do Club como base de URL, ou lança se não é http em loopback. */
function apiBase(api: string): string {
  let u: URL;
  try {
    u = new URL(api);
  } catch {
    throw new TarefaError('endereço do Claudio’s Club inválido');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'http:' || !loopback || u.username || u.password) throw new TarefaError('o endereço do Claudio’s Club tem de ser http em loopback (127.0.0.1)');
  return `${u.protocol}//${u.host}`;
}

/** O que a resposta de sucesso diz da tarefa, numa linha (nunca a tarefa inteira). */
function summaryOf(tool: TarefaTool, id: string, body: unknown): string {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const t = (raw.task && typeof raw.task === 'object' ? raw.task : raw) as { status?: unknown; cancelRequest?: { status?: unknown } };
  const status = typeof t.status === 'string' ? t.status : '?';
  const cr = typeof t.cancelRequest?.status === 'string' ? t.cancelRequest.status : null;
  const head = { tarefa_cancelar: 'cancelada', tarefa_pedir_cancelamento: 'pedido de cancelamento enviado', tarefa_recusar_cancelamento: 'recusa gravada' }[tool];
  return `${head}: ${id} (status ${status}${cr ? `; pedido de cancelamento ${cr}` : ''})`;
}

export function createTarefaMcp(opts: TarefaMcpOptions) {
  const base = apiBase(opts.api);
  if (!SAFE_ID.test(opts.projectId)) throw new TarefaError('projeto inválido');
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TAREFA_TIMEOUT_MS;
  const busyWait = opts.busyWaitMs ?? BUSY_WAIT_MS;
  const tokenOf = opts.token ?? (() => process.env.MYCO_TOKEN);

  async function run(tool: TarefaTool, args: Record<string, unknown>): Promise<string> {
    const id = typeof args.tarefa === 'string' ? args.tarefa.trim() : '';
    if (!SAFE_ID.test(id) || id.length > 40) throw new TarefaError('informe o id da tarefa (`tarefa`, o id que o aviso mostra, como t-1a2b3c)');
    const reason = typeof args.motivo === 'string' ? args.motivo.trim() : '';
    if (!reason) throw new TarefaError(`informe o motivo ${ROUTE[tool].what} (\`motivo\`, em uma frase)`);
    if (reason.length > REASON_MAX || CONTROL.test(reason)) throw new TarefaError(`o motivo ${ROUTE[tool].what} passa de ${REASON_MAX} caracteres ou tem caractere de controle`);
    const token = tokenOf();
    if (!token) throw new TarefaError('esta conversa não tem MYCO_TOKEN no ambiente do MCP: use o curl da ficha, com $MYCO_TOKEN');
    const url = `${base}/api/projects/${opts.projectId}/tasks/${id}/${ROUTE[tool].path}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'x-myco': '1', 'x-myco-token': token, 'content-type': 'application/json' },
          body: JSON.stringify({ reason }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        // Sem resposta: a rota pode ter gravado. Não repete (cancelar de novo daria 409 e esconderia o que houve); manda conferir.
        throw new TarefaError(
          timedOut
            ? 'o Claudio’s Club não respondeu a tempo: o pedido pode ter sido gravado, confira o estado da tarefa antes de repetir'
            : 'não consegui falar com o Claudio’s Club (ele está no ar?): nada foi enviado; tente de novo em instantes ou use o curl da ficha',
        );
      }
      const text = await res.text().catch(() => '');
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // resposta que não é JSON: só o status vale
      }
      if (res.ok) return summaryOf(tool, id, body);
      if (res.status === 503 && attempt < BUSY_RETRIES) {
        await new Promise((r) => setTimeout(r, busyWait));
        continue;
      }
      const said = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : '';
      // O mesmo erro da rota (403, 409, 404…), com o status na frente: nada foi mudado.
      throw new TarefaError(`${res.status}: ${(said || res.statusText || 'recusado pelo Claudio’s Club').slice(0, 600)}`);
    }
  }

  async function callTool(name: TarefaTool, args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError && { isError: true as const }) });
    if (!args || typeof args !== 'object' || Array.isArray(args)) return text('argumentos inválidos: esperava um objeto', true);
    try {
      return text(await run(name, args as Record<string, unknown>));
    } catch (err) {
      // Erro nosso e da rota já vêm em palavras; o resto, sem detalhe (pode ter caminho interno).
      return text(err instanceof TarefaError ? err.message : 'falha inesperada no MCP de tarefa', true);
    }
  }

  type Msg = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const reply = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  /** Uma mensagem JSON-RPC; devolve a resposta, ou null (notificação, ou resposta do cliente). */
  async function handle(raw: unknown): Promise<object | null> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(null, -32600, 'Invalid Request');
    const m = raw as Msg;
    if (!('method' in m) && ('result' in m || 'error' in m)) return null; // resposta do cliente: este servidor não pergunta nada
    const isRequest = 'id' in m && m.id !== null && (typeof m.id === 'string' || typeof m.id === 'number');
    if (typeof m.method !== 'string') return isRequest ? fail(m.id, -32600, 'Invalid Request') : null;
    if (!isRequest) return null; // notifications/initialized, cancelled…
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion;
        return reply(m.id, {
          protocolVersion: typeof asked === 'string' && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: TAREFA_MCP_NAME, version: VERSION },
          instructions: 'Cancela a tarefa que é sua (ou que você pediu e nunca começou), pede o cancelamento de uma que você pediu e já começou, ou recusa um pedido de cancelamento. O Claudio’s Club confere quem você é; o erro dele volta como está.',
        });
      }
      case 'ping':
        return reply(m.id, {});
      case 'tools/list':
        return reply(m.id, { tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (typeof name !== 'string' || !(TAREFA_TOOLS as readonly string[]).includes(name)) return fail(m.id, -32602, `ferramenta desconhecida: ${String(name).slice(0, 60)}`);
        return reply(m.id, await callTool(name as TarefaTool, m.params?.arguments));
      }
      default:
        return fail(m.id, -32601, `método não suportado: ${m.method.slice(0, 60)}`);
    }
  }

  return { handle, callTool };
}

const ARGS = {
  type: 'object',
  properties: {
    tarefa: { type: 'string', description: 'O id da tarefa (como t-1a2b3c), o que o aviso ou a ficha mostra.' },
    motivo: { type: 'string', description: 'O motivo, em uma frase.' },
  },
  required: ['tarefa', 'motivo'],
};

export const TOOLS = [
  {
    name: 'tarefa_cancelar',
    description:
      'Cancela uma tarefa: a SUA (você é o responsável atual, pela conversa dela: o usuário pediu, ou você aceita um pedido de cancelamento, e o pedido fica aceito) ou uma que VOCÊ PEDIU e que nunca começou (ou terminou sem editar código). Tarefa que você pediu e já começou dá 409: use tarefa_pedir_cancelamento. É a mesma rota que o curl `POST .../tasks/<id>/cancel`; o Claudio’s Club confere quem você é e devolve o mesmo erro (403, 409). Cancelar não desfaz o que já foi feito (branch e worktree ficam). Cancele só quando o usuário pedir sem dúvida, ou ao aceitar um pedido de cancelamento; na dúvida, pergunte antes.',
    inputSchema: ARGS,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'tarefa_pedir_cancelamento',
    description:
      'Pede ao responsável o cancelamento de uma tarefa que VOCÊ PEDIU e que já começou. O pedido chega na conversa dele, que aceita (cancelando) ou recusa dizendo por quê; só há um pedido aberto por vez, e recusado só se pede de novo depois de 10 min. Tarefa que nunca começou dá 409: use tarefa_cancelar. É a mesma rota que o curl `POST .../tasks/<id>/cancel-request`.',
    inputSchema: ARGS,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'tarefa_recusar_cancelamento',
    description:
      'Recusa o pedido de cancelamento de uma tarefa que você faz (responsável atual, pela conversa dela), dizendo por quê; quem pediu é avisado e a tarefa segue. Só vale com um pedido esperando decisão (409 sem ele). É a mesma rota que o curl `POST .../tasks/<id>/cancel-request/refuse`.',
    inputSchema: ARGS,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

/** Lê `--chave valor` dos argumentos. */
function argOf(argv: string[], key: string): string | undefined {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Sobe o MCP no stdin/stdout (uma mensagem JSON por linha). Log só no stderr. */
export async function runTarefaMcpStdio(argv: string[], input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const api = argOf(argv, '--api');
  const projectId = argOf(argv, '--project');
  if (!api || !projectId) throw new Error('uso: --api <http://127.0.0.1:porta> --project <id do projeto>');
  const server = createTarefaMcp({ api, projectId });
  const write = (obj: object | null) => {
    if (obj) output.write(JSON.stringify(obj) + '\n');
  };
  for await (const raw of createInterface({ input, crlfDelay: Infinity })) {
    const line = raw.replace(/^﻿/, ''); // BOM (pipe do PowerShell 5.1)
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    // Uma de cada vez: a resposta sai na ordem dos pedidos.
    try {
      write(await server.handle(msg));
    } catch (err) {
      process.stderr.write(`[myco-tarefa] ${err instanceof Error ? err.name : 'erro'}\n`);
      const id = (msg as { id?: unknown })?.id;
      if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
    }
  }
}

// ---- como o funcionário sobe este MCP ----

/** Pacote gerado pelo build (scripts/bundle.ts); sem ele (dev), o .ts pelo tsx. */
export const TAREFA_MCP_BUNDLE = path.join(ROOT, 'dist', 'tarefa-mcp.mjs');
export const TAREFA_MCP_ENTRY = path.join(ROOT, 'server', 'tarefa-mcp.ts');

/** node + o que rodar: o pacote quando o servidor roda empacotado e ele existe; senão o .ts com o tsx. */
export function tarefaMcpCommand(bundled = !import.meta.url.endsWith('.ts')): { command: string; args: string[] } {
  if (bundled && existsSync(TAREFA_MCP_BUNDLE)) return { command: process.execPath, args: [TAREFA_MCP_BUNDLE] };
  const tsx = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return { command: process.execPath, args: ['--import', tsx, TAREFA_MCP_ENTRY] };
}

/** O servidor que a conversa sobe: só o endereço do Club e o projeto (o token vem do ambiente da conversa, nunca daqui). */
export function tarefaMcpServer(o: { api: string; projectId: string }, bundled?: boolean): { command: string; args: string[] } {
  const { command, args } = tarefaMcpCommand(bundled);
  return { command, args: [...args, '--api', o.api, '--project', o.projectId] };
}
