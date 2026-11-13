import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Skill } from '../shared/model';
import type { SkillSource } from '../client/src/api';
import { SkillHooksWarning, SkillManage, SkillManageView } from '../client/src/detail/SkillManage';
import { deletedNotice, hookLabel, hooksChanged, needsHooksConfirm, skillLock, skillRef } from '../client/src/detail/skillAccess';
import { goneSkills, skillIsGone } from '../client/src/staff/skillGone';

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: 'x',
  name: 'vps',
  label: null,
  description: null,
  scope: 'user',
  readOnly: false,
  dirPath: 'C:/Users/a/.claude/skills/vps',
  link: { kind: 'file', target: null },
  error: null,
  ...over,
});

const source = (over: Partial<SkillSource> = {}): SkillSource => ({ name: 'vps', content: '# vps', editable: true, link: null, ...over });

const render = (props: Partial<Parameters<typeof SkillManageView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SkillManageView, {
      name: 'vps',
      source: source(),
      loadError: null,
      saved: false,
      confirming: false,
      busy: false,
      error: null,
      onEdit: () => {},
      onAskDelete: () => {},
      onDelete: () => {},
      ...props,
    }),
  );

describe('skill: quem dá para editar e excluir', () => {
  it('conta e projeto sim; o servidor monta a pasta (só escopo, projeto e nome vão)', () => {
    expect(skillRef(skill(), null)).toEqual({ scope: 'user', projectId: null, name: 'vps' });
    expect(skillRef(skill({ scope: 'project' }), 'p1')).toEqual({ scope: 'project', projectId: 'p1', name: 'vps' });
  });

  it('sincronizada (ou somente leitura) e projeto sem id não têm ação', () => {
    expect(skillRef(skill({ scope: 'synced', readOnly: true }), null)).toBeNull();
    expect(skillRef(skill({ readOnly: true }), null)).toBeNull();
    expect(skillRef(skill({ scope: 'project' }), null)).toBeNull();
  });

  it('o motivo do bloqueio: link (com o destino) ou outro', () => {
    expect(skillLock(source())).toBeNull();
    expect(skillLock(source({ editable: false, link: 'D:/origem/vps' }))).toEqual({ kind: 'link', target: 'D:/origem/vps' });
    expect(skillLock(source({ editable: false }))).toEqual({ kind: 'other' });
  });
});

describe('skill: seção Editar ou excluir', () => {
  it('editável: Editar e Excluir (vermelho), sem confirmação aberta', () => {
    const html = render();
    expect(html).toContain('Editar ou excluir');
    expect(html).toContain('>Editar<');
    expect(html).toMatch(/btn-secondary is-danger[^>]*>Excluir</);
    expect(html).not.toContain('Mover para a lixeira');
  });

  it('confirmar: diz que vai para a lixeira e pode ser recuperada; "Manter" e sem Editar', () => {
    const html = render({ confirming: true });
    expect(html).toContain('lixeira');
    expect(html).toContain('pode ser recuperada');
    expect(html).toContain('“vps”');
    expect(html).toContain('Mover para a lixeira');
    expect(html).toContain('Manter');
    expect(html).not.toContain('>Editar<');
  });

  it('excluindo: botões travados', () => {
    const html = render({ confirming: true, busy: true });
    expect(html).toContain('Movendo…');
    expect((html.match(/ disabled/g) ?? []).length).toBe(2);
  });

  it('link: sem ações e mostra o destino', () => {
    const html = render({ source: source({ editable: false, link: 'D:/origem/vps' }) });
    expect(html).toContain('D:/origem/vps');
    expect(html).toContain('link');
    expect(html).not.toContain('<button');
  });

  it('bloqueada por outro motivo: sem ações e diz que o Club não libera', () => {
    const html = render({ source: source({ editable: false }) });
    expect(html).toContain('não libera a edição');
    expect(html).not.toContain('<button');
  });

  it('lendo: só o aviso de carregando; falha na leitura mostra a mensagem do servidor', () => {
    expect(render({ source: null })).toContain('Carregando…');
    expect(render({ source: null })).not.toContain('<button');
    const html = render({ source: null, loadError: 'skill não encontrada' });
    expect(html).toContain('skill não encontrada');
    expect(html).not.toContain('Carregando…');
  });

  it('o erro do servidor (hook apontando) aparece como veio, inclusive com os botões de volta', () => {
    const msg = 'hook de PreToolUse em C:/Users/a/.claude/settings.json aponta para esta skill: tire o hook antes de apagar';
    const html = render({ error: msg });
    expect(html).toContain(msg);
    expect(html).toContain('class="error"');
    expect(html).toContain('>Editar<');
  });

  it('salvou: confirma e diz que a versão anterior ficou em backup', () => {
    const html = render({ saved: true });
    expect(html).toContain('Salvo.');
    expect(html).toContain('backup');
  });
});

