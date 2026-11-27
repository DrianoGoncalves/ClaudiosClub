import { randomUUID } from 'node:crypto';
import fsSync, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Posse do projeto: só UM servidor do Claudio’s Club manda nos dados de um projeto (cards, equipe, fila, conversas). Uma segunda instância na mesma pasta
// (teste, print, outro MYCO_HOME) só lê: nada de recuperação de reinício, varredura, fila nem conversa nova. Foi o que faltou no incidente do t-963b58: a
// instância de teste não conhecia a conversa do funcionário (viva no servidor principal), achou o card órfão e o mandou para Aguardar.
//
// A trava mora com os dados que protege: `<projeto>/.myco/owner/<época>.json` (a pasta traz um .gitignore próprio; nada vai para o git). Cada posse é uma
// ÉPOCA nova, criada com `wx` (falha se já existe): quem cria a época N+1 é o único dono, e duas instâncias subindo juntas disputam o mesmo nome, então
// só uma ganha. O dono é a época mais alta. Sem leitura-e-troca de um arquivo só, não há como os dois acharem que ganharam.
//
// Quem pode tomar a posse (decidido sobre a época mais alta):
//   - nenhuma época (projeto sem dono): só a casa PADRÃO (`~/.myco`, a do servidor principal) registra, e só ela. Uma instância com outro MYCO_HOME (teste, print) só lê, mesmo
//     chegando antes do principal: se registrasse, viraria a dona dos projetos reais (e rodaria a fila neles) e, quando o principal subisse, ele é que ficaria só lendo (foreign-home).
//     Ficam de fora a pasta DENTRO do próprio MYCO_HOME (os dados da própria instância, como o demo) e a troca de propósito (`MYCO_ADOPT_PROJECTS=1`). O principal registra todo
//     projeto com dados do Club na subida (ver `claimKnownProjects`).
//   - o dono vivo (processo existe e o batimento é recente): ninguém, nem a mesma casa (duas instâncias subindo juntas: só uma fica);
//   - o dono morto ou saído: só a MESMA casa (MYCO_HOME) dele. O reinício normal pelo vigia (mesma casa, pid novo) retoma na hora. Uma casa diferente (instância de
//     teste) nunca toma, nem com o principal desligado: o dono fica registrado no arquivo. Para trocar de dono de propósito: `MYCO_ADOPT_PROJECTS=1` (com o dono
//     morto) ou apagar `.myco/owner`.
// "Vivo" = o pid existe NESTA máquina e o arquivo foi tocado há menos de `staleMs` (o dono toca a cada `beatMs`); o pid sozinho engana quando o número é reaproveitado.
// A identidade da instância é um UUID por processo (`instance`), não o pid.

export const OWNER_SUBDIR = path.join('.myco', 'owner');
const EPOCH_FILE = /^(\d{1,12})\.json$/;

export interface OwnerRecord {
  v: 1;
  epoch: number;
  /** MYCO_HOME canônico do dono: quem pode retomar quando ele morre. */
  home: string;
  /** UUID desta subida do servidor (o pid pode ser reaproveitado). */
  instance: string;
  pid: number;
  host: string;
  startedAt: string;
}

export type NotOwnerReason = 'not-open' | 'live-holder' | 'foreign-home' | 'unregistered' | 'error';

export interface OwnerHolder {
  home: string;
  pid: number;
  host: string;
  startedAt: string;
}

export type OwnerStatus = { owner: true } | { owner: false; reason: NotOwnerReason; holder?: OwnerHolder; error?: string };

/** Esta instância não tem a posse do projeto: ela só lê. Vira 423 na rota. */
export class NotOwnerError extends Error {
  readonly code = 'not-owner';
  constructor(
    readonly dir: string,
    readonly status: Extract<OwnerStatus, { owner: false }>,
  ) {
    super(notOwnerMessage(status));
  }
}

