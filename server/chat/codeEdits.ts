import path from 'node:path';
import { isInside } from '../adapters/claude/paths';
import { unwrapShell } from './codexEvents';
import { findSecret } from './secrets';

// Edição de código vista na conversa de um funcionário, nos dois motores: é o que faz o Claudio’s Club abrir o card automático do
// quadro (ver TaskService.onCodeEdit). Só funções puras, sem processo.
//
// O que o Club enxerga: as ferramentas de edição do Claude (Edit, MultiEdit, Write e NotebookEdit, também as de subagents) e o item
// `file_change` do Codex. Edição só por shell (`sed`, `node -e`, redirecionamento, script) NÃO é vista: é o limite aceito desta detecção
// (ela registra, não trava; o commit e a revisão do diff pegam o que ficou de fora).

/** Uma edição de arquivo numa conversa de funcionário (ver `ChatProcessOptions.onEdit`). */
export interface CodeEdit {
  sessionId: string;
  projectId: string;
  staffId: string;
  engine: 'claude' | 'codex';
  /** Pasta onde a conversa roda: a worktree do funcionário ou o projeto. */
  cwd: string;
  /** Caminhos como o motor os deu (absolutos, ou relativos a `cwd`). Só edição que deu certo. */
  files: string[];
  /** A última mensagem sua na conversa (o pedido), se ainda está na memória do processo: vira a descrição do card. */
  request: string | null;
}

const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * O arquivo-alvo de uma chamada de ferramenta do Claude: `file_path` (`notebook_path` no NotebookEdit) no Read e nas de edição. As outras
 * ferramentas dão null (Grep e Glob têm `path` de pasta, não de arquivo).
 */
export function claudeToolFile(tool: string, input: unknown): string | null {
  if (tool !== 'Read' && !CLAUDE_EDIT_TOOLS.has(tool)) return null;
  const o = asRecord(input);
  const file = tool === 'NotebookEdit' ? o.notebook_path : o.file_path;
  return typeof file === 'string' && file.trim() ? file : null;
}

/** O arquivo que uma chamada de ferramenta do Claude altera; null se a ferramenta não edita. */
export function claudeEditedFile(tool: string, input: unknown): string | null {
  return CLAUDE_EDIT_TOOLS.has(tool) ? claudeToolFile(tool, input) : null;
}

