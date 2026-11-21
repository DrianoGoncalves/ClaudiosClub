import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

// O CLAUDE.md do projeto consultado, para a conversa de consulta no Claude (t-1a9bf2). Ela abre com `--setting-sources user`: o `claude` só carrega o CLAUDE.md do projeto junto com o
// `.claude/settings.json` dele (mesma fonte, `project`), e dessa fonte vêm allow, hooks e pastas extras, que na consulta não podem valer (um hook seria código de outro repositório rodando na
// consulta; um allow de Read fora do projeto pularia a negação na hora). Então o Club lê o arquivo e o põe no prompt de sistema. Provado com o claude 2.1.310.

/** Teto do texto que entra no prompt da consulta (bytes do arquivo). Acima disso o texto é cortado e o prompt avisa. */
export const CONSULT_GUIDE_MAX_BYTES = 16 * 1024;

const BOM = 0xfeff;
const BROKEN = 0xfffd;

export interface ConsultGuide {
  text: string;
  /** O arquivo passava do teto: `text` é só o começo. */
  truncated: boolean;
}

/**
 * O `CLAUDE.md` da raiz do projeto, ou `null` se não existe, não é um arquivo comum ou resolve (link) para fora da pasta do projeto: um CLAUDE.md que aponte para um segredo não vira
 * prompt. Só os primeiros `CONSULT_GUIDE_MAX_BYTES` bytes são lidos. Não expande `@imports`, e não lê CLAUDE.local.md, `.claude/rules` nem CLAUDE.md de subpasta.
 */
export async function readConsultGuide(projectPath: string, max = CONSULT_GUIDE_MAX_BYTES): Promise<ConsultGuide | null> {
  try {
    const root = await realpath(projectPath);
    const file = await realpath(path.join(projectPath, 'CLAUDE.md'));
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const handle = await open(file, 'r');
    try {
      if (!(await handle.stat()).isFile()) return null;
      const buf = Buffer.alloc(max + 1);
      const { bytesRead } = await handle.read(buf, 0, max + 1, 0);
      const truncated = bytesRead > max;
      let text = buf.subarray(0, Math.min(bytesRead, max)).toString('utf8');
      if (text.charCodeAt(0) === BOM) text = text.slice(1);
      // O corte pode cair no meio de um caractere: o pedaço quebrado (U+FFFD) do fim sai.
      while (text.charCodeAt(text.length - 1) === BROKEN) text = text.slice(0, -1);
      text = text.trim();
      return text ? { text, truncated } : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
