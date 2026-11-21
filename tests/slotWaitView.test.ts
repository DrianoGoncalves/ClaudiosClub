import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../client/src/api';
import messages from '../client/src/i18n/tasks';
import { BoardReview, type BoardReviewState, type BoardWriterState } from '../client/src/tasks/BoardReview';
import { queueRows } from '../client/src/tasks/queueState';
import { ResourceWaitBadge, resourceWaitHint, resourceWaitText, slotHolder } from '../client/src/tasks/ResourceWait';
import type { StaffQueue, TaskStatus } from '../shared/model';

// t-340cdd: a espera pela vaga de escrita (`Task.resourceWait.holder`, "um card escrevendo por vez") tem texto próprio com o card que ocupa; a espera por
// recurso da máquina segue com o texto de sempre. O interruptor "Um card escrevendo por vez" lê e grava `singleWriter` pela rota board-writer.

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const SINCE = new Date(NOW - 4 * 60_000).toISOString();
const LABEL = { todo: 'A fazer', doing: 'Fazendo', review: 'Revisão', done: 'Pronto' } as Record<TaskStatus, string>;
const cards = [{ id: 't-aaaa11', title: 'Corrigir o login', status: 'doing' as TaskStatus }];
const gate = { reason: 'RAM disponível 1,2 GB (reserva 1,5 GB)', since: SINCE };
const slot = { reason: 'a vaga de escrita deste projeto está com “Corrigir o login” (t-aaaa11, em andamento)', since: SINCE, holder: 't-aaaa11' };

describe('espera pela vaga de escrita', () => {
  it('só a espera com `holder` é da vaga; o card vem do quadro com a coluna', () => {
    expect(slotHolder(gate, cards, LABEL)).toBeNull();
    expect(slotHolder(null, cards, LABEL)).toBeNull();
    expect(slotHolder(slot, cards, LABEL)).toEqual({ id: 't-aaaa11', title: 'Corrigir o login', column: 'Fazendo' });
    expect(slotHolder(slot, [], LABEL)).toEqual({ id: 't-aaaa11', title: null, column: null });
  });

  it('o texto diz quem ocupa (título, id e coluna) e quando o card começa; o do gate de recursos não muda', () => {
    const text = resourceWaitText(slot, NOW, slotHolder(slot, cards, LABEL));
    expect(text).toBe('Esperando a vez de editar: “Corrigir o login” (t-aaaa11, Fazendo) está editando o projeto. Começa sozinho quando esse card for aprovado e commitado · há 4min');
    expect(text).not.toContain('Aguardando recursos');
    expect(resourceWaitText(gate, NOW, slotHolder(gate, cards, LABEL))).toBe('Aguardando recursos: RAM disponível 1,2 GB (reserva 1,5 GB) · há 4min');
  });

  it('card que ocupa fora da lista: o id no lugar do título, sem inventar coluna', () => {
    expect(resourceWaitText(slot, NOW, slotHolder(slot, [], LABEL))).toBe('Esperando a vez de editar: t-aaaa11 está editando o projeto. Começa sozinho quando esse card for aprovado e commitado · há 4min');
  });

  it('o selo e a dica seguem o tipo da espera', () => {
    const holder = slotHolder(slot, cards, LABEL);
    const html = renderToStaticMarkup(createElement(ResourceWaitBadge, { wait: slot, now: NOW, holder }));
    expect(html).toContain('task-resource');
    expect(html).toContain('t-aaaa11, Fazendo');
    expect(html).toContain('para não misturar no commit');
    expect(resourceWaitHint(null)).toContain('até a máquina folgar');
    expect(renderToStaticMarkup(createElement(ResourceWaitBadge, { wait: gate, now: NOW, holder: null }))).toContain('Aguardando recursos');
  });
});

