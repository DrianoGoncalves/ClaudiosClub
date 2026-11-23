import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StaffQueue } from '../shared/model';
import tasksMessages from '../client/src/i18n/tasks';
import { queueDots, queueRows, queueSince, SLOW_DELIVERY_MS } from '../client/src/tasks/queueState';
import { QueueDots } from '../client/src/tasks/QueueStrip';
import { TasksBoard } from '../client/src/tasks/TasksBoard';

// Hora local, como os textos: 20/11 às 14:32 e um "agora" no mesmo dia.
const AT = new Date(2026, 10, 20, 14, 32).getTime();
const ISO = new Date(AT).toISOString();
const NOW = new Date(2026, 10, 20, 15, 0).getTime();
const NAMES: Record<string, string> = { bel: 'Belchior', leo: 'Leonardo' };
const nameOf = (id: string) => NAMES[id] ?? null;
const titleOf = (id: string) => (id === 't-1' ? 'Tela de login' : id);
const queue = (over: Partial<StaffQueue>): StaffQueue => ({ staffId: 'bel', state: 'free', queued: 2, deliveries: [], ...over });
const rows = (q: StaffQueue[], only = '') => queueRows(q, nameOf, titleOf, NOW, only);
const dotsOf = (q: StaffQueue[]) => queueDots(q, [], nameOf, titleOf, NOW);

