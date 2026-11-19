import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_FILE_BYTES, resolveProjectFile } from '../projectFiles';
import { secretFile } from './codeEdits';
import { scanSecrets, type SecretKind } from './secrets';

// De onde veio o segredo que apareceu na SAÍDA de um comando: o comando leu arquivos do projeto (`Get-Content`, `cat`, `type`…, um ou vários no mesmo
// comando) e o servidor descobre qual deles tem aquele segredo. Duas etapas: (1) `commandFiles` tira do texto do comando os caminhos que ele lê (só
// candidatos: nada é aberto por causa do que o comando diz); (2) `locateSecretFile` abre cada candidato que fica dentro do projeto e confere se o
// SEGREDO dele é o mesmo da saída, pela identidade da ocorrência (`ClassifiedSecret.occurrence`: HMAC com sal, o valor nunca é comparado nem sai daqui).
// Só vale com UM arquivo: mais de um candidato com o mesmo segredo, ou nenhum, é "sem arquivo". O Club não adivinha caminho.

/** O que sai: o caminho relativo ao projeto (com "/", o mesmo de `secretFile`) e, se deu para achar, a linha (1 = primeira) do segredo. */
export interface SecretOrigin {
  file: string;
  line?: number;
}

/** Comando comprido demais (um script colado) não é lido: o que ele leu seria chute. */
const MAX_COMMAND = 8_000;
const MAX_CANDIDATES = 12;
const MAX_DEPTH = 2;
/** O que se varre de cada arquivo: linhas e tamanho da linha (um bundle minificado é uma linha só e não vale o custo). */
const MAX_LINES = 20_000;
const MAX_LINE = 4_000;
const BINARY_PROBE_BYTES = 8 * 1024;

/** Comandos que mostram o conteúdo de arquivos (ou as linhas deles). Os argumentos que não são arquivo (padrão, opção) caem na conferência do disco. */
const READERS = new Set(['cat', 'type', 'get-content', 'gc', 'head', 'tail', 'more', 'less', 'bat', 'nl', 'tac', 'grep', 'egrep', 'fgrep', 'rg', 'select-string', 'sls', 'findstr']);
/** Invólucros: o que vem depois da opção de comando (`-c`, `-lc`, `-Command`, `/c`) é outro comando. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'powershell', 'pwsh', 'cmd']);
const COMMAND_FLAG = /^(?:-[a-z]*c|-command|\/c|\/k)$/i;
const CHDIR = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd']);
/**
 * Comando que fala com outra máquina ou rede: a saída dele NÃO é de arquivo local, então o comando inteiro fica sem candidato (mesmo que outra parte dele
 * leia um arquivo daqui). Pasta ou arquivo com o nome parecido (`.ssh/config`, `keys/ssh.txt`, `docker.md`) não conta: o nome tem de ser solto, ou `nome.exe`.
 */
const REMOTE =
  /(?<![\w.\\/-])(?:ssh|scp|sftp|rsync|plink|pscp|psftp|sshpass|ftp|lftp|curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|invoke-command|icm|enter-pssession|new-pssession|docker|podman|kubectl|wsl|nc|ncat|telnet)(?:\.exe)?(?![\w-]|\.\w)/i;
