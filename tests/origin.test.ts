import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../server/callers';
import { hasStaffNotice, STAFF_NOTICE } from '../server/chat/items';
import { ChatManager } from '../server/chat/manager';
import { type OriginDeps, staffOrigin, staffOriginNotice } from '../server/chat/origin';
import type { StaffProfile } from '../shared/model';

// O carimbo de quem mandou (outro funcionário): sai do token de quem chama, nunca do corpo do pedido.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-origin-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const tupac = { id: 'tupac-91e7', name: 'Tupac', role: 'Analista de segurança (AppSec)', engine: 'claude' } as StaffProfile;
const cris = { id: 'cris-1', name: 'Cris', role: 'Revisora', engine: 'codex' } as StaffProfile;
const people: Record<string, StaffProfile> = { 'tupac-91e7': tupac, 'cris-1': cris };

const deps = (over: Partial<OriginDeps> = {}): OriginDeps => ({
  projectPath: async (id) => (id === 'p1' ? '/projeto' : null),
  readProfile: async (_dir, id) => people[id] ?? null,
  taskOfWork: async () => null,
  mycoUrl: 'http://127.0.0.1:4848',
  codexUrl: 'http://127.0.0.2:4848',
  ...over,
});

const caller = (over: Partial<Caller> = {}): Caller => ({ staffId: 'tupac-91e7', projectId: 'p1', sessionId: 's-tupac', engine: 'claude', sandbox: false, ...over });

const UNVERIFIED = `${STAFF_NOTICE} (origem não verificada)`;

describe('carimbo de quem mandou', () => {
  it('traz nome, cargo, id, a tarefa e como responder, com a conversa e a API do destinatário', async () => {
    const text = await staffOrigin(deps({ taskOfWork: async () => ({ id: 't-704fe9', title: 'Login' }) }), 'p1', caller(), 'tupac-91e7');
    expect(text).toBe(
      `${STAFF_NOTICE} Quem mandou: Tupac (Analista de segurança (AppSec), id tupac-91e7), da tarefa t-704fe9 “Login”, na conversa s-tupac. ` +
        'Para responder: POST http://127.0.0.1:4848/api/projects/p1/chat/send com os cabeçalhos `x-myco: 1` e `x-myco-token: $MYCO_TOKEN` ' +
        'e o JSON `{"sessionId":"s-tupac","staffId":"tupac-91e7","text":"..."}`.',
    );
  });

  it('sem tarefa na conversa do remetente: não fala de tarefa', async () => {
    const text = await staffOrigin(deps(), 'p1', caller(), 'tupac-91e7');
    expect(text).toContain('Quem mandou: Tupac (Analista de segurança (AppSec), id tupac-91e7), na conversa s-tupac. Para responder:');
    expect(text).not.toContain('tarefa');
  });

  it('destinatário no Codex: a resposta vai pelo endereço da sandbox', async () => {
    const text = await staffOrigin(deps(), 'p1', caller(), 'cris-1');
    expect(text).toContain('POST http://127.0.0.2:4848/api/projects/p1/chat/send');
  });

  it('sem token: a marca genérica, dizendo que a origem não foi verificada', async () => {
    expect(await staffOrigin(deps(), 'p1', null, 'tupac-91e7')).toBe(UNVERIFIED);
  });

  it('token de outro projeto, ou de conversa sem ficha: também não verificada (sem nome)', async () => {
    expect(await staffOrigin(deps(), 'p1', caller({ projectId: 'outro' }), 'tupac-91e7')).toBe(UNVERIFIED);
    expect(await staffOrigin(deps(), 'p1', caller({ staffId: null }), 'tupac-91e7')).toBe(UNVERIFIED);
  });

  it('ficha do remetente que não existe no projeto: não verificada', async () => {
    expect(await staffOrigin(deps({ readProfile: async () => null }), 'p1', caller(), 'tupac-91e7')).toBe(UNVERIFIED);
  });

  it('as duas formas são reconhecidas como marca de outro funcionário (histórico e rollout usam o começo)', () => {
    const block = (text: string) => [{ type: 'text', text }];
    expect(hasStaffNotice(block(STAFF_NOTICE))).toBe(true);
    expect(hasStaffNotice(block(UNVERIFIED))).toBe(true);
    expect(hasStaffNotice(block(staffOriginNotice({ name: 'Tupac', role: 'AppSec', staffId: 'tupac-91e7', sessionId: 's-tupac', task: null, api: 'http://x' })))).toBe(true);
    expect(hasStaffNotice(block('[MyCo] Folga de cota'))).toBe(false);
  });
});

describe('o carimbo chega à conversa do destinatário', () => {
  it('mensagem de outro funcionário leva o carimbo como bloco próprio; sem carimbo, a marca genérica', async () => {
    const dir = path.join(root, 'manager');
    await fs.mkdir(dir, { recursive: true });
    const procs: string[][] = [];
    const chats = new ChatManager({
      transcriptsDir: dir,
      usageFile: path.join(dir, 'usage.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => ({ sessionId: sid ?? 's-novo', cwd: '.', args: [] }),
      spawnImpl: () => {
        const stdin = new PassThrough();
        const written: string[] = [];
        stdin.on('data', (c) => written.push(String(c)));
        procs.push(written);
        return Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough(), pid: 7000 + procs.length, kill: () => {} }) as never;
      },
    });
    const origin = `${STAFF_NOTICE} Quem mandou: Tupac (Analista de segurança (AppSec), id tupac-91e7), na conversa s-tupac.`;
    await chats.send('p1', 's-dest-1', null, 'Revise o PR 12', 'next', [], [], true, origin);
    await chats.send('p1', 's-dest-2', null, 'Oi', 'next', [], [], true);
    await new Promise((r) => setTimeout(r, 30));

    const userBlocks = (lines: string[]) =>
      lines
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((m) => m.type === 'user')
        .at(-1)!.message.content.map((b: { text: string }) => b.text);
    expect(userBlocks(procs[0]!)).toEqual([origin, 'Revise o PR 12']);
    expect(userBlocks(procs[1]!)).toEqual([STAFF_NOTICE, 'Oi']);
  });
});
