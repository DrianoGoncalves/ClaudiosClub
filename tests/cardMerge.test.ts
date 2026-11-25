import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FlowPolicies } from '../server/flowPolicy';
import { readBaseline } from '../server/proofBaseline';
import { TaskService, readTasks } from '../server/tasks';
import type { StaffProfile, Task } from '../shared/model';
import { removeTemp } from './support/tmp';

// t-250de1 (etapa 2): a junção do card em worktree própria, com git e `npm test` de verdade (só as conversas são falsas). Dois cards no mesmo arquivo, o conflito que volta ao responsável, o principal
// sujo que espera e junta sozinho, o que o dono deixou sujo fora do card, só os commits do card, a aprovação do revisor e os testes vermelhos no worktree do card.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 60_000 });
delete process.env.MYCO_CARD_WORKTREE_DEFAULT; // padrão de produção: ligado (a bateria dos outros assuntos o desliga, ver tests/support/cardOff.ts)

let root: string;
const homeBefore = process.env.MYCO_HOME;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-cardmerge-'));
  process.env.MYCO_HOME = path.join(root, 'myco-home'); // `npm test` entra na fila de validação pesada: uma só deste arquivo
});
afterAll(async () => {
  if (homeBefore === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = homeBefore;
  await removeTemp(root);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
const person = (id: string, name: string) => ({ id, name, role: 'Dev', autonomy: 'acceptEdits', worktree: false, servers: [] }) as unknown as StaffProfile;
const until = async (fn: () => Promise<unknown>, ms = 240_000) => {
  for (let i = 0; i * 50 < ms; i++) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error('a condição não chegou a tempo');
};

/** O arquivo de 10 linhas em que os cards mexem: l1 … l10. */
const LINES = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);
const body = (edits: Record<number, string> = {}) => `${LINES.map((l, i) => edits[i + 1] ?? l).join('\n')}\n`;

async function proj(name: string, opts: { policy?: 'auto'; vitest?: boolean } = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const test = "node -e \"process.exit(require('fs').readFileSync('ok.txt','utf8').trim()==='sim'?0:1)\"";
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test } }));
  await fs.writeFile(path.join(dir, 'ok.txt'), 'sim');
  if (opts.vitest) {
    // Projeto com vitest: o `vitest` do projeto (versionado, para a worktree do card tê-lo) passa sem fazer nada; o teste lê o comando que a junção rodou em `Task.tests`.
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^5.1.0' } }));
    await fs.mkdir(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', '.bin', 'vitest'), '#!/usr/bin/env node\n');
    await fs.writeFile(path.join(dir, 'node_modules', '.bin', 'vitest.cmd'), '@node "%~dp0vitest" %*\r\n');
    await fs.writeFile(path.join(dir, 'src.ts'), 'export const x = 1;\n');
  }
  await fs.writeFile(path.join(dir, 'app.txt'), body());
  await fs.writeFile(path.join(dir, '.gitignore'), '.claude/\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Teste');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'início');

  const people: Record<string, StaffProfile> = { 'ana-1': person('ana-1', 'Ana'), 'bia-1': person('bia-1', 'Bia'), 'rev-1': person('rev-1', 'Rui') };
  const policies = new FlowPolicies(path.join(root, `${name}-flow.json`), () => {});
  const texts = new Map<string, string>();
  const adjusts: Array<{ staffId: string; text: string }> = [];
  let n = 0;
  const mk = () =>
    new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async () => `s-${++n}`,
      sendTo: async (_p, session, staffId, text) => {
        adjusts.push({ staffId, text });
        return session;
      },
      branchFor: async (_d, p) => `myco/${p.id}`,
      lastText: (session) => texts.get(session) ?? null,
      notify: async () => {},
      flow: policies,
    });
  const svc = mk();
  if (opts.policy === 'auto') await svc.setFlowPolicy('p', { mode: 'auto' }, true);
  const get = async (id: string) => (await readTasks(dir)).find((t) => t.id === id)!;
  /** O card começa (a worktree nasce do HEAD do principal de agora). */
  const start = async (staffId: string, title: string) => {
    const t = (await svc.create('p', { title, staffId, reviewerId: 'rev-1' }))!;
    await svc.start('p', t.id);
    return get(t.id);
  };
  /** O funcionário escreve `files` na worktree do card (gravação direta, como um script: nada passa por `changedFiles`) e entrega: o checkpoint commita, e o card vai a Revisão. */
  const deliver = async (card: Task, files: Record<string, string>, since?: Task) => {
    await sleep(1100); // a prova de "sem código" compara o mtime com a hora do início
    for (const [f, text] of Object.entries(files)) await fs.writeFile(path.join(card.codeAt!.path!, f), text);
    const had = since?.checkpoint?.sha;
    await svc.onTurnDone((await get(card.id)).sessionId!);
    await until(async () => {
      const c = await get(card.id);
      return c.status === 'review' && c.checkpoint?.sha && c.checkpoint.sha !== had;
    });
    return get(card.id);
  };
  const sweep = async (at: Date, service: TaskService = svc) => {
    (service as unknown as { mergeSoon(p: string, now: Date): void }).mergeSoon('p', at);
    await service.mergesSettled();
  };
  const notes = (t: Task) => t.history.map((h) => h.note ?? '');
  return { dir, svc, mk, texts, adjusts, get, start, deliver, sweep, notes };
}

