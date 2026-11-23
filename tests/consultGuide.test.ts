import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSULT_GUIDE_MAX_BYTES, readConsultGuide } from '../server/staff/consultGuide';

// O CLAUDE.md do projeto consultado que entra no prompt da consulta no Claude (t-1a9bf2): lido com teto, só da raiz, e nunca um link que sai da pasta do projeto.

let root: string;
let n = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-consult-guide-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const project = async () => {
  const dir = path.join(root, `p${n++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

describe('readConsultGuide', () => {
  it('lê o CLAUDE.md da raiz; sem o arquivo (ou vazio, ou pasta) não há nada', async () => {
    const dir = await project();
    expect(await readConsultGuide(dir)).toBeNull();
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), '﻿  \n');
    expect(await readConsultGuide(dir)).toBeNull();
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), '﻿# Regras\nUse npm test.\n');
    expect(await readConsultGuide(dir)).toEqual({ text: '# Regras\nUse npm test.', truncated: false });
    const dirAsFile = await project();
    await fs.mkdir(path.join(dirAsFile, 'CLAUDE.md'));
    expect(await readConsultGuide(dirAsFile)).toBeNull();
    expect(await readConsultGuide(path.join(root, 'nao-existe'))).toBeNull();
  });

  it('só a raiz: CLAUDE.md de subpasta, CLAUDE.local.md e .claude/rules não entram', async () => {
    const dir = await project();
    await fs.mkdir(path.join(dir, 'sub'));
    await fs.mkdir(path.join(dir, '.claude', 'rules'), { recursive: true });
    await fs.writeFile(path.join(dir, 'sub', 'CLAUDE.md'), 'SUBPASTA');
    await fs.writeFile(path.join(dir, 'CLAUDE.local.md'), 'LOCAL');
    await fs.writeFile(path.join(dir, '.claude', 'rules', 'x.md'), 'REGRA');
    expect(await readConsultGuide(dir)).toBeNull();
  });

  it('acima do teto: só o começo (até o teto em bytes), marcado como cortado; no teto exato, inteiro', async () => {
    const dir = await project();
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), `INICIO-OK\n${'a'.repeat(CONSULT_GUIDE_MAX_BYTES)}\nFIM-CORTADO`);
    const cut = (await readConsultGuide(dir))!;
    expect(cut.truncated).toBe(true);
    expect(cut.text.startsWith('INICIO-OK')).toBe(true);
    expect(cut.text).not.toContain('FIM-CORTADO');
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(CONSULT_GUIDE_MAX_BYTES);
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), 'b'.repeat(CONSULT_GUIDE_MAX_BYTES));
    expect(await readConsultGuide(dir)).toMatchObject({ truncated: false });
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), 'b'.repeat(CONSULT_GUIDE_MAX_BYTES + 1));
    expect(await readConsultGuide(dir)).toMatchObject({ truncated: true });
  });

  it('o corte no meio de um caractere de vários bytes não deixa o caractere quebrado no fim', async () => {
    const dir = await project();
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), `${'a'.repeat(9)}${'ã'.repeat(20)}`);
    const guide = (await readConsultGuide(dir, 10))!;
    expect(guide.truncated).toBe(true);
    expect(guide.text).toBe(`${'a'.repeat(9)}`);
    expect(guide.text.includes(String.fromCharCode(0xfffd))).toBe(false);
  });

  it('não expande @imports: a linha segue como está e o arquivo importado não entra', async () => {
    const dir = await project();
    await fs.mkdir(path.join(dir, 'docs'));
    await fs.writeFile(path.join(dir, 'docs', 'extra.md'), 'IMPORTADO');
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), 'Veja @docs/extra.md');
    expect((await readConsultGuide(dir))!.text).toBe('Veja @docs/extra.md');
  });

  it('um CLAUDE.md que é link para um arquivo FORA do projeto (um segredo) não vira prompt', async () => {
    const dir = await project();
    const fora = path.join(root, 'segredo.txt');
    await fs.writeFile(fora, 'SEGREDO-DE-FORA');
    try {
      await fs.symlink(fora, path.join(dir, 'CLAUDE.md'), 'file');
    } catch (err) {
      // Windows sem privilégio para link simbólico: o caso não se monta aqui.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    expect(await readConsultGuide(dir)).toBeNull();
    // Link para um arquivo DENTRO do projeto continua valendo.
    await fs.rm(path.join(dir, 'CLAUDE.md'));
    await fs.mkdir(path.join(dir, 'docs'));
    await fs.writeFile(path.join(dir, 'docs', 'guia.md'), 'DENTRO');
    await fs.symlink(path.join(dir, 'docs', 'guia.md'), path.join(dir, 'CLAUDE.md'), 'file');
    expect((await readConsultGuide(dir))!.text).toBe('DENTRO');
  });
});
