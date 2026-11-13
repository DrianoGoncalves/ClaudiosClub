// MCP falso para testar a escrita por MCP à mão (sem dependências). Cadastre na biblioteca de MCPs como servidor stdio:
// comando `node`, argumento o caminho absoluto deste arquivo. Arquivo de notas: env FAKE_MCP_FILE (padrão: pasta temporária,
// fake-mcp-notas.txt). FAKE_MCP_EXTRA=1 põe a ferramenta apagar_notas (simula uma ferramenta nova depois do teste).
import { appendFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const notesFile = () => process.env.FAKE_MCP_FILE || path.join(os.tmpdir(), 'fake-mcp-notas.txt');

const tools = [
  {
    name: 'ler_nota',
    description: 'Devolve o conteúdo do arquivo de notas (vazio se não existir).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'gravar_nota',
    description: 'Acrescenta uma linha ao arquivo de notas.',
    inputSchema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ...(process.env.FAKE_MCP_EXTRA === '1'
    ? [
        {
          name: 'apagar_notas',
          description: 'Apaga o arquivo de notas.',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: false },
        },
      ]
    : []),
];

const text = (t) => ({ content: [{ type: 'text', text: t }] });

async function callTool(name, args) {
  if (name === 'ler_nota') {
    return text(await readFile(notesFile(), 'utf8').catch(() => ''));
  }
  if (name === 'gravar_nota') {
    if (typeof args?.texto !== 'string') throw rpcError(-32602, 'texto obrigatório (string)');
    await appendFile(notesFile(), args.texto.replace(/\r?\n/g, ' ') + '\n');
    return text('gravado');
  }
  if (name === 'apagar_notas' && process.env.FAKE_MCP_EXTRA === '1') {
    await rm(notesFile(), { force: true });
    return text('apagado');
  }
  throw rpcError(-32602, `ferramenta desconhecida: ${name}`);
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const rpcError = (code, message) => new RpcError(code, message);

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(req) {
  const { id, method, params } = req;
  // Notificação (sem id): não responde (ex.: notifications/initialized).
  if (id === undefined) return;
  try {
    let result;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        };
        break;
      case 'tools/list':
        result = { tools };
        break;
      case 'tools/call':
        result = await callTool(params?.name, params?.arguments);
        break;
      case 'ping':
        result = {};
        break;
      default:
        throw rpcError(-32601, `método não encontrado: ${method}`);
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (err) {
    const code = err instanceof RpcError ? err.code : -32603;
    send({ jsonrpc: '2.0', id, error: { code, message: err.message } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  void handle(req);
});