const mainClean = (dir: string) => git(dir, 'status', '--porcelain', '--', '.', ':(exclude).myco');

describe('dois cards em paralelo', () => {
  it('o mesmo arquivo em trechos diferentes: os dois juntam sem conflito, um commit de merge por card', async () => {
    const p = await proj('paralelo');
    const a = await p.start('ana-1', 'A');
    const b = await p.start('bia-1', 'B');
    const ra = await p.deliver(a, { 'app.txt': body({ 1: 'do A' }) });
    const rb = await p.deliver(b, { 'app.txt': body({ 10: 'do B' }) });

    expect((await p.svc.update('p', ra.id, { status: 'done' }, true))?.status).toBe('done');
    expect((await p.svc.update('p', rb.id, { status: 'done' }, true))?.status).toBe('done');

    expect(await fs.readFile(path.join(p.dir, 'app.txt'), 'utf8')).toBe(body({ 1: 'do A', 10: 'do B' }));
    expect(git(p.dir, 'rev-list', '--first-parent', '--merges', '--count', 'HEAD')).toBe('2');
    expect(mainClean(p.dir)).toBe('');
    const done = await p.get(rb.id);
    expect(done.merged).toMatchObject({ branch: rb.codeAt!.branch, base: 'main' });
    await until(async () => !existsSync(ra.codeAt!.path!) && !existsSync(rb.codeAt!.path!));
    expect(git(p.dir, 'branch', '--list', 'myco-card/*')).toBe('');
  });

  it('o mesmo trecho: o segundo volta ao responsável com os arquivos, o principal não é tocado e o conflito fica no worktree dele para resolver', async () => {
    const p = await proj('conflito');
    const a = await p.start('ana-1', 'A');
    const b = await p.start('bia-1', 'B');
    const ra = await p.deliver(a, { 'app.txt': body({ 5: 'versão do A' }) });
    const rb = await p.deliver(b, { 'app.txt': body({ 5: 'versão do B' }) });
    await p.svc.update('p', ra.id, { status: 'done' }, true);
    const head = git(p.dir, 'rev-parse', 'HEAD');

    const out = await p.svc.update('p', rb.id, { status: 'done' }, true);
    expect(out?.status).toBe('doing'); // voltou ao responsável
    expect(git(p.dir, 'rev-parse', 'HEAD')).toBe(head); // nada entrou no principal
    expect(await fs.readFile(path.join(p.dir, 'app.txt'), 'utf8')).toBe(body({ 5: 'versão do A' }));
    expect(mainClean(p.dir)).toBe('');
    const sent = p.adjusts.at(-1)!;
    expect(sent.staffId).toBe('bia-1');
    expect(sent.text).toContain('`app.txt`');
    expect(sent.text).toContain('worktree');
    expect(p.notes(await p.get(rb.id)).some((x) => x.includes('conflito com o principal em app.txt') && x.includes('devolvida ao responsável'))).toBe(true);
    // O conflito está no worktree do card (marcadores), à espera de quem resolve.
    const marked = await fs.readFile(path.join(rb.codeAt!.path!, 'app.txt'), 'utf8');
    expect(marked).toContain('<<<<<<<');
    expect(git(rb.codeAt!.path!, 'diff', '--name-only', '--diff-filter=U')).toBe('app.txt');
  });

  it('entregar SEM resolver não commita os marcadores: o checkpoint recusa e o card diz por quê', async () => {
    const p = await proj('conflito-sem-resolver');
    const a = await p.start('ana-1', 'A');
    const b = await p.start('bia-1', 'B');
    const ra = await p.deliver(a, { 'app.txt': body({ 5: 'versão do A' }) });
    const rb = await p.deliver(b, { 'app.txt': body({ 5: 'versão do B' }) });
    await p.svc.update('p', ra.id, { status: 'done' }, true);
    await p.svc.update('p', rb.id, { status: 'done' }, true); // conflito: volta ao responsável
    const bounced = await p.get(rb.id);
    expect(bounced.status).toBe('doing');
    const worktree = rb.codeAt!.path!;
    const had = git(worktree, 'rev-parse', 'HEAD');

    await sleep(1100);
    await p.svc.onTurnDone(bounced.sessionId!);
    await until(async () => (await p.get(rb.id)).history.some((h) => (h.note ?? '').startsWith('entrega sem commit: conflito não resolvido')));
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(had); // nenhum commit novo
    expect(git(worktree, 'show', 'HEAD:app.txt')).not.toContain('<<<<<<<');
    expect(git(worktree, 'diff', '--name-only', '--diff-filter=U')).toBe('app.txt'); // o conflito segue aberto, à espera de quem resolve
  });

  it('o responsável resolve no próprio worktree e entrega de novo: junta com o que ele decidiu, sem forçar nada', async () => {
    const p = await proj('conflito-resolvido');
    const a = await p.start('ana-1', 'A');
    const b = await p.start('bia-1', 'B');
    const ra = await p.deliver(a, { 'app.txt': body({ 5: 'versão do A' }) });
    const rb = await p.deliver(b, { 'app.txt': body({ 5: 'versão do B' }) });
    await p.svc.update('p', ra.id, { status: 'done' }, true);
    await p.svc.update('p', rb.id, { status: 'done' }, true); // conflito: volta ao responsável
    const worktree = rb.codeAt!.path!;

    const resolved = body({ 5: 'versão do B sobre a do A' });
    await fs.writeFile(path.join(worktree, 'app.txt'), resolved);
    git(worktree, 'add', 'app.txt');
    git(worktree, 'commit', '-qm', 'resolve o conflito');
    const again = await p.deliver(await p.get(rb.id), {}, rb); // entrega de novo: o checkpoint é o commit do merge resolvido
    expect(again.checkpoint!.sha).toBe(git(worktree, 'rev-parse', 'HEAD'));

    expect((await p.svc.update('p', rb.id, { status: 'done' }, true))?.status).toBe('done');
    expect(await fs.readFile(path.join(p.dir, 'app.txt'), 'utf8')).toBe(resolved);
    expect(mainClean(p.dir)).toBe('');
  });
});