/** Caminho que não é literal: variável, subcomando, curinga, `%VAR%` ou `~` no começo (o shell expande; o nome curto `PROGRA~1` do Windows não). */
const NOT_LITERAL = /[$`(){}*?%!\[\]<>|;&"']|^~/;

const baseName = (word: string) => path.posix.basename(word.replace(/\\/g, '/')).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');

/** O comando em instruções separadas por `;`, `&&`, `||`, `|`, `&` e quebra de linha (fora de aspas), cada uma em palavras sem as aspas. */
function statementsOf(text: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let word = '';
  let open = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (open) cur.push(word);
    word = '';
    open = false;
  };
  const endStatement = () => {
    endWord();
    if (cur.length) out.push(cur);
    cur = [];
  };
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
    } else if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') {
      endStatement();
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word += ch;
      open = true;
    }
  }
  endStatement();
  return out;
}

interface Walk {
  base: string;
  files: string[];
}

function walk(command: string, w: Walk, depth: number): void {
  for (const words of statementsOf(command)) {
    const name = baseName(words[0] ?? '');
    if (SHELLS.has(name) && depth < MAX_DEPTH) {
      const at = words.findIndex((x, i) => i > 0 && COMMAND_FLAG.test(x));
      if (at !== -1) walk(words.slice(at + 1).join(' '), w, depth + 1);
    } else if (CHDIR.has(name)) {
      const dir = words.slice(1).find((x) => !x.startsWith('-') && !NOT_LITERAL.test(x));
      if (dir) w.base = path.resolve(w.base, dir);
    } else if (READERS.has(name)) {
      for (let i = 1; i < words.length; i++) {
        const x = words[i]!;
        // Redirecionamento de saída (`> arquivo`, `2>x`): o alvo é gravado, não lido.
        if (/^\d*>{1,2}$/.test(x)) i++;
        // Opção e o número que ela leva (`-n 20`, `-TotalCount 80`) não são arquivo.
        if (x.startsWith('-') || /^\d*>/.test(x) || /^\d+$/.test(x)) continue;
        // PowerShell lista arquivos com vírgula: `Get-Content a.md, b.md`.
        for (const part of x.split(',')) {
          if (!part || part.length > 260 || NOT_LITERAL.test(part) || part.includes('\0')) continue;
          w.files.push(path.resolve(w.base, part));
        }
      }
    }
  }
}

/**
 * Os caminhos que o comando lê, absolutos e sem repetir (no máximo 12), na ordem em que aparecem. Só candidatos: podem nem existir. Sem nenhum quando o
 * comando fala com outra máquina (ver `REMOTE`), é comprido demais ou não lê arquivo. Cada `cd` muda a base dos caminhos seguintes.
 */
export function commandFiles(command: string, cwd: string): string[] {
  if (!command || command.length > MAX_COMMAND || REMOTE.test(command)) return [];
  const w: Walk = { base: path.resolve(cwd), files: [] };
  walk(command, w, 0);
  return [...new Set(w.files)].slice(0, MAX_CANDIDATES);
}

export interface LocateOptions {
  /** O comando como o motor o rodou (Codex: sem o invólucro `bash -lc`). */
  command: string;
  /** A pasta onde o comando rodou (a worktree do funcionário ou o projeto). */
  cwd: string;
  /** A raiz do projeto: nada fora dela é aberto nem vira `file`. */
  projectDir: string;
  /** A identidade do segredo que apareceu na saída (`ClassifiedSecret.occurrence`) e o tipo dele. */
  occurrence: string;
  kind: SecretKind;
  /** O sal da instalação: o mesmo com que a ocorrência foi calculada. */
  pepper?: string;
}

/** O texto de um candidato, ou null se não vale: fora do projeto, pasta, grande, binário ou ilegível. */
async function textOf(projectDir: string, rel: string): Promise<{ text: string; realRel: string } | null> {
  try {
    const { abs, realRel, size } = await resolveProjectFile(projectDir, rel);
    if (size > MAX_FILE_BYTES) return null;
    const bytes = await fs.readFile(abs);
    if (bytes.length > MAX_FILE_BYTES || bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
    return { text: bytes.toString('utf8'), realRel };
  } catch {
    return null;
  }
}

/** O segredo da ocorrência está neste texto? `line` = a linha onde está (ausente na chave privada, que tem várias linhas). */
function findOccurrence(text: string, rel: string, o: LocateOptions): { line?: number } | null {
  const same = (s: string) => scanSecrets(s, { file: rel, pepper: o.pepper }).some((x) => x.occurrence === o.occurrence);
  const lines = text.split(/\r\n|\n|\r/, MAX_LINES);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length >= 8 && same(line.slice(0, MAX_LINE))) return { line: i + 1 };
  }
  return o.kind === 'private-key' && same(text) ? {} : null;
}

/**
 * Qual arquivo que o comando leu tem o segredo da saída. Devolve o caminho relativo ao projeto (e a linha, se der) quando exatamente um arquivo
 * do projeto o tem; null se nenhum, se mais de um (sem decisão clara) ou se o que ele leu está fora do projeto. Nunca lança.
 */
export async function locateSecretFile(o: LocateOptions): Promise<SecretOrigin | null> {
  try {
    const found = new Map<string, SecretOrigin>();
    for (const abs of commandFiles(o.command, o.cwd)) {
      const rel = secretFile(abs, o.cwd, o.projectDir);
      if (!rel) continue;
      const read = await textOf(o.projectDir, rel);
      if (!read) continue;
      const at = findOccurrence(read.text, read.realRel, o);
      // O caminho real (link seguido): é o arquivo que o editor abre e o que a checagem de segredo (`isBlockedRel`) classifica.
      const file = at && secretFile(read.realRel, o.projectDir, o.projectDir);
      if (file && !found.has(file)) found.set(file, { file, ...(at.line && { line: at.line }) });
    }
    return found.size === 1 ? [...found.values()][0]! : null;
  } catch {
    return null;
  }
}
