import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMORY_PRESSURE_IDLE_MS, pickIdleForMemory, type ReapCandidate } from '../server/chat/memoryPressure';

// Falta memória: a conversa parada há mais tempo fecha sem esperar os 15 min. Em 25/11/2026, 7 conversas abertas (4 paradas) numa máquina de 8 GB faziam o
// Windows paginar sem parar.

const NOW = 1_800_000_000_000;
const chat = (sessionId: string, idleMin: number, o: Partial<ReapCandidate> = {}): ReapCandidate => ({ sessionId, running: true, working: false, lastActivity: NOW - idleMin * 60_000, ...o });

describe('pickIdleForMemory', () => {
  it('fecha a parada há mais tempo', () => {
    expect(pickIdleForMemory([chat('a', 5), chat('b', 12), chat('c', 3)], NOW)?.sessionId).toBe('b');
  });

  it('nunca a que trabalha (turno, pergunta ou permissão pendente, tarefa em segundo plano) nem a que já fechou', () => {
    expect(pickIdleForMemory([chat('a', 30, { working: true }), chat('b', 20, { running: false }), chat('c', 4)], NOW)?.sessionId).toBe('c');
    expect(pickIdleForMemory([chat('a', 30, { working: true })], NOW)).toBeNull();
  });

  it('a que acabou de responder fica (o dono pode estar lendo): só fecha parada há mais de 2 min', () => {
    expect(MEMORY_PRESSURE_IDLE_MS).toBe(2 * 60_000);
    expect(pickIdleForMemory([chat('a', 1), chat('b', 1.9)], NOW)).toBeNull();
    expect(pickIdleForMemory([chat('a', 1), chat('b', 2.1)], NOW)?.sessionId).toBe('b');
  });
});

describe('ligação no servidor', () => {
  it('a rodada do reap (a cada minuto) também fecha por memória, uma conversa por vez, com o mínimo da config', async () => {
    const manager = await fs.readFile(path.join(__dirname, '..', 'server', 'chat', 'manager.ts'), 'utf8');
    const reap = manager.slice(manager.indexOf('private reap()'), manager.indexOf('private reapingMemory'));
    expect(reap).toContain('void this.reapForMemory();');
    const fn = manager.slice(manager.indexOf('private async reapForMemory()'));
    expect(fn).toContain('if (!m || m.freeBytes >= m.minBytes) return;');
    expect(fn).toContain('const victim = pickIdleForMemory(this.chats.values(), now);');
    expect((fn.slice(0, fn.indexOf('finally')).match(/\.stop\(\)/g) ?? []).length).toBe(1);
    const index = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(index).toContain('c.resourceGate && c.minFreeRamGb > 0 ? { freeBytes: os.freemem(), minBytes: c.minFreeRamGb * 1024 ** 3 } : null');
  });
});
