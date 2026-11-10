import { describe, expect, it } from 'vitest';
import { draftFrom, draftProblem, groupServers, saveBody, targetLabel, type McpServer } from '../client/src/office/mcpForm';

const http: McpServer = {
  name: 'n8n',
  scope: 'user',
  type: 'http',
  url: 'https://n8n.exemplo.com/mcp',
  env: [],
  headers: [
    { key: 'Authorization', set: true },
    { key: 'X-Team', set: true },
  ],
};

const stdio: McpServer = {
  name: 'db',
  scope: 'local',
  projectId: 'p1',
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'server-db'],
  env: [{ key: 'DB_URL', set: true }],
  headers: [],
  argsMasked: true,
};

describe('formulário de MCP: corpo do save', () => {
  it('novo cadastro sugere o cofre do Club', () => {
    expect(draftFrom(null).scope).toBe('club');
  });

  it('editar sem tocar nos valores manda null (manter) e não manda removeKeys', () => {
    const body = saveBody(draftFrom(http));
    expect(body).toEqual({
      scope: 'user',
      originalName: 'n8n',
      name: 'n8n',
      type: 'http',
      url: 'https://n8n.exemplo.com/mcp',
      env: {},
      headers: { Authorization: null, 'X-Team': null },
    });
  });

  it('preencher troca, remover vai em removeKeys, chave nova vai com valor', () => {
    const d = draftFrom(http);
    d.headers[0]!.value = 'Bearer novo';
    d.headers[1]!.removed = true;
    d.headers.push({ key: 'X-New', value: 'v', saved: false, removed: false });
    d.headers.push({ key: 'X-Gone', value: 'x', saved: false, removed: true });
    const body = saveBody(d);
    expect(body.headers).toEqual({ Authorization: 'Bearer novo', 'X-New': 'v' });
    expect(body.removeKeys).toEqual({ headers: ['X-Team'] });
  });

  it('argumentos mascarados só vão se o usuário pediu para trocar', () => {
    const d = draftFrom(stdio, 'p1');
    expect(saveBody(d)).toMatchObject({ scope: 'local', projectId: 'p1', command: 'npx', env: { DB_URL: null } });
    expect(saveBody(d)).not.toHaveProperty('args');
    d.argsTouched = true;
    d.args = '-y\n server-db \n\n--ro';
    expect(saveBody(d).args).toEqual(['-y', 'server-db', '--ro']);
  });

  it('trocar de tipo descarta os pares do outro tipo (guardados saem)', () => {
    const d = draftFrom(http);
    d.type = 'stdio';
    d.command = 'node';
    const body = saveBody(d);
    expect(body.headers).toEqual({});
    expect(body.removeKeys).toEqual({ headers: ['Authorization', 'X-Team'] });
    expect(body).not.toHaveProperty('url');
  });

  it('escopo de conta não manda projectId', () => {
    const d = draftFrom(null, 'p1');
    d.name = 'n8n';
    d.url = 'https://x';
    expect(saveBody(d)).not.toHaveProperty('projectId');
  });
});

describe('formulário de MCP: validação', () => {
  const base = () => Object.assign(draftFrom(null), { name: 'n8n', url: 'https://n8n.x/mcp' });

  it('aceita o básico', () => expect(draftProblem(base())).toBeNull());
  it('nome com espaço', () => expect(draftProblem({ ...base(), name: 'meu mcp' })?.problem).toBe('name'));
  it('URL sem http', () => expect(draftProblem({ ...base(), url: 'n8n.x' })?.problem).toBe('url'));
  it('projeto obrigatório nos de projeto', () => expect(draftProblem({ ...base(), scope: 'project' })?.problem).toBe('project'));
  it('comando obrigatório no stdio', () => expect(draftProblem({ ...base(), type: 'stdio' })?.problem).toBe('command'));
  it('chave nova sem valor', () => {
    const d = base();
    d.headers.push({ key: 'Authorization', value: '', saved: false, removed: false });
    expect(draftProblem(d)).toEqual({ problem: 'newValue', key: 'Authorization' });
  });
  it('chave guardada vazia = manter (ok)', () => expect(draftProblem(draftFrom(http))).toBeNull());
  it('chave repetida', () => {
    const d = draftFrom(http);
    d.headers.push({ key: 'authorization', value: 'x', saved: false, removed: false });
    expect(draftProblem(d)?.problem).toBe('duplicate');
  });
});

describe('lista de MCPs', () => {
  it('agrupa por origem e mostra comando sem os argumentos ocultos', () => {
    const g = groupServers([stdio, http, { ...http, name: 'a', scope: 'club' }]);
    expect(g.club.map((s) => s.name)).toEqual(['a']);
    expect(g.user.map((s) => s.name)).toEqual(['n8n']);
    expect(g.local.map((s) => s.name)).toEqual(['db']);
    expect(targetLabel(stdio)).toBe('npx …');
    expect(targetLabel({ ...stdio, argsMasked: false })).toBe('npx -y server-db');
  });
});