function notOwnerMessage(s: Extract<OwnerStatus, { owner: false }>): string {
  const base = 'Esta instância do Claudio’s Club só lê este projeto: não grava cards nem equipe, não roda a fila e não abre conversas.';
  if (s.reason === 'foreign-home') return `${base} O dono dele é o servidor com os dados em ${s.holder?.home ?? 'outra pasta'}${s.holder ? ` (pid ${s.holder.pid})` : ''}.`;
  if (s.reason === 'live-holder') return `${base} Outro servidor do mesmo usuário já está com ele${s.holder ? ` (pid ${s.holder.pid})` : ''}.`;
  if (s.reason === 'not-open') return `${base} O servidor ainda está subindo ou já está saindo.`;
  if (s.reason === 'unregistered') return `${base} O projeto ainda não tem dono, e só o Claudio’s Club com os dados na pasta padrão (~/.myco) registra um. Para esta instância registrar de propósito, suba com MYCO_ADOPT_PROJECTS=1.`;
  return `${base} Não consegui registrar a posse (${s.error ?? 'erro de disco'}).`;
}

export interface OwnershipOptions {
  /** MYCO_HOME desta instância: é a identidade do "dono registrado". */
  home: string;
  /** A casa do servidor principal (`~/.myco`): só ela registra projeto sem dono. Os testes trocam. */
  defaultHome?: string;
  instance?: string;
  pid?: number;
  host?: string;
  startedAt?: string;
  now?: () => number;
  /** O processo existe? Os testes trocam. */
  isAlive?: (pid: number) => boolean;
  /** Sem toque do dono há tanto tempo, ele não conta como vivo. */
  staleMs?: number;
  /** De quanto em quanto o dono toca o arquivo (e confere que segue sendo o dono). */
  beatMs?: number;
  /** Quanto tempo uma posse conferida vale sem reler o disco. */
  trustMs?: number;
  /** Quanto tempo um "não" vale sem reler o disco. */
  recheckMs?: number;
  /** Troca de dono de propósito: toma a posse de casa diferente, desde que o dono esteja morto (nunca de um vivo). */
  adopt?: boolean;
  log?: (line: string) => void;
}

const DEFAULTS = { staleMs: 30_000, beatMs: 5_000, trustMs: 15_000, recheckMs: 3_000 };
/** Arquivo recém-criado que ainda não tem conteúdo (quem criou está gravando): vale como "ocupado" por este tempo. */
const WRITING_MS = 3_000;
const ROOT_TTL_MS = 60_000;
const ATTEMPTS = 6;

interface Current {
  epoch: number;
  file: string;
  rec: OwnerRecord | null;
  mtimeMs: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function canonicalHome(home: string): string {
  try {
    return fsSync.realpathSync(home);
  } catch {
    return path.resolve(home);
  }
}
const sameHome = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function parseRecord(raw: string): OwnerRecord | null {
  try {
    const r = JSON.parse(raw) as Partial<OwnerRecord> | null;
    if (!r || typeof r.instance !== 'string' || typeof r.home !== 'string' || typeof r.pid !== 'number') return null;
    return { v: 1, epoch: Number(r.epoch) || 0, home: r.home, instance: r.instance, pid: r.pid, host: typeof r.host === 'string' ? r.host : '', startedAt: typeof r.startedAt === 'string' ? r.startedAt : '' };
  } catch {
    return null;
  }
}

export class ProjectOwnership {
  readonly instance: string;
  readonly home: string;
  private readonly defaultHome: string;
  private readonly pid: number;
  private readonly host: string;
  private readonly startedAt: string;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly staleMs: number;
  private readonly beatMs: number;
  private readonly trustMs: number;
  private readonly recheckMs: number;
  private readonly adopt: boolean;
  private readonly log: (line: string) => void;
  private opened = false;
  private timer: NodeJS.Timeout | null = null;
  /** dir dado → raiz canônica (realpath), para duas formas de chegar à mesma pasta cair na mesma trava. */
  private readonly roots = new Map<string, { root: string; at: number }>();
  private readonly owned = new Map<string, { epoch: number; file: string; verifiedAt: number }>();
  private readonly denied = new Map<string, { status: Extract<OwnerStatus, { owner: false }>; at: number }>();
  private readonly inflight = new Map<string, Promise<OwnerStatus>>();
  /** Raízes cujo "não" já foi para o log (um aviso por mudança, não um por pedido). */
  private readonly told = new Map<string, string>();

