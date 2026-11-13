import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Routine, StaffProfile } from '../../shared/model';
import { cronError } from '../../shared/cron';
import { PERSONALITIES } from '../../shared/personality';
import { codexModelOrNull, codexProfileError } from '../chat/codexArgs';
import { findSecret } from '../chat/secrets';
import { LIBRARY_DIR, librarySkillsOf } from '../skillLibrary';
import { AUTONOMY, McpAccessSchema, McpPolicySchema, StaffError, type StaffInputParsed } from './store';
import { mcpAccessOfInput } from './mcpAccess';

// Equipe em arquivo: as fichas escolhidas e as skills da biblioteca que elas usam, num JSON só.
//
// Exportar usa allowlist: só os campos que definem o funcionário (cargo, missão, regras, motor, roteiro, rotinas…).
// Id, conversas, servidores, conhecimento, memória, retrato, situação de temporário, ids de cofre e config MCP bruta
// não saem. Campo novo que aparecer no StaffProfile fica de fora até entrar aqui de propósito.
//
// Importar confere o arquivo inteiro antes de gravar qualquer coisa (tudo ou nada). Ids são novos, os vínculos de
// gestor vêm por `ref` (referência local do arquivo), e nada é iniciado: sem conversa, sem despertador.

export const TEAM_FORMAT = 'claudios-club-team';
export const TEAM_VERSION = 1;
/** Limites: passou disso, recusa (na exportação e na importação); nunca corta um arquivo pelo meio. */
export const MAX_SKILL_FILE_BYTES = 200 * 1024;
export const MAX_SKILL_BYTES = 1024 * 1024;
export const MAX_TEAM_BYTES = 3 * 1024 * 1024;
const MAX_STAFF = 50;
const MAX_SKILLS = 100;
const MAX_FILES_PER_SKILL = 50;

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/; // a mesma regra de skillLibrary.ts
const REF = /^[A-Za-z0-9]{1,12}$/;
// A mesma regra do ModelSchema do store (o modelo vai para a linha de comando).
const MODEL = /^[\w.[\]-]{1,60}$/;
const PLAYBOOKS = ['plan-big-execute-small', 'scout-then-build', 'review-gate'] as const;
// Ordem do AUTONOMY (store.ts): plan, manual, acceptEdits, auto, bypassPermissions. Acima de acceptEdits não entra na importação.
const AUTONOMIA_ACIMA_DO_ACCEPT_EDITS = new Set<string>(['auto', 'bypassPermissions']);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

const text = (max: number) => z.string().trim().max(max);
const list = (item: number, max: number) => z.array(text(item)).max(max).default([]);

const RoutineFile = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'id de rotina inválido'),
  name: text(60).min(1, 'dê um nome à rotina'),
  schedule: text(100).superRefine((v, ctx) => {
    const err = cronError(v);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `horário: ${err}` });
  }),
  message: text(4000).min(1, 'escreva a mensagem da rotina'),
  mode: z.enum(['continue', 'new', 'task']).default('continue'),
});

const StaffFile = z.object({
  ref: z.string().regex(REF, 'referência de ficha inválida'),
  name: text(60).min(1, 'informe o nome'),
  role: text(60).min(1, 'informe o cargo'),
  mission: text(4000).min(1, 'informe a missão'),
  rules: list(500, 50),
  doneWhen: text(2000).default(''),
  autonomy: z.enum(AUTONOMY).default('manual'),
  engine: z.enum(['claude', 'codex']).default('claude'),
  model: z.string().regex(MODEL, 'modelo inválido').nullable().default(null),
  effort: z.enum(EFFORTS).nullable().default(null),
  personality: z.enum(PERSONALITIES).nullable().default(null),
  playbook: z.enum(PLAYBOOKS).nullable().default(null),
  worktree: z.boolean().default(false),
  agents: list(500, 100),
  skills: list(500, 100),
  // Só os nomes; `null` = todos os MCPs configurados (vale como veio).
  mcps: z.array(text(100).min(1, 'MCP vazio')).max(100).nullable().default(null),
  // Mesmo schema da ficha (store.ts): o acesso aos MCPs não é segredo, e sem ele a ficha importada ficaria mais permissiva.
  // `mcpPolicy` é o formato antigo (arquivos exportados antes): entra pela mesma leitura (mcpAccessOfInput).
  mcpAccess: McpAccessSchema.optional(),
  mcpPolicy: McpPolicySchema.optional(),
  reportsTo: z.array(z.string().regex(REF, 'gestor inválido')).max(10).default([]),
  routines: z.array(RoutineFile).max(10, 'no máximo 10 rotinas por funcionário').default([]),
});

