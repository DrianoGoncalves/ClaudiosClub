import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TestFailedFile, TestIsolatedFile, TestIsolation, TestRun } from '../shared/model';
import { isHeavyCommand } from '../scripts/hooks/heavy-lock.mjs';

// As falhas da suíte para o pedido de revisão: quais arquivos de teste falharam (e quantas falhas cada um), se passam ao rodar de novo só eles, e quais
// falham também isolados e tocam a entrega. Sem isso o revisor via "28 falhas" sem lista e não separava falha desta entrega de falha antiga.
// Só a saída do vitest é lida (o `npm test` do projeto é `vitest run`); com outro executor não há lista e o aviso volta ao fim da saída, como era.

/** Arquivos que a nova rodada leva: acima disso ela viraria a suíte inteira. Os de fora ficam "sem resultado isolado". */
export const ISOLATED_MAX = 12;
/** O tempo da nova rodada (a espera pela fila de validação pesada não conta; ver `runTests`). */
export const ISOLATED_TIMEOUT_MS = 3 * 60_000;
/** Linhas da lista no pedido de revisão; o resto vai como contagem. */
const ROWS_MAX = 25;
/** Quantos níveis de importação e quantos arquivos a busca por "toca a entrega" percorre por teste. */
const IMPORT_DEPTH = 4;
const IMPORT_FILES_MAX = 300;
const SOURCE_MAX_BYTES = 400_000;
const LINE_MAX = 4000;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** ` FAIL  tests/a.test.ts > suíte > teste` (um por teste) ou ` FAIL  tests/a.test.ts [ tests/a.test.ts ]` (arquivo que nem carregou). */
const FAIL_LINE = /^\s*FAIL\s+(\S+)(?:\s+>|\s+\[|\s*$)/;
/** ` Test Files  3 failed | 1 passed (4)`. */
const FILES_LINE = /^\s*Test Files\s.*\((\d+)\)\s*$/;
const SOURCE = /\.[cm]?[jt]sx?$/;

/** Caminho de arquivo de teste que vale: relativo ao projeto, sem `..`, só caracteres de caminho e sem hífen no começo. Vai para a linha de comando da nova rodada. */
export function testFileOf(name: string): string | null {
  const file = name.replace(/\\/g, '/');
  return /^[A-Za-z0-9_@+.][A-Za-z0-9_@+./-]*$/.test(file) && SOURCE.test(file) && !file.split('/').includes('..') ? file : null;
}

/**
 * Lê a saída dos testes à medida que ela chega (o fim da saída, guardado no resultado, perde o começo e cortaria a lista): conta as falhas por arquivo e o total de arquivos.
 * Uma entrada por fluxo (stdout e stderr), porque as linhas de um não se misturam com as do outro.
 */
export class TestScan {
  private readonly rest = ['', ''];
  private readonly failed = new Map<string, number>();
  private total: number | null = null;

  feed(chunk: string, stream: 0 | 1 = 0): void {
    const lines = (this.rest[stream]! + chunk).split(/\r?\n/);
    this.rest[stream] = (lines.pop() ?? '').slice(-LINE_MAX);
    for (const line of lines) this.line(line);
  }

  /** O fim da saída: a última linha pode não ter quebra. */
  end(): void {
    for (const stream of [0, 1] as const) {
      this.line(this.rest[stream]!);
      this.rest[stream] = '';
    }
  }

  private line(raw: string): void {
    if (raw.length > LINE_MAX) return;
    const text = raw.replace(ANSI, '');
    const fail = FAIL_LINE.exec(text);
    if (fail) {
      const file = testFileOf(fail[1]!);
      if (file) this.failed.set(file, (this.failed.get(file) ?? 0) + 1);
      return;
    }
    const files = FILES_LINE.exec(text);
    if (files) this.total = Number(files[1]);
  }

  /** `failedFiles` só vem com falha lida; `files` só com a linha do vitest. Mais falhas primeiro. */
  result(): { files?: number; failedFiles?: TestFailedFile[] } {
    const failedFiles = [...this.failed].map(([file, failed]) => ({ file, failed })).sort((a, b) => b.failed - a.failed || a.file.localeCompare(b.file));
    return { ...(this.total !== null && { files: this.total }), ...(failedFiles.length && { failedFiles }) };
  }
}

/** A nova rodada passa pelo mesmo `runTests` da suíte (a fila de validação pesada, o timeout e o limite de saída são os dele). `queueAs`: o comando que vale para a fila. */
export type Rerun = (cwd: string, command: string, timeoutMs: number, queueAs: string) => Promise<TestRun>;

/** O `test` do projeto é só `vitest` ou `vitest run`? Só assim `npm test -- <arquivos>` roda os arquivos e nada além. */
async function plainVitest(dir: string, command: string): Promise<boolean> {
  if (command !== 'npm test') return false;
  const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8').catch(() => null);
  try {
    const test = (JSON.parse((raw ?? '').replace(/^﻿/, '')) as { scripts?: { test?: unknown } }).scripts?.test;
    return typeof test === 'string' && /^vitest(\s+run)?$/.test(test.trim());
  } catch {
    return false;
  }
}

const isFile = (p: string) => fs.stat(p).then((s) => s.isFile(), () => false);

/**
 * Roda de novo UMA vez só os arquivos que falharam (até `ISOLATED_MAX`), sem a suíte inteira e sem a suíte no HEAD: o custo de uma nova rodada. Diz, por arquivo, se passa
 * isolado (instável na suíte inteira: carga ou ordem) ou falha de novo, e neste caso se ele é ou importa algo da entrega (`delivered`, os arquivos que a tarefa alterou).
 * Sem lista de falhas (outro executor) ou com a suíte que passou: undefined. Rodar não é possível (`test` do projeto não é o vitest simples, arquivo sumiu, a rodada caiu): devolve o motivo.
 */
export async function isolateFailures(dir: string, run: TestRun, delivered: string[], rerun: Rerun): Promise<TestIsolation | undefined> {
  const failed = run.failedFiles;
  if (run.ok || !failed?.length) return undefined;
  const unknown = (): TestIsolatedFile[] => failed.map((f) => ({ file: f.file, failed: f.failed, status: 'unknown' }));
  if (!(await plainVitest(dir, run.command))) return { skipped: 'o comando de testes do projeto não é `npm test` com `vitest run`: não dá para rodar só os arquivos que falharam', files: unknown() };

  const runnable: TestFailedFile[] = [];
  for (const f of failed) {
    if (runnable.length >= ISOLATED_MAX) break;
    if (await isFile(path.join(dir, f.file))) runnable.push(f);
  }
  if (!runnable.length) return { skipped: 'os arquivos que falharam não existem mais no projeto', files: unknown() };
  const command = `npm test -- ${runnable.map((f) => f.file).join(' ')}`;
  // Nunca a suíte inteira: com ao menos um arquivo no comando ele não é pesado; se for (o reconhecedor mudou), não roda.
  if (isHeavyCommand(command)) return { skipped: 'a nova rodada seria a suíte inteira', files: unknown() };

  let again: TestRun;
  try {
    again = await rerun(dir, command, ISOLATED_TIMEOUT_MS, run.command);
  } catch (err) {
    return { skipped: `a nova rodada não rodou: ${err instanceof Error ? err.message : String(err)}`, files: unknown() };
  }
  const still = new Map((again.failedFiles ?? []).map((f) => [f.file, f.failed]));
  // Passou isolado só com prova: a rodada leu exatamente os arquivos pedidos e terminou limpa, ou terminou com falhas que a lista mostra.
  const conclusive = again.files === runnable.length && (again.ok || still.size > 0);
  const graph = importGraph(dir);
  const ran = new Set(runnable.map((f) => f.file));
  const files: TestIsolatedFile[] = [];
  for (const f of failed) {
    const base = { file: f.file, failed: f.failed };
    if (!ran.has(f.file)) files.push({ ...base, status: 'unknown' });
    else if (still.has(f.file)) {
      const touches = await graph.reaches(f.file, delivered);
      files.push({ ...base, status: 'fail', isolatedFailed: still.get(f.file)!, ...(touches && { touches }) });
    } else files.push({ ...base, status: conclusive ? 'pass' : 'unknown' });
  }
  return { command, ms: again.ms, files };
}

const keyOf = (rel: string) => (process.platform === 'win32' ? rel.toLowerCase() : rel);
const norm = (f: string) => f.replace(/\\/g, '/').replace(/^\.\//, '');
const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** `from './x'`, `import('./x')`, `require('./x')`, `vi.mock('./x')`: só o relativo. */
const IMPORT = /(?:\bfrom|\bimport|\brequire|\bmock|\bimportActual)\s*\(?\s*['"](\.[^'"\r\n]*)['"]/g;

/**
 * Os arquivos do projeto que um teste importa, direta ou indiretamente (só importação relativa, até `IMPORT_DEPTH` níveis e `IMPORT_FILES_MAX` arquivos): se algum é da entrega, o
 * teste a exercita. O próprio teste da entrega também conta. Leitura de cada arquivo uma vez só por chamada de `isolateFailures`.
 */
function importGraph(dir: string): { reaches: (testFile: string, delivered: string[]) => Promise<string | null> } {
  const specs = new Map<string, string[]>();
  const readSpecs = async (abs: string): Promise<string[]> => {
    const known = specs.get(abs);
    if (known) return known;
    let found: string[] = [];
    if (SOURCE.test(abs)) {
      const stat = await fs.stat(abs).catch(() => null);
      const text = stat && stat.size <= SOURCE_MAX_BYTES ? await fs.readFile(abs, 'utf8').catch(() => '') : '';
      found = [...new Set([...text.matchAll(IMPORT)].map((m) => m[1]!))];
    }
    specs.set(abs, found);
    return found;
  };
  /** `./x` → `x.ts`, `x/index.ts`…; `./x.js` aponta para `x.ts` (importação à moda ESM do TypeScript). */
  const resolveSpec = async (from: string, spec: string): Promise<string | null> => {
    const base = path.resolve(path.dirname(from), spec);
    const ts = base.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx').replace(/\.mjs$/, '.mts');
    for (const cand of [base, ts, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, `index${e}`))]) if (await isFile(cand)) return cand;
    return null;
  };
  return {
    async reaches(testFile, delivered) {
      const targets = new Map(delivered.map((f) => [keyOf(norm(f)), norm(f)] as const));
      if (!targets.size) return null;
      const self = targets.get(keyOf(norm(testFile)));
      if (self) return self;
      const seen = new Set([keyOf(norm(testFile))]);
      let layer = [path.join(dir, testFile)];
      for (let depth = 0; depth < IMPORT_DEPTH && layer.length; depth++) {
        const next: string[] = [];
        for (const file of layer) {
          for (const spec of await readSpecs(file)) {
            const abs = await resolveSpec(file, spec);
            const rel = abs && norm(path.relative(dir, abs));
            if (!abs || !rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
            const hit = targets.get(keyOf(rel));
            if (hit) return hit;
            if (seen.has(keyOf(rel)) || seen.size >= IMPORT_FILES_MAX) continue;
            seen.add(keyOf(rel));
            next.push(abs);
          }
        }
        layer = next;
      }
      return null;
    },
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A lista de falhas para o pedido de revisão (vazia sem `failedFiles`): os arquivos com o número de falhas, o que a nova rodada isolada mostrou e o destaque do que falha isolado e toca
 * a entrega. `hasList`: a tarefa tem a lista de arquivos alterados (sem ela não dá para dizer se toca).
 */
export function failureBlock(t: TestRun, hasList: boolean): string {
  const failed = t.failedFiles;
  if (!failed?.length) return '';
  const iso = t.isolated;
  const byFile = new Map((iso?.files ?? []).map((f) => [f.file, f]));
  const total = failed.reduce((n, f) => n + f.failed, 0);
  const order = (f: TestFailedFile) => {
    const r = byFile.get(f.file);
    return r?.status === 'fail' && r.touches ? 0 : r?.status === 'fail' ? 1 : r?.status === 'pass' ? 3 : 2;
  };
  const rows = [...failed].sort((a, b) => order(a) - order(b) || b.failed - a.failed || a.file.localeCompare(b.file));
  const head = [`Arquivos com falha: ${failed.length}${t.files ? ` de ${t.files}` : ''} (${plural(total, 'falha', 'falhas')} no total).`];
  if (iso?.command) head.push(`Nova rodada, uma vez, só dos arquivos que falharam (\`${iso.command}\`, ${Math.round((iso.ms ?? 0) / 1000)} s):`);
  else if (iso?.skipped) head.push(`Nova rodada só desses arquivos não feita: ${iso.skipped}.`);
  const line = (f: TestFailedFile): string => {
    const r = byFile.get(f.file);
    const base = `- \`${f.file}\`: ${plural(f.failed, 'falha', 'falhas')} na suíte`;
    if (!r) return base;
    if (r.status === 'pass') return `${base}; passa isolado (instável na suíte inteira: carga ou ordem; não prova regressão desta entrega)`;
    if (r.status === 'unknown') return `${base}; sem resultado isolado`;
    const again = `${base}; falha também isolado (${r.isolatedFailed})`;
    if (r.touches) return `${again}; ⚠ ${r.touches === f.file ? 'é um arquivo desta entrega' : `importa \`${r.touches}\` (direta ou indiretamente), que é desta entrega`}: confira primeiro`;
    return hasList ? `${again}; não importa arquivo desta entrega (provavelmente anterior a ela)` : `${again}; a tarefa não tem lista de arquivos: não dá para dizer se toca a entrega`;
  };
  const out = [...head, ...rows.slice(0, ROWS_MAX).map(line)];
  if (rows.length > ROWS_MAX) out.push(`- … e mais ${rows.length - ROWS_MAX} ${rows.length - ROWS_MAX === 1 ? 'arquivo' : 'arquivos'}`);
  if (iso?.command) {
    const results = iso.files;
    const fails = results.filter((r) => r.status === 'fail');
    const passes = results.filter((r) => r.status === 'pass').length;
    const rest = results.length - fails.length - passes;
    out.push(
      `Resumo: falham também isolados: ${fails.length} (tocam a entrega: ${fails.filter((r) => r.touches).length}); passam isolados: ${passes}${rest ? `; sem resultado isolado: ${rest}` : ''}. Só o que falha isolado e toca a entrega aponta regressão dela.`,
    );
  }
  return out.join('\n');
}