describe('queueRows: o que o dono lê de cada fila', () => {
  it('livre e ocupado são discretos (quiet); sem card esperando, nem aparecem', () => {
    const r = rows([queue({ state: 'free' }), queue({ staffId: 'leo', state: 'busy', taskId: 't-1', queued: 1 }), queue({ staffId: 'x', state: 'busy', taskId: 't-1', queued: 0 })]);
    expect(r.map((x) => x.tone)).toEqual(['quiet', 'quiet']);
    expect(r[0]!.text).toBe('Belchior: livre · 2 na fila');
    expect(r[1]!.text).toBe('Leonardo: trabalhando em Tela de login · 1 na fila');
  });

  it('esperando recursos e limite de consumo: trava, com o motivo do servidor e desde quando', () => {
    const [res, use] = rows([
      queue({ state: 'resource-wait', taskId: 't-2', since: ISO, detail: 'pouca memória livre (1.2 GB de 16 GB)' }),
      queue({ staffId: 'leo', state: 'usage-limit', taskId: 't-3', since: ISO, detail: 'limite atingido' }),
    ]);
    expect(res).toMatchObject({ tone: 'stuck', detail: 'pouca memória livre (1.2 GB de 16 GB)' });
    expect(res!.text).toBe('Belchior: fila parada, esperando a máquina folgar · 2 na fila · desde 14:32');
    expect(use).toMatchObject({ tone: 'stuck', detail: 'limite atingido' });
    expect(use!.text).toContain('limite de consumo');
  });

  it('suíte esperando a vez: trava, com quem a segura e o horário em que começou a esperar', () => {
    const [r] = rows([queue({ state: 'heavy-wait', taskId: 't-1', since: ISO, phase: 'heavy-wait', deliveries: [{ taskId: 't-1', phase: 'heavy-wait', since: ISO, startedAt: ISO, holder: 'MyCo' }] })]);
    expect(r).toMatchObject({ tone: 'stuck' });
    expect(r!.text).toBe('Belchior: testes de Tela de login esperando a vez (a suíte de MyCo roda agora) · 2 na fila · desde 14:32');
    expect(r!.detail).toContain('uma suíte de testes pesada');
  });

  it('suíte esperando sem saber quem a segura: a frase não cita ninguém', () => {
    const [r] = rows([queue({ state: 'heavy-wait', taskId: 't-1', since: ISO, phase: 'heavy-wait' })]);
    expect(r!.text).toBe('Belchior: testes de Tela de login esperando a vez · 2 na fila · desde 14:32');
  });

  it('entrega salvando: discreta no começo, trava depois de 3 min; só a que segura a fila (saving) trava', () => {
    const fresh = new Date(NOW - SLOW_DELIVERY_MS + 1000).toISOString();
    const old = new Date(NOW - SLOW_DELIVERY_MS).toISOString();
    const [a, b, c] = rows([
      queue({ state: 'delivering', taskId: 't-1', since: fresh, phase: 'saving' }),
      queue({ staffId: 'leo', state: 'delivering', taskId: 't-1', since: old, phase: 'saving' }),
      queue({ staffId: 'z', state: 'delivering', taskId: 't-1', since: old, phase: 'tests' }),
    ]);
    expect(a).toMatchObject({ tone: 'quiet' });
    expect(a!.detail).toBeUndefined();
    expect(b).toMatchObject({ tone: 'stuck' });
    expect(b!.detail).toContain('A fila só anda quando a entrega terminar');
    expect(c).toMatchObject({ tone: 'quiet' });
  });

  it('projeto pausado não vira linha (a faixa do quadro já diz) e o filtro mostra só o funcionário escolhido', () => {
    const all = [queue({ state: 'paused', since: ISO }), queue({ staffId: 'leo', state: 'free' })];
    expect(rows(all)).toHaveLength(1);
    expect(rows([queue({}), queue({ staffId: 'leo' })], 'leo').map((x) => x.staffId)).toEqual(['leo']);
    expect(queueRows(null, nameOf, titleOf, NOW)).toEqual([]);
  });

  it('horário de outro dia leva a data; sem horário, nada', () => {
    expect(queueSince(ISO, NOW)).toBe('desde 14:32');
    expect(queueSince(new Date(2026, 10, 19, 9, 5).toISOString(), NOW)).toMatch(/^desde 19\/11.*09:05$/);
    expect(queueSince(undefined, NOW)).toBe('');
  });

  it('os textos existem em pt-BR, inglês e espanhol, com os mesmos {campos}', () => {
    const keys = Object.keys(tasksMessages['pt-BR']).filter((k) => /^tasks\.queue(Label|Since|StFree|StBusy|BusyChat|Resource|Usage|Deliver|Heavy|Reviewing)/.test(k));
    expect(keys).toHaveLength(14);
    const fields = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of keys) {
      for (const lang of ['en', 'es'] as const) {
        const text = (tasksMessages[lang] as Record<string, string>)[k];
        expect(text, `${lang} ${k}`).toBeTruthy();
        expect(fields(text!), `${lang} ${k}`).toEqual(fields((tasksMessages['pt-BR'] as Record<string, string>)[k]!));
      }
    }
  });
});
describe('queueDots: quem está ocupado em Fazendo e em Revisão', () => {
  const review = (staffId: string, over: object = {}) => ({ id: 't-1', status: 'review', review: { staffId, sessionId: 's', at: ISO, ...over } });
  const dots = (q: StaffQueue[], tasks: Parameters<typeof queueDots>[1] = [], only = '') => queueDots(q, tasks, nameOf, titleOf, NOW, only);

  it('Fazendo: ocupado e entregando viram bolinha normal, mesmo sem card esperando; livre não aparece', () => {
    const r = dots([queue({ state: 'free' }), queue({ staffId: 'leo', state: 'busy', taskId: 't-1', queued: 0 }), queue({ staffId: 'z', state: 'paused', taskId: 't-1' })]);
    expect(r).toEqual([{ staffId: 'leo', column: 'doing', tone: 'busy', text: 'Leonardo: trabalhando em Tela de login · 0 na fila' }]);
  });

  it('Fazendo: a fila travada vira bolinha de alerta, com o detalhe para o hover', () => {
    const [d] = dots([queue({ state: 'usage-limit', taskId: 't-1', since: ISO, detail: 'limite atingido' })]);
    expect(d).toMatchObject({ column: 'doing', tone: 'stuck', detail: 'limite atingido' });
    expect(d!.text).toContain('limite de consumo');
  });

  it('Revisão: só o pedido ainda aberto (sem fim do turno, veredito nem rodada substituída); vale o revisor, não o dono', () => {
    expect(dots([], [review('bel')])).toEqual([{ staffId: 'bel', column: 'review', tone: 'busy', text: 'Belchior: revisando Tela de login' }]);
    for (const over of [{ doneAt: ISO }, { verdict: 'approved' }, { superseded: true }]) expect(dots([], [review('bel', over)])).toEqual([]);
    expect(dots([], [{ ...review('bel'), status: 'doing' }, { ...review('bel'), archived: true }])).toEqual([]);
    expect(dots([], [review('bel'), review('leo')], 'leo').map((x) => x.staffId)).toEqual(['leo']);
  });

  it('quem revisa numa conversa sem card não ganha uma bolinha também em Fazendo', () => {
    const r = dots([queue({ state: 'busy', queued: 0 })], [review('bel')]);
    expect(r.map((x) => x.column)).toEqual(['review']);
  });

  it('sem dado, nada', () => {
    expect(queueDots(null, undefined, nameOf, titleOf, NOW)).toEqual([]);
  });
});

