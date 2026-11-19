import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client/src/api';
import appMsgs from '../client/src/i18n/app';
import staffMsgs from '../client/src/i18n/staff';
import tasksMsgs from '../client/src/i18n/tasks';
import { inboxText } from '../client/src/inbox/inboxText';
import type { Tr } from '../client/src/inbox/secretText';
import { taskIdOf } from '../client/src/inbox/taskAlerts';
import { decisionErrorText, decisionOf, followUpAuthor, followUpBadgeText, followUpHasMore, followUpLine, followUpState, followUpText, openFollowUps } from '../client/src/tasks/followUp';
import { FollowUpBadge, FollowUpBlock, FollowUpBlockView, FollowUpDecide, FollowUpGoneNote, sendDecision, submitDecision, type DecisionOutcome, type SubmitSetters } from '../client/src/tasks/TaskFollowUps';
import type { FollowUp, InboxItem, Task } from '../shared/model';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NOW = Date.parse('2026-11-18T12:00:00Z');
const NAMES: Record<string, string> = { ana: 'Ana', beto: 'Beto', rev: 'Rita' };
const nameOf = (id: string | null) => (id ? (NAMES[id] ?? null) : null);

const fu = (over: Partial<FollowUp> = {}): FollowUp => ({ id: 'f-a1b2c3', by: 'rev', at: '2026-11-18T10:00:00Z', text: 'Extrair o helper de data.\nHoje há duas cópias.', status: 'open', to: 'manager', ...over });
const task = (followUps: FollowUp[], over: Partial<Task> = {}): Task => ({ id: 't-aaaaaa', title: 'Tela do selo', status: 'done', staffId: 'beto', requestedBy: 'ana', createdAt: '2026-11-17T09:00:00Z', followUps, ...over }) as Task;
const sibling = (id: string, title: string, createdAt: string, extra: Partial<Task> = {}): Task => ({ id, title, status: 'todo', createdAt, ...extra }) as Task;
const noop = () => {};
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const block = (t: Task, tasks: Task[] = [t]) => html(createElement(FollowUpBlock, { task: t, tasks, nameOf, now: NOW, projectId: 'p-1', onOpenTask: noop, onChanged: noop }));

