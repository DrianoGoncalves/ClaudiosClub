import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanEnv, parseAuthStatus } from '../server/auth';
import { companyOf, ConfigPatch, readConfig, removeCompany, saveCompany, setArchived, setProjectCompany, updateConfig } from '../server/config';
import { readUsage } from '../server/usage';
import { projectBudgetHit, UsageStopError } from '../server/usageStop';
import type { AccountUsage } from '../shared/model';
import { ensureMycoGitignore, IGNORED_IMAGES } from '../server/mycoGitignore';

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-server-'));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('.myco/.gitignore', () => {
  it('cria com as imagens e, se já existe, só acrescenta o que falta', async () => {
    const proj = path.join(root, 'proj-gi');
    await ensureMycoGitignore(proj);
    const file = path.join(proj, '.myco', '.gitignore');
    const first = await fs.readFile(file, 'utf8');
    for (const l of IGNORED_IMAGES) expect(first).toContain(`${l}\n`);

    await fs.writeFile(file, 'minha-regra\nstaff/*.jpg');
    await ensureMycoGitignore(proj);
    const lines = (await fs.readFile(file, 'utf8')).split('\n');
    expect(lines[0]).toBe('minha-regra');
    expect(lines.filter((l) => l === 'staff/*.jpg')).toHaveLength(1);
    expect(lines).toContain('project.webp');
  });
});

describe('auth', () => {
  it('tira do ambiente o que desvia o CLI da assinatura', () => {
    const env = cleanEnv({ PATH: 'x', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_ENTRYPOINT: 'e', CLAUDECODE: '1', HOME: 'h' });
    expect(env).toEqual({ PATH: 'x', HOME: 'h' });
  });

  it('lê o JSON do `claude auth status` (deslogado sai com código 1, mas imprime o JSON)', () => {
    const at = new Date('2026-10-26T12:00:00Z');
    expect(parseAuthStatus('{\n  "loggedIn": false,\n  "authMethod": "none"\n}', at)).toEqual({
      cliFound: true,
      loggedIn: false,
      authMethod: 'none',
      subscription: false,
      error: null,
      checkedAt: at.toISOString(),
    });
    expect(parseAuthStatus('{"loggedIn": true, "authMethod": "claude.ai"}')).toMatchObject({ loggedIn: true, subscription: true });
    expect(parseAuthStatus('{"loggedIn": true, "authMethod": "console"}')).toMatchObject({ loggedIn: true, subscription: false });
    expect(parseAuthStatus('quebrado')).toMatchObject({ loggedIn: false, error: expect.any(String) });
  });
});

