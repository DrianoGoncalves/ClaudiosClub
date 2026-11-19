import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTINE_HISTORY_MAX, type CalendarRecurrence, type Routine, type StaffProfile } from '../shared/model';
import { writeAtomic } from '../server/atomicWrite';
import { RoutineScheduler, type RoutineOutcome } from '../server/routines';

// Agendador das rotinas com execução atrasada: o cursor guarda o horário PREVISTO já tratado; cada tick roda UMA vez a ocorrência mais recente
// não tratada (se dentro do limite, inclusive) e descarta as outras com registro. 2026-11-18 é quarta-feira; horário local.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-catchup-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

let n = 0;
/** Um arquivo de estado novo por teste: "reiniciar" é criar outro agendador sobre o mesmo arquivo. */
const stateFile = () => path.join(root, `estado-${++n}.json`);
const KEY = 'proj:ana-1:r1';

const routine = (over: Partial<Routine> = {}): Routine => ({ id: 'r1', name: 'Revisar', schedule: '0 9 * * *', message: 'Revise.', mode: 'continue', enabled: true, ...over });
const profile = (routines: Routine[]): StaffProfile => ({ id: 'ana-1', projectId: 'proj', name: 'Ana', sessions: [], routines }) as unknown as StaffProfile;
/** Dia (novembro de 2026), hora, minuto, segundo, no horário local. */
const t = (day: number, h = 0, mi = 0, s = 0) => new Date(2026, 10, day, h, mi, s);

function make(file: string, routines: () => Routine[], over: { outcome?: RoutineOutcome; write?: (f: string, text: string) => Promise<void> } = {}) {
  const calls: Array<{ id: string; minute: string }> = [];
  const logs: string[] = [];
  const s = new RoutineScheduler({
    file,
    listStaff: async () => [profile(routines())],
    run: async (_p, r, minute) => {
      calls.push({ id: r.id, minute });
      return over.outcome ?? { ok: true, text: 'mandada' };
    },
    ...(over.write && { write: over.write }),
    log: (l) => logs.push(l),
  });
  return { s, calls, logs };
}

describe('execução atrasada: dentro do limite', () => {
  it('reinício depois do horário roda UMA vez a ocorrência perdida, com o minuto PREVISTO, e não repete', async () => {
    const f = stateFile();
    const rs = [routine({ catchUpHours: 6 })];
    const before = make(f, () => rs);
    await before.s.tick(t(18, 8)); // o app estava ligado antes das 9h
    const after = make(f, () => rs); // fechou e abriu às 12h
    await after.s.tick(t(18, 12));
    expect(after.calls).toEqual([{ id: 'r1', minute: '2026-11-18T09:00' }]);
    expect((await after.s.snapshot(KEY))?.history[0]).toMatchObject({ state: 'ran', due: t(18, 9).toISOString(), lateMin: 180 });
    await after.s.tick(t(18, 12, 0, 30));
    await make(f, () => rs).s.tick(t(18, 12, 1)); // outro reinício
    expect(after.calls).toHaveLength(1);
  });

  it('o limite é inclusivo: no limite exato roda; um minuto além descarta', async () => {
    const rs = [routine({ catchUpHours: 6 })];
    const onTheEdge = stateFile();
    await make(onTheEdge, () => rs).s.tick(t(18, 8));
    const edge = make(onTheEdge, () => rs);
    await edge.s.tick(t(18, 15, 0)); // 9h + 6h
    expect(edge.calls).toHaveLength(1);

    const past = stateFile();
    await make(past, () => rs).s.tick(t(18, 8));
    const late = make(past, () => rs);
    await late.s.tick(t(18, 15, 1));
    expect(late.calls).toEqual([]);
    expect((await late.s.snapshot(KEY))?.history[0]).toMatchObject({ state: 'discarded' });
  });

  it('várias perdidas: roda só a mais recente e registra as anteriores como descartadas (em lote)', async () => {
    const f = stateFile();
    const rs = [routine({ schedule: '0 * * * *', catchUpHours: 5 })];
    await make(f, () => rs).s.tick(t(18, 8, 30));
    const after = make(f, () => rs);
    await after.s.tick(t(18, 13, 30)); // perdeu 9h, 10h, 11h, 12h e 13h
    expect(after.calls).toEqual([{ id: 'r1', minute: '2026-11-18T13:00' }]);
    const history = (await after.s.snapshot(KEY))!.history;
    expect(history[0]).toMatchObject({ state: 'ran', due: t(18, 13).toISOString(), lateMin: 30 });
    expect(history[1]).toMatchObject({ state: 'discarded', count: 4, from: t(18, 9).toISOString(), due: t(18, 12).toISOString() });
    expect(history[1]!.text).toMatch(/mais recente/);
    await after.s.tick(t(18, 13, 31));
    expect(after.calls).toHaveLength(1);
  });
});