describe('skill: excluir com hooks vinculados', () => {
  const hooks = [
    { file: 'C:/Users/a/.claude/settings.json', event: 'PreToolUse' },
    { file: 'C:/proj/.claude/settings.local.json', event: 'Stop' },
  ];
  const warning = (props: Partial<Parameters<typeof SkillHooksWarning>[0]> = {}) =>
    renderToStaticMarkup(createElement(SkillHooksWarning, { name: 'vps', hooks, busy: false, error: null, onYes: () => {}, onCancel: () => {}, ...props }));

  it('o alerta lista cada hook (evento e arquivo), avisa que param de rodar e do backup, e pergunta', () => {
    const html = warning();
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('“vps”');
    for (const h of hooks) {
      expect(html).toContain(`<strong>${h.event}</strong>`);
      expect(html).toContain(h.file);
    }
    expect(html).toContain('deixam de rodar');
    expect(html).toContain('proteções');
    expect(html).toContain('~/.myco/backups/settings');
    expect(html).toContain('Deseja continuar?');
  });

  it('Cancelar (com o foco) e Sim (vermelho); nenhum botão de fechar escrito', () => {
    const html = warning();
    expect(html).toMatch(/<button[^>]*autoFocus|<button[^>]*autofocus/i);
    expect(html).toMatch(/btn-secondary"[^>]*>Cancelar</);
    expect(html).toMatch(/btn-secondary is-danger"[^>]*>Sim</);
  });

  it('removendo: os dois botões travam e o Sim vira "Removendo…"', () => {
    const html = warning({ busy: true });
    expect(html).toContain('Removendo…');
    expect((html.match(/ disabled/g) ?? []).length).toBe(2);
  });

  it('hooks que mudaram: a mensagem do servidor aparece acima da pergunta, com a lista nova', () => {
    const msg = 'os hooks mudaram desde o aviso: confirme de novo';
    const html = warning({ error: msg, hooks: [hooks[1]!] });
    expect(html).toContain(msg);
    expect(html.indexOf(msg)).toBeLessThan(html.indexOf('Deseja continuar?'));
    expect(html).not.toContain('PreToolUse');
    expect(warning()).not.toContain('class="error"');
  });

  it('a resposta do servidor: aviso com a lista (nada apagado) ou a skill na lixeira', () => {
    expect(needsHooksConfirm({ needsConfirm: true, hooks })).toBe(true);
    expect(needsHooksConfirm({ trash: 'C:/lixeira/vps' })).toBe(false);
    expect(needsHooksConfirm({ trash: 'C:/lixeira/vps', removedHooks: hooks, settingsBackups: ['C:/b/settings.json'] })).toBe(false);
  });

  it('só a recusa dos hooks que mudaram volta ao aviso; as outras ficam como erro', () => {
    expect(hooksChanged('os hooks mudaram desde o aviso: confirme de novo')).toBe(true);
    expect(hooksChanged('C:/Users/a/.claude/settings.json não é um JSON válido: corrija antes de apagar a skill')).toBe(false);
    expect(hooksChanged('skill não encontrada')).toBe(false);
  });

  it('aviso do canto: sem hooks = só a lixeira; com hooks = quais saíram e onde estão os backups', () => {
    expect(deletedNotice({ trash: 'C:/lixeira/vps' })).toEqual({ key: 'app.skillDeleted', hooks: '', backups: '' });
    expect(hookLabel(hooks[0]!)).toBe('PreToolUse (C:/Users/a/.claude/settings.json)');
    expect(deletedNotice({ trash: 'C:/lixeira/vps', removedHooks: hooks, settingsBackups: ['C:/b/a.json', 'C:/b/b.json'] })).toEqual({
      key: 'app.skillDeletedHooks',
      hooks: 'PreToolUse (C:/Users/a/.claude/settings.json); Stop (C:/proj/.claude/settings.local.json)',
      backups: 'C:/b/a.json; C:/b/b.json',
    });
  });
});

describe('skill sincronizada no painel', () => {
  const panel = (s: Skill, projectId: string | null = null) =>
    renderToStaticMarkup(createElement(SkillManage, { skill: s, projectId, onChanged: () => {}, onDeleted: () => {} }));

  it('sem ações e com o motivo (vem de fora do Club, só leitura)', () => {
    const html = panel(skill({ scope: 'synced', readOnly: true }));
    expect(html).toContain('sincronizada da conta');
    expect(html).toContain('só para leitura');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Carregando…');
  });

  it('skill da conta ou do projeto começa lendo o SKILL.md (sem botões até o servidor responder)', () => {
    for (const html of [panel(skill()), panel(skill({ scope: 'project' }), 'p1')]) {
      expect(html).toContain('Editar ou excluir');
      expect(html).toContain('Carregando…');
      expect(html).not.toContain('<button');
    }
  });
});

describe('ficha: skill marcada que não existe mais', () => {
  it('só as marcadas ao abrir que a lista não oferece; lendo a biblioteca, nenhuma', () => {
    expect(goneSkills(['vps', 'deploy'], ['deploy', 'docs'], 'ok')).toEqual(['vps']);
    expect(goneSkills(['vps'], [], 'loading')).toEqual([]);
    expect(goneSkills([], ['docs'], 'ok')).toEqual([]);
    expect(goneSkills(['vps'], ['vps'], 'ok')).toEqual([]);
  });

  it('biblioteca que não leu: a linha fica (dá para desmarcar), mas sem acusar que sumiu', () => {
    expect(goneSkills(['vps'], [], 'failed')).toEqual(['vps']);
    expect(skillIsGone('vps', 'failed', new Set())).toBe(false);
    expect(skillIsGone('vps', 'loading', new Set())).toBe(false);
  });

  it('sincronizada marcada existe: só não é oferecida', () => {
    expect(skillIsGone('vps', 'ok', new Set())).toBe(true);
    expect(skillIsGone('vps', 'ok', new Set(['vps']))).toBe(false);
  });
});