  constructor(opts: OwnershipOptions) {
    this.home = canonicalHome(opts.home);
    this.defaultHome = canonicalHome(opts.defaultHome ?? path.join(os.homedir(), '.myco'));
    this.instance = opts.instance ?? randomUUID();
    this.pid = opts.pid ?? process.pid;
    this.host = opts.host ?? os.hostname();
    this.startedAt = opts.startedAt ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
    this.now = opts.now ?? Date.now;
    this.alive = opts.isAlive ?? pidAlive;
    this.staleMs = opts.staleMs ?? DEFAULTS.staleMs;
    this.beatMs = opts.beatMs ?? DEFAULTS.beatMs;
    this.trustMs = opts.trustMs ?? DEFAULTS.trustMs;
    this.recheckMs = opts.recheckMs ?? DEFAULTS.recheckMs;
    this.adopt = opts.adopt ?? false;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /**
   * Só depois de ficar com a porta: antes disso nenhum projeto é tomado (um servidor que não conseguiu subir não registra nada), e o que chegar antes (o vigia
   * de sessões começa antes do listen) é recusado. Liga o batimento do dono.
   */
  open(): void {
    this.opened = true;
    if (!this.timer) {
      this.timer = setInterval(() => void this.beat().catch(() => {}), this.beatMs);
      this.timer.unref();
    }
  }

  /** Para o batimento e solta o que tinha, no estado de "saí" (o arquivo fica velho de propósito: quem retoma não espera o prazo). Pode ser chamado em `process.on('exit')`. */
  releaseSync(): void {
    this.opened = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const o of this.owned.values()) {
      try {
        fsSync.utimesSync(o.file, 0, 0);
      } catch {
        // sem o arquivo ou sem permissão: o pid morto já basta para quem retomar
      }
    }
    this.owned.clear();
  }

  async owns(dir: string): Promise<boolean> {
    return (await this.claim(dir)).owner;
  }

  /** Lança `NotOwnerError` se não é a dona. Pasta que não existe: não há o que proteger (quem grava a cria), vale como livre. */
  async assert(dir: string): Promise<void> {
    const s = await this.claim(dir);
    if (!s.owner) throw new NotOwnerError(dir, s);
  }

  /**
   * Toma a posse do projeto (ou confirma a que já tem). Cria `.myco/owner` na pasta: só para quem vai gravar ou agir ali. `waitMs`: com o dono vivo
   * sendo da MESMA casa (o servidor antigo ainda saindo, quando o novo sobe), espera até esse prazo em vez de desistir na hora.
   */
  async claim(dir: string, opts: { waitMs?: number } = {}): Promise<OwnerStatus> {
    if (!this.opened) return { owner: false, reason: 'not-open' };
    const root = await this.rootOf(dir);
    if (!root) return { owner: true };
    const deadline = this.now() + (opts.waitMs ?? 0);
    for (;;) {
      const t = this.now();
      const mine = this.owned.get(root);
      if (mine && t - mine.verifiedAt < this.trustMs) return { owner: true };
      const no = this.denied.get(root);
      const wait = opts.waitMs !== undefined;
      if (!wait && no && t - no.at < this.recheckMs) return no.status;
      const status = await this.verify(root);
      if (status.owner || !wait || status.reason !== 'live-holder' || this.now() >= deadline) return status;
      await sleep(Math.min(250, Math.max(10, deadline - this.now())));
    }
  }

