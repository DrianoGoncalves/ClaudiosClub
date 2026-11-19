import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import appMessages from '../client/src/i18n/app';
import tasksMessages from '../client/src/i18n/tasks';
import { ProjectNode, ResumeChip } from '../client/src/board/nodes';
import { onDialogRequest } from '../client/src/lib/dialogStore';
import { changePause, createPauseController, pausedHeading, pausedTip, pauseSince, type PauseView } from '../client/src/tasks/pauseState';
import { PausedBanner, PausedTag, PauseButton } from '../client/src/tasks/ProjectPauseBar';
import { TasksBoard } from '../client/src/tasks/TasksBoard';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// Hora local (os textos saem na hora de quem vê): o dia 19/11 às 14:32 e dois "agora", no mesmo dia e no seguinte.
const AT = new Date(2026, 10, 19, 14, 32).toISOString();
const SAME_DAY = new Date(2026, 10, 19, 16, 0).getTime();
const NEXT_DAY = new Date(2026, 10, 20, 9, 0).getTime();
const PAUSE = { at: AT };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** O que o servidor diz quando recusa quem não é a tela (`TaskService.setPaused`): em pt-BR, como em todo erro dele. */
const FORBIDDEN_PT = { error: 'só você, pelo Claudio’s Club, pausa ou retoma um projeto' };

/** O modal do App, no lugar de quem responde: guarda o texto perguntado e responde `answer`. */
const modal = (answer: boolean, onDialogRequestFn: typeof onDialogRequest = onDialogRequest) => {
  const asked: string[] = [];
  const off = onDialogRequestFn((req) => {
    asked.push(req.text);
    req.resolve(answer);
  });
  return { asked, off };
};
const stubFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  return fetch;
};
const sent = (fetch: ReturnType<typeof stubFetch>, n = 0) => fetch.mock.calls[n] as unknown as [string, RequestInit];

describe('desde quando está pausado', () => {
  it('hoje: "desde hoje às 14:32"', () => {
    expect(pauseSince(PAUSE, SAME_DAY)).toBe('desde hoje às 14:32');
  });

  it('outro dia: dia/mês e hora, sem "hoje"', () => {
    expect(pauseSince(PAUSE, NEXT_DAY)).toMatch(/^desde 19\/11,? 14:32$/);
  });

  it('sem pausa ou com horário que não lê: vazio (a faixa diz só "Projeto pausado")', () => {
    expect(pauseSince(null, SAME_DAY)).toBe('');
    expect(pauseSince(undefined, SAME_DAY)).toBe('');
    expect(pauseSince({ at: 'ontem' }, SAME_DAY)).toBe('');
    expect(pausedHeading({ at: 'ontem' }, SAME_DAY)).toBe('Projeto pausado');
  });

  it('título da faixa e dica do selo', () => {
    expect(pausedHeading(PAUSE, SAME_DAY)).toBe('Projeto pausado desde hoje às 14:32');
    expect(pausedTip(PAUSE, SAME_DAY)).toBe('Projeto pausado desde hoje às 14:32. Nada novo começa sozinho.');
  });
});

describe('changePause: o único caminho que muda a pausa', () => {
  it('pausar pergunta antes, explica o que a pausa faz e grava em POST .../pause', async () => {
    const { asked, off } = modal(true);
    const fetch = stubFetch(() => json({ paused: PAUSE }));
    const next = await changePause('proj-a', 'MyCo', false);
    off();
    expect(next).toEqual(PAUSE);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Pausar o projeto “MyCo”?');
    expect(asked[0]).toContain('Nada novo começa sozinho');
    expect(asked[0]).toContain('termina o turno atual e para');
    expect(asked[0]).toContain('a fila segue na ordem');
    const [url, init] = sent(fetch);
    expect(url).toBe('/api/projects/proj-a/pause');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-myco']).toBe('1');
  });

  it('desistiu na pergunta: nada é enviado e o estado fica (undefined)', async () => {
    const { off } = modal(false);
    const fetch = stubFetch(() => json({}));
    expect(await changePause('proj-a', 'MyCo', false)).toBeUndefined();
    off();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retomar não pergunta: POST .../resume e o estado volta a "rodando" (null)', async () => {
    const { asked, off } = modal(false);
    const fetch = stubFetch(() => json({ paused: null }));
    const next = await changePause('proj-a', 'MyCo', true);
    off();
    expect(next).toBeNull();
    expect(asked).toEqual([]);
    expect(sent(fetch)[0]).toBe('/api/projects/proj-a/resume');
  });
});

