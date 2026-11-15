import path from 'node:path';
import { PassThrough } from 'node:stream';
import { argOf, initializeResult, TOOLS } from './gptMcpMeta';

// Entrada preguiçosa do MCP do GPT. O Claude Code sobe este processo em toda conversa em que o Codex está ligado, e o MCP inteiro (gptMcp.ts:
// zod, configuração, motor do Codex…) custa ~25 MB a mais que o node puro, parado. Aqui só se responde ao que não precisa dele (`initialize`,
// `ping` e `tools/list`, de gptMcpMeta.ts); na primeira linha que precisa (um `tools/call`, um método desconhecido, uma linha inválida), carrega o
// MCP inteiro (`loadCore`), entrega a ele essa linha e tudo o que vier depois, e ele passa a falar sozinho: o protocolo e o resultado são os
// mesmos. Empacotado, o resto é outro arquivo (dist/gpt-mcp-core.mjs): num pacote só, o esbuild põe os `import` de pacotes (zod) no topo e eles
// carregariam de qualquer jeito. Só built-ins do node e gptMcpMeta aqui (tests/gptMcp.test.ts confere).

/** O que o MCP inteiro tem a oferecer a esta entrada (gptMcp.ts). */
export interface GptCore {
  runGptMcpStdio(argv: string[], input: NodeJS.ReadableStream, output: NodeJS.WritableStream, o?: { handleSignals?: boolean }): Promise<void>;
}

/** Empacotado, o resto é dist/gpt-mcp-core.mjs (ao lado deste pacote); em dev (tsx), o gptMcp.ts. */
async function loadCoreDefault(): Promise<GptCore> {
  const spec = import.meta.url.endsWith('.ts') ? './gptMcp' : './gpt-mcp-core.mjs';
  return (await import(spec)) as GptCore;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Sobe o MCP no stdin/stdout. Termina quando o stdin acaba (ou, depois de abrir o MCP inteiro, quando ele termina: ver runGptMcpStdio).
 * `loadCore` é o que os testes trocam.
 */
export async function runGptMcpLazy(
  argv: string[],
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  o: { handleSignals?: boolean; loadCore?: () => Promise<GptCore> } = {},
): Promise<void> {
  const loadCore = o.loadCore ?? loadCoreDefault;
  const write = (obj: object) => void output.write(JSON.stringify(obj) + '\n');
  output.on('error', () => {}); // o cliente já foi embora (EPIPE)
  const project = argOf(argv, '--project');
  const root = argOf(argv, '--root') ?? project;
  // Uso errado: o MCP inteiro diz o que falta (o mesmo erro de sempre), já na subida.
  if (!project || !path.isAbsolute(project) || !root || !path.isAbsolute(root)) return (await loadCore()).runGptMcpStdio(argv, input, output, { handleSignals: o.handleSignals });

  /** Responde à linha se não precisa do MCP inteiro; false se precisa. */
  const light = (raw: string): boolean => {
    const line = raw.replace(/^﻿/, '').trim(); // BOM (pipe do PowerShell 5.1)
    if (!line) return true;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return false; // erro de sintaxe: a resposta é a do MCP inteiro
    }
    if (!isObject(msg)) return false;
    const isRequest = (typeof msg.id === 'string' || typeof msg.id === 'number') && typeof msg.method === 'string';
    if (typeof msg.method !== 'string') return !('id' in msg) || 'result' in msg || 'error' in msg; // resposta do cliente: este servidor não pergunta nada
    if (!isRequest) return true; // notificações (inclusive `cancelled`: sem pergunta em andamento, nada a cancelar)
    switch (msg.method) {
      case 'initialize':
        write({ jsonrpc: '2.0', id: msg.id, result: initializeResult(isObject(msg.params) ? msg.params.protocolVersion : undefined) });
        return true;
      case 'ping':
        write({ jsonrpc: '2.0', id: msg.id, result: {} });
        return true;
      case 'tools/list':
        write({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
        return true;
      default:
        return false;
    }
  };

  input.setEncoding('utf8');
  return new Promise<void>((resolve, reject) => {
    let buf = '';
    let opening = false;
    const onEnd = () => resolve();
    const onData = (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); !opening && nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!light(line)) return void open(line);
      }
    };
    /** Abre o MCP inteiro e passa a ele esta linha, o que já chegou e o resto do stdin. */
    async function open(first: string): Promise<void> {
      opening = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.pause();
      let core: GptCore;
      try {
        core = await loadCore();
      } catch {
        // Não abriu (pacote ausente ou quebrado): o pedido falha e o MCP segue respondendo o que sabe; a próxima linha tenta de novo.
        const id = (() => {
          try {
            return (JSON.parse(first) as { id?: unknown }).id;
          } catch {
            return undefined;
          }
        })();
        write({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: 'o MCP do GPT não carregou (rode o build do Claudio’s Club)' } });
        opening = false;
        input.on('data', onData);
        input.once('end', onEnd);
        input.resume();
        return onData('');
      }
      const pass = new PassThrough();
      core.runGptMcpStdio(argv, pass, output, { handleSignals: o.handleSignals }).then(resolve, reject);
      pass.write(first + '\n' + buf);
      buf = '';
      input.pipe(pass); // o fim do stdin fecha `pass`, e o MCP inteiro encerra do seu jeito
    }
    input.on('data', onData);
    input.once('end', onEnd);
  });
}