  /**
   * Só olha, não toma nem cria nada: o projeto está registrado para OUTRA instância (dono vivo, ou de outra casa)? É a pergunta das varreduras que
   * não gravam no projeto, mas não devem agir sobre o que é de outro servidor.
   */
  async blockedByOther(dir: string): Promise<boolean> {
    const root = await this.rootOf(dir);
    if (!root) return false;
    const cur = await this.readCurrent(path.join(root, OWNER_SUBDIR)).catch(() => null);
    if (cur?.rec?.instance === this.instance) return false;
    // Sem dono registrado: é de quem puder registrar. A instância que não pode (teste) não age sobre ele.
    if (!cur || (!cur.rec && this.judge(cur) === null)) return !this.mayRegister(root);
    return this.judge(cur) !== null;
  }

  /** Esta instância pode registrar um projeto que ainda não tem dono? A casa padrão, uma pasta dentro da própria casa (dados dela) ou a troca de propósito. */
  private mayRegister(root: string): boolean {
    if (this.adopt || sameHome(this.home, this.defaultHome)) return true;
    const rel = path.relative(this.home, root);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  /** O batimento: toca o arquivo de cada posse e confere que ninguém tomou depois (se tomou, esta instância passa a só ler). */
  async beat(): Promise<void> {
    for (const root of [...this.owned.keys()]) await this.verify(root);
  }

  // ---- por dentro ----

  private async rootOf(dir: string): Promise<string | null> {
    const key = path.resolve(dir);
    const hit = this.roots.get(key);
    if (hit && this.now() - hit.at < ROOT_TTL_MS) return hit.root;
    try {
      const root = await fs.realpath(key);
      if (!(await fs.stat(root)).isDirectory()) return null;
      this.roots.set(key, { root, at: this.now() });
      return root;
    } catch {
      return null;
    }
  }

  /** Uma tentativa por raiz de cada vez (cinco pedidos juntos viram uma só ida ao disco). */
  private verify(root: string): Promise<OwnerStatus> {
    const running = this.inflight.get(root);
    if (running) return running;
    const p = this.attempt(root)
      .catch((err: unknown): OwnerStatus => ({ owner: false, reason: 'error', error: err instanceof Error ? err.message : String(err) }))
      .then((status) => {
        if (status.owner) this.denied.delete(root);
        // Erro de disco passageiro na conferência de quem já é o dono não tira a posse: ela vale até o prazo da última conferência (`trustMs`), e o próximo batimento tenta de novo.
        else if (status.reason === 'error' && this.owned.has(root)) this.note(root, `não consegui conferir a posse de ${root}: ${status.error ?? 'erro de disco'}`);
        else {
          const lost = this.owned.delete(root);
          this.denied.set(root, { status, at: this.now() });
          // "Sem dono e esta instância não registra" é o normal de uma instância de teste, e vale para todo projeto: o resumo da subida (`claimKnownProjects`) já diz.
          if (status.reason !== 'unregistered') this.note(root, `${lost ? 'perdi a posse de' : 'só leitura em'} ${root}: ${notOwnerMessage(status)}`);
        }
        return status;
      })
      .finally(() => this.inflight.delete(root));
    this.inflight.set(root, p);
    return p;
  }

  private async attempt(root: string): Promise<OwnerStatus> {
    const odir = path.join(root, OWNER_SUBDIR);
    for (let i = 0; i < ATTEMPTS; i++) {
      const cur = await this.readCurrent(odir);
      if (cur?.rec?.instance === this.instance) {
        // Já é a minha: toca o arquivo (é o batimento). Sumiu no meio (alguém apagou a pasta): relê e tenta de novo.
        const t = new Date(this.now());
        try {
          await fs.utimes(cur.file, t, t);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
        this.owned.set(root, { epoch: cur.epoch, file: cur.file, verifiedAt: this.now() });
        return { owner: true };
      }
      if (cur) {
        const no = this.judge(cur);
        if (no) return no;
      }
      // Sem dono provável (nenhuma época, ou o registro quebrado e velho): só quem pode registrar toma (ver o cabeçalho). Nada é criado na pasta.
      if (!cur?.rec && !this.mayRegister(root)) return { owner: false, reason: 'unregistered' };
      const epoch = (cur?.epoch ?? 0) + 1;
      const file = await this.create(odir, epoch);
      if (file) {
        this.owned.set(root, { epoch, file, verifiedAt: this.now() });
        this.note(root, `${root} agora é deste servidor (época ${epoch}${cur ? `, antes de pid ${cur.rec?.pid ?? '?'}` : ''})`);
        await this.sweepOld(odir, epoch);
        return { owner: true };
      }
      // Perdeu a corrida pela época: relê e vê quem ganhou.
    }
    return { owner: false, reason: 'live-holder' };
  }

  /** `null`: dá para tomar a posse. Senão, o porquê do "não". */
  private judge(cur: Current): Extract<OwnerStatus, { owner: false }> | null {
    const rec = cur.rec;
    const age = this.now() - cur.mtimeMs;
    // Sem conteúdo legível: quem criou ainda está gravando (ocupado) ou o arquivo ficou quebrado (sem dono que se possa provar: livre).
    if (!rec) return age < WRITING_MS ? { owner: false, reason: 'live-holder' } : null;
    const holder: OwnerHolder = { home: rec.home, pid: rec.pid, host: rec.host, startedAt: rec.startedAt };
    const fresh = age < this.staleMs;
    // Em outra máquina o pid não diz nada (a pasta sincronizada): só o batimento.
    const live = fresh && (rec.host !== this.host || this.alive(rec.pid));
    const mine = sameHome(rec.home, this.home);
    if (live) return { owner: false, reason: mine ? 'live-holder' : 'foreign-home', holder };
    // Dono morto ou saído: a casa dele retoma; outra casa nunca (a instância de teste não toma, nem com o principal desligado), salvo troca explícita.
    if (!mine && !this.adopt) return { owner: false, reason: 'foreign-home', holder };
    return null;
  }

  private async readCurrent(odir: string): Promise<Current | null> {
    let names: string[];
    try {
      names = await fs.readdir(odir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const top = names.reduce((best, n) => {
      const m = EPOCH_FILE.exec(n);
      return m && Number(m[1]) > best ? Number(m[1]) : best;
    }, 0);
    if (!top) return null;
    const file = path.join(odir, `${top}.json`);
    try {
      const [raw, st] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
      return { epoch: top, file, rec: parseRecord(raw), mtimeMs: st.mtimeMs };
    } catch (err) {
      // Apagada entre a lista e a leitura (a limpeza das velhas): sem a mais alta, volta ao que houver.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.readCurrent(odir);
      throw err;
    }
  }

  /** Cria a época com `wx`: só um ganha. Devolve o arquivo, ou null se já existia. */
  private async create(odir: string, epoch: number): Promise<string | null> {
    await fs.mkdir(odir, { recursive: true });
    // A pasta se ignora sozinha no git (o `*` pega até este arquivo): a trava nunca aparece em status nem entra em commit.
    await fs.writeFile(path.join(odir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
    const file = path.join(odir, `${epoch}.json`);
    let fh;
    try {
      fh = await fs.open(file, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
    const rec: OwnerRecord = { v: 1, epoch, home: this.home, instance: this.instance, pid: this.pid, host: this.host, startedAt: this.startedAt };
    try {
      await fh.writeFile(JSON.stringify(rec) + '\n', 'utf8');
    } finally {
      await fh.close();
    }
    return file;
  }

  /** As épocas antigas já não valem: saem (melhor esforço). */
  private async sweepOld(odir: string, keep: number): Promise<void> {
    try {
      for (const n of await fs.readdir(odir)) {
        const m = EPOCH_FILE.exec(n);
        if (m && Number(m[1]) < keep) await fs.rm(path.join(odir, n), { force: true });
      }
    } catch {
      // fica para a próxima posse
    }
  }

  /** Uma linha de log por mudança de situação de cada raiz (não uma por pedido). */
  private note(root: string, line: string): void {
    if (this.told.get(root) === line) return;
    this.told.set(root, line);
    this.log(`[posse] ${line}`);
  }
}

// ---- o gancho do processo: quem grava ou age pergunta aqui. Sem instalar, tudo vale (testes, scripts); o servidor instala na subida. ----

let active: ProjectOwnership | null = null;

export function installOwnership(o: ProjectOwnership | null): void {
  active = o;
}

/** A instância pode agir neste projeto? (Toma a posse se ninguém tem.) */
export async function ownsProject(dir: string): Promise<boolean> {
  return active ? active.owns(dir) : true;
}

/** Como `ownsProject`, mas lança `NotOwnerError`: a porta de toda gravação nos dados do projeto. */
export async function assertOwner(dir: string): Promise<void> {
  if (active) await active.assert(dir);
}

/** O projeto é de outro servidor? Só olha (não cria nada na pasta): para as varreduras que não gravam no projeto. */
export async function ownedByOther(dir: string): Promise<boolean> {
  return active ? active.blockedByOther(dir) : false;
}

/** Escrita pela rota de um projeto (`/api/projects/:id/...`, todo método que não é GET): o que não é do projeto (config, chaves, conversas por id) segue. */
const PROJECT_ROUTE = /^\/api\/projects\/([A-Za-z0-9-]+)\//;
/** POST que só consulta (lista e teste de conexão): a instância que só lê também pode usar. */
const READ_ONLY_POST = /^\/api\/projects\/[A-Za-z0-9-]+\/connections\/(list|[A-Za-z0-9][\w.-]{0,39}\/test)$/;

/**
 * A porta das rotas de escrita (todo método que não é GET, chamada antes de ler o corpo): num projeto que este servidor não possui, lança `NotOwnerError` (423). `dirOf`: a pasta do projeto pelo
 * id (projeto que não existe segue, e a rota responde do seu jeito).
 */
export async function assertProjectRoute(pathname: string, dirOf: (projectId: string) => Promise<string | null>): Promise<void> {
  const m = PROJECT_ROUTE.exec(pathname);
  if (!m || READ_ONLY_POST.test(pathname)) return;
  const dir = await dirOf(m[1]!);
  if (dir) await assertOwner(dir);
}

/**
 * Na subida, antes da recuperação de reinício e da fila: registra a posse dos projetos que já têm dados do Club (`hasData`: cards ou equipe). Registrado, o projeto tem dono
 * (esta casa): uma instância de teste, com outro MYCO_HOME, não o toma nem com este servidor desligado. Quem não pode registrar (casa que não é a padrão) não cria nada: o
 * projeto sem dono fica só para leitura. `waitMs` é o prazo para o servidor ANTIGO (mesma casa) largar a posse, quando o novo sobe com ele ainda saindo (um prazo só para todos).
 * Devolve os nomes dos projetos que ficaram com esta instância e dos que ficaram só para leitura.
 */
export async function claimKnownProjects(
  o: ProjectOwnership,
  projects: Array<{ path: string; name: string }>,
  hasData: (dir: string) => Promise<boolean>,
  waitMs = 0,
): Promise<{ mine: string[]; other: string[] }> {
  const deadline = Date.now() + waitMs;
  const mine: string[] = [];
  const other: string[] = [];
  for (const p of projects) {
    if (!(await hasData(p.path))) continue;
    const status = await o.claim(p.path, { waitMs: Math.max(0, deadline - Date.now()) });
    (status.owner ? mine : other).push(p.name);
  }
  return { mine, other };
}
