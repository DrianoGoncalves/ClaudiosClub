import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { StaffProfile } from '../../shared/model';
import { tryJson } from '../adapters/claude/fsutil';
import { convertMcps, isMcpRef, MCP_NAME, type KnownMcpNames } from '../mcpAccessRefs';
import { DEFAULT_SECRETS_DIR, hasSecret, type VaultOptions } from '../secretVault';
import { clubDefOf, clubEntry, clubSecretId, McpError, readClub } from './mcp';
import { editFile, extraOf, readDoc } from './mcpLibrary';
import { parseLauncherEntry } from './mcpLaunch';
import { migrateToolsKeys } from './mcpTools';
import { writeAtomic } from './store';

// Migração de uma vez para o modelo Global/Projeto de MCPs (ver mcpAccessRefs.ts e mcpLibrary.ts). Roda no boot, sem bloquear a subida. Nada é
// sobrescrito: o que não dá para mover (nome que já existe na Global) fica onde está e vai no relatório. O ~/.myco/mcps.json não é apagado: é o
// registro das definições que o lançador lê (ver mcpLaunch.ts), e o rollback precisa dele. Nenhum valor literal vai para o ~/.claude.json.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export interface McpMigration {
  at: string;
  /** Os MCPs do Club que agora estão na Global (os que já estavam lá, do mesmo servidor, de uma execução interrompida, entram também). */
  moved: string[];
  /** Os que ficaram onde estavam, com o motivo: o nome já existe na Global (vale a entrada que já estava), ou a entrada não pôde ser montada. */
  conflicts: string[];
  /** Os que migraram mas faltam valor no cofre (`nome (CHAVE)`): o lançador diz o que falta ao subir. */
  semValor: string[];
  /** O backup do ~/.claude.json feito antes de gravar (null: o arquivo não existia, ou nada foi gravado). */
  backup: string | null;
  /** As entradas gravadas agora (sem valor): o rollback só remove a que continua igual. */
  written: Record<string, Obj>;
  /** As fichas convertidas junto (o `mcps` de antes, para o rollback). */
  fichas: Array<{ projectId: string; staffId: string; before: string[] }>;
}

export interface McpMigrationOptions {
  /** ~/.myco/mcps.json: o registro das definições. */
  clubFile: string;
  claudeConfigFile: string;
  /** Pasta dos backups do ~/.claude.json. */
  backupDir: string;
  /** O relatório (`~/.myco/mcps-migracao.json`): com ele, a migração está feita. */
  recordFile: string;
  vault?: VaultOptions;
  /** O lançador que as entradas chamam (padrão: o de agora, ver mcpLaunchCommand). */
  launcher?: { command: string; args: string[] };
}

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

/** A entrada já é a do Club deste servidor (de uma execução interrompida antes de gravar o relatório); a igual ao que seria gravado também conta (ver apply). */
const isOwnPointer = (e: unknown, name: string, clubFile: string): boolean => {
  const ref = isObj(e) ? parseLauncherEntry(e) : null;
  return !!ref && ref.server === name && ref.club !== undefined && path.resolve(ref.club) === path.resolve(clubFile);
};

/**
 * O registro do Club (`~/.myco/mcps.json`) → Global (`mcpServers` do ~/.claude.json): cada MCP vira uma entrada que chama o lançador com o nome
 * do servidor (stdio, e http/sse com cabeçalho) ou `{type, url}` (http/sse sem cabeçalho); os valores seguem no cofre. Uma só gravação do
 * ~/.claude.json, com backup antes. Nome que já existe lá (e não é a entrada do próprio Club) fica como está e vai em `conflicts`. O relatório
 * grava em `recordFile` e, com ele, a migração fica feita: nova execução não toca em nada (`null`). Registro ou ~/.claude.json estragados
 * lançam McpError sem gravar o relatório (tenta de novo no próximo boot).
 */
