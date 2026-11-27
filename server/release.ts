import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Task, TestRun } from '../shared/model';
import {
  compareVersions,
  expandScope,
  hasTasksBlock,
  nextVersion,
  parseReleaseBody,
  parseVersion,
  releaseBody,
  releaseProgress,
  RELEASE_MAX_TASKS,
  tasksFromSubjects,
  type ReleaseHistory,
  type ReleaseHistoryEntry,
  type ReleaseState,
  type ReleaseView,
} from '../shared/release';
import { writeAtomic } from './atomicWrite';
import { assertOwner } from './projectOwner';
import type { GitRun } from './autoCommit';
import { assertSafeConfig, githubRepoOf, validBranchName, withNetworkRetry } from './staff/gitSafe';

// Versão com escopo (substitui, na tela, a pausa de versão com prazo). O dono escolhe as tarefas pendentes que entram (as bloqueadoras abertas vêm junto). Enquanto a
// versão está aberta, só as tarefas dela saem da fila e só elas mesclam (`scope`, que o TaskService pergunta em `takeNextFrom`, `start` e `merge`); as de fora esperam.
// Quando todas ficam prontas, a rotina (`sweep`) prepara sozinha: testes do projeto, número novo no package.json e no lock e o commit local "Versão X". Daí a fila volta.
// Publicar (push do commit para `release/<versão>` e o PR) e criar a tag (depois da mescla do PR) são botões do dono: a tag é o que atualiza as instalações (selfUpdate).
//
// Estado em `<projeto>/.myco/release.json` (pasta fora do git): lido uma vez e guardado na memória; só este serviço grava. O progresso é derivado das tarefas
// (`readTasks`, guardado por versão do arquivo), nunca gravado. O histórico vem das tags anotadas: um `git for-each-ref` quando a tela pede, nunca em polling.

export class ReleaseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const RELEASE_FILE = path.join('.myco', 'release.json');
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,9}$/;
const ID = z.string().regex(/^t-[0-9a-z]{4,20}$/);
const VERSION = z.string().trim().refine((v) => !!parseVersion(v), 'versão no formato X.Y.Z (ex.: 1.5.2)');

const StateSchema = z.object({
  version: VERSION,
  taskIds: z.array(ID).max(RELEASE_MAX_TASKS + 1),
  docsTaskId: ID.nullable().default(null),
  openedAt: z.string().datetime(),
  prepared: z.object({ at: z.string(), sha: z.string().regex(/^[0-9a-f]{7,64}$/), branch: z.string().max(200) }).nullable().default(null),
  prepareError: z.object({ at: z.string(), message: z.string().max(2000), testsOutput: z.string().max(8000).optional() }).nullable().default(null),
  published: z.object({ at: z.string(), branch: z.string().max(200), pr: z.string().regex(PR_URL) }).nullable().default(null),
});

const OpenBody = z.object({
  version: VERSION,
  taskIds: z.array(ID).min(1, 'marque ao menos uma tarefa').max(RELEASE_MAX_TASKS),
  /** Card de manual e doc: com quem fica (null = não criar). */
  docsStaffId: z.string().regex(/^[a-z0-9-]{1,40}$/).nullable().default(null),
});
const ScopeBody = z.object({ add: z.array(ID).max(RELEASE_MAX_TASKS).default([]), remove: z.array(ID).max(RELEASE_MAX_TASKS).default([]) });
const PrepareBody = z.object({ skipTests: z.boolean().default(false) });

export interface ReleaseDeps {
  projectPath: (projectId: string) => Promise<string | null>;
  projectIds: () => Promise<string[]>;
  readTasks: (dir: string) => Promise<Task[]>;
  /** Cria o card de manual e doc em Aguardar (`start: false`). */
  createTask: (projectId: string, body: { title: string; description: string; staffId: string; start: false }) => Promise<{ id: string } | null>;
  /** Põe o card de manual na fila quando as outras ficam prontas. */
  startTask: (projectId: string, taskId: string) => Promise<unknown>;
  /** Os testes do projeto (fila pesada); null = o projeto não tem testes. */
  runTests: (dir: string) => Promise<TestRun | null>;
  /** O git e o gh sem hooks e com ambiente controlado (ver gitSafe.ts). */
  tools: { git: GitRun; gh: (args: string[], input?: string) => Promise<string> };
  /**
   * Este servidor manda no projeto (ver server/projectOwner.ts)? A rodada automática (`sweep`) não põe card na fila nem prepara a versão de projeto que é de outro servidor.
   * Sem a opção, vale (testes).
   */
  owns?: (projectId: string) => Promise<boolean>;
  /** O escopo saiu da frente (preparada ou cancelada): a fila do projeto anda já, sem esperar a rodada. */
  onScopeLifted?: (projectId: string) => void;
  log?: (line: string) => void;
  now?: () => Date;
}

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new ReleaseError(400, r.error.issues[0]?.message ?? 'dados inválidos');
  return r.data;
};
const firstLine = (err: unknown) => ((err as Error)?.message ?? String(err)).split(/\r?\n/).find((l) => l.trim())?.replace(/^(fatal|error): /, '').slice(0, 300) ?? 'falhou';

