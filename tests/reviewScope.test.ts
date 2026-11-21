import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskService } from '../server/tasks';
import type { StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// O pedido de revisão traz o diff só dos arquivos da tarefa (t-e434c4, caso t-b80e90): no projeto compartilhado o `git diff HEAD` inteiro mistura
// as tarefas abertas, e o revisor reprovava uma por hunk da outra. O texto é um só para os dois motores do revisor.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-scope-'));
});
afterAll(() => removeTemp(root));

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });

/** Projeto git com a.ts, b.ts e c.ts commitados e as mudanças sem commit de duas tarefas: a.ts e b.ts alterados, n.ts novo. */
async function project(name: string, reviewerEngine: 'claude' | 'codex') {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const f of ['a.ts', 'b.ts', 'c.ts']) await fs.writeFile(path.join(dir, f), `export const ${f[0]} = 1;\n`);
  git(dir, 'add', 'a.ts', 'b.ts', 'c.ts');
  git(dir, 'commit', '-q', '-m', 'base');
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 2;\n');
  await fs.writeFile(path.join(dir, 'b.ts'), 'export const b = 2;\n');
  await fs.writeFile(path.join(dir, 'n.ts'), 'export const n = 1;\n');

  const people: Record<string, StaffProfile> = {
    'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false, engine: reviewerEngine } as StaffProfile,
  };
  const sent: string[] = [];
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, _staff, text) => {
      sent.push(text);
      return `s-${sent.length}`;
    },
    sendTo: async (_p, session) => session,
    branchFor: async () => null,
    isWorking: () => false,
    isSessionWorking: () => false,
    lastText: () => null,
    notify: async () => {},
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    apiUrl: 'http://127.0.0.1:4848',
  });
  const file = path.join(dir, '.myco', 'tasks.json');
  /** Cria a tarefa e grava os campos que a detecção de edição (`noteTaskEdit`) e o quadro gravariam. */
  const task = async (title: string, patch: Record<string, unknown> = {}) => {
    const t = (await svc.create('p', { title, description: `Pedido de ${title}`, staffId: 'ana-1' }))!;
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    Object.assign(all.find((x) => x.id === t.id)!, patch);
    await fs.writeFile(file, JSON.stringify(all));
    return t.id;
  };
  const review = async (id: string) => {
    await svc.requestReview('p', id, 'rev-1');
    return sent.at(-1)!;
  };
  return { dir, svc, task, review, sent };
}

