import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendRun, readRuns, RUNS_ROTATE_BYTES, type TaskRunEvent } from '../server/taskRuns';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-runs-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const ev = (over: Partial<TaskRunEvent> = {}): TaskRunEvent => ({ ev: 'start', runId: 'r-1', taskId: 't-1', staffId: 'ana-1', at: new Date().toISOString(), ...over });

describe('registro de execuções (taskRuns.ts)', () => {
  it('grava em .myco fora do git, sem intercalar linhas, e não cola na linha pela metade', async () => {
    const dir = path.join(root, 'basico');
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    await fs.writeFile(path.join(dir, '.myco', 'task-runs.jsonl'), '{"ev":"start","runId":"r-');
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendRun(dir, ev({ runId: `r-${i + 2}` }))));
    expect(await readRuns(dir)).toHaveLength(20);
    expect(await fs.readFile(path.join(dir, '.myco', '.gitignore'), 'utf8')).toContain('task-runs.jsonl*');
  });

  it('acima do limite, gira para .1 (só um antigo) e segue no arquivo novo', async () => {
    const dir = path.join(root, 'gira');
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    const file = path.join(dir, '.myco', 'task-runs.jsonl');
    await fs.writeFile(file, 'x'.repeat(RUNS_ROTATE_BYTES + 1) + '\n');
    await appendRun(dir, ev({ runId: 'r-novo' }));
    expect((await fs.stat(`${file}.1`)).size).toBeGreaterThan(RUNS_ROTATE_BYTES);
    expect((await readRuns(dir)).map((e) => e.runId)).toEqual(['r-novo']);
  });
});