describe('execução atrasada: fora do limite, e desligada', () => {
  it('fora do limite não roda, descarta com o motivo, e o dia seguinte roda normal', async () => {
    const f = stateFile();
    const rs = [routine({ catchUpHours: 6 })];
    await make(f, () => rs).s.tick(t(18, 8));
    const after = make(f, () => rs);
    await after.s.tick(t(18, 16)); // 7 h depois
    expect(after.calls).toEqual([]);
    const snap = await after.s.snapshot(KEY);
    expect(snap?.history).toHaveLength(1);
    expect(snap?.history[0]).toMatchObject({ state: 'discarded', due: t(18, 9).toISOString() });
    expect(snap?.history[0]!.text).toMatch(/limite de 6 h/);
    await make(f, () => rs).s.tick(t(18, 16, 1)); // o descarte ficou gravado: não volta
    await after.s.tick(t(19, 9, 0, 10));
    expect(after.calls).toEqual([{ id: 'r1', minute: '2026-11-19T09:00' }]);
  });

  it('sem `catchUpHours` só roda no minuto marcado: 30 s depois ainda vale, passado o minuto descarta', async () => {
    const rs = [routine()];
    const inMinute = stateFile();
    await make(inMinute, () => rs).s.tick(t(18, 8));
    const a = make(inMinute, () => rs);
    await a.s.tick(t(18, 9, 0, 30));
    expect(a.calls).toHaveLength(1);

    const pastMinute = stateFile();
    await make(pastMinute, () => rs).s.tick(t(18, 8));
    const b = make(pastMinute, () => rs);
    await b.s.tick(t(18, 9, 1, 5));
    expect(b.calls).toEqual([]);
    expect((await b.s.snapshot(KEY))?.history[0]).toMatchObject({ state: 'discarded' });
    expect((await b.s.snapshot(KEY))?.history[0]!.text).toMatch(/atrasada está desligada/);
  });
});

describe('reserva antes de executar', () => {
  it('a gravação da reserva falha: NÃO executa; quando volta a gravar, roda uma vez só', async () => {
    const f = stateFile();
    let failing = false;
    const write = async (file: string, text: string) => {
      if (failing) throw new Error('disco cheio');
      await writeAtomic(file, text);
    };
    const rs = [routine()];
    const h = make(f, () => rs, { write });
    await h.s.tick(t(18, 8));
    failing = true;
    await h.s.tick(t(18, 9, 0, 10));
    expect(h.calls).toEqual([]);
    expect(h.logs.join('\n')).toMatch(/não consegui gravar/);
    failing = false;
    await h.s.tick(t(18, 9, 0, 30));
    expect(h.calls).toEqual([{ id: 'r1', minute: '2026-11-18T09:00' }]);
    await h.s.tick(t(18, 9, 0, 50));
    expect(h.calls).toHaveLength(1);
  });

  it('queda depois da reserva e antes do fim: a ocorrência fica incerta, vira aviso e NÃO é tentada de novo', async () => {
    const f = stateFile();
    const rs = [routine({ catchUpHours: 6 })];
    await make(f, () => rs).s.tick(t(18, 8));
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => (started = resolve));
    const dying = new RoutineScheduler({
      file: f,
      listStaff: async () => [profile(rs)],
      run: async () => {
        started();
        return new Promise<RoutineOutcome>(() => {}); // o processo caiu aqui: nunca termina
      },
      log: () => {},
    });
    void dying.tick(t(18, 9, 0, 10));
    await hasStarted;

    const reborn = make(f, () => rs);
    await reborn.s.tick(t(18, 9, 0, 30));
    await reborn.s.tick(t(18, 9, 1));
    await reborn.s.tick(t(18, 10));
    expect(reborn.calls).toEqual([]);
    const snap = await reborn.s.snapshot(KEY);
    expect(snap?.history[0]).toMatchObject({ state: 'uncertain', due: t(18, 9).toISOString() });
    expect(snap?.inFlight).toBeNull();
    expect(reborn.s.alerts()).toEqual([expect.objectContaining({ uncertain: true, routineName: 'Revisar', staffName: 'Ana' })]);
    // E segue valendo para as próximas: no dia seguinte roda.
    await reborn.s.tick(t(19, 9, 0, 10));
    expect(reborn.calls).toEqual([{ id: 'r1', minute: '2026-11-19T09:00' }]);
  });
});