describe.each(['claude', 'codex'] as const)('pedido de revisão, revisor no %s', (engine) => {
  it('o diff é só dos arquivos da tarefa: o que é de outra tarefa não entra no comando nem na lista', async () => {
    const p = await project(`so-dela-${engine}`, engine);
    const id = await p.task('Tela A', { changedFiles: ['a.ts'] });
    const text = await p.review(id);
    expect(text).toContain('veja só as desta tarefa, com `git diff HEAD -- "a.ts"`');
    expect(text).toContain('Arquivos que esta conversa alterou (confira só eles): a.ts');
    expect(text).not.toMatch(/git diff HEAD`/); // nada do diff inteiro
    expect(text).not.toContain('b.ts');
    expect(text).not.toContain('n.ts');
    expect(text).not.toContain('arquivo compartilhado');
  });

  it('arquivo que outra tarefa aberta também alterou é marcado; encerrada (pronta ou cancelada) não conta', async () => {
    const p = await project(`compartilhado-${engine}`, engine);
    const mine = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'] });
    const other = await p.task('Tela B', { changedFiles: ['b.ts'], status: 'review' });
    const done = await p.task('Tela C', { changedFiles: ['a.ts'], status: 'done' });
    const cancelled = await p.task('Tela D', { changedFiles: ['a.ts'], status: 'cancelled' });
    const text = await p.review(mine);
    expect(text).toContain(`- \`b.ts\`: arquivo compartilhado com ${other}; hunks de outras tarefas não contam para o veredito`);
    expect(text).not.toContain(done);
    expect(text).not.toContain(cancelled);
    expect(text).not.toMatch(/`a\.ts`: arquivo compartilhado/);
    expect(text).toContain('git diff HEAD -- "a.ts" "b.ts"'); // o diff dos dois segue pedido: a marca é que separa o que conta
  });

  it('sem changedFiles: segue o diff inteiro e o pedido diz isso', async () => {
    const p = await project(`vazia-${engine}`, engine);
    const id = await p.task('Edição por shell');
    const text = await p.review(id);
    expect(text).toMatch(/veja com `git diff HEAD`\./);
    expect(text).toContain('Esta tarefa não tem lista de arquivos (edição só por shell não é detectada): o diff é o do projeto inteiro e pode trazer mudanças de outras tarefas.');
    expect(text).toContain('Arquivos: ');
    expect(text).not.toContain('confira só eles');
  });

  it('a instrução do revisor: avalia só o que é da tarefa e hunk alheio é, no máximo, observação', async () => {
    const p = await project(`instrucao-${engine}`, engine);
    const text = await p.review(await p.task('Tela A', { changedFiles: ['a.ts'] }));
    expect(text).toContain('Avalie só o que é desta tarefa');
    expect(text).toContain('não reprova: cite no máximo como observação 🟢, fora do veredito');
    // O que já valia segue valendo.
    expect(text).toContain('APROVADO ou REPROVADO na primeira linha');
    expect(text).toContain('REPROVADO só se houver algum 🔴');
    // E vale também sem a lista de arquivos.
    const loose = await p.review(await p.task('Sem lista'));
    expect(loose).toContain('Avalie só o que é desta tarefa');
  });

  it('arquivo novo sem rastreio e arquivo já commitado: o pedido avisa, para não parecer que nada mudou', async () => {
    const p = await project(`avisos-${engine}`, engine);
    const text = await p.review(await p.task('Tela A', { changedFiles: ['a.ts', 'n.ts', 'c.ts'] }));
    expect(text).toContain('Arquivos novos, sem rastreio (o diff não os mostra, leia o arquivo): n.ts');
    expect(text).toContain('Sem diferença contra o HEAD (já commitados ou desfeitos): c.ts.');
  });

  it('nome de arquivo que quebraria a linha de comando fica fora dela, com aviso', async () => {
    const p = await project(`nome-${engine}`, engine);
    const text = await p.review(await p.task('Tela A', { changedFiles: ['a.ts', 'estranho"; rm -rf.ts', 'quebra\nlinha.ts'] }));
    expect(text).toContain('git diff HEAD -- "a.ts"`');
    expect(text).not.toContain('rm -rf');
    expect(text).not.toContain('quebra');
    expect(text).toContain('Arquivos com nome fora do comum ficaram fora da lista');
  });

  it('lista longa: o comando leva os 60 primeiros e o pedido diz quantos ficaram de fora', async () => {
    const p = await project(`longa-${engine}`, engine);
    const many = Array.from({ length: 62 }, (_, i) => `src/f${i}.ts`);
    const text = await p.review(await p.task('Tela grande', { changedFiles: many }));
    expect(text).toContain('"src/f59.ts"');
    expect(text).not.toContain('"src/f60.ts"');
    expect(text).toContain('… (+2;');
  });
});

describe('paridade entre motores', () => {
  it('o mesmo texto de pedido para o revisor Claude e para o Codex', async () => {
    const texts: string[] = [];
    for (const engine of ['claude', 'codex'] as const) {
      const p = await project(`paridade-${engine}`, engine);
      const mine = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'] });
      await p.task('Tela B', { changedFiles: ['b.ts'], status: 'doing' });
      // Os ids são sorteados: o texto é o mesmo fora deles.
      texts.push((await p.review(mine)).replace(/t-[0-9a-f]{6}/g, 't-xxxxxx'));
    }
    expect(texts[0]).toBe(texts[1]);
  });
});
