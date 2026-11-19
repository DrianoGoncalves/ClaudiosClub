import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_PRESETS, PLAYBOOK_AGENTS } from '../shared/agentPresets';
import type { Agent, Board, StaffProfile } from '../shared/model';
import { AgentList } from '../client/src/detail/Detail';
import { agentBrief, presetDrift, roleTag, roleText, rosterRows } from '../client/src/staff/agentRoles';
import { StaffForm } from '../client/src/staff/HireForm';
import staff from '../client/src/i18n/staff';

const known = (rows: Array<[string, string | null, string | null]>) => new Map(rows.map(([n, model, effort]) => [n, { model, effort }]));

describe('papel dos agents prontos (pensador × executor)', () => {
  it('o contrato do servidor: executor implementa em Sonnet, o rápido faz o mecânico em Haiku, os dois no roteiro', () => {
    const byName = Object.fromEntries(AGENT_PRESETS.map((p) => [p.name, p]));
    expect([byName.executor?.model, byName.executor?.effort]).toEqual(['sonnet', 'medium']);
    expect([byName['executor-rapido']?.model, byName['executor-rapido']?.effort]).toEqual(['haiku', 'low']);
    expect(PLAYBOOK_AGENTS['plan-big-execute-small']).toEqual(expect.arrayContaining(['executor', 'executor-rapido']));
  });

  it('cada pronto tem papel e etiqueta; agent que não é pronto, nenhum', () => {
    for (const p of AGENT_PRESETS) {
      expect(roleText(p.name), p.name).toBeTruthy();
      expect(roleTag(p.name), p.name).toBeTruthy();
    }
    expect(roleTag('executor')).toBe('implementa');
    expect(roleTag('executor-rapido')).toBe('mecânico');
    expect(roleText('designer')).toBeNull();
    expect(roleTag('toString')).toBeNull();
  });

  it('modelo e esforço em uma linha; sem modelo vale o de quem chama', () => {
    expect(agentBrief('sonnet', 'medium')).toBe('Sonnet · Medium');
    expect(agentBrief('haiku', null)).toBe('Haiku');
    expect(agentBrief('claude-sonnet-4-5', 'xhigh')).toBe('claude-sonnet-4-5 · XHigh');
    expect(agentBrief(null, null)).toBe('modelo de quem chama');
    expect(agentBrief('inherit', 'low')).toBe('modelo de quem chama · Low');
  });

  describe('arquivo que difere do pronto atual', () => {
    it('o executor que ficou no Haiku antigo: modelo e esforço diferem', () => {
      const d = presetDrift('executor', 'haiku', 'low');
      expect(d).toMatchObject({ model: true, effort: true });
      expect(d?.preset.model).toBe('sonnet');
    });

    it('igual ao pronto: sem aviso', () => {
      expect(presetDrift('executor', 'sonnet', 'medium')).toBeNull();
      expect(presetDrift('executor-rapido', 'haiku', 'low')).toBeNull();
    });

    it('só o esforço difere: o modelo não acusa', () => {
      expect(presetDrift('revisor', 'sonnet', 'max')).toMatchObject({ model: false, effort: true });
    });

    it("'inherit' e esforço vazio contam como sem valor (o formulário usa esses)", () => {
      expect(presetDrift('executor', 'inherit', '')).toMatchObject({ model: true, effort: true });
      expect(presetDrift('executor', null, null)).toMatchObject({ model: true, effort: true });
    });

    it('agent que não é pronto: nunca difere', () => {
      expect(presetDrift('designer', 'haiku', 'low')).toBeNull();
    });
  });

  describe('quem ajuda no roteiro', () => {
    it('mostra os 4 do roteiro na ordem dele; o que falta no projeto será criado, com o modelo do pronto', () => {
      const rows = rosterRows('plan-big-execute-small', known([]), false);
      expect(rows.map((r) => r.name)).toEqual(PLAYBOOK_AGENTS['plan-big-execute-small']);
      expect(rows.every((r) => r.created)).toBe(true);
      expect(Object.fromEntries(rows.map((r) => [r.name, r.brief]))).toEqual({
        pesquisador: 'Haiku · Low',
        executor: 'Sonnet · Medium',
        'executor-rapido': 'Haiku · Low',
        revisor: 'Sonnet · High',
      });
      expect(rows.every((r) => r.role.length > 0)).toBe(true);
    });

    it('o que já está no projeto mostra o arquivo de verdade, não o pronto', () => {
      const rows = rosterRows('plan-big-execute-small', known([['executor', 'haiku', 'low']]), false);
      const executor = rows.find((r) => r.name === 'executor');
      expect(executor).toMatchObject({ brief: 'Haiku · Low', created: false });
      expect(rows.find((r) => r.name === 'revisor')?.created).toBe(true);
    });

    it('roteiro menor lista só os agents dele', () => {
      expect(rosterRows('review-gate', known([]), false).map((r) => r.name)).toEqual(['executor', 'revisor']);
    });

    it('no Codex o modelo do agent não vale: modelo da conversa, só o esforço vem do agent', () => {
      const rows = rosterRows('plan-big-execute-small', known([['executor', 'haiku', 'high']]), true);
      expect(rows.find((r) => r.name === 'executor')?.brief).toBe('modelo da conversa · esforço High');
      expect(rows.find((r) => r.name === 'revisor')?.brief).toBe('modelo da conversa · esforço High');
      expect(rows.find((r) => r.name === 'executor-rapido')?.brief).toBe('modelo da conversa · esforço Low');
      expect(rosterRows('plan-big-execute-small', known([['executor', 'haiku', null]]), true).find((r) => r.name === 'executor')?.brief).toBe('modelo da conversa');
    });
  });
});

