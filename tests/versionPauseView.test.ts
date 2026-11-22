import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import detailMessages from '../client/src/i18n/detail';
import tasksMessages from '../client/src/i18n/tasks';
import type { Board, ProjectPause, StaffProfile } from '../shared/model';
import { StaffForm } from '../client/src/staff/HireForm';
import { TasksBoard } from '../client/src/tasks/TasksBoard';
import { createPauseController, minutesLabel, pauseHeading, pausedTip, versionBy, versionLeft, type PauseView } from '../client/src/tasks/pauseState';
import { PausedBanner, PausedTag, PauseButton, VersionPauseControl } from '../client/src/tasks/ProjectPauseBar';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Hora local: o dia 21/11 às 14:00, a pausa de versão dura 30 min (até 14:30) e "agora" é 14:06 (faltam 24 min).
const AT = new Date(2026, 10, 21, 14, 0).toISOString();
const UNTIL = new Date(2026, 10, 21, 14, 30).toISOString();
const NOW = new Date(2026, 10, 21, 14, 6).getTime();
const OWNER: ProjectPause = { at: AT, mode: 'version', until: UNTIL };
const BY_STAFF: ProjectPause = { ...OWNER, by: { staffId: 'denzel-1', name: 'Denzel' } };
const COMMON: ProjectPause = { at: AT };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stubFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  return fetch;
};
const sent = (fetch: ReturnType<typeof stubFetch>, n = 0) => fetch.mock.calls[n] as unknown as [string, RequestInit];

describe('o que falta e quem ligou', () => {
  it('minutos em texto: arredonda para cima, nunca "0 min", horas quando passa de 60', () => {
    expect(minutesLabel(24)).toBe('24 min');
    expect(minutesLabel(23.2)).toBe('24 min');
    expect(minutesLabel(0)).toBe('1 min');
    expect(minutesLabel(60)).toBe('1 h');
    expect(minutesLabel(65)).toBe('1 h 05 min');
    expect(minutesLabel(120)).toBe('2 h');
  });

  it('"faltam 24 min"; passado o prazo, "termina agora"; pausa comum ou sem pausa: vazio', () => {
    expect(versionLeft(OWNER, NOW)).toBe('faltam 24 min');
    expect(versionLeft(OWNER, new Date(2026, 10, 21, 14, 31).getTime())).toBe('termina agora');
    expect(versionLeft(COMMON, NOW)).toBe('');
    expect(versionLeft(null, NOW)).toBe('');
  });

  it('quem ligou: o dono (sem `by`) é "você"; o funcionário aparece pelo nome', () => {
    expect(versionBy(OWNER)).toBe('Ligada por você');
    expect(versionBy(BY_STAFF)).toBe('Ligada por Denzel');
  });

  it('título e dica: a de versão traz o que falta, quem ligou e a hora de saída; a comum segue igual', () => {
    expect(pauseHeading(OWNER, NOW)).toBe('Pausa de versão · faltam 24 min');
    expect(pausedTip(BY_STAFF, NOW)).toBe('Pausa de versão · faltam 24 min. Ligada por Denzel. Nada novo entra em Fazendo; o que está em andamento termina. Sai sozinha às 14:30.');
    expect(pauseHeading(COMMON, NOW)).toBe('Projeto pausado desde hoje às 14:00');
    expect(pausedTip(COMMON, NOW)).toBe('Projeto pausado desde hoje às 14:00. Nada novo começa sozinho.');
  });
});

