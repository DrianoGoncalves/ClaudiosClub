import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatItem, ChatSnapshot } from '../shared/model';

// Excluir a mensagem guardada, o comportamento (t-a741d9): `useChat.discardHeld` (discardHeldItem: o pedido, a releitura e o resultado)
// e o clique do ChatView (createHeldDiscarder: pergunta, aviso, erro, um pedido por vez). Só `api.discardHeld` e o modal (dialogStore)
// são falsos; o resto (ApiError, alertError, textos) é o de verdade. O vitest daqui é sem DOM, então os dois hooks foram extraídos
// para heldDiscard.ts e é isto que roda; a fiação em useChat.ts/ChatView.tsx (duas linhas cada) está em "ligações" no fim.

vi.mock('../client/src/api', async (orig) => {
  const real = await orig<typeof import('../client/src/api')>();
  return { ...real, api: { ...real.api, discardHeld: vi.fn() } };
});
vi.mock('../client/src/lib/dialogStore', () => ({ askConfirm: vi.fn(), showAlert: vi.fn() }));

import { api, ApiError } from '../client/src/api';
import { createHeldDiscarder, discardHeldItem, type HeldDiscardResult } from '../client/src/chat/heldDiscard';
import chatMessages from '../client/src/i18n/chat';
import { askConfirm, showAlert } from '../client/src/lib/dialogStore';

const discardHeld = vi.mocked(api.discardHeld);
const confirm = vi.mocked(askConfirm);
const alertText = vi.mocked(showAlert);

const pt = chatMessages['pt-BR'];
const held = (over: Record<string, unknown> = {}): ChatItem =>
  ({ kind: 'user', id: 'h:a1b2c3d4', text: 'corrija o botão', at: '2026-11-18T10:00:00.000Z', held: 'espera Ana terminar “Painel”', heldTaskId: 't-abc123', heldDiscardable: true, ...over }) as ChatItem;
const snapshot = (items: ChatItem[]) => ({ held: items }) as unknown as ChatSnapshot;
/** Recusa do servidor, com o texto de cada um dos três motivos do 409 (server/tasks.ts `discardHeld`). */
const refuse = (status: number | null, message: string, code: string | null = null) => new ApiError(message, code, null, {}, status);
const SENT = 'esse ajuste já não está guardado (foi enviado ou já foi excluído)';
const OWNER = 'a tarefa mudou de responsável: abra a conversa de novo e tente outra vez';

beforeEach(() => {
  discardHeld.mockReset();
  confirm.mockReset();
  alertText.mockReset();
  alertText.mockResolvedValue(undefined);
});

