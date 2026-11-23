import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentInput, readAgentSource, saveAgent } from '../server/adapters/claude/agentWrite';
import { migrateAgentPresets, migrateProjectAgents } from '../server/staff/presetMigration';
import { AGENT_PRESETS } from '../shared/agentPresets';
import { removeTemp } from './support/tmp';

// Migração do executor: só o arquivo igual ao pronto antigo (Haiku/low) vira o novo (Sonnet/medium); o personalizado fica como está.

// O pronto de antes da mudança, escrito à mão aqui (independente da cópia que o código guarda).
const OLD_PROMPT = [
  'Você é um executor. Faça exatamente a tarefa recebida, sem ampliar o escopo.',
  '- Leia só o necessário para a tarefa.',
  '- Se algo estiver ambíguo ou fora do combinado, pare e diga o que falta em vez de adivinhar.',
  '- Não chame outros agents nem divida a tarefa: se ela for grande demais, devolva dizendo isso.',
  '- Commit, push, instalar dependências, apagar arquivos ou mexer fora dos arquivos combinados só se a tarefa pedir.',
  '- Antes de responder, rode a verificação que a tarefa pedir (ou a mais simples que prove que funciona).',
  '- Responda curto: o que mudou, com arquivo:linha, e o que você verificou (comando e resultado). Não cole arquivos inteiros nem diffs longos.',
  '- Se não conseguiu, diga o motivo e onde parou, em uma ou duas linhas.',
].join('\n');
const OLD_EXECUTOR = {
  name: 'executor',
  description: 'Executa tarefas bem especificadas que o orquestrador delegar: editar os arquivos indicados, aplicar mudanças repetitivas, rodar comandos de verificação.',
  model: 'haiku',
  effort: 'low' as 'low' | 'high',
  tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'PowerShell'],
  prompt: OLD_PROMPT,
};

let root: string;
let dir: string;
let backup: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-premig-'));
  dir = path.join(root, '.claude', 'agents');
  backup = path.join(root, 'bak');
});
afterEach(() => removeTemp(root));

/** Cria o executor como o código antigo criava (saveAgent com o pronto de então). */
async function writeOld(over: Partial<typeof OLD_EXECUTOR> = {}) {
  await saveAgent(dir, AgentInput.parse({ ...OLD_EXECUTOR, ...over }), path.join(root, 'unused'));
}

