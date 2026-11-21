import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, PermissionWait, Task } from '../shared/model';
import { permissionTarget, permissionText } from '../client/src/tasks/PermissionWait';
import { TasksBoard } from '../client/src/tasks/TasksBoard';

// A conversa da tarefa espera o dono responder um pedido de permissão (contrato: `Task.permissionWait`, tests/permissionWait.test.ts no servidor).
// Aqui: o texto do selo (pendente e parada), o item da caixa que o atalho abre e a ligação no quadro (cartão e detalhe).

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const wait = (over: Partial<PermissionWait> = {}): PermissionWait => ({ tool: 'Bash', since: ago(4), stuck: false, ...over });
/** Para o quadro, que lê a hora de verdade (Date.now()): o pedido espera há min minutos de agora. */
const agoReal = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

describe('permissionText: o que o selo diz', () => {
  it('pendente: a ferramenta e há quanto tempo, sem "Parada"', () => {
    const text = permissionText(wait(), 'Ana', NOW)!;
    expect(text.stuck).toBe(false);
    expect(text.head).toBe('Esperando sua permissão: Bash · há 4min');
    expect(text.hint).toContain('A conversa de Ana pediu uma permissão (Bash)');
  });

  it('passou de 15 min (o servidor marca `stuck`): a palavra "Parada" abre o texto e a frase diz o porquê', () => {
    const text = permissionText(wait({ since: ago(17), stuck: true }), 'Ana', NOW)!;
    expect(text.stuck).toBe(true);
    expect(text.head).toBe('Parada: esperando sua permissão: Bash · há 17min');
    expect(text.hint).toContain('mais de 15 min');
  });

  it('sem pedido, ou sem a ferramenta legível: nada', () => {
    expect(permissionText(undefined, 'Ana', NOW)).toBeNull();
    expect(permissionText(wait({ tool: '' }), 'Ana', NOW)).toBeNull();
  });

  it('hora ilegível: o texto sai sem o tempo; dono sem ficha na lista: "o funcionário"', () => {
    const text = permissionText(wait({ since: 'ontem' }), null, NOW)!;
    expect(text.head).toBe('Esperando sua permissão: Bash');
    expect(text.hint).toContain('A conversa de o funcionário');
  });

  it('o plano pronto (ExitPlanMode) vira "aprovar o plano"; com o selo de plano no cartão só a parada repete o aviso', () => {
    expect(permissionText(wait({ tool: 'ExitPlanMode' }), 'Ana', NOW)!.head).toBe('Esperando sua permissão: aprovar o plano · há 4min');
    expect(permissionText(wait({ tool: 'ExitPlanMode' }), 'Ana', NOW, true)).toBeNull();
    expect(permissionText(wait({ tool: 'ExitPlanMode', since: ago(20), stuck: true }), 'Ana', NOW, true)!.head).toContain('Parada');
  });
});

describe('permissionTarget: para onde o atalho leva', () => {
  const project = { id: 'p', name: 'Projeto' };
  const task = { id: 't-perm01', staffId: 'ana-1', sessionId: 'sess-1' };
  const item = (over: Partial<InboxItem>): InboxItem => ({ id: 'perm:p:r1', kind: 'permission', projectId: 'p', projectName: 'Projeto', sessionId: 'sess-1', staffId: 'ana-1', name: 'Ana', summary: 'Bash ls', at: ago(4), itemId: 'p:r1', ...over });

  it('com o item da caixa: o próprio item, que leva ao cartão do pedido (itemId)', () => {
    const real = item({});
    expect(permissionTarget(task, [item({ sessionId: 'outra' }), real], project)).toBe(real);
    const plan = item({ kind: 'plan', itemId: 'p:r2' });
    expect(permissionTarget(task, [plan], project)).toBe(plan);
  });

  it('item de outra espécie na mesma conversa não vale (um erro não é o cartão do pedido)', () => {
    const target = permissionTarget(task, [item({ kind: 'error', id: 'error:sess-1' })], project)!;
    expect(target.id).toBe('perm-wait:t-perm01');
  });

  it('a caixa ainda não leu o pedido: abre a conversa da tarefa (sem rolar até um cartão)', () => {
    const target = permissionTarget(task, [], project)!;
    expect(target).toMatchObject({ kind: 'permission', projectId: 'p', projectName: 'Projeto', sessionId: 'sess-1', staffId: 'ana-1' });
    expect(target.itemId).toBeUndefined();
  });

  it('sem conversa na tarefa: sem atalho', () => {
    expect(permissionTarget({ ...task, sessionId: null }, [item({})], project)).toBeNull();
  });
});

