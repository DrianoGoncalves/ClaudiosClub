import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './staff/store';
import { ProjectFileError } from './projectFiles';
import { changedFiles } from './taskCode';

// Guia do projeto (SPEC.md, na raiz da pasta do projeto). Se existe, a ficha de todo funcionário dele manda
// consultá-lo em caso de dúvida (ver server/staff/ficha.ts). O arquivo é do projeto: o Claudio’s Club só cria
// o modelo e lê o estado; editar é com o usuário, no editor dele.

export const GUIDE_PATH = 'SPEC.md';
/** Última conferência do guia (draft ou drift): o HEAD da hora e a data. Fica na pasta do Club do projeto. */
export const GUIDE_CHECK_PATH = path.join('.myco', 'guide.json');

/** Vitrine do projeto (ação `showcase` do guia): página única, na raiz. Base da conferência em arquivo próprio. */
export const SHOWCASE_PATH = 'VITRINE.html';
export const SHOWCASE_CHECK_PATH = path.join('.myco', 'showcase.json');
/** Acima disso, a vitrine não é servida (413). */
export const MAX_SHOWCASE_BYTES = 5 * 1024 * 1024;

/** Base da conferência: o sha do HEAD quando o guia foi conferido, e a hora (ISO). */
export interface GuideCheck {
  sha: string;
  at: string;
}

export interface GuideStatus {
  /** Caminho relativo à raiz do projeto. */
  path: string;
  exists: boolean;
  /** A pasta está dentro de um repositório git. */
  isGit: boolean;
  /** O git ignora o arquivo (.gitignore): só faz sentido com isGit. */
  ignored: boolean;
  /** Base válida (o sha ainda existe no repo). Ausente: sem base, o drift confere tudo. */
  lastCheck?: GuideCheck;
  /** Arquivos mudados desde `lastCheck.sha` (inclui não rastreados; ignora `.myco/`). Só com `lastCheck`. */
  changedSince?: number;
  /** Vitrine (VITRINE.html): existe, e a última conferência dela (base válida, ver showcase.json). */
  showcase: ShowcaseStatus;
}

export interface ShowcaseStatus {
  path: string;
  exists: boolean;
  lastCheck?: GuideCheck;
}

/** Já existe um SPEC.md: a criação não sobrescreve. A rota responde 409 com `{ error: 'exists' }`. */
export class GuideExistsError extends Error {
  constructor() {
    super('exists');
  }
}

/** Roda git sem shell, na pasta do projeto. Sem git (ou fora de um repositório) devolve null. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 5_000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** Só confere se o arquivo está lá (sem git). */
export async function hasGuide(root: string): Promise<boolean> {
  return fs.stat(path.join(root, GUIDE_PATH)).then((st) => st.isFile(), () => false);
}

/** A vitrine está lá como arquivo comum (link simbólico conta como ausente, igual à leitura de `readShowcase`). */
export async function hasShowcase(root: string): Promise<boolean> {
  return fs.lstat(path.join(root, SHOWCASE_PATH)).then((st) => st.isFile(), () => false);
}

/**
 * Lê a vitrine para a tela. `null`: não existe, ou não é arquivo comum (link simbólico fica de fora). Acima de
 * MAX_SHOWCASE_BYTES: 413. O tamanho vem do lstat, antes de ler.
 */
export async function readShowcase(root: string): Promise<Buffer | null> {
  const file = path.join(root, SHOWCASE_PATH);
  const st = await fs.lstat(file).catch(() => null);
  if (!st || !st.isFile()) return null;
  if (st.size > MAX_SHOWCASE_BYTES) throw new ProjectFileError(413, `${SHOWCASE_PATH} grande demais (máx. 5 MB)`);
  const bytes = await fs.readFile(file).catch(() => null);
  if (bytes && unsafeShowcase(bytes.toString('utf8'))) {
    throw new ProjectFileError(422, 'VITRINE.html tem <link>, <base> ou <meta http-equiv>: esses elementos fogem da CSP. Gere de novo pelo botão do guia.');
  }
  return bytes;
}

/** `<link>`, `<base>` ou `<meta http-equiv>` na vitrine: dns-prefetch/preconnect e meta refresh escapam da CSP. */
export function unsafeShowcase(html: string): boolean {
  return /<link[\s>\/]/i.test(html) || /<base[\s>\/]/i.test(html) || /<meta\b[^>]*http-equiv/i.test(html);
}

