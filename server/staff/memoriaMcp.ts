import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { MEMORIA_MCP_NAME } from '../../shared/model';
import { ROOT } from '../root';
import { memoryDir, memoryFile, writeAtomic } from './store';

// MCP do Claudio’s Club para a memória da própria ficha: um servidor stdio (JSON-RPC por linha) que a conversa em autonomia `plan` sobe para o
// funcionário manter `.myco/staff/<id>.memory.md` e `.myco/staff/<id>.memory/*.md`. Em plan o Claude pede aprovação a cada edição e a sandbox do
// Codex é de só leitura, sem exceção por caminho; este MCP roda fora dela, como o de SSH, e é a única porta de escrita. A ficha dona (`--staff`)
// vem da linha de comando montada pelo Claudio’s Club, nunca do modelo: ele só escolhe o arquivo, e o que não é a memória dessa ficha é recusado.
//
// Sem o SDK oficial de propósito (ver ftpMcp.ts): o protocolo usado é pequeno: initialize, ping, tools/list e tools/call.

export { MEMORIA_MCP_NAME };
export const MEMORIA_TOOLS = ['memoria_gravar', 'memoria_apagar'] as const;
type ToolName = (typeof MEMORIA_TOOLS)[number];

const VERSION = '1.0.0';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** Cada arquivo da memória (a ficha pede uma memória curta: isto só impede um laço de encher o disco). */
export const MEMORIA_MAX_BYTES = 32 * 1024;
/** Arquivos de detalhe na pasta `<id>.memory`. */
export const MEMORIA_MAX_FILES = 100;

const SAFE_ID = /^[a-z0-9-]{1,40}$/;
/** Nome do arquivo de detalhe: minúsculas e hífens, como a ficha manda (`<assunto>.md`). */
const TOPIC = /^[a-z0-9][a-z0-9-]{0,59}\.md$/;
/** Nomes que o Windows trata como dispositivo, com ou sem extensão. */
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;
/** Caracteres de controle (tab e quebra de linha passam). */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export class MemoriaError extends Error {}

const sameFile = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

export interface MemoriaTarget {
  /** Caminho absoluto, já no formato canônico (o de `memoryFile`/`memoryDir`). */
  file: string;
  /** `true` = o índice (`<id>.memory.md`); `false` = um detalhe de `<id>.memory/`. */
  index: boolean;
}

/**
 * O arquivo que a chamada pede, SE for da memória da ficha `staffId`: o índice ou `<assunto>.md` direto na pasta `<id>.memory`. Qualquer outro
 * caminho (memória ou ficha de outra pessoa, `<id>.md`/`<id>.json`, subpasta, fora de `.myco/staff`, absoluto de fora, `..`) lança. Não olha o disco:
 * os links são conferidos em `assertPlain`.
 */
export function memoriaTarget(projectPath: string, staffId: string, arquivo: unknown): MemoriaTarget {
  if (!SAFE_ID.test(staffId)) throw new MemoriaError('ficha inválida');
  if (typeof arquivo !== 'string' || !arquivo.trim() || arquivo.length > 400 || CONTROL.test(arquivo)) throw new MemoriaError('informe o caminho do arquivo da sua memória');
  const index = path.resolve(memoryFile(projectPath, staffId));
  const dir = path.resolve(memoryDir(projectPath, staffId));
  const mine = `o seu índice (\`${path.relative(projectPath, index).replace(/\\/g, '/')}\`) ou \`${path.relative(projectPath, dir).replace(/\\/g, '/')}/<assunto>.md\` (minúsculas e hífens)`;
  // O `..` nem entra: um caminho que "volta" para a própria memória também é recusado, para a regra ser uma só e fácil de conferir.
  if (arquivo.split(/[\\/]/).includes('..')) throw new MemoriaError(`caminho com ".." não vale: só ${mine}`);
  // A barra invertida só separa pasta no Windows; no Linux `path.resolve` a trataria como parte do nome. O modelo escreve com as barras que quiser.
  const want = path.resolve(projectPath, arquivo.replace(/\\/g, '/'));
  if (sameFile(want, index)) return { file: index, index: true };
  const name = path.basename(want);
  if (sameFile(path.dirname(want), dir) && TOPIC.test(name) && !DEVICE.test(name)) return { file: path.join(dir, name), index: false };
  throw new MemoriaError(`só a memória da sua ficha pode ser gravada: ${mine}`);
}