describe('o erro de pausar/retomar sai no idioma da tela', () => {
  // O servidor erra em pt-BR (server/tasks.ts): a tela não pode repetir o texto dele em en/es. O idioma é fixado na carga do módulo, então cada caso o recarrega.
  const inLocale = async (locale: 'pt-BR' | 'en' | 'es') => {
    vi.resetModules();
    vi.stubGlobal('window', { localStorage: { getItem: () => locale }, dispatchEvent: vi.fn() });
    const dialog = await import('../client/src/lib/dialogStore');
    const state = await import('../client/src/tasks/pauseState');
    return { state, dialog };
  };
  const text = (locale: 'pt-BR' | 'en' | 'es', key: keyof (typeof tasksMessages)['pt-BR']) => tasksMessages[locale][key];

  describe.each(['pt-BR', 'en', 'es'] as const)('%s', (locale) => {
    const fail = async (res: () => Response | Promise<Response>, pausing: boolean) => {
      const { state, dialog } = await inLocale(locale);
      const m = modal(true, dialog.onDialogRequest);
      stubFetchAfterLocale(res);
      const e = await state.changePause('proj-a', 'MyCo', !pausing).catch((x: unknown) => x);
      m.off();
      expect(e).toBeInstanceOf(Error);
      return (e as Error).message;
    };
    // O `window` do locale tem de ficar: o stub do fetch só troca o `fetch`.
    const stubFetchAfterLocale = (res: () => Response | Promise<Response>) => vi.stubGlobal('fetch', vi.fn(async () => res()));

    it('403 (não é você, pelo Club): a frase da tela, nunca a do servidor', async () => {
      const message = await fail(() => json(FORBIDDEN_PT, 403), true);
      expect(message).toBe(text(locale, 'tasks.projectPauseForbidden'));
      if (locale !== 'pt-BR') expect(message).not.toContain('só você');
    });

    it('404 (o projeto sumiu)', async () => {
      expect(await fail(() => json({ error: 'projeto não encontrado' }, 404), true)).toBe(text(locale, 'tasks.projectPauseGone'));
    });

    it('outro erro do servidor: frase genérica de pausar ou de retomar, sem o texto em pt', async () => {
      const body = { error: 'a pausa de projeto não está disponível neste servidor' };
      const pause = await fail(() => json(body, 500), true);
      const resume = await fail(() => json(body, 500), false);
      expect(pause).toBe(text(locale, 'tasks.projectPauseFailed'));
      expect(resume).toBe(text(locale, 'tasks.projectResumeFailed'));
      expect(pause).not.toBe(resume);
      if (locale !== 'pt-BR') expect(pause + resume).not.toContain('servidor');
    });

    it('servidor fora do ar: a frase que a api já traduz', async () => {
      const message = await fail(() => Promise.reject(new TypeError('Failed to fetch')), true);
      expect(message).toBe(appMessages[locale]['app.serverOffline']);
    });

    it('recusa por pareamento: mensagem vazia (o aviso do App já explica)', async () => {
      expect(await fail(() => json({ code: 'needs-pairing', error: 'x' }, 403), true)).toBe('');
    });
  });
});

