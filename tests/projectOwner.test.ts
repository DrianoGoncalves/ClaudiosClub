import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertOwner, claimKnownProjects, installOwnership, NotOwnerError, ownedByOther, ownsProject, OWNER_SUBDIR, ProjectOwnership, type OwnershipOptions } from '../server/projectOwner';

// Posse do projeto (t-f50944): só um servidor manda nos dados de cada projeto. Aqui o núcleo (a trava em disco); os pontos que a usam (fila, recuperação de reinício, varreduras,
// conversas, rotas) estão em projectOwnerGates.test.ts.

let root: string;
let n = 0;
const made: ProjectOwnership[] = [];

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-owner-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
afterEach(() => {
  installOwnership(null);
  for (const o of made.splice(0)) o.releaseSync(); // para o batimento (e deixa o arquivo "velho", como no fim do processo)
});

/** Processos vivos desta máquina de mentira: `isAlive` consulta este conjunto. */
const alive = new Set<number>();
let pids = 1000;
const isAlive = (pid: number) => alive.has(pid);
const pidOf = new WeakMap<ProjectOwnership, number>();

/** Uma instância do Club: casa (MYCO_HOME) e pid próprios, já aberta (porta na mão). A casa PADRÃO destes testes é `main` (o `~/.myco` do servidor principal). */
function club(home: string, extra: Partial<OwnershipOptions> = {}, open = true): ProjectOwnership {
  const pid = extra.pid ?? ++pids;
  alive.add(pid);
  const o = new ProjectOwnership({ home: path.join(root, 'homes', home), defaultHome: path.join(root, 'homes', 'main'), pid, isAlive, log: () => {}, ...extra });
  if (open) o.open();
  made.push(o);
  pidOf.set(o, pid);
  return o;
}
/** O processo saiu sem avisar (kill -9, queda): só o pid some, o arquivo fica como estava. */
const die = (o: ProjectOwnership) => void alive.delete(pidOf.get(o)!);
const project = async () => {
  const dir = path.join(root, `proj-${n++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};
const epochs = async (dir: string) => (await fs.readdir(path.join(dir, OWNER_SUBDIR))).filter((f) => /^\d+\.json$/.test(f)).sort();
const record = async (dir: string) => {
  const files = await epochs(dir);
  return JSON.parse(await fs.readFile(path.join(dir, OWNER_SUBDIR, files.at(-1)!), 'utf8')) as Record<string, unknown>;
};

describe('a posse: tomar, e quem pode', () => {
  it('o primeiro a pedir fica com o projeto, e o registro diz quem é (casa, pid e identidade além do pid)', async () => {
    const dir = await project();
    const a = club('main');
    expect(await a.claim(dir)).toEqual({ owner: true });
    expect(await epochs(dir)).toEqual(['1.json']);
    expect(await record(dir)).toMatchObject({ v: 1, epoch: 1, home: a.home, instance: a.instance, pid: expect.any(Number), host: os.hostname() });
    // a pasta se ignora no git sozinha: a trava nunca vira arquivo novo no status do projeto
    expect(await fs.readFile(path.join(dir, OWNER_SUBDIR, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('antes de ter a porta (não aberta), nada é tomado e nada é criado na pasta', async () => {
    const dir = await project();
    const a = club('main', {}, false);
    expect(await a.claim(dir)).toEqual({ owner: false, reason: 'not-open' });
    await expect(a.assert(dir)).rejects.toBeInstanceOf(NotOwnerError);
    await expect(fs.stat(path.join(dir, '.myco'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('pasta que não existe: nada a proteger (quem grava a cria) e nada é criado', async () => {
    const a = club('main');
    const ghost = path.join(root, 'nao-existe');
    expect(await a.claim(ghost)).toEqual({ owner: true });
    await expect(fs.stat(ghost)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('pelo link simbólico cai na mesma trava (raiz canônica): o outro não entra por outro caminho', async () => {
    const dir = await project();
    const link = path.join(root, `link-${n++}`);
    await fs.symlink(dir, link);
    const a = club('main');
    const b = club('main');
    expect((await a.claim(dir)).owner).toBe(true);
    expect(await b.claim(link)).toMatchObject({ owner: false, reason: 'live-holder' });
  });

  it('o dono continua dono (confirma sem criar época nova)', async () => {
    const dir = await project();
    const a = club('main');
    await a.claim(dir);
    await a.beat();
    expect(await a.claim(dir)).toEqual({ owner: true });
    expect(await epochs(dir)).toEqual(['1.json']);
  });
});

describe('item 3: duas instâncias subindo juntas, só uma fica com a posse', () => {
  it('mesma casa, ao mesmo tempo, em 25 projetos: exatamente um dono em cada', async () => {
    for (let i = 0; i < 25; i++) {
      const dir = await project();
      const a = club('main');
      const b = club('main');
      const [x, y] = await Promise.all([a.claim(dir), b.claim(dir)]);
      expect([x.owner, y.owner].filter(Boolean)).toHaveLength(1);
      expect(await epochs(dir)).toHaveLength(1);
    }
  });

  it('casa padrão e casa de teste ao mesmo tempo, em projeto sem dono: sempre a padrão fica, a de teste nunca', async () => {
    for (let i = 0; i < 25; i++) {
      const dir = await project();
      const a = club('main');
      const t = club('teste');
      const [x, y] = await Promise.all([a.claim(dir), t.claim(dir)]);
      expect(x).toEqual({ owner: true });
      expect(y.owner).toBe(false);
      expect(await epochs(dir)).toEqual(['1.json']);
      expect(await record(dir)).toMatchObject({ home: a.home });
    }
  });

  it('três instâncias juntas, com o dono morto no meio: uma só toma a época seguinte', async () => {
    for (let i = 0; i < 10; i++) {
      const dir = await project();
      const old = club('main');
      await old.claim(dir);
      die(old);
      const [a, b, c] = [club('main'), club('main'), club('main')];
      const got = await Promise.all([a.claim(dir), b.claim(dir), c.claim(dir)]);
      expect(got.filter((g) => g.owner)).toHaveLength(1);
      expect(await epochs(dir)).toEqual(['2.json']); // a época antiga saiu, uma só nova ficou
    }
  });

  it('duas instâncias no mesmo processo (mesmo pid): a identidade é o UUID, não o pid', async () => {
    const dir = await project();
    const a = club('main', { pid: 4242 });
    const b = club('main', { pid: 4242 });
    expect(a.instance).not.toBe(b.instance);
    await a.claim(dir);
    expect(await b.claim(dir)).toMatchObject({ owner: false, reason: 'live-holder' });
    expect(await a.claim(dir)).toEqual({ owner: true });
  });
});

describe('item 4: casa diferente do dono registrado não toma, nem com o principal desligado', () => {
  it('o principal registrou e caiu (pid morto): a instância de teste fica só lendo, e nada muda no registro', async () => {
    const dir = await project();
    const main = club('main');
    await main.claim(dir);
    const before = await fs.readFile(path.join(dir, OWNER_SUBDIR, '1.json'), 'utf8');
    die(main);
    const teste = club('teste'); // MYCO_HOME=/tmp/myco-leo do incidente
    expect(await teste.claim(dir)).toMatchObject({ owner: false, reason: 'foreign-home', holder: { home: main.home } });
    await expect(teste.assert(dir)).rejects.toThrow(/só lê este projeto/);
    expect(await epochs(dir)).toEqual(['1.json']);
    expect(await fs.readFile(path.join(dir, OWNER_SUBDIR, '1.json'), 'utf8')).toBe(before);
  });

  it('o principal saiu direito (soltou a posse): a de teste também não toma', async () => {
    const dir = await project();
    const main = club('main');
    await main.claim(dir);
    main.releaseSync(); // saída limpa: o arquivo fica velho, mas o dono registrado continua sendo a casa dele
    const teste = club('teste');
    expect(await teste.claim(dir)).toMatchObject({ owner: false, reason: 'foreign-home' });
  });

  it('o principal vivo: a de teste lê o dono, e o principal segue dono', async () => {
    const dir = await project();
    const main = club('main');
    await main.claim(dir);
    const teste = club('teste');
    expect(await teste.claim(dir)).toMatchObject({ owner: false, reason: 'foreign-home' });
    expect(await main.claim(dir)).toEqual({ owner: true });
  });

  it('só uma troca de propósito (MYCO_ADOPT_PROJECTS) toma de casa diferente, e só com o dono morto', async () => {
    const dir = await project();
    const main = club('main');
    await main.claim(dir);
    const adopter = club('novo', { adopt: true, recheckMs: 0 }); // sem lembrar o "não" de antes: o dono morreu agora
    expect(await adopter.claim(dir)).toMatchObject({ owner: false, reason: 'foreign-home' }); // dono vivo: nunca
    die(main);
    expect(await adopter.claim(dir)).toEqual({ owner: true });
    expect(await epochs(dir)).toEqual(['2.json']);
  });

  it('a instância de teste não registra projeto novo por cima de um registrado em outra pasta de dados (o mesmo vale para o que o principal vê depois)', async () => {
    const dir = await project();
    const main = club('main');
    await main.claim(dir);
    const teste = club('teste');
    for (let i = 0; i < 3; i++) await teste.claim(dir); // insistir não muda nada
    expect(await epochs(dir)).toEqual(['1.json']);
    die(main);
    const main2 = club('main'); // o principal volta (pid novo)
    expect(await main2.claim(dir)).toEqual({ owner: true });
  });
});

describe('item 2: o reinício normal (mesma casa, pid novo) retoma a posse na hora', () => {
  it('o dono caiu (pid morto): o servidor novo da mesma casa toma já, sem esperar o prazo do batimento', async () => {
    const dir = await project();
    const velho = club('main');
    await velho.claim(dir);
    die(velho);
    const novo = club('main');
    const t0 = Date.now();
    expect(await novo.claim(dir)).toEqual({ owner: true });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(await epochs(dir)).toEqual(['2.json']);
    expect(await record(dir)).toMatchObject({ epoch: 2, instance: novo.instance });
  });

  it('saiu direito (soltou a posse) com o pid ainda vivo por um instante: o novo toma na hora', async () => {
    const dir = await project();
    const velho = club('main');
    await velho.claim(dir);
    velho.releaseSync();
    const novo = club('main');
    expect(await novo.claim(dir)).toEqual({ owner: true });
  });

  it('o servidor antigo ainda saindo quando o novo sobe: o novo espera (até o prazo) e toma quando ele solta', async () => {
    const dir = await project();
    const velho = club('main');
    await velho.claim(dir);
    const novo = club('main');
    setTimeout(() => velho.releaseSync(), 120);
    const t0 = Date.now();
    expect(await novo.claim(dir, { waitMs: 3_000 })).toEqual({ owner: true });
    expect(Date.now() - t0).toBeLessThan(2_000);
    // sem prazo, o mesmo pedido desistiria na hora (dono vivo)
    const outro = await project();
    const v2 = club('main');
    await v2.claim(outro);
    expect(await club('main').claim(outro)).toMatchObject({ owner: false, reason: 'live-holder' });
  });

  it('o antigo que ficou para trás perde a posse no batimento seguinte e passa a só ler', async () => {
    const dir = await project();
    const velho = club('main');
    await velho.claim(dir);
    die(velho); // "morreu" para o novo, mas o objeto segue de pé (processo congelado que volta)
    const novo = club('main');
    await novo.claim(dir);
    await velho.beat();
    expect(await velho.claim(dir)).toMatchObject({ owner: false });
    expect(await novo.claim(dir)).toEqual({ owner: true });
  });

  it('batimento velho com o pid vivo (número reaproveitado por outro programa): a mesma casa toma', async () => {
    const dir = await project();
    let clock = Date.now();
    const velho = club('main', { now: () => clock });
    await velho.claim(dir);
    clock += 60_000; // um minuto sem tocar o arquivo; o pid, esse, "existe" (outro programa com o mesmo número)
    const novo = club('main', { now: () => clock });
    expect(await novo.claim(dir)).toEqual({ owner: true });
  });

  it('o batimento do dono mantém o arquivo "fresco": o outro não toma enquanto ele bate', async () => {
    const dir = await project();
    let clock = Date.now();
    const dono = club('main', { now: () => clock });
    await dono.claim(dir);
    for (let i = 0; i < 4; i++) {
      clock += 20_000; // 80 s no total: bem além do prazo de 30 s, mas com batimento a cada 20 s
      await dono.beat();
    }
    const outro = club('main', { now: () => clock });
    expect(await outro.claim(dir)).toMatchObject({ owner: false, reason: 'live-holder' });
  });

  it('dono de outra máquina (pasta sincronizada): o pid não vale, só o batimento', async () => {
    const dir = await project();
    const lá = club('main', { host: 'outro-pc', pid: 77 });
    await lá.claim(dir);
    alive.delete(77); // este pid não existe AQUI, e isso não diz nada sobre o outro computador
    expect(await club('main').claim(dir)).toMatchObject({ owner: false, reason: 'live-holder' });
    const depois = club('main', { now: () => Date.now() + 120_000 });
    expect(await depois.claim(dir)).toEqual({ owner: true });
  });

  it('registro quebrado: recém-criado vale como ocupado (quem criou está gravando); velho não segura ninguém', async () => {
    const dir = await project();
    await fs.mkdir(path.join(dir, OWNER_SUBDIR), { recursive: true });
    await fs.writeFile(path.join(dir, OWNER_SUBDIR, '1.json'), '');
    const a = club('main');
    expect(await a.claim(dir)).toMatchObject({ owner: false });
    const later = club('main', { now: () => Date.now() + 60_000 });
    expect(await later.claim(dir)).toEqual({ owner: true });
    expect(await epochs(dir)).toEqual(['2.json']);
  });
});

describe('só olhar (blockedByOther) e o gancho do processo', () => {
  it('olhar não cria nada: projeto sem registro é de quem pode registrar (a casa padrão), e a de teste o trata como de outro; o de outro servidor vivo, ou de outra casa, está bloqueado; o meu, não', async () => {
    const livre = await project();
    const teste = club('teste');
    expect(await teste.blockedByOther(livre)).toBe(true);
    expect(await club('main').blockedByOther(livre)).toBe(false);
    await expect(fs.stat(path.join(livre, '.myco'))).rejects.toMatchObject({ code: 'ENOENT' });

    const dir = await project();
    const main = club('main');
    await main.claim(dir);
    expect(await teste.blockedByOther(dir)).toBe(true);
    expect(await main.blockedByOther(dir)).toBe(false);
    die(main);
    expect(await teste.blockedByOther(dir)).toBe(true); // morto, mas de outra casa
    expect(await club('main').blockedByOther(dir)).toBe(false); // a casa dele retoma
  });

  it('sem instalar nada (testes, scripts), tudo vale; instalada, as portas valem', async () => {
    const dir = await project();
    await assertOwner(dir);
    expect(await ownsProject(dir)).toBe(true);
    expect(await ownedByOther(dir)).toBe(false);

    const main = club('main');
    await main.claim(dir);
    const teste = club('teste');
    installOwnership(teste);
    expect(await ownsProject(dir)).toBe(false);
    await expect(assertOwner(dir)).rejects.toMatchObject({ code: 'not-owner' });
    expect(await ownedByOther(dir)).toBe(true);
    installOwnership(main);
    expect(await ownsProject(dir)).toBe(true);
  });

  it('um "não" é lembrado por pouco tempo (sem ir ao disco a cada pedido) e é revisto depois', async () => {
    const dir = await project();
    let clock = Date.now();
    const main = club('main', { now: () => clock });
    await main.claim(dir);
    const outro = club('main', { now: () => clock, recheckMs: 3_000 });
    expect((await outro.claim(dir)).owner).toBe(false);
    die(main);
    expect((await outro.claim(dir)).owner).toBe(false); // ainda dentro dos 3 s: nem relê
    clock += 3_500;
    expect((await outro.claim(dir)).owner).toBe(true); // reviu: o dono morreu, a casa é a mesma
  });
});

describe('R1: só a casa padrão registra projeto sem dono (a instância de teste que chega primeiro não trava o principal)', () => {
  it('casa diferente da padrão reivindica projeto sem registro: não é dona e nada é criado em .myco/owner', async () => {
    const dir = await project();
    const teste = club('teste');
    expect(await teste.claim(dir)).toMatchObject({ owner: false, reason: 'unregistered' });
    await expect(teste.assert(dir)).rejects.toThrow(/ainda não tem dono.*MYCO_ADOPT_PROJECTS=1/s);
    expect(await teste.blockedByOther(dir)).toBe(true);
    await expect(fs.stat(path.join(dir, '.myco'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(dir, OWNER_SUBDIR))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ordem teste → principal: o teste sobe antes e tenta várias vezes; o principal registra depois, vira dono na época 1 e segue dono (sem foreign-home)', async () => {
    const dir = await project();
    const teste = club('teste');
    for (let i = 0; i < 3; i++) expect((await teste.claim(dir)).owner).toBe(false);
    const main = club('main');
    expect(await main.claim(dir)).toEqual({ owner: true });
    expect(await epochs(dir)).toEqual(['1.json']);
    expect(await record(dir)).toMatchObject({ home: main.home, instance: main.instance });
    // o principal cai e volta (reinício): mesma casa, retoma
    die(main);
    expect(await club('main').claim(dir)).toEqual({ owner: true });
  });

  it('claimKnownProjects de uma instância de teste não cria época: só lê, e diz quais ficaram sem ela', async () => {
    const withTasks = await project();
    await fs.mkdir(path.join(withTasks, '.myco'), { recursive: true });
    await fs.writeFile(path.join(withTasks, '.myco', 'tasks.json'), '[]');
    const withStaff = await project();
    await fs.mkdir(path.join(withStaff, '.myco', 'staff'), { recursive: true });
    await fs.writeFile(path.join(withStaff, '.myco', 'staff', 'ana-1.json'), '{}');
    const plain = await project(); // projeto qualquer do Claude Code, sem dados do Club
    const projects = [
      { path: withTasks, name: 'com-tarefas' },
      { path: withStaff, name: 'com-equipe' },
      { path: plain, name: 'simples' },
    ];
    const hasData = (dir: string) => fs.stat(path.join(dir, '.myco')).then(() => true, () => false);

    const teste = club('teste', { recheckMs: 0 }); // sem lembrar o "sem dono" de antes: o principal registrou entre uma conferência e outra
    expect(await claimKnownProjects(teste, projects, hasData)).toEqual({ mine: [], other: ['com-tarefas', 'com-equipe'] });
    for (const d of [withTasks, withStaff, plain]) await expect(fs.stat(path.join(d, OWNER_SUBDIR))).rejects.toMatchObject({ code: 'ENOENT' });

    // controle: o principal registra os dois com dados (e não toca no simples)
    const main = club('main');
    expect(await claimKnownProjects(main, projects, hasData)).toEqual({ mine: ['com-tarefas', 'com-equipe'], other: [] });
    for (const d of [withTasks, withStaff]) expect(await epochs(d)).toEqual(['1.json']);
    await expect(fs.stat(path.join(plain, '.myco'))).rejects.toMatchObject({ code: 'ENOENT' });
    // e agora a de teste lê o dono (foreign-home), como antes
    expect(await teste.claim(withTasks)).toMatchObject({ owner: false, reason: 'foreign-home' });
  });

  it('as exceções: a pasta dentro da própria casa (o demo) e a troca de propósito registram; as duas só valem para quem as tem', async () => {
    const teste = club('teste');
    const inside = path.join(teste.home, 'demo', 'cafe');
    await fs.mkdir(inside, { recursive: true });
    expect(await teste.claim(inside)).toEqual({ owner: true });
    expect(await teste.blockedByOther(inside)).toBe(false);
    // a casa vizinha, de nome parecido, não conta como "dentro"
    const sibling = path.join(`${teste.home}-vizinha`, 'p');
    await fs.mkdir(sibling, { recursive: true });
    expect(await teste.claim(sibling)).toMatchObject({ owner: false, reason: 'unregistered' });

    const dir = await project();
    const adopter = club('novo', { adopt: true });
    expect(await adopter.claim(dir)).toEqual({ owner: true });
    expect(await record(dir)).toMatchObject({ home: adopter.home });
  });

  it('registro quebrado e velho (sem dono provável) também só é tomado por quem pode registrar', async () => {
    const dir = await project();
    await fs.mkdir(path.join(dir, OWNER_SUBDIR), { recursive: true });
    await fs.writeFile(path.join(dir, OWNER_SUBDIR, '1.json'), '');
    const later = () => Date.now() + 60_000;
    expect(await club('teste', { now: later }).claim(dir)).toMatchObject({ owner: false, reason: 'unregistered' });
    expect(await epochs(dir)).toEqual(['1.json']);
    expect(await club('main', { now: later }).claim(dir)).toEqual({ owner: true });
  });
});
