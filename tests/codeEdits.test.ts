import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { claudeEditedFile, codePath, codexEditedFiles, type CodeEdit } from '../server/chat/codeEdits';
import { CodexProcess } from '../server/chat/codexProcess';
import { ChatManager } from '../server/chat/manager';
import { ChatProcess } from '../server/chat/process';

// Edição de código vista na conversa (base do card automático do quadro): o que conta, o que não conta e a paridade Claude × Codex.

const tick = () => new Promise((r) => setTimeout(r, 20));
const proj = path.join(os.tmpdir(), 'myco-edits', 'proj');
const wt = path.join(proj, '.claude', 'worktrees', 'myco-ana-1');

describe('quais chamadas são edição', () => {
  it('Claude: Edit, MultiEdit e Write pelo file_path, NotebookEdit pelo notebook_path; o resto não é edição', () => {
    expect(claudeEditedFile('Edit', { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' })).toBe('/p/a.ts');
    expect(claudeEditedFile('MultiEdit', { file_path: '/p/b.ts', edits: [] })).toBe('/p/b.ts');
    expect(claudeEditedFile('Write', { file_path: '/p/c.ts', content: '' })).toBe('/p/c.ts');
    expect(claudeEditedFile('NotebookEdit', { notebook_path: '/p/n.ipynb', new_source: '' })).toBe('/p/n.ipynb');
    expect(claudeEditedFile('NotebookEdit', { file_path: '/p/n.ipynb' })).toBeNull();
    for (const tool of ['Read', 'Bash', 'Grep', 'Glob', 'TodoWrite', 'mcp__x__edit']) expect(claudeEditedFile(tool, { file_path: '/p/a.ts', command: 'sed -i s/a/b/ a.ts' })).toBeNull();
    expect(claudeEditedFile('Edit', {})).toBeNull();
    expect(claudeEditedFile('Edit', { file_path: '   ' })).toBeNull();
    expect(claudeEditedFile('Edit', null)).toBeNull();
  });

  it('Codex: só o file_change concluído, sem falha nem recusa; em andamento ou de outro tipo não conta', () => {
    const change = { id: 'item_2', type: 'file_change', changes: [{ path: '/tmp/projeto/novo.txt', kind: 'add' }, { path: '/tmp/projeto/b.ts', kind: 'update' }] };
    expect(codexEditedFiles('completed', { ...change, status: 'completed' })).toEqual(['/tmp/projeto/novo.txt', '/tmp/projeto/b.ts']);
    expect(codexEditedFiles('completed', change)).toEqual(['/tmp/projeto/novo.txt', '/tmp/projeto/b.ts']);
    expect(codexEditedFiles('started', { ...change, status: 'in_progress' })).toEqual([]);
    expect(codexEditedFiles('updated', { ...change, status: 'in_progress' })).toEqual([]);
    expect(codexEditedFiles('completed', { ...change, status: 'failed' })).toEqual([]);
    expect(codexEditedFiles('completed', { ...change, status: 'declined' })).toEqual([]);
    expect(codexEditedFiles('completed', { id: 'i', type: 'command_execution', command: 'sed -i s/a/b/ a.ts', status: 'completed' })).toEqual([]);
    expect(codexEditedFiles('completed', { type: 'file_change', changes: [{ kind: 'add' }, { path: '' }, 7] })).toEqual([]);
    expect(codexEditedFiles('completed', null)).toEqual([]);
  });
});

describe('o que é código do projeto', () => {
  it('dentro do projeto conta, relativo ao projeto (ou à worktree, onde a conversa roda)', () => {
    expect(codePath(path.join(proj, 'src', 'a.ts'), proj, proj)).toBe('src/a.ts');
    expect(codePath('src/a.ts', proj, proj)).toBe('src/a.ts');
    expect(codePath(path.join(wt, 'src', 'a.ts'), wt, proj)).toBe('src/a.ts');
    // Conversa na worktree que mexe no projeto principal: relativo ao projeto.
    expect(codePath(path.join(proj, 'README.md'), wt, proj)).toBe('README.md');
  });

  it('tudo em .myco/ fica de fora, em qualquer profundidade e inclusive na cópia dentro da worktree', () => {
    expect(codePath(path.join(proj, '.myco', 'staff', 'ana-1.memory.md'), proj, proj)).toBeNull();
    expect(codePath(path.join(proj, '.myco', 'tasks.json'), proj, proj)).toBeNull();
    expect(codePath('.myco/staff/ana-1.md', proj, proj)).toBeNull();
    expect(codePath(path.join(wt, '.myco', 'staff', 'ana-1.md'), wt, proj)).toBeNull();
    expect(codePath(path.join(proj, '.MYCO', 'x.md'), proj, proj)).toBeNull();
    expect(codePath(path.join(proj, 'pkg', '.myco', 'x.md'), proj, proj)).toBeNull();
    // Só a pasta com esse nome: um arquivo parecido é código.
    expect(codePath(path.join(proj, 'docs', 'myco.md'), proj, proj)).toBe('docs/myco.md');
    expect(codePath(path.join(proj, '.mycorp', 'a.ts'), proj, proj)).toBe('.mycorp/a.ts');
  });

  it('fora da pasta do projeto, a própria pasta e caminho que escapa por ".." não contam', () => {
    expect(codePath(path.join(os.tmpdir(), 'outro', 'a.ts'), proj, proj)).toBeNull();
    expect(codePath(path.join(os.homedir(), '.claude', 'settings.json'), proj, proj)).toBeNull();
    expect(codePath(proj, proj, proj)).toBeNull();
    expect(codePath('../fora/a.ts', proj, proj)).toBeNull();
    expect(codePath(path.join(proj, 'src', '..', '..', 'fora', 'a.ts'), proj, proj)).toBeNull();
    // Pasta irmã com o mesmo prefixo não é "dentro".
    expect(codePath(`${proj}-irmao${path.sep}a.ts`, proj, proj)).toBeNull();
  });
});

/** Um processo falso do claude: `emit` escreve uma linha no stdout dele. */
function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4242, kill: () => proc.emit('exit', 0) });
  stdin.on('finish', () => proc.emit('exit', 0));
  return { spawnImpl: () => proc as never, emit: (ev: object) => stdout.write(JSON.stringify(ev) + '\n') };
}

