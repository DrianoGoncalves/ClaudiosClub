import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PLAYBOOK_AGENTS } from '../shared/agentPresets';
import type { Board } from '../shared/model';
import staff from '../client/src/i18n/staff';
import { rosterRows } from '../client/src/staff/agentRoles';
import { StaffForm } from '../client/src/staff/HireForm';
import { PlaybookRoster } from '../client/src/staff/PlaybookRoster';
import { blank, RoleForm } from '../client/src/toolbar/RolesEditor';

const rows = rosterRows('plan-big-execute-small', new Map(), false);
const html = (forRole: boolean) => renderToStaticMarkup(createElement(PlaybookRoster, { rows, forRole }));

describe('agents do roteiro no cargo (Cargos da empresa)', () => {
  it('mostra os 4 agents com papel e modelo do pronto', () => {
    const out = html(true);
    for (const name of PLAYBOOK_AGENTS['plan-big-execute-small']) expect(out).toContain(`<b class="mono">${name}</b>`);
    expect(out).toContain('Sonnet · Medium');
    expect(out).toContain('Haiku · Low');
    expect(out).toContain('Implementa o que o funcionário decidiu');
  });

  it('no cargo não há projeto: sem "criado ao abrir" nem "já está", com a nota do cargo', () => {
    const out = html(true);
    expect(out.match(/<\/span><span class="muted small">(criado ao abrir a conversa|já está no projeto)/g)).toBeNull();
    expect(out).toContain('Modelos dos agents prontos');
    expect(out).not.toContain('Os que faltam no projeto');
  });

  it('na contratação (forRole desligado) segue como antes', () => {
    const out = html(false);
    expect(out.match(/criado ao abrir a conversa/g)).toHaveLength(4);
    expect(out).toContain('Os que faltam no projeto');
  });

  it('nota do cargo nos 3 idiomas', () => {
    const dict = staff as unknown as Record<'pt-BR' | 'en' | 'es', Record<string, string>>;
    for (const lang of ['pt-BR', 'en', 'es'] as const) expect(dict[lang]?.['staff.rosterRoleNote'], lang).toBeTruthy();
  });
});

describe('formulário de cargo (RoleForm)', () => {
  const form = (playbook: '' | 'plan-big-execute-small') =>
    renderToStaticMarkup(createElement(RoleForm, { editing: { ...blank, label: 'X', role: 'X', playbook }, setEditing: () => {}, busy: false, onSave: () => {}, onCancel: () => {} }));

  it('com roteiro: papel e modelo de cada agent, sem rótulo de projeto', () => {
    const out = form('plan-big-execute-small');
    expect(out).toContain('Sonnet · Medium');
    expect(out).toContain('Haiku · Low');
    expect(out).toContain('Modelos dos agents prontos');
    expect(out).toContain('Implementa o que o funcionário decidiu');
    expect(out).not.toContain('Os que faltam no projeto');
  });

  it('sem roteiro: a lista não aparece', () => {
    expect(form('')).not.toContain('Quem ajuda neste roteiro');
  });
});

describe('contratação no nível Simples', () => {
  const board = { projects: [{ id: 'p1', name: 'Loja', path: 'C:/loja', exists: true }], inventories: { p1: { agents: [], skills: [] } }, user: { agents: [], skills: [] }, staff: [] } as unknown as Board;
  const hire = (simple: boolean) =>
    renderToStaticMarkup(createElement(StaffForm, { board, projectId: 'p1', mode: { kind: 'hire', reportsTo: [] }, simple, onClose: () => {}, onHired: () => {}, onSaved: () => {} }));

  it('o roteiro dos agents não aparece (a lista só existe na ficha completa)', () => {
    const out = hire(true);
    expect(out).not.toContain('Quem ajuda neste roteiro');
    expect(out).not.toContain('class="roster"');
    expect(out).toContain('simple-hire');
  });
});
