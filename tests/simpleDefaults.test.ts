import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { ANIMATIONS_KEY, animationsOn, readAnimationsChoice } from '../client/src/animations';
import { readConfig, updateConfig } from '../server/config';
import { removeTemp } from './support/tmp';

describe('Animações: padrão do nível Simples', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Simples sem escolha salva = ligada, mesmo com o sistema pedindo menos movimento', () => {
    expect(animationsOn(null, 'simple', false)).toBe(true);
    expect(animationsOn(null, 'simple', true)).toBe(true);
  });

  it('Avançado (e nível ainda não chegado) sem escolha segue o "reduzir animações" do sistema, como antes', () => {
    expect(animationsOn(null, 'advanced', false)).toBe(true);
    expect(animationsOn(null, 'advanced', true)).toBe(false);
    expect(animationsOn(null, null, true)).toBe(false);
  });

  it('escolha salva vale em qualquer nível', () => {
    for (const level of ['simple', 'advanced', null] as const) {
      expect(animationsOn(false, level, false)).toBe(false);
      expect(animationsOn(true, level, true)).toBe(true);
    }
  });

  it('lê a escolha do armazenamento: "1" liga, "0" desliga, o resto é "nunca escolheu"', () => {
    const store = (value: string | null) => vi.stubGlobal('localStorage', { getItem: (key: string) => (key === ANIMATIONS_KEY ? value : null) });
    store('1');
    expect(readAnimationsChoice()).toBe(true);
    store('0');
    expect(readAnimationsChoice()).toBe(false);
    store(null);
    expect(readAnimationsChoice()).toBeNull();
    store('talvez');
    expect(readAnimationsChoice()).toBeNull();
  });

  it('sem armazenamento = "nunca escolheu" (o Simples liga)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('bloqueado');
      },
    });
    expect(readAnimationsChoice()).toBeNull();
  });
});

describe('Otimizar assinatura: padrão do nível Simples', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-simple-defaults-'));
  });
  afterAll(() => removeTemp(dir));

  it('config sem escolha salva = Simples com a otimização desligada', async () => {
    const config = await readConfig(path.join(dir, 'novo', 'config.json'));
    expect(config).toMatchObject({ uiLevel: 'simple', optimizeQuota: false });
  });

  it('config antiga sem a chave também começa desligada; a escolha salva (ligada ou não) não muda', async () => {
    const file = path.join(dir, 'antigo', 'config.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ companyName: 'Acme' }));
    expect((await readConfig(file)).optimizeQuota).toBe(false);

    expect((await updateConfig({ optimizeQuota: true }, file)).optimizeQuota).toBe(true);
    expect((await readConfig(file)).optimizeQuota).toBe(true);
    expect((await updateConfig({ uiLevel: 'advanced' }, file)).optimizeQuota).toBe(true);

    expect((await updateConfig({ optimizeQuota: false }, file)).optimizeQuota).toBe(false);
    expect((await readConfig(file)).optimizeQuota).toBe(false);
  });
});