describe('lista de agents do projeto', () => {
  const agent = (name: string, model: string | null, effort: string | null): Agent =>
    ({ id: `p:${name}`, name, description: `desc ${name}`, tools: null, model, effort, scope: 'project', filePath: `/x/${name}.md`, link: { kind: 'file', target: null }, duplicate: false, error: null }) as unknown as Agent;
  const html = (agents: Agent[]) => renderToStaticMarkup(createElement(AgentList, { agents, empty: 'nada' }));

  it('o pronto leva a etiqueta do papel; o agent que não é pronto, não', () => {
    const out = html([agent('executor', 'sonnet', 'medium'), agent('executor-rapido', 'haiku', 'low'), agent('designer', 'sonnet', null)]);
    expect(out).toContain('<span class="badge dim">implementa</span>');
    expect(out).toContain('<span class="badge dim">mecânico</span>');
    expect(out.match(/badge dim/g)).toHaveLength(2);
  });

  it('executor que ficou no Haiku antigo: o cartão diz qual é o pronto atual e qual o arquivo usa', () => {
    const out = html([agent('executor', 'haiku', 'low')]);
    expect(out).toContain('O pronto atual de “executor” é Sonnet · Medium; este usa Haiku · Low. Edite para trocar.');
  });

  it('igual ao pronto, ou só o esforço diferente: sem aviso na lista', () => {
    expect(html([agent('executor', 'sonnet', 'medium')])).not.toContain('pronto atual');
    expect(html([agent('revisor', 'sonnet', 'max')])).not.toContain('pronto atual');
  });

  it('agent com erro de leitura não ganha aviso', () => {
    const broken = { ...agent('executor', 'haiku', 'low'), error: 'frontmatter inválido' } as Agent;
    expect(html([broken])).not.toContain('pronto atual');
  });
});

