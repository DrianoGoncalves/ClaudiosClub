import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../client/src/api';
import { closeConversation, closeRefusal, isWorking, noteStillWorking, refusalText, runClose } from '../client/src/chat/closeConversation';
import { t } from '../client/src/i18n';
import { onDialogRequest } from '../client/src/lib/dialogStore';

// O contrato do servidor (server/chat/manager.ts `close`, rota POST /api/chat/:id/close e /api/archive): 409 com `code` `working` ou `uncertain` (+ `action`).
const refuse = (code: 'working' | 'uncertain', action?: string) => new ApiError('recusado', code, null, { code, ...(action && { action }) }, 409);

/** Responde os modais: `answers` na ordem (true = OK); devolve o que foi perguntado e mostrado. */
function modal(answers: boolean[]) {
  const seen: string[] = [];
  const off = onDialogRequest((r) => {
    seen.push(`${r.kind}:${r.text}`);
    r.resolve(r.kind === 'alert' ? true : (answers.shift() ?? false));
  });
  return { seen, off };
}

afterEach(() => vi.restoreAllMocks());

describe('closeRefusal (a recusa 409 do servidor)', () => {
  it('lê working e uncertain (com a ação)', () => {
    expect(closeRefusal(refuse('working'))).toEqual({ code: 'working' });
    expect(closeRefusal(refuse('uncertain', 'em segundo plano: build'))).toEqual({ code: 'uncertain', action: 'em segundo plano: build' });
    expect(closeRefusal(refuse('uncertain'))).toEqual({ code: 'uncertain', action: null });
  });

  it('outro erro, outro 409 ou outro status não é recusa de fechar', () => {
    expect(closeRefusal(new Error('x'))).toBeNull();
    expect(closeRefusal(new ApiError('x', 'open-tasks', null, {}, 409))).toBeNull();
    expect(closeRefusal(new ApiError('x', 'working', null, {}, 500))).toBeNull();
    expect(closeRefusal(null)).toBeNull();
  });
});

describe('isWorking (o que pede confirmação para fechar)', () => {
  it('turno, pedido esperando ou algo em segundo plano contam; parada não', () => {
    expect(isWorking({ busy: false })).toBe(false);
    expect(isWorking({ busy: true })).toBe(true);
    expect(isWorking({ busy: false }, true)).toBe(true);
    expect(isWorking({ busy: false, background: [{}] })).toBe(true);
    expect(isWorking({ busy: false, background: [] })).toBe(false);
    expect(isWorking(null)).toBe(false);
  });
});

