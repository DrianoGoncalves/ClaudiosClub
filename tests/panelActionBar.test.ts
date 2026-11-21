import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { EmployeePanel } from '../client/src/detail/Detail';
import { employeeBarPlan, PlanBar, projectBarPlan, type BarPlan } from '../client/src/detail/PanelBars';
import { ActionBar } from '../client/src/lib/ActionBar';

// Guarda do ActionBar nos painéis do funcionário e do projeto: a regra de hierarquia (uma primária só, destrutiva nunca primária, primária por
// último) vale por construção, e a primária certa de cada estado fica travada aqui. O painel do projeto só monta depois de ler `api.project`, então
// a barra dele é testada pelo plano (`projectBarPlan`) renderizado no PlanBar real, o mesmo que o painel usa.

// O painel lê o 'visto' do quadro com useSyncExternalStore, que o render no servidor não suporta: aqui o quadro não viu nada.
vi.mock('../client/src/board/unread', async (orig) => ({ ...(await orig<typeof import('../client/src/board/unread')>()), useSeenIdle: () => ({}), useSeeIdle: () => {} }));

const noop = () => {};
const archive = { id: 'archive', label: 'Arquivar', danger: true, onClick: noop };
const html = (plan: BarPlan) => renderToStaticMarkup(createElement(PlanBar, { plan }));
const primaries = (s: string) => (s.match(/class="btn-primary/g) ?? []).length;
const labels = (s: string) => [...s.matchAll(/<button[^>]*class="(btn-primary|btn-secondary)[^"]*"[^>]*>(?:<svg.*?<\/svg>)?([^<]*)</g)].map((m) => `${m[1]}:${m[2]}`);

/** Sem ação vermelha na primária e a primária, se houver, é o último botão fora do "⋯". */
function expectHierarchy(out: string, why: string) {
  expect(primaries(out), why).toBeLessThanOrEqual(1);
  expect(out, why).not.toMatch(/btn-primary[^"]*is-danger/);
  if (primaries(out) === 1) expect(out.lastIndexOf('btn-primary'), why).toBeGreaterThan(out.lastIndexOf('btn-secondary'));
}

describe('painel do projeto: ActionBar', () => {
  const base = { exists: true, archived: false, paused: false, onHire: noop, onTasks: noop, onSchedules: noop, onFiles: noop, onTogglePause: noop, terminal: createElement('button', { className: 'btn-secondary btn-icon' }, 'T'), archive };

  it('em qualquer estado: no máximo 1 primária, destrutiva fora dela e a primária por último', () => {
    for (const exists of [true, false])
      for (const archived of [true, false])
        for (const paused of [true, false]) expectHierarchy(html(projectBarPlan({ ...base, exists, archived, paused })), JSON.stringify({ exists, archived, paused }));
  });

  it('primária por estado: Contratar funcionário; pausado → Retomar projeto; arquivado → Desarquivar projeto; sem pasta → nenhuma', () => {
    const normal = projectBarPlan(base);
    expect(normal.primary).toMatchObject({ id: 'hire', label: 'Contratar funcionário' });
    expect(projectBarPlan({ ...base, paused: true }).primary).toMatchObject({ id: 'resume', label: 'Retomar projeto' });
    expect(projectBarPlan({ ...base, archived: true }).primary).toMatchObject({ id: 'archive', label: 'Desarquivar projeto' });
    expect(projectBarPlan({ ...base, exists: false }).primary).toBeNull();
  });

  it('Arquivar projeto fica no "⋯", em vermelho; pausar é secundária só em ícone (quando pausado a primária é Retomar)', () => {
    const out = html(projectBarPlan(base));
    expect(out).toContain('action-bar-more');
    expect(out).toContain('class="btn-secondary is-danger action-bar-item"');
    expect(out).toContain('>Arquivar projeto<');
    expect(out).toMatch(/class="btn-secondary btn-icon"[^>]*aria-label="Pausar projeto"/);
    expect(html(projectBarPlan({ ...base, paused: true }))).not.toContain('Pausar projeto');
    expect(labels(out).at(-1)).toBe('btn-primary:Contratar funcionário');
  });

  it('sem os callbacks de tarefas, agendamentos, arquivos e pausa, esses botões não aparecem', () => {
    const out = html(projectBarPlan({ ...base, onTasks: undefined, onSchedules: undefined, onFiles: undefined, onTogglePause: undefined }));
    for (const name of ['Tarefas', 'Agendamentos', 'Arquivos', 'Pausar projeto']) expect(out).not.toContain(`aria-label="${name}"`);
  });
});

describe('painel do funcionário: ActionBar', () => {
  const base = { hasSheet: true, archived: false, temporary: false, canHire: true, onHireSub: noop, archive };

  it('em qualquer estado: no máximo 1 primária e destrutiva nunca primária', () => {
    for (const hasSheet of [true, false])
      for (const archived of [true, false])
        for (const temporary of [true, false])
          for (const canHire of [true, false]) expectHierarchy(html(employeeBarPlan({ ...base, hasSheet, archived, temporary, canHire })), JSON.stringify({ hasSheet, archived, temporary, canHire }));
  });

  it('ativo: sem primária (a principal é a conversa); Contratar subordinado secundária; Arquivar funcionário no "⋯", vermelho', () => {
    const plan = employeeBarPlan(base);
    expect(plan.primary).toBeNull();
    const out = html(plan);
    expect(out).toContain('btn-secondary">Contratar subordinado<');
    expect(out).toContain('class="btn-secondary is-danger action-bar-item"');
    expect(out).toContain('>Arquivar funcionário<');
  });

  it('arquivado com ficha: Desarquivar funcionário é a primária; o temporário restaura pelo aviso dele (aqui, secundária)', () => {
    expect(employeeBarPlan({ ...base, archived: true }).primary).toMatchObject({ label: 'Desarquivar funcionário' });
    const temp = employeeBarPlan({ ...base, archived: true, temporary: true });
    expect(temp.primary).toBeNull();
    expect(html(temp)).toMatch(/btn-secondary"[^>]*>Restaurar funcionário</);
    expect(employeeBarPlan({ ...base, archived: true, hasSheet: false }).primary).toBeNull();
  });

  const staff = (over: Partial<StaffProfile> = {}) =>
    ({ id: 'ana-1', projectId: 'p', name: 'Ana', role: 'Dev', temporary: true, hiredBy: 'rui-1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), servers: [], sessions: [], reportsTo: [], ...over }) as unknown as StaffProfile;
  const project = { id: 'p', name: 'Projeto', path: 'C:/p', exists: true } as never;
  const panel = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(EmployeePanel, { session: null, staff: null, managers: [], project: null, costUsd: null, totalUsd: 0, archived: false, onArchive: async () => {}, onHireSub: noop, onEdit: noop, ...props } as never));

  it('aviso do temporário (painel de verdade): Efetivar funcionário é a única primária; Restaurar, secundária, só com ele arquivado', () => {
    const live = panel({ staff: staff(), project });
    expect(primaries(live)).toBe(1);
    expect(live).toMatch(/class="btn-primary"[^>]*>Efetivar funcionário</);
    expect(live).not.toContain('Restaurar funcionário');
    const gone = panel({ staff: staff({ ended: { at: new Date().toISOString(), reason: 'ocioso' } } as never), project, archived: true });
    expect(primaries(gone)).toBe(1);
    expect(gone).toMatch(/btn-secondary"[^>]*>Restaurar funcionário</);
    expect(gone.indexOf('Restaurar funcionário')).toBeLessThan(gone.indexOf('Efetivar funcionário'));
  }, 30_000);

  it('sem ficha (painel de verdade): Dar uma ficha é a primária e a página toda tem uma só', () => {
    const out = panel({ staff: null, ghost: true });
    expect(primaries(out)).toBe(1);
    expect(out).toMatch(/class="btn-primary"[^>]*>Dar uma ficha</);
  });
});

describe('o código dos painéis usa o ActionBar', () => {
  const source = readFileSync('client/src/detail/Detail.tsx', 'utf8');
  // Só os painéis do funcionário e do projeto (os outros painéis do arquivo, como o da conta, ficam fora).
  const detail = source.slice(source.indexOf('export function EmployeePanel('), source.indexOf('type ProjectTab'));
  const bars = readFileSync('client/src/detail/PanelBars.tsx', 'utf8');

  it('Detail.tsx não monta mais os botões de ação à mão (`<p className="actions">`, ArchiveButton, PauseButton, "btn-primary btn-with-icon")', () => {
    expect(detail).not.toContain('className="actions"');
    expect(detail).not.toContain('ArchiveButton');
    expect(detail).not.toContain('PauseButton');
    expect(detail).not.toContain('btn-primary btn-with-icon');
    expect(detail).not.toContain('temp-notice-actions');
    expect(detail).toContain('<PlanBar');
    expect(detail).toContain('<ActionBar');
  });

  it('os painéis do projeto e do funcionário passam pelo ActionBar (e PanelBars não cria um segundo componente de barra)', () => {
    expect(bars).toContain("from '../lib/ActionBar'");
    expect(bars).toContain('<ActionBar');
    expect(bars).not.toMatch(/className="action-bar/);
  });

  it('nos painéis, só a barra tem btn-primary: o corpo do projeto (guia, vitrine, modelo de equipe) usa secundária', () => {
    for (const f of ['client/src/detail/ProjectGuide.tsx', 'client/src/detail/ShowcaseBlock.tsx', 'client/src/staff/TeamTemplatePicker.tsx']) expect(readFileSync(f, 'utf8'), f).not.toContain('btn-primary');
  });

  it('CSS: o "Responder no chat" do cartão é primária (sem amarelo próprio) e o rodapé do painel gruda embaixo', () => {
    const css = readFileSync('client/src/styles.css', 'utf8');
    expect(css).toMatch(/\.btn-primary\.task-perm-go \{[^}]*\}/);
    expect(css).not.toMatch(/\.btn-secondary\.task-perm-go/);
    expect(css).toMatch(/\.panel-foot \{[^}]*position: sticky[^}]*env\(safe-area-inset-bottom\)/);
    expect(css).toMatch(/@media \(max-width: 640px\) \{ \.btn-primary\.task-perm-go \{ min-height: 44px; \} \}/);
  });

  it('o ActionBar aceita ícone (só ícone vira btn-icon com aria-label) e nó livre nas secundárias', () => {
    const out = renderToStaticMarkup(
      createElement(ActionBar, {
        label: 'Ações',
        moreLabel: 'Mais',
        secondary: [{ id: 'a', label: 'Tarefas', icon: createElement('i'), iconOnly: true }, { id: 'n', node: createElement('b', null, 'nó') }],
        primary: { id: 'p', label: 'Contratar funcionário', icon: createElement('i') },
      }),
    );
    expect(out).toContain('class="btn-secondary btn-icon" title="Tarefas" aria-label="Tarefas"');
    expect(out).toContain('<b>nó</b>');
    expect(out).toContain('class="btn-primary btn-with-icon"');
  });
});
