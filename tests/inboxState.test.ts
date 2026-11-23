import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboxState } from '../server/inboxState';
import { removeTemp } from './support/tmp';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-inbox-'));
});
afterAll(() => removeTemp(root));

describe('o que a caixa lembra entre reinícios', () => {
  it('perguntas e "não é segredo" voltam depois de reabrir', async () => {
    const file = path.join(root, 'inbox.json');
    const a = new InboxState(file);
    a.setQuestion('s1', { text: 'Faço o commit?', at: '2026-10-28T21:28:38Z', itemId: 'a:m1' });
    a.setQuestion('s2', { text: 'E o deploy?', at: '2026-10-28T21:30:00Z' });
    a.setQuestion('s2', null);
    a.mute('s1:um token do GitHub');
    a.mute('s1:um token do GitHub');
    await a.flush();

    const b = new InboxState(file);
    expect(b.questions()).toEqual([{ sessionId: 's1', text: 'Faço o commit?', at: '2026-10-28T21:28:38Z', itemId: 'a:m1' }]);
    expect(b.isMuted('s1:um token do GitHub')).toBe(true);
    expect(b.isMuted('s1:uma senha')).toBe(false);
  });

  it('o sal da instalação (identidade da ocorrência do segredo) nasce uma vez e sobrevive a reabrir; valor estranho no arquivo é refeito', async () => {
    const file = path.join(root, 'inbox-sal.json');
    const a = new InboxState(file);
    const sal = a.pepper();
    expect(sal).toMatch(/^[0-9a-f]{32}$/);
    expect(a.pepper()).toBe(sal);
    await a.flush();
    expect(new InboxState(file).pepper()).toBe(sal);

    const ruim = path.join(root, 'inbox-sal-ruim.json');
    await fs.writeFile(ruim, JSON.stringify({ muted: ['s1:x#abc'], pepper: 'não é hex' }));
    const b = new InboxState(ruim);
    expect(b.isMuted('s1:x#abc')).toBe(true);
    expect(b.pepper()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('"dispensar" numa sessão esperando você em outro lugar: some até o status mudar, e sobrevive a reabrir', async () => {
    const file = path.join(root, 'inbox-espera.json');
    const a = new InboxState(file);
    expect(a.isWaitingDismissed('w1', '2026-10-29T10:00:00Z')).toBe(false);
    a.dismissWaiting('w1', '2026-10-29T10:00:00Z');
    expect(a.isWaitingDismissed('w1', '2026-10-29T10:00:00Z')).toBe(true);
    // Mudou de status (outro statusUpdatedAt): volta a aparecer na caixa.
    expect(a.isWaitingDismissed('w1', '2026-10-29T10:05:00Z')).toBe(false);
    a.dismissWaiting('w2', null);
    expect(a.isWaitingDismissed('w2', null)).toBe(true);
    await a.flush();

    const b = new InboxState(file);
    expect(b.isWaitingDismissed('w1', '2026-10-29T10:00:00Z')).toBe(true);
    expect(b.isWaitingDismissed('w2', null)).toBe(true);
    expect(b.isWaitingDismissed('w2', '2026-10-29T10:00:00Z')).toBe(false);
  });

  it('a parada por erro do motor (login recusado) volta depois de reabrir; tipo ou campo fora do conhecido é ignorado', async () => {
    const file = path.join(root, 'inbox-motor.json');
    const a = new InboxState(file);
    a.setTurnCap('s1', { kind: 'engine', why: 'auth', engine: 'claude', error: 'Failed to authenticate', at: '2026-11-19T10:00:00.000Z' });
    a.setTurnCap('s2', { kind: 'engine', why: 'error', engine: 'codex', error: 'boom', at: '2026-11-19T10:01:00.000Z' });
    await a.flush();
    const b = new InboxState(file);
    expect(b.turnCapOf('s1')).toMatchObject({ kind: 'engine', why: 'auth', engine: 'claude', error: 'Failed to authenticate' });
    expect(b.turnCaps()).toEqual([expect.objectContaining({ sessionId: 's1', kind: 'engine' }), expect.objectContaining({ sessionId: 's2', kind: 'engine', why: 'error', engine: 'codex' })]);

    const ruim = path.join(root, 'inbox-motor-ruim.json');
    await fs.writeFile(ruim, JSON.stringify({ caps: { s1: { kind: 'engine', why: 'x', engine: 'claude', error: 'e', at: 'a' }, s2: { kind: 'engine', why: 'auth', engine: 'gpt', error: 'e', at: 'a' }, s3: { kind: 'engine', why: 'auth', engine: 'claude', at: 'a' } } }));
    expect(new InboxState(ruim).turnCaps()).toEqual([]);
  });

  it('"ignorar" um alerta de erro: vale só para aquela ocorrência (outro carimbo volta), sobrevive a reabrir, e mensagem nova esquece', async () => {
    const file = path.join(root, 'inbox-erro.json');
    const a = new InboxState(file);
    expect(a.isErrorDismissed('error:s1', '2026-11-16T10:00:00.000Z')).toBe(false);
    a.dismissError('error:s1', '2026-11-16T10:00:00.000Z');
    a.dismissError('cap:s1', '2026-11-16T10:05:00.000Z');
    expect(a.isErrorDismissed('error:s1', '2026-11-16T10:00:00.000Z')).toBe(true);
    expect(a.isErrorDismissed('error:s1', '2026-11-16T10:01:00.000Z')).toBe(false); // outro erro da conversa
    expect(a.isErrorDismissed('error:s2', '2026-11-16T10:00:00.000Z')).toBe(false); // outra conversa
    await a.flush();

    const b = new InboxState(file);
    expect(b.isErrorDismissed('error:s1', '2026-11-16T10:00:00.000Z')).toBe(true);
    expect(b.isErrorDismissed('cap:s1', '2026-11-16T10:05:00.000Z')).toBe(true);
    b.forgetErrors('s1');
    expect(b.isErrorDismissed('error:s1', '2026-11-16T10:00:00.000Z')).toBe(false);
    expect(b.isErrorDismissed('cap:s1', '2026-11-16T10:05:00.000Z')).toBe(false);
    await b.flush();
    expect(new InboxState(file).isErrorDismissed('cap:s1', '2026-11-16T10:05:00.000Z')).toBe(false);

    // Valor estranho no arquivo é ignorado.
    const ruim = path.join(root, 'inbox-erro-ruim.json');
    await fs.writeFile(ruim, JSON.stringify({ errorDismissed: { 'error:s1': 42, 'cap:s1': '2026-11-16T10:05:00.000Z' } }));
    const c = new InboxState(ruim);
    expect(c.isErrorDismissed('error:s1', '42')).toBe(false);
    expect(c.isErrorDismissed('cap:s1', '2026-11-16T10:05:00.000Z')).toBe(true);
  });

  it('arquivo corrompido ou ausente: começa vazio; sem arquivo, só na memória', async () => {
    const bad = path.join(root, 'ruim.json');
    await fs.writeFile(bad, '{ não é json');
    expect(new InboxState(bad).questions()).toEqual([]);
    expect(new InboxState(path.join(root, 'nao-existe.json')).questions()).toEqual([]);
    const mem = new InboxState();
    mem.mute('x');
    expect(mem.isMuted('x')).toBe(true);
  });
});