describe('arquivo de estado', () => {
  it('corrompido não vira estado vazio calado: guarda cópia, avisa e NÃO repete o que acabou de rodar', async () => {
    const f = stateFile();
    const rs = [routine({ catchUpHours: 6 })];
    const first = make(f, () => rs);
    await first.s.tick(t(18, 8));
    await first.s.tick(t(18, 9, 0, 10));
    expect(first.calls).toHaveLength(1);

    await fs.writeFile(f, '{"version":2,"routines":{"proj:ana');
    const second = make(f, () => rs);
    await second.s.tick(t(18, 9, 0, 40)); // mesmo minuto
    await second.s.tick(t(18, 12));
    expect(second.calls).toEqual([]);
    expect(second.s.warning()).toMatch(/corrompido/);
    const copies = (await fs.readdir(root)).filter((name) => name.startsWith(`${path.basename(f)}.corrompido-`));
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(path.join(root, copies[0]!), 'utf8')).toContain('"proj:ana');
    await second.s.tick(t(19, 9, 0, 10)); // e o dia seguinte roda
    expect(second.calls).toHaveLength(1);
  });

  it('vazio e com formato errado também contam como corrompidos; ausente não', async () => {
    const rs = [routine()];
    for (const garbage of ['', '[]', '"texto"', '{"version":3,"routines":{}}', '{"version":2,"routines":[]}']) {
      const f = stateFile();
      await fs.writeFile(f, garbage);
      const h = make(f, () => rs);
      await h.s.tick(t(18, 9, 0, 10));
      expect(h.s.warning(), garbage).toMatch(/corrompido/);
      expect(h.calls, garbage).toEqual([]);
    }
    const absent = make(stateFile(), () => rs);
    await absent.s.tick(t(18, 9, 0, 10));
    expect(absent.s.warning()).toBeNull();
    expect(absent.calls).toHaveLength(1); // rotina nova, no minuto dela: roda como sempre rodou
  });

  it('erro de leitura que não é "ausente" não executa nada (nem vira estado vazio)', async () => {
    const dir = path.join(root, `dir-${++n}`);
    await fs.mkdir(dir); // o "arquivo" é uma pasta: EISDIR
    const h = make(dir, () => [routine()]);
    await expect(h.s.tick(t(18, 9, 0, 10))).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });

  it('arquivo antigo (sem version) migra: a última execução fica, e o minuto que já disparou não repete', async () => {
    const f = stateFile();
    await fs.writeFile(f, JSON.stringify({ [KEY]: { at: t(18, 9, 0, 5).toISOString(), ok: true, text: 'mandada', minute: '2026-11-18T09:00' } }));
    const h = make(f, () => [routine()]);
    await h.s.tick(t(18, 9, 0, 40)); // reinício no mesmo minuto da última execução
    expect(h.calls).toEqual([]);
    expect((await h.s.state())[KEY]).toMatchObject({ ok: true, text: 'mandada' });
    expect(JSON.parse(await fs.readFile(f, 'utf8'))).toMatchObject({ version: 2 });
    await h.s.tick(t(19, 9, 0, 10));
    expect(h.calls).toEqual([{ id: 'r1', minute: '2026-11-19T09:00' }]);
  });
});

