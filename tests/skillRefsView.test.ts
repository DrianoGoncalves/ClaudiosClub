import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Board, Skill, StaffProfile } from '../shared/model';
import { StaffForm } from '../client/src/staff/HireForm';
import { goneSkills, skillIsGone } from '../client/src/staff/skillGone';
import {
  convertSkills as serverConvert,
  formatSkillRef as serverFormat,
  parseSkillRef as serverParse,
  planSkills,
  resolveLegacySkill as serverResolve,
} from '../server/skillAccess';
import { formatSkillRef, normalizeSkills, parseSkillRef, resolveLegacySkill, skillCatalog, skillLabels, templateSkills } from '../client/src/staff/skillRefs';

const user = (name: string, scope: Skill['scope'] = 'user') => ({ name, scope });

// Conta: motion-design e deploy (Global), vps sincronizada. Projeto: deploy (mesmo nome nos dois escopos) e relatorio.
// `null` = inventário do projeto não lido (`undefined` cairia no padrão).
const catalog = (project: string[] | null = ['deploy', 'relatorio']) =>
  skillCatalog(project?.map((name) => ({ name })), [user('motion-design'), user('deploy'), user('vps', 'synced')]);

describe('ficha: skills com escopo (global:/project:)', () => {
  it('a lista oferece Global (conta) e Projeto; o mesmo nome nos dois escopos são duas linhas; sincronizada não é oferecida', () => {
    expect(catalog().offered.map((o) => o.ref)).toEqual(['global:deploy', 'project:deploy', 'global:motion-design', 'project:relatorio']);
    expect(catalog().all.get('global:vps')).toMatchObject({ synced: true });
    expect(catalog().all.get('project:vps')).toBeUndefined();
  });

  it('ref reconhecida: marcada e existente no escopo dela = sem linha extra e sem selo', () => {
    const c = catalog();
    expect(goneSkills(['global:motion-design', 'project:relatorio', 'global:deploy', 'project:deploy'], c)).toEqual([]);
  });

  it('nome antigo (sem escopo) vira a ref pela regra do servidor: Global, senão Projeto, senão Global', () => {
    const c = catalog();
    expect(normalizeSkills(['motion-design', 'relatorio', 'deploy', 'apagada'], c)).toEqual([
      'global:motion-design',
      'project:relatorio',
      'global:deploy',
      'global:apagada',
    ]);
    expect(normalizeSkills(['motion-design', 'global:motion-design', 'project:relatorio'], c)).toEqual(['global:motion-design', 'project:relatorio']);
    // marcada com o nome antigo e existente: a linha normal fica marcada, sem selo
    expect(goneSkills(normalizeSkills(['motion-design'], c), c)).toEqual([]);
  });

  it('selo só quando a skill daquela ref não existe no escopo dela', () => {
    const c = catalog();
    expect(skillIsGone('global:apagada', c)).toBe(true);
    expect(skillIsGone('project:apagada', c)).toBe(true);
    // existe só no outro escopo: a ref marcada não tem skill
    expect(skillIsGone('project:motion-design', c)).toBe(true);
    expect(skillIsGone('global:relatorio', c)).toBe(true);
    expect(skillIsGone('global:motion-design', c)).toBe(false);
    expect(skillIsGone('project:deploy', c)).toBe(false);
  });

  it('sincronizada marcada existe: fica à vista (não é oferecida), sem selo', () => {
    const c = catalog();
    expect(goneSkills(['global:vps'], c)).toEqual(['global:vps']);
    expect(skillIsGone('global:vps', c)).toBe(false);
  });

  it('inventário do projeto não lido: não acusa skill do projeto, mas a Global segue valendo', () => {
    const c = catalog(null);
    expect(skillIsGone('project:relatorio', c)).toBe(false);
    expect(skillIsGone('global:apagada', c)).toBe(true);
  });

  it('inventário não lido: nome antigo que não é Global NÃO vira global:<nome> (o servidor converte ao salvar)', () => {
    const c = catalog(null);
    // `relatorio` é do projeto, mas o inventário não veio: não dá para dizer que é Global
    expect(normalizeSkills(['relatorio', 'motion-design'], c)).toEqual(['relatorio', 'global:motion-design']);
    // a linha fica à vista (marcada) e não acusa que sumiu
    expect(goneSkills(['relatorio'], c)).toEqual(['relatorio']);
    expect(skillIsGone('relatorio', c)).toBe(false);
    // com o inventário lido, o mesmo nome sem escopo que não está em lugar nenhum é acusado
    expect(skillIsGone('sumiu', catalog())).toBe(true);
    expect(skillIsGone('relatorio', catalog())).toBe(false);
  });

  it('cargo: o nome vira a ref do escopo dele (Global antes de Projeto), só as oferecidas, somadas às marcadas, sem repetir', () => {
    const c = catalog();
    expect(templateSkills(['motion-design', 'relatorio', 'deploy', 'vps', 'apagada'], ['project:deploy'], c)).toEqual([
      'project:deploy',
      'global:motion-design',
      'project:relatorio',
      'global:deploy',
    ]);
    expect(templateSkills(['motion-design'], ['global:motion-design'], c)).toEqual(['global:motion-design']);
    // inventário não lido: o nome do projeto fica de fora (não dá para marcar uma ref que a lista não tem)
    expect(templateSkills(['relatorio', 'motion-design'], [], catalog(null))).toEqual(['global:motion-design']);
  });

  it('rótulo: nome simples; o mesmo nome nos dois escopos leva o escopo; ref ou nome antigo', () => {
    const scope = (s: string) => (s === 'global' ? 'Global' : 'Projeto');
    expect(skillLabels(['global:motion-design', 'project:relatorio', 'antiga'], scope)).toEqual(['motion-design', 'relatorio', 'antiga']);
    expect(skillLabels(['global:deploy', 'project:deploy'], scope)).toEqual(['deploy (Global)', 'deploy (Projeto)']);
    expect(parseSkillRef('global:a:b')).toEqual({ scope: 'global', name: 'a:b' });
    expect(parseSkillRef('antiga')).toBeNull();
  });
});

