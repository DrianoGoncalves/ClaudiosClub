import { describe, expect, it } from 'vitest';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';

describe('POST de funcionário pela API (lista fechada)', () => {
  it('libera só o que a ficha manda usar', () => {
    for (const p of [
      '/api/projects/p1/tasks',
      '/api/projects/p1/staff',
      '/api/projects/p1/chat/send',
      '/api/projects/p1/chat/s-1/wake',
      '/api/projects/p1/chat/s-1/wake/cancel',
      '/api/projects/p1/staff/ana-1a2b/done',
      '/api/projects/p1/tasks/t-1a2b3c/cancel',
      // Pedido de cancelamento (quem pediu a tarefa) e a recusa dele (o responsável): a rota exige o token e confere quem é.
      '/api/projects/p1/tasks/t-1a2b3c/cancel-request',
      '/api/projects/p1/tasks/t-1a2b3c/cancel-request/refuse',
      // Editar tarefa que ainda não começou (a rota exige o token e confere quem pediu e a coluna).
      '/api/projects/p1/tasks/t-1a2b3c',
    ]) {
      expect(staffMayPost(p), p).toBe(true);
    }
  });

  it('o resto é só pelo navegador: permissão, config, arquivar, login, parar, compactar, apagar arquivo…', () => {
    for (const p of [
      '/api/chat/s-1/permission',
      '/api/config',
      '/api/archive',
      '/api/conversation-title',
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
      // Reabrir e as ações de quem espera uma cancelada são só da tela; cancelar só vale na própria tarefa (a rota confere o token).
      '/api/projects/p1/tasks/t1/reopen',
      '/api/projects/p1/tasks/t1/blocker',
      '/api/projects/p1/tasks/t1/cancel/extra',
      '/api/projects/p1/tasks/t1/cancel-request/extra',
      '/api/projects/p1/tasks/t1/cancel-request/accept',
      '/api/projects/p1/tasks/t1/edit',
      '/api/projects/p1/tasks/t1/delete',
      '/api/projects/p1/tasks/t1/answer/extra',
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

describe('sandbox do Codex: editar tarefa que ainda não começou', () => {
  it('passa no projeto da própria conversa; em outro projeto, 403', () => {
    expect(sandboxVerdict('POST', '/api/projects/p1/tasks/t-1', 'p1')).toBeNull();
    expect(sandboxVerdict('POST', '/api/projects/p2/tasks/t-1', 'p1')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('GET', '/api/projects/p1/tasks/t-1', 'p1')).toMatchObject({ status: 403 });
  });
});

describe('sandbox do Codex: cancelar a própria tarefa', () => {
  it('só a rota de cancelar passa, no projeto da própria conversa; reabrir e as ações de dependentes não', () => {
    expect(sandboxVerdict('POST', '/api/projects/p1/tasks/t-1/cancel', 'p1')).toBeNull();
    expect(sandboxVerdict('POST', '/api/projects/p2/tasks/t-1/cancel', 'p1')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('POST', '/api/projects/p1/tasks/t-1/reopen', 'p1')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('POST', '/api/projects/p1/tasks/t-1/blocker', 'p1')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('POST', '/api/projects/p1/tasks/t-1/delete', 'p1')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('GET', '/api/projects/p1/tasks/t-1/cancel', 'p1')).toMatchObject({ status: 403 });
  });

  it('o pedido de cancelamento e a recusa passam no projeto da própria conversa; em outro projeto ou por GET, 403', () => {
    for (const route of ['cancel-request', 'cancel-request/refuse']) {
      expect(sandboxVerdict('POST', `/api/projects/p1/tasks/t-1/${route}`, 'p1'), route).toBeNull();
      expect(sandboxVerdict('POST', `/api/projects/p2/tasks/t-1/${route}`, 'p1'), route).toMatchObject({ status: 403 });
      expect(sandboxVerdict('GET', `/api/projects/p1/tasks/t-1/${route}`, 'p1'), route).toMatchObject({ status: 403 });
    }
  });
});