describe('useChat.discardHeld (discardHeldItem)', () => {
  const run = (item = held(), reload = vi.fn<(sid: string) => Promise<ChatSnapshot | null>>(async () => snapshot([])), sessionId: string | null = 'sess-1') => {
    const drop = vi.fn();
    const result = discardHeldItem(item, { projectId: 'proj-a', sessionId, reload, drop });
    return { result, reload, drop };
  };

  it('sucesso: bate na rota certa e tira a mensagem das guardadas, sem reler', async () => {
    discardHeld.mockResolvedValue(null);
    const { result, reload, drop } = run();
    expect(await result).toBe('discarded');
    expect(discardHeld).toHaveBeenCalledWith('proj-a', 't-abc123', 'a1b2c3d4');
    expect(drop).toHaveBeenCalledWith('h:a1b2c3d4');
    expect(reload).not.toHaveBeenCalled();
  });

  it('409 "já enviada/excluída": relê e, sem a mensagem entre as guardadas, devolve gone', async () => {
    discardHeld.mockRejectedValue(refuse(409, SENT));
    const { result, reload, drop } = run(held(), vi.fn(async () => snapshot([held({ id: 'h:outra' })])));
    expect(await result).toBe('gone');
    expect(reload).toHaveBeenCalledWith('sess-1');
    expect(drop).not.toHaveBeenCalled(); // a releitura é que troca as guardadas; nada é tirado à mão
  });

  it('409 "mudou de responsável": a mensagem segue guardada na releitura, então o resultado é kept (não gone)', async () => {
    discardHeld.mockRejectedValue(refuse(409, OWNER));
    const { result, reload } = run(held(), vi.fn(async () => snapshot([held()])));
    expect(await result).toBe('kept');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('releitura que falha: unknown (não diz que a mensagem sumiu nem que ficou)', async () => {
    discardHeld.mockRejectedValue(refuse(409, SENT));
    expect(await run(held(), vi.fn(async () => Promise.reject(refuse(null, 'sem rede', 'offline')))).result).toBe('unknown');
  });

  it('releitura descartada (a tela já foi para outra conversa, load devolve null): unknown', async () => {
    discardHeld.mockRejectedValue(refuse(409, SENT));
    expect(await run(held(), vi.fn<(sid: string) => Promise<ChatSnapshot | null>>(async () => null)).result).toBe('unknown');
  });

  it('403 e queda de rede sobem como erro, sem reler nem tirar a mensagem', async () => {
    for (const err of [refuse(403, 'só você, pelo Claudio’s Club, exclui o ajuste guardado'), refuse(null, 'Sem conexão com o servidor', 'offline'), refuse(404, 'tarefa não existe')]) {
      discardHeld.mockRejectedValue(err);
      const { result, reload, drop } = run();
      await expect(result).rejects.toBe(err);
      expect(reload).not.toHaveBeenCalled();
      expect(drop).not.toHaveBeenCalled();
    }
  });

  it('sem como excluir (resposta a dúvida, ou sem conversa): unknown e nem chama o servidor', async () => {
    expect(await run(held({ heldDiscardable: false })).result).toBe('unknown');
    expect(await run(held(), undefined, null).result).toBe('unknown');
    expect(discardHeld).not.toHaveBeenCalled();
  });
});

describe('ChatView.discardHeld (createHeldDiscarder)', () => {
  const setup = (discard: (item: ChatItem) => Promise<HeldDiscardResult>) => {
    const busy: Array<string | null> = [];
    const fn = vi.fn(discard);
    return { click: createHeldDiscarder({ discard: fn, onBusy: (id) => busy.push(id) }), discard: fn, busy };
  };

  it('pergunta com o botão "Excluir" (e não "OK") e, confirmada, exclui sem aviso', async () => {
    confirm.mockResolvedValue(true);
    const { click, discard, busy } = setup(async () => 'discarded');
    await click(held());
    expect(confirm).toHaveBeenCalledWith(pt['chat.heldDiscardConfirm'], 'Excluir');
    expect(discard).toHaveBeenCalledTimes(1);
    expect(alertText).not.toHaveBeenCalled();
    expect(busy).toEqual(['h:a1b2c3d4', null]);
  });

  it('cancelar a pergunta não envia o pedido nem avisa, e solta o botão', async () => {
    confirm.mockResolvedValue(false);
    const { click, discard, busy } = setup(async () => 'discarded');
    await click(held());
    expect(discard).not.toHaveBeenCalled();
    expect(alertText).not.toHaveBeenCalled();
    expect(busy).toEqual(['h:a1b2c3d4', null]);
  });

  it('clique repetido: com a pergunta aberta, o 2º clique não abre outra nem exclui duas vezes', async () => {
    let answer!: (ok: boolean) => void;
    confirm.mockImplementation(() => new Promise<boolean>((r) => (answer = r)));
    const { click, discard } = setup(async () => 'discarded');
    const first = click(held());
    await click(held()); // antes de a pergunta ser respondida (nem houve re-render)
    expect(confirm).toHaveBeenCalledTimes(1);
    answer(true);
    await first;
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('clique repetido: com o pedido a caminho, o 2º clique também não faz nada; depois de terminar, um clique novo vale', async () => {
    confirm.mockResolvedValue(true);
    let finish!: (r: HeldDiscardResult) => void;
    const { click, discard } = setup(() => new Promise<HeldDiscardResult>((r) => (finish = r)));
    const first = click(held());
    await vi.waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
    await click(held());
    expect(confirm).toHaveBeenCalledTimes(1);
    finish('discarded');
    await first;
    discard.mockResolvedValueOnce('discarded');
    await click(held());
    expect(discard).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['gone', 'chat.heldDiscardGone'],
    ['kept', 'chat.heldDiscardKept'],
    ['unknown', 'chat.heldDiscardUnsure'],
  ] as const)('resultado %s: o aviso é o da chave %s', async (result, key) => {
    confirm.mockResolvedValue(true);
    await setup(async () => result).click(held());
    expect(alertText).toHaveBeenCalledWith(pt[key]);
  });

  it('o aviso de mensagem que segue guardada (ou de estado desconhecido) não diz que foi enviada nem excluída', () => {
    for (const lang of ['pt-BR', 'en', 'es'] as const) {
      for (const key of ['chat.heldDiscardKept', 'chat.heldDiscardUnsure'] as const) {
        expect(chatMessages[lang][key], `${lang} ${key}`).not.toMatch(/enviad|excluíd|eliminad|\bsent\b|deleted/i);
      }
    }
  });

  it('erro de rede e 403 vão para o alerta de erro (o texto do erro), sem aviso de "gone", e soltam o botão', async () => {
    confirm.mockResolvedValue(true);
    for (const err of [refuse(null, 'Sem conexão com o servidor', 'offline'), refuse(403, 'só você, pelo Claudio’s Club, exclui o ajuste guardado')]) {
      alertText.mockClear();
      const { click, busy } = setup(async () => Promise.reject(err));
      await click(held());
      expect(alertText).toHaveBeenCalledTimes(1);
      expect(alertText).toHaveBeenCalledWith(err.message);
      expect(busy).toEqual(['h:a1b2c3d4', null]);
    }
  });

  it('403 por falta de pareamento não abre alerta (o aviso do App já explica), e o botão solta', async () => {
    confirm.mockResolvedValue(true);
    const { click, busy } = setup(async () => Promise.reject(refuse(403, '', 'needs-pairing')));
    await click(held());
    expect(alertText).not.toHaveBeenCalled();
    expect(busy).toEqual(['h:a1b2c3d4', null]);
  });
});

describe('os dois juntos (o aviso bate com o estado da conversa)', () => {
  const clickWith = (error: ApiError, reload: () => Promise<ChatSnapshot | null>) => {
    confirm.mockResolvedValue(true);
    discardHeld.mockRejectedValue(error);
    const click = createHeldDiscarder({
      discard: (item) => discardHeldItem(item, { projectId: 'proj-a', sessionId: 'sess-1', reload, drop: () => {} }),
      onBusy: () => {},
    });
    return click(held());
  };

  it('409 já enviada/excluída, e a conversa relida já não a traz: avisa que já não aparece guardada', async () => {
    await clickWith(refuse(409, SENT), async () => snapshot([]));
    expect(alertText).toHaveBeenCalledWith(pt['chat.heldDiscardGone']);
  });

  it('409 mudou de responsável, e a mensagem continua guardada: avisa que continua guardada (nunca "enviada/excluída")', async () => {
    await clickWith(refuse(409, OWNER), async () => snapshot([held()]));
    expect(alertText).toHaveBeenCalledTimes(1);
    expect(alertText).toHaveBeenCalledWith(pt['chat.heldDiscardKept']);
  });

  it('409 com a releitura falhando: o aviso diz que não conseguiu atualizar, não "Atualizei a conversa"', async () => {
    await clickWith(refuse(409, SENT), async () => Promise.reject(new Error('rede')));
    expect(alertText).toHaveBeenCalledWith(pt['chat.heldDiscardUnsure']);
    expect(alertText.mock.calls[0]![0]).not.toContain('Atualizei a conversa');
  });
});

describe('ligações (useChat.ts e ChatView.tsx)', () => {
  it('o hook passa a leitura (load) e a retirada da lista guardada; o ChatView liga o controlador ao último chat.discardHeld e ao estado do botão', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const read = (f: string) => readFile(join(__dirname, '..', 'client', 'src', 'chat', f), 'utf8');
    const hook = await read('useChat.ts');
    expect(hook).toContain('discardHeldItem(item, { projectId, sessionId, reload: load, drop: (id) => setHeld((h) => h.filter((i) => i.id !== id)) })');
    const view = await read('ChatView.tsx');
    expect(view).toContain('createHeldDiscarder({ discard: (item) => discardNow.current(item), onBusy: setDiscarding })');
    expect(view).toContain('discardNow.current = chat.discardHeld');
    expect(view).toContain('onDiscardHeld={(held) => void discardHeld(held)}');
    expect(view).toContain('discarding={discarding === item.id}');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