describe('QueueDots e o quadro', () => {
  it('uma bolinha por pessoa, com a frase no nome acessível e sem o texto na página (só no hover)', () => {
    const html = renderToStaticMarkup(
      createElement(QueueDots, { dots: dotsOf([queue({ state: 'resource-wait', taskId: 't-2', since: ISO, detail: 'pouca memória' }), queue({ staffId: 'leo', state: 'busy', taskId: 't-1', queued: 0 })]) }),
    );
    expect(html).toContain('role="group"');
    expect(html.match(/class="queue-dot"/g)).toHaveLength(2);
    // O mesmo `Portrait` do organograma (menor), com o contorno à mão; sem a ficha, as iniciais do id.
    expect(html.match(/class="bn-portrait is-mini"/g)).toHaveLength(2);
    expect(html.match(/class="sketch /g)).toHaveLength(2);
    expect(html).toContain('<span>B</span>');
    expect(html).not.toContain('class="dot ');
    expect(html).toContain('aria-label="Belchior: fila parada, esperando a máquina folgar · 2 na fila · desde 14:32. pouca memória"');
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toContain('>Belchior');
  });

  it('com a ficha: o retrato no lugar da bolinha; sem retrato, as iniciais do nome', () => {
    const staff = [
      { id: 'bel', name: 'Belchior', portrait: 'p.png', updatedAt: '2026-11-20T10:00:00.000Z' },
      { id: 'leo', name: 'Leonardo Dev', portrait: null, updatedAt: ISO },
    ];
    const html = renderToStaticMarkup(
      createElement(QueueDots, { projectId: 'p1', staff, dots: dotsOf([queue({ state: 'busy', taskId: 't-1' }), queue({ staffId: 'leo', state: 'busy', taskId: 't-1', queued: 0 })]) }),
    );
    expect(html).toContain('src="/api/projects/p1/staff/bel/portrait?v=2026-11-20T10%3A00%3A00.000Z"');
    expect(html.match(/<img /g)).toHaveLength(1);
    // Iniciais só quando não há foto: quem tem retrato não mostra as dele.
    expect(html).toContain('<span>LD</span>');
    expect(html).not.toContain('<span>B</span>');
  });

  it('Revisão (quem revisa): só a bolinha, sem retrato nem iniciais, mesmo com ficha e foto', () => {
    const staff = [{ id: 'leo', name: 'Leonardo', portrait: 'p.png', updatedAt: ISO }];
    const html = renderToStaticMarkup(createElement(QueueDots, { projectId: 'p1', staff, dots: [{ staffId: 'leo', column: 'review', tone: 'busy', text: 'Leonardo: revisando X' }] }));
    expect(html).toContain('class="queue-dot is-plain"');
    expect(html).toContain('class="dot dot-busy"');
    expect(html).not.toContain('bn-portrait');
    expect(html).not.toContain('<img');
  });

  it('ninguém ocupado, não desenha nada', () => {
    expect(renderToStaticMarkup(createElement(QueueDots, { dots: [] }))).toBe('');
  });

  it('o quadro põe as bolinhas no topo de Fazendo e Revisão, sem faixa de texto, e some sem o dado', () => {
    const mk = (id: string, status: string, over: object = {}) => ({ id, title: id === 't-1' ? 'Tela de login' : 'Outra', status, staffId: 'bel', updatedAt: ISO, createdAt: ISO, history: [], ...over });
    const board = (initialQueues?: StaffQueue[] | null) =>
      renderToStaticMarkup(
        createElement(TasksBoard, {
          projectId: 'p',
          projectName: 'Projeto',
          staff: [{ id: 'bel', name: 'Belchior', portrait: 'p.png', updatedAt: ISO, servers: [], reportsTo: [] } as never, { id: 'leo', name: 'Leonardo', servers: [], reportsTo: [] } as never],
          costs: null,
          onClose: () => {},
          onOpenStaff: () => {},
          onChanged: () => {},
          initialTasks: [mk('t-1', 'doing'), mk('t-2', 'review', { review: { staffId: 'leo', sessionId: 's', at: ISO } })] as never,
          initialQueues,
        }),
      );
    const html = board([queue({ state: 'busy', taskId: 't-1', since: ISO })]);
    expect(html).not.toContain('queue-strip');
    const doing = html.slice(html.indexOf('tasks-col-doing'), html.indexOf('tasks-col-review'));
    const rev = html.slice(html.indexOf('tasks-col-review'), html.indexOf('tasks-col-done'));
    expect(doing).toContain('aria-label="Belchior: trabalhando em Tela de login');
    // O quadro passa a ficha: quem executa (Belchior, com retrato) aparece com a foto em Fazendo; quem revisa (Leonardo) é só bolinha em Revisão.
    expect(doing).toContain('src="/api/projects/p/staff/bel/portrait?v=');
    expect(rev.slice(rev.indexOf('queue-dots'), rev.indexOf('task-card'))).not.toContain('bn-portrait');
    expect(rev).toContain('aria-label="Leonardo: revisando Outra"');
    // Sem o dado das filas, só Fazendo perde a bolinha: Revisão vem dos cards.
    for (const none of [undefined, null]) {
      const h = board(none);
      expect(h).not.toContain('Belchior: trabalhando');
      expect(h).toContain('Leonardo: revisando Outra');
    }
  });
});
