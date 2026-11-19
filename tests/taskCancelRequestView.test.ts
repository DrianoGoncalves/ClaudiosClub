import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import tasksMsgs from '../client/src/i18n/tasks';
import { askerName, cancelBadgeText, cancelDelivery, cancelledRole, cancelledWho, duplicateWarnings } from '../client/src/tasks/cancelRequest';
import { CancelRequestBadge, CancelRequestBlock, DuplicateNote } from '../client/src/tasks/TaskCancelRequest';
import type { CancelRequest, TaskCreateWarning } from '../shared/model';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const NAMES: Record<string, string> = { ana: 'Ana', beto: 'Beto' };
const nameOf = (id: string | null) => (id ? (NAMES[id] ?? null) : null);

const pending = (over: Partial<CancelRequest> = {}): CancelRequest => ({ by: 'ana', reason: 'o cliente desistiu', at: '2026-11-17T11:48:00Z', status: 'pending', ...over });
const refused = (over: Partial<CancelRequest> = {}): CancelRequest =>
  pending({ status: 'refused', decidedAt: '2026-11-17T11:55:00Z', decidedBy: 'beto', answer: 'já está quase pronta', ...over });
const block = (request: CancelRequest | undefined, open = true) =>
  renderToStaticMarkup(createElement(CancelRequestBlock, { request, staffName: 'Beto', nameOf, now: NOW, open }));

describe('quem cancelou, e em que papel', () => {
  const task = { requestedBy: 'ana', staffId: 'beto' };

  it('você pela tela não tem papel; solicitante e responsável têm', () => {
    expect(cancelledRole({ ...task, cancelledBy: 'user' })).toBeNull();
    expect(cancelledRole({ ...task, cancelledBy: undefined })).toBeNull();
    expect(cancelledRole({ ...task, cancelledBy: 'ana' })).toBe('requester');
    expect(cancelledRole({ ...task, cancelledBy: 'beto' })).toBe('worker');
  });

  it('quem pediu e fazia é o mesmo funcionário, ou ninguém reconhecido: sem papel (não dá para dizer qual dos dois)', () => {
    expect(cancelledRole({ requestedBy: 'ana', staffId: 'ana', cancelledBy: 'ana' })).toBeNull();
    expect(cancelledRole({ ...task, cancelledBy: 'caio' })).toBeNull();
    expect(cancelledRole({ requestedBy: null, staffId: null, cancelledBy: 'caio' })).toBeNull();
  });

  it('o texto leva o nome e o papel; o id vale quando a ficha sumiu', () => {
    expect(cancelledWho({ ...task, cancelledBy: 'ana' }, nameOf)).toBe('Ana (quem pediu a tarefa)');
    expect(cancelledWho({ ...task, cancelledBy: 'beto' }, nameOf)).toBe('Beto (quem fazia a tarefa)');
    expect(cancelledWho({ ...task, cancelledBy: 'user' }, nameOf)).toBe('você');
    expect(cancelledWho({ requestedBy: 'zed', staffId: 'beto', cancelledBy: 'zed' }, nameOf)).toBe('zed (quem pediu a tarefa)');
  });
});

describe('selo do cartão: pedido de cancelamento', () => {
  it('esperando decisão e recusado têm selo; aceito, sem efeito e sem pedido não', () => {
    expect(cancelBadgeText(pending(), nameOf)).toBe('Pedido de cancelamento de Ana');
    expect(cancelBadgeText(refused(), nameOf)).toBe('Cancelamento recusado');
    expect(cancelBadgeText(pending({ status: 'accepted' }), nameOf)).toBeNull();
    expect(cancelBadgeText(pending({ status: 'moot' }), nameOf)).toBeNull();
    expect(cancelBadgeText(undefined, nameOf)).toBeNull();
  });

  it('sem ficha, o id de quem pediu', () => {
    expect(askerName({ by: 'x1' }, nameOf)).toBe('x1');
  });

  it('o selo é neutro (sem amarelo nem laranja) e o title traz o motivo, ou o porquê da recusa; escapa o texto', () => {
    const p = renderToStaticMarkup(createElement(CancelRequestBadge, { request: pending({ reason: '<b>x</b> & y' }), nameOf }));
    expect(p).toContain('task-badge task-cancelreq small');
    expect(p).not.toMatch(/is-waiting|task-wait/);
    expect(p).toContain('title="Pedido de cancelamento de Ana: &lt;b&gt;x&lt;/b&gt; &amp; y"');
    const r = renderToStaticMarkup(createElement(CancelRequestBadge, { request: refused(), nameOf }));
    expect(r).toContain('title="Cancelamento recusado: já está quase pronta"');
    expect(renderToStaticMarkup(createElement(CancelRequestBadge, { request: pending({ status: 'accepted' }), nameOf }))).toBe('');
  });
});

describe('onde o pedido está', () => {
  it('chegou, espera a vez do responsável, a entrega falhou ou está saindo', () => {
    expect(cancelDelivery({ deliveredAt: '2026-11-17T11:49:00Z' })).toBe('delivered');
    expect(cancelDelivery({ waiting: 'Beto está em “Exportar CSV”' })).toBe('waiting');
    expect(cancelDelivery({ retry: { attempts: 1, nextAt: '2026-11-17T12:01:00Z', firstAt: '2026-11-17T11:48:30Z' } })).toBe('retry');
    expect(cancelDelivery({})).toBe('sending');
  });
});

