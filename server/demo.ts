import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { StaffProfile, Task, TaskStatus } from '../shared/model';
import { BUILTIN_ROLES } from '../shared/roles';
import { encodeProjectDir } from './adapters/claude/paths';
import { MYCO_HOME } from './config';
import { ensureMycoGitignore } from './mycoGitignore';
import { saveProfile, staffDir, writeAtomic } from './staff/store';

// Projeto demo: uma API pequena de cafeteria (com um bug de propósito) e uma equipe pronta, para
// quem acabou de baixar o MyCo ver fichas, hierarquia e tarefas no quadro sem gastar nada. O app
// vem de demo/ no repositório; a cópia vai para ~/.myco/demo, fora do clone (o trabalho dos
// funcionários não suja o git do MyCo). Abrir um funcionário é o Claude Code de verdade: gasta a
// cota de quem usa. A equipe sai dos cargos prontos, então acompanha as revisões deles.

export const DEMO_DIR = path.join(MYCO_HOME, 'demo', 'cafe-demo');
const TEMPLATE_DIR = path.resolve(import.meta.dirname, '../demo/cafe-demo');

const exec = promisify(execFile);

interface Member {
  id: string;
  name: string;
  roleId: string;
  reportsTo: string[];
}

// Dois níveis: a orquestradora divide o trabalho; o front-end coordena quem cuida do visual.
const TEAM: Member[] = [
  { id: 'lia-demo', name: 'Lia', roleId: 'orquestrador', reportsTo: [] },
  { id: 'caio-demo', name: 'Caio', roleId: 'planejador', reportsTo: ['lia-demo'] },
  { id: 'bruno-demo', name: 'Bruno', roleId: 'desenvolvedor', reportsTo: ['lia-demo'] },
  { id: 'fernanda-demo', name: 'Fernanda', roleId: 'frontend', reportsTo: ['lia-demo'] },
  { id: 'duda-demo', name: 'Duda', roleId: 'design-system', reportsTo: ['fernanda-demo'] },
  { id: 'tais-demo', name: 'Taís', roleId: 'testador', reportsTo: ['lia-demo'] },
  { id: 'rui-demo', name: 'Rui', roleId: 'revisor', reportsTo: ['lia-demo'] },
];

// Repasses da orquestradora, como ela faria pela API: cada um com dono, pronto e o que não mexer.
const TASKS: Array<{ title: string; description: string; staffId: string; status: TaskStatus }> = [
  {
    title: 'Montar o cardápio e a rota do pedido',
    description: 'GET /api/cardapio e POST /api/pedidos em server.js, com validação dos itens.',
    staffId: 'bruno-demo',
    status: 'done',
  },
  {
    title: 'Corrigir o total do pedido',
    description:
      'calcularTotal (pedidos.js) soma o preço sem multiplicar pela quantidade.\nPronto quando: o total é a soma de preço × quantidade, com um teste que falhava antes.\nNão mexer: o cardápio e as rotas.',
    staffId: 'bruno-demo',
    status: 'todo',
  },
  {
    title: 'Testes da validação do pedido',
    description:
      'Cobrir validarItens (pedidos.js) com node --test: item fora do cardápio, quantidade 0, 51 e fracionada, pedido vazio.\nNão mexer: o código de produção.',
    staffId: 'tais-demo',
    status: 'todo',
  },
  {
    title: 'Montar o pedido na página',
    description:
      'Em public/index.html: escolher a quantidade de cada item, enviar para POST /api/pedidos e mostrar o total devolvido.\nPronto quando: funciona em 360px e no desktop.\nNão mexer: a API.',
    staffId: 'fernanda-demo',
    status: 'todo',
  },
  {
    title: 'Planejar cupons de desconto',
    description: 'Como aplicar um cupom no pedido (formato, validação, onde guardar). Só o plano, com até três alternativas.',
    staffId: 'caio-demo',
    status: 'todo',
  },
];