describe('selo, faixa e controle', () => {
  it('selo da versão: "Pausa de versão · 24 min", classe is-version e dica com quem ligou', () => {
    const html = renderToStaticMarkup(createElement(PausedTag, { pause: BY_STAFF, now: NOW, className: 'badge is-paused' }));
    expect(html).toContain('Pausa de versão · 24 min');
    expect(html).toContain('is-paused is-version');
    expect(html).toContain('Ligada por Denzel');
  });

  it('selo da pausa comum: como era ("Pausado", sem is-version)', () => {
    const html = renderToStaticMarkup(createElement(PausedTag, { pause: COMMON, now: NOW, className: 'badge is-paused' }));
    expect(html).toContain('Pausado');
    expect(html).not.toContain('is-version');
    expect(html).not.toContain('Pausa de versão');
  });

  it('faixa da versão: o que falta, quem ligou (dono: "você") e a hora de saída; a comum não muda', () => {
    const v = renderToStaticMarkup(createElement(PausedBanner, { pause: OWNER, now: NOW }));
    expect(v).toContain('Pausa de versão · faltam 24 min');
    expect(v).toContain('Ligada por você');
    expect(v).toContain('Sai sozinha às 14:30');
    expect(v).toContain('role="status"');
    const c = renderToStaticMarkup(createElement(PausedBanner, { pause: COMMON, now: NOW }));
    expect(c).toContain('Projeto pausado desde hoje às 14:00');
    expect(c).not.toContain('is-version');
  });

  it('botão: na de versão diz "Encerrar pausa"; na comum segue "Retomar projeto"; rodando, "Pausar projeto"', () => {
    const end = renderToStaticMarkup(createElement(PauseButton, { paused: true, version: true, onClick: () => {} }));
    expect(end).toContain('Encerrar pausa');
    expect(end).not.toContain('Retomar projeto');
    expect(renderToStaticMarkup(createElement(PauseButton, { paused: true, onClick: () => {} }))).toContain('Retomar projeto');
    expect(renderToStaticMarkup(createElement(PauseButton, { paused: false, onClick: () => {} }))).toContain('Pausar projeto');
  });

  it('controle: prazos 15/30/60/120 min com 30 selecionado, e o botão Ligar pausa', () => {
    const html = renderToStaticMarkup(createElement(VersionPauseControl, { onStart: () => {} }));
    expect(html).toContain('Pausa de versão');
    expect(html).toMatch(/<option value="30" selected="">30 min<\/option>/);
    for (const label of ['15 min', '1 h', '2 h']) expect(html).toContain(`>${label}</option>`);
    expect(html).toContain('Ligar pausa');
    expect(renderToStaticMarkup(createElement(VersionPauseControl, { busy: true, onStart: () => {} }))).toContain('disabled');
  });
});