describe('em que pé está o follow-up', () => {
  const ctx = { requestedBy: 'ana', nameOf, now: NOW };

  it('aberto com o gestor: diz quem pediu a tarefa; avisado mostra há quanto tempo; aviso que não chegou diz que tenta de novo', () => {
    expect(followUpState(fu(), ctx).lines).toEqual(['Espera Ana, que pediu a tarefa.']);
    expect(followUpState(fu({ deliveredAt: '2026-11-18T10:30:00Z' }), ctx).lines[0]).toMatch(/^Espera Ana, que pediu a tarefa\. Avisado há /);
    const retry = followUpState(fu({ notifyRetry: { attempts: 1, firstAt: '2026-11-18T10:00:00Z', nextAt: '2026-11-18T12:05:00Z' } as FollowUp['notifyRetry'] }), ctx).lines[0];
    expect(retry).toContain('O aviso a Ana ainda não chegou');
    expect(retry).toContain('passa para você');
  });

  it('gestor que não se conhece (ficha sumiu) vira "o gestor", nunca o id', () => {
    expect(followUpState(fu(), { ...ctx, requestedBy: 'zed' }).lines[0]).toBe('Espera o gestor, que pediu a tarefa.');
    expect(followUpState(fu(), { ...ctx, requestedBy: null }).lines[0]).toBe('Espera o gestor, que pediu a tarefa.');
  });

  it('aberto com você: pedido por você, ou o aviso ao gestor não chegou', () => {
    expect(followUpState(fu({ to: 'owner' }), ctx)).toMatchObject({ kind: 'open', badge: 'Aberto', lines: ['Espera você.'] });
    expect(followUpState(fu({ to: 'owner', escalatedAt: '2026-11-18T10:40:00Z' }), ctx).lines[0]).toContain('o aviso ao gestor não chegou');
  });

  it('virou card: quem decidiu (você pela tela, o gestor pelo nome) e quando', () => {
    const byYou = followUpState(fu({ status: 'resolved', resolution: 'card', resolvedBy: 'you', resolvedAt: '2026-11-18T11:00:00Z', cardId: 't-bbbbbb' }), ctx);
    expect(byYou).toMatchObject({ kind: 'card', badge: 'Virou card' });
    expect(byYou.lines[0]).toMatch(/^Decidido por você há /);
    expect(followUpState(fu({ status: 'resolved', resolution: 'card', resolvedBy: 'ana', resolvedAt: '2026-11-18T11:00:00Z' }), ctx).lines[0]).toMatch(/^Decidido por Ana há /);
  });

  it('quem decidiu sem ficha (saiu do projeto) ou sem registro vira "alguém", nunca o id', () => {
    const base = { status: 'resolved', resolution: 'discarded', resolvedAt: '2026-11-18T11:00:00Z' } as const;
    expect(followUpState(fu({ ...base, resolvedBy: 'ghost' }), ctx).lines[0]).toMatch(/^Decidido por alguém há /);
    expect(followUpState(fu({ ...base, resolvedBy: undefined }), ctx).lines[0]).toMatch(/^Decidido por alguém há /);
    expect(followUpState(fu({ ...base, resolvedBy: 'ghost' }), ctx).lines[0]).not.toContain('ghost');
  });

  it('descartado: o motivo vem numa linha; sem motivo, só quem decidiu', () => {
    const base = { status: 'resolved', resolution: 'discarded', resolvedBy: 'you', resolvedAt: '2026-11-18T11:59:50Z' } as const;
    const withNote = followUpState(fu({ ...base, note: 'já coberto pela t-cccccc' }), ctx);
    expect(withNote).toMatchObject({ kind: 'discarded', badge: 'Descartado' });
    expect(withNote.lines).toEqual(['Decidido por você agora', 'Motivo: já coberto pela t-cccccc']);
    expect(followUpState(fu(base), ctx).lines).toHaveLength(1);
  });

  it('só os abertos contam para o selo, e o singular é singular', () => {
    const t = task([fu(), fu({ id: 'f-000002', status: 'resolved', resolution: 'discarded' }), fu({ id: 'f-000003' })]);
    expect(openFollowUps(t).map((f) => f.id)).toEqual(['f-a1b2c3', 'f-000003']);
    expect(followUpBadgeText(1)).toBe('1 follow-up aberto');
    expect(followUpBadgeText(2)).toBe('2 follow-ups abertos');
    expect(openFollowUps({})).toEqual([]);
  });
});