export interface DemoOptions {
  templateDir?: string;
  targetDir?: string;
  /** Inicia um repositório git com o app (o painel de código e a revisão usam o diff). */
  git?: boolean;
  now?: Date;
}

/** Cria o projeto demo, se ainda não existe (nunca sobrescreve). */
export async function createDemo(opts: DemoOptions = {}): Promise<{ created: boolean; projectId: string; path: string }> {
  const target = opts.targetDir ?? DEMO_DIR;
  const out = { projectId: encodeProjectDir(target), path: target };
  if (await exists(target)) return { created: false, ...out };

  // Monta numa pasta ao lado e só no fim põe no lugar: um erro no meio não deixa demo pela metade.
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.rm(tmp, { recursive: true, force: true });
  try {
    await fs.cp(opts.templateDir ?? TEMPLATE_DIR, tmp, { recursive: true, errorOnExist: true });
    await seedOffice(tmp, opts.now ?? new Date());
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    // Dois cliques juntos: o outro já pôs o demo no lugar.
    if (await exists(target)) return { created: false, ...out };
    throw err;
  }
  if (opts.git !== false) await initGit(target);
  return { created: true, ...out };
}

async function seedOffice(dir: string, now: Date): Promise<void> {
  await fs.mkdir(staffDir(dir), { recursive: true });
  await ensureMycoGitignore(dir);
  // Um segundo entre cada contratação: o quadro ordena pela data.
  const at = (i: number) => new Date(now.getTime() + i * 1000).toISOString();
  for (const [i, m] of TEAM.entries()) await saveProfile(dir, profileOf(m, at(i)));
  const tasks = TASKS.map((t, i): Task => {
    const created = at(TEAM.length + i);
    return {
      id: `t-demo${i + 1}`,
      title: t.title,
      description: t.description,
      status: t.status,
      staffId: t.staffId,
      requestedBy: 'lia-demo',
      sessionId: null,
      plan: null,
      branch: null,
      pr: null,
      createdAt: created,
      updatedAt: created,
      history: [
        { at: created, status: 'todo', by: 'auto', note: 'pedida por Lia' },
        ...(t.status === 'todo' ? [] : [{ at: created, status: t.status, by: 'you' as const }]),
      ],
    };
  });
  await writeAtomic(path.join(dir, '.myco', 'tasks.json'), JSON.stringify(tasks, null, 2) + '\n');
}

function profileOf(m: Member, at: string): StaffProfile {
  const role = BUILTIN_ROLES.find((r) => r.id === m.roleId);
  if (!role) throw new Error(`cargo pronto ${m.roleId} não existe`);
  return {
    id: m.id,
    projectId: '',
    name: m.name,
    role: role.role,
    portrait: null,
    reportsTo: m.reportsTo,
    mission: role.mission,
    firstTask: '',
    autonomy: role.autonomy,
    agents: [],
    skills: [],
    mcps: null,
    knowledge: ['README.md'],
    rules: role.rules,
    doneWhen: role.doneWhen,
    model: role.model || null,
    effort: role.effort,
    canHire: !!role.canHire,
    usageStop: null,
    playbook: role.playbook ?? null,
    worktree: false,
    // Nada de servidores nem do seu Chrome num projeto de exemplo.
    servers: [],
    browser: false,
    sessions: [],
    createdAt: at,
    updatedAt: at,
  };
}

/** Sem git (ou sem conseguir commitar), o demo funciona do mesmo jeito, só sem o diff. */
async function initGit(dir: string): Promise<void> {
  const git = (...args: string[]) => exec('git', ['-C', dir, ...args], { windowsHide: true, timeout: 15_000 });
  try {
    await git('init', '-q', '-b', 'main');
    await git('add', '-A');
    await git('-c', 'user.name=MyCo', '-c', 'user.email=myco@localhost', 'commit', '-q', '-m', 'Projeto demo do MyCo');
  } catch {
    // segue sem o repositório (ou sem o primeiro commit)
  }
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);
