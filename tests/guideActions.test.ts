import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { GuideActionError, guideActionText, runGuideAction } from '../server/guideActions';
import { GUIDE_TEMPLATE } from '../server/projectGuide';

describe('ações do guia: textos', () => {
  it('cada ação começa com o rótulo dela, em pt-BR', () => {
    expect(guideActionText('test').startsWith('[Guia do projeto: teste de compreensão]')).toBe(true);
    expect(guideActionText('drift').startsWith('[Guia do projeto: divergência]')).toBe(true);
    expect(guideActionText('draft').startsWith('[Guia do projeto: rascunho]')).toBe(true);
  });

  it('teste: subagent novo com só o caminho e a instrução; sem Agent, para e avisa', () => {
    const t = guideActionText('test');
    expect(t).toContain('ferramenta Agent');
    expect(t).toContain('`SPEC.md`');
    expect(t).toContain('Não leia código, outros arquivos nem a web');
    expect(t).toContain('O que entendi');
    expect(t).toContain('🔴 (impede entender), 🟡 (importante) ou 🟢 (detalhe)');
    expect(t).toContain('Não passe ao subagent a sua opinião, o contexto nem esta conversa.');
    expect(t).toContain('este teste não vale no mesmo contexto');
    expect(t).toContain('Não edite sem o ok do usuário');
  });

  it('divergência: só divergências com arquivo:linha, as seis categorias, "Nenhuma divergência", e não edita', () => {
    const d = guideActionText('drift');
    expect(d).toContain('Explore');
    expect(d).toContain('arquivo:linha');
    expect(d).toContain('"Fora do escopo"');
    expect(d).toContain('Nenhuma divergência');
    expect(d).toContain('Não edite nada.');
  });

  it('rascunho: inclui o modelo do GUIDE_TEMPLATE, pede dúvidas em aberto e proíbe commit', () => {
    const r = guideActionText('draft');
    expect(r).toContain(GUIDE_TEMPLATE);
    expect(r).toContain('"Dúvidas em aberto"');
    expect(r).toContain('Não faça commit nem git add.');
  });
});

describe('ações do guia: runGuideAction', () => {
  let dir: string;
  let sent: Array<{ staffId: string; text: string; force: boolean }>;
  const ana = { id: 'ana-1', name: 'Ana', role: 'Revisora' } as StaffProfile;
  const deps = () => ({
    readProfile: async (id: string) => (id === 'ana-1' ? ana : null),
    send: async (staffId: string, text: string, force: boolean) => {
      sent.push({ staffId, text, force });
      return 'sess-9';
    },
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-acoes-guia-'));
    sent = [];
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('teste com SPEC.md: abre conversa nova do funcionário com o texto da ação e devolve o id', async () => {
    await fs.writeFile(path.join(dir, 'SPEC.md'), '# Guia\n', 'utf8');
    const r = await runGuideAction(deps(), dir, { action: 'test', staffId: 'ana-1' });
    expect(r).toEqual({ sessionId: 'sess-9', staffId: 'ana-1' });
    expect(sent).toEqual([{ staffId: 'ana-1', text: guideActionText('test'), force: false }]);
  });

  it('divergência sem SPEC.md: 400 (GuideActionError), e nada é enviado', async () => {
    await expect(runGuideAction(deps(), dir, { action: 'drift', staffId: 'ana-1' })).rejects.toThrow(/não há SPEC\.md/);
    expect(sent).toEqual([]);
  });

  it('teste sem SPEC.md: 400 também', async () => {
    await expect(runGuideAction(deps(), dir, { action: 'test', staffId: 'ana-1' })).rejects.toBeInstanceOf(GuideActionError);
    expect(sent).toEqual([]);
  });

  it('rascunho com SPEC.md já escrito: 400, não sobrescreve nem envia', async () => {
    await fs.writeFile(path.join(dir, 'SPEC.md'), 'texto meu', 'utf8');
    await expect(runGuideAction(deps(), dir, { action: 'draft', staffId: 'ana-1' })).rejects.toThrow(/não sobrescreve/);
    expect(sent).toEqual([]);
  });

  it('rascunho sem SPEC.md: envia o texto do rascunho', async () => {
    const r = await runGuideAction(deps(), dir, { action: 'draft', staffId: 'ana-1' });
    expect(r).toEqual({ sessionId: 'sess-9', staffId: 'ana-1' });
    expect(sent[0]!.text.startsWith('[Guia do projeto: rascunho]')).toBe(true);
  });

  it('funcionário inexistente: null (a rota responde 404) e nada é enviado', async () => {
    await fs.writeFile(path.join(dir, 'SPEC.md'), '# Guia\n', 'utf8');
    expect(await runGuideAction(deps(), dir, { action: 'test', staffId: 'ninguem' })).toBeNull();
    expect(sent).toEqual([]);
  });

  it('ação inválida ou sem funcionário: 400 com mensagem em pt-BR', async () => {
    await expect(runGuideAction(deps(), dir, { action: 'x', staffId: 'ana-1' })).rejects.toThrow(/ação inválida/);
    await expect(runGuideAction(deps(), dir, { action: 'test' })).rejects.toThrow(/escolha quem faz a ação/);
    await expect(runGuideAction(deps(), dir, undefined)).rejects.toBeInstanceOf(GuideActionError);
    expect(sent).toEqual([]);
  });
});
