import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CiStatus } from '../shared/ci';
import type { InboxItem, StaffProfile, Task, TestRun } from '../shared/model';
import {
  expandScope,
  nextVersion,
  parseReleaseBody,
  parseVersion,
  releaseBody,
  releaseProgress,
  RELEASE_MAX_TASKS,
  type ReleaseActor,
  type ReleaseHistory,
  type ReleaseHistoryEntry,
  type ReleaseLogEntry,
  type ReleaseMode,
  type ReleaseProof,
  type ReleaseState,
  type ReleaseView,
} from '../shared/release';
import { writeAtomic } from './atomicWrite';
import type { GitRun } from './autoCommit';
import { assertSafeConfig, githubRepoOf, isProtectedBranch, validBranchName, withNetworkRetry } from './staff/gitSafe';

// Versão com escopo (substitui, na tela, a pausa de versão com prazo). O dono escolhe as tarefas pendentes que entram (as bloqueadoras abertas vêm junto). Enquanto a
// versão está aberta, só as tarefas dela (e os hotfixes) saem da fila e mesclam (`scope`, que o TaskService pergunta em `takeNextFrom`, `start` e `merge`); as de fora esperam.
// Quando todas ficam prontas, a rotina (`sweep`) prepara sozinha: provas (checagem de tipos e testes relacionados aos arquivos da versão), número novo no package.json e
// no lock e o commit local "Versão X". Daí a fila volta. Publicar (push do commit para `release/<versão>` e o PR) e criar a tag (depois da mescla do PR, que é sempre do dono)
// são do dono, ou do funcionário com "Pode versionar e fazer deploy" conforme o portão `publish` da política de fluxo do projeto (server/flowPolicy.ts). Quem executa é sempre
// este servidor, com as travas do myco-git (só origin no GitHub, nunca a branch padrão nem force, sem hooks); o funcionário só pede pela API.
//
// Estado e avisos em `~/.myco/releases/<projeto>.json`: fora do projeto, como a política de fluxo, porque o `<projeto>/.myco` o agente consegue editar (e um escopo, uma preparação
// ou um link de PR forjados mudariam o que é publicado); a ficha nega a escrita. Lido uma vez e guardado na memória; só este serviço grava. O progresso é derivado das tarefas
// (`readTasks`), nunca gravado. O histórico vem das tags anotadas: um `git for-each-ref` quando a tela pede, nunca em polling.

export class ReleaseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,9}$/;
const ID = z.string().regex(/^t-[0-9a-z]{4,20}$/);
const VERSION = z.string().trim().refine((v) => !!parseVersion(v), 'versão no formato X.Y.Z (ex.: 1.5.2)');
const ACTOR = z.object({ staffId: z.string().max(40), name: z.string().max(100) });
/** Quanto o registro guarda e quanto o aviso fica na caixa se você não o dispensar. */
const LOG_MAX = 100;
const NOTICE_KEEP_MS = 7 * 24 * 60 * 60_000;
const NOTICE_MAX = 20;
/** Acima disto, os "testes relacionados" seriam quase a suíte inteira: roda a suíte. */
const RELATED_MAX = 400;
const CODE_FILE = /\.(m|c)?(t|j)sx?$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

const PROOF = z.object({ typecheck: z.enum(['ok', 'none', 'skipped']), tests: z.enum(['ok', 'none', 'skipped']), related: z.number().int().nullable() });
const StateSchema = z.object({
  version: VERSION,
  taskIds: z.array(ID).max(RELEASE_MAX_TASKS + 1),
  hotfixes: z.array(ID).max(RELEASE_MAX_TASKS).default([]),
  docsTaskId: ID.nullable().default(null),
  openedAt: z.string().datetime(),
  prepared: z
    .object({ at: z.string(), sha: z.string().regex(/^[0-9a-f]{7,64}$/), branch: z.string().max(200), proof: PROOF.default({ typecheck: 'skipped', tests: 'skipped', related: null }) })
    .nullable()
    .default(null),
  prepareError: z.object({ at: z.string(), message: z.string().max(2000), testsOutput: z.string().max(8000).optional() }).nullable().default(null),
  published: z.object({ at: z.string(), branch: z.string().max(200), pr: z.string().regex(PR_URL), by: ACTOR.nullable().default(null) }).nullable().default(null),
  tagRequest: z.object({ at: z.string(), by: ACTOR }).nullable().default(null),
  log: z
    .array(z.object({ at: z.string(), action: z.string().max(40), by: ACTOR.nullable(), detail: z.string().max(500).optional() }))
    .max(LOG_MAX)
    .default([]),
});

interface Notice {
  at: string;
  text: string;
}
/** O que `~/.myco/releases/<projeto>.json` guarda: a versão aberta (null = nenhuma) e os avisos da caixa. */
interface Stored {
  release: ReleaseState | null;
  notices: Notice[];
}
const StoredSchema = z.object({
  release: StateSchema.nullable().default(null),
  notices: z.array(z.object({ at: z.string(), text: z.string().max(500) })).max(NOTICE_MAX).default([]),
});
const PROJECT_FILE_ID = /^[A-Za-z0-9-]{1,100}$/;

const OpenBody = z.object({
  version: VERSION,
  taskIds: z.array(ID).min(1, 'marque ao menos uma tarefa').max(RELEASE_MAX_TASKS),
  /** Card de manual e doc: com quem fica (null = não criar). */
  docsStaffId: z.string().regex(/^[a-z0-9-]{1,40}$/).nullable().default(null),
});
const ScopeBody = z.object({
  add: z.array(ID).max(RELEASE_MAX_TASKS).default([]),
  remove: z.array(ID).max(RELEASE_MAX_TASKS).default([]),
  /** Furam a versão: começam e mesclam com ela aberta, sem que ela espere por elas. */
  hotfix: z.array(ID).max(RELEASE_MAX_TASKS).default([]),
});
const PrepareBody = z.object({ skipTests: z.boolean().default(false) });
/** `force`: criar a tag com o status do CI indisponível (só você; CI vermelho ou rodando nunca passa). */
const TagBody = z.object({ force: z.boolean().default(false) });