describe('o principal sujo', () => {
  it('o que o dono deixou sujo FORA dos arquivos do card não é tocado: edição, arquivo novo e o que está no índice', async () => {
    const p = await proj('sujo-fora');
    const a = await p.start('ana-1', 'A');
    const ra = await p.deliver(a, { 'a.txt': 'do A\n' });
    await fs.writeFile(path.join(p.dir, 'app.txt'), body({ 3: 'edição do dono' })); // arquivo versionado alterado
    await fs.writeFile(path.join(p.dir, 'rascunho.txt'), 'novo do dono\n'); // arquivo novo, sem rastreio
    await fs.writeFile(path.join(p.dir, 'indice.txt'), 'no índice\n');
    git(p.dir, 'add', 'indice.txt'); // no índice, sem commit

    const out = await p.svc.update('p', ra.id, { status: 'done' }, true);
    expect(out?.status).toBe('done');
    expect(await fs.readFile(path.join(p.dir, 'a.txt'), 'utf8')).toBe('do A\n');
    expect(await fs.readFile(path.join(p.dir, 'app.txt'), 'utf8')).toBe(body({ 3: 'edição do dono' }));
    expect(await fs.readFile(path.join(p.dir, 'rascunho.txt'), 'utf8')).toBe('novo do dono\n');
    expect(await fs.readFile(path.join(p.dir, 'indice.txt'), 'utf8')).toBe('no índice\n');
    const status = git(p.dir, 'status', '--porcelain', '--', '.', ':(exclude).myco');
    expect(status).toMatch(/M app\.txt/); // (o git() do teste apara a saída: sem o espaço da frente)
    expect(status).toContain('?? rascunho.txt');
    expect(status).toContain('A  indice.txt');
    // E nada do dono foi parar no commit da junção.
    const joined = git(p.dir, 'diff', '--name-only', 'HEAD^1', 'HEAD'); // o commit de merge, contra o principal de antes
    expect(joined).toContain('a.txt');
    expect(joined).not.toMatch(/app\.txt|rascunho|indice/);
  });

  it('sujo no arquivo do card: o card FICA em Revisão com o motivo (sem erro), espera sem teto e junta sozinho quando o dono limpa', async () => {
    const p = await proj('sujo-no-card');
    const a = await p.start('ana-1', 'A');
    const ra = await p.deliver(a, { 'a.txt': 'do A\n' });
    await fs.writeFile(path.join(p.dir, 'a.txt'), 'do dono, sem commit\n'); // o mesmo arquivo, novo e sem rastreio, no principal

    const out = await p.svc.update('p', ra.id, { status: 'done' }, true);
    expect(out?.status).toBe('review');
    expect(out?.merged).toBeFalsy();
    expect(out?.autoMerge).toMatchObject({ byOwner: true, wait: { why: 'main-dirty' } });
    expect(out?.autoMerge?.wait?.detail).toContain('a.txt');
    expect(p.notes(out!).some((x) => x.startsWith('junção em espera:') && x.includes('a.txt'))).toBe(true);
    expect(await fs.readFile(path.join(p.dir, 'a.txt'), 'utf8')).toBe('do dono, sem commit\n');

    // Mais tentativas que o teto das falhas passageiras (5): continua esperando, sem parar nem contar.
    for (let i = 1; i <= 7; i++) await p.sweep(new Date(Date.now() + i * 60_000));
    const waiting = await p.get(ra.id);
    expect(waiting.status).toBe('review');
    expect(waiting.autoMerge?.stopped).toBeUndefined();
    expect(waiting.autoMerge?.retry).toBeUndefined();
    expect(waiting.history.filter((h) => (h.note ?? '').startsWith('junção em espera:'))).toHaveLength(1); // a nota sai uma vez por motivo

    // O dono limpa: a próxima varredura junta sozinha.
    await fs.rm(path.join(p.dir, 'a.txt'));
    await p.sweep(new Date(Date.now() + 10 * 60_000));
    const done = await p.get(ra.id);
    expect(done.status).toBe('done');
    expect(done.autoMerge).toBeUndefined();
    expect(await fs.readFile(path.join(p.dir, 'a.txt'), 'utf8')).toBe('do A\n');
  });

  it('o reinício no meio da espera: um serviço novo continua de onde parou e junta quando limpo', async () => {
    const p = await proj('sujo-reinicio');
    const a = await p.start('ana-1', 'A');
    const ra = await p.deliver(a, { 'a.txt': 'do A\n' });
    await fs.writeFile(path.join(p.dir, 'a.txt'), 'do dono\n');
    expect((await p.svc.update('p', ra.id, { status: 'done' }, true))?.status).toBe('review');

    const restarted = p.mk(); // o processo caiu e voltou: só o que está gravado vale
    await fs.rm(path.join(p.dir, 'a.txt'));
    await p.sweep(new Date(Date.now() + 60_000), restarted);
    expect((await p.get(ra.id)).status).toBe('done');
    expect(await fs.readFile(path.join(p.dir, 'a.txt'), 'utf8')).toBe('do A\n');
  });
});

