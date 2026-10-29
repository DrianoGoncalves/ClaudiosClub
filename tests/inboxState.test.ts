import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboxState } from '../server/inboxState';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-inbox-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('o que a caixa lembra entre reinícios', () => {
  it('perguntas e "não é segredo" voltam depois de reabrir', async () => {
    const file = path.join(root, 'inbox.json');
    const a = new InboxState(file);
    a.setQuestion('s1', { text: 'Faço o commit?', at: '2026-10-28T21:28:38Z' });
    a.setQuestion('s2', { text: 'E o deploy?', at: '2026-10-28T21:30:00Z' });
    a.setQuestion('s2', null);
    a.mute('s1:um token do GitHub');
    a.mute('s1:um token do GitHub');
    await a.flush();

    const b = new InboxState(file);
    expect(b.questions()).toEqual([{ sessionId: 's1', text: 'Faço o commit?', at: '2026-10-28T21:28:38Z' }]);
    expect(b.isMuted('s1:um token do GitHub')).toBe(true);
    expect(b.isMuted('s1:uma senha')).toBe(false);
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