describe('runClose (fechar e arquivar com a confirmação certa)', () => {
  it('parada: fecha direto, sem perguntar e sem mandar confirm', async () => {
    const { seen, off } = modal([]);
    const act = vi.fn().mockResolvedValue('ok');
    expect(await runClose(false, { working: 'chat.closeConfirmWorking' }, act)).toEqual({ done: 'ok' });
    expect(act).toHaveBeenCalledExactlyOnceWith(false);
    expect(seen).toEqual([]);
    off();
  });

  it('trabalhando: pergunta o risco antes e só então fecha, com confirm', async () => {
    const { seen, off } = modal([true]);
    const act = vi.fn().mockResolvedValue('ok');
    expect(await runClose(true, { working: 'chat.closeConfirmWorking' }, act)).toEqual({ done: 'ok' });
    expect(seen).toEqual([`confirm:${t('chat.closeConfirmWorking')}`]);
    expect(act).toHaveBeenCalledExactlyOnceWith(true);
    off();
  });

  it('trabalhando e você cancela: nada é chamado', async () => {
    const { off } = modal([false]);
    const act = vi.fn();
    expect(await runClose(true, { working: 'chat.closeConfirmWorking' }, act)).toBeNull();
    expect(act).not.toHaveBeenCalled();
    off();
  });

  it('parada com aviso (arquivar): pergunta uma vez; cancelar não arquiva', async () => {
    const ask = { working: 'chat.archiveConfirmWorking', idle: 'detail.archiveConversationConfirm' } as const;
    const yes = modal([true]);
    const act = vi.fn().mockResolvedValue('ok');
    expect(await runClose(false, ask, act)).toEqual({ done: 'ok' });
    expect(yes.seen).toEqual([`confirm:${t('detail.archiveConversationConfirm')}`]);
    expect(act).toHaveBeenCalledExactlyOnceWith(false);
    yes.off();

    const no = modal([false]);
    const never = vi.fn();
    expect(await runClose(false, ask, never)).toBeNull();
    expect(never).not.toHaveBeenCalled();
    no.off();
  });

  it('o servidor diz que trabalha (começou depois do clique): pergunta o risco e repete com confirm', async () => {
    const { seen, off } = modal([true]);
    const act = vi.fn().mockRejectedValueOnce(refuse('working')).mockResolvedValueOnce('ok');
    expect(await runClose(false, { working: 'chat.closeConfirmWorking' }, act)).toEqual({ done: 'ok' });
    expect(act.mock.calls).toEqual([[false], [true]]);
    expect(seen).toEqual([`confirm:${t('chat.closeConfirmWorking')}`]);
    off();
  });

  it('efeito incerto: mostra o motivo (com a ação), não fecha e devolve null', async () => {
    const { seen, off } = modal([true]);
    const act = vi.fn().mockRejectedValue(refuse('uncertain', 'em segundo plano: deploy'));
    expect(await runClose(true, { working: 'chat.closeConfirmWorking' }, act)).toBeNull();
    expect(act).toHaveBeenCalledExactlyOnceWith(true);
    expect(seen.at(-1)).toBe(`alert:${t('chat.closeUncertain', { action: 'em segundo plano: deploy' })}`);
    off();
  });

  it('já confirmado e o servidor ainda diz working: mostra a recusa, sem repetir sem fim', async () => {
    const { seen, off } = modal([true]);
    const act = vi.fn().mockRejectedValue(refuse('working'));
    expect(await runClose(true, { working: 'chat.closeConfirmWorking' }, act)).toBeNull();
    expect(act).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe('alert:recusado');
    off();
  });

  it('outro erro sobe para quem chamou (o botão mostra)', async () => {
    const act = vi.fn().mockRejectedValue(new Error('rede'));
    await expect(runClose(false, { working: 'chat.closeConfirmWorking' }, act)).rejects.toThrow('rede');
  });
});

describe('refusalText', () => {
  it('uncertain sem ação usa o texto sem ela; working cai na mensagem do servidor', () => {
    expect(refusalText({ code: 'uncertain', action: null }, 'x')).toBe(t('chat.closeUncertainNoAction'));
    expect(refusalText({ code: 'working' }, 'msg do servidor')).toBe('msg do servidor');
  });
});

describe('closeConversation / arquivar (o corpo que vai ao servidor)', () => {
  it('fecha pelo contrato: confirm só vai quando confirmado', async () => {
    const close = vi.spyOn(api, 'chatClose').mockResolvedValue({ ok: true, closed: true, interrupted: false });
    expect(await closeConversation('s1', false)).toEqual({ done: { ok: true, closed: true, interrupted: false } });
    expect(close).toHaveBeenCalledWith('s1', false);
    const { off } = modal([true]);
    await closeConversation('s2', true);
    expect(close).toHaveBeenLastCalledWith('s2', true);
    off();
  });

  it('avisa as conversas que seguiram trabalhando depois de arquivar funcionário ou projeto', async () => {
    const { seen, off } = modal([]);
    await noteStillWorking({ closed: 2, working: 0 });
    await noteStillWorking(undefined);
    expect(seen).toEqual([]);
    await noteStillWorking({ closed: 1, working: 2 });
    expect(seen).toEqual([`alert:${t('chat.archiveStillWorking', { n: 2 })}`]);
    off();
  });
});