describe('item do follow-up na caixa', () => {
  const item = (followUp: InboxItem['followUp'] | undefined, over: Partial<InboxItem> = {}): InboxItem => ({
    id: 'followup:t-aaaaaa:f-a1b2c3',
    kind: 'followUp',
    projectId: 'p-1',
    projectName: 'MyCo',
    sessionId: '',
    staffId: null,
    name: 'Beto',
    summary: '“Tela do selo” tem um follow-up de Rita esperando você: Extrair o helper de data.',
    at: '2026-11-18T10:00:00Z',
    ...(followUp && { followUp }),
    ...over,
  });
  const f = (over: Partial<NonNullable<InboxItem['followUp']>> = {}) => ({ taskId: 't-aaaaaa', taskTitle: 'Tela do selo', followUpId: 'f-a1b2c3', by: 'rev', byName: 'Rita', text: 'Extrair o helper de data.\nHoje há duas cópias.', at: '2026-11-18T10:00:00Z', ...over });

  it('a frase sai da estrutura: tarefa, autor e a primeira linha do achado', () => {
    expect(inboxText(item(f()))).toBe('“Tela do selo” tem um follow-up de Rita esperando você: Extrair o helper de data.');
  });

  it('autor sem ficha: "revisão", nunca vazio; sem a estrutura (servidor antigo), o summary', () => {
    expect(inboxText(item(f({ byName: '' })))).toContain('follow-up de revisão esperando você');
    expect(inboxText(item(undefined))).toBe(item(undefined).summary);
    expect(followUpText({ summary: 'x', followUp: undefined })).toBe('x');
  });

  it('autor sem ficha: o cartão e a caixa chamam do mesmo jeito (nunca pelo id)', () => {
    expect(followUpAuthor({ by: 'ghost' }, nameOf)).toBe('revisão');
    expect(followUpAuthor({ by: 'rev' }, nameOf)).toBe('Rita');
    expect(followUpText(item(f({ by: 'ghost', byName: '' })))).toContain(`follow-up de ${followUpAuthor({ by: 'ghost' }, nameOf)} esperando você`);
    expect(followUpText(item(f({ by: 'ghost', byName: '' })))).not.toContain('ghost');
  });

  it('o card que o item abre é o da tarefa do follow-up', () => {
    expect(taskIdOf(item(f()))).toBe('t-aaaaaa');
    expect(taskIdOf(item(undefined))).toBeUndefined();
  });

  it('a linha corta em 140; "ver o texto inteiro" só quando há mais que a linha', () => {
    const long = 'x'.repeat(200);
    expect(followUpLine(long)).toHaveLength(140);
    expect(followUpLine(long).endsWith('…')).toBe(true);
    expect(followUpHasMore(long)).toBe(true);
    expect(followUpHasMore('Uma linha só.')).toBe(false);
    expect(followUpHasMore('Linha 1\nLinha 2')).toBe(true);
    expect(followUpHasMore('  Uma linha só.  \n')).toBe(false);
  });

  it('espaço duplo ou tabulação dentro de uma linha só não conta como "mais texto": compara com a linha normalizada', () => {
    expect(followUpLine('Uma  linha\tcom   espaços.')).toBe('Uma linha com espaços.');
    expect(followUpHasMore('Uma  linha\tcom   espaços.')).toBe(false);
    expect(followUpHasMore('\n\n  Linha  depois de vazias  \r\n')).toBe(false);
    // O que a linha de fato esconde segue oferecendo o texto inteiro.
    expect(followUpHasMore('Linha  1\nLinha  2')).toBe(true);
    expect(followUpHasMore(`${'palavra '.repeat(30)}fim`)).toBe(true);
    expect(followUpHasMore('x'.repeat(140))).toBe(false);
    expect(followUpHasMore('x'.repeat(141))).toBe(true);
  });
});

describe('o corpo do POST de decidir', () => {
  it('"virou card" (a rota `resolve` ainda aceita): o card só vai se foi indicado', () => {
    expect(decisionOf('card', '')).toEqual({ resolution: 'card' });
    expect(decisionOf('card', 't-bbbbbb')).toEqual({ resolution: 'card', cardId: 't-bbbbbb' });
  });

  it('"descartar": o motivo vai aparado e só se escrito; nunca leva cardId (o servidor recusa)', () => {
    expect(decisionOf('discard', '')).toEqual({ resolution: 'discarded' });
    expect(decisionOf('discard', '   ')).toEqual({ resolution: 'discarded' });
    expect(decisionOf('discard', '  já coberto  ')).toEqual({ resolution: 'discarded', reason: 'já coberto' });
    expect(decisionOf('discard', 'x')).not.toHaveProperty('cardId');
  });
});

describe('selo do cartão', () => {
  const badge = (t: Pick<Task, 'followUps'>) => html(createElement(FollowUpBadge, { task: t }));

  it('sem follow-up aberto, nada', () => {
    expect(badge({})).toBe('');
    expect(badge({ followUps: [fu({ status: 'resolved', resolution: 'card' })] })).toBe('');
  });

  const hint = (out: string) => out.match(/title="([^"]*)"/)?.[1];

  it('é só texto (o cartão é um botão) e, esperando o gestor, a dica não pede nada a você', () => {
    const out = badge({ followUps: [fu()] });
    expect(out).toContain('1 follow-up aberto');
    expect(out).not.toContain('<button');
    expect(hint(out)).toBe(tasksMsgs['pt-BR']['tasks.fuBadgeHint']);
  });

  it('quando algum espera você, a dica diz que espera você (o amarelo do selo só reforça)', () => {
    const out = badge({ followUps: [fu(), fu({ id: 'f-000002', to: 'owner' })] });
    expect(out).toContain('2 follow-ups abertos');
    expect(hint(out)).toBe(tasksMsgs['pt-BR']['tasks.fuBadgeMineHint']);
    expect(hint(out)).toMatch(/^Espera você/);
  });
});

