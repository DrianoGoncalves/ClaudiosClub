import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Routine, StaffProfile } from '../shared/model';
import { RoutineScheduler, type RoutineOutcome } from '../server/routines';
import { RoutinesSchema } from '../server/staff/store';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-routines-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  name: 'Revisar PRs',
  schedule: '0 19 * * 1-5',
  message: 'Revise os PRs abertos.',
  mode: 'continue',
  enabled: true,
  ...over,
});
const profile = (routines: Routine[]): StaffProfile =>
  ({ id: 'ana-1', projectId: 'proj', name: 'Ana', sessions: [], routines }) as unknown as StaffProfile;

function scheduler(file: string, routines: Routine[], outcome: RoutineOutcome = { ok: true, text: 'mandada' }) {
  const calls: string[] = [];
  const s = new RoutineScheduler({
    file: path.join(root, file),
    listStaff: async () => [profile(routines)],
    run: async (_p, r) => {
      calls.push(r.id);
      return outcome;
    },
    log: () => {},
  });
  return { s, calls };
}

// Segunda-feira, horário local.
const monday19 = new Date(2026, 9, 26, 19, 0, 10);

describe('rotinas agendadas', () => {
  it('dispara uma vez no minuto que bate, nem antes nem de novo no mesmo minuto', async () => {
    const { s, calls } = scheduler('a.json', [routine(), routine({ id: 'r2', enabled: false })]);
    await s.tick(new Date(2026, 9, 26, 18, 59, 50));
    await s.tick(monday19);
    await s.tick(new Date(2026, 9, 26, 19, 0, 40));
    expect(calls).toEqual(['r1']);
    expect((await s.state())['proj:ana-1:r1']).toMatchObject({ ok: true, text: 'mandada' });
  });

  it('reinício no mesmo minuto não dispara de novo (a última execução fica no disco)', async () => {
    const first = scheduler('b.json', [routine()]);
    await first.s.tick(monday19);
    const again = scheduler('b.json', [routine()]);
    await again.s.tick(new Date(2026, 9, 26, 19, 0, 50));
    expect([...first.calls, ...again.calls]).toEqual(['r1']);
  });

  it('não rodou: fica registrado e vira aviso; "rodar agora" ignora o horário', async () => {
    const { s, calls } = scheduler('c.json', [routine()], { ok: false, text: 'pulada: ele estava trabalhando' });
    await s.tick(monday19);
    expect(s.alerts()).toEqual([expect.objectContaining({ staffName: 'Ana', routineName: 'Revisar PRs', text: 'pulada: ele estava trabalhando' })]);
    expect(s.dismissAlert(s.alerts()[0]!.id)).toBe(true);
    expect(s.alerts()).toEqual([]);
    expect(await s.runNow(profile([routine()]), 'r1')).toMatchObject({ ok: false });
    expect(await s.runNow(profile([routine()]), 'nao-existe')).toBeNull();
    expect(calls).toEqual(['r1', 'r1']);
  });

  it('valida a rotina: horário em cron, nome e mensagem', () => {
    expect(RoutinesSchema.safeParse([routine()]).success).toBe(true);
    const bad = RoutinesSchema.safeParse([routine({ schedule: '0 25 * * *' })]);
    expect(bad.success || bad.error.issues[0]!.message).toMatch(/horário: hora/);
    expect(RoutinesSchema.safeParse([routine({ message: ' ' })]).success).toBe(false);
    expect(RoutinesSchema.safeParse(Array.from({ length: 11 }, (_, i) => routine({ id: `r${i}` }))).success).toBe(false);
  });
});