// O cliente repete as regras de ref do servidor (o navegador não importa `server/`): aqui as duas pontas têm que dar o mesmo.
describe('paridade com server/skillAccess.ts', () => {
  const sources = (names: string[]) => names.map((name) => ({ name, dir: `/x/${name}` }));
  const globals = ['motion-design', 'deploy', 'vps'];
  const projects = ['deploy', 'relatorio'];
  // Global vem de `user` + `synced`; o catálogo do cliente tem as duas, como a Global do servidor.
  const client = skillCatalog(projects.map((name) => ({ name })), [user('motion-design'), user('deploy'), user('vps', 'synced')]);
  const known = { globalNames: globals, projectNames: projects };

  it('formatar e ler a ref', () => {
    for (const raw of ['global:motion-design', 'project:relatorio', 'global:a-b-1']) expect(parseSkillRef(raw)).toEqual(serverParse(raw));
    // sem escopo (nome antigo) ou com escopo que não existe: nenhum dos dois lê
    for (const raw of ['motion-design', 'user:x']) {
      expect(parseSkillRef(raw)).toBeNull();
      expect(serverParse(raw)).toBeNull();
    }
    expect(formatSkillRef('global', 'a')).toBe(serverFormat('global', 'a'));
    expect(formatSkillRef('project', 'a')).toBe(serverFormat('project', 'a'));
  });

  it('nome antigo vira a mesma ref (Global, senão Projeto, senão Global), repetido e ref já pronta incluídos', () => {
    const names = ['motion-design', 'relatorio', 'deploy', 'vps', 'apagada', 'global:deploy', 'project:deploy', 'motion-design'];
    expect(normalizeSkills(names, client)).toEqual(serverConvert(names, known).skills);
    for (const n of ['motion-design', 'relatorio', 'deploy', 'vps', 'apagada']) expect(resolveLegacySkill(n, client)).toBe(serverResolve(n, known));
  });

  it('o que existe: ref marcada existente no cliente = `planSkills` sem `missing`', () => {
    const marked = ['global:motion-design', 'global:vps', 'project:relatorio', 'project:deploy', 'global:relatorio', 'project:motion-design', 'global:apagada'];
    const plan = planSkills(marked, sources(globals), sources(projects));
    for (const ref of marked) expect(skillIsGone(ref, client)).toBe(plan.missing.includes(ref));
  });
});

