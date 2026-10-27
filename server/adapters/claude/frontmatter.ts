import { parse } from 'yaml';

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Extrai o bloco YAML entre linhas `---` no topo de um agent/skill.
 * Arquivos reais costumam ter descrições sem aspas que não são YAML válido;
 * nesse caso cai para um parser linha a linha de `chave: valor`.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { data: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: src };
  const raw = src.slice(4, end);
  const lineEnd = src.indexOf('\n', end + 1);
  const body = lineEnd === -1 ? '' : src.slice(lineEnd + 1);
  return { data: parseYamlLenient(raw), body };
}

function parseYamlLenient(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    const data: Record<string, unknown> = {};
    for (const line of raw.split('\n')) {
      const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (m?.[1]) data[m[1]] = unquote(m[2] ?? '');
    }
    return data;
  }
}

function unquote(v: string): string {
  const t = v.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** `tools` aparece como "A, B, C" ou como lista YAML. */
export function strList(v: unknown): string[] | null {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
  }
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return null;
}
