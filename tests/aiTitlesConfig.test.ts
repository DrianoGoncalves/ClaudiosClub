import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigPatch, readConfig, updateConfig } from '../server/config';
import { removeTemp } from './support/tmp';

// Opção aiTitles no config: arquivo temporário, nada toca o ~/.myco.

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-aititles-'));
});

afterAll(() => removeTemp(root));

const fileWith = async (name: string, body: unknown): Promise<string> => {
  const file = path.join(root, name);
  await fs.writeFile(file, JSON.stringify(body), 'utf8');
  return file;
};

describe('opção aiTitles (config)', () => {
  it('padrão ligada quando não há arquivo', async () => {
    expect((await readConfig(path.join(root, 'nao-existe.json'))).aiTitles).toBe(true);
  });

  it('config antigo, sem a chave, fica ligada', async () => {
    const file = await fileWith('antigo.json', { companyName: 'Acme' });
    expect((await readConfig(file)).aiTitles).toBe(true);
  });

  it('valor inválido vira o padrão e o resto do config segue', async () => {
    const file = await fileWith('invalido.json', { aiTitles: 'x', companyName: 'Acme', maxActiveChats: 3 });
    const cfg = await readConfig(file);
    expect(cfg.aiTitles).toBe(true);
    expect(cfg.companyName).toBe('Acme');
    expect(cfg.maxActiveChats).toBe(3);
  });

  it('updateConfig grava false, preserva chaves desconhecidas e readConfig lê de volta', async () => {
    const file = await fileWith('grava.json', { chaveDesconhecida: { a: 1 }, companyName: 'Acme' });
    expect((await updateConfig({ aiTitles: false }, file)).aiTitles).toBe(false);
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    expect(raw.aiTitles).toBe(false);
    expect(raw.chaveDesconhecida).toEqual({ a: 1 });
    expect(raw.companyName).toBe('Acme');
    expect((await readConfig(file)).aiTitles).toBe(false);

    expect((await updateConfig({ aiTitles: true }, file)).aiTitles).toBe(true);
    expect((await readConfig(file)).aiTitles).toBe(true);
  });

  it('ConfigPatch aceita só booleano', () => {
    expect(ConfigPatch.safeParse({ aiTitles: false }).success).toBe(true);
    expect(ConfigPatch.safeParse({ aiTitles: 'não' }).success).toBe(false);
    expect(ConfigPatch.safeParse({ aiTitles: 0 }).success).toBe(false);
  });
});