export async function migrateClubToGlobal(o: McpMigrationOptions): Promise<McpMigration | null> {
  if (await exists(o.recordFile)) return null;
  const club = await readClub(o.clubFile);
  const vaultDir = o.vault?.dir ?? DEFAULT_SECRETS_DIR;
  const pre: string[] = [];
  const semValor: string[] = [];
  const todo: Array<{ name: string; entry: Obj }> = [];
  for (const [name, def] of Object.entries(club?.servers ?? {})) {
    if (!MCP_NAME.test(name) || name === '__proto__') {
      pre.push(`${name} (nome inválido para a Global)`);
      continue;
    }
    const entry = clubEntry(name, def, { clubFile: o.clubFile, vaultDir, launcher: o.launcher });
    if (!entry) {
      pre.push(`${name} (não deu para montar a entrada: caminho com aspas, % ou $, ou sem URL)`);
      continue;
    }
    for (const key of def.env ?? []) if (!(await hasSecret(clubSecretId(name, 'env', key), o.vault))) semValor.push(`${name} (${key})`);
    for (const key of def.headers ?? []) if (!(await hasSecret(clubSecretId(name, 'header', key), o.vault))) semValor.push(`${name} (${key})`);
    todo.push({ name, entry });
  }

  // `editFile` pode refazer a mudança sobre um arquivo que o Claude Code gravou no meio: o que sai daqui é sempre o da última volta.
  let moved: string[] = [];
  let inEdit: string[] = [];
  let written: Record<string, Obj> = {};
  const apply = (servers: Obj) => {
    moved = [];
    inEdit = [];
    written = {};
    for (const t of todo) {
      if (!has(servers, t.name)) {
        servers[t.name] = t.entry;
        moved.push(t.name);
        written[t.name] = t.entry;
      } else if (isOwnPointer(servers[t.name], t.name, o.clubFile) || isDeepStrictEqual(servers[t.name], t.entry)) moved.push(t.name);
      else inEdit.push(`${t.name} (já existe na Global: ficou como estava)`);
    }
  };
  const doc = await readDoc(o.claudeConfigFile);
  apply(isObj(doc?.mcpServers) ? structuredClone(doc.mcpServers as Obj) : {});
  let backup: string | null = null;
  if (Object.keys(written).length) backup = await editFile(o, 'user', null, apply);

  const result: McpMigration = { at: new Date().toISOString(), moved, conflicts: [...pre, ...inEdit], semValor, backup, written, fichas: [] };
  await writeRecord(o.recordFile, result);
  return result;
}

async function writeRecord(file: string, rec: McpMigration): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, JSON.stringify(rec, null, 2) + '\n');
}

/**
 * Entrada do Club cujo lançador não existe mais (o Club mudou de pasta, ou passou do modo de desenvolvimento para o pacote): refaz com o de
 * agora. Só mexe no que `clubDefOf` reconhece como do Club, e só quando o lançador antigo sumiu e o novo existe (nada de alternar entre
 * os dois a cada boot). Devolve os nomes refeitos; sem nada a refazer, nem grava.
 */
export async function repairLauncherEntries(o: Omit<McpMigrationOptions, 'recordFile'>): Promise<string[]> {
  const vaultDir = o.vault?.dir ?? DEFAULT_SECRETS_DIR;
  const club = await readClub(o.clubFile).catch(() => null);
  if (!club) return [];
  const plan = (servers: Obj): Array<{ name: string; entry: Obj }> => {
    const out: Array<{ name: string; entry: Obj }> = [];
    for (const [name, e] of Object.entries(servers)) {
      if (!isObj(e)) continue;
      const c = clubDefOf(e, club, o.clubFile);
      const ref = parseLauncherEntry(e);
      if (!c || !ref || existsSync(ref.launcher)) continue;
      const next = clubEntry(c.name, c.def, { clubFile: o.clubFile, vaultDir, launcher: o.launcher });
      const nextRef = next ? parseLauncherEntry(next) : null;
      if (next && nextRef && existsSync(nextRef.launcher)) out.push({ name, entry: { ...extraOf(e), ...next } });
    }
    return out;
  };
  const doc = await readDoc(o.claudeConfigFile);
  if (!isObj(doc?.mcpServers) || !plan(doc.mcpServers as Obj).length) return [];
  let fixed: string[] = [];
  await editFile(o, 'user', null, (servers) => {
    const todo = plan(servers);
    fixed = todo.map((t) => t.name);
    for (const t of todo) servers[t.name] = t.entry;
  });
  return fixed;
}

export interface StaffMcpConversion {
  /** Fichas regravadas (projeto e id), com o `mcps` de antes. */
  changed: Array<{ projectId: string; staffId: string; before: string[] }>;
  /** Projetos que não deu para ler (as fichas deles ficam como estão até a próxima tentativa). */
  skipped: string[];
}

/**
 * Converte o nome antigo dos MCPs de cada ficha (ver convertMcps) e regrava só as que mudam; `mcps: null` (todos) não muda. `known` dá os nomes
 * que existem na Global e no projeto (lança se não conseguir ler: o projeto é pulado, converter no escuro mandaria nome de projeto para a
 * Global); `list` e `save` são a leitura e a gravação das fichas (os testes trocam).
 */
export async function convertStaffMcps(o: {
  projects: Array<{ id: string; path: string }>;
  known: (project: { id: string; path: string }) => Promise<KnownMcpNames>;
  list: (projectPath: string, projectId: string) => Promise<StaffProfile[]>;
  save: (projectPath: string, p: StaffProfile) => Promise<void>;
}): Promise<StaffMcpConversion> {
  const changed: StaffMcpConversion['changed'] = [];
  const skipped: string[] = [];
  for (const project of o.projects) {
    let known: KnownMcpNames;
    let staff: StaffProfile[];
    try {
      staff = await o.list(project.path, project.id);
      if (!staff.some((p) => p.mcps?.some((m) => !isMcpRef(m)))) continue;
      known = await o.known(project);
    } catch {
      skipped.push(project.id);
      continue;
    }
    for (const p of staff) {
      if (!p.mcps?.some((m) => !isMcpRef(m))) continue;
      const next = convertMcps(p.mcps, known).mcps;
      await o.save(project.path, { ...p, mcps: next });
      changed.push({ projectId: project.id, staffId: p.id, before: p.mcps });
    }
  }
  return { changed, skipped };
}