const SkillFile = z.object({
  name: z.string().regex(SKILL_NAME, 'nome de skill inválido'),
  files: z
    .array(z.object({ path: text(300).min(1, 'caminho vazio'), content: z.string() }))
    .min(1, 'skill sem arquivos')
    .max(MAX_FILES_PER_SKILL),
});

export const TeamFileSchema = z.object({
  format: z.literal(TEAM_FORMAT),
  version: z.literal(TEAM_VERSION),
  exportedAt: text(40),
  staff: z.array(StaffFile).min(1, 'o arquivo não tem nenhuma ficha').max(MAX_STAFF),
  skills: z.array(SkillFile).max(MAX_SKILLS).default([]),
});
export type TeamFile = z.infer<typeof TeamFileSchema>;

type SkillText = { name: string; files: Array<{ path: string; content: string }> };

/** Caminho relativo dentro da pasta da skill (barras normais); null se é absoluto, tem drive, `..`, `.` ou segmento vazio. */
export function safeSkillPath(raw: string): string | null {
  if (raw.includes('\0') || raw.includes(':') || /^[\\/]/.test(raw)) return null;
  const parts = raw.split(/[\\/]/);
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts.join('/');
}

/** Segredo no texto: recusa, sem mostrar o valor (só o tipo, como no resto do Claudio’s Club). */
function secretIn(value: string, where: string): void {
  const hit = findSecret(value);
  if (hit) throw new StaffError(`${where}: ${hit.label} no texto. Tire o segredo antes`);
}

/** Primeiro problema do schema, com o caminho do campo (ex.: `staff.0.name: informe o nome`). */
function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return 'arquivo inválido';
  return (i.path.length ? `${i.path.join('.')}: ` : '') + i.message;
}

/** Lê a pasta de uma skill (texto só; link, binário ou grande demais recusam a exportação inteira). */
async function readSkillDir(root: string, skill: string, rel: string, out: SkillText['files']): Promise<void> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new StaffError(`skill ${skill}: ${p} é um link; não dá para exportar`);
    if (e.isDirectory()) {
      await readSkillDir(root, skill, p, out);
      continue;
    }
    if (!e.isFile()) continue;
    const buf = await fs.readFile(path.join(root, p));
    if (buf.length > MAX_SKILL_FILE_BYTES) throw new StaffError(`skill ${skill}: ${p} é grande demais (máx. 200 KB)`);
    if (buf.includes(0)) throw new StaffError(`skill ${skill}: ${p} não é texto; só arquivos de texto vão no arquivo`);
    const content = buf.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(buf)) throw new StaffError(`skill ${skill}: ${p} não é UTF-8; só arquivos de texto`);
    out.push({ path: p, content });
    if (out.length > MAX_FILES_PER_SKILL) throw new StaffError(`skill ${skill}: arquivos demais (máx. ${MAX_FILES_PER_SKILL})`);
  }
}

/**
 * O arquivo de equipe das fichas dadas (já escolhidas por quem chama) e das skills da biblioteca que elas usam.
 * Recusa a exportação inteira se alguma ficha ou skill tiver segredo, link, binário ou for grande demais.
 */