describe('bloco do detalhe', () => {
  it('sem follow-up, nada', () => {
    expect(block(task([]))).toBe('');
    expect(block(task([], { followUps: undefined }))).toBe('');
  });

  it('aberto: autor, texto, com quem está e as duas saídas', () => {
    const out = block(task([fu()]));
    expect(out).toContain('Follow-ups de revisão');
    expect(out).toContain('<b>Rita</b>');
    expect(out).toContain('Extrair o helper de data.');
    expect(out).toContain('Aberto');
    expect(out).toContain('Espera Ana, que pediu a tarefa.');
    // A tarefa do exemplo está Finalizada (a aprovação costuma fechá-la): as saídas são "Revisar" e "Concluir".
    expect(out).toContain('Revisar');
    expect(out).toContain('Concluir');
    expect(out).not.toContain('Virou card');
    // Ainda aberta, "Criar card" e "Descartar".
    const aberta = block(task([fu()], { status: 'doing' }));
    expect(aberta).toContain('Criar card');
    expect(aberta).toContain('Descartar');
    expect(aberta).not.toContain('Concluir');
    // A regra de ouro do revisor: falha que invalida a aprovação é reprovação, não follow-up.
    expect(out).toContain('é reprovação');
  });

  it('o texto do autor é puro: HTML nele não vira marcação', () => {
    const out = block(task([fu({ text: '<img src=x onerror=alert(1)> <b>negrito</b>' })]));
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('autor sem ficha aparece como "revisão", não pelo id (o mesmo da caixa)', () => {
    const out = block(task([fu({ by: 'ghost' })]));
    expect(out).toContain('<b>revisão</b>');
    expect(out).not.toContain('ghost');
  });

  it('virou card: link para o card (título) e sem as saídas', () => {
    const t = task([fu({ status: 'resolved', resolution: 'card', resolvedBy: 'you', resolvedAt: '2026-11-18T11:00:00Z', cardId: 't-bbbbbb' })]);
    const out = block(t, [t, sibling('t-bbbbbb', 'Extrair helper de data', '2026-11-18T11:30:00Z')]);
    expect(out).toContain('Virou card');
    expect(out).toContain('Extrair helper de data');
    expect(out).toContain('Decidido por você');
    expect(out).toContain('Todos decididos');
    expect(out).not.toContain('Descartar');
    expect(out).not.toContain('Espera ');
    expect(out.match(/<button/g)).toHaveLength(1);
  });

  it('virou card de uma tarefa que saiu do quadro: o id e "fora do quadro"; sem id, diz que não foi indicado', () => {
    const base = { status: 'resolved', resolution: 'card', resolvedBy: 'you' } as const;
    const gone = block(task([fu({ ...base, cardId: 't-zzzzzz' })]));
    expect(gone).toContain('t-zzzzzz');
    expect(gone).toContain('fora do quadro');
    expect(block(task([fu(base)]))).toContain('Sem indicar qual card.');
  });

  it('descartado: o motivo aparece e não há botão', () => {
    const out = block(task([fu({ status: 'resolved', resolution: 'discarded', resolvedBy: 'ana', resolvedAt: '2026-11-18T11:00:00Z', note: 'já coberto' })]));
    expect(out).toContain('Descartado');
    expect(out).toContain('Decidido por Ana');
    expect(out).toContain('Motivo: já coberto');
    expect(out).not.toContain('<button');
  });

  it('vários, do mais antigo ao mais novo, cada um com as suas saídas só se aberto', () => {
    const out = block(task([fu({ id: 'f-000001', text: 'primeiro', status: 'resolved', resolution: 'discarded' }), fu({ id: 'f-000002', text: 'segundo' })]));
    expect(out.indexOf('primeiro')).toBeLessThan(out.indexOf('segundo'));
    expect(out).toContain('1 follow-up aberto');
    expect(out.match(/Concluir<\/button>/g)).toHaveLength(1);
  });
});

describe('as duas saídas', () => {
  const decide = (props: Partial<Parameters<typeof FollowUpDecide>[0]> = {}) =>
    html(createElement(FollowUpDecide, { projectId: 'p-1', taskId: 't-aaaaaa', followUp: { id: 'f-a1b2c3', text: 'achado' }, onDone: noop, ...props }));

  it('tarefa aberta, só os botões: "Criar card" e "Descartar"; o formulário abre ao tocar (decidido uma vez, não se desfaz)', () => {
    const out = decide();
    expect(out).toContain('Criar card');
    expect(out).toContain('Descartar');
    expect(out).not.toContain('Revisar');
    expect(out).not.toContain('Concluir');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('Abrir card');
  });

  it('enquanto a tarefa de origem não foi lida (`loading`), as saídas esperam: sem ela não se sabe se está Finalizada nem o achado inteiro', () => {
    expect(decide()).not.toContain('disabled');
    const out = decide({ loading: true });
    expect(out.match(/disabled=""/g)).toHaveLength(2);
    expect(decide({ loading: true, task: { status: 'done', staffId: 'beto' } }).match(/disabled=""/g)).toHaveLength(2);
  });

  it('tarefa Finalizada: "Revisar" e "Concluir" no lugar de "Criar card" e "Descartar"', () => {
    const out = decide({ task: { status: 'done', staffId: 'beto' } });
    expect(out).toContain('Revisar');
    expect(out).toContain('Concluir');
    expect(out).not.toContain('Criar card');
    expect(out).not.toContain('Descartar');
  });

  it('na caixa: "Abrir card" vem junto, com as mesmas saídas dos botões cheios', () => {
    const out = decide({ compact: true, onOpenCard: noop });
    expect(out).toContain('Abrir card');
    expect(out).toContain('Criar card');
    expect(out).toContain('Descartar');
    expect(out.match(/<button/g)).toHaveLength(3);
    // Sem o `onOpenCard` o atalho não existe: o botão de abrir o card é do item da caixa, não de toda saída.
    expect(decide({ compact: true })).not.toContain('Abrir card');
  });

  // Única asserção de classe que sobra: "compacto" só muda o desenho (botão de texto no lugar do cheio), sem texto nem comportamento a conferir; é a classe que o CSS da caixa lê.
  it('compacto é botão de texto; o cheio, botão cheio', () => {
    expect(decide({ compact: true })).toContain('class="link small"');
    expect(decide({ compact: true })).not.toContain('btn-secondary');
    expect(decide()).toContain('btn-secondary');
    expect(decide()).not.toContain('class="link small"');
  });
});

// O envio, com o servidor falso na borda (fetch): a rota e o corpo que de fato saem, e o que a tela fica sabendo de cada resposta. `sendDecision` é o que o formulário chama ao confirmar;
// ela não rejeita nunca, então o `setBusy(false)` que vem depois dela sempre roda (botões de volta).
describe('enviar a decisão', () => {
  const REF = { projectId: 'p-1', taskId: 't-aaaaaa', followUpId: 'f-a1b2c3' };
  const URL = '/api/projects/p-1/tasks/t-aaaaaa/followup/f-a1b2c3/resolve';
  const reply = (status: number, body: unknown = {}) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const stubServer = (answer: () => Promise<Response>) => {
    const fetch = vi.fn(answer);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    return fetch;
  };
  const sent = (fetch: ReturnType<typeof stubServer>) => {
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    return { url, method: init.method, body: JSON.parse(init.body as string) as unknown, mycoHeader: (init.headers as Record<string, string>)['x-myco'] };
  };
  const ok = reply(200, { id: 'f-a1b2c3', taskId: 't-aaaaaa', status: 'resolved' });

  it('descartar com motivo: POST na rota do follow-up com {resolution, reason} aparado; depois relê e não há erro', async () => {
    const fetch = stubServer(ok);
    const onDone = vi.fn();
    await expect(sendDecision(REF, decisionOf('discard', '  já coberto pela t-cccccc  '), onDone)).resolves.toEqual({ error: null, gone: false });
    expect(sent(fetch)).toEqual({ url: URL, method: 'POST', mycoHeader: '1', body: { resolution: 'discarded', reason: 'já coberto pela t-cccccc' } });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('descartar sem motivo (ou só espaços): o corpo é só {resolution}, sem reason e sem cardId', async () => {
    for (const reason of ['', '   ']) {
      const fetch = stubServer(ok);
      await sendDecision(REF, decisionOf('discard', reason), vi.fn());
      expect(sent(fetch).body).toEqual({ resolution: 'discarded' });
    }
  });

  it('virou card com o card indicado: {resolution:"card", cardId}', async () => {
    const fetch = stubServer(ok);
    const onDone = vi.fn();
    await expect(sendDecision(REF, decisionOf('card', 't-bbbbbb'), onDone)).resolves.toEqual({ error: null, gone: false });
    expect(sent(fetch)).toMatchObject({ url: URL, method: 'POST', body: { resolution: 'card', cardId: 't-bbbbbb' } });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('virou card sem indicar qual: {resolution:"card"}, sem cardId (o servidor aceita; com id vazio recusaria)', async () => {
    const fetch = stubServer(ok);
    await sendDecision(REF, decisionOf('card', ''), vi.fn());
    expect(sent(fetch).body).toEqual({ resolution: 'card' });
  });

  it('409 (já decidido por outro caminho): relê a lista e devolve o aviso no idioma da tela, não o texto do servidor, marcado como "gone"', async () => {
    stubServer(reply(409, { error: 'esse follow-up já foi decidido (descartado por o usuário)' }));
    const onDone = vi.fn();
    const out = await sendDecision(REF, decisionOf('discard', ''), onDone);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ error: tasksMsgs['pt-BR']['tasks.fuErrDecided'], gone: true });
    expect(out.error).not.toContain('o usuário');
  });

  it('409 e a releitura também falha: ainda devolve o aviso de "já decidido", sem rejeitar', async () => {
    stubServer(reply(409, { error: 'x' }));
    const onDone = vi.fn().mockRejectedValue(new Error('sem rede'));
    await expect(sendDecision(REF, decisionOf('discard', ''), onDone)).resolves.toEqual({ error: tasksMsgs['pt-BR']['tasks.fuErrDecided'], gone: true });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('queda de rede: devolve a frase do servidor fora do ar (não "gone": o formulário segue aberto), não relê e a promessa resolve', async () => {
    const fetch = stubServer(() => Promise.reject(new TypeError('Failed to fetch')));
    const onDone = vi.fn();
    const out = await sendDecision(REF, decisionOf('card', 't-bbbbbb'), onDone);
    expect(out).toEqual({ error: appMsgs['pt-BR']['app.serverOffline'], gone: false });
    expect(onDone).not.toHaveBeenCalled();
    // Um envio repetido duplicaria a decisão: a rede que cai não é tentada de novo sozinha.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('recusa que não se conhece (400): segue com o texto do servidor, sem reler', async () => {
    stubServer(reply(400, { error: 'cardId: tarefa não encontrada neste projeto' }));
    const onDone = vi.fn();
    await expect(sendDecision(REF, decisionOf('card', 't-zzzzzz'), onDone)).resolves.toEqual({ error: 'cardId: tarefa não encontrada neste projeto', gone: false });
    expect(onDone).not.toHaveBeenCalled();
  });

  it('recusa por pareamento vem sem texto: nada a mostrar (o aviso do App já explica)', async () => {
    stubServer(reply(403, { error: 'pareie o navegador', code: 'needs-pairing' }));
    await expect(sendDecision(REF, decisionOf('discard', ''), vi.fn())).resolves.toEqual({ error: '', gone: false });
  });

  it('decidiu e a releitura falhou: o erro da releitura é o devolvido, sem rejeitar', async () => {
    stubServer(ok);
    const onDone = vi.fn().mockRejectedValue(new Error('lista não carregou'));
    await expect(sendDecision(REF, decisionOf('discard', ''), onDone)).resolves.toEqual({ error: 'lista não carregou', gone: false });
  });

  it('espera o onDone assíncrono antes de devolver (a tela só destrava depois da releitura)', async () => {
    stubServer(ok);
    const order: string[] = [];
    const out = sendDecision(REF, decisionOf('discard', ''), async () => {
      await Promise.resolve();
      order.push('releu');
    }).then((r) => {
      order.push('voltou');
      return r;
    });
    await out;
    expect(order).toEqual(['releu', 'voltou']);
  });

  // O que o formulário faz com a resposta (`submitDecision`, o que `FollowUpDecide` chama ao confirmar), com o servidor falso na borda e os setters como registro de chamadas: ocupado → (aviso no pai
  // no 409 | erro sob o formulário | frase do que foi feito) → ocupado de volta. Sem DOM, é onde a fiação de `busy`/`setError`/`onGone` se prova.
  describe('o envio do formulário', () => {
    const OFFLINE = appMsgs['pt-BR']['app.serverOffline'];
    const DECIDED = tasksMsgs['pt-BR']['tasks.fuErrDecided'];
    const submit = async (decision: () => Promise<DecisionOutcome & { note?: string }>, withParent = true) => {
      const log: string[] = [];
      const set: SubmitSetters = {
        setBusy: (busy) => log.push(`busy:${busy}`),
        setError: (error) => log.push(`error:${error}`),
        onDecided: (message) => log.push(`decided:${message}`),
        ...(withParent && { onGone: (message: string | null) => log.push(`gone:${message}`) }),
      };
      await submitDecision(decision, set);
      return log;
    };
    const discard = (onDone: () => void | Promise<void> = vi.fn(), note = 'Follow-up descartado.') => async () => ({ ...(await sendDecision(REF, decisionOf('discard', ''), onDone)), note });
    // O começo de todo envio: ocupa e limpa o que a tentativa anterior deixou (formulário e pai).
    const START = ['busy:true', 'error:null', 'gone:null', 'decided:null'];

    it('deu certo: ocupa, limpa os avisos, sobe a frase do que foi feito para o pai e desocupa; sem erro', async () => {
      stubServer(ok);
      expect(await submit(discard())).toEqual([...START, 'decided:Follow-up descartado.', 'busy:false']);
    });

    it('queda de rede: o erro fica sob o formulário (não vai ao pai, não diz que foi feito) e o ocupado volta', async () => {
      stubServer(() => Promise.reject(new TypeError('Failed to fetch')));
      const onDone = vi.fn();
      expect(await submit(discard(onDone))).toEqual([...START, `error:${OFFLINE}`, 'busy:false']);
      expect(onDone).not.toHaveBeenCalled();
    });

    it('409: a releitura roda, o aviso sobe para o PAI (nada sob o formulário, que a releitura desmonta) e o ocupado volta', async () => {
      stubServer(reply(409, { error: 'esse follow-up já foi decidido' }));
      const onDone = vi.fn();
      expect(await submit(discard(onDone))).toEqual([...START, `gone:${DECIDED}`, 'busy:false']);
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('409 sem pai para avisar (sem onGone): o aviso fica sob o formulário, não se perde', async () => {
      stubServer(reply(409, { error: 'já decidido' }));
      expect(await submit(discard(), false)).toEqual(['busy:true', 'error:null', 'decided:null', `error:${DECIDED}`, 'busy:false']);
    });

    it('recusa que não é 409 (400): texto do servidor sob o formulário, que segue aberto, sem aviso no pai', async () => {
      stubServer(reply(400, { error: 'cardId: tarefa não encontrada neste projeto' }));
      expect(await submit(discard())).toEqual([...START, 'error:cardId: tarefa não encontrada neste projeto', 'busy:false']);
    });

    it('o ocupado volta mesmo se o envio rejeitar (os botões nunca ficam travados)', async () => {
      const log: string[] = [];
      const set: SubmitSetters = { setBusy: (busy) => log.push(`busy:${busy}`), setError: noop };
      await expect(submitDecision(() => Promise.reject(new Error('quebrou')), set)).rejects.toThrow('quebrou');
      expect(log).toEqual(['busy:true', 'busy:false']);
    });
  });

  // O 409 e a releitura que o acompanha: o follow-up vira "decidido" (detalhe) ou some (caixa), e o `FollowUpDecide` com ele. O aviso tem de estar no pai, que fica.
  describe('o aviso de "já decidido" sobrevive à releitura', () => {
    const decidedElsewhere = fu({ status: 'resolved', resolution: 'discarded', resolvedBy: 'ana', resolvedAt: '2026-11-18T11:00:00Z' });
    const view = (t: Task, gone: string | null) =>
      html(createElement(FollowUpBlockView, { task: t, tasks: [t], nameOf, now: NOW, projectId: 'p-1', onOpenTask: noop, onChanged: noop, gone, onGone: noop, done: null, onDecided: noop }));

    it('o pai guarda o aviso e mostra com a releitura já feita: follow-up decidido, sem saídas, com o aviso', async () => {
      stubServer(reply(409, { error: 'esse follow-up já foi decidido' }));
      let current = task([fu()]);
      let gone: string | null = null;
      // O que o bloco do detalhe faz: `onChanged` relê (aqui, o servidor já o tem decidido por outro caminho) e `onGone` guarda o aviso. O envio é o do formulário (`submitDecision`).
      await submitDecision(
        () =>
          sendDecision(REF, decisionOf('discard', ''), () => {
            current = task([decidedElsewhere]);
          }),
        { setBusy: noop, setError: noop, onGone: (message) => (gone = message) },
      );
      expect(view(task([fu()]), null)).toContain('Concluir</button>');
      const after = view(current, gone);
      expect(after).toContain('role="alert"');
      expect(after).toContain(tasksMsgs['pt-BR']['tasks.fuErrDecided']);
      expect(after).toContain('Decidido por Ana');
      expect(after).not.toContain('Concluir</button>');
      expect(after).not.toContain('<form');
    });

    it('sem aviso guardado, nada de alerta', () => {
      expect(view(task([decidedElsewhere]), null)).not.toContain('role="alert"');
    });

    it('a caixa usa a mesma nota, fora da lista: com a lista vazia ainda mostra o aviso', () => {
      const out = html(createElement(FollowUpGoneNote, { message: tasksMsgs['pt-BR']['tasks.fuErrDecided'], className: 'inbox-fu-gone' }));
      expect(out).toContain('role="alert"');
      expect(out).toContain(tasksMsgs['pt-BR']['tasks.fuErrDecided']);
      expect(html(createElement(FollowUpGoneNote, { message: null, className: 'inbox-fu-gone' }))).toBe('');
    });
  });

  it('o erro conhecido sai no idioma da tela (en/es), não em pt-BR', () => {
    const msgs = { en: { ...appMsgs.en, ...tasksMsgs.en }, es: { ...appMsgs.es, ...tasksMsgs.es } } as Record<'en' | 'es', Record<string, string>>;
    for (const lang of ['en', 'es'] as const) {
      const tr: Tr = (key) => msgs[lang][key] ?? key;
      const gone = decisionErrorText(new ApiError('esse follow-up já foi decidido', null, null, {}, 409), tr);
      const offline = decisionErrorText(new ApiError('Claudio’s Club reiniciando', 'offline', null), tr);
      expect(gone, lang).toBe(tasksMsgs[lang]['tasks.fuErrDecided']);
      expect(offline, lang).toBe(appMsgs[lang]['app.serverOffline']);
      expect(gone + offline, lang).not.toMatch(/já foi decidido|reiniciando,? tente/);
    }
  });
});

describe('textos nos 3 idiomas', () => {
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const parity = (msgs: typeof tasksMsgs | typeof staffMsgs, prefix: RegExp, expected: number) => {
    const pt = msgs['pt-BR'] as Record<string, string>;
    const keys = Object.keys(pt).filter((k) => prefix.test(k));
    expect(keys).toHaveLength(expected);
    for (const locale of ['en', 'es'] as const) {
      for (const k of keys) {
        const text = (msgs[locale] as Record<string, string>)[k];
        expect(text, `${locale} ${k}`).toBeTruthy();
        // Os mesmos {parâmetros} do pt: texto sem um deles deixaria a tela sem o nome ou o motivo.
        expect(vars(text!), `${locale} ${k}`).toEqual(vars(pt[k]!));
      }
    }
  };

  it('en e es têm todas as chaves do follow-up do quadro', () => parity(tasksMsgs, /^tasks\.fu[A-Z]/, 70));

  it('a dica do selo nos 3 idiomas diz a frase inteira: quem pediu a tarefa OU o dono decide, e o que a decisão pode ser', () => {
    expect(tasksMsgs['pt-BR']['tasks.fuBadgeHint']).toContain('Quem pediu a tarefa, ou você, decide: vira card ou é descartada.');
    expect(tasksMsgs.en['tasks.fuBadgeHint']).toContain('Whoever requested the task, or you, decides: it becomes a card or is discarded.');
    expect(tasksMsgs.es['tasks.fuBadgeHint']).toContain('Decide quien pidió la tarea, o tú: se vuelve tarjeta o se descarta.');
  });
  it('en e es têm todas as chaves do follow-up da caixa', () => parity(staffMsgs, /^inbox\.(followUp\.|kindFollowUp|titleFollowUp)/, 5));
});