describe('ficha aberta: a lista de skills', () => {
  const board = (inventory = true): Board =>
    ({
      projects: [{ id: 'p1', name: 'Loja', path: 'C:/loja', exists: true }],
      inventories: inventory ? { p1: { agents: [], skills: [{ id: 'p1:relatorio', name: 'relatorio', scope: 'project' }] } } : {},
      user: { agents: [], skills: [{ id: 'u:motion-design', name: 'motion-design', scope: 'user' }, { id: 'u:vps', name: 'vps', scope: 'synced' }] },
      staff: [],
    }) as unknown as Board;
  const open = (skills: string[], inventory = true) => {
    const profile = { id: 's1', projectId: 'p1', name: 'Jinx', role: 'Design', mission: 'm', autonomy: 'manual', skills, agents: [], servers: [], reportsTo: [], rules: [], knowledge: [] } as unknown as StaffProfile;
    return renderToStaticMarkup(
      createElement(StaffForm, { board: board(inventory), projectId: 'p1', mode: { kind: 'edit', profile }, onClose: () => {}, onHired: () => {}, onSaved: () => {} }),
    );
  };
  /** A linha da skill: o <label> que traz o nome; marcada = o checkbox dele vem `checked`. */
  const rows = (html: string, name: string) => html.match(new RegExp(`<label class="check"><input type="checkbox"[^>]*><span class="check-text"><span>${name}</span><span[^]*?</label>`, 'g')) ?? [];
  const row = (html: string, name: string) => rows(html, name)[0] ?? '';

  it('global:motion-design: a linha normal vem marcada e sem selo (era o falso "não existe mais")', () => {
    const html = open(['global:motion-design']);
    const line = row(html, 'motion-design');
    expect(line).toContain('checked');
    expect(line).toContain('skill · Global');
    expect(html).not.toContain('não existe mais');
    expect(html.match(/<span>motion-design</g)).toHaveLength(1);
  });

  it('project:relatorio: marcada com o escopo Projeto à vista', () => {
    const line = row(open(['project:relatorio']), 'relatorio');
    expect(line).toContain('checked');
    expect(line).toContain('skill · Projeto');
  });

  it('nome antigo sem escopo (ficha não migrada): segue marcada e sem selo', () => {
    const html = open(['motion-design']);
    expect(row(html, 'motion-design')).toContain('checked');
    expect(html).not.toContain('não existe mais');
  });

  it('skill apagada de verdade: ganha a linha marcada com o selo, e a dica de desmarcar', () => {
    const html = open(['global:apagada', 'project:sumiu']);
    expect(row(html, 'apagada')).toContain('checked');
    expect(row(html, 'apagada')).toContain('não existe mais');
    expect(row(html, 'sumiu')).toContain('skill · Projeto');
    expect(row(html, 'sumiu')).toContain('não existe mais');
    expect(html).toContain('desmarque para tirar da ficha');
  });

  it('só do outro escopo: global:relatorio (a skill é do projeto) tem selo, e a project:relatorio continua oferecida, desmarcada', () => {
    const [offered, marked] = rows(open(['global:relatorio']), 'relatorio');
    expect(offered).toContain('skill · Projeto');
    expect(offered).not.toContain('checked');
    expect(offered).not.toContain('não existe mais');
    expect(marked).toContain('skill · Global');
    expect(marked).toContain('checked');
    expect(marked).toContain('não existe mais');
  });

  it('sincronizada marcada aparece com a etiqueta e sem selo', () => {
    const html = open(['global:vps']);
    expect(row(html, 'vps')).toContain('sincronizada · Global');
    expect(html).not.toContain('não existe mais');
  });

  it('inventário do projeto não lido: skill do projeto (ref ou nome antigo) fica marcada, sem selo e sem virar global:', () => {
    for (const marked of ['project:relatorio', 'relatorio']) {
      const html = open([marked], false);
      expect(row(html, 'relatorio')).toContain('checked');
      expect(html).not.toContain('não existe mais');
      expect(html).not.toContain('global:relatorio');
    }
    // nome antigo sem escopo: a linha não inventa um escopo
    expect(row(open(['relatorio'], false), 'relatorio')).not.toContain('Global');
    // a Global que sumiu continua acusada
    expect(row(open(['global:apagada'], false), 'apagada')).toContain('não existe mais');
  });
});
