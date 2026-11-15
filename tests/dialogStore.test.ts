import { describe, expect, it } from 'vitest';
import { askConfirm, onDialogRequest, showAlert } from '../client/src/lib/dialogStore';

describe('dialogStore (modal no lugar de window.confirm/alert)', () => {
  it('sem o modal montado, o confirm é recusado (nunca segue sem o dono ver)', async () => {
    expect(await askConfirm('Apagar?')).toBe(false);
  });

  it('o confirm espera a resposta do modal', async () => {
    const seen: string[] = [];
    const off = onDialogRequest((r) => {
      seen.push(`${r.kind}:${r.text}`);
      r.resolve(r.text === 'sim');
    });
    expect(await askConfirm('sim')).toBe(true);
    expect(await askConfirm('não')).toBe(false);
    await showAlert('erro');
    expect(seen).toEqual(['confirm:sim', 'confirm:não', 'alert:erro']);
    off();
    expect(await askConfirm('sim')).toBe(false);
  });
});