export interface McpBootResult {
  /** A migração do registro: null = já estava feita; `error`: não deu (registro ou ~/.claude.json estragados), tenta no próximo boot. */
  club: McpMigration | null;
  clubError?: string;
  /** Entradas do Club cujo lançador foi refeito. */
  repaired: string[];
  /** Chaves do arquivo de ferramentas testadas que passaram para o modelo novo. */
  toolsKeys: number;
  fichas: StaffMcpConversion;
}

/**
 * O que roda no boot, nesta ordem: o registro vai para a Global (uma vez); entradas do Club com lançador que sumiu são refeitas; as
 * ferramentas testadas ganham a chave nova; as fichas com nome antigo viram refs (a cada boot, só as que mudam). O `mcps` de antes das
 * fichas convertidas na primeira execução fica no relatório (rollback). Um passo que falha não derruba os outros.
 */
export async function migrateMcpsAtBoot(
  o: McpMigrationOptions & { toolsFile: string } & Pick<Parameters<typeof convertStaffMcps>[0], 'projects' | 'known' | 'list' | 'save'>,
): Promise<McpBootResult> {
  const out: McpBootResult = { club: null, repaired: [], toolsKeys: 0, fichas: { changed: [], skipped: [] } };
  try {
    out.club = await migrateClubToGlobal(o);
  } catch (err) {
    out.clubError = err instanceof Error ? err.message : 'erro';
  }
  out.repaired = await repairLauncherEntries(o).catch(() => []);
  out.toolsKeys = await migrateToolsKeys(o.toolsFile).catch(() => 0);
  out.fichas = await convertStaffMcps(o);
  if (out.club && out.fichas.changed.length) await writeRecord(o.recordFile, { ...out.club, fichas: out.fichas.changed });
  return out;
}

export interface McpRollback {
  /** Entradas removidas do ~/.claude.json (as que continuavam iguais ao que a migração gravou). */
  removed: string[];
  /** As que o usuário mexeu depois: ficaram. */
  kept: string[];
  /** Fichas com o `mcps` de antes de volta. */
  fichas: number;
}

/**
 * Desfaz a migração a partir do relatório: remove do ~/.claude.json só a entrada que ainda é igual à gravada (e, se ela chama o lançador, que
 * `parseLauncherEntry` reconhece como a do Club deste servidor), devolve o `mcps` de antes às fichas e apaga o relatório. O registro e o cofre não foram mexidos,
 * então o modelo antigo volta a achar tudo. A lista de ferramentas testadas não volta (a chave antiga não é recuperável): teste de novo.
 * `null` = sem relatório, nada a desfazer. Alternativa à mão: restaurar o backup do ~/.claude.json que está no relatório.
 */
export async function rollbackMcpMigration(o: {
  recordFile: string;
  claudeConfigFile: string;
  backupDir: string;
  projects: Array<{ id: string; path: string }>;
  list: (projectPath: string, projectId: string) => Promise<StaffProfile[]>;
  save: (projectPath: string, p: StaffProfile) => Promise<void>;
}): Promise<McpRollback | null> {
  const raw = await fs.readFile(o.recordFile, 'utf8').catch(() => null);
  const rec = raw === null ? null : tryJson(raw.replace(/^﻿/, ''));
  if (!isObj(rec)) return null;
  const written = isObj(rec.written) ? rec.written : {};
  const fichas = Array.isArray(rec.fichas) ? rec.fichas : [];

  let removed: string[] = [];
  let kept: string[] = [];
  const apply = (servers: Obj) => {
    removed = [];
    kept = [];
    for (const [name, entry] of Object.entries(written)) {
      const cur = has(servers, name) ? servers[name] : undefined;
      if (cur === undefined) continue;
      // A que chama o lançador tem de ser reconhecida como a do Club deste servidor; `{type, url}` (http/sse sem cabeçalho) não chama nada, e só a igualdade prova que é a gravada.
      const wasPointer = isObj(entry) && parseLauncherEntry(entry) !== null;
      if (isObj(cur) && (!wasPointer || parseLauncherEntry(cur)?.server === name) && isDeepStrictEqual(cur, entry)) {
        delete servers[name];
        removed.push(name);
      } else kept.push(name);
    }
  };
  const doc = await readDoc(o.claudeConfigFile);
  apply(isObj(doc?.mcpServers) ? structuredClone(doc.mcpServers as Obj) : {});
  if (removed.length) await editFile(o, 'user', null, apply);

  let restored = 0;
  for (const f of fichas) {
    if (!isObj(f) || typeof f.projectId !== 'string' || typeof f.staffId !== 'string' || !Array.isArray(f.before)) continue;
    const project = o.projects.find((p) => p.id === f.projectId);
    if (!project) continue;
    const profile = (await o.list(project.path, project.id)).find((p) => p.id === f.staffId);
    if (!profile) continue;
    await o.save(project.path, { ...profile, mcps: f.before.filter((m): m is string => typeof m === 'string') });
    restored++;
  }
  await fs.rm(o.recordFile, { force: true });
  return { removed, kept, fichas: restored };
}