describe('controlador: ligar com prazo e encerrar antes', () => {
  const make = (initial?: ProjectPause | null) => {
    const views: PauseView[] = [];
    const onChanged = vi.fn();
    const c = createPauseController({ projectId: 'p', name: 'MyCo', initial, onView: (v) => views.push(v), onChanged });
    return { c, views, onChanged };
  };

  it('liga: POST .../version-pause com { minutes }, mostra o estado novo e avisa o App', async () => {
    const fetch = stubFetch(() => json({ paused: OWNER }));
    const { c, onChanged } = make(null);
    await c.startVersion(45);
    const [url, init] = sent(fetch);
    expect(url).toBe('/api/projects/p/version-pause');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ minutes: 45 });
    expect(c.view.pause).toEqual(OWNER);
    expect(c.view.error).toBeNull();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('só liga com o projeto rodando: pausado (qualquer modo) ou sem leitura, nada é enviado', async () => {
    const fetch = stubFetch(() => json({ paused: OWNER }));
    await make(COMMON).c.startVersion(30);
    await make(OWNER).c.startVersion(30);
    await make(undefined).c.startVersion(30);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('encerra antes: o botão (toggle) na de versão chama .../version-pause/end, sem pergunta, e volta a rodando', async () => {
    const fetch = stubFetch(() => json({ paused: null }));
    const { c, onChanged } = make(BY_STAFF);
    await c.toggle();
    expect(sent(fetch)[0]).toBe('/api/projects/p/version-pause/end');
    expect(c.view.pause).toBeNull();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('a pausa comum segue igual: toggle com pausa comum chama .../resume', async () => {
    const fetch = stubFetch(() => json({ paused: null }));
    const { c } = make(COMMON);
    await c.toggle();
    expect(sent(fetch)[0]).toBe('/api/projects/p/resume');
    expect(c.view.pause).toBeNull();
  });

  it('409 (já há pausa comum ou de outra pessoa): erro no idioma da tela, estado e App não mudam', async () => {
    stubFetch(() => json({ error: 'o projeto está em pausa comum: ela segue até o usuário retomar' }, 409));
    const { c, onChanged } = make(null);
    await c.startVersion(30);
    expect(c.view.pause).toBeNull();
    expect(c.view.error).toBe('O projeto já está pausado (pausa comum ou de versão de outra pessoa). Atualize a tela.');
    expect(c.view.busy).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('403 ao ligar: "só você" no idioma da tela, não o texto do servidor', async () => {
    stubFetch(() => json({ error: 'só você, pelo Claudio’s Club' }, 403));
    const { c } = make(null);
    await c.startVersion(30);
    expect(c.view.error).toBe('Só você pode ligar ou encerrar a pausa de versão por aqui, pelo próprio Claudio’s Club.');
  });

  it('leitura: a mudança de prazo ou de quem ligou aparece (não só a de horário)', async () => {
    const later = { ...OWNER, until: new Date(2026, 10, 21, 15, 0).toISOString() };
    stubFetch(() => json({ paused: later }));
    const { c, views } = make(OWNER);
    await c.read();
    expect(c.view.pause).toEqual(later);
    expect(views).toHaveLength(1);
  });
});

describe('o quadro de tarefas', () => {
  const board = (initialPause?: ProjectPause | null) =>
    renderToStaticMarkup(
      createElement(TasksBoard, { projectId: 'p', projectName: 'Projeto', staff: [], costs: null, onClose: () => {}, onOpenStaff: () => {}, onChanged: () => {}, initialTasks: [], initialPause }),
    );

  it('rodando: o controle "Pausa de versão" aparece junto de "Pausar projeto", sem faixa', () => {
    const html = board(null);
    expect(html).toContain('version-pause-control');
    expect(html).toContain('Pausar projeto');
    expect(html).not.toContain('project-paused');
  });

  it('pausa de versão: faixa com quem ligou, botão "Encerrar pausa" e sem o controle de ligar', () => {
    const html = board(BY_STAFF);
    expect(html).toContain('project-paused is-version');
    expect(html).toContain('Ligada por Denzel');
    expect(html).toContain('Encerrar pausa');
    expect(html).not.toContain('version-pause-control');
    expect(html).not.toContain('Retomar projeto');
  });

  it('pausa comum: igual a hoje (faixa e "Retomar projeto"), sem controle de versão', () => {
    const html = board(COMMON);
    expect(html).toContain('class="project-paused"');
    expect(html).toContain('Retomar projeto');
    expect(html).not.toContain('version-pause-control');
    expect(html).not.toContain('Encerrar pausa');
  });

  it('sem ler o estado: nem controle nem faixa', () => {
    const html = board(undefined);
    expect(html).not.toContain('version-pause-control');
    expect(html).not.toContain('project-paused');
  });
});

describe('textos nos três idiomas e a ficha', () => {
  it('tasks.versionPause*/versionPaused* existem em pt-BR, en e es com as mesmas chaves', () => {
    const t = tasksMessages as unknown as Record<string, Record<string, string>>;
    const pick = (lang: string) => Object.keys(t[lang] ?? {}).filter((k) => /^tasks\.versionPause/.test(k)).sort();
    expect(pick('pt-BR').length).toBeGreaterThanOrEqual(15);
    expect(pick('en')).toEqual(pick('pt-BR'));
    expect(pick('es')).toEqual(pick('pt-BR'));
  });

  it('detail.canRelease existe nos três idiomas', () => {
    const d = detailMessages as unknown as Record<string, Record<string, string>>;
    for (const lang of ['pt-BR', 'en', 'es']) {
      expect(d[lang]?.['detail.canRelease']).toBeTruthy();
      expect(d[lang]?.['detail.canReleaseHint']).toBeTruthy();
    }
    expect(d['pt-BR']?.['detail.canRelease']).toBe('Pode versionar e fazer deploy');
  });

  it('ficha aberta: "Pode versionar e fazer deploy" vem logo após "Pode contratar", desligada por padrão e ligada se a ficha tem', () => {
    const open = (canRelease?: boolean) => {
      const profile = { id: 's1', projectId: 'p1', name: 'Jinx', role: 'Dev', mission: 'm', autonomy: 'manual', skills: [], agents: [], servers: [], reportsTo: [], rules: [], knowledge: [], canHire: false, ...(canRelease !== undefined && { canRelease }) } as unknown as StaffProfile;
      const board = { projects: [{ id: 'p1', name: 'Loja', path: 'C:/loja', exists: true }], inventories: {}, user: { agents: [], skills: [] }, staff: [] } as unknown as Board;
      return renderToStaticMarkup(createElement(StaffForm, { board, projectId: 'p1', mode: { kind: 'edit', profile }, onClose: () => {}, onHired: () => {}, onSaved: () => {} }));
    };
    const row = (html: string) => html.match(/<label class="check"><input type="checkbox"([^>]*)><span class="check-text"><span>Pode versionar e fazer deploy<\/span>/);
    const off = open();
    expect(row(off)?.[1]).not.toContain('checked');
    expect(off.indexOf('Pode contratar subfuncionários')).toBeGreaterThan(-1);
    expect(off.indexOf('Pode versionar e fazer deploy')).toBeGreaterThan(off.indexOf('Pode contratar subfuncionários'));
    expect(row(open(true))?.[1]).toContain('checked');
  });

  it('HireForm: "Pode versionar e fazer deploy" é um label.check igual ao de "Pode contratar", padrão desligado, e vai no pedido', () => {
    const src = readFileSync('client/src/staff/HireForm.tsx', 'utf8');
    expect(src).toContain('useState(editing?.canRelease ?? false)');
    expect(src).toMatch(/<input type="checkbox" checked=\{canRelease\} onChange=\{\(e\) => setCanRelease\(e\.target\.checked\)\} \/>/);
    expect(src).toMatch(/<label className="check">\s*<input type="checkbox" checked=\{canRelease\}/);
    expect(src).toContain("t('detail.canRelease')");
    expect(src).toMatch(/canHire,\s*canRelease,/);
  });
});
