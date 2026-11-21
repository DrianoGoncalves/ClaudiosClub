import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import tasksMsgs from '../client/src/i18n/tasks';
import staffMsgs from '../client/src/i18n/staff';
import { alertAction, isTaskAlert, stuckNoCodeOf, stuckText, taskIdOf } from '../client/src/inbox/taskAlerts';
import { giveBackBody, giveBackHeldNote, noCodeOf } from '../client/src/tasks/noCode';
import { NoCodeBadge, NoCodeBlock } from '../client/src/tasks/TaskNoCode';
import { TasksBoard } from '../client/src/tasks/TasksBoard';
import type { InboxItem, Task } from '../shared/model';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Card = código: o card que termina o turno sem editar nada não vai para revisão (`Task.noCode`, tests/noCode.test.ts). Na tela: selo no cartão, bloco no detalhe e, quando quem decide é
// você, o item "stuck" da caixa com "Cancelar" (com motivo) e "Devolver ao responsável" (uma mensagem na conversa de trabalho).

const AT = '2026-11-18T10:00:00Z';
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const noop = () => {};
const nameOf = (id: string | null) => ({ ana: 'Ana', beto: 'Beto' })[id ?? ''] ?? null;
const task = (over: Partial<Task> = {}): Task =>
  ({ id: 't-aaaaaa', title: 'Mapear as telas', description: 'd', status: 'doing', staffId: 'beto', sessionId: 'sess-w', requestedBy: 'ana', createdAt: AT, updatedAt: AT, history: [], plan: null, branch: null, pr: null, ...over }) as Task;
const marked = (over: Partial<NonNullable<Task['noCode']>> = {}, taskOver: Partial<Task> = {}) => task({ noCode: { since: AT, summary: 'Li o código: o helper de data tem duas cópias, não há o que editar.', to: 'owner', ...over }, ...taskOver });

describe('a marca "sem código"', () => {
  it('vale só com o card em "fazendo" (mover o card a desfaz)', () => {
    expect(noCodeOf(marked())).toMatchObject({ to: 'owner' });
    expect(noCodeOf(marked({}, { status: 'review' }))).toBeNull();
    expect(noCodeOf(task())).toBeNull();
  });

  it('devolver ao responsável é uma mensagem na conversa de trabalho dele, no idioma da tela; sem conversa, não há a quem devolver', () => {
    const body = giveBackBody(task());
    expect(body).toMatchObject({ sessionId: 'sess-w', staffId: 'beto' });
    expect(body!.text).toContain('terminou sem editar nenhum arquivo');
    expect(giveBackBody(task({ sessionId: null }))).toBeNull();
    expect(giveBackBody(null)).toBeNull();
    expect(giveBackBody(task({ staffId: null }))?.staffId).toBeNull();
  });

  it('mensagem guardada (funcionário ocupado) avisa para não mandar de novo; entregue (ou envio cancelado) não avisa', () => {
    expect(giveBackHeldNote({ held: 'Beto está em “Exportar CSV”' })).toContain('Não mande de novo');
    expect(giveBackHeldNote({})).toBeNull();
    expect(giveBackHeldNote(null)).toBeNull();
    expect(giveBackHeldNote(undefined)).toBeNull();
  });

  it('a mensagem sai pela rota de enviar da conversa, com o corpo do rascunho (é ela que desfaz a marca no servidor)', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ sessionId: 'sess-w' }), { status: 200 })));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const { api } = await import('../client/src/api');
    await api.chatSend('p-1', { ...giveBackBody(task())!, force: false });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/p-1/chat/send');
    expect(JSON.parse(init.body as string)).toMatchObject({ sessionId: 'sess-w', staffId: 'beto', force: false });
  });
});

describe('selo do cartão', () => {
  const badge = (t: Task) => html(createElement(NoCodeBadge, { task: t }));

  it('"Sem código", só texto (o cartão é um botão); amarelo só quando espera você', () => {
    const owner = badge(marked());
    expect(owner).toContain('Sem código');
    expect(owner).toContain('tone-action');
    expect(owner).not.toContain('<button');
    expect(badge(marked({ to: 'manager' }))).not.toContain('tone-action');
  });

  it('sem a marca (ou fora de "fazendo"), nada', () => {
    expect(badge(task())).toBe('');
    expect(badge(marked({}, { status: 'done' }))).toBe('');
  });
});

