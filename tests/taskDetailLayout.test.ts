import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StaffProfile, Task } from '../shared/model';
import tasksMsgs from '../client/src/i18n/tasks';
import { ActionBar } from '../client/src/lib/ActionBar';
import { footerPlan, ownerAsks } from '../client/src/tasks/detailActions';
import { TasksBoard } from '../client/src/tasks/TasksBoard';
import { keyboardInset } from '../client/src/tasks/useKeyboardInset';

// O painel da tarefa: faixa "Precisa de você", cartões, modo leitura e o rodapé fixo (ActionBar). Quais ações existem em cada estado (a regra de
// sempre) e onde ficam (só no rodapé, sem duplicar); o ActionBar aplica a hierarquia de botões por construção.

const noop = () => {};
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ANA = { id: 'ana-1', name: 'Ana', role: 'Dev', reportsTo: [], servers: [] } as unknown as StaffProfile;

const task = (over: Partial<Task> = {}): Task =>
  ({ id: 't-lay001', title: 'Exportar em CSV', description: 'Passo a passo:\n\n- abrir a tela\n- clicar em `Exportar`', acceptance: 'Baixa um `.csv` com `client/src/app.ts`', status: 'doing', staffId: 'ana-1', sessionId: 'sess-1', plan: null, branch: null, pr: null, history: [], createdAt: ago(60), updatedAt: ago(3), ...over }) as Task;