/** HEAD da pasta (git). Sem git ou sem commit: null. */
export async function headSha(root: string): Promise<string | null> {
  const out = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  const sha = out?.trim() ?? '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** Lê a base (`.myco/guide.json`, ou o `rel` dado). Arquivo ausente ou fora do formato: null. */
async function readCheck(root: string, rel: string = GUIDE_CHECK_PATH): Promise<GuideCheck | null> {
  const raw = await fs.readFile(path.join(root, rel), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw) as Partial<GuideCheck>;
    return typeof data.sha === 'string' && /^[0-9a-f]{40,64}$/.test(data.sha) && typeof data.at === 'string' ? { sha: data.sha, at: data.at } : null;
  } catch {
    return null;
  }
}

/** Base válida: está gravada e o sha ainda existe no repo (um rebase pode tê-lo levado). Senão, null. */
export async function validCheck(root: string, rel: string = GUIDE_CHECK_PATH): Promise<GuideCheck | null> {
  const check = await readCheck(root, rel);
  if (!check) return null;
  const exists = (await git(root, ['cat-file', '-e', `${check.sha}^{commit}`])) !== null;
  return exists ? check : null;
}

/** Grava a base com o HEAD atual (em `rel`, por padrão `.myco/guide.json`). Gravação atômica (a do Club), dentro de `.myco/`. */
export async function recordCheck(root: string, sha: string, rel: string = GUIDE_CHECK_PATH): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const check: GuideCheck = { sha, at: new Date().toISOString() };
  await writeAtomic(file, JSON.stringify(check, null, 2) + '\n');
}

export async function guideStatus(root: string): Promise<GuideStatus> {
  const exists = await hasGuide(root);
  const inside = (await git(root, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true';
  // check-ignore -q: código 0 = ignorado; 1 = não ignorado (o execFile devolve erro nos dois casos de falha).
  const ignored = inside ? (await git(root, ['check-ignore', '-q', GUIDE_PATH])) !== null : false;
  const showcase: ShowcaseStatus = { path: SHOWCASE_PATH, exists: await hasShowcase(root) };
  const status: GuideStatus = { path: GUIDE_PATH, exists, isGit: inside, ignored, showcase };
  const base = inside ? await validCheck(root) : null;
  if (base) {
    status.lastCheck = base;
    status.changedSince = (await changedFiles(root, base.sha)).length;
  }
  const showcaseBase = inside ? await validCheck(root, SHOWCASE_CHECK_PATH) : null;
  if (showcaseBase) showcase.lastCheck = showcaseBase;
  return status;
}

/**
 * Modelo do guia em pt-BR. As linhas `<!-- -->` são instruções para quem preenche: não aparecem na leitura.
 * Fica curto de propósito: um guia longo ninguém atualiza.
 */
export const GUIDE_TEMPLATE = `# Guia do projeto

> A equipe consulta este arquivo em caso de dúvida.
>
> Se tiver informação privada (senhas, dados de clientes, endereços internos),
> não escreva aqui: ponha o arquivo no \`.gitignore\`.

## Visão

<!--
O que é o projeto, em duas ou três frases, e para quem é.
-->

## Problema que resolve

<!--
Qual dor existe hoje e o que muda para quem usa
quando o projeto estiver pronto.
-->

## Escopo

<!--
O que o projeto faz. Uma função principal por linha.
-->

## Fora do escopo

<!--
O que o projeto não faz, mesmo que alguém peça.
Evita trabalho que contraria a visão.
-->

## Princípios e regras inegociáveis

<!--
Regras que não se quebram por conveniência.
Ex.: dados sensíveis só no servidor; dependência nova só com aprovação.
-->

## Glossário

<!--
Termos do projeto e o que significam, para todos falarem a mesma língua.
-->

## Decisões

<!--
Cada decisão com data e o porquê.
Ex.: 2026-11-06: SQLite, porque o cliente não tem servidor de banco.
-->

## Dúvidas em aberto

<!--
O que ainda não foi decidido. Quando resolver, passe para Decisões.
-->

## Lições da revisão

<!--
Regras que saíram de um 🔴 da revisão e valem para o projeto todo, uma por linha, com data.
No máximo 15: ao passar disso, junte ou tire as que ficaram velhas.
Ex.: 2026-11-06: toda rota que grava confere o cabeçalho x-myco.
-->
`;

/**
 * Cria o SPEC.md a partir do modelo. `wx`: se o arquivo já existe, falha (não sobrescreve nem corre o risco
 * de apagar o que o usuário escreveu entre a checagem e a gravação).
 */
export async function createGuide(root: string): Promise<void> {
  try {
    await fs.writeFile(path.join(root, GUIDE_PATH), GUIDE_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new GuideExistsError();
    throw err;
  }
}