describe('só o que é do card', () => {
  it('juntar o card A não leva o commit do card B, que segue em revisão', async () => {
    const p = await proj('so-do-card');
    const a = await p.start('ana-1', 'A');
    const b = await p.start('bia-1', 'B');
    const ra = await p.deliver(a, { 'a.txt': 'do A\n' });
    const rb = await p.deliver(b, { 'b.txt': 'do B\n' });

    await p.svc.update('p', ra.id, { status: 'done' }, true);

    expect(existsSync(path.join(p.dir, 'a.txt'))).toBe(true);
    expect(existsSync(path.join(p.dir, 'b.txt'))).toBe(false);
    expect(git(p.dir, 'branch', '--contains', rb.checkpoint!.sha)).not.toContain('main');
    expect(git(p.dir, 'log', '--format=%s', 'main')).not.toContain(rb.title);
    expect((await p.get(rb.id)).status).toBe('review');
    expect(existsSync(rb.codeAt!.path!)).toBe(true); // a worktree do B segue de pé
    expect(git(p.dir, 'branch', '--list', rb.codeAt!.branch!)).toContain(rb.codeAt!.branch!);
  });
});

// t-edf1bf: card de documentação. A cópia do card edita `docs/uso` e `client/public/manual.html` como qualquer código; o principal não é tocado até a aprovação e a junção leva os arquivos.
describe('documentação na cópia do card', () => {
  it('edita docs/uso e o manual na própria cópia: o principal fica limpo até aprovar e a junção leva os arquivos, sem tocar o doc que o dono deixou sujo', async () => {
    const p = await proj('docs-na-copia');
    const at = (...f: string[]) => path.join(p.dir, ...f);
    await fs.mkdir(at('docs', 'uso'), { recursive: true });
    await fs.mkdir(at('client', 'public'), { recursive: true });
    await fs.writeFile(at('docs', 'uso', '02-funcionarios.md'), '# Funcionários\n');
    await fs.writeFile(at('docs', 'uso', '04-tarefas.md'), '# Tarefas\n');
    await fs.writeFile(at('client', 'public', 'manual.html'), '<h1>Manual</h1>\n');
    git(p.dir, 'add', '.');
    git(p.dir, 'commit', '-qm', 'docs');

    const a = await p.start('ana-1', 'Manual: avisos');
    expect(a.codeAt).toMatchObject({ where: 'worktree', card: true });
    const ra = await p.deliver(a, {
      'docs/uso/02-funcionarios.md': '# Funcionários\nlinha do card\n',
      'docs/uso/10-novo.md': '# Novo\n',
      'client/public/manual.html': '<h1>Manual</h1>\n<p>do card</p>\n',
    });
    // A edição foi na cópia: o principal segue limpo e sem nenhum dos arquivos até a aprovação.
    expect(mainClean(p.dir)).toBe('');
    expect(await fs.readFile(at('docs', 'uso', '02-funcionarios.md'), 'utf8')).toBe('# Funcionários\n');
    expect(existsSync(at('docs', 'uso', '10-novo.md'))).toBe(false);
    expect(git(ra.codeAt!.path!, 'diff', '--name-only', 'main', 'HEAD').split(/\r?\n/).sort()).toEqual(['client/public/manual.html', 'docs/uso/02-funcionarios.md', 'docs/uso/10-novo.md']);

    // O dono deixa sujo OUTRO doc (o caso real: docs de um card em revisão): não trava a junção.
    await fs.writeFile(at('docs', 'uso', '04-tarefas.md'), '# Tarefas\nrascunho do dono\n');
    const out = await p.svc.update('p', ra.id, { status: 'done' }, true);
    expect(out?.status).toBe('done');

    expect(await fs.readFile(at('docs', 'uso', '02-funcionarios.md'), 'utf8')).toBe('# Funcionários\nlinha do card\n');
    expect(await fs.readFile(at('docs', 'uso', '10-novo.md'), 'utf8')).toBe('# Novo\n');
    expect(await fs.readFile(at('client', 'public', 'manual.html'), 'utf8')).toBe('<h1>Manual</h1>\n<p>do card</p>\n');
    expect(await fs.readFile(at('docs', 'uso', '04-tarefas.md'), 'utf8')).toBe('# Tarefas\nrascunho do dono\n');
    const status = git(p.dir, 'status', '--porcelain', '--', '.', ':(exclude).myco');
    expect(status).toMatch(/M docs\/uso\/04-tarefas\.md/); // (o git() do teste apara a saída: sem o espaço da frente)
    expect(status).not.toMatch(/02-funcionarios|10-novo|manual\.html/);
    const joined = git(p.dir, 'diff', '--name-only', 'HEAD^1', 'HEAD'); // o commit de merge, contra o principal de antes
    expect(joined).toMatch(/docs\/uso\/02-funcionarios\.md/);
    expect(joined).toMatch(/docs\/uso\/10-novo\.md/);
    expect(joined).toMatch(/client\/public\/manual\.html/);
    expect(joined).not.toMatch(/04-tarefas/);
  });
});