// Comando de leitura simples: o programa, no máximo opções de quantidade de linhas (`-n 20`, `-20`, `-TotalCount 20`, `-Raw`) e UM arquivo.
// Qualquer sintaxe de shell (pipe, `;`, `&&`, redirecionamento, variável, curinga, `~`) deixa o caminho em dúvida: não se adivinha.
const READ_COMMANDS = new Set(['cat', 'type', 'get-content', 'gc', 'head', 'tail']);
const SHELL_SYNTAX = /[|;&<>$`(){}*?%~\r\n]/;

function readCommandFile(command: string): string | null {
  const text = command.trim();
  if (!text || SHELL_SYNTAX.test(text)) return null;
  const words = [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
  if (!READ_COMMANDS.has((words[0] ?? '').toLowerCase())) return null;
  const files: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (/^-(?:n|totalcount|tail|first|last|head)$/i.test(w)) {
      if (!/^\d+$/.test(words[++i] ?? '')) return null;
    } else if (/^-(?:n?\d+|raw)$/i.test(w)) {
      continue;
    } else if (/^-(?:literal)?path$/i.test(w)) {
      files.push(words[++i] ?? '');
    } else if (w.startsWith('-')) {
      return null;
    } else {
      files.push(w);
    }
  }
  return files.length === 1 && files[0]!.trim() ? files[0]! : null;
}

/**
 * O comando de shell de uma chamada de ferramenta do Claude (Bash e PowerShell), para o aviso de segredo descobrir qual arquivo o comando leu
 * (ver `locateSecretFile`). Ausente (null) nas outras ferramentas.
 */
export function claudeToolCommand(tool: string, input: unknown): string | null {
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = asRecord(input).command;
  return typeof command === 'string' && command.trim() ? command : null;
}

/** O comando de um item `command_execution` do Codex, sem o invólucro `bash -lc` (ver `unwrapShell`); null nos outros itens. */
export function codexToolCommand(raw: unknown): string | null {
  const item = asRecord(raw);
  if (item.type !== 'command_execution' || typeof item.command !== 'string') return null;
  const command = unwrapShell(item.command);
  return command.trim() ? command : null;
}

/**
 * O arquivo de um item do Codex, para o aviso de segredo. Sem ferramenta de leitura, o Codex lê por shell: só vale o comando de leitura
 * simples de um arquivo. O `file_change` só vale com exatamente uma mudança (e ele não traz o conteúdo, então o segredo gravado por ele
 * não é visto; ver `server/chat/codexEvents.ts`). Fora disso, null: o Club não adivinha caminho. O comando que lê vários arquivos (ou tem `;`, pipe)
 * não passa por aqui: o servidor confere no disco qual deles tem o segredo (`codexToolCommand` + `locateSecretFile`).
 */
export function codexToolFile(raw: unknown): string | null {
  const item = asRecord(raw);
  if (item.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const file = changes.length === 1 ? asRecord(changes[0]).path : null;
    return typeof file === 'string' && file.trim() ? file : null;
  }
  if (item.type === 'command_execution') return readCommandFile(unwrapShell(typeof item.command === 'string' ? item.command : ''));
  return null;
}

/**
 * Os arquivos de um `file_change` do Codex que contam: o item concluído, sem falha nem recusa. Item em andamento (`item.started`,
 * `item.updated`) ou que falhou não conta; sem `status` no item concluído, vale (formato antigo).
 */
export function codexEditedFiles(phase: string, raw: unknown): string[] {
  const item = asRecord(raw);
  if (phase !== 'completed' || item.type !== 'file_change') return [];
  if (typeof item.status === 'string' && item.status !== 'completed') return [];
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.map((c) => asRecord(c).path).filter((p): p is string => typeof p === 'string' && p.trim() !== '');
}

const MAX_SECRET_FILE = 300;

/**
 * O arquivo do aviso de segredo como o `files/read` o abre: relativo à raiz do projeto (`projectDir`), com "/". `file` vem como o motor o deu
 * (absoluto, ou relativo a `cwd`, a pasta da conversa). Null quando não dá para confiar: fora do projeto, a própria raiz, comprido demais ou com
 * cara de segredo no nome (o caminho vai para a tela, e nunca pode levar o valor). `.env` e chaves passam: quem os marca como "não abre pela
 * tela" é a mesma checagem da rota (`isBlockedRel`).
 */
export function secretFile(file: string, cwd: string, projectDir: string): string | null {
  if (file.includes('\0')) return null;
  const abs = path.resolve(cwd, file);
  if (!isInside(abs, projectDir)) return null;
  const rel = path.relative(projectDir, abs);
  if (!rel || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.includes('..')) return null;
  const clean = parts.join('/');
  return clean.length > MAX_SECRET_FILE || findSecret(clean) ? null : clean;
}

/**
 * O arquivo como "código do projeto": o caminho relativo (com "/"), à pasta onde a conversa roda (`cwd`, a worktree do funcionário) ou, se
 * ele está fora dela, ao projeto. Null quando não conta: fora da pasta do projeto, a própria pasta, ou qualquer coisa em `.myco/` (a
 * memória e a ficha dos funcionários são gravadas o tempo todo e não são código).
 */
export function codePath(file: string, cwd: string, projectDir: string): string | null {
  const abs = path.resolve(cwd, file);
  if (!isInside(abs, projectDir)) return null;
  const base = isInside(abs, cwd) && isInside(cwd, projectDir) ? cwd : projectDir;
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => p.toLowerCase() === '.myco')) return null;
  return parts.join('/');
}