describe('por que a fila não anda', () => {
  // Sem `since`: a hora "desde HH:MM" sai no fuso da máquina e não é o assunto aqui.
  const queue = (extra: Partial<StaffQueue>): StaffQueue => ({ staffId: 'ana-1', state: 'resource-wait', taskId: 't-bbbb22', queued: 1, deliveries: [], ...extra });
  const rows = (q: StaffQueue, slotOf?: Parameters<typeof queueRows>[6]) => queueRows([q], () => 'Ana', (id) => id, NOW, '', false, slotOf);

  it('espera pela vaga: texto próprio com o card que ocupa e a dica; sem a vaga, o texto do gate', () => {
    const [row] = rows(queue({ detail: slot.reason }), () => slotHolder(slot, cards, LABEL));
    expect(row!.tone).toBe('stuck');
    expect(row!.text).toBe('Ana: fila parada, esperando a vez de editar: “Corrigir o login” (t-aaaa11, Fazendo) está editando o projeto · 1 na fila');
    expect(row!.detail).toContain('um card editar por vez');
    const [gated] = rows(queue({ detail: gate.reason }), () => null);
    expect(gated!.text).toContain('esperando a máquina folgar');
    expect(gated!.detail).toBe(gate.reason);
    expect(rows(queue({ detail: gate.reason }))[0]!.text).toContain('esperando a máquina folgar');
  });
});

describe('i18n do interruptor e da espera', () => {
  const KEYS = ['tasks.boardWriter', 'tasks.boardWriterRule', 'tasks.slotWait', 'tasks.slotWaitHint', 'tasks.slotWaitOpen', 'tasks.queueSlot'] as const;
  it('as seis chaves existem nos três idiomas, sem texto vazio e com os mesmos marcadores', () => {
    const all = messages as unknown as Record<string, Record<string, string>>;
    expect(Object.keys(all).sort()).toEqual(['en', 'es', 'pt-BR']);
    for (const key of KEYS) {
      const marks = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(all['pt-BR']![key], `pt-BR ${key}`).toBeTruthy();
      for (const lang of ['en', 'es']) {
        expect(all[lang]![key], `${lang} ${key}`).toBeTruthy();
        expect(marks(all[lang]![key]!), `${lang} ${key}`).toBe(marks(all['pt-BR']![key]!));
      }
    }
  });
});

describe('o interruptor "Um card escrevendo por vez"', () => {
  const review: BoardReviewState = { config: { autoReview: false, reviewerId: null }, missing: false, error: null, saving: false, save: async () => {} };
  const writer = (singleWriter: boolean | null, extra: Partial<BoardWriterState> = {}): BoardWriterState => ({ config: singleWriter === null ? null : { singleWriter }, error: null, saving: false, save: async () => {}, ...extra });
  const render = (w?: BoardWriterState) => renderToStaticMarkup(createElement(BoardReview, { review, writer: w, staff: [] }));

  it('fica no bloco do commit automático, desligado por padrão, com a ajuda (commit sem mistura; worktree não espera)', () => {
    const html = render(writer(false));
    expect(html).toContain('Um card escrevendo por vez');
    expect(html).toContain('Evita misturar no mesmo commit arquivos de cards diferentes');
    expect(html).toContain('worktree própria não espera');
    expect(html).toMatch(/aria-labelledby="[^"]+"[^>]*>Desligada<\/button>/);
    expect(html).not.toContain('aria-pressed="true"');
  });

  it('ligado: botão pressionado; sem estado (lendo, 404) some; gravando desabilita; o erro do servidor aparece', () => {
    expect(render(writer(true))).toMatch(/aria-pressed="true"[^>]*>Ligada<\/button>/);
    expect(render()).not.toContain('escrevendo por vez');
    expect(render(writer(null))).not.toContain('escrevendo por vez');
    expect(render(writer(false, { saving: true }))).toMatch(/<button[^>]*disabled=""[^>]*>Desligada<\/button>/);
    expect(render(writer(false, { error: 'a vaga de escrita só é ligada ou desligada pelo Claudio’s Club' }))).toContain('só é ligada ou desligada pelo Claudio’s Club');
  });
});

describe('a rota board-writer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lê e grava `singleWriter` em /api/projects/:id/board-writer, com POST JSON e o cabeçalho da tela', async () => {
    let state = { singleWriter: false };
    const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
    vi.stubGlobal('window', { dispatchEvent: () => true });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
      if (method === 'POST') state = JSON.parse(String(init!.body));
      return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(await api.boardWriter('proj')).toEqual({ singleWriter: false });
    expect(await api.saveBoardWriter('proj', { singleWriter: true })).toEqual({ singleWriter: true });
    expect(await api.boardWriter('proj')).toEqual({ singleWriter: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/projects/proj/board-writer', 'POST /api/projects/proj/board-writer', 'GET /api/projects/proj/board-writer']);
    expect(calls[1]!.body).toEqual({ singleWriter: true });
    expect(calls[1]!.headers['x-myco']).toBe('1');
  });
});