describe('a aprovação do revisor (conclusão por IA)', () => {
  it('junta sozinha e vai a Finalizado; com o arquivo do card sujo no principal espera mais que o teto de 5 e junta quando limpo', async () => {
    const p = await proj('revisor', { policy: 'auto' });
    const a = await p.start('ana-1', 'A');
    const ra = await p.deliver(a, { 'a.txt': 'do A\n' });
    await until(async () => (await p.get(ra.id)).review?.sessionId);
    await fs.writeFile(path.join(p.dir, 'a.txt'), 'do dono\n');
    p.texts.set((await p.get(ra.id)).review!.sessionId, 'APROVADO\n\nTudo conferido.');
    await p.svc.onTurnDone((await p.get(ra.id)).review!.sessionId);
    await p.svc.mergesSettled();

    for (let i = 1; i <= 7; i++) await p.sweep(new Date(Date.now() + i * 60_000));
    const waiting = await p.get(ra.id);
    expect(waiting.status).toBe('review');
    expect(waiting.autoMerge?.stopped).toBeUndefined();
    expect(waiting.autoMerge?.wait).toMatchObject({ why: 'main-dirty' });
    expect(waiting.autoMerge?.wait?.detail).toContain('a.txt');

    await fs.rm(path.join(p.dir, 'a.txt'));
    await p.sweep(new Date(Date.now() + 20 * 60_000));
    const done = await p.get(ra.id);
    expect(done.status).toBe('done');
    expect(done.merged).toBeTruthy();
    expect(await fs.readFile(path.join(p.dir, 'a.txt'), 'utf8')).toBe('do A\n');
    await until(async () => !existsSync(ra.codeAt!.path!));
  });
});