/** As provas da preparação. `files` = os arquivos de código da versão (null = rodar a suíte inteira). Cada uma: null = o projeto não tem. */
export type ProofRunner = (dir: string, files: string[] | null) => Promise<{ typecheck: TestRun | null; tests: TestRun | null }>;

export interface ReleaseDeps {
  /** Onde fica o estado de cada projeto (`~/.myco/releases`): fora do projeto, onde o agente não grava (a ficha nega a escrita), como a política de fluxo. */
  stateDir: string;
  /** Quem publica no projeto: o portão `publish` da política de fluxo (ver server/flowPolicy.ts, `publishOf`). */
  publishMode: (projectId: string) => Promise<ReleaseMode>;
  projectPath: (projectId: string) => Promise<string | null>;
  projectIds: () => Promise<string[]>;
  readTasks: (dir: string) => Promise<Task[]>;
  readProfile: (projectId: string, staffId: string) => Promise<StaffProfile | null>;
  /** Cria o card de manual e doc em Aguardar (`start: false`). */
  createTask: (projectId: string, body: { title: string; description: string; staffId: string; start: false }) => Promise<{ id: string } | null>;
  /** Põe o card de manual na fila quando as outras ficam prontas. */
  startTask: (projectId: string, taskId: string) => Promise<unknown>;
  runProof: ProofRunner;
  /** O git e o gh sem hooks e com ambiente controlado (ver gitSafe.ts). */
  tools: { git: GitRun; gh: (args: string[], input?: string) => Promise<string> };
  /** O escopo saiu da frente (preparada ou cancelada): a fila do projeto anda já, sem esperar a rodada. */
  onScopeLifted?: (projectId: string) => void;
  /** O CI de um commit (ver server/ciStatus.ts): a tag só sai com o CI do commit da mescla verde (ou sem CI). Sem ele, a regra não vale (testes antigos). */
  ci?: (projectId: string, sha: string) => Promise<CiStatus>;
  log?: (line: string) => void;
  now?: () => Date;
}

/** Quem chama pela API (o token da conversa). */
type CallerLike = { staffId: string | null; projectId: string } | null;

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new ReleaseError(400, r.error.issues[0]?.message ?? 'dados inválidos');
  return r.data;
};
const firstLine = (err: unknown) => ((err as Error)?.message ?? String(err)).split(/\r?\n/).find((l) => l.trim())?.replace(/^(fatal|error): /, '').slice(0, 300) ?? 'falhou';
const who = (by: ReleaseActor) => by?.name ?? 'você';

export class ReleaseService {
  /** O que cada projeto já lido guarda (versão aberta e avisos). Só este serviço grava o arquivo. */
  private stored = new Map<string, Stored>();
  private locks = new Map<string, Promise<unknown>>();
  private preparing = new Set<string>();
  /** A preparação em curso de cada projeto (a rotina não abre outra por cima; os testes esperam por `settled`). */
  private running = new Map<string, Promise<void>>();
  private sweeping = false;

  constructor(private readonly deps: ReleaseDeps) {}

  private now = () => this.deps.now?.() ?? new Date();
  private log = (line: string) => (this.deps.log ?? ((l) => console.warn(`[versão] ${l}`)))(line);

