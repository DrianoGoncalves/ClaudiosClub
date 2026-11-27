import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_ROLES, type RoleEntry } from '../shared/roles';

// O vitest roda sem DOM: o portal vira o próprio conteúdo para dar para renderizar a tela.
vi.mock('react-dom', async (orig) => ({ ...(await orig<typeof import('react-dom')>()), createPortal: (c: unknown) => c }));
vi.stubGlobal('document', { body: {}, documentElement: {}, querySelector: () => null });
const { RolesScreen, firstSentence } = await import('../client/src/toolbar/RolesEditor');

const roles = BUILTIN_ROLES.slice(0, 3).map((r, i) => ({ ...r, builtin: true, isDefault: i === 0 })) as unknown as RoleEntry[];

describe('Ver cargos em modo de escolher', () => {
  it('mostra os cards e os filtros de nicho, sem editar, apagar, padrão nem novo cargo', () => {
    const html = renderToStaticMarkup(createElement(RolesScreen, { roles, onClose: () => {}, onPick: () => {}, selectedId: roles[1]!.id }));
    for (const r of roles) expect(html).toContain(r.label);
    expect(html).toContain('roles-filters');
    expect(html).toContain('Escolher cargo');
    expect(html).not.toContain('name="default-role"');
    expect(html).not.toContain('Novo cargo');
    expect(html).not.toContain('Remover');
    expect(html).toContain('roles-card is-on');
  });
  it('no modo da Config mantém as ações de edição', () => {
    const manage = { busy: false, error: null, current: true, hiddenBuiltins: 0, onNew() {}, onEdit() {}, onDefault() {}, onDelete() {}, onRestore() {} };
    const html = renderToStaticMarkup(createElement(RolesScreen, { roles, onClose: () => {}, manage }));
    expect(html).toContain('name="default-role"');
    expect(html).toContain('Novo cargo');
  });
  it('a missão do card é só a 1ª frase', () => {
    expect(firstSentence('Faz isto. Depois aquilo.')).toBe('Faz isto.');
  });
});