describe('config', () => {
  it('usa "MyCo" por padrão e grava o nome preservando outras chaves', async () => {
    const file = path.join(root, 'cfg', 'config.json');
    const usageStop = { fiveHour: 90, sevenDay: 95 };
    const colors = { projectColors: {}, boardBackground: { light: null, dark: null }, projectBudgets: {}, companies: [], projectCompanies: {} };
    // Quem chega (sem config) começa no simples.
    expect(await readConfig(file)).toEqual({
      companyName: 'MyCo',
      uiLevel: 'simple',
      archived: { projects: [], sessions: [] },
      usageStop,
      sendWhileBusy: 'next',
      ...colors,
    });

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ futuro: 1 }));
    // Quem já tinha config (já usava o MyCo antes da opção) fica no avançado.
    expect(await updateConfig({ companyName: 'Acme Labs' }, file)).toEqual({
      companyName: 'Acme Labs',
      uiLevel: 'advanced',
      archived: { projects: [], sessions: [] },
      usageStop,
      sendWhileBusy: 'next',
      ...colors,
    });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ futuro: 1, companyName: 'Acme Labs' });
    expect((await updateConfig({ uiLevel: 'simple' }, file)).uiLevel).toBe('simple');
  });

  it('empresas: cria com id do nome, renomeia sem trocar o id, recusa nome repetido', async () => {
    const file = path.join(root, 'cfg-emp', 'config.json');
    const noBg = { light: null, dark: null };
    let cfg = await saveCompany({ name: 'Acme Labs', color: 'teal' }, file);
    expect(cfg.companies).toEqual([{ id: 'acme-labs', name: 'Acme Labs', color: 'teal', background: noBg }]);
    cfg = await saveCompany({ name: 'Ação Ltda' }, file);
    expect(cfg.companies[1]).toEqual({ id: 'acao-ltda', name: 'Ação Ltda', color: null, background: noBg });
    await expect(saveCompany({ name: 'acme labs' }, file)).rejects.toThrow('já existe');
    // Fundo por tema, um de cada vez; renomear sem mandar cor nem fundo mantém os dois.
    await saveCompany({ id: 'acme-labs', name: 'Acme Labs', background: { dark: '#1A2B3C' } }, file);
    cfg = await saveCompany({ id: 'acme-labs', name: 'Acme Labs', background: { light: '#f6f0e1' } }, file);
    expect(cfg.companies[0]).toMatchObject({ color: 'teal', background: { light: '#f6f0e1', dark: '#1a2b3c' } });
    await expect(saveCompany({ id: 'acme-labs', name: 'Acme Labs', background: { light: 'azul' } }, file)).rejects.toThrow();
    cfg = await saveCompany({ id: 'acme-labs', name: 'Acme', color: null, background: { light: null } }, file);
    expect(cfg.companies[0]).toEqual({ id: 'acme-labs', name: 'Acme', color: null, background: { light: null, dark: '#1a2b3c' } });
    await expect(saveCompany({ id: 'sumiu', name: 'X' }, file)).rejects.toThrow('não encontrada');
    await expect(saveCompany({ name: '' }, file)).rejects.toThrow('nome');
    // Mesmo nome-base depois de renomear: o id ganha um número.
    expect((await saveCompany({ name: 'Acme Labs' }, file)).companies.map((c) => c.id)).toEqual(['acme-labs', 'acao-ltda', 'acme-labs-2']);
  });

  it('empresa do projeto: atribui, tira, e remover a empresa deixa os projetos sem empresa', async () => {
    const file = path.join(root, 'cfg-emp2', 'config.json');
    await saveCompany({ name: 'Acme' }, file);
    await saveCompany({ name: 'Beta' }, file);
    await setProjectCompany('p1', 'acme', file);
    await setProjectCompany('p2', 'beta', file);
    let cfg = await setProjectCompany('p3', 'acme', file);
    expect(cfg.projectCompanies).toEqual({ p1: 'acme', p2: 'beta', p3: 'acme' });
    expect(companyOf(cfg, 'p2')?.name).toBe('Beta');
    expect(companyOf(cfg, 'p9')).toBeNull();
    await expect(setProjectCompany('p1', 'sumiu', file)).rejects.toThrow('não encontrada');
    cfg = await setProjectCompany('p3', null, file);
    expect(cfg.projectCompanies).toEqual({ p1: 'acme', p2: 'beta' });
    cfg = await removeCompany('acme', file);
    expect(cfg).toMatchObject({ companies: [{ id: 'beta' }], projectCompanies: { p2: 'beta' } });
    // Editado à mão: empresa inválida some, e projeto de empresa que não existe fica sem empresa.
    await fs.writeFile(file, JSON.stringify({ companies: [{ id: 'ok', name: 'Ok' }, { id: 'Ruim!', name: 'x' }, 3], projectCompanies: { a: 'ok', b: 'fantasma', c: 1 } }));
    expect(await readConfig(file)).toMatchObject({ companies: [{ id: 'ok', name: 'Ok', color: null, background: { light: null, dark: null } }], projectCompanies: { a: 'ok' } });
  });

  it('linha de parada: null desliga um limite; valores fora de 1–100 são recusados', async () => {
    const file = path.join(root, 'cfg3', 'config.json');
    const cfg = await updateConfig(ConfigPatch.parse({ usageStop: { fiveHour: 80, sevenDay: null } }), file);
    expect(cfg.usageStop).toEqual({ fiveHour: 80, sevenDay: null });
    expect(ConfigPatch.safeParse({ usageStop: { fiveHour: 0, sevenDay: 50 } }).success).toBe(false);
  });

  it('orçamento por projeto: grava por partes, null tira, valor estranho no arquivo é ignorado', async () => {
    const file = path.join(root, 'cfg-budget', 'config.json');
    await updateConfig(ConfigPatch.parse({ projectBudgets: { a: 30, b: 10 } }), file);
    expect((await updateConfig(ConfigPatch.parse({ projectBudgets: { b: null } }), file)).projectBudgets).toEqual({ a: 30 });
    expect(ConfigPatch.safeParse({ projectBudgets: { a: 0 } }).success).toBe(false);
    expect(ConfigPatch.safeParse({ projectBudgets: { a: 150 } }).success).toBe(false);
    await fs.writeFile(file, JSON.stringify({ projectBudgets: { a: 'muito', c: 40 } }));
    expect((await readConfig(file)).projectBudgets).toEqual({ c: 40 });
  });

  it('orçamento por projeto: a parte do projeto na cota de 7 dias', () => {
    const usage = { limits: [{ kind: 'seven_day', percentUsed: 60, resetsAt: '2999-01-01T00:00:00Z' }] } as AccountUsage;
    // 40% do custo da semana × 60% da cota = 24% da cota.
    expect(projectBudgetHit(usage, { project: 4, total: 10 }, 30, 'loja')).toBeNull();
    expect(projectBudgetHit(usage, { project: 4, total: 10 }, 20, 'loja')).toMatchObject({ kind: 'project_week', percentUsed: 24, limit: 20, projectName: 'loja' });
    expect(projectBudgetHit(usage, { project: 4, total: 10 }, undefined, 'loja')).toBeNull();
    expect(projectBudgetHit(usage, { project: 0, total: 0 }, 5, 'loja')).toBeNull();
    expect(new UsageStopError(projectBudgetHit(usage, { project: 4, total: 10 }, 20, 'loja')!).message).toContain('loja já usou cerca de 24%');
  });

  it('mensagem durante o trabalho: grava a prioridade; valor estranho no arquivo volta ao padrão', async () => {
    const file = path.join(root, 'cfg4', 'config.json');
    expect((await updateConfig(ConfigPatch.parse({ sendWhileBusy: 'later' }), file)).sendWhileBusy).toBe('later');
    expect(ConfigPatch.safeParse({ sendWhileBusy: 'ja' }).success).toBe(false);
    await fs.writeFile(file, JSON.stringify({ sendWhileBusy: 'ja' }));
    expect((await readConfig(file)).sendWhileBusy).toBe('next');
  });

  it('cor da sala: define e limpa por projeto, sem mexer nos outros', async () => {
    const file = path.join(root, 'cfg5', 'config.json');
    await updateConfig(ConfigPatch.parse({ projectColors: { a: 'red', b: 'teal' } }), file);
    expect((await updateConfig(ConfigPatch.parse({ projectColors: { a: 'blue' } }), file)).projectColors).toEqual({ a: 'blue', b: 'teal' });
    expect((await updateConfig(ConfigPatch.parse({ projectColors: { b: null } }), file)).projectColors).toEqual({ a: 'blue' });
    // Outro campo no mesmo arquivo não apaga as cores.
    expect((await updateConfig(ConfigPatch.parse({ companyName: 'X' }), file)).projectColors).toEqual({ a: 'blue' });
    expect(ConfigPatch.safeParse({ projectColors: { a: 'marrom' } }).success).toBe(false);
    expect(ConfigPatch.safeParse({ projectColors: { '': 'red' } }).success).toBe(false);
  });

  it('cor da sala: entrada estranha no arquivo some, as boas ficam', async () => {
    const file = path.join(root, 'cfg6', 'config.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ companyName: 'Y', projectColors: { a: 'green', b: 'marrom', c: 3 } }));
    const cfg = await readConfig(file);
    expect(cfg.projectColors).toEqual({ a: 'green' });
    expect(cfg.companyName).toBe('Y');
    await fs.writeFile(file, JSON.stringify({ companyName: 'Z', projectColors: 'vermelho' }));
    expect(await readConfig(file)).toMatchObject({ companyName: 'Z', projectColors: {} });
  });

  it('fundo do quadro: um tema por vez, null volta ao padrão, só #rrggbb', async () => {
    const file = path.join(root, 'cfg7', 'config.json');
    expect((await updateConfig(ConfigPatch.parse({ boardBackground: { light: '#F6F0E1' } }), file)).boardBackground).toEqual({
      light: '#f6f0e1',
      dark: null,
    });
    expect((await updateConfig(ConfigPatch.parse({ boardBackground: { dark: '#18212f' } }), file)).boardBackground).toEqual({
      light: '#f6f0e1',
      dark: '#18212f',
    });
    expect((await updateConfig(ConfigPatch.parse({ boardBackground: { light: null } }), file)).boardBackground).toEqual({
      light: null,
      dark: '#18212f',
    });
    for (const bad of ['red', '#fff', '#12345g', 'url(x)']) {
      expect(ConfigPatch.safeParse({ boardBackground: { light: bad } }).success, bad).toBe(false);
    }
    await fs.writeFile(file, JSON.stringify({ boardBackground: { light: 'azul', dark: '#000000' } }));
    expect((await readConfig(file)).boardBackground).toEqual({ light: null, dark: '#000000' });
  });

  it('arquiva e desarquiva projetos e funcionários sem duplicar', async () => {
    const file = path.join(root, 'cfg2', 'config.json');
    await setArchived({ kind: 'project', id: 'p1', archived: true }, file);
    await setArchived({ kind: 'project', id: 'p1', archived: true }, file);
    const cfg = await setArchived({ kind: 'session', id: 's1', archived: true }, file);
    expect(cfg.archived).toEqual({ projects: ['p1'], sessions: ['s1'] });
    expect((await setArchived({ kind: 'project', id: 'p1', archived: false }, file)).archived).toEqual({
      projects: [],
      sessions: ['s1'],
    });
  });
});

describe('usage', () => {
  it('diz se o mod está instalado e lê o que ele gravou', async () => {
    const usageFile = path.join(root, 'usage.json');
    const tapFile = path.join(root, 'mods', 'myco-tap', 'hooks', 'register.ts');

    expect(await readUsage(usageFile, tapFile)).toEqual({ tapInstalled: false, limits: [], updatedAt: null });

    await fs.mkdir(path.dirname(tapFile), { recursive: true });
    await fs.writeFile(tapFile, '');
    await fs.writeFile(
      usageFile,
      // BOM, como o PowerShell grava
      '﻿' +
      JSON.stringify({
        updatedAt: '2026-10-26T12:00:00.000Z',
        sessionId: 'abc',
        limits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-26T15:00:00.000Z' }],
      }),
    );
    expect(await readUsage(usageFile, tapFile)).toEqual({
      tapInstalled: true,
      updatedAt: '2026-10-26T12:00:00.000Z',
      limits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-26T15:00:00.000Z' }],
    });
  });
});
