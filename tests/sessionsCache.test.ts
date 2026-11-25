import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSession } from '../shared/model';
import { readProjectSessions, transcriptCacheSize } from '../server/adapters/claude/sessions';
import { removeTemp } from './support/tmp';

// O /api/board passa por todo transcript recente: o começo e o fim de cada um são lidos uma vez por versão do arquivo (SPEC "Desempenho" 2).
const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock('../server/adapters/claude/fsutil', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../server/adapters/claude/fsutil')>();
  return {
    ...orig,
    readHeadTail: (...args: Parameters<typeof orig.readHeadTail>) => {
      reads.n++;
      return orig.readHeadTail(...args);
    },
  };
});

let root: string;
let n = 0;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-sessions-cache-'));
});
afterAll(() => removeTemp(root));
beforeEach(() => {
  reads.n = 0;
});

/** Pasta de projeto nova por teste: o guardado é por arquivo, e um teste não vê o do outro. */
async function projectDir(): Promise<string> {
  const dir = path.join(root, `p${++n}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Grava o transcript e põe o mtime `ageMs` no passado (fora da janela em que não se guarda); negativo põe no futuro (sempre dentro dela). */
async function transcript(dir: string, id: string, lines: object[], ageMs = 60_000): Promise<string> {
  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const t = new Date(Date.now() - ageMs);
  await fs.utimes(file, t, t);
  return file;
}

const origin = {
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-11-20T10:00:00.000Z',
  entrypoint: 'cli',
  gitBranch: 'main',
  version: '2.0.0',
  message: { content: '[Tarefa "Cache do quadro"] reler só o que mudou' },
};

const liveOf = (sessionId: string, name: string): LiveSession => ({
  sessionId,
  pid: 1,
  cwd: null,
  name,
  status: null,
  alive: true,
  entrypoint: null,
  kind: null,
  startedAt: null,
  statusUpdatedAt: null,
});

describe('lista de conversas: transcript lido uma vez por versão', () => {
  it('a segunda montagem do mesmo transcript não relê o arquivo e dá o mesmo resultado', async () => {
    const dir = await projectDir();
    await transcript(dir, 's1', [origin, { type: 'custom-title', customTitle: 'Quadro rápido' }]);
    const first = await readProjectSessions(dir, new Map());
    const second = await readProjectSessions(dir, new Map());
    expect(reads.n).toBe(1);
    expect(second).toEqual(first);
    expect(second[0]).toMatchObject({
      title: 'Quadro rápido',
      topic: 'Cache do quadro',
      gitBranch: 'main',
      entrypoint: 'cli',
      version: '2.0.0',
      startedAt: origin.timestamp,
    });
  });

  it('transcript grande (começo e fim separados): título do fim e assunto do começo, lidos uma vez', async () => {
    const dir = await projectDir();
    const filler = Array.from({ length: 200 }, (_, i) => ({ type: 'assistant', uuid: `a${i}`, message: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } }));
    const file = await transcript(dir, 's1', [origin, ...filler, { type: 'custom-title', customTitle: 'No fim do arquivo' }]);
    expect((await fs.stat(file)).size).toBeGreaterThan(2 * 64 * 1024);
    const first = await readProjectSessions(dir, new Map());
    const second = await readProjectSessions(dir, new Map());
    expect(second[0]).toMatchObject({ title: 'No fim do arquivo', topic: 'Cache do quadro', gitBranch: 'main' });
    expect(second).toEqual(first);
    expect(reads.n).toBe(1);
  });

  it('transcript que ganhou linha é relido (o título novo aparece)', async () => {
    const dir = await projectDir();
    const file = await transcript(dir, 's1', [origin]);
    expect((await readProjectSessions(dir, new Map()))[0]?.title).toBeNull();
    await fs.appendFile(file, JSON.stringify({ type: 'custom-title', customTitle: 'Renomeada' }) + '\n', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    expect((await readProjectSessions(dir, new Map()))[0]?.title).toBe('Renomeada');
    expect(reads.n).toBe(2);
  });

  it('transcript mexido há pouco não é guardado: cada montagem relê', async () => {
    const dir = await projectDir();
    // mtime no futuro: sempre dentro da janela, por mais lenta que a máquina esteja entre as duas montagens.
    await transcript(dir, 's1', [origin], -60_000);
    await readProjectSessions(dir, new Map());
    await readProjectSessions(dir, new Map());
    expect(reads.n).toBe(2);
  });

  it('o que é ao vivo não vem do guardado', async () => {
    const dir = await projectDir();
    await transcript(dir, 's1', [origin]);
    const parada = (await readProjectSessions(dir, new Map()))[0];
    expect(parada).toMatchObject({ title: null, live: null });
    const viva = (await readProjectSessions(dir, new Map([['s1', liveOf('s1', 'Conversa viva')]])))[0];
    expect(viva?.title).toBe('Conversa viva');
    expect(viva?.live?.alive).toBe(true);
    expect(reads.n).toBe(1);
  });

  it('o custom-title.json ao lado é lido a cada vez (renomear não mexe no transcript)', async () => {
    const dir = await projectDir();
    await transcript(dir, 's1', [origin]);
    await readProjectSessions(dir, new Map());
    await fs.mkdir(path.join(dir, 's1'), { recursive: true });
    await fs.writeFile(path.join(dir, 's1', 'custom-title.json'), JSON.stringify({ customTitle: 'Pelo arquivo' }), 'utf8');
    expect((await readProjectSessions(dir, new Map()))[0]?.title).toBe('Pelo arquivo');
    expect(reads.n).toBe(1);
  });

  it('transcript apagado sai da lista e do guardado; o recriado com o mesmo nome é lido de novo', async () => {
    const dir = await projectDir();
    const file = await transcript(dir, 's1', [origin, { type: 'custom-title', customTitle: 'Antiga' }]);
    await readProjectSessions(dir, new Map());
    const guardados = transcriptCacheSize();
    await fs.rm(file);
    expect(await readProjectSessions(dir, new Map())).toEqual([]);
    expect(transcriptCacheSize()).toBe(guardados - 1);
    await transcript(dir, 's1', [origin, { type: 'custom-title', customTitle: 'Nova' }]);
    expect((await readProjectSessions(dir, new Map()))[0]?.title).toBe('Nova');
    expect(reads.n).toBe(2);
  });
});
