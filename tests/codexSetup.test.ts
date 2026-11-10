import { describe, expect, it } from 'vitest';
import { CodexSetup, CodexSetupError, type InstallOutcome } from '../server/codexSetup';

// Instalar e entrar no Codex pelo Claudio’s Club: só pelo navegador pareado, e uma instalação por vez (o npm roda uma vez só).

const OK: InstallOutcome = { ok: true, error: null };

/** Uma instalação que só termina quando o teste manda; conta quantas vezes foi rodada. */
function fakeInstall(result: InstallOutcome = OK) {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const calls = { n: 0 };
  return {
    calls,
    release,
    install: async () => {
      calls.n++;
      await wait;
      return result;
    },
  };
}

describe('CodexSetup', () => {
  it('recusa instalar e entrar sem ser o navegador pareado: não roda o npm nem abre o login', async () => {
    const f = fakeInstall();
    const setup = new CodexSetup({
      installed: async () => false,
      install: f.install,
      openLogin: () => {
        throw new Error('não devia abrir o login');
      },
    });
    await expect(setup.install(false)).rejects.toBeInstanceOf(CodexSetupError);
    expect(() => setup.login(false)).toThrow(CodexSetupError);
    expect(f.calls.n).toBe(0);
  });

  it('duas chamadas simultâneas rodam o npm uma vez só, e as duas recebem o mesmo resultado', async () => {
    const f = fakeInstall();
    const setup = new CodexSetup({ installed: async () => false, install: f.install });
    const a = setup.install(true);
    const b = setup.install(true);
    f.release();
    expect(await a).toEqual(OK);
    expect(await b).toEqual(OK);
    expect(f.calls.n).toBe(1);
  });

  it('depois de terminar, um pedido novo roda de novo (a trava não fica presa)', async () => {
    const f = fakeInstall();
    const setup = new CodexSetup({ installed: async () => false, install: f.install });
    const first = setup.install(true);
    f.release();
    await first;
    await setup.install(true);
    expect(f.calls.n).toBe(2);
  });

  it('já instalado: não roda o npm e responde ok', async () => {
    const f = fakeInstall();
    const setup = new CodexSetup({ installed: async () => true, install: f.install });
    expect(await setup.install(true)).toEqual(OK);
    expect(f.calls.n).toBe(0);
  });

  it('a releitura do Codex roda só depois de uma instalação que deu certo', async () => {
    let after = 0;
    const ok = new CodexSetup({ installed: async () => false, install: async () => OK, afterInstall: async () => void after++ });
    await ok.install(true);
    expect(after).toBe(1);

    const failed: InstallOutcome = { ok: false, error: 'não consegui instalar o Codex: EPERM' };
    const bad = new CodexSetup({ installed: async () => false, install: async () => failed, afterInstall: async () => void after++ });
    expect(await bad.install(true)).toEqual(failed);
    expect(after).toBe(1);
  });

  it('erro do npm volta como resultado curto, sem lançar', async () => {
    const failed: InstallOutcome = { ok: false, error: 'a instalação demorou demais (5 min)' };
    const setup = new CodexSetup({ installed: async () => false, install: async () => failed });
    expect(await setup.install(true)).toEqual(failed);
  });

  it('erro ao checar a instalação vira resultado de erro (não derruba a rota)', async () => {
    const setup = new CodexSetup({
      installed: async () => {
        throw new Error('sem PATH');
      },
    });
    expect(await setup.install(true)).toEqual({ ok: false, error: 'não consegui instalar o Codex: sem PATH' });
  });

  it('login: devolve o que o terminal disse (o mecanismo do Claude) e só pelo navegador', () => {
    const setup = new CodexSetup({ installed: async () => true, openLogin: () => ({ ok: true, error: null }) });
    expect(setup.login(true)).toEqual({ ok: true, error: null });
    const semTerminal = new CodexSetup({ installed: async () => true, openLogin: () => ({ ok: false, error: 'nenhum terminal encontrado' }) });
    expect(semTerminal.login(true)).toEqual({ ok: false, error: 'nenhum terminal encontrado' });
  });
});
