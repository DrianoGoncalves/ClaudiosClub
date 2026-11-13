import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readProjectSessions } from '../server/adapters/claude/sessions';
import { rolloutUpdatedAt } from '../server/adapters/codex/rollout';
import type { ToolAdapter } from '../server/adapters/types';
import { ConfigPatch, readConfig, RetentionError, updateConfig } from '../server/config';
import { retainedSessionIds } from '../server/retention';
import { attachThreadId, getRegisteredSession, readSessionRegistry, recordSession, RegistryInputError, RegistryReadError } from '../server/sessionsRegistry';
import { StaffService } from '../server/staff/service';
import type { AccountUsage, LiveSession, Project, StaffProfile, Task } from '../shared/model';

// Lê o que o `readProjectSessions` lê de cada transcript: o teste prova que as conversas antigas não chegam a ser lidas.
const probe = vi.hoisted(() => ({ reads: [] as string[] }));
vi.mock('../server/adapters/claude/fsutil', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/adapters/claude/fsutil')>();
  return {
    ...real,
    readHeadTail: (file: string, bytes?: number) => {
      probe.reads.push(file);
      return real.readHeadTail(file, bytes);
    },
  };
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-13T12:00:00.000Z');
/** Id de conversa no formato do Club (UUID). */
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let root: string;
let n = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-retention-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
/** Pasta nova e única por teste. */
const fresh = (name: string) => path.join(root, `${name}-${n++}`);

describe('config: retenção (arquivar e apagar)', () => {
  it('padrão: arquivar em 7 dias, apagar em 30, exclusão nunca ligada', async () => {
    const c = await readConfig(path.join(fresh('cfg'), 'config.json'));
    expect(c).toMatchObject({ archiveAfterDays: 7, deleteAfterDays: 30, retentionDeleteEnabledAt: null });
  });

  it('o patch aceita inteiros de 0 a 365; o registro de exclusão não entra pelo patch genérico', () => {
    for (const ok of [0, 1, 7, 365]) {
      expect(ConfigPatch.safeParse({ archiveAfterDays: ok }).success, `archive ${ok}`).toBe(true);
      expect(ConfigPatch.safeParse({ deleteAfterDays: ok }).success, `delete ${ok}`).toBe(true);
    }
    for (const bad of [-1, 366, 1.5, '7', null]) {
      expect(ConfigPatch.safeParse({ archiveAfterDays: bad }).success, `archive ${String(bad)}`).toBe(false);
      expect(ConfigPatch.safeParse({ deleteAfterDays: bad }).success, `delete ${String(bad)}`).toBe(false);
    }
    expect(ConfigPatch.parse({ retentionDeleteEnabledAt: '2026-11-13T00:00:00.000Z' })).not.toHaveProperty('retentionDeleteEnabledAt');
  });

  it('exclusão tem de passar do arquivamento (quando os dois estão ligados): recusa, e não grava nada', async () => {
    const file = path.join(fresh('cfg-par'), 'config.json');
    await expect(updateConfig({ archiveAfterDays: 7, deleteAfterDays: 7 }, file)).rejects.toBeInstanceOf(RetentionError);
    // Só um dos dois no patch: confere com o outro como está (o padrão de arquivar é 7).
    await expect(updateConfig({ deleteAfterDays: 5 }, file)).rejects.toThrow('apagar depois de arquivar');
    await expect(fs.access(file)).rejects.toThrow(); // o arquivo nem foi criado
    expect((await readConfig(file)).deleteAfterDays).toBe(30);
  });

  it('0 desliga: com um deles em 0, não há par para conferir; a mudança que fecha o par é aceita', async () => {
    const file = path.join(fresh('cfg-zero'), 'config.json');
    expect(await updateConfig({ archiveAfterDays: 0, deleteAfterDays: 5 }, file)).toMatchObject({ archiveAfterDays: 0, deleteAfterDays: 5 });
    expect(await updateConfig({ archiveAfterDays: 40, deleteAfterDays: 0 }, file)).toMatchObject({ archiveAfterDays: 40, deleteAfterDays: 0 });
    expect(await updateConfig({ archiveAfterDays: 14, deleteAfterDays: 60 }, file)).toMatchObject({ archiveAfterDays: 14, deleteAfterDays: 60 });
  });

  it('o par é conferido com o valor gravado: arquivar que passa da exclusão gravada é recusado e o gravado fica', async () => {
    const file = path.join(fresh('cfg-grav'), 'config.json');
    await updateConfig({ deleteAfterDays: 30 }, file); // arquivar segue 7
    await expect(updateConfig({ archiveAfterDays: 30 }, file)).rejects.toBeInstanceOf(RetentionError);
    expect(await readConfig(file)).toMatchObject({ archiveAfterDays: 7, deleteAfterDays: 30 });
  });

  it('config editado à mão com o par que não fecha volta aos dois padrões', async () => {
    const file = path.join(fresh('cfg-sujo'), 'config.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ archiveAfterDays: 10, deleteAfterDays: 5, retentionDeleteEnabledAt: 'não é data' }));
    expect(await readConfig(file)).toMatchObject({ archiveAfterDays: 7, deleteAfterDays: 30, retentionDeleteEnabledAt: null });
  });
});

describe('registro das conversas do Club (sessions-registry.json)', () => {
  it('grava, lê (com o cwd real), mantém createdAt e a ficha ao reabrir, e anota o thread_id só de conversa registrada', async () => {
    const reg = path.join(fresh('reg'), 'sessions-registry.json');
    await recordSession({ sessionId: uid(1), engine: 'claude', projectPath: '/proj', cwd: '/wt', staffId: 'ana', at: new Date('2026-11-01T10:00:00Z') }, reg);
    await recordSession({ sessionId: uid(2), engine: 'codex', projectPath: '/proj', cwd: '/proj', staffId: 'bia', at: new Date('2026-11-02T10:00:00Z') }, reg);
    expect(await getRegisteredSession(uid(1), reg)).toEqual({ engine: 'claude', projectPath: '/proj', cwd: '/wt', staffId: 'ana', createdAt: '2026-11-01T10:00:00.000Z' });

    await attachThreadId(uid(2), 'thr-1', reg);
    await attachThreadId(uid(99), 'thr-x', reg); // não cria entrada
    expect([...(await readSessionRegistry(reg)).keys()].sort()).toEqual([uid(1), uid(2)].sort());
    expect(await getRegisteredSession(uid(2), reg)).toMatchObject({ threadId: 'thr-1', createdAt: '2026-11-02T10:00:00.000Z' });

    // Reabrir (regravar) não troca a data de lançamento nem apaga a ficha.
    await recordSession({ sessionId: uid(1), engine: 'claude', projectPath: '/proj', cwd: '/wt', at: new Date('2026-11-13T00:00:00Z') }, reg);
    expect(await getRegisteredSession(uid(1), reg)).toMatchObject({ staffId: 'ana', createdAt: '2026-11-01T10:00:00.000Z' });
    expect(await getRegisteredSession(uid(3), reg)).toBeNull();
  });

  it('arquivo ausente lê vazio; entrada fora do formato some; JSON inválido NÃO é regravado', async () => {
    const reg = path.join(fresh('reg-sujo'), 'sessions-registry.json');
    expect((await readSessionRegistry(reg)).size).toBe(0); // ENOENT = registro vazio

    await recordSession({ sessionId: uid(4), engine: 'claude', projectPath: '/p', cwd: '/p' }, reg);
    expect((await getRegisteredSession(uid(4), reg))).not.toHaveProperty('staffId');

    const sessions: Record<string, unknown> = {
      [uid(5)]: { engine: 'codex', projectPath: '/p', cwd: '/p', createdAt: '2026-11-01T00:00:00.000Z' },
      [uid(6)]: { engine: 'outro', projectPath: '/p', cwd: '/p', createdAt: '2026-11-01T00:00:00.000Z' }, // motor inválido
      [uid(7)]: { engine: 'claude', projectPath: '/p', createdAt: '2026-11-01T00:00:00.000Z' }, // sem cwd
      'nao-e-uuid': { engine: 'claude', projectPath: '/p', cwd: '/p', createdAt: '2026-11-01T00:00:00.000Z' },
      [uid(8)]: { engine: 'codex', projectPath: '/p', cwd: '/p', threadId: 'com espaço', createdAt: '2026-11-01T00:00:00.000Z' }, // thread inválido: some o thread, a entrada fica
    };
    // Chave `__proto__` como chave própria (não como protótipo): tem de ser ignorada, sem mexer no protótipo.
    Object.defineProperty(sessions, '__proto__', { value: { engine: 'claude', projectPath: '/p', cwd: '/p', createdAt: '2026-11-01T00:00:00.000Z' }, enumerable: true });
    await fs.writeFile(reg, JSON.stringify({ sessions }));
    const kept = await readSessionRegistry(reg);
    expect([...kept.keys()]).toEqual([uid(5), uid(8)]);
    expect(kept.get(uid(8))?.threadId).toBeUndefined();

    // Arquivo que existe e não lê: lança erro, não grava, e o conteúdo fica como estava.
    await fs.writeFile(reg, '{ isto não é json');
    await expect(readSessionRegistry(reg)).rejects.toBeInstanceOf(RegistryReadError);
    await expect(recordSession({ sessionId: uid(9), engine: 'claude', projectPath: '/p', cwd: '/p' }, reg)).rejects.toBeInstanceOf(RegistryReadError);
    await expect(attachThreadId(uid(4), 'thr-2', reg)).rejects.toBeInstanceOf(RegistryReadError);
    expect(await fs.readFile(reg, 'utf8')).toBe('{ isto não é json');
  });

  it('id de conversa e thread_id fora do formato: recusa e não grava', async () => {
    const reg = path.join(fresh('reg-id'), 'sessions-registry.json');
    await expect(recordSession({ sessionId: '../fora', engine: 'claude', projectPath: '/p', cwd: '/p' }, reg)).rejects.toBeInstanceOf(RegistryInputError);
    await expect(recordSession({ sessionId: uid(1), engine: 'claude', projectPath: '/p', cwd: '/p', threadId: 'com espaço' }, reg)).rejects.toBeInstanceOf(RegistryInputError);
    await expect(attachThreadId('nao-uuid', 'thr', reg)).rejects.toBeInstanceOf(RegistryInputError);
    await expect(fs.access(reg)).rejects.toThrow();
  });

  it('gravações ao mesmo tempo não se perdem', async () => {
    const reg = path.join(fresh('reg-conc'), 'sessions-registry.json');
    await Promise.all(Array.from({ length: 12 }, (_, i) => recordSession({ sessionId: uid(100 + i), engine: 'claude', projectPath: '/p', cwd: '/p' }, reg)));
    expect((await readSessionRegistry(reg)).size).toBe(12);
  });

  it('Codex parado 10 dias, sem run/ (cleanRunDir levou o codex-thread.json): o rollout é achado pelo threadId do registro', async () => {
    const home = path.join(fresh('codex-home'));
    const reg = path.join(fresh('codex-reg'), 'sessions-registry.json');
    const threadId = 'thr-sem-run-10d';
    const day = path.join(home, 'sessions', '2026', '11', '03');
    await fs.mkdir(day, { recursive: true });
    const rollout = path.join(day, `rollout-2026-11-03T10-00-00-${threadId}.jsonl`);
    await fs.writeFile(rollout, '{}\n');
    const old = new Date(Date.now() - 10 * DAY);
    await fs.utimes(rollout, old, old);

    await recordSession({ sessionId: uid(200), engine: 'codex', projectPath: '/p', cwd: '/p', staffId: 'bia' }, reg);
    await attachThreadId(uid(200), threadId, reg);
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const runGone = path.join(root, 'run-que-nao-existe');
      const at = await rolloutUpdatedAt(runGone, uid(200), reg);
      expect(at).not.toBeNull();
      expect(at!.getTime()).toBeLessThan(Date.now() - 7 * DAY); // parada além do arquivamento: some da lista
      // Sem o registro, não há como achar o rollout: null, e a conversa segue como antes.
      expect(await rolloutUpdatedAt(runGone, uid(201), reg)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });
});

describe('listagem: conversa antiga sai sem ser lida', () => {
  /** Transcript com a atividade `ageDays` atrás; `subAgeDays` põe um subagent com outra data na pasta `<id>/subagents`. */
  async function transcript(dir: string, id: string, ageDays: number, subAgeDays?: number) {
    const at = (days: number) => new Date(NOW - days * DAY);
    const file = path.join(dir, `${id}.jsonl`);
    await fs.writeFile(file, JSON.stringify({ type: 'user', message: { content: `Assunto de ${id}` }, timestamp: '2026-01-01T00:00:00Z' }) + '\n');
    await fs.utimes(file, at(ageDays), at(ageDays));
    if (subAgeDays !== undefined) {
      const sub = path.join(dir, id, 'subagents');
      await fs.mkdir(sub, { recursive: true });
      const sf = path.join(sub, 'agent-1.jsonl');
      await fs.writeFile(sf, '{}\n');
      await fs.utimes(sf, at(subAgeDays), at(subAgeDays));
      await fs.utimes(sub, at(subAgeDays), at(subAgeDays));
    }
  }

  it('com archiveAfterDays, as antigas saem sem leitura; ao vivo, protegida e atividade recente em subagent ficam; includeOld traz tudo', async () => {
    const dir = fresh('proj');
    await fs.mkdir(dir, { recursive: true });
    await transcript(dir, 'nova', 1);
    await transcript(dir, 'velha', 30);
    await transcript(dir, 'viva', 30);
    await transcript(dir, 'morta', 30); // entrada de processo morto não protege
    await transcript(dir, 'protegida', 30); // última de ficha / tarefa não concluída
    await transcript(dir, 'velha-com-subagente', 30, 0.5);
    await transcript(dir, 'velha-subagente-antiga', 30, 20);
    const live = new Map([
      ['viva', { sessionId: 'viva', alive: true } as unknown as LiveSession],
      ['morta', { sessionId: 'morta', alive: false } as unknown as LiveSession],
    ]);
    const keep = new Set(['protegida']);

    probe.reads.length = 0;
    const shown = await readProjectSessions(dir, live, { archiveAfterDays: 7, keep, now: NOW });
    expect(shown.map((s) => s.id).sort()).toEqual(['nova', 'protegida', 'velha-com-subagente', 'viva']);
    expect(probe.reads.map((f) => path.basename(f)).sort()).toEqual(['nova.jsonl', 'protegida.jsonl', 'velha-com-subagente.jsonl', 'viva.jsonl']);

    expect(await readProjectSessions(dir, live, { archiveAfterDays: 7, includeOld: true, now: NOW })).toHaveLength(7);
    expect(await readProjectSessions(dir, live, { archiveAfterDays: 0, now: NOW })).toHaveLength(7);
    expect(await readProjectSessions(dir, live, { now: NOW })).toHaveLength(7);
  });

  it('a retenção nunca arquiva a última sessão de cada ficha nem as de tarefa não concluída', () => {
    const staff = [
      { sessions: [{ id: 'antiga' }, { id: 'ultima' }] },
      { sessions: [] },
    ] as unknown as Array<Pick<StaffProfile, 'sessions'>>;
    const tasks = [
      { status: 'doing', sessionId: 't-execucao', review: null, deploy: null, question: undefined },
      { status: 'done', sessionId: 't-feita', review: null, deploy: null, question: undefined },
      { status: 'review', sessionId: null, review: { sessionId: 'r-revisao' }, deploy: null, question: undefined },
      { status: 'waiting', sessionId: null, review: null, deploy: { sessionId: 'd-deploy' }, question: { managerSession: 'g-gestor' } },
    ] as unknown as Task[];
    expect([...retainedSessionIds(staff, tasks)].sort()).toEqual(['g-gestor', 'd-deploy', 'r-revisao', 't-execucao', 'ultima'].sort());
  });
});

describe('registro pelo lançamento (chatSpawn)', () => {
  it('ficha, avulsa e Codex entram no registro (com a pasta real); reabrir não; o thread_id do Codex vai junto', async () => {
    const dir = fresh('club');
    const projectPath = path.join(dir, 'proj');
    await fs.mkdir(projectPath, { recursive: true });
    const reg = path.join(dir, 'sessions-registry.json');
    const project = { id: 'proj-id', path: projectPath, name: 'proj', exists: true, worktreeOf: null, hasClaudeMd: false, agentCount: 0, skillCount: 0, sessionCount: 0, lastActivityAt: null } as Project;
    const noUsage = async (): Promise<AccountUsage> => ({ tapInstalled: true, limits: [], updatedAt: null });
    const svc = new StaffService({ listProjects: async () => [project] } as unknown as ToolAdapter, {
      runDir: path.join(dir, 'run'),
      claudeConfigFile: path.join(dir, 'claude.json'),
      mycoUrl: 'http://127.0.0.1:4848',
      readUsage: noUsage,
      codexEnabled: async () => true,
      sessionsFile: reg,
    });
    const base = { role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', launch: false };
    const ana = (await svc.hire('proj-id', { ...base, name: 'Ana' }, true))!.profile;
    const bia = (await svc.hire('proj-id', { ...base, name: 'Bia', engine: 'codex', model: 'gpt-6-sol' }, true))!.profile;

    const ficha = (await svc.chatSpawn('proj-id', null, ana.id))!;
    const avulsa = (await svc.chatSpawn('proj-id', null, null))!;
    const codex = (await svc.chatSpawn('proj-id', null, bia.id))!;
    const all = await readSessionRegistry(reg);
    expect(all.get(ficha.sessionId)).toMatchObject({ engine: 'claude', staffId: ana.id, projectPath, cwd: ficha.cwd });
    expect(all.get(avulsa.sessionId)).toMatchObject({ engine: 'claude', projectPath, cwd: projectPath });
    expect(all.get(avulsa.sessionId)).not.toHaveProperty('staffId');
    expect(all.get(codex.sessionId)).toMatchObject({ engine: 'codex', staffId: bia.id });
    expect(all.size).toBe(3);

    // Reabrir a conversa da ficha não lança outra: continua 3.
    await svc.chatSpawn('proj-id', ficha.sessionId, ana.id);
    expect((await readSessionRegistry(reg)).size).toBe(3);

    // O Codex dá o thread_id (o callback do processo): vai para o registro.
    codex.codex!.onThread!('019e-thread-1');
    await vi.waitFor(async () => expect((await getRegisteredSession(codex.sessionId, reg))?.threadId).toBe('019e-thread-1'));
  });
});
