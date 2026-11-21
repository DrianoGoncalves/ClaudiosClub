import { describe, expect, it } from 'vitest';
import type { Autonomy, Engine, StaffProfile } from '../shared/model';
import { BUILTIN_ROLES } from '../shared/roles';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { renderFicha, type FichaContext } from '../server/staff/ficha';

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
      // Decidir o plano do card que pediu (t-5a9ef6): a rota exige o token e `decidePlan` confere quem pediu.
      '/api/projects/p1/tasks/t-1a2b3c/plan',
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
      '/api/projects/p1/files/open-editor',
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
      '/api/projects/p1/tasks/t1/plan/extra',
      '/api/projects/p1/tasks/t1/plan/',
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

describe('sandbox do Codex: decidir o plano do card que pediu', () => {
  it('a rota do plano passa no projeto da própria conversa; em outro projeto, por GET ou com sufixo, 403, e a mensagem de recusa a lista', () => {
    expect(sandboxVerdict('POST', '/api/projects/p1/tasks/t-1/plan', 'p1')).toBeNull();
    expect(sandboxVerdict('POST', '/api/projects/p2/tasks/t-1/plan', 'p1')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('GET', '/api/projects/p1/tasks/t-1/plan', 'p1')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('POST', '/api/projects/p1/tasks/t-1/plan/extra', 'p1')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('GET', '/api/projects/p1/tasks/t-1/plan', 'p1')!.error).toContain('decidir o plano do card que você pediu');
  });
});

// Toda rota POST que a ficha manda um funcionário usar tem de estar em `STAFF_POSTS`: a t-bb54bc pôs `tasks/<id>/plan` na ficha e na rota, mas esqueceu a lista, e o gate respondia
// 400 "só pelo Claudio’s Club" ao gestor (t-5a9ef6). Renderiza a ficha de todo cargo pronto, nos dois motores e com/sem contratar, e cruza cada `POST <url do projeto>/…` com `staffMayPost`.
describe('rotas POST citadas na ficha × lista de POST de funcionário', () => {
  const MYCO = 'http://127.0.0.1:4848';
  const API = `${MYCO}/api/projects/p`;
  const person = (engine: Engine, autonomy: Autonomy, canHire: boolean, role: string): StaffProfile =>
    ({
      id: 'gil-1',
      projectId: 'p',
      name: 'Gil',
      role,
      portrait: null,
      reportsTo: [],
      mission: 'Servidor',
      autonomy,
      agents: [],
      skills: [],
      mcps: null,
      knowledge: [],
      rules: [],
      canHire,
      playbook: null,
      worktree: false,
      servers: [],
      browser: false,
      sessions: [],
      engine,
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
    }) as unknown as StaffProfile;
  // As seções com rota (tarefa, editar, cancelar, ordem, plano… e a consulta) só entram para quem tem equipe e vínculo; a outra variante é a ficha sem eles.
  const WITH_ROUTES: Partial<FichaContext> = { team: [{ id: 'ana-1', name: 'Ana', role: 'Front-end', mission: 'Telas.' }], consult: { targets: [{ projectId: 'q', projectName: 'Outro' }] } };
  const ctx = (over: Partial<FichaContext> = {}): FichaContext => ({
    company: 'Acme',
    projectName: 'painel',
    projectPath: 'C:\\www\\painel',
    managerNames: ['Denzel'],
    fichaPath: '.myco\\staff\\gil-1.md',
    memoryPath: '.myco\\staff\\gil-1.memory.md',
    mycoUrl: MYCO,
    roles: BUILTIN_ROLES.map((r) => ({ id: r.id, label: r.label })),
    ...over,
  });

  /** Os caminhos (relativos ao projeto, com `<…>` e `$VAR` trocados por um id) de cada `POST <url do projeto>/…` e `-X POST … <url do projeto>/…` do texto. */
  const postedPaths = (md: string): string[] => {
    const text = md.replace(/<[^<>\n]*>/g, 'x-1').replace(/\$[A-Z_]+/g, 'x-1');
    const found = new Set<string>();
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(/(?:\bPOST|-X POST)\b[^\n]*?(http:\/\/127\.0\.0\.1:4848\/api\/projects\/p[A-Za-z0-9/_-]*)/g)) found.add(m[1]!);
    }
    return [...found];
  };

  it('toda rota POST da ficha (todo cargo pronto, Claude e Codex, com e sem contratar) é de funcionário', () => {
    const fichas: string[] = [];
    for (const engine of ['claude', 'codex'] as const) {
      for (const canHire of [true, false]) {
        for (const autonomy of ['plan', 'acceptEdits', 'auto'] as const) {
          for (const r of BUILTIN_ROLES) for (const extra of [{}, WITH_ROUTES]) fichas.push(renderFicha(person(engine, autonomy, canHire, r.role), ctx(extra)));
        }
      }
    }
    const routes = new Set(fichas.flatMap(postedPaths));
    // Sanidade: o extrator enxerga as rotas conhecidas (senão o teste passaria vazio se a ficha mudasse de forma).
    for (const known of ['/tasks', '/tasks/x-1', '/staff', '/staff/x-1/done', '/chat/send', '/chat/x-1/wake', '/consult', '/tasks/x-1/cancel', '/tasks/x-1/cancel-request', '/tasks/x-1/order', '/tasks/x-1/followup', '/tasks/x-1/review-anyway', '/tasks/x-1/plan']) {
      expect([...routes], known).toContain(`${API}${known}`);
    }
    const fora = [...routes].filter((u) => !staffMayPost(u.slice(MYCO.length)));
    expect(fora, `rotas que a ficha manda usar e o gate recusa (400 "só pelo Claudio’s Club"): ${fora.join(', ')}`).toEqual([]);
  });
});