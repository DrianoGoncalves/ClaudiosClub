import fs from 'node:fs';
import path from 'node:path';

// Dependências usadas pelo app, para a seção "Dependências usadas" da página de início (scripts/start.html): lê o
// package.json (o que o projeto pede) e, de cada pacote, a versão instalada, a licença e a descrição que o próprio
// pacote traz em node_modules. Só leitura e nunca lança: o que não dá para ler vira null (ou lista vazia).

export interface DepInfo {
  name: string;
  /** A faixa pedida no package.json (ex.: "^1.2.0"). */
  wanted: string;
  /** Versão instalada em node_modules, ou null se o pacote não está lá. */
  version: string | null;
  /** Licença do pacote; null se não tem ou se não é texto. */
  license: string | null;
  /** Descrição do pacote, cortada em ~140 caracteres; null se não tem. */
  description: string | null;
  /** true: vem de devDependencies (só para montar e testar). */
  dev: boolean;
}

export interface DepsReport {
  /** Primeiro as dependências do app, depois as de desenvolvimento; cada grupo ordenado por nome. */
  deps: DepInfo[];
  /** Quantos pacotes estão instalados (contando as dependências deles), pelo node_modules/.package-lock.json; null se o arquivo não existe. */
  installedTotal: number | null;
}

const DESC_MAX = 140;

type Json = Record<string, unknown>;

function readJson(file: string): Json | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A licença pode vir como texto ou, em pacotes antigos, como { type }. */
function licenseOf(v: unknown): string | null {
  if (v && typeof v === 'object' && 'type' in v) return text((v as Json).type);
  return text(v);
}

/** Uma linha só, no máximo DESC_MAX caracteres (com as reticências no fim quando corta). */
function descriptionOf(v: unknown): string | null {
  const t = text(v)?.replace(/\s+/g, ' ');
  if (!t) return null;
  return t.length > DESC_MAX ? `${t.slice(0, DESC_MAX - 1).trimEnd()}…` : t;
}

/** Quantos pacotes há no lockfile escondido do node_modules (as chaves "node_modules/..." de packages); null se não dá para ler. */
function installedCount(root: string): number | null {
  const lock = readJson(path.join(root, 'node_modules', '.package-lock.json'));
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object') return null;
  return Object.keys(packages).filter((k) => k.startsWith('node_modules/')).length;
}

/** Os pacotes que o projeto em `root` pede (package.json), com o que está instalado. Nunca lança. */
export function listDeps(root: string): DepsReport {
  const pkg = readJson(path.join(root, 'package.json'));
  const group = (field: 'dependencies' | 'devDependencies', dev: boolean): DepInfo[] => {
    const wanted = pkg?.[field];
    if (!wanted || typeof wanted !== 'object') return [];
    return Object.entries(wanted as Record<string, unknown>)
      .map(([name, range]): DepInfo => {
        const inst = readJson(path.join(root, 'node_modules', name, 'package.json'));
        return {
          name,
          wanted: typeof range === 'string' ? range : '',
          version: text(inst?.version),
          license: licenseOf(inst?.license),
          description: descriptionOf(inst?.description),
          dev,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    deps: [...group('dependencies', false), ...group('devDependencies', true)],
    installedTotal: installedCount(root),
  };
}