/** O detalhe de verdade (SSR), com a tarefa já carregada: só o painel, do `<aside>` em diante. */
const detail = (t: Task, props: Record<string, unknown> = {}) => {
  const html = renderToStaticMarkup(
    createElement(TasksBoard, { projectId: 'p', projectName: 'Projeto', staff: [ANA], costs: null, onClose: noop, onOpenStaff: noop, onChanged: noop, initialTasks: [t], initialTaskId: t.id, onOpenInbox: noop, ...props }),
  );
  const at = html.indexOf('<aside class="task-detail">');
  expect(at).toBeGreaterThan(0);
  return html.slice(at);
};
/** O rodapé: da barra de ações até o fim do `<footer>`. */
const footer = (html: string) => html.slice(html.indexOf('<footer class="task-detail-foot">'));
/** O teste que vale para qualquer painel com ActionBar: no máximo um `btn-primary` na barra. */
const primaries = (bar: string) => (bar.match(/class="btn-primary/g) ?? []).length;
const count = (html: string, text: string) => html.split(text).length - 1;

describe('ActionBar: a regra de hierarquia por construção', () => {
  const render = (props: Partial<Parameters<typeof ActionBar>[0]> = {}) =>
    renderToStaticMarkup(createElement(ActionBar, { label: 'Ações', moreLabel: 'Mais ações', ...props }));

  it('uma primária só (o `primary` é um objeto, não uma lista), sempre por último: [⋯] [secundárias] [reservado] [primária]', () => {
    const out = render({
      primary: { id: 'ok', label: 'Aprovar entrega' },
      secondary: [{ id: 'a', label: 'Abrir conversa' }],
      more: [{ id: 'm', label: 'Apagar tarefa', danger: true }],
      reserved: 'reject',
    });
    expect(primaries(out)).toBe(1);
    const at = (s: string) => out.indexOf(s);
    expect(at('⋯')).toBeLessThan(at('Abrir conversa'));
    expect(at('Abrir conversa')).toBeLessThan(at('data-slot="reject"'));
    expect(at('data-slot="reject"')).toBeLessThan(at('Aprovar entrega'));
  });

  it('destrutiva: contorno vermelho (`btn-secondary is-danger`) e nunca primária, mesmo se pedirem', () => {
    const out = render({ primary: { id: 'x', label: 'Apagar tarefa', danger: true }, more: [{ id: 'm', label: 'Cancelar tarefa', danger: true }] });
    expect(out).toContain('class="btn-secondary is-danger action-bar-item"');
    expect(out).toMatch(/<button type="button" class="btn-primary"[^>]*>Apagar tarefa/);
    expect(out).not.toMatch(/btn-primary is-danger/);
  });

  it('primária desligada diz o motivo ao lado (e o leitor de tela o lê); sem motivo, nada', () => {
    const out = render({ primary: { id: 'go', label: 'Começar', disabled: true, disabledReason: 'Escolha quem cuida da tarefa' } });
    expect(out).toContain('<p id="go-why" class="action-bar-why">Escolha quem cuida da tarefa</p>');
    expect(out).toContain('aria-describedby="go-why"');
    expect(render({ primary: { id: 'go', label: 'Começar' } })).not.toContain('action-bar-why');
  });

  it('enviando: o rótulo vira "enviando…" e o botão fica desligado (sem clique duplo)', () => {
    const out = render({ primary: { id: 'gb', label: 'Devolver ao responsável', busy: true } });
    expect(out).toContain('enviando…');
    expect(out).not.toContain('Devolver ao responsável');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"/);
  });

  it('secundária com painel abre um painel acima da barra (não age direto); sem "⋯" quando não há itens', () => {
    const out = render({ secondary: [{ id: 'd', label: 'Delegar revisão', panel: createElement('p', null, 'quem revisa') }] });
    expect(out).toContain('<summary class="btn-secondary">Delegar revisão</summary>');
    expect(out).toContain('quem revisa');
    expect(out).not.toContain('action-bar-more');
  });
});

describe('footerPlan: as ações por estado (a regra de quando aparecem é a de sempre; muda só onde ficam)', () => {
  const plan = (t: Task, over: Partial<Parameters<typeof footerPlan>[0]> = {}) =>
    footerPlan({ task: t, asks: ownerAsks({ task: t, hasPermission: false, plan: null }), queuePos: 0, canOpenPermission: true, hasChat: !!t.sessionId, ...over });

  it('aguardar e a fazer (nunca começou): Começar é a principal; mover, cancelar e apagar no "⋯"', () => {
    for (const status of ['waiting', 'todo'] as const) {
      const p = plan(task({ status, sessionId: null }));
      expect(p).toMatchObject({ primary: 'start', secondary: [], more: ['move', 'cancel', 'delete'] });
    }
  });

  it('na fila: sem Começar (já está na fila); "Tirar da fila" entra no "⋯"', () => {
    const p = plan(task({ status: 'todo', sessionId: null }), { queuePos: 2 });
    expect(p.primary).toBeNull();
    expect(p.more).toEqual(['move', 'unqueue', 'cancel', 'delete']);
  });

  it('fazendo: a próxima ação natural é abrir a conversa', () => {
    expect(plan(task())).toMatchObject({ primary: 'openChat', secondary: [], more: ['move', 'cancel', 'delete'] });
  });

  it('revisão: Aprovar principal; Delegar revisão e Abrir conversa secundárias', () => {
    expect(plan(task({ status: 'review' }))).toMatchObject({ primary: 'approve', secondary: ['delegate', 'openChat'], more: ['move', 'cancel', 'delete'] });
  });

  it('pronto: nada pede o dono (sem principal); cancelar não cabe numa tarefa encerrada', () => {
    expect(plan(task({ status: 'done' }))).toMatchObject({ primary: null, secondary: ['openChat'], more: ['move', 'delete'] });
  });

  it('cancelada: Reabrir é a principal (a única saída útil); não há "Mover para" (o servidor pede reabrir antes)', () => {
    expect(plan(task({ status: 'cancelled' }))).toMatchObject({ primary: 'reopen', secondary: ['openChat'], more: ['delete'] });
  });

  it('o que espera o dono toma a principal: sem código (Devolver), permissão, dúvida, follow-up; Aprovar desce para as secundárias', () => {
    const nocode = task({ noCode: { since: ago(5), to: 'owner' } });
    expect(plan(nocode, { asks: ownerAsks({ task: nocode, hasPermission: false, plan: null }) }).primary).toBe('giveBack');
    const doubt = task({ status: 'review', question: { id: 'q-1', source: 'text', text: 'Qual formato?', status: 'escalated', askedAt: ago(5) } });
    const p = plan(doubt, { asks: ownerAsks({ task: doubt, hasPermission: true, plan: null }) });
    expect(p.primary).toBe('goPermission');
    const noPerm = plan(doubt, { asks: ownerAsks({ task: doubt, hasPermission: true, plan: null }), canOpenPermission: false });
    expect(noPerm).toMatchObject({ primary: 'goCard', goCard: 'doubt' });
    expect(noPerm.secondary).toContain('approve');
  });
});

describe('ownerAsks: só o que é decisão do dono', () => {
  it('conta permissão, sem código com o dono, dúvida escalada, follow-up para o dono e revisão do dono', () => {
    const t = task({
      status: 'review',
      noCode: undefined,
      question: { id: 'q-1', source: 'text', text: 'x', status: 'escalated', askedAt: ago(5) },
      followUps: [
        { id: 'f-aaaaaa', by: 'rui-1', at: ago(5), text: 'limpar', status: 'open', to: 'owner' },
        { id: 'f-bbbbbb', by: 'rui-1', at: ago(5), text: 'outro', status: 'open', to: 'manager' },
      ],
    } as Partial<Task>);
    const asks = ownerAsks({ task: t, hasPermission: true, plan: { kind: 'owner', why: 'self' } });
    expect(asks.map((a) => a.card)).toEqual(['permission', 'doubt', 'followup', 'review']);
    expect(asks.find((a) => a.card === 'followup')?.params).toEqual({ n: 1 });
  });

  it('não conta o que é de outro: pedido de cancelamento, dúvida com o gestor, aviso sem código com o gestor, revisão de funcionário', () => {
    const t = task({
      status: 'review',
      cancelRequest: { status: 'pending', by: 'maestro', reason: 'r', at: ago(1) },
      question: { id: 'q-2', source: 'text', text: 'x', status: 'open', askedAt: ago(5) },
    } as Partial<Task>);
    expect(ownerAsks({ task: t, hasPermission: false, plan: { kind: 'staff', id: 'rui-1', from: 'task' } })).toEqual([]);
    const nc = task({ noCode: { since: ago(5), to: 'manager' } });
    expect(ownerAsks({ task: nc, hasPermission: false, plan: null })).toEqual([]);
  });
});

describe('o painel de verdade (SSR): ordem, rodapé e sem duplicar', () => {
  const states: Task['status'][] = ['waiting', 'todo', 'doing', 'review', 'done', 'cancelled'];

  it('o id fica numa linha própria acima do título, com a mesma classe do id do cartão, e não repete no selo de estado', () => {
    const html = detail(task());
    const head = html.slice(html.indexOf('<header class="task-detail-head">'), html.indexOf('</header>'));
    expect(head).toMatch(/^<header class="task-detail-head"><span class="task-id muted small"[^>]*>t-lay001<\/span><div class="task-detail-top">/);
    expect(count(head, 't-lay001')).toBe(1);
  });

  it('o rodapé existe fora do corpo que rola, em todo estado, com no máximo um btn-primary', () => {
    for (const status of states) {
      const html = detail(task({ status, sessionId: status === 'waiting' || status === 'todo' ? null : 'sess-1' }));
      expect(html).toContain('<div class="task-detail-body"');
      const bodyEnd = html.indexOf('</div><footer class="task-detail-foot">');
      expect(bodyEnd, status).toBeGreaterThan(0);
      expect(primaries(footer(html)), status).toBeLessThanOrEqual(1);
      expect(primaries(html.slice(0, bodyEnd)), `${status}: nenhum btn-primary no corpo`).toBe(0);
    }
  });

  it('ações por estado, uma vez cada: Começar, Aprovar, Reabrir, Cancelar, Apagar, Abrir conversa', () => {
    const waiting = detail(task({ status: 'waiting', sessionId: null }));
    expect(count(waiting, '>Começar<')).toBe(1);
    expect(count(waiting, '>Cancelar tarefa<')).toBe(1);
    expect(count(waiting, '>Apagar tarefa<')).toBe(1);
    const review = detail(task({ status: 'review' }));
    expect(count(review, '>Aprovar entrega<')).toBe(1);
    expect(count(review, '>Abrir a conversa com Ana<')).toBe(1);
    expect(review).toContain('>Delegar revisão<');
    expect(review).toContain('data-slot="reject"');
    expect(detail(task({ status: 'doing' }))).not.toContain('data-slot="reject"');
    const cancelled = detail(task({ status: 'cancelled', cancelledAt: ago(2) }));
    expect(count(cancelled, '>Reabrir<')).toBe(1);
    expect(cancelled).not.toContain('>Cancelar tarefa<');
    expect(cancelled).not.toContain('Mover para a coluna');
    const done = detail(task({ status: 'done' }));
    expect(done).not.toContain('>Aprovar entrega<');
    expect(done).not.toContain('>Começar<');
  });

  it('o "⋯" guarda Mover para, Tirar da fila, Cancelar e Apagar; os dois últimos em contorno vermelho', () => {
    const html = footer(detail(task({ status: 'doing' })));
    expect(html).toContain('aria-label="Mais ações da tarefa"');
    expect(html).toContain('Mover para a coluna');
    expect(html).toContain('class="btn-secondary is-danger action-bar-item" title="Fecha a tarefa sem entregar: não conta como pronta e dá para reabrir.">Cancelar tarefa');
    expect(html).toMatch(/is-danger action-bar-item">Apagar tarefa/);
  });

  it('ordem dos blocos: cabeçalho, faixa, revisão, dúvida, permissão, follow-up, sem código, cancelamento, tarefa, recolhidos', () => {
    const html = detail(
      task({
        status: 'review',
        permissionWait: { tool: 'Bash', since: ago(4), stuck: false },
        question: { id: 'q-1', source: 'text', text: 'Qual formato?', status: 'escalated', askedAt: ago(5) },
        followUps: [{ id: 'f-aaaaaa', by: 'rui-1', at: ago(5), text: 'limpar', status: 'open', to: 'owner' }],
        cancelRequest: { status: 'pending', by: 'maestro', reason: 'duplicada', at: ago(1) },
        review: { staffId: 'rui-1', at: ago(2), doneAt: ago(1), verdict: 'rejected' },
      } as Partial<Task>),
    );
    const marks = ['task-detail-head', 'task-asks', 'task-review-box', 'data-card="doubt"', 'data-card="permission"', 'data-card="followup"', 'data-card="cancelreq"', 'class="task-read"', '>Código, revisão e deploy<', '>Histórico<', 'task-detail-foot'];
    const at = marks.map((m) => html.indexOf(m));
    expect(at.every((i) => i >= 0), JSON.stringify(marks.filter((_, i) => at[i]! < 0))).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toContain('Precisa de você (4)');
  });

  it('sem código (doing): o cartão no lugar certo, Devolver uma vez só e no rodapé', () => {
    const html = detail(task({ noCode: { since: ago(5), to: 'owner', summary: 'Li o código.' } }));
    expect(html.indexOf('data-card="nocode"')).toBeGreaterThan(html.indexOf('task-asks'));
    expect(count(html, 'Devolver ao responsável</button>')).toBe(1);
    expect(html.indexOf('Devolver ao responsável</button>')).toBeGreaterThan(html.indexOf('task-detail-foot'));
    expect(html).toContain('Terminou sem código: devolver ou cancelar');
  });

  it('leitura por padrão, em qualquer coluna: critério visível e formatado; descrição recolhida; nenhum campo até "Editar"', () => {
    for (const status of states) {
      const html = detail(task({ status, sessionId: status === 'waiting' || status === 'todo' ? null : 'sess-1' }));
      const body = html.slice(0, html.indexOf('<footer'));
      expect(body, status).not.toContain('<textarea');
      expect(body, status).not.toContain('<input');
      expect(body, status).toContain('>Editar<');
      // O critério vem antes de qualquer seção recolhida da tarefa e já em markdown (código e caminho em <code>).
      const accept = body.indexOf('task-accept');
      expect(accept, status).toBeGreaterThan(0);
      expect(body.slice(accept, body.indexOf('</section>', accept))).toContain('<code>client/src/app.ts</code>');
      expect(body, status).toMatch(/<details class="collapse"><summary>Descrição<\/summary>[\s\S]*<li>abrir a tela<\/li>/);
    }
  });

  it('esperas em Aguardar e A fazer: nota de leitura (não campo), já aberta; nas outras colunas, recolhida', () => {
    const blockedTask = (status: Task['status']) => task({ status, sessionId: null, blockedBy: ['t-dep1'] });
    const dep = { id: 't-dep1', title: 'Base da API', description: '', staffId: null, plan: null, history: [], blockedBy: [], status: 'doing', createdAt: ago(90), updatedAt: ago(80) } as unknown as Task;
    const render = (status: Task['status']) => {
      const t = blockedTask(status);
      const html = renderToStaticMarkup(createElement(TasksBoard, { projectId: 'p', projectName: 'P', staff: [ANA], costs: null, onClose: noop, onOpenStaff: noop, onChanged: noop, initialTasks: [t, dep], initialTaskId: t.id }));
      return html.slice(html.indexOf('<aside class="task-detail">'));
    };
    const todo = render('todo');
    expect(todo).toMatch(/<details class="collapse" open=""><summary class="has-sum">Esperas e fila/);
    expect(todo).toMatch(/<p class="task-note tone-wait">[^<]*Base da API/);
    expect(render('waiting')).toMatch(/<details class="collapse" open=""><summary class="has-sum">Esperas e fila/);
    // Fora dessas colunas a dependência já não segura a tarefa: nenhuma seção aberta de esperas.
    expect(render('doing')).not.toMatch(/open=""><summary class="has-sum">Esperas e fila/);
  });
});

describe('CSS do painel e textos', () => {
  const css = readFileSync('client/src/styles.css', 'utf8');
  const rule = (sel: string) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';

  it('o painel não rola; o corpo rola; o rodapé não encolhe e respeita a área segura', () => {
    expect(rule('.task-detail')).toMatch(/overflow: hidden/);
    expect(rule('.task-detail')).toMatch(/flex-direction: column/);
    expect(rule('.task-detail-body')).toMatch(/overflow-y: auto/);
    expect(rule('.task-detail-body')).toMatch(/min-height: 0/);
    expect(rule('.task-detail-foot')).toMatch(/flex: none/);
    expect(rule('.task-detail-foot')).toContain('env(safe-area-inset-bottom)');
  });

  it('celular com teclado aberto: nenhuma regra esconde o rodapé quando um campo recebe foco', () => {
    expect(css).not.toMatch(/:focus\)[^{]*\.task-detail-foot[^{]*\{[^}]*display: none/);
    expect(css).not.toMatch(/\.task-detail:has\(/);
  });

  it('teclado virtual que só cobre a página: o painel sobe o tanto coberto; sem teclado, zoom ou barra de endereço, 0', () => {
    expect(keyboardInset(740, { height: 440, offsetTop: 0, scale: 1 })).toBe(300);
    expect(keyboardInset(740, { height: 740, offsetTop: 0, scale: 1 })).toBe(0);
    expect(keyboardInset(740, { height: 690, offsetTop: 0, scale: 1 })).toBe(0); // barra de endereço
    expect(keyboardInset(740, { height: 300, offsetTop: 0, scale: 2 })).toBe(0); // pinça
    // Teclado que encolhe o layout: `innerHeight` já é a altura visível.
    expect(keyboardInset(440, { height: 440, offsetTop: 0, scale: 1 })).toBe(0);
  });

  it('celular: alvo de toque de 44 px, foco visível e a primária em largura inteira embaixo', () => {
    expect(css).toMatch(/\.action-bar :is\(\.action-bar-pop > summary[^)]*\) \{ min-height: 28px/);
    expect(css).toMatch(/\.action-bar :is\([^)]*\):focus-visible \{ outline: 2px solid/);
    expect(css).toMatch(/@media \(max-width: 640px\) \{\s*\.action-bar > \.btn-primary \{ flex: 1 0 100%; \}/);
  });

  it('os textos novos existem nos 3 idiomas com os mesmos {parâmetros}', () => {
    const pt = tasksMsgs['pt-BR'] as Record<string, string>;
    const keys = Object.keys(pt).filter((k) => /^tasks\.(asks|ask[A-Z]|foot|more|moreTitle|unqueueMenu|head|sectionTask|edit|acceptanceNone|sectionWaits)|^actionBar\./.test(k));
    expect(keys.length).toBeGreaterThanOrEqual(24);
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const locale of ['en', 'es'] as const) {
      const msgs = tasksMsgs[locale] as Record<string, string>;
      for (const key of keys) {
        expect(msgs[key], `${locale} ${key}`).toBeTruthy();
        expect(vars(msgs[key]!), `${locale} ${key}`).toEqual(vars(pt[key]!));
      }
    }
  });
});