const use = (id: string, name: string, input: object, parent?: string) => ({ type: 'assistant', ...(parent && { parent_tool_use_id: parent }), message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, isError = false, parent?: string) => ({ type: 'user', ...(parent && { parent_tool_use_id: parent }), message: { content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'falhou' : 'ok', ...(isError && { is_error: true }) }] } });

describe('Claude: a edição só conta quando o resultado chega sem erro', () => {
  it('Edit e Write que deram certo chegam em onEdit; negada, com erro ou sem resultado não; Bash não', async () => {
    const f = fakeClaude();
    const seen: string[][] = [];
    const chat = new ChatProcess({ sessionId: 'c1', cwd: '.', args: [], spawnImpl: f.spawnImpl, onEdit: (files) => seen.push(files) });
    chat.start();
    f.emit(use('e1', 'Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }));
    f.emit(use('e2', 'Write', { file_path: '/p/b.ts', content: 'x' }));
    f.emit(use('e3', 'Edit', { file_path: '/p/c.ts', old_string: 'a', new_string: 'b' }));
    f.emit(use('e4', 'Edit', { file_path: '/p/d.ts', old_string: 'a', new_string: 'b' }));
    f.emit(use('b1', 'Bash', { command: "sed -i 's/a/b/' /p/e.ts" }));
    await tick();
    expect(seen).toEqual([]); // sem resultado, nada
    f.emit(result('e1'));
    f.emit(result('e2'));
    f.emit(result('e3', true)); // Edit com erro (texto não achado, ou permissão negada)
    f.emit(result('b1'));
    await tick();
    expect(seen).toEqual([['/p/a.ts'], ['/p/b.ts']]);
    // O mesmo resultado de novo (evento duplicado) não repete; e e4 nunca teve resultado.
    f.emit(result('e1'));
    await tick();
    expect(seen).toEqual([['/p/a.ts'], ['/p/b.ts']]);
  });

  it('as edições dos subagents também contam (e continuam fora da conversa principal)', async () => {
    const f = fakeClaude();
    const seen: string[][] = [];
    const chat = new ChatProcess({ sessionId: 'c2', cwd: '.', args: [], spawnImpl: f.spawnImpl, onEdit: (files) => seen.push(files) });
    chat.start();
    f.emit(use('s1', 'Write', { file_path: '/p/sub.ts', content: 'x' }, 'agent-1'));
    f.emit(use('s2', 'NotebookEdit', { notebook_path: '/p/n.ipynb', new_source: 'x' }, 'agent-1'));
    f.emit(use('s3', 'Edit', { file_path: '/p/falha.ts', old_string: 'a', new_string: 'b' }, 'agent-1'));
    f.emit(result('s1', false, 'agent-1'));
    f.emit(result('s2', false, 'agent-1'));
    f.emit(result('s3', true, 'agent-1'));
    await tick();
    expect(seen).toEqual([['/p/sub.ts'], ['/p/n.ipynb']]);
    // O que o subagent faz não aparece como ferramenta da conversa principal.
    expect(chat.snapshot().items.filter((i) => i.kind === 'tool')).toEqual([]);
  });

  it('sem onEdit nada muda; lastUserText devolve o último pedido', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 'c3', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    expect(chat.lastUserText()).toBeNull();
    chat.send('primeiro pedido');
    chat.send('corrija o botão de exportar');
    f.emit(use('e1', 'Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }));
    f.emit(result('e1'));
    await tick();
    expect(chat.lastUserText()).toBe('corrija o botão de exportar');
  });
});

describe('Codex: o file_change concluído equivale à edição do Claude', () => {
  const profile = { cwd: '/proj', sessionId: 'cx-1', permissionMode: 'default', secrets: { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' } };

  function fakeCodex() {
    const runs: Array<{ emit: (ev: object) => void; close: () => void }> = [];
    const spawnImpl = () => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 5000 + runs.length });
      runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'), close: () => void child.emit('close', 0) });
      return child as never;
    };
    return { runs, spawnImpl };
  }

  it('só no item.completed sem falha; a execução em andamento e o comando de shell não contam', async () => {
    const f = fakeCodex();
    const seen: string[][] = [];
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onEdit: (files) => seen.push(files) });
    chat.start();
    chat.send('crie um arquivo');
    const r = f.runs[0]!;
    r.emit({ type: 'item.started', item: { id: 'item_0', type: 'file_change', changes: [{ path: '/proj/novo.txt', kind: 'add' }], status: 'in_progress' } });
    r.emit({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "bash -lc 'sed -i s/a/b/ a.ts'", aggregated_output: '', exit_code: 0, status: 'completed' } });
    r.emit({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: '/proj/falhou.txt', kind: 'update' }], status: 'failed' } });
    await tick();
    expect(seen).toEqual([]);
    r.emit({ type: 'item.completed', item: { id: 'item_0', type: 'file_change', changes: [{ path: '/proj/novo.txt', kind: 'add' }], status: 'completed' } });
    r.emit({ type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: '/proj/a.ts', kind: 'update' }, { path: '/proj/b.ts', kind: 'update' }], status: 'completed' } });
    r.emit({ type: 'turn.completed', usage: {} });
    r.close();
    await tick();
    expect(seen).toEqual([['/proj/novo.txt'], ['/proj/a.ts', '/proj/b.ts']]);
  });
});