/** Existe? O caminho, se existe, é arquivo comum (ou pasta comum): link e junção são recusados (não saem da pasta da memória). */
async function assertPlain(p: string, kind: 'file' | 'dir'): Promise<boolean> {
  const st = await fs.lstat(p).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!st) return false;
  if (st.isSymbolicLink() || (kind === 'file' ? !st.isFile() : !st.isDirectory())) {
    throw new MemoriaError(`"${path.basename(p)}" não é ${kind === 'file' ? 'um arquivo' : 'uma pasta'} comum (link ou outro tipo): recuso`);
  }
  return true;
}

/** Como fica gravado: quebras LF, sem espaço no fim da linha nem no fim do texto, uma quebra final. */
function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '') + '\n';
}

export interface MemoriaMcpOptions {
  /** Pasta do projeto principal (onde ficam as fichas, também numa worktree). */
  projectPath: string;
  /** A ficha dona desta conversa. */
  staffId: string;
}

export function createMemoriaMcp(opts: MemoriaMcpOptions) {
  const rel = (file: string) => path.relative(opts.projectPath, file).replace(/\\/g, '/');

  async function gravar(args: { arquivo?: unknown; conteudo?: unknown }): Promise<string> {
    const target = memoriaTarget(opts.projectPath, opts.staffId, args.arquivo);
    if (typeof args.conteudo !== 'string' || !args.conteudo.trim()) throw new MemoriaError('informe o conteúdo (texto, não vazio)');
    if (CONTROL.test(args.conteudo)) throw new MemoriaError('a memória aceita só texto (sem caracteres de controle)');
    const text = normalize(args.conteudo);
    if (Buffer.byteLength(text, 'utf8') > MEMORIA_MAX_BYTES) throw new MemoriaError(`o arquivo passa de ${MEMORIA_MAX_BYTES / 1024} KB: resuma (a memória é curta)`);
    const dir = path.dirname(target.file);
    // O índice mora em `.myco/staff`; o detalhe, na pasta da memória (que pode ainda não existir). Link num dos dois: recusado.
    const dirExists = target.index || (await assertPlain(dir, 'dir'));
    const exists = dirExists && (await assertPlain(target.file, 'file'));
    if (!target.index && dirExists && !exists && (await fs.readdir(dir)).length >= MEMORIA_MAX_FILES) {
      throw new MemoriaError(`a pasta da memória já tem ${MEMORIA_MAX_FILES} arquivos: apague os que ficaram velhos`);
    }
    await writeAtomic(target.file, text);
    return `gravado: ${rel(target.file)} (${text.split('\n').length - 1} linhas, ${Buffer.byteLength(text, 'utf8')} bytes)`;
  }

  async function apagar(args: { arquivo?: unknown }): Promise<string> {
    const target = memoriaTarget(opts.projectPath, opts.staffId, args.arquivo);
    if (target.index) throw new MemoriaError('o índice da memória não se apaga: reescreva-o com memoria_gravar');
    await assertPlain(path.dirname(target.file), 'dir');
    if (!(await assertPlain(target.file, 'file'))) throw new MemoriaError(`${rel(target.file)} não existe`);
    await fs.rm(target.file);
    return `apagado: ${rel(target.file)}`;
  }

  const handlers: Record<ToolName, (a: Record<string, unknown>) => Promise<string>> = { memoria_gravar: gravar, memoria_apagar: apagar };

  async function callTool(name: ToolName, args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError && { isError: true as const }) });
    if (!args || typeof args !== 'object' || Array.isArray(args)) return text('argumentos inválidos: esperava um objeto', true);
    try {
      return text(await handlers[name](args as Record<string, unknown>));
    } catch (err) {
      // Erro nosso já vem em palavras; o resto, sem detalhe (pode ter caminho interno).
      return text(err instanceof MemoriaError ? err.message : 'falha inesperada ao gravar a memória', true);
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
          serverInfo: { name: MEMORIA_MCP_NAME, version: VERSION },
          instructions: 'Grava só a memória da sua própria ficha (o índice e os arquivos de detalhe). Nada de segredos nela. Qualquer outro arquivo é recusado.',
        });
      }
      case 'ping':
        return reply(m.id, {});
      case 'tools/list':
        return reply(m.id, { tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (typeof name !== 'string' || !(MEMORIA_TOOLS as readonly string[]).includes(name)) return fail(m.id, -32602, `ferramenta desconhecida: ${String(name).slice(0, 60)}`);
        return reply(m.id, await callTool(name as ToolName, m.params?.arguments));
      }
      default:
        return fail(m.id, -32601, `método não suportado: ${m.method.slice(0, 60)}`);
    }
  }

  return { handle, callTool };
}