describe('migrateAgentPresets', () => {
  it('arquivo igual ao pronto antigo: vira o novo (Sonnet, médio, prompt e descrição novos) e o anterior vai para o backup', async () => {
    await writeOld();
    const before = await fs.readFile(path.join(dir, 'executor.md'), 'utf8');
    const r = await migrateAgentPresets(dir, backup);
    expect(r).toEqual({ updated: ['executor'], kept: [] });
    const now = AGENT_PRESETS.find((p) => p.name === 'executor')!;
    expect(await readAgentSource(dir, 'executor')).toMatchObject({ model: 'sonnet', effort: 'medium', description: now.description, prompt: now.prompt });
    const saved = await fs.readdir(backup);
    expect(saved).toHaveLength(1);
    expect(await fs.readFile(path.join(backup, saved[0]!), 'utf8')).toBe(before);
  });

  it('personalizado (modelo, prompt, ferramentas, descrição ou chave extra): não é tocado e a nota diz no que difere', async () => {
    const cases: Array<[string, Partial<typeof OLD_EXECUTOR>, string]> = [
      ['modelo', { model: 'opus' }, 'model'],
      ['esforço', { effort: 'high' }, 'effort'],
      ['prompt', { prompt: OLD_PROMPT + '\n- Responda em inglês.' }, 'prompt'],
      ['ferramentas', { tools: ['Read', 'Grep'] }, 'tools'],
      ['descrição', { description: 'O executor do nosso time, com as regras do nosso time.' }, 'description'],
    ];
    for (const [label, over, field] of cases) {
      await fs.rm(dir, { recursive: true, force: true });
      await writeOld(over);
      const before = await fs.readFile(path.join(dir, 'executor.md'), 'utf8');
      const r = await migrateAgentPresets(dir, backup);
      expect(r.updated, label).toEqual([]);
      expect(r.kept, label).toHaveLength(1);
      expect(r.kept[0], label).toMatch(/^executor \(personalizado: difere do pronto antigo em .*/);
      expect(r.kept[0], label).toContain(field);
      expect(await fs.readFile(path.join(dir, 'executor.md'), 'utf8'), label).toBe(before);
    }
    await expect(fs.readdir(backup)).rejects.toThrow(); // nada foi regravado: nem backup
  });

  it('chave extra no frontmatter (color…) conta como personalizado', async () => {
    await writeOld();
    const file = path.join(dir, 'executor.md');
    const text = (await fs.readFile(file, 'utf8')).replace('\n---\n', '\ncolor: blue\n---\n');
    await fs.writeFile(file, text);
    const r = await migrateAgentPresets(dir, backup);
    expect(r.updated).toEqual([]);
    expect(r.kept[0]).toContain('chaves extras: color');
    expect(await fs.readFile(file, 'utf8')).toBe(text);
  });

  it('o personalizado escrito à mão, com outro nome de arquivo, também fica', async () => {
    await fs.mkdir(dir, { recursive: true });
    const own = path.join(dir, 'dev.md');
    await fs.writeFile(own, '---\nname: executor\ndescription: o meu executor, do jeito do projeto\nmodel: haiku\n---\n\nmeu\n');
    const r = await migrateAgentPresets(dir, backup);
    expect(r.updated).toEqual([]);
    expect(r.kept).toHaveLength(1);
    expect(await fs.readFile(own, 'utf8')).toContain('meu');
  });

  it('já está no pronto novo, ou o projeto não tem executor: nada a fazer e nada a dizer', async () => {
    expect(await migrateAgentPresets(dir, backup)).toEqual({ updated: [], kept: [] });
    const now = AGENT_PRESETS.find((p) => p.name === 'executor')!;
    await saveAgent(dir, AgentInput.parse({ ...now, tools: now.tools.split(',').map((t) => t.trim()) }), backup);
    const before = await fs.readFile(path.join(dir, 'executor.md'), 'utf8');
    expect(await migrateAgentPresets(dir, backup)).toEqual({ updated: [], kept: [] });
    expect(await fs.readFile(path.join(dir, 'executor.md'), 'utf8')).toBe(before);
  });

  it('só mexe no executor: pesquisador e revisor antigos, mesmo iguais ao pronto, seguem como estão', async () => {
    for (const name of ['pesquisador', 'revisor']) {
      const p = AGENT_PRESETS.find((x) => x.name === name)!;
      await saveAgent(dir, AgentInput.parse({ ...p, tools: p.tools.split(',').map((t) => t.trim()) }), backup);
    }
    const before = await Promise.all(['pesquisador', 'revisor'].map((n) => fs.readFile(path.join(dir, `${n}.md`), 'utf8')));
    await writeOld();
    await migrateAgentPresets(dir, backup);
    expect(await Promise.all(['pesquisador', 'revisor'].map((n) => fs.readFile(path.join(dir, `${n}.md`), 'utf8')))).toEqual(before);
  });

  it('link: não regrava o destino, só avisa', async () => {
    const elsewhere = path.join(root, 'outro', '.claude', 'agents');
    await saveAgent(elsewhere, AgentInput.parse(OLD_EXECUTOR), backup);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.symlink(path.join(elsewhere, 'executor.md'), path.join(dir, 'executor.md'));
    } catch {
      return; // sem permissão para criar symlink (Windows sem modo desenvolvedor)
    }
    const before = await fs.readFile(path.join(elsewhere, 'executor.md'), 'utf8');
    const r = await migrateAgentPresets(dir, backup);
    expect(r).toEqual({ updated: [], kept: ['executor (é um link: não atualizado)'] });
    expect(await fs.readFile(path.join(elsewhere, 'executor.md'), 'utf8')).toBe(before);
  });
});

describe('migrateProjectAgents', () => {
  const project = async (id: string, make?: () => Promise<void>) => {
    const p = path.join(root, id);
    dir = path.join(p, '.claude', 'agents');
    if (make) await make();
    return { id, path: p };
  };

  it('migra cada projeto uma vez: o registro guarda o resultado, e a segunda rodada não toca em mais nada', async () => {
    const a = await project('a', () => writeOld());
    const b = await project('b', () => writeOld({ model: 'opus' }));
    const c = await project('c'); // sem .claude/agents
    const recordFile = path.join(root, 'agents-migracao.json');
    const first = await migrateProjectAgents({ projects: [a, b, c], recordFile, backupDir: backup });
    expect(first).toEqual({
      a: { updated: ['executor'], kept: [] },
      b: { updated: [], kept: [expect.stringContaining('personalizado')] },
      c: { updated: [], kept: [] },
    });
    expect(JSON.parse(await fs.readFile(recordFile, 'utf8'))).toEqual(first);
    // Um arquivo antigo que aparece depois (outro checkout) não é refeito: o projeto já foi migrado.
    await fs.rm(path.join(root, 'a'), { recursive: true });
    await project('a', () => writeOld());
    expect(await migrateProjectAgents({ projects: [a], recordFile, backupDir: backup })).toEqual({});
    expect(await readAgentSource(path.join(root, 'a', '.claude', 'agents'), 'executor')).toMatchObject({ model: 'haiku' });
    // Projeto novo entra na rodada seguinte, os antigos seguem fora.
    const d = await project('d', () => writeOld());
    expect(Object.keys(await migrateProjectAgents({ projects: [a, d], recordFile, backupDir: backup }))).toEqual(['d']);
    expect(Object.keys(JSON.parse(await fs.readFile(recordFile, 'utf8'))).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('registro ilegível não trava: começa vazio', async () => {
    const a = await project('a', () => writeOld());
    const recordFile = path.join(root, 'agents-migracao.json');
    await fs.writeFile(recordFile, '{ não é json');
    expect(await migrateProjectAgents({ projects: [a], recordFile, backupDir: backup })).toEqual({ a: { updated: ['executor'], kept: [] } });
  });
});
