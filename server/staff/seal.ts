import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Autonomy, StaffProfile } from '../../shared/model';
import { tryJson } from '../adapters/claude/fsutil';
import { profileFile, writeAtomic } from './store';

// Selo da ficha de quem roda no Codex: o motor e a autonomia que o próprio Claudio’s Club gravou da última vez.
//
// Por quê: a sandbox de escrita do Codex deixa o funcionário gravar em todo o projeto, inclusive em `.myco/staff/<id>.json`, a ficha dele. Um
// funcionário do Codex (ou um texto malicioso que ele leu) poderia trocar `engine` para claude e `autonomy` para bypassPermissions, e a
// próxima conversa abriria como Claude, sem sandbox. O Codex 0.167.0 não deixa fechar a pasta das fichas só para leitura e manter a
// memória gravável (`write` num arquivo quebra o bwrap; ver codexArgs.ts), então a defesa vem do servidor: o selo fica FORA do projeto
// (`<runDir>/seals`, que a sandbox não grava) e, ao abrir uma conversa, a ficha do disco tem que bater com ele.
//
// Só quem roda no Codex tem selo (o caminho do Claude não muda): trocar de motor pela tela apaga o selo; salvar uma ficha do Codex pela
// tela, contratar, copiar e restaurar o regravam. Ficha do Codex sem selo (anterior a ele, ou vinda de outro computador) é selada na
// primeira vez que abre.
//
// Uma exceção no Claude: o contratado por um gestor que roda no Codex (`engine: 'claude'`, travado em `manual`). Ele roda fora da sandbox, então
// sem selo poderia subir a própria autonomia editando a ficha. O selo dele (`engine: 'claude'`) vale como o do Codex e sobrevive a quem salva a
// ficha pela tela (a trava só cai se o dono trocar o motor para o Codex e voltar).

export interface FichaSeal {
  /** `codex`: ficha do Codex. `claude`: Claude contratado por um gestor no Codex (travado em `manual`). */
  engine: 'codex' | 'claude';
  autonomy: Autonomy;
  sealedAt: string;
}

/** O selo é por arquivo de ficha (o caminho completo), então o mesmo id em outro projeto não se mistura. */
export function sealFile(runDir: string, projectPath: string, staffId: string): string {
  const key = createHash('sha256').update(path.resolve(profileFile(projectPath, staffId))).digest('hex').slice(0, 32);
  return path.join(runDir, 'seals', `${key}.json`);
}

/**
 * Grava o selo da ficha (Codex) ou apaga o que houver (qualquer outro motor). Chamar só onde o Claudio’s Club decidiu motor e autonomia.
 * `lockedClaude`: o Claude contratado por um gestor no Codex nasce selado; quem já tem esse selo o mantém (com a autonomia que o dono salvou).
 */
export async function writeSeal(
  runDir: string,
  projectPath: string,
  profile: Pick<StaffProfile, 'id' | 'engine' | 'autonomy'>,
  opts: { lockedClaude?: boolean } = {},
): Promise<void> {
  const file = sealFile(runDir, projectPath, profile.id);
  const codex = profile.engine === 'codex';
  const locked = !codex && (opts.lockedClaude || (await readSeal(runDir, projectPath, profile.id))?.engine === 'claude');
  if (!codex && !locked) {
    await fs.rm(file, { force: true });
    return;
  }
  const seal: FichaSeal = { engine: codex ? 'codex' : 'claude', autonomy: profile.autonomy, sealedAt: new Date().toISOString() };
  await writeAtomic(file, JSON.stringify(seal) + '\n');
}

/** O selo gravado; null se não há ou se o arquivo não vale. */
export async function readSeal(runDir: string, projectPath: string, staffId: string): Promise<FichaSeal | null> {
  const raw = await fs.readFile(sealFile(runDir, projectPath, staffId), 'utf8').catch(() => null);
  const seal = raw === null ? null : (tryJson(raw) as Partial<FichaSeal> | null);
  return seal && (seal.engine === 'codex' || seal.engine === 'claude') && typeof seal.autonomy === 'string' ? (seal as FichaSeal) : null;
}

/** Por que a ficha do disco não vale (diferente do selo); null = vale (ou não há selo). A mensagem é para o usuário. */
export function sealViolation(profile: Pick<StaffProfile, 'name' | 'engine' | 'autonomy'>, seal: FichaSeal | null): string | null {
  if (!seal) return null;
  const engine = profile.engine ?? 'claude';
  if (engine === seal.engine && profile.autonomy === seal.autonomy) return null;
  const diffs = [
    engine !== seal.engine ? `motor ${engine} em vez de ${seal.engine}` : '',
    profile.autonomy !== seal.autonomy ? `autonomia ${profile.autonomy} em vez de ${seal.autonomy}` : '',
  ].filter(Boolean);
  const quem = seal.engine === 'claude' ? 'Quem foi contratado por um gestor no Codex' : 'Quem roda no Codex';
  return `A ficha de ${profile.name} foi mudada fora do Claudio’s Club (${diffs.join('; ')}). ${quem} não muda o próprio motor nem a própria autonomia, então a conversa não abre. Abra a ficha, confira e salve de novo para confirmar, ou volte a uma versão anterior pelo histórico.`;
}
