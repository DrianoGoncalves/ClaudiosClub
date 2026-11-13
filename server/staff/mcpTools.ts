import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServerInfo } from '../../shared/model';
import { MYCO_HOME } from '../config';
import { tryJson } from '../adapters/claude/fsutil';
import { pathKey } from '../adapters/claude/paths';
import { writeAtomic } from './store';

// Ferramentas de cada MCP, guardadas no último teste que deu certo (biblioteca → Testar):
//   leitura  = a ferramenta declara `annotations.readOnlyHint: true` (é o próprio servidor que diz: protege contra engano do
//              funcionário, não contra um MCP mal-intencionado)
//   escrita  = todo o resto (sem a marcação, conta como escrita)
// O acesso da ficha (`mcpAccess`, ver mcpAccess.ts) usa essa lista: no Claude vai ao hook (mcp-write.json) e no Codex vira `enabled_tools`.
// Sem teste, ou com o MCP mudado depois do teste (outra URL, comando ou argumentos), a lista de leitura fica vazia e a regra vale
// para o servidor inteiro.

/** Fora de qualquer projeto, como a biblioteca. */
export const MCP_TOOLS_FILE = path.join(MYCO_HOME, 'mcp-tools.json');

const MAX_ENTRIES = 300;
const MAX_TOOLS = 500;

const Tool = z.object({ name: z.string().min(1).max(200), readOnly: z.boolean() });
export type McpTool = z.infer<typeof Tool>;
const Entry = z.object({ fingerprint: z.string().max(100), tools: z.array(Tool).max(MAX_TOOLS), testedAt: z.string().max(40) });
type Entry = z.infer<typeof Entry>;
const Doc = z.object({ servers: z.record(z.string(), Entry) });

type Source = McpServerInfo['source'];

/** A chave de um MCP no arquivo: origem + projeto (só local e project, que dependem dele) + nome. */
export function toolsKey(source: Source, projectPath: string | null, name: string): string {
  const where = source === 'local' || source === 'project' ? (projectPath ? pathKey(projectPath) : '') : '';
  return `${source}|${where}|${name}`;
}

/**
 * Impressão do que define o servidor (tipo, URL, comando e argumentos), sem env nem cabeçalhos: mudou, a lista do teste não vale.
 * Só o hash fica no arquivo (a URL pode ter segredo). Trocar só um valor de env (ex.: os toolsets) não muda a impressão: teste de novo.
 */
export function mcpFingerprint(cfg: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const url = str(cfg.url);
  const command = str(cfg.command);
  const type = str(cfg.type) ?? (url ? 'http' : command ? 'stdio' : null);
  const args = Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [];
  return createHash('sha256').update(JSON.stringify([type, url, command, args])).digest('hex').slice(0, 32);
}

async function readDoc(file: string): Promise<Record<string, Entry>> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return {};
  const parsed = Doc.safeParse(tryJson(raw.replace(/^﻿/, '')));
  // Estragado: começa vazio (o pior caso é a regra valer para o servidor inteiro até o próximo teste).
  return parsed.success ? parsed.data.servers : {};
}

/**
 * Guarda as ferramentas do teste que deu certo. Lista fora do formato (nome grande demais, ferramentas demais) não é cortada:
 * a entrada sai, e a regra volta a valer para o servidor inteiro (cortar deixaria uma ferramenta de escrita sem regra).
 * Passou do limite de entradas, saem as testadas há mais tempo.
 */
export async function saveTestedTools(file: string, key: string, fingerprint: string, tools: McpTool[], now = new Date()): Promise<void> {
  const servers = await readDoc(file);
  const valid = z.array(Tool).max(MAX_TOOLS).safeParse(tools);
  if (valid.success) servers[key] = { fingerprint, tools: valid.data, testedAt: now.toISOString() };
  else delete servers[key];
  const kept = Object.entries(servers)
    .sort((a, b) => b[1].testedAt.localeCompare(a[1].testedAt))
    .slice(0, MAX_ENTRIES);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, JSON.stringify({ servers: Object.fromEntries(kept) }, null, 2) + '\n');
}

/** As ferramentas do último teste, se o servidor ainda é o mesmo (impressão igual); senão, null. */
export async function testedTools(file: string, key: string, fingerprint: string): Promise<McpTool[] | null> {
  const e = (await readDoc(file))[key];
  return e && e.fingerprint === fingerprint ? e.tools : null;
}

/** Leitura em lote (um arquivo lido só uma vez). */
export async function testedToolsMany(file: string, wanted: Array<{ key: string; fingerprint: string }>): Promise<Map<string, McpTool[]>> {
  const servers = await readDoc(file);
  const out = new Map<string, McpTool[]>();
  for (const w of wanted) {
    const e = servers[w.key];
    if (e && e.fingerprint === w.fingerprint) out.set(w.key, e.tools);
  }
  return out;
}

/** Nome como o Claude Code põe na ferramenta (`mcp__<servidor>__<ferramenta>`): o que não é letra, número, `_` ou `-` vira `_`. Igual ao do hook. */
export const claudeName = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');

