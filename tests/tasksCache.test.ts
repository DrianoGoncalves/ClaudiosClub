import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTasks } from '../server/tasks';
import { removeTemp } from './support/tmp';

// O quadro guardado por versão do arquivo (server/tasks.ts, `readTasks`): gravação no lugar, de mesmo tamanho e em seguida (o mtime do Windows anda
// em degraus de ~15,6 ms), nunca devolve o quadro velho; arquivo parado volta do guardado; cada leitor recebe a própria lista.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-taskscache-'));
});
afterAll(() => removeTemp(root));

const task = (id: string, title: string) => ({ id, title, description: '', status: 'todo', staffId: null, sessionId: null, plan: null, branch: null, pr: null, history: [], createdAt: '2026-11-23T10:00:00.000Z', updatedAt: '2026-11-23T10:00:00.000Z' });

async function project(name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  return { dir, file, write: (title: string) => fs.writeFile(file, JSON.stringify([task('t-1', title)])) };
}

describe('readTasks guardado', () => {
  it('gravações no lugar, de mesmo tamanho e seguidas: cada leitura vê a última (sem o degrau do mtime enganar)', async () => {
    const p = await project('seguidas');
    for (const title of ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE']) {
      await p.write(title); // mesmo tamanho, mesmo inode, quase sempre o mesmo mtime no Windows
      expect((await readTasks(p.dir))[0]!.title).toBe(title);
    }
  });

  it('arquivo parado: a leitura seguinte vem do guardado (os mesmos objetos), e cada leitor ganha a própria lista', async () => {
    const p = await project('parado');
    await p.write('XXXX');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(p.file, old, old); // parado há 1 min
    const a = await readTasks(p.dir);
    const b = await readTasks(p.dir);
    expect(b[0]).toBe(a[0]); // do guardado
    expect(b).not.toBe(a); // listas diferentes
    a.push(a[0]!);
    expect(await readTasks(p.dir)).toHaveLength(1); // mexer na lista de um não muda a de outro
    // Nos testes, a tarefa guardada vem congelada: quem tenta alterar no lugar quebra aqui, não em produção.
    expect(() => {
      (b[0] as { title: string }).title = 'mudei';
    }).toThrow(TypeError);
  });

  it('arquivo que mudou depois de guardado (mesmo tamanho, mtime novo): lê de novo', async () => {
    const p = await project('mudou');
    await p.write('AAAA');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(p.file, old, old);
    expect((await readTasks(p.dir))[0]!.title).toBe('AAAA');
    await p.write('BBBB');
    expect((await readTasks(p.dir))[0]!.title).toBe('BBBB');
  });

  it('sem arquivo ou com JSON ruim: lista vazia, e nada fica guardado', async () => {
    const p = await project('ruim');
    expect(await readTasks(p.dir)).toEqual([]);
    await fs.writeFile(p.file, '{ quebrado');
    expect(await readTasks(p.dir)).toEqual([]);
    await p.write('OKOK');
    expect((await readTasks(p.dir))[0]!.title).toBe('OKOK');
  });
});