describe('bloco do detalhe', () => {
  const block = (t: Task) => html(createElement(NoCodeBlock, { task: t, nameOf }));

  it('com você: por que parou e o que o responsável disse; as saídas (Devolver, Cancelar) ficam no rodapé fixo, não no cartão', () => {
    const out = block(marked());
    expect(out).toContain('Terminou sem editar código');
    expect(out).toContain('Espera você: cancelar com motivo ou devolver ao responsável.');
    expect(out).toContain('Li o código: o helper de data tem duas cópias');
    expect(out).toContain('O que o responsável disse ao terminar');
    expect(out).not.toContain('<button');
  });

  it('mensagem guardada: aviso neutro (role status, sem a classe de erro), não um alerta; sem a nota, nada', () => {
    const held = giveBackHeldNote({ held: 'Beto está em “Exportar CSV”' })!;
    const out = html(createElement(NoCodeBlock, { task: marked(), nameOf, note: held }));
    expect(out).toContain('role="status"');
    expect(out).toContain('A mensagem ficou guardada');
    expect(out).not.toContain('role="alert"');
    expect(out).not.toContain('class="error');
    expect(block(marked())).not.toContain('task-nocode-note');
  });

  it('com o gestor: diz quem decide e não oferece as saídas (ele decide pela conversa dele)', () => {
    const out = block(marked({ to: 'manager' }));
    expect(out).toContain('Espera Ana, que pediu o card');
    expect(out).not.toContain('<button');
  });

  it('o que o responsável disse é texto puro: HTML nele não vira marcação', () => {
    const out = block(marked({ summary: '<img src=x onerror=alert(1)> <b>x</b>' }));
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('sem resumo, sem o bloco de "o que disse"; sem a marca, nada', () => {
    expect(block(marked({ summary: undefined }))).not.toContain('O que o responsável disse');
    expect(block(task())).toBe('');
  });
});

describe('no quadro', () => {
  const render = (t: Task) => {
    const out = html(createElement(TasksBoard, { projectId: 'p-1', projectName: 'Projeto', staff: [], costs: null, onClose: noop, onOpenStaff: noop, onChanged: noop, initialTasks: [t], initialTaskId: t.id }));
    const at = out.indexOf('<aside class="task-detail">');
    expect(at).toBeGreaterThan(0);
    return { card: out.slice(0, at), detail: out.slice(at) };
  };

  it('o cartão leva o selo e o detalhe o bloco com as saídas; o card normal em "fazendo" não leva nenhum', () => {
    const { card, detail } = render(marked());
    expect(card).toContain('task-nocode');
    expect(card).toContain('Sem código');
    expect(detail).toContain('task-nocode-box');
    expect(detail).toContain('Devolver ao responsável');
    expect(detail.match(/Devolver ao responsável<\/button>/g)).toHaveLength(1);
    const plain = render(task());
    expect(plain.card).not.toContain('Sem código');
    expect(plain.detail).not.toContain('task-nocode-box');
  });
});

// O item da caixa: o servidor manda `stuck.noCode` + `stuck.summary` quando quem pediu é você (ou o aviso ao gestor se perdeu).
describe('item da caixa', () => {
  const stuck = (over: Partial<NonNullable<InboxItem['stuck']>> = {}): InboxItem => ({
    id: 'stuck:t-aaaaaa:decide',
    kind: 'stuck',
    projectId: 'p-1',
    projectName: 'MyCo',
    sessionId: '',
    staffId: 'beto',
    name: 'Beto',
    summary: '“Mapear as telas” está parada: terminou o turno sem editar código',
    at: AT,
    stuck: { taskId: 't-aaaaaa', taskTitle: 'Mapear as telas', reason: 'r', selfHeals: false, humanAction: 'decide', since: AT, noCode: true, summary: 'Li o código.', ...over },
  });

  it('é reconhecido pela marca `noCode`; o "stuck" comum não é', () => {
    expect(stuckNoCodeOf(stuck())?.summary).toBe('Li o código.');
    expect(stuckNoCodeOf(stuck({ noCode: undefined }))).toBeNull();
    expect(stuckNoCodeOf({ kind: 'error' })).toBeNull();
  });

  it('a frase diz card = código e as duas saídas, no idioma da tela; o "Decidir" que só abre o card sai (a caixa mostra Cancelar e Devolver)', () => {
    expect(stuckText(stuck())).toBe('“Mapear as telas” terminou o turno sem editar código (card = código): cancele com motivo ou devolva ao responsável');
    expect(alertAction(stuck())).toBeNull();
    // A parada comum em Aguardar segue com o "Decidir".
    expect(alertAction(stuck({ noCode: undefined }))?.action).toBe('decide');
    expect(stuckText(stuck({ noCode: undefined }))).toContain('está em Aguardar');
  });

  it('segue sendo item de tarefa: abre o card e não pinta de amarelo a conversa do funcionário', () => {
    expect(taskIdOf(stuck())).toBe('t-aaaaaa');
    expect(isTaskAlert(stuck())).toBe(true);
  });
});

describe('textos nos 3 idiomas', () => {
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('en e es têm as chaves do card sem código (tela e caixa), com os mesmos {parâmetros}', () => {
    for (const [msgs, re, expected] of [
      [tasksMsgs, /^tasks\.noCode/, 13],
      [staffMsgs, /^inbox\.(stuck\.noCode|noCode\.)/, 2],
    ] as const) {
      const pt = msgs['pt-BR'] as Record<string, string>;
      const keys = Object.keys(pt).filter((k) => re.test(k));
      expect(keys).toHaveLength(expected);
      for (const locale of ['en', 'es'] as const) {
        for (const key of keys) {
          const text = (msgs[locale] as Record<string, string>)[key];
          expect(text, `${locale} ${key}`).toBeTruthy();
          expect(vars(text!), `${locale} ${key}`).toEqual(vars(pt[key]!));
        }
      }
    }
  });
});