export const TOOLS = [
  {
    name: 'memoria_gravar',
    description:
      'Grava (cria ou substitui por inteiro) um arquivo da SUA memória: o índice `.myco/staff/<id>.memory.md` ou um detalhe `.myco/staff/<id>.memory/<assunto>.md` (minúsculas e hífens), com os caminhos que a seção Memória da sua ficha mostra. É a única escrita permitida em plan; qualquer outro arquivo é recusado. Mande o arquivo inteiro (leia antes, para não perder o que vale). Curto, sem segredos.',
    inputSchema: {
      type: 'object',
      properties: {
        arquivo: { type: 'string', description: 'Caminho do arquivo da sua memória (relativo à pasta do projeto, ou absoluto), sem "..".' },
        conteudo: { type: 'string', description: 'O texto inteiro do arquivo (Markdown).' },
      },
      required: ['arquivo', 'conteudo'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'memoria_apagar',
    description: 'Apaga um arquivo de detalhe da SUA memória (`.myco/staff/<id>.memory/<assunto>.md`) que ficou velho. O índice não se apaga (reescreva-o com memoria_gravar).',
    inputSchema: {
      type: 'object',
      properties: { arquivo: { type: 'string', description: 'Caminho do detalhe a apagar (relativo à pasta do projeto, ou absoluto), sem "..".' } },
      required: ['arquivo'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

/** Lê `--chave valor` dos argumentos. */
function argOf(argv: string[], key: string): string | undefined {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Sobe o MCP no stdin/stdout (uma mensagem JSON por linha). Log só no stderr. */
export async function runMemoriaMcpStdio(argv: string[], input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const projectPath = argOf(argv, '--project');
  const staffId = argOf(argv, '--staff');
  if (!projectPath || !path.isAbsolute(projectPath) || !staffId || !SAFE_ID.test(staffId)) throw new Error('uso: --project <pasta absoluta> --staff <id>');
  const server = createMemoriaMcp({ projectPath, staffId });
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
    // Uma de cada vez: duas gravações do mesmo arquivo não se atropelam, e a resposta sai na ordem dos pedidos.
    try {
      write(await server.handle(msg));
    } catch (err) {
      process.stderr.write(`[myco-memoria] ${err instanceof Error ? err.name : 'erro'}\n`);
      const id = (msg as { id?: unknown })?.id;
      if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
    }
  }
}

// ---- como o funcionário sobe este MCP ----

/** Pacote gerado pelo build (scripts/bundle.ts); sem ele (dev), o .ts pelo tsx. */
export const MEMORIA_MCP_BUNDLE = path.join(ROOT, 'dist', 'memoria-mcp.mjs');
export const MEMORIA_MCP_ENTRY = path.join(ROOT, 'server', 'memoria-mcp.ts');

/** node + o que rodar: o pacote quando o servidor roda empacotado e ele existe; senão o .ts com o tsx. */
export function memoriaMcpCommand(bundled = !import.meta.url.endsWith('.ts')): { command: string; args: string[] } {
  if (bundled && existsSync(MEMORIA_MCP_BUNDLE)) return { command: process.execPath, args: [MEMORIA_MCP_BUNDLE] };
  const tsx = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return { command: process.execPath, args: ['--import', tsx, MEMORIA_MCP_ENTRY] };
}

/** O servidor que a conversa sobe (só o projeto e a ficha dona: nenhum segredo). */
export function memoriaMcpServer(o: MemoriaMcpOptions, bundled?: boolean): { command: string; args: string[] } {
  const { command, args } = memoriaMcpCommand(bundled);
  return { command, args: [...args, '--project', o.projectPath, '--staff', o.staffId] };
}