// SPEC "Desempenho" 9: a junção testa só o que o card traz (`scopedTestCommand`), na fila pesada; a rodada escopada não é a suíte, então não vira baseline dela (`suite:<sha>`).
describe('testes escopados na junção do card', () => {
  const suites = async (dir: string) => Object.keys(await readBaseline(dir)).filter((k) => k.startsWith('suite:'));

  it('com vitest e um arquivo de código no card: só os testes ligados a ele, com 2 processos, e nada de baseline da suíte', async () => {
    const p = await proj('escopado', { vitest: true });
    const a = await p.start('ana-1', 'A');
    const ra = await p.deliver(a, { 'src.ts': 'export const x = 2;\n' });

    expect((await p.svc.update('p', ra.id, { status: 'done' }, true))?.status).toBe('done');
    expect((await p.get(ra.id)).tests).toMatchObject({ ok: true, command: 'npx vitest related src.ts --run --passWithNoTests --maxWorkers=2' });
    expect(await suites(p.dir)).toEqual([]);
  });

  it('o card só mexe em texto (nada para o `related` achar): a suíte inteira, e ela vira o baseline', async () => {
    const p = await proj('inteira', { vitest: true });
    const a = await p.start('ana-1', 'A');
    const ra = await p.deliver(a, { 'app.txt': body({ 1: 'do A' }) });

    expect((await p.svc.update('p', ra.id, { status: 'done' }, true))?.status).toBe('done');
    expect((await p.get(ra.id)).tests).toMatchObject({ ok: true, command: 'npm test' });
    expect(await suites(p.dir)).toHaveLength(1);
  });
});

describe('testes no worktree do card', () => {
  it('vermelhos com o principal dentro: nada entra no principal e o card volta ao responsável', async () => {
    const p = await proj('vermelho');
    const a = await p.start('ana-1', 'A');
    const ra = await p.deliver(a, { 'ok.txt': 'nao' }); // quebra o `npm test` do projeto
    const head = git(p.dir, 'rev-parse', 'HEAD');

    const out = await p.svc.update('p', ra.id, { status: 'done' }, true);
    expect(out?.status).toBe('doing');
    expect(git(p.dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(await fs.readFile(path.join(p.dir, 'ok.txt'), 'utf8')).toBe('sim');
    expect(p.adjusts.at(-1)!.text).toContain('testes ficaram vermelhos');
    expect(mainClean(p.dir)).toBe('');
  });
});