export async function buildTeamExport(staff: StaffProfile[], opts: { libraryDir?: string; now?: Date } = {}): Promise<TeamFile> {
  // A referência é local do arquivo (`p0`, `p1`…): o id da ficha não sai.
  const refOf = new Map(staff.map((p, i) => [p.id, `p${i}`]));
  const out: TeamFile['staff'] = staff.map((p) => {
    const routines = (p.routines ?? []).map((r) => ({ id: r.id, name: r.name, schedule: r.schedule, message: r.message, mode: r.mode }));
    secretIn([p.name, p.role, p.mission, p.doneWhen, ...p.rules, ...routines.map((r) => r.message)].join('\n'), `ficha ${p.name}`);
    return {
      ref: refOf.get(p.id)!,
      name: p.name,
      role: p.role,
      mission: p.mission,
      rules: [...p.rules],
      doneWhen: p.doneWhen,
      autonomy: p.autonomy,
      engine: p.engine ?? 'claude',
      model: p.model,
      effort: p.effort,
      personality: p.personality ?? null,
      playbook: p.playbook,
      worktree: p.worktree,
      agents: [...p.agents],
      skills: [...p.skills],
      mcps: p.mcps === null ? null : [...p.mcps],
      ...(p.mcpAccess && { mcpAccess: { ...p.mcpAccess } }),
      // Gestor fora do conjunto exportado não tem ref: o vínculo sai.
      reportsTo: p.reportsTo.flatMap((id) => refOf.get(id) ?? []),
      routines,
    };
  });

  const libraryDir = opts.libraryDir ?? LIBRARY_DIR;
  const names = [...new Set(staff.flatMap((p) => p.skills))];
  const skills: SkillText[] = [];
  let total = 0;
  for (const name of (await librarySkillsOf(names, libraryDir)).sort()) {
    const files: SkillText['files'] = [];
    await readSkillDir(path.join(libraryDir, name), name, '', files);
    files.sort((a, b) => a.path.localeCompare(b.path));
    for (const f of files) {
      secretIn(f.content, `skill ${name} (${f.path})`);
      total += Buffer.byteLength(f.content, 'utf8');
    }
    skills.push({ name, files });
  }
  if (total > MAX_SKILL_BYTES) throw new StaffError('skills grandes demais para um arquivo (máx. 1 MB no total)');

  return {
    format: TEAM_FORMAT,
    version: TEAM_VERSION,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    staff: out,
    skills,
  };
}

/** Uma ficha pronta para criar: os campos já filtrados. `reportsTo` são refs (as criadas antes, nesta ordem). */
export interface PlannedStaff {
  ref: string;
  input: Omit<StaffInputParsed, 'reportsTo'>;
  reportsTo: string[];
  /** Entram desligadas (`enabled: false`): nada roda sem ligar de novo na ficha. */
  routines: Routine[];
}

export interface TeamImportPlan {
  /** Na ordem de criação: gestor antes do subordinado. */
  staff: PlannedStaff[];
  /** Skills novas da biblioteca (as que já existem não entram). */
  skills: SkillText[];
  warnings: string[];
}

/**
 * Confere o arquivo inteiro e devolve o que vai ser criado. Não grava nada: quem chama só grava se isto não lançar.
 * Lança `StaffError` com o primeiro problema (formato, schema, caminho, tamanho, segredo, ciclo, regra do motor).
 */