describe('createPauseController: o estado e as ações, sem tela', () => {
  const make = (initial?: { at: string } | null) => {
    const views: PauseView[] = [];
    const onChanged = vi.fn();
    const c = createPauseController({ projectId: 'p', name: 'MyCo', initial, onView: (v) => views.push(v), onChanged });
    return { c, views, onChanged };
  };

  it('lê do servidor: guarda o estado, avisa a tela uma vez e não avisa de novo com o mesmo estado', async () => {
    stubFetch(() => json({ paused: PAUSE }));
    const { c, views } = make();
    expect(c.view.pause).toBeUndefined();
    await c.read();
    expect(c.view.pause).toEqual(PAUSE);
    expect(views).toHaveLength(1);
    await c.read();
    expect(views).toHaveLength(1);
  });

  it('servidor sem as rotas (404): fica sem estado, e então não há botão nem ação', async () => {
    const fetch = stubFetch(() => json({}, 404));
    const { c, views } = make();
    await c.read();
    expect(c.view.pause).toBeUndefined();
    expect(views).toEqual([]);
    fetch.mockClear();
    await c.toggle();
    expect(fetch).not.toHaveBeenCalled();
    expect(views).toEqual([]);
  });

  it('pausar: ocupado durante a gravação, estado novo e onChanged uma vez no fim', async () => {
    const { off } = modal(true);
    stubFetch(() => json({ paused: PAUSE }));
    const { c, views, onChanged } = make(null);
    await c.toggle();
    off();
    expect(views.map((v) => [v.busy, v.pause])).toEqual([
      [true, null],
      [false, PAUSE],
    ]);
    expect(c.view.error).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('segundo clique no meio da gravação não grava de novo', async () => {
    const m = modal(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = stubFetch(async () => {
      await gate;
      return json({ paused: PAUSE });
    });
    const { c, onChanged } = make(null);
    const first = c.toggle();
    await c.toggle();
    expect(c.view.busy).toBe(true);
    release();
    await first;
    m.off();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(m.asked).toHaveLength(1);
    expect(c.view.busy).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('desistir na pergunta: nada grava, nada avisa e o botão volta ao normal', async () => {
    const { off } = modal(false);
    const fetch = stubFetch(() => json({ paused: PAUSE }));
    const { c, onChanged } = make(null);
    await c.toggle();
    off();
    expect(fetch).not.toHaveBeenCalled();
    expect(c.view).toEqual({ pause: null, busy: false, error: null });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('retomar: sem pergunta, POST .../resume, estado "rodando"', async () => {
    const m = modal(false);
    const fetch = stubFetch(() => json({ paused: null }));
    const { c, onChanged } = make(PAUSE);
    await c.toggle();
    m.off();
    expect(m.asked).toEqual([]);
    expect(sent(fetch)[0]).toBe('/api/projects/p/resume');
    expect(c.view.pause).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('erro (403): o estado fica, o erro vai para a tela já no idioma, e o próximo clique o limpa', async () => {
    const { off } = modal(true);
    let reply: () => Response = () => json(FORBIDDEN_PT, 403);
    stubFetch(() => reply());
    const { c, views, onChanged } = make(null);
    await c.toggle();
    expect(c.view).toEqual({ pause: null, busy: false, error: tasksMessages['pt-BR']['tasks.projectPauseForbidden'] });
    expect(onChanged).not.toHaveBeenCalled();
    reply = () => json({ paused: PAUSE });
    await c.toggle();
    off();
    expect(views.some((v) => v.busy && v.error === null)).toBe(true);
    expect(c.view).toEqual({ pause: PAUSE, busy: false, error: null });
  });

  it('rede fora no meio de gravar: o erro é o do servidor fora do ar, não um texto cru', async () => {
    const { off } = modal(true);
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const { c } = make(null);
    await c.toggle();
    off();
    expect(c.view.error).toBe(appMessages['pt-BR']['app.serverOffline']);
    expect(c.view.busy).toBe(false);
  });

  it('pareamento recusado: sem texto de erro (o aviso do App já explica)', async () => {
    const { off } = modal(true);
    stubFetch(() => json({ code: 'needs-pairing' }, 403));
    const { c } = make(null);
    await c.toggle();
    off();
    expect(c.view).toEqual({ pause: null, busy: false, error: null });
  });

  it('leitura que saiu antes da gravação e voltou depois traz o estado velho: é descartada', async () => {
    const { off } = modal(true);
    let late!: (r: Response) => void;
    const lateGet = new Promise<Response>((r) => (late = r));
    stubFetch((_url, init) => (init?.method === 'POST' ? json({ paused: PAUSE }) : lateGet));
    const { c } = make(null);
    const stale = c.read();
    await c.toggle();
    expect(c.view.pause).toEqual(PAUSE);
    late(json({ paused: null }));
    await stale;
    off();
    expect(c.view.pause).toEqual(PAUSE);
  });

  it('leitura que falha com o estado já lido não apaga o estado', async () => {
    let ok = true;
    stubFetch(() => (ok ? json({ paused: PAUSE }) : json({}, 500)));
    const { c } = make();
    await c.read();
    ok = false;
    await c.read();
    expect(c.view.pause).toEqual(PAUSE);
  });
});

describe('botão, selo e faixa', () => {
  it('rodando: "Pausar projeto" secundário; pausado: "Retomar projeto" cheio, com o nome também no modo só ícone', () => {
    const run = renderToStaticMarkup(createElement(PauseButton, { paused: false, onClick: () => {} }));
    expect(run).toContain('btn-secondary btn-with-icon project-pause-btn');
    expect(run).toContain('Pausar projeto');
    const paused = renderToStaticMarkup(createElement(PauseButton, { paused: true, onClick: () => {} }));
    expect(paused).toContain('btn-primary btn-with-icon project-pause-btn');
    expect(paused).toContain('Retomar projeto');
    const icon = renderToStaticMarkup(createElement(PauseButton, { paused: true, iconOnly: true, onClick: () => {} }));
    expect(icon).toContain('btn-primary btn-icon project-pause-btn');
    expect(icon).toContain('aria-label="Retomar projeto"');
    expect(icon).not.toContain('>Retomar projeto<');
  });

  it('ocupado: o botão fica desabilitado (sem segundo clique no meio da gravação)', () => {
    expect(renderToStaticMarkup(createElement(PauseButton, { paused: false, busy: true, onClick: () => {} }))).toContain('disabled');
  });

  it('o selo "Pausado" leva a classe de quem usa (sala ou painel) e a dica de desde quando', () => {
    const tag = renderToStaticMarkup(createElement(PausedTag, { pause: PAUSE, now: SAME_DAY, className: 'badge is-paused' }));
    expect(tag).toContain('class="badge is-paused"');
    expect(tag).toContain('title="Projeto pausado desde hoje às 14:32. Nada novo começa sozinho."');
    expect(tag).toContain('Pausado');
  });

  it('a faixa diz desde quando e o que a pausa faz', () => {
    const html = renderToStaticMarkup(createElement(PausedBanner, { pause: PAUSE, now: SAME_DAY }));
    expect(html).toContain('role="status"');
    expect(html).toContain('Projeto pausado desde hoje às 14:32');
    expect(html).toContain('termina o turno atual e para');
    expect(html).toContain('Ao retomar, a fila segue na ordem');
  });
});

describe('a sala no quadro: selo e botão no cabeçalho do projeto', () => {
  const project = (over: Record<string, unknown> = {}) => ({ id: 'p', name: 'MyCo', path: 'C:/x/MyCo', exists: true, ...over });
  const room = (tasks: Record<string, unknown> | null, exists = true) => {
    const data = {
      project: project({ exists }),
      live: [],
      liveWho: [],
      cost: null,
      archived: false,
      image: null,
      header: { color: null, sideAt: null, collapsed: false, resources: 0 },
      git: null,
      tasks,
      awaiting: 0,
      employees: 3,
    };
    const props = { id: 'p:p', data, selected: false, width: 640 } as unknown as Parameters<typeof ProjectNode>[0];
    return renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(ProjectNode, props)));
  };

  it('pausado: selo "Pausado" na linha do resumo (não no título, que é do nome) e o botão "Retomar projeto"', () => {
    const html = room({ open: 4, review: 1, paused: PAUSE });
    const title = html.slice(html.indexOf('<div class="bn-title">'), html.indexOf('<div class="bn-meta"'));
    expect(title).toContain('MyCo');
    expect(title).not.toContain('Pausado');
    const metaAt = html.indexOf('<div class="bn-meta"');
    expect(metaAt).toBeGreaterThan(0);
    expect(html.slice(metaAt, metaAt + 160)).toContain('bn-tag is-paused');
    expect(html).toContain('class="bn-pause nodrag is-paused"');
    expect(html).toContain('aria-label="Retomar projeto"');
  });

  it('rodando: sem selo e sem botão de pausa no cabeçalho (o nome da sala estreita fica inteiro; pausar é pelo painel ou pelo quadro)', () => {
    const html = room({ open: 4, review: 1 });
    expect(html).not.toContain('is-paused');
    expect(html).not.toContain('bn-pause');
    expect(html).toContain('3 funcionários');
  });

  it('projeto sem nenhuma tarefa aberta, mas pausado: o selo aparece mesmo assim', () => {
    const html = room({ open: 0, review: 0, paused: PAUSE });
    expect(html).toContain('bn-tag is-paused');
  });

  it('pausado e sem resumo (sem funcionário): a linha do selo existe mesmo sem o texto do resumo', () => {
    const data = { project: project(), live: [], liveWho: [], cost: null, archived: false, image: null, header: { color: null, sideAt: null, collapsed: false, resources: 0 }, git: null, tasks: { open: 0, review: 0, paused: PAUSE }, awaiting: 0, employees: 0 };
    const props = { id: 'p:p', data, selected: false, width: 640 } as unknown as Parameters<typeof ProjectNode>[0];
    expect(renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(ProjectNode, props)))).toContain('<div class="bn-meta"');
  });

  it('pasta do projeto sumiu: sem botão de retomar', () => {
    expect(room({ open: 0, review: 0, paused: PAUSE }, false)).not.toContain('bn-pause');
  });

  it('o botão do cabeçalho mostra só o estado de retomar (o clique é tratado no Board, pela classe)', () => {
    const html = renderToStaticMarkup(createElement(ResumeChip));
    expect(html).toContain('class="bn-pause nodrag is-paused"');
    expect(html).toContain('aria-label="Retomar projeto"');
  });
});

describe('o quadro de tarefas: onde a pausa é ligada', () => {
  const board = (initialPause?: { at: string } | null) =>
    renderToStaticMarkup(
      createElement(TasksBoard, { projectId: 'p', projectName: 'Projeto', staff: [], costs: null, onClose: () => {}, onOpenStaff: () => {}, onChanged: () => {}, initialTasks: [], initialPause }),
    );

  it('pausado: faixa no quadro e botão "Retomar projeto" no cabeçalho', () => {
    const html = board(PAUSE);
    expect(html).toContain('class="project-paused"');
    expect(html).toContain('Projeto pausado desde ');
    expect(html).toContain('Retomar projeto');
    expect(html).not.toContain('Pausar projeto');
  });

  it('rodando: botão "Pausar projeto" e nenhuma faixa', () => {
    const html = board(null);
    expect(html).toContain('Pausar projeto');
    expect(html).not.toContain('project-paused');
  });

  it('sem ler o estado (ainda lendo ou servidor sem as rotas): nem botão nem faixa, o quadro segue igual', () => {
    const html = board(undefined);
    expect(html).not.toContain('project-pause-btn');
    expect(html).not.toContain('project-paused');
    expect(html).toContain('tasks-columns');
  });
});