describe('ChatManager repassa a edição com quem, onde e o pedido, nos dois motores', () => {
  it('só conversa de funcionário: Claude e Codex trazem staffId, projectId, motor, cwd e o último pedido; sem ficha não avisa', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-edit-mgr-'));
    const edits: CodeEdit[] = [];
    // Um processo falso por abertura: a conversa da Ana (Claude), a sem ficha (Claude) e a da Cris (Codex).
    const claudes: Array<ReturnType<typeof fakeClaude>> = [];
    const codex: { run: { emit: (ev: object) => void; close: () => void } | null } = { run: null };
    const manager = new ChatManager({
      transcriptsDir: dir,
      usageFile: path.join(dir, 'usage.json'),
      listLive: async () => [],
      onEdit: (e) => edits.push(e),
      resolve: async (_p, sid, staffId) =>
        staffId === 'cris'
          ? {
              sessionId: sid ?? 'sess-codex',
              cwd: dir,
              args: [],
              engine: 'codex' as const,
              codex: {
                autonomy: 'acceptEdits' as const,
                model: null,
                effort: null,
                instructions: 'Ficha',
                writableRoots: [],
                readOnlyPaths: [],
                agents: [],
                secrets: { projectPath: dir, home: path.join(dir, 'sem-home'), mycoHome: path.join(dir, 'sem-myco') },
                threadId: null,
                threadFile: path.join(dir, 'codex-thread.json'),
                mycoUrl: 'http://127.0.0.2:4848',
              },
            }
          : { sessionId: sid ?? (staffId ? 'sess-claude' : 'sess-livre'), cwd: dir, args: ['--resume', 'x'] },
      spawnImpl: (cmd) => {
        if (cmd !== 'codex') {
          claudes.push(fakeClaude());
          return claudes.at(-1)!.spawnImpl();
        }
        const stdout = new PassThrough();
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 6000 });
        codex.run = { emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'), close: () => void child.emit('close', 0) };
        return child as never;
      },
      log: () => {},
    });
    try {
      await manager.send('p1', null, 'ana', 'Corrija o botão de exportar');
      claudes[0]!.emit(use('e1', 'Edit', { file_path: path.join(dir, 'src', 'a.ts'), old_string: 'a', new_string: 'b' }));
      claudes[0]!.emit(result('e1'));
      await manager.send('p1', null, 'cris', 'Crie o relatório');
      for (let i = 0; i < 50 && !codex.run; i++) await tick(); // o Codex abre depois de preparar a execução
      codex.run!.emit({ type: 'item.completed', item: { id: 'item_0', type: 'file_change', changes: [{ path: path.join(dir, 'rel.ts'), kind: 'add' }], status: 'completed' } });
      await tick();
      await manager.send('p1', null, null, 'sem ficha');
      claudes[1]!.emit(use('e2', 'Write', { file_path: path.join(dir, 'livre.ts'), content: 'x' }));
      claudes[1]!.emit(result('e2'));
      await tick();
      expect(edits).toEqual([
        { sessionId: 'sess-claude', projectId: 'p1', staffId: 'ana', engine: 'claude', cwd: dir, files: [path.join(dir, 'src', 'a.ts')], request: 'Corrija o botão de exportar' },
        { sessionId: 'sess-codex', projectId: 'p1', staffId: 'cris', engine: 'codex', cwd: dir, files: [path.join(dir, 'rel.ts')], request: 'Crie o relatório' },
      ]);
    } finally {
      // A execução do Codex termina antes de fechar tudo (o processo é falso: fechar com ela aberta tentaria encerrar um pid de verdade).
      codex.run?.emit({ type: 'turn.completed', usage: {} });
      codex.run?.close();
      await tick();
      await manager.stopAll();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