export async function planTeamImport(raw: unknown, ctx: { libraryDir?: string; localMcps: readonly string[] }): Promise<TeamImportPlan> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StaffError('arquivo inválido: o conteúdo não é um objeto');
  if (JSON.stringify(raw).length > MAX_TEAM_BYTES) throw new StaffError('arquivo grande demais (máx. 3 MB)');
  const head = raw as { format?: unknown; version?: unknown };
  if (head.format !== TEAM_FORMAT) throw new StaffError('não é um arquivo de equipe do Claudio’s Club');
  if (head.version !== TEAM_VERSION) throw new StaffError(`versão do arquivo não suportada (esta versão lê a ${TEAM_VERSION})`);
  const parsed = TeamFileSchema.safeParse(raw);
  if (!parsed.success) throw new StaffError(firstIssue(parsed.error));
  const file = parsed.data;
  const warnings: string[] = [];

  // Skills: nome único, caminho seguro, SKILL.md presente, tamanho e segredo.
  const skills: SkillText[] = [];
  let total = 0;
  for (const s of file.skills) {
    if (skills.some((k) => k.name === s.name)) throw new StaffError(`skill repetida no arquivo: ${s.name}`);
    const seen = new Set<string>();
    const files = s.files.map((f) => {
      const p = safeSkillPath(f.path);
      if (!p) throw new StaffError(`skill ${s.name}: caminho recusado (${f.path.slice(0, 80)}); só caminho relativo dentro da pasta da skill`);
      if (seen.has(p)) throw new StaffError(`skill ${s.name}: arquivo repetido (${p})`);
      seen.add(p);
      const size = Buffer.byteLength(f.content, 'utf8');
      if (size > MAX_SKILL_FILE_BYTES) throw new StaffError(`skill ${s.name}: ${p} é grande demais (máx. 200 KB)`);
      total += size;
      secretIn(f.content, `skill ${s.name} (${p})`);
      return { path: p, content: f.content };
    });
    if (!seen.has('SKILL.md')) throw new StaffError(`skill ${s.name}: falta o SKILL.md`);
    skills.push({ name: s.name, files });
  }
  if (total > MAX_SKILL_BYTES) throw new StaffError('skills grandes demais para um arquivo (máx. 1 MB no total)');

  // Fichas: ref única, segredo no texto, regra do motor (Codex sem servidor, ultra só no Codex).
  const byRef = new Map(file.staff.map((s) => [s.ref, s] as const));
  if (byRef.size !== file.staff.length) throw new StaffError('referência de ficha repetida no arquivo');
  for (const s of file.staff) {
    secretIn([s.name, s.role, s.mission, s.doneWhen, ...s.rules, ...s.routines.map((r) => r.message)].join('\n'), `ficha ${s.name}`);
    const err = codexProfileError({ engine: s.engine, servers: [], effort: s.effort });
    if (err) throw new StaffError(`ficha ${s.name}: ${err}`);
  }

  // Vínculos: gestor fora do arquivo ou a própria ficha são descartados; ciclo recusa o arquivo.
  const links = new Map<string, string[]>();
  for (const s of file.staff) {
    const kept: string[] = [];
    for (const r of new Set(s.reportsTo)) {
      if (r === s.ref) warnings.push(`${s.name}: não pode reportar a si mesmo; vínculo descartado`);
      else if (!byRef.has(r)) warnings.push(`${s.name}: gestor que não veio no arquivo; vínculo descartado`);
      else kept.push(r);
    }
    links.set(s.ref, kept);
  }
  const order: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const visit = (ref: string): void => {
    const st = state.get(ref);
    if (st === 'done') return;
    if (st === 'open') throw new StaffError('os vínculos de gestor formam um ciclo; nada foi importado');
    state.set(ref, 'open');
    for (const m of links.get(ref) ?? []) visit(m);
    state.set(ref, 'done');
    order.push(ref);
  };
  for (const s of file.staff) visit(s.ref);

  // Conflito de skill: a da biblioteca fica como está; a do arquivo não entra e o aviso diz isso.
  const local = new Set(await librarySkillsOf(skills.map((k) => k.name), ctx.libraryDir));
  for (const k of skills) if (local.has(k.name)) warnings.push(`skill ${k.name} já existe na biblioteca: a sua foi mantida (a do arquivo não entrou)`);

  // MCPs: só os que existem neste projeto; o resto sai com aviso.
  const mcpsHere = new Set(ctx.localMcps);
  const staff: PlannedStaff[] = order.map((ref) => {
    const s = byRef.get(ref)!;
    // Autonomia mais permissiva que acceptEdits não entra da importação: vira manual, com aviso do valor que veio.
    let autonomy = s.autonomy;
    if (AUTONOMIA_ACIMA_DO_ACCEPT_EDITS.has(s.autonomy)) {
      warnings.push(`${s.name}: autonomia ${s.autonomy} no arquivo; entrou como manual (suba na ficha, se quiser)`);
      autonomy = 'manual';
    }
    for (const m of s.mcps ?? []) if (!mcpsHere.has(m)) warnings.push(`${s.name}: MCP ${m} não existe neste projeto; ficou de fora`);
    if (s.routines.length) warnings.push(`${s.name}: ${s.routines.length} rotina(s) entraram desligadas; ligue na ficha se quiser`);
    // Acesso aos MCPs: o do arquivo (ou o legado, de antes) pela mesma leitura da ficha; o que sobrar é o que entra.
    const access = mcpAccessOfInput(s);
    return {
      ref,
      input: {
        name: s.name,
        role: s.role,
        mission: s.mission,
        firstTask: '',
        autonomy,
        agents: s.agents,
        skills: s.skills,
        mcps: s.mcps === null ? null : s.mcps.filter((m) => mcpsHere.has(m)),
        ...(access && { mcpAccess: access }),
        // Sem conhecimento, servidores, navegador nem contratação: o que é deste projeto e da máquina não vem no arquivo.
        knowledge: [],
        rules: s.rules,
        doneWhen: s.doneWhen,
        engine: s.engine,
        model: s.engine === 'codex' ? codexModelOrNull(s.model) : s.model,
        effort: s.effort,
        personality: s.personality,
        canHire: false,
        playbook: s.playbook,
        worktree: s.worktree,
        servers: [],
        sshWrite: [],
        browser: false,
        portraitDataUrl: null,
      },
      reportsTo: links.get(ref) ?? [],
      routines: s.routines.map((r) => ({ id: r.id, name: r.name, schedule: r.schedule, message: r.message, mode: r.mode, enabled: false })),
    };
  });

  return { staff, skills: skills.filter((k) => !local.has(k.name)), warnings };
}