describe('o quadro de tarefas: onde o selo, o atalho e o bloco são ligados', () => {
  const full = (over: Partial<Task> = {}): Task =>
    ({ id: 't-perm01', title: 'Exportar em CSV', description: 'exportar', status: 'doing', staffId: 'ana-1', sessionId: 'sess-1', plan: null, branch: null, pr: null, history: [], createdAt: agoReal(60), updatedAt: agoReal(3), permissionWait: wait({ since: agoReal(4) }), ...over }) as Task;

  /** O quadro de verdade no servidor, com a tarefa já carregada e o detalhe aberto: separa o que é do cartão do que é do detalhe. */
  const board = (over: Partial<Task> = {}, props: Record<string, unknown> = { onOpenInbox: () => {} }) => {
    const t = full(over);
    const html = renderToStaticMarkup(
      createElement(TasksBoard, { projectId: 'p', projectName: 'Projeto', staff: [], costs: null, onClose: () => {}, onOpenStaff: () => {}, onChanged: () => {}, initialTasks: [t], initialTaskId: t.id, ...props }),
    );
    const at = html.indexOf('<aside class="task-detail">');
    expect(at).toBeGreaterThan(0);
    return { card: html.slice(0, at), detail: html.slice(at) };
  };

  it('pendente: selo amarelo (tone-action, o mesmo da caixa) no cartão com o atalho fora do botão; o detalhe tem o bloco e o botão', () => {
    const { card, detail } = board();
    expect(card).toMatch(/<span class="task-queue task-permission tone-action small" title="[^"]+">Esperando sua permissão: Bash · há [^<]+<\/span>/);
    expect(card).not.toContain('is-stuck');
    // O atalho é irmão do botão do cartão: depois do </button> do cartão, nunca dentro dele.
    const closeCard = card.indexOf('</button>');
    expect(card.indexOf('task-perm-go')).toBeGreaterThan(closeCard);
    expect(card).toMatch(/<button class="btn-secondary task-perm-go"[^>]*>Responder no chat<\/button>/);
    expect(detail).toContain('<div class="task-perm">');
    // O botão é a ação principal do rodapé fixo (uma vez só), não mais um botão dentro do cartão do pedido.
    expect(detail.match(/<button type="button" class="btn-primary"[^>]*>Responder no chat<\/button>/g)).toHaveLength(1);
    expect(detail.indexOf('Responder no chat</button>')).toBeGreaterThan(detail.indexOf('task-detail-foot'));
  });

  it('parada (passou de 15 min): o cartão e o detalhe marcam is-stuck e dizem "Parada"', () => {
    const { card, detail } = board({ permissionWait: wait({ since: agoReal(17), stuck: true }) });
    expect(card).toContain('task-permission tone-action is-stuck small');
    expect(card).toContain('Parada: esperando sua permissão: Bash · há 17min');
    expect(detail).toContain('<div class="task-perm is-stuck">');
  });

  it('sem `onOpenInbox` (quem monta o quadro não liga o atalho): o selo fica, o botão não', () => {
    const { card, detail } = board({}, {});
    expect(card).toContain('Esperando sua permissão: Bash');
    expect(card).not.toContain('task-perm-go');
    expect(detail).toContain('task-perm');
    expect(detail).not.toContain('Responder no chat');
  });

  it('sem `permissionWait` (respondeu, ou nunca houve): nenhum selo, atalho nem bloco', () => {
    const { card, detail } = board({ permissionWait: undefined });
    expect(card + detail).not.toContain('task-permission');
    expect(card + detail).not.toContain('task-perm');
    expect(card + detail).not.toContain('Responder no chat');
  });

  it('plano esperando (item `plan` na caixa): o selo "Plano para aprovar" basta; o do pedido só aparece parado', () => {
    const plan = { id: 'perm:p:r2', kind: 'plan', projectId: 'p', projectName: 'Projeto', sessionId: 'sess-1', staffId: 'ana-1', name: 'Ana', summary: 'plano pronto para aprovar', at: ago(2), itemId: 'p:r2' } as InboxItem;
    const waiting = board({ status: 'planning', permissionWait: wait({ tool: 'ExitPlanMode', since: agoReal(4) }) }, { onOpenInbox: () => {}, inboxItems: [plan] });
    expect(waiting.card).not.toContain('task-permission');
    expect(waiting.detail).not.toContain('task-perm');
    const stuck = board({ status: 'planning', permissionWait: wait({ tool: 'ExitPlanMode', since: agoReal(20), stuck: true }) }, { onOpenInbox: () => {}, inboxItems: [plan] });
    expect(stuck.card).toContain('Parada: esperando sua permissão: aprovar o plano');
  });
});

describe('idiomas e CSS', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  const inLocale = async (locale: string) => {
    vi.resetModules();
    vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
    return import('../client/src/tasks/PermissionWait');
  };

  it('en e es: selo pendente, parada e o plano', async () => {
    const en = await inLocale('en');
    expect(en.permissionText(wait(), 'Ana', NOW)!.head).toMatch(/^Waiting for your permission: Bash · 4min ago$/);
    expect(en.permissionText(wait({ since: ago(17), stuck: true }), 'Ana', NOW)!.head).toMatch(/^Stuck: waiting for your permission: Bash/);
    expect(en.permissionText(wait({ tool: 'ExitPlanMode' }), 'Ana', NOW)!.head).toContain('approve the plan');
    const es = await inLocale('es');
    expect(es.permissionText(wait(), 'Ana', NOW)!.head).toMatch(/^Esperando tu permiso: Bash · hace 4min$/);
    expect(es.permissionText(wait({ since: ago(17), stuck: true }), 'Ana', NOW)!.head).toMatch(/^Parada: esperando tu permiso: Bash/);
    expect(es.permissionText(wait({ tool: 'ExitPlanMode' }), 'Ana', NOW)!.head).toContain('aprobar el plan');
  });

  it('o CSS do selo só usa tokens (nenhuma cor solta) e o amarelo é o do --tone-action', () => {
    const css = readFileSync('client/src/styles.css', 'utf8');
    const lines = css.split('\n').filter((l) => /\.task-permission|\.task-perm-go|\.task-perm\b/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const l of lines) expect(l).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(lines.join('\n')).toContain('var(--tone-action)');
    expect(lines.join('\n')).toContain('var(--tone-action-ink)');
  });
});
