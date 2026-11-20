import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsultView, type ConsultViewProps } from '../client/src/consult/ConsultSection';
import { consultErrorKey, consultMessageOf, secondsToDeadline, splitLinks, toggleStaff } from '../client/src/consult/consultView';
import { t } from '../client/src/i18n';

const base: ConsultViewProps = {
  projectId: 'slingshot',
  projectName: 'Slingshot',
  projects: [
    { id: 'learnote', name: 'Learnote' },
    { id: 'outro', name: 'Outro' },
  ],
  team: [
    { id: 'roberto', name: 'Roberto' },
    { id: 'ana', name: 'Ana' },
  ],
  staffName: (_p, s) => (s === 'alphonse' ? 'Alphonse' : s),
  links: [],
  records: [],
  now: Date.parse('2026-11-20T10:00:00Z'),
  onSet: () => undefined,
  onRevoke: () => undefined,
};
const html = (p: Partial<ConsultViewProps> = {}) => renderToStaticMarkup(createElement(ConsultView, { ...base, ...p }));

describe('mensagens da consulta (rótulo no chat)', () => {
  it('lê resposta, pergunta e aviso, com quem e de qual projeto', () => {
    expect(consultMessageOf('Resposta da consulta c-a1b2c3: Alphonse (Dev), do projeto “Learnote”. É informação')).toEqual({ kind: 'answer', id: 'c-a1b2c3', name: 'Alphonse', role: 'Dev', project: 'Learnote' });
    expect(consultMessageOf('Consulta c-a1b2c3 de outro projeto, SOMENTE LEITURA. Quem pergunta: Roberto (Back), do projeto “Slingshot”.')).toMatchObject({ kind: 'question', name: 'Roberto', project: 'Slingshot' });
    expect(consultMessageOf('A consulta c-a1b2c3 a Alphonse (projeto “Learnote”) não deu resposta: sem resposta no prazo')).toMatchObject({ kind: 'notice', name: 'Alphonse', project: 'Learnote' });
  });
  it('mensagem comum da plataforma não vira consulta', () => {
    expect(consultMessageOf('Tarefa t-123 entregue')).toBeNull();
    expect(consultMessageOf('Resposta da consulta x: falso')).toBeNull();
  });
});

describe('lógica pura', () => {
  it('erro pelo status, nunca pelo texto do servidor', () => {
    expect(consultErrorKey(400)).toBe('consult.errInvalid');
    expect(consultErrorKey(403)).toBe('consult.errForbidden');
    expect(consultErrorKey(404)).toBe('consult.errNotFound');
    expect(consultErrorKey(null)).toBe('consult.errGeneric');
  });
  it('separa vínculos que saem e que chegam', () => {
    const links = [
      { from: 'a', to: 'b', staffIds: null, createdAt: '' },
      { from: 'b', to: 'a', staffIds: ['x'], createdAt: '' },
    ];
    expect(splitLinks(links, 'a')).toEqual({ out: [links[0]], incoming: [links[1]] });
  });
  it('marca e desmarca na ordem da equipe, sem repetir', () => {
    expect(toggleStaff(['ana'], ['roberto', 'ana'], 'roberto')).toEqual(['roberto', 'ana']);
    expect(toggleStaff(['ana', 'roberto'], ['roberto', 'ana'], 'ana')).toEqual(['roberto']);
  });
  it('prazo nunca fica negativo', () => {
    expect(secondsToDeadline('2026-11-20T10:00:30Z', Date.parse('2026-11-20T10:00:00Z'))).toBe(30);
    expect(secondsToDeadline('2026-11-20T09:00:00Z', Date.parse('2026-11-20T10:00:00Z'))).toBe(0);
  });
});

describe('contrato com as rotas /api/consult (as mesmas provadas contra o servidor real)', () => {
  it('ligar, limitar e revogar mandam o corpo que o servidor espera', async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown; headers: Record<string, string> }> = [];
    const realFetch = globalThis.fetch;
    (globalThis as { window?: unknown }).window = { dispatchEvent: () => true };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ link: {}, revoked: true, cancelled: 0 }), { status: 200 });
    }) as typeof fetch;
    try {
      const { api } = await import('../client/src/api');
      await api.setConsultLink('a', 'b', 'all');
      await api.setConsultLink('a', 'b', ['roberto']);
      await api.revokeConsultLink('a', 'b');
      expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
        ['POST', '/api/consult/links', { fromProjectId: 'a', toProjectId: 'b', staff: 'all' }],
        ['POST', '/api/consult/links', { fromProjectId: 'a', toProjectId: 'b', staff: ['roberto'] }],
        ['POST', '/api/consult/links/revoke', { fromProjectId: 'a', toProjectId: 'b' }],
      ]);
      expect(calls.every((c) => c.headers['x-myco'] === '1')).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      delete (globalThis as { window?: unknown }).window;
    }
  });
});

describe('seção Consulta entre projetos', () => {
  it('vem desligada e avisa: só leitura e cota do projeto consultado', () => {
    const out = html();
    expect(out).toContain(t('consult.none'));
    expect(out).toContain('só por leitura');
    expect(out).toContain('cota de uso do projeto consultado');
    expect(out).toContain(t('consult.turnOn'));
  });
  it('mostra vínculo com a lista limitada e o botão de revogar', () => {
    const out = html({ links: [{ from: 'slingshot', to: 'learnote', staffIds: ['roberto'], createdAt: '' }] });
    expect(out).toContain('Learnote');
    expect(out).toContain('só Roberto');
    expect(out).toContain(t('consult.revoke'));
    // O projeto já ligado sai das opções de destino.
    expect(out).not.toContain('<option value="learnote">');
    expect(out).toContain('<option value="outro">');
  });
  it('vínculo que chega aparece com quem pode consultar', () => {
    const out = html({ links: [{ from: 'learnote', to: 'slingshot', staffIds: null, createdAt: '' }] });
    expect(out).toContain(t('consult.askedBy'));
    expect(out).toContain(t('consult.everyone'));
  });
  it('registro identifica quem e o projeto, com estado e prazo', () => {
    const out = html({
      records: [{ id: 'c-a1b2c3', state: 'running', deadlineAt: '2026-11-20T10:05:00Z', from: { projectId: 'slingshot', staffId: 'roberto' }, to: { projectId: 'learnote', staffId: 'alphonse' }, createdAt: '' }],
    });
    expect(out).toContain('roberto (Slingshot) → Alphonse (Learnote)');
    expect(out).toContain('em andamento · prazo em 5 min');
  });
  it('sem funcionários, não oferece ligar', () => {
    expect(html({ team: [] })).toContain(t('consult.noStaff'));
  });
});