export class ReleaseService {
  /** O estado de cada projeto já lido (null = sem versão aberta). Só este serviço grava o arquivo. */
  private states = new Map<string, ReleaseState | null>();
  private locks = new Map<string, Promise<unknown>>();
  private preparing = new Set<string>();
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

  /** A versão aberta do projeto (null = nenhuma). Arquivo ausente ou estragado = nenhuma (o estragado vai para `.bad`, com log). */
  async state(projectId: string): Promise<ReleaseState | null> {
    if (this.states.has(projectId)) return this.states.get(projectId)!;
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return null;
    const file = path.join(dir, RELEASE_FILE);
    let found: ReleaseState | null = null;
    const raw = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw !== null) {
      const r = (() => {
        try {
          return StateSchema.safeParse(JSON.parse(raw.replace(/^\uFEFF/, '')));
        } catch {
          return null;
        }
      })();
      if (r?.success) found = r.data;
      else {
        await fs.rename(file, `${file}.bad`).catch(() => {});
        this.log(`${file} estragado; guardado em ${file}.bad: nenhuma versão aberta`);
      }
    }
    this.states.set(projectId, found);
    return found;
  }

  private async save(projectId: string, next: ReleaseState | null): Promise<void> {
    const dir = await this.dir(projectId);
    await assertOwner(dir); // o estado da versão é dado do projeto: só o servidor que manda nele grava
    const file = path.join(dir, RELEASE_FILE);
    if (next) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeAtomic(file, JSON.stringify(next, null, 2) + '\n');
    } else await fs.rm(file, { force: true });
    this.states.set(projectId, next);
  }

  /** O que a fila e a mescla perguntam: o escopo enquanto a versão está aberta e ainda não preparada; null = sem trava. */
  async scope(projectId: string): Promise<{ version: string; ids: ReadonlySet<string> } | null> {
    const st = await this.state(projectId);
    return st && !st.prepared ? { version: st.version, ids: new Set(st.taskIds) } : null;
  }

  /** O estado e o progresso (custo fixo: o arquivo vem da memória, as tarefas do `readTasks` guardado). Null = projeto não existe. */
  async view(projectId: string): Promise<ReleaseView | null> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return null;
    const st = await this.state(projectId);
    if (!st) return { release: null, tasks: [], done: 0, total: 0, ready: false, preparing: false };
    return { release: st, ...releaseProgress(await this.deps.readTasks(dir), st), preparing: this.preparing.has(projectId) };
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
      const bad = input.taskIds.filter((id) => !byId.has(id) || byId.get(id)!.status === 'done' || byId.get(id)!.status === 'cancelled');
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
        docsTaskId,
        openedAt: this.now().toISOString(),
        prepared: null,
        prepareError: null,
        published: null,
      };
      await this.save(projectId, st);
      return this.view(projectId);
    });
  }

  /** Põe ou tira tarefas do escopo (só antes de preparar). Pôr puxa as bloqueadoras; tirar uma de que outra do escopo depende é recusado. */
  async changeScope(projectId: string, body: unknown, fromBrowser: boolean): Promise<ReleaseView | null> {
    if (!fromBrowser) throw new ReleaseError(403, 'só você, pelo Claudio’s Club, muda a versão');
    const input = parse(ScopeBody, body);
    return this.locked(projectId, async () => {
      const dir = await this.dir(projectId);
      const st = await this.state(projectId);
      if (!st) throw new ReleaseError(409, 'não há versão aberta');
      if (st.prepared) throw new ReleaseError(409, 'a versão já foi preparada: o escopo não muda mais');
      const tasks = await this.deps.readTasks(dir);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const bad = input.add.filter((id) => !byId.has(id) || byId.get(id)!.status === 'done' || byId.get(id)!.status === 'cancelled');
      if (bad.length) throw new ReleaseError(409, `só entram tarefas pendentes: ${bad.join(', ')} não está pendente`);
      const remove = new Set(input.remove);
      const kept = st.taskIds.filter((id) => !remove.has(id));
      for (const id of remove) {
        const needs = kept.filter((k) => byId.get(k)?.status !== 'done' && (byId.get(k)?.blockedBy ?? []).includes(id));
        if (needs.length) throw new ReleaseError(409, `${needs.join(', ')} depende de ${id}: tire a dependente junto`);
      }
      const ids = [...new Set([...kept, ...expandScope(tasks, input.add)])];
      if (ids.length > RELEASE_MAX_TASKS + 1) throw new ReleaseError(409, `a versão teria ${ids.length} tarefas (máx. ${RELEASE_MAX_TASKS})`);
      const docsTaskId = st.docsTaskId && ids.includes(st.docsTaskId) ? st.docsTaskId : null;
      // Escopo mexido: a falha antiga de preparação já não vale (a automática tenta de novo).
      await this.save(projectId, { ...st, taskIds: ids, docsTaskId, prepareError: null });
      return this.view(projectId);
    });
  }

  /**
   * Prepara já (o botão; a automática é a `sweep`): testes, número novo e o commit local, por trás (a suíte leva minutos): a resposta volta na hora com `preparing`, e a
   * tela acompanha pela leitura. A falha fica em `prepareError`. `skipTests` = preparar sem os testes (o dono decidiu). Faltando tarefa: 409 na hora.
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
      void this.startPrepare(projectId, skipTests);
    }
    return this.view(projectId);
  }

  /** A preparação em curso de cada projeto (a rotina não abre outra por cima; os testes esperam por `settled`). */
  private running = new Map<string, Promise<void>>();

  /** Roda a preparação por trás, uma por projeto. Falha prevista já foi gravada por `doPrepare`; a imprevista (disco, git) é gravada aqui. */
  private startPrepare(projectId: string, skipTests: boolean): Promise<void> {
    const current = this.running.get(projectId);
    if (current) return current;
    this.preparing.add(projectId);
    const run = this.locked(projectId, () => this.doPrepare(projectId, skipTests))
      .catch(async (err: unknown) => {
        this.log(`versão de ${projectId} não preparou: ${firstLine(err)}`);
        if (err instanceof ReleaseError) return;
        const cur = await this.state(projectId).catch(() => null);
        if (cur && !cur.prepared) await this.save(projectId, { ...cur, prepareError: { at: this.now().toISOString(), message: `a preparação falhou: ${firstLine(err)}` } }).catch(() => {});
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

  private async doPrepare(projectId: string, skipTests: boolean): Promise<void> {
    const dir = await this.dir(projectId);
    const st = await this.state(projectId);
    if (!st) throw new ReleaseError(409, 'não há versão aberta');
    if (st.prepared) return;
    const progress = releaseProgress(await this.deps.readTasks(dir), st);
    if (!progress.ready) throw new ReleaseError(409, `faltam ${progress.total - progress.done} de ${progress.total} tarefas ficarem prontas`);
    const git = this.deps.tools.git;
    const fail = async (message: string, testsOutput?: string): Promise<never> => {
      await this.save(projectId, { ...st, prepareError: { at: this.now().toISOString(), message, ...(testsOutput && { testsOutput: testsOutput.slice(-8000) }) } });
      throw new ReleaseError(409, message);
    };
    {
      const files = ['package.json', 'package-lock.json'];
      const present = (await Promise.all(files.map((f) => fs.access(path.join(dir, f)).then(() => f, () => null)))).filter((f): f is string => !!f);
      if (present.length) {
        const dirty = (await git(dir, ['status', '--porcelain', '--', ...present]).catch((err) => fail(`não deu para ler o git: ${firstLine(err)}`))).trim();
        if (dirty) await fail(`${present.join(' e ')} tem mudança sem commit: commite ou desfaça antes de preparar a versão`);
      }
      if (!skipTests) {
        const tests = await this.deps.runTests(dir).catch((err) => fail(`os testes não rodaram: ${firstLine(err)}`));
        if (tests && !tests.ok) await fail(tests.timedOut ? 'os testes passaram do tempo-limite: tente de novo com a máquina mais livre' : 'os testes falharam: nada foi commitado', tests.output);
      }
      const v = st.version;
      for (const f of present) {
        const file = path.join(dir, f);
        const raw = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
        const json = JSON.parse(raw) as { version?: string; packages?: Record<string, { version?: string }> };
        json.version = v;
        if (f === 'package-lock.json' && json.packages?.['']) json.packages[''].version = v;
        await writeAtomic(file, JSON.stringify(json, null, 2) + '\n');
      }
      const tasks = await this.deps.readTasks(dir);
      const titled = st.taskIds.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => !!t && t.status === 'done');
      // `--only` (com `--allow-empty`): o commit leva só estes arquivos, nunca o que outra conversa deixou no índice.
      await git(dir, ['commit', '--only', '--allow-empty', '-m', `Versão ${v}`, '-m', releaseBody('', titled), '--', ...present]).catch((err) => fail(`o commit da versão falhou: ${firstLine(err)}`));
      const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')).trim();
      await this.save(projectId, { ...st, prepared: { at: this.now().toISOString(), sha, branch }, prepareError: null });
      this.deps.onScopeLifted?.(projectId);
    }
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
    return { repo: `github.com/${gh.owner}/${gh.repo}`, base: head.replace(/^origin\//, '') || 'main' };
  }

  /** Push do commit da versão para `release/<versão>` (nunca force) e o PR para a branch padrão. Repetir depois de falhar no PR refaz só o que falta. */
  async publish(projectId: string, fromBrowser: boolean): Promise<ReleaseView | null> {
    if (!fromBrowser) throw new ReleaseError(403, 'só você, pelo Claudio’s Club, publica a versão');
    await this.locked(projectId, async () => {
      const dir = await this.dir(projectId);
      const st = await this.state(projectId);
      if (!st?.prepared) throw new ReleaseError(409, 'prepare a versão antes de publicar');
      if (st.published) return;
      const { repo, base } = await this.remote(dir);
      const branch = `release/${st.version}`;
      if (!validBranchName(branch) || branch === base) throw new ReleaseError(409, `nome de branch inválido: ${branch}`);
      const git = this.deps.tools.git;
      try {
        await withNetworkRetry(() => git(dir, ['push', '--no-verify', '--no-recurse-submodules', '--no-follow-tags', 'origin', `${st.prepared!.sha}:refs/heads/${branch}`], { timeoutMs: 120_000 }));
      } catch (err) {
        const why = firstLine(err);
        throw new ReleaseError(409, /non-fast-forward|fetch first|rejected/i.test(why) ? `o GitHub já tem ${branch} com outros commits (sem force): ${why}` : `o push falhou: ${why}`);
      }
      const tasks = await this.deps.readTasks(dir);
      const titled = st.taskIds.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => !!t && t.status === 'done');
      let out: string;
      try {
        out = await withNetworkRetry(() =>
          this.deps.tools.gh(['pr', 'create', '-R', repo, `--head=${branch}`, `--base=${base}`, `--title=Versão ${st.version}`, '--body-file=-'], releaseBody(`Versão ${st.version}`, titled)),
        );
      } catch (err) {
        throw new ReleaseError(409, `o push foi feito, mas o PR não abriu: ${firstLine(err)}`);
      }
      const pr = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
      // O link vai para a tela (href) e volta ao gh como argumento: só o formato de PR do GitHub passa.
      if (!PR_URL.test(pr)) throw new ReleaseError(409, `o push foi feito, mas o gh não devolveu o link do PR: ${pr.slice(0, 200)}`);
      await this.save(projectId, { ...st, published: { at: this.now().toISOString(), branch, pr } });
    });
    return this.view(projectId);
  }

  /** Depois da mescla do PR: a tag anotada `vX` no commit da mescla, com o resumo e as tarefas, e o push dela. É ela que atualiza as instalações. A versão fecha. */
  async tag(projectId: string, fromBrowser: boolean): Promise<ReleaseView | null> {
    if (!fromBrowser) throw new ReleaseError(403, 'só você, pelo Claudio’s Club, cria a tag da versão');
    await this.locked(projectId, async () => {
      const dir = await this.dir(projectId);
      const st = await this.state(projectId);
      if (!st?.published) throw new ReleaseError(409, 'publique a versão (PR) antes de criar a tag');
      const { repo, base } = await this.remote(dir);
      const git = this.deps.tools.git;
      let pr: { state?: string; mergeCommit?: { oid?: string } | null };
      try {
        pr = JSON.parse(await withNetworkRetry(() => this.deps.tools.gh(['pr', 'view', st.published!.pr, '-R', repo, '--json', 'state,mergeCommit'])));
      } catch (err) {
        throw new ReleaseError(409, `não consegui ler o PR: ${firstLine(err)}`);
      }
      const oid = pr.mergeCommit?.oid ?? '';
      if (pr.state !== 'MERGED' || !/^[0-9a-f]{40}$/.test(oid)) throw new ReleaseError(409, 'o PR ainda não foi mesclado no GitHub');
      await withNetworkRetry(() => git(dir, ['fetch', '--no-tags', 'origin', base], { timeoutMs: 120_000 })).catch((err) => {
        throw new ReleaseError(409, `não consegui buscar ${base}: ${firstLine(err)}`);
      });
      await git(dir, ['cat-file', '-e', `${oid}^{commit}`]).catch(() => {
        throw new ReleaseError(409, `o commit da mescla (${oid.slice(0, 7)}) não veio com ${base}`);
      });
      const tag = `v${st.version}`;
      const existing = (await git(dir, ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]).catch(() => '')).trim();
      if (existing && existing !== oid) throw new ReleaseError(409, `a tag ${tag} já existe em outro commit`);
      if (!existing) {
        const tasks = await this.deps.readTasks(dir);
        const titled = st.taskIds.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => !!t && t.status === 'done');
        await git(dir, ['tag', '-a', tag, oid, '-F', '-'], { input: `Versão ${st.version}\n\n${releaseBody(`PR: ${st.published.pr}`, titled)}\n` });
      }
      try {
        await withNetworkRetry(() => git(dir, ['push', '--no-verify', 'origin', `refs/tags/${tag}`], { timeoutMs: 120_000 }));
      } catch (err) {
        throw new ReleaseError(409, `a tag foi criada aqui, mas o push dela falhou (tente de novo): ${firstLine(err)}`);
      }
      await this.save(projectId, null);
    });
    return this.view(projectId);
  }

  /** Cancela a versão aberta: a fila e as mesclas de fora voltam. Commit já feito fica (é local; desfazer é com você). O card de manual fica no quadro. */
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

  /**
   * As versões fechadas (tags `vX.Y.Z`, mais nova primeiro) e o número sugerido para a próxima. A tela só pede ao abrir. Um `for-each-ref` e, só se alguma
   * tag mostrada não tem o bloco "Tarefas:" (tag criada à mão), mais um `git log` para todas juntas (nunca um por tag).
   */
  async history(projectId: string): Promise<ReleaseHistory | null> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return null;
    const raw = await this.deps.tools
      .git(dir, ['for-each-ref', 'refs/tags', '--sort=-creatordate', '--count=200', '--format=%(refname:short)%00%(creatordate:iso-strict)%00%(objectname)%00%(*objectname)%00%(contents:subject)%00%(contents:body)%1e'])
      .catch(() => '');
    const entries: ReleaseHistoryEntry[] = [];
    const bare = new Set<string>(); // as tags sem o bloco "Tarefas:"
    const tips = new Map<string, string>(); // versão → commit, de todas as tags lidas (a tag anterior pode estar além das mostradas)
    for (const rec of raw.split('\x1e')) {
      const [tag, date, obj, commit, subject, body] = rec.replace(/^\s+/, '').split('\0');
      if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) continue;
      const sha = (commit || obj || '').trim();
      tips.set(tag.slice(1), sha);
      if (entries.length >= 60) continue;
      const parsed = parseReleaseBody(body ?? '');
      if (!hasTasksBlock(body ?? '')) bare.add(tag);
      entries.push({ tag, version: tag.slice(1), date: date ?? '', sha, subject: (subject ?? '').trim(), summary: parsed.summary.slice(0, 2000), tasks: parsed.tasks });
    }
    await this.fillFromCommits(dir, entries, bare, tips);
    const pkg = await fs
      .readFile(path.join(dir, 'package.json'), 'utf8')
      .then((t) => (JSON.parse(t.replace(/^\uFEFF/, '')) as { version?: string }).version ?? '', () => '');
    return { entries, suggested: nextVersion([...entries.map((e) => e.version), pkg]) };
  }

  /**
   * Tag sem o bloco "Tarefas:" (criada à mão): os cards vêm dos títulos "(t-xxxxxx)" dos commits entre a tag anterior (na ordem de versão) e ela; título do
   * quadro quando o card existe. Um só `git log` para todas as tags (os commits de cada uma saem do grafo, na memória). A 1ª tag não tem anterior: fica como está.
   * Falha do git ou do quadro não derruba o histórico: a tag só fica sem a lista.
   */
  private async fillFromCommits(dir: string, entries: ReleaseHistoryEntry[], bare: Set<string>, tips: Map<string, string>): Promise<void> {
    const sorted = [...tips.keys()].sort(compareVersions);
    const jobs = entries.flatMap((e) => {
      const prev = sorted[sorted.indexOf(e.version) - 1];
      const to = tips.get(e.version);
      const from = prev ? tips.get(prev) : undefined;
      return bare.has(e.tag) && to && from && to !== from ? [{ entry: e, to, from, prev: prev! }] : [];
    });
    if (!jobs.length) return;
    const floor = jobs.reduce((lo, j) => (compareVersions(j.prev, lo.prev) < 0 ? j : lo)).from; // a tag anterior mais velha: o git não anda além dela
    const log = await this.deps.tools
      .git(dir, ['log', '--topo-order', '--max-count=20000', '--format=%H%x00%P%x00%s', ...new Set(jobs.flatMap((j) => [j.to, j.from])), '--not', floor, '--'], { timeoutMs: 30_000 })
      .catch(() => '');
    const graph = new Map<string, { parents: string[]; subject: string; at: number }>();
    for (const line of log.split('\n')) {
      const [sha, parents, ...subject] = line.split('\0');
      if (sha && /^[0-9a-f]{40,64}$/.test(sha)) graph.set(sha, { parents: (parents ?? '').split(' ').filter(Boolean), subject: subject.join('\0'), at: graph.size });
    }
    if (!graph.size) return;
    const reach = new Map<string, Set<string>>();
    const reachOf = (tip: string, skip?: Set<string>): Set<string> => {
      const seen = new Set<string>();
      const stack = [tip];
      while (stack.length) {
        const sha = stack.pop()!;
        const c = graph.get(sha);
        if (!c || seen.has(sha) || skip?.has(sha)) continue;
        seen.add(sha);
        stack.push(...c.parents);
      }
      return seen;
    };
    const found = jobs.map((j) => {
      if (!reach.has(j.from)) reach.set(j.from, reachOf(j.from));
      const own = [...reachOf(j.to, reach.get(j.from))].sort((a, b) => graph.get(b)!.at - graph.get(a)!.at); // do mais antigo ao mais novo
      return { entry: j.entry, subjects: own.map((sha) => graph.get(sha)!.subject) };
    });
    if (!found.some((f) => tasksFromSubjects(f.subjects).length)) return;
    const board = new Map((await this.deps.readTasks(dir).catch(() => [] as Task[])).map((t) => [t.id, t.title]));
    for (const f of found) f.entry.tasks = tasksFromSubjects(f.subjects, (id) => board.get(id));
  }

  /**
   * A rotina (a cada minuto, uma por vez): em cada projeto com versão aberta e não preparada, põe o card de manual na fila quando as outras ficam prontas e prepara sozinha
   * quando todas ficam (uma vez: falhou, espera o dono). O arquivo de cada projeto é lido na primeira passada e depois vem da memória.
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
        // Versão aberta de projeto que é de outro servidor: quem a põe na fila e a prepara é o dono.
        if (this.deps.owns && !(await this.deps.owns(projectId).catch(() => false))) continue;
        const tasks = await this.deps.readTasks(dir).catch(() => null);
        if (!tasks) continue;
        const docs = st.docsTaskId ? tasks.find((t) => t.id === st.docsTaskId) : undefined;
        if (docs && (docs.status === 'waiting' || docs.status === 'todo') && !docs.sessionId && !docs.queuedAt) {
          const others = releaseProgress(tasks, { taskIds: st.taskIds.filter((id) => id !== docs.id) });
          if (others.ready) await Promise.resolve(this.deps.startTask(projectId, docs.id)).catch((err) => this.log(`card de manual ${docs.id} não entrou na fila: ${firstLine(err)}`));
          continue;
        }
        if (!releaseProgress(tasks, st).ready) continue;
        // Por trás: a suíte de um projeto não segura a rodada dos outros.
        void this.startPrepare(projectId, false);
      }
    } finally {
      this.sweeping = false;
    }
  }
}