describe('bloco do detalhe: pedido de cancelamento', () => {
  it('sem pedido: nada', () => {
    expect(block(undefined)).toBe('');
  });

  it('esperando: quem pediu, quando, o motivo, onde está e que você pode cancelar já', () => {
    const html = block(pending({ deliveredAt: '2026-11-17T11:49:00Z' }));
    expect(html).toContain('task-cancelreq-box');
    expect(html).not.toContain('is-decided');
    expect(html).toContain('aguardando Beto');
    expect(html).toContain('Ana pediu há 12min');
    expect(html).toContain('Motivo: o cliente desistiu');
    expect(html).toContain('O pedido chegou à conversa de Beto, que decide.');
    expect(html).toContain('Você pode cancelar já, com “Cancelar tarefa”.');
  });

  it('esperando mas ainda fora da conversa dele: diz que espera a vez (texto do servidor, só em pt, não é usado)', () => {
    const html = block(pending({ waiting: 'Beto está em “Exportar CSV”' }));
    expect(html).toContain('Ainda não chegou: Beto está em outra tarefa e vê o pedido na vez dele.');
    expect(html).not.toContain('Exportar CSV');
  });

  it('tarefa já encerrada: não oferece "Cancelar tarefa"', () => {
    expect(block(pending(), false)).not.toContain('Cancelar tarefa');
    expect(block(refused(), false)).not.toContain('Cancelar tarefa');
  });

  it('recusado: quem recusou, quando e o porquê; o aviso a quem pediu que ainda não chegou', () => {
    const html = block(refused({ notifyRetry: { attempts: 0, nextAt: '2026-11-17T11:55:00Z', firstAt: '2026-11-17T11:55:00Z' } }));
    expect(html).toContain('is-decided');
    expect(html).toContain('>recusado<');
    expect(html).toContain('Recusado por Beto há 5min.');
    expect(html).toContain('Motivo da recusa: já está quase pronta');
    expect(html).toContain('O aviso da recusa para Ana ainda não chegou');
    expect(html).toContain('A tarefa segue. Você pode cancelar já');
  });

  it('aceito: quem aceitou (o responsável, ou você ao cancelar pela tela)', () => {
    expect(block(pending({ status: 'accepted', decidedBy: 'beto', decidedAt: '2026-11-17T11:50:00Z' }), false)).toContain('Aceito por Beto há 10min: a tarefa foi cancelada.');
    expect(block(pending({ status: 'accepted', decidedBy: 'user', decidedAt: '2026-11-17T11:50:00Z' }), false)).toContain('Aceito por você há 10min');
  });

  it('sem efeito: a tarefa ficou pronta antes da decisão', () => {
    const html = block(pending({ status: 'moot' }), false);
    expect(html).toContain('>sem efeito<');
    expect(html).toContain('A tarefa ficou pronta antes de alguém decidir');
  });

  it('motivo e resposta saem escapados (texto puro, sem HTML)', () => {
    const html = block(refused({ reason: '<img src=x onerror=1>', answer: '<script>1</script>' }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
  });
});

describe('aviso de possível duplicata na criação', () => {
  const warn = (over: Partial<TaskCreateWarning> = {}): TaskCreateWarning => ({
    code: 'possible-duplicate',
    message: 'possível duplicata de “Ajustar o login” (id t-aaaaaa)…',
    taskId: 't-aaaaaa',
    title: 'Ajustar o login',
    status: 'doing',
    createdAt: '2026-11-17T11:57:00Z',
    ...over,
  });
  const note = (warnings: TaskCreateWarning[], createdId: string | null = 't-bbbbbb') =>
    renderToStaticMarkup(createElement(DuplicateNote, { warnings, now: NOW, statusLabel: (s) => `[${s}]`, onOpen: () => {}, onClose: () => {}, createdId }));

  it('só o código conhecido vira aviso; sem `warnings` ou resposta nula, nenhum', () => {
    expect(duplicateWarnings(null)).toEqual([]);
    expect(duplicateWarnings({})).toEqual([]);
    expect(duplicateWarnings({ warnings: [warn(), { ...warn({ taskId: 't-cccccc' }), code: 'outro' as 'possible-duplicate' }] })).toHaveLength(1);
  });

  it('a linha sai do título, da coluna e da hora da parecida (e não da mensagem em pt do servidor)', () => {
    const html = note([warn()]);
    expect(html).toContain('Possível duplicata');
    expect(html).toContain('“Ajustar o login” ([doing], criada há 3min) tem título parecido e o mesmo responsável.');
    expect(html).not.toContain('possível duplicata de');
    expect(html).toContain('A tarefa nova foi criada mesmo assim.');
    expect(html).toContain('Ver a nova');
    expect(html).toContain('Entendi');
  });

  it('amarelo do "precisa de você": a classe é a da caixa amarela e o link herda a cor do texto', () => {
    expect(note([warn()])).toContain('class="task-dup"');
  });

  it('várias parecidas, uma linha cada; título escapado; sem lista, nada', () => {
    const html = note([warn(), warn({ taskId: 't-cccccc', title: '<i>x</i>' })]);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(note([])).toBe('');
  });

  it('sem id da nova tarefa, não mostra "Ver a nova"', () => {
    expect(note([warn()], null)).not.toContain('Ver a nova');
  });
});

describe('textos nos 3 idiomas', () => {
  it('en e es têm todas as chaves novas do pt', () => {
    const keys = Object.keys(tasksMsgs['pt-BR']).filter((k) => /^tasks\.(cancelReq|dup|cancelledAs)/.test(k));
    expect(keys).toHaveLength(28);
    for (const locale of ['en', 'es'] as const) {
      for (const k of keys) {
        const text = (tasksMsgs[locale] as Record<string, string>)[k];
        expect(text, `${locale} ${k}`).toBeTruthy();
        // Os mesmos {parâmetros} do pt: texto sem um deles deixaria a tela sem o nome ou o motivo.
        const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(vars(text!), `${locale} ${k}`).toEqual(vars((tasksMsgs['pt-BR'] as Record<string, string>)[k]!));
      }
    }
  });
});