describe('Rodar agora, ligar e desligar, edição', () => {
  it('"Rodar agora" roda e registra, mas não mexe no cursor: a ocorrência marcada ainda roda', async () => {
    const f = stateFile();
    const rs = [routine()];
    const h = make(f, () => rs);
    await h.s.tick(t(18, 8));
    const before = await h.s.snapshot(KEY);
    expect(await h.s.runNow(profile(rs), 'r1')).toMatchObject({ ok: true });
    const after = await h.s.snapshot(KEY);
    expect(after?.cursor).toBe(before?.cursor);
    expect(after?.history[0]).toMatchObject({ state: 'ran', manual: true });
    expect((await h.s.state())[KEY]).toMatchObject({ ok: true });
    expect(h.calls).toHaveLength(1);
    await h.s.tick(t(18, 9, 0, 10));
    expect(h.calls).toHaveLength(2);
    expect((await h.s.snapshot(KEY))?.history[0]).toMatchObject({ state: 'ran', due: t(18, 9).toISOString() });
    expect((await h.s.snapshot(KEY))?.history[0]!.manual).toBeUndefined();
  });

  it('reativar não recupera o que passou enquanto estava desligada (mesmo com a execução atrasada ligada)', async () => {
    const f = stateFile();
    let enabled = true;
    const h = make(f, () => [routine({ catchUpHours: 24, enabled })]);
    await h.s.tick(t(18, 8));
    enabled = false;
    await h.s.tick(t(18, 8, 30));
    await h.s.tick(t(18, 10)); // o 9h passou desligada
    enabled = true;
    await h.s.tick(t(18, 10, 5));
    expect(h.calls).toEqual([]);
    expect((await h.s.snapshot(KEY))?.history).toEqual([]);
    await h.s.tick(t(19, 9, 0, 10));
    expect(h.calls).toEqual([{ id: 'r1', minute: '2026-11-19T09:00' }]);
  });

  it('editar o "quando roda" recomeça do minuto da edição; editar só a mensagem mantém o que ficou para trás', async () => {
    const hourly = (over: Partial<Routine> = {}) => routine({ schedule: '0 * * * *', catchUpHours: 6, ...over });
    const edited = stateFile();
    await make(edited, () => [hourly()]).s.tick(t(18, 8, 30));
    const moved = make(edited, () => [hourly({ schedule: '30 * * * *' })]);
    await moved.s.tick(t(18, 11, 40)); // o 11:30 do novo horário seria "atrasado", mas a rotina nova não existia antes
    expect(moved.calls).toEqual([]);

    const sameWhen = stateFile();
    await make(sameWhen, () => [hourly()]).s.tick(t(18, 8, 30));
    const reworded = make(sameWhen, () => [hourly({ message: 'Outra mensagem' })]);
    await reworded.s.tick(t(18, 11, 40));
    expect(reworded.calls).toEqual([{ id: 'r1', minute: '2026-11-18T11:00' }]);
  });

  it('`sync` arma na hora (a ocorrência entre a criação e o primeiro tick não se perde) e esquece a rotina apagada', async () => {
    const f = stateFile();
    const rs = [routine({ catchUpHours: 1 })];
    const h = make(f, () => rs);
    await h.s.sync(profile(rs), t(18, 8, 59, 50)); // criada às 8:59:50
    await h.s.tick(t(18, 9, 5)); // o primeiro tick só veio às 9:05
    expect(h.calls).toEqual([{ id: 'r1', minute: '2026-11-18T09:00' }]);
    expect((await h.s.snapshot(KEY))?.history[0]).toMatchObject({ state: 'ran', lateMin: 5 });
    await h.s.sync(profile([]), t(18, 9, 6));
    expect(await h.s.snapshot(KEY)).toBeNull();
  });
});

describe('casos de borda e resultado', () => {
  it('dia 31 em mês curto: a rotina mensal do dia 31 roda no dia 30 de abril', async () => {
    const rec: CalendarRecurrence = { kind: 'monthly', interval: 1, monthDay: 31, time: '09:00', start: '2026-01-31' };
    const f = stateFile();
    const h = make(f, () => [routine({ schedule: '', recurrence: rec })]);
    await h.s.tick(new Date(2026, 3, 29, 8));
    await h.s.tick(new Date(2026, 3, 30, 9, 0, 10));
    await h.s.tick(new Date(2026, 4, 1, 9, 0, 10));
    expect(h.calls).toEqual([{ id: 'r1', minute: '2026-04-30T09:00' }]);
  });

  it('funcionário ocupado (pulada): fica registrada como falha e vira aviso; a ocorrência não é tentada de novo, a seguinte é', async () => {
    const f = stateFile();
    const h = make(f, () => [routine()], { outcome: { ok: false, text: 'pulada: ele estava trabalhando' } });
    await h.s.tick(t(18, 8));
    await h.s.tick(t(18, 9, 0, 10));
    await h.s.tick(t(18, 9, 0, 30));
    expect(h.calls).toHaveLength(1);
    expect((await h.s.snapshot(KEY))?.history[0]).toMatchObject({ state: 'failed', text: 'pulada: ele estava trabalhando' });
    expect(h.s.alerts()).toEqual([expect.objectContaining({ text: 'pulada: ele estava trabalhando' })]);
    await h.s.tick(t(19, 9, 0, 10));
    expect(h.calls).toHaveLength(2);
  });

  it('o histórico guarda só as mais recentes (teto) e a tela o recebe do mais novo ao mais antigo', async () => {
    const f = stateFile();
    const h = make(f, () => [routine({ schedule: '0 * * * *' })]);
    const start = t(18, 8, 0, 10).getTime();
    for (let i = 0; i < ROUTINE_HISTORY_MAX + 10; i++) await h.s.tick(new Date(start + i * 3_600_000));
    const history = (await h.s.snapshot(KEY))!.history;
    expect(history).toHaveLength(ROUTINE_HISTORY_MAX);
    expect(history[0]!.due).toBe(new Date(start - 10_000 + (ROUTINE_HISTORY_MAX + 9) * 3_600_000).toISOString());
    expect(history.at(-1)!.due < history[0]!.due).toBe(true);
  });

  it('rotina com recorrência inválida (ficha editada à mão) é ignorada, sem derrubar as outras', async () => {
    const f = stateFile();
    const h = make(f, () => [routine({ id: 'ruim', schedule: '99 99 * * *' }), routine({ id: 'boa' })]);
    await h.s.tick(t(18, 9, 0, 10));
    expect(h.calls.map((c) => c.id)).toEqual(['boa']);
  });
});