describe('ficha aberta: quem ajuda no roteiro', () => {
  const board = (agents: Agent[] = []): Board =>
    ({
      projects: [{ id: 'p1', name: 'Loja', path: 'C:/loja', exists: true }],
      inventories: { p1: { agents, skills: [] } },
      user: { agents: [], skills: [] },
      staff: [],
    }) as unknown as Board;
  const open = (playbook: StaffProfile['playbook'], agents: Agent[] = []) => {
    const profile = { id: 's1', projectId: 'p1', name: 'Jinx', role: 'Back-end', mission: 'm', autonomy: 'manual', playbook, skills: [], agents: [], servers: [], reportsTo: [], rules: [], knowledge: [] } as unknown as StaffProfile;
    return renderToStaticMarkup(
      createElement(StaffForm, { board: board(agents), projectId: 'p1', mode: { kind: 'edit', profile }, onClose: () => {}, onHired: () => {}, onSaved: () => {} }),
    );
  };

  it('com o roteiro Planeja grande, executa pequeno: os 4 agents, com papel e modelo, criados ao abrir a conversa', () => {
    const out = open('plan-big-execute-small');
    expect(out).toContain('Quem ajuda neste roteiro');
    for (const name of PLAYBOOK_AGENTS['plan-big-execute-small']) expect(out).toContain(`<b class="mono">${name}</b>`);
    expect(out.match(/criado ao abrir a conversa/g)).toHaveLength(4);
    expect(out).toContain('Sonnet · Medium');
    expect(out).toContain('Implementa o que o funcionário decidiu');
    expect(out).toContain('Tarefa mecânica, sem julgamento');
    expect(out).toContain('Mudança pequena, local e de baixo risco ele mesmo faz');
  });

  it('o executor que o projeto já tem aparece com o arquivo dele, não com o pronto', () => {
    const out = open('plan-big-execute-small', [agent('executor', 'haiku', 'low')]);
    expect(out.match(/criado ao abrir a conversa/g)).toHaveLength(3);
    expect(out).toContain('já está no projeto');
    expect(out).toContain('Haiku · Low');
  });

  it('sem roteiro: a lista não aparece', () => {
    expect(open(null)).not.toContain('Quem ajuda neste roteiro');
  });

  function agent(name: string, model: string | null, effort: string | null): Agent {
    return { id: `p:${name}`, name, description: null, tools: null, model, effort, scope: 'project', filePath: `/x/${name}.md`, link: { kind: 'file', target: null }, duplicate: false, error: null } as unknown as Agent;
  }
});

describe('textos nos 3 idiomas', () => {
  const KEYS = [
    'staff.rosterTitle',
    'staff.rosterCreated',
    'staff.rosterHave',
    'staff.rosterInherit',
    'staff.rosterEffort',
    'staff.rosterNote',
    'staff.presetExecutor',
    'staff.presetExecutorFast',
    'staff.roleExecutor',
    'staff.roleExecutorFast',
    'staff.roleResearcher',
    'staff.roleReviewer',
    'staff.roleTagExecutor',
    'staff.roleTagExecutorFast',
    'staff.roleTagResearcher',
    'staff.roleTagReviewer',
    'staff.presetDrift',
    'staff.presetDriftApply',
    'staff.presetDriftList',
    'staff.playbookBigSmallHelp',
    'staff.codexPlaybookNote',
  ] as const;
  const dict = staff as unknown as Record<'pt-BR' | 'en' | 'es', Record<string, string>>;

  it.each(['pt-BR', 'en', 'es'] as const)('%s tem todas as chaves, sem texto vazio', (lang) => {
    for (const k of KEYS) expect(dict[lang]?.[k], `${lang} ${k}`).toBeTruthy();
  });

  it('o rótulo do executor diz Sonnet e o do rápido, Haiku (o modelo dos prontos)', () => {
    for (const lang of ['pt-BR', 'en', 'es'] as const) {
      expect(dict[lang]?.['staff.presetExecutor']).toContain('Sonnet');
      expect(dict[lang]?.['staff.presetExecutorFast']).toContain('Haiku');
    }
  });

  it('os marcadores {…} de cada idioma são os mesmos do português', () => {
    const slots = (s: string | undefined) => [...(s ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of KEYS) {
      for (const lang of ['en', 'es'] as const) expect(slots(dict[lang]?.[k]), `${lang} ${k}`).toEqual(slots(dict['pt-BR']?.[k]));
    }
  });
});

describe('em outro idioma', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  const inLocale = async (locale: string) => {
    vi.resetModules();
    vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
    return import('../client/src/staff/agentRoles');
  };

  it.each([
    ['en', 'implements', 'caller model'],
    ['es', 'implementa', 'modelo de quien llama'],
  ])('%s: etiqueta e "sem modelo" traduzidos', async (locale, tag, caller) => {
    const mod = await inLocale(locale);
    expect(mod.roleTag('executor')).toBe(tag);
    expect(mod.agentBrief(null, null)).toBe(caller);
  });
});