  /** Uma escrita por vez por projeto (abrir, mudar escopo, preparar, publicar, tag, cancelar). */
  private locked<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(projectId, run.catch(() => {}));
    return run;
  }

  private async dir(projectId: string): Promise<string> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) throw new ReleaseError(404, 'projeto não encontrado');
    return dir;
  }

  /** Lê um JSON do projeto: ausente = null; estragado vai para `.bad` (com log) e vale como ausente. */
  private async readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw === null) return null;
    let r: ReturnType<typeof schema.safeParse> | null = null;
    try {
      r = schema.safeParse(JSON.parse(raw.replace(/^\uFEFF/, '')));
    } catch {
      r = null;
    }
    if (r?.success) return r.data;
    await fs.rename(file, `${file}.bad`).catch(() => {});
    this.log(`${file} estragado; guardado em ${file}.bad`);
    return null;
  }

  private fileOf(projectId: string): string {
    if (!PROJECT_FILE_ID.test(projectId)) throw new ReleaseError(400, 'projeto inválido');
    return path.join(this.deps.stateDir, `${projectId}.json`);
  }

  /** O que o projeto guarda: lido do disco uma vez e depois da memória (ausente = nada; estragado vai para `.bad` e vale como nada). */
  private async load(projectId: string): Promise<Stored> {
    const had = this.stored.get(projectId);
    if (had) return had;
    const found = (await this.readJson(this.fileOf(projectId), StoredSchema)) as Stored | null;
    const s = found ?? { release: null, notices: [] };
    this.stored.set(projectId, s);
    return s;
  }

  private async persist(projectId: string, next: Stored): Promise<void> {
    const cut = this.now().getTime() - NOTICE_KEEP_MS;
    const trimmed: Stored = {
      release: next.release ? { ...next.release, log: next.release.log.slice(-LOG_MAX) } : null,
      notices: next.notices.filter((n) => Date.parse(n.at) > cut).slice(-NOTICE_MAX),
    };
    const file = this.fileOf(projectId);
    if (!trimmed.release && !trimmed.notices.length) await fs.rm(file, { force: true });
    else {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeAtomic(file, JSON.stringify(trimmed, null, 2) + '\n');
    }
    this.stored.set(projectId, trimmed);
  }

  /** A versão aberta do projeto (null = nenhuma). */
  async state(projectId: string): Promise<ReleaseState | null> {
    return (await this.load(projectId)).release;
  }

  private async save(projectId: string, next: ReleaseState | null): Promise<void> {
    await this.persist(projectId, { ...(await this.load(projectId)), release: next });
  }

  private entry(action: ReleaseLogEntry['action'], by: ReleaseActor, detail?: string): ReleaseLogEntry {
    return { at: this.now().toISOString(), action, by, ...(detail && { detail: detail.slice(0, 500) }) };
  }

  /** Quem publica no projeto (o portão da política de fluxo). Política ilegível: só você. */
  private mode(projectId: string): Promise<ReleaseMode> {
    return this.deps.publishMode(projectId).catch(() => 'manual' as ReleaseMode);
  }

  /** Um aviso de fora da versão para a mesma caixa (o deploy como código, ver server/deploy.ts). */
  addNotice(projectId: string, text: string): Promise<void> {
    return this.notify(projectId, text.slice(0, 500));
  }

  /** Um aviso para a caixa (publicação, pedido de tag, preparação). Falha ao gravar não derruba quem avisou. */
  private async notify(projectId: string, text: string): Promise<void> {
    const s = await this.load(projectId);
    await this.persist(projectId, { ...s, notices: [...s.notices, { at: this.now().toISOString(), text }] }).catch((err) => this.log(`aviso não gravado: ${firstLine(err)}`));
  }

  /** O que a fila e a mescla perguntam: o escopo (com os hotfixes) enquanto a versão está aberta e ainda não preparada; null = sem trava. */
  async scope(projectId: string): Promise<{ version: string; ids: ReadonlySet<string> } | null> {
    const st = await this.state(projectId);
    return st && !st.prepared ? { version: st.version, ids: new Set([...st.taskIds, ...st.hotfixes]) } : null;
  }

  /** O estado e o progresso (custo fixo: o arquivo vem da memória, as tarefas do `readTasks` guardado). Null = projeto não existe. */
  async view(projectId: string): Promise<ReleaseView | null> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return null;
    const mode = await this.mode(projectId);
    const st = await this.state(projectId);
    if (!st) return { release: null, mode, tasks: [], done: 0, total: 0, ready: false, preparing: false };
    return { release: st, mode, ...releaseProgress(await this.deps.readTasks(dir), st), preparing: this.preparing.has(projectId) };
  }

  /**
   * Quem publica: você (`fromBrowser`) ou o funcionário pela API, com o token da conversa deste projeto, a permissão "Pode versionar e fazer deploy" na ficha, autonomia auto ou
   * sem travas (a mesma regra do push do myco-git) e o modo do projeto que deixa (`need`). O resto: 403, antes de qualquer git.
   */
  private async actor(projectId: string, fromBrowser: boolean, caller: CallerLike): Promise<ReleaseActor> {
    if (fromBrowser) return null;
    const me = caller?.staffId;
    if (!me || caller.projectId !== projectId) throw new ReleaseError(403, 'só você, pelo Claudio’s Club, ou o funcionário com a permissão “Pode versionar e fazer deploy”, com o token da conversa dele (x-myco-token), publica a versão');
    const profile = await this.deps.readProfile(projectId, me).catch(() => null);
    if (!profile?.canRelease) throw new ReleaseError(403, 'a sua ficha não tem a permissão “Pode versionar e fazer deploy”: peça ao usuário para ligá-la');
    if (profile.autonomy !== 'auto' && profile.autonomy !== 'bypassPermissions') throw new ReleaseError(403, 'publicar exige autonomia auto ou sem travas na ficha (a mesma regra do push do myco-git); o usuário muda na ficha');
    if ((await this.mode(projectId)) === 'manual') throw new ReleaseError(403, 'neste projeto só o usuário publica a versão (política de fluxo: publicação manual); ele muda na página da versão');
    return { staffId: me, name: profile.name.slice(0, 100) };
  }

  /**
   * A política de fluxo mudou (o portão `publish`, pela rota `flow-policy`): voltar a `manual` é o "desligar agora". Vale para o próximo pedido, e o pedido de tag pendente de um funcionário é
   * recusado. Falha não desfaz a política (já gravada).
   */
  async publishModeChanged(projectId: string, mode: ReleaseMode): Promise<void> {
    if (mode !== 'manual') return;
    await this.locked(projectId, async () => {
      const st = await this.state(projectId);
      if (st?.tagRequest) await this.save(projectId, { ...st, tagRequest: null, log: [...st.log, this.entry('tag-declined', null, 'publicação por funcionários desligada')] });
    }).catch((err) => this.log(`pedido de tag de ${projectId} não recusado: ${firstLine(err)}`));
  }

  /** Abre a versão: número livre (sem tag igual), tarefas pendentes do projeto, bloqueadoras abertas junto; o card de manual, se pedido. */
  async open(projectId: string, body: unknown, fromBrowser: boolean): Promise<ReleaseView | null> {
    if (!fromBrowser) throw new ReleaseError(403, 'só você, pelo Claudio’s Club, abre uma versão');
    const input = parse(OpenBody, body);
    return this.locked(projectId, async () => {
      const dir = await this.dir(projectId);
      if (await this.state(projectId)) throw new ReleaseError(409, 'já há uma versão aberta neste projeto: feche ou cancele antes');
      const tag = `v${input.version}`;
      const exists = await this.deps.tools.git(dir, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).then(() => true, () => false);
      if (exists) throw new ReleaseError(409, `a tag ${tag} já existe: escolha outro número`);
      const tasks = await this.deps.readTasks(dir);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const bad = input.taskIds.filter((id) => !isPending(byId.get(id)));
      if (bad.length) throw new ReleaseError(409, `só entram tarefas pendentes: ${bad.join(', ')} não está pendente`);
      const ids = expandScope(tasks, input.taskIds);
      if (ids.length > RELEASE_MAX_TASKS) throw new ReleaseError(409, `com as dependências, a versão teria ${ids.length} tarefas (máx. ${RELEASE_MAX_TASKS})`);
      let docsTaskId: string | null = null;
      if (input.docsStaffId) {
        const titles = ids.map((id) => `- ${byId.get(id)!.title}`).join('\n');
        const card = await this.deps.createTask(projectId, {
          title: `Manual e doc da versão ${input.version}`,
          description: `Atualize o manual e a documentação de uso do projeto com o que a versão ${input.version} traz. Começa sozinho quando as outras tarefas da versão ficarem prontas.\n\nTarefas da versão:\n${titles}`,
          staffId: input.docsStaffId,
          start: false,
        });
        docsTaskId = card?.id ?? null;
      }
      const st: ReleaseState = {
        version: input.version,
        taskIds: docsTaskId ? [...ids, docsTaskId] : ids,
        hotfixes: [],
        docsTaskId,
        openedAt: this.now().toISOString(),
        prepared: null,
        prepareError: null,
        published: null,
        tagRequest: null,
        log: [this.entry('opened', null, `${ids.length} tarefas`)],
      };
      await this.save(projectId, st);
      return this.view(projectId);
    });
  }

  /**
   * Põe ou tira tarefas do escopo (só antes de preparar). Pôr puxa as bloqueadoras; tirar uma de que outra do escopo depende é recusado. `hotfix`: a tarefa fura a versão
   * aberta (começa e mescla), mas a versão não espera por ela; entra no changelog se ficar pronta antes da preparação.
   */
  async changeScope(projectId: string, body: unknown, fromBrowser: boolean): Promise<ReleaseView | null> {
    if (!fromBrowser) throw new ReleaseError(403, 'só você, pelo Claudio’s Club, muda a versão');
    const input = parse(ScopeBody, body);
    return this.locked(projectId, async () => {
      const dir = await this.dir(projectId);
      const st = await this.state(projectId);
      if (!st) throw new ReleaseError(409, 'não há versão aberta');
      if (st.prepared) throw new ReleaseError(409, 'a versão já foi preparada: o escopo não muda mais (descarte a preparação antes)');
      const tasks = await this.deps.readTasks(dir);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const bad = [...input.add, ...input.hotfix].filter((id) => !isPending(byId.get(id)));
      if (bad.length) throw new ReleaseError(409, `só entram tarefas pendentes: ${bad.join(', ')} não está pendente`);
      const remove = new Set(input.remove);
      const kept = st.taskIds.filter((id) => !remove.has(id));
      for (const id of remove) {
        const needs = kept.filter((k) => byId.get(k)?.status !== 'done' && (byId.get(k)?.blockedBy ?? []).includes(id));
        if (needs.length) throw new ReleaseError(409, `${needs.join(', ')} depende de ${id}: tire a dependente junto`);
      }
      const ids = [...new Set([...kept, ...expandScope(tasks, input.add)])];
      if (ids.length > RELEASE_MAX_TASKS + 1) throw new ReleaseError(409, `a versão teria ${ids.length} tarefas (máx. ${RELEASE_MAX_TASKS})`);
      const hotfixes = [...new Set([...st.hotfixes.filter((id) => !remove.has(id)), ...input.hotfix])].filter((id) => !ids.includes(id));
      const docsTaskId = st.docsTaskId && ids.includes(st.docsTaskId) ? st.docsTaskId : null;
      const log = [...st.log];
      if (input.add.length || input.remove.length) log.push(this.entry('scope', null, [input.add.length && `pôs ${input.add.join(', ')}`, input.remove.length && `tirou ${input.remove.join(', ')}`].filter(Boolean).join('; ')));
      if (input.hotfix.length) log.push(this.entry('hotfix', null, input.hotfix.join(', ')));
      // Escopo mexido: a falha antiga de preparação já não vale (a automática tenta de novo).
      await this.save(projectId, { ...st, taskIds: ids, hotfixes, docsTaskId, prepareError: null, log });
      return this.view(projectId);
    });
  }

  /**
   * Prepara já (o botão; a automática é a `sweep`): provas, número novo e o commit local, por trás (os testes levam minutos): a resposta volta na hora com `preparing`, e a
   * tela acompanha pela leitura. A falha fica em `prepareError`. `skipTests` = preparar sem as provas (você decidiu). Faltando tarefa: 409 na hora.
   */
  async prepare(projectId: string, body: unknown, fromBrowser: boolean): Promise<ReleaseView | null> {
    if (!fromBrowser) throw new ReleaseError(403, 'só você, pelo Claudio’s Club, prepara a versão');
    const { skipTests } = parse(PrepareBody, body);
    const dir = await this.dir(projectId);
    const st = await this.state(projectId);
    if (!st) throw new ReleaseError(409, 'não há versão aberta');
    if (!st.prepared && !this.preparing.has(projectId)) {
      const progress = releaseProgress(await this.deps.readTasks(dir), st);
      if (!progress.ready) throw new ReleaseError(409, `faltam ${progress.total - progress.done} de ${progress.total} tarefas ficarem prontas`);
      void this.startPrepare(projectId, skipTests, false);
    }
    return this.view(projectId);
  }

  /** Roda a preparação por trás, uma por projeto. Falha prevista já foi gravada por `doPrepare`; a imprevista (disco, git) é gravada aqui. `auto` = a rotina (vira aviso na caixa). */
  private startPrepare(projectId: string, skipTests: boolean, auto: boolean): Promise<void> {
    const current = this.running.get(projectId);
    if (current) return current;
    this.preparing.add(projectId);
    const run = this.locked(projectId, () => this.doPrepare(projectId, skipTests))
      .then(async () => {
        const st = await this.state(projectId);
        if (auto && st?.prepared) await this.notify(projectId, `versão ${st.version} preparada (commit ${st.prepared.sha.slice(0, 7)}): falta publicar`);
      })
      .catch(async (err: unknown) => {
        this.log(`versão de ${projectId} não preparou: ${firstLine(err)}`);
        const cur = await this.state(projectId).catch(() => null);
        if (!cur || cur.prepared) return;
        const message = err instanceof ReleaseError ? err.message : `a preparação falhou: ${firstLine(err)}`;
        if (!(err instanceof ReleaseError)) await this.save(projectId, { ...cur, prepareError: { at: this.now().toISOString(), message } }).catch(() => {});
        if (auto) await this.notify(projectId, `versão ${cur.version} não preparou: ${message}`);
      })
      .finally(() => {
        this.preparing.delete(projectId);
        this.running.delete(projectId);
      });
    this.running.set(projectId, run);
    return run;
  }

  /** Espera a preparação em curso do projeto, se houver (para os testes). */
  async settled(projectId: string): Promise<void> {
    await this.running.get(projectId);
  }

  /** Os arquivos de código mudados desde a última tag `v*` (os testes relacionados vêm deles); null = rodar a suíte inteira (sem tag, demais, ou nome fora do seguro). */
  private async versionFiles(dir: string): Promise<string[] | null> {
    const git = this.deps.tools.git;
    const tag = (await git(dir, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD']).catch(() => '')).trim();
    if (!tag) return null;
    const out = await git(dir, ['diff', '--name-only', '--diff-filter=d', `${tag}..HEAD`]).catch(() => null);
    if (out === null) return null;
    const files = out.split(/\r?\n/).map((f) => f.trim()).filter((f) => CODE_FILE.test(f));
    if (files.length > RELATED_MAX || files.some((f) => !SAFE_PATH.test(f) || f.startsWith('-'))) return null;
    return files;
  }

  private async doPrepare(projectId: string, skipTests: boolean): Promise<void> {
    const dir = await this.dir(projectId);
    const st = await this.state(projectId);
    if (!st) throw new ReleaseError(409, 'não há versão aberta');
    if (st.prepared) return;
    const progress = releaseProgress(await this.deps.readTasks(dir), st);
    if (!progress.ready) throw new ReleaseError(409, `faltam ${progress.total - progress.done} de ${progress.total} tarefas ficarem prontas`);
    const git = this.deps.tools.git;
    const fail = async (message: string, testsOutput?: string): Promise<never> => {
      const cur = (await this.state(projectId)) ?? st;
      await this.save(projectId, {
        ...cur,
        prepareError: { at: this.now().toISOString(), message, ...(testsOutput && { testsOutput: testsOutput.slice(-8000) }) },
        log: [...cur.log, this.entry('prepare-failed', null, message)],
      });
      throw new ReleaseError(409, message);
    };
    const files = ['package.json', 'package-lock.json'];
    const present = (await Promise.all(files.map((f) => fs.access(path.join(dir, f)).then(() => f, () => null)))).filter((f): f is string => !!f);
    if (present.length) {
      const dirty = (await git(dir, ['status', '--porcelain', '--', ...present]).catch((err) => fail(`não deu para ler o git: ${firstLine(err)}`))).trim();
      if (dirty) await fail(`${present.join(' e ')} tem mudança sem commit: commite ou desfaça antes de preparar a versão`);
    }
    let proof: ReleaseProof = { typecheck: 'skipped', tests: 'skipped', related: null };
    if (!skipTests) {
      const changed = await this.versionFiles(dir);
      const r = await this.deps.runProof(dir, changed).catch((err) => fail(`as provas não rodaram: ${firstLine(err)}`));
      if (r.typecheck && !r.typecheck.ok) await fail(r.typecheck.timedOut ? 'a checagem de tipos passou do tempo-limite: tente de novo com a máquina mais livre' : 'a checagem de tipos falhou: nada foi commitado', r.typecheck.output);
      if (r.tests && !r.tests.ok) {
        const failed = r.tests.failedFiles?.map((f) => f.file).slice(0, 10).join(', ');
        await fail(r.tests.timedOut ? 'os testes passaram do tempo-limite: tente de novo com a máquina mais livre' : `os testes falharam${failed ? ` (${failed})` : ''}: nada foi commitado`, r.tests.output);
      }
      proof = { typecheck: r.typecheck ? 'ok' : 'none', tests: r.tests ? 'ok' : 'none', related: changed ? changed.length : null };
    }
    const v = st.version;
    for (const f of present) {
      const file = path.join(dir, f);
      const json = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as { version?: string; packages?: Record<string, { version?: string }> };
      json.version = v;
      if (f === 'package-lock.json' && json.packages?.['']) json.packages[''].version = v;
      await writeAtomic(file, JSON.stringify(json, null, 2) + '\n');
    }
    const body = releaseBody('', await this.changelog(dir, st));
    // `--only` (com `--allow-empty`): o commit leva só estes arquivos, nunca o que outra conversa deixou no índice.
    await git(dir, ['commit', '--only', '--allow-empty', '-m', `Versão ${v}`, '-m', body, '--', ...present]).catch((err) => fail(`o commit da versão falhou: ${firstLine(err)}`));
    const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')).trim();
    const proofText = skipTests ? 'sem as provas (liberado por você)' : `tipos ${proof.typecheck}, testes ${proof.tests}${proof.related !== null ? ` (relacionados a ${proof.related} arquivos)` : ''}`;
    await this.save(projectId, { ...st, prepared: { at: this.now().toISOString(), sha, branch, proof }, prepareError: null, log: [...st.log, this.entry('prepared', null, `${sha.slice(0, 7)}; ${proofText}`)] });
    this.deps.onScopeLifted?.(projectId);
  }

  /** O changelog: os títulos das tarefas prontas da versão e dos hotfixes prontos (marcados). */
  private async changelog(dir: string, st: ReleaseState): Promise<Array<{ id: string; title: string }>> {
    const tasks = await this.deps.readTasks(dir);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const done = (id: string) => (byId.get(id)?.status === 'done' ? byId.get(id)! : null);
    return [
      ...st.taskIds.map(done).filter((t): t is Task => !!t).map((t) => ({ id: t.id, title: t.title })),
      ...st.hotfixes.map(done).filter((t): t is Task => !!t).map((t) => ({ id: t.id, title: `[hotfix] ${t.title}` })),
    ];
  }

  /**
   * Descarta a versão preparada antes de publicar: um commit novo que volta o número no package.json e no lock ao de antes (sem reset nem reescrita de história; o resto
   * desses arquivos, mudado depois por outra tarefa, fica). A versão volta a ficar aberta, com a trava. Depois de publicada, não: o PR já existe.
   */
  async discard(projectId: string, fromBrowser: boolean): Promise<ReleaseView | null> {
    if (!fromBrowser) throw new ReleaseError(403, 'só você, pelo Claudio’s Club, descarta a versão preparada');
    await this.locked(projectId, async () => {
      const dir = await this.dir(projectId);
      const st = await this.state(projectId);
      if (!st?.prepared) throw new ReleaseError(409, 'não há versão preparada para descartar');
      if (st.published) throw new ReleaseError(409, 'a versão já foi publicada (o PR existe): feche o PR no GitHub e cancele a versão');
      const git = this.deps.tools.git;
      const files = ['package.json', 'package-lock.json'];
      const present = (await Promise.all(files.map((f) => fs.access(path.join(dir, f)).then(() => f, () => null)))).filter((f): f is string => !!f);
      if (present.length && (await git(dir, ['status', '--porcelain', '--', ...present])).trim()) throw new ReleaseError(409, `${present.join(' e ')} tem mudança sem commit: commite ou desfaça antes`);
      for (const f of present) {
        const before = await git(dir, ['show', `${st.prepared.sha}~1:${f}`]).catch(() => null);
        const old = before ? ((JSON.parse(before.replace(/^\uFEFF/, '')) as { version?: string }).version ?? null) : null;
        if (!old) continue;
        const file = path.join(dir, f);
        const json = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as { version?: string; packages?: Record<string, { version?: string }> };
        json.version = old;
        if (f === 'package-lock.json' && json.packages?.['']) json.packages[''].version = old;
        await writeAtomic(file, JSON.stringify(json, null, 2) + '\n');
      }
      await git(dir, ['commit', '--only', '--allow-empty', '-m', `Descarta a versão ${st.version} (não publicada)`, '--', ...present]).catch((err) => {
        throw new ReleaseError(409, `o commit do descarte falhou: ${firstLine(err)}`);
      });
      await this.save(projectId, { ...st, prepared: null, prepareError: null, log: [...st.log, this.entry('discarded', null, st.prepared.sha.slice(0, 7))] });
    });
    return this.view(projectId);
  }

  /** O `owner/repo` do origin (só GitHub) e a branch padrão, com a config do repositório conferida (nada nela roda com as suas credenciais). */
  private async remote(dir: string): Promise<{ repo: string; base: string }> {
    const git = this.deps.tools.git;
    const url = (await git(dir, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
    const gh = githubRepoOf(url);
    if (!gh) throw new ReleaseError(409, 'o origin deste projeto não é um repositório do GitHub');
    await assertSafeConfig(git, dir).catch((err) => {
      throw new ReleaseError(409, (err as Error).message);
    });
    const head = (await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
    const base = head.replace(/^origin\//, '') || 'main';
    // Destino só a branch principal (main/master): é ela que as instalações seguem.
    if (!isProtectedBranch(base, null)) throw new ReleaseError(409, `a branch padrão do origin é ${base}: a ferramenta de versão só publica para main ou master`);
    return { repo: `github.com/${gh.owner}/${gh.repo}`, base };
  }

  /**
   * Push do commit da versão para `release/<versão>` (nunca force, nunca a branch padrão, sem tags) e o PR para a branch padrão, com o changelog. Você, ou o funcionário com a permissão
   * nos modos `staff-pr` e `staff-all`. O servidor confere antes: versão preparada (com as provas ou o seu "sem as provas"). Repetir depois de falhar no PR refaz só o que falta.
   */
  async publish(projectId: string, fromBrowser: boolean, caller: CallerLike = null): Promise<ReleaseView | null> {
    const by = await this.actor(projectId, fromBrowser, caller);
    await this.locked(projectId, async () => {
      const dir = await this.dir(projectId);
      const st = await this.state(projectId);
      if (!st?.prepared) throw new ReleaseError(409, 'a versão ainda não foi preparada (commit local com as provas)');
      if (st.published) return;
      const { repo, base } = await this.remote(dir);
      const branch = `release/${st.version}`;
      if (!validBranchName(branch) || isProtectedBranch(branch, base)) throw new ReleaseError(409, `nome de branch inválido: ${branch}`);
      const git = this.deps.tools.git;
      try {
        await withNetworkRetry(() => git(dir, ['push', '--no-verify', '--no-recurse-submodules', '--no-follow-tags', 'origin', `${st.prepared!.sha}:refs/heads/${branch}`], { timeoutMs: 120_000 }));
      } catch (err) {
        const why = firstLine(err);
        throw new ReleaseError(409, /non-fast-forward|fetch first|rejected/i.test(why) ? `o GitHub já tem ${branch} com outros commits (sem force): ${why}` : `o push falhou: ${why}`);
      }
      // O changelog do PR: os títulos das tarefas da versão (o commit da versão já os leva também).
      const body = releaseBody(`Versão ${st.version}, publicada por ${who(by)}. A mescla é do dono; depois dela, a tag vX publica a versão.`, await this.changelog(dir, st));
      let out: string;
      try {
        out = await withNetworkRetry(() => this.deps.tools.gh(['pr', 'create', '-R', repo, `--head=${branch}`, `--base=${base}`, `--title=Versão ${st.version}`, '--body-file=-'], body));
      } catch (err) {
        throw new ReleaseError(409, `o push foi feito, mas o PR não abriu: ${firstLine(err)}`);
      }
      const pr = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
      // O link vai para a tela (href) e volta ao gh como argumento: só o formato de PR do GitHub passa.
      if (!PR_URL.test(pr)) throw new ReleaseError(409, `o push foi feito, mas o gh não devolveu o link do PR: ${pr.slice(0, 200)}`);
      await this.save(projectId, { ...st, published: { at: this.now().toISOString(), branch, pr, by }, log: [...st.log, this.entry('published', by, pr)] });
      await this.notify(projectId, `versão ${st.version}: PR aberto por ${who(by)} (${pr}); a mescla é sua`);
    });
    return this.view(projectId);
  }

  /**
   * A tag `vX`, depois da mescla do PR: anotada no commit da mescla, com o changelog e quem publicou, e o push dela. É ela que atualiza as instalações. A versão fecha.
   * Você cria direto (e assim aprova o pedido pendente). O funcionário com a permissão: no modo `staff-all` cria (e você é avisado); no `staff-pr` só pede (`tagRequest`), e o
   * pedido espera o seu ok na página da versão, com aviso na caixa. Antes de tudo, o CI do commit da mescla tem de estar verde (ou o repositório sem CI): vermelho ou rodando
   * recusa (409); indisponível (sem token, sem rede) recusa, menos para você com `force`.
   */
  async tag(projectId: string, fromBrowser: boolean, caller: CallerLike = null, body: unknown = {}): Promise<ReleaseView | null> {
    const by = await this.actor(projectId, fromBrowser, caller);
    const { force } = parse(TagBody, body);
    await this.locked(projectId, async () => {
      const dir = await this.dir(projectId);
      const st = await this.state(projectId);
      if (!st?.published) throw new ReleaseError(409, 'publique a versão (PR) antes de criar a tag');
      const { repo, base } = await this.remote(dir);
      const merge = await this.mergeOf(dir, repo, base, st.published.pr);
      const ci = this.deps.ci ? await this.deps.ci(projectId, merge) : null;
      if (ci?.state === 'failure') throw new ReleaseError(409, `o CI do commit da mescla (${merge.slice(0, 7)}) falhou: corrija antes de criar a tag`);
      if (ci?.state === 'pending') throw new ReleaseError(409, `o CI do commit da mescla (${merge.slice(0, 7)}) ainda está rodando: tente quando ficar verde`);
      if (ci?.state === 'unavailable' && !(force && !by)) throw new ReleaseError(409, `status do CI indisponível (${ci.reason ?? 'sem resposta do GitHub'})${by ? '' : ': confira no GitHub e crie a tag mesmo assim, se for o caso'}`);
      if (by && (await this.mode(projectId)) === 'staff-pr') {
        if (st.tagRequest) return;
        await this.save(projectId, { ...st, tagRequest: { at: this.now().toISOString(), by }, log: [...st.log, this.entry('tag-requested', by)] });
        await this.notify(projectId, `${by.name} pediu a tag v${st.version} (o PR já foi mesclado): aprove na página da versão`);
        return;
      }
      const git = this.deps.tools.git;
      const tag = `v${st.version}`;
      const existing = (await git(dir, ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]).catch(() => '')).trim();
      if (existing && existing !== merge) throw new ReleaseError(409, `a tag ${tag} já existe em outro commit`);
      if (!existing) {
        const approved = st.tagRequest && !by ? `Pedida por ${st.tagRequest.by.name}, aprovada por você.` : `Publicada por ${who(by)}.`;
        const summary = [`PR: ${st.published.pr}`, approved].join('\n');
        await git(dir, ['tag', '-a', tag, merge, '-F', '-'], { input: `Versão ${st.version}\n\n${releaseBody(summary, await this.changelog(dir, st))}\n` });
      }
      try {
        await withNetworkRetry(() => git(dir, ['push', '--no-verify', 'origin', `refs/tags/${tag}`], { timeoutMs: 120_000 }));
      } catch (err) {
        throw new ReleaseError(409, `a tag foi criada aqui, mas o push dela falhou (tente de novo): ${firstLine(err)}`);
      }
      await this.notify(projectId, `versão ${st.version} publicada: tag ${tag} enviada por ${who(by)}; as instalações passam a ver a atualização`);
      await this.save(projectId, null);
    });
    return this.view(projectId);
  }

  /** O commit da mescla do PR (o PR tem de estar mesclado), já buscado da branch padrão. */
  private async mergeOf(dir: string, repo: string, base: string, prUrl: string): Promise<string> {
    let pr: { state?: string; mergeCommit?: { oid?: string } | null };
    try {
      pr = JSON.parse(await withNetworkRetry(() => this.deps.tools.gh(['pr', 'view', prUrl, '-R', repo, '--json', 'state,mergeCommit'])));
    } catch (err) {
      throw new ReleaseError(409, `não consegui ler o PR: ${firstLine(err)}`);
    }
    const oid = pr.mergeCommit?.oid ?? '';
    if (pr.state !== 'MERGED' || !/^[0-9a-f]{40}$/.test(oid)) throw new ReleaseError(409, 'o PR ainda não foi mesclado no GitHub (a mescla é sempre do dono)');
    const git = this.deps.tools.git;
    await withNetworkRetry(() => git(dir, ['fetch', '--no-tags', 'origin', base], { timeoutMs: 120_000 })).catch((err) => {
      throw new ReleaseError(409, `não consegui buscar ${base}: ${firstLine(err)}`);
    });
    await git(dir, ['cat-file', '-e', `${oid}^{commit}`]).catch(() => {
      throw new ReleaseError(409, `o commit da mescla (${oid.slice(0, 7)}) não veio com ${base}`);
    });
    return oid;
  }

  /** Recusa o pedido de tag do funcionário (só você). A versão segue publicada; a tag fica para quando você a criar. */
  async declineTag(projectId: string, fromBrowser: boolean): Promise<ReleaseView | null> {
    if (!fromBrowser) throw new ReleaseError(403, 'só você, pelo Claudio’s Club, recusa o pedido de tag');
    await this.locked(projectId, async () => {
      const st = await this.state(projectId);
      if (!st?.tagRequest) return;
      await this.save(projectId, { ...st, tagRequest: null, log: [...st.log, this.entry('tag-declined', null, `pedido de ${st.tagRequest.by.name}`)] });
    });
    return this.view(projectId);
  }

  /** Cancela a versão aberta: a fila e as mesclas de fora voltam. Commit já feito fica (é local; para desfazer, descarte antes). O card de manual fica no quadro. */
  async cancel(projectId: string, fromBrowser: boolean): Promise<ReleaseView | null> {
    if (!fromBrowser) throw new ReleaseError(403, 'só você, pelo Claudio’s Club, cancela a versão');
    await this.locked(projectId, async () => {
      await this.dir(projectId);
      const had = await this.state(projectId);
      await this.save(projectId, null);
      if (had && !had.prepared) this.deps.onScopeLifted?.(projectId);
    });
    return this.view(projectId);
  }

  /** As versões fechadas (tags `vX.Y.Z`, mais nova primeiro) e o número sugerido para a próxima. Um processo git por pedido; a tela só pede ao abrir. */
  async history(projectId: string): Promise<ReleaseHistory | null> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return null;
    const raw = await this.deps.tools
      .git(dir, ['for-each-ref', 'refs/tags', '--sort=-creatordate', '--count=200', '--format=%(refname:short)%00%(creatordate:iso-strict)%00%(objectname)%00%(*objectname)%00%(contents:subject)%00%(contents:body)%1e'])
      .catch(() => '');
    const entries: ReleaseHistoryEntry[] = [];
    for (const rec of raw.split('\x1e')) {
      const [tag, date, obj, commit, subject, body] = rec.replace(/^\s+/, '').split('\0');
      if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) continue;
      const parsed = parseReleaseBody(body ?? '');
      entries.push({ tag, version: tag.slice(1), date: date ?? '', sha: (commit || obj || '').trim(), subject: (subject ?? '').trim(), summary: parsed.summary.slice(0, 2000), tasks: parsed.tasks });
      if (entries.length >= 60) break;
    }
    const pkg = await fs
      .readFile(path.join(dir, 'package.json'), 'utf8')
      .then((t) => (JSON.parse(t.replace(/^﻿/, '')) as { version?: string }).version ?? '', () => '');
    return { entries, suggested: nextVersion([...entries.map((e) => e.version), pkg]) };
  }

  /**
   * Os avisos da caixa (kind `routine`, informativos): o pedido de tag pendente (sai quando você aprova ou recusa) e as publicações e preparações dos últimos 7 dias que você não
   * dispensou. Custo fixo: tudo vem da memória depois da primeira leitura de cada projeto.
   */
  async inboxItems(projectIds: string[], projectName: (projectId: string) => string): Promise<InboxItem[]> {
    const out: InboxItem[] = [];
    const cut = this.now().getTime() - NOTICE_KEEP_MS;
    for (const projectId of projectIds) {
      const s = await this.load(projectId).catch(() => null);
      const st = s?.release;
      const place = { projectId, projectName: projectName(projectId), sessionId: '', staffId: null, name: 'Versão' };
      if (st?.tagRequest) {
        out.push({ id: `routine:release:${projectId}:request`, kind: 'routine', ...place, summary: `${st.tagRequest.by.name} pediu a tag v${st.version}: aprove ou recuse na página da versão (botão Versão do quadro)`, at: st.tagRequest.at });
      }
      for (const n of s?.notices ?? []) {
        if (Date.parse(n.at) > cut) out.push({ id: `routine:release:${projectId}:${Date.parse(n.at)}`, kind: 'routine', ...place, summary: n.text, at: n.at });
      }
    }
    return out;
  }

  /** Dispensa um aviso (`release:<projeto>:<ms>`). O pedido de tag não se dispensa (sai ao aprovar ou recusar): false. */
  async dismiss(id: string): Promise<boolean> {
    const m = /^release:([A-Za-z0-9-]+):(\d+)$/.exec(id);
    if (!m) return false;
    const [, projectId, ms] = m;
    const s = await this.load(projectId!);
    const kept = s.notices.filter((n) => String(Date.parse(n.at)) !== ms);
    if (kept.length === s.notices.length) return false;
    await this.persist(projectId!, { ...s, notices: kept });
    return true;
  }

  /**
   * A rotina (a cada minuto, uma por vez): em cada projeto com versão aberta e não preparada, põe o card de manual na fila quando as outras ficam prontas e prepara sozinha
   * quando todas ficam (uma vez: falhou, espera você). O arquivo de cada projeto é lido na primeira passada e depois vem da memória.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const projectId of await this.deps.projectIds().catch(() => [] as string[])) {
        const st = await this.state(projectId).catch(() => null);
        if (!st || st.prepared || st.prepareError || this.preparing.has(projectId)) continue;
        const dir = await this.deps.projectPath(projectId);
        if (!dir) continue;
        const tasks = await this.deps.readTasks(dir).catch(() => null);
        if (!tasks) continue;
        const docs = st.docsTaskId ? tasks.find((t) => t.id === st.docsTaskId) : undefined;
        if (docs && (docs.status === 'waiting' || docs.status === 'todo') && !docs.sessionId && !docs.queuedAt) {
          const others = releaseProgress(tasks, { taskIds: st.taskIds.filter((id) => id !== docs.id) });
          if (others.ready) await Promise.resolve(this.deps.startTask(projectId, docs.id)).catch((err) => this.log(`card de manual ${docs.id} não entrou na fila: ${firstLine(err)}`));
          continue;
        }
        if (!releaseProgress(tasks, st).ready) continue;
        // Por trás: as provas de um projeto não seguram a rodada dos outros.
        void this.startPrepare(projectId, false, true);
      }
    } finally {
      this.sweeping = false;
    }
  }
}

const isPending = (t: Task | undefined): boolean => !!t && t.status !== 'done' && t.status !== 'cancelled';
