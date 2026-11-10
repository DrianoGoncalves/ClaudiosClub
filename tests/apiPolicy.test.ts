import { describe, expect, it } from 'vitest';
import { staffMayPost } from '../server/apiPolicy';

describe('POST de funcionário pela API (lista fechada)', () => {
  it('libera só o que a ficha manda usar', () => {
    for (const p of [
      '/api/projects/p1/tasks',
      '/api/projects/p1/staff',
      '/api/projects/p1/chat/send',
      '/api/projects/p1/chat/s-1/wake',
      '/api/projects/p1/chat/s-1/wake/cancel',
      '/api/projects/p1/staff/ana-1a2b/done',
    ]) {
      expect(staffMayPost(p), p).toBe(true);
    }
  });

  it('o resto é só pelo navegador: permissão, config, arquivar, login, parar, compactar, apagar arquivo…', () => {
    for (const p of [
      '/api/chat/s-1/permission',
      '/api/config',
      '/api/archive',
      '/api/auth/login',
      '/api/codex/install',
      '/api/codex/login',
      '/api/chat/s-1/interrupt',
      '/api/chat/s-1/stop',
      '/api/chat/s-1/stop-task',
      '/api/projects/p1/chat/s-1/compact',
      '/api/projects/p1/chat/s-1/wake/user-cancel',
      '/api/projects/p1/files/delete',
      '/api/projects/p1/files/write',
      '/api/projects/p1/staff/ana-1a2b/keep',
      '/api/projects/p1/staff/ana-1a2b',
      '/api/projects/p1/tasks/t1/start',
      '/api/server/restart',
      '/api/rota-nova',
      // Sem truque de prefixo ou sufixo.
      '/api/projects/p1/tasks/',
      '/api/projects/p1/tasks/../config',
      '/x/api/projects/p1/tasks',
    ]) {
      expect(staffMayPost(p), p).toBe(false);
    }
  });
});
