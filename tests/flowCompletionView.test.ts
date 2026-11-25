import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardConfig, FlowPolicy, StaffProfile } from '../shared/model';
import { applyFlowInput, legacyPolicy, type FlowPolicyInput } from '../server/flowPolicy';
import { BoardReview, completionDefaultOnReviewer, completionIsOn, saveWithCompletionDefault, useFlowCompletion, type BoardReviewState, type FlowCompletionState } from '../client/src/tasks/BoardReview';
import { mountHooks, tag, textOf } from './support/mountHooks';

// A conclusão automática ao lado do revisor: o servidor falso usa o `applyFlowInput` de verdade (server/flowPolicy.ts), então o que a tela grava e o que o GET devolve vêm da regra real.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const person = { id: 'ana', name: 'Ana', role: 'Dev' } as StaffProfile;

afterEach(() => vi.unstubAllGlobals());

function fakeServer(initial: FlowPolicy, opts: { postStatus?: number } = {}) {
  let stored = initial;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return json(stored);
    if (opts.postStatus) return json({ error: 'só pela tela' }, opts.postStatus);
    const { source: _s, ...next } = applyFlowInput(stored, JSON.parse(String(init.body)) as FlowPolicyInput) as FlowPolicy;
    stored = { ...next, source: 'stored' };
    return json(stored);
  });
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  const posts = () => fetch.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST').map((c) => JSON.parse(String((c[1] as RequestInit).body)));
  return { fetch, posts, get: () => stored };
}

const mount = () => {
  const m = mountHooks((p: { id: string }) => useFlowCompletion(p.id), { id: 'p-1' });
  return { ...m, state: () => m.view() as FlowCompletionState };
};

describe('useFlowCompletion', () => {
  it('lê o GET; gravar { completion } só manda esse portão e o GET volta com completionChosen: true', async () => {
    const srv = fakeServer(legacyPolicy(false));
    const m = mount();
    await m.runEffects();
    expect(m.state().policy).toMatchObject({ source: 'default', completion: 'ai', completionChosen: false });

    await m.state().save('ai');
    expect(srv.posts()).toEqual([{ completion: 'ai' }]);
    expect(srv.get()).toMatchObject({ source: 'stored', mode: 'custom', completion: 'ai', completionChosen: true });
    expect(m.state().policy).toMatchObject({ source: 'stored', completionChosen: true });

    await m.state().save('owner');
    expect(srv.posts()).toEqual([{ completion: 'ai' }, { completion: 'owner' }]);
    expect(m.state().policy).toMatchObject({ completion: 'owner', completionChosen: true });
  });

  it('403: o erro aparece e a tela mostra o estado real lido do GET, sem estado falso', async () => {
    const srv = fakeServer(legacyPolicy(false), { postStatus: 403 });
    const m = mount();
    await m.runEffects();
    await m.state().save('owner');
    expect(m.state().error).toContain('só pela tela');
    expect(m.state().policy).toMatchObject({ source: 'default', completion: 'ai', completionChosen: false });
    expect(srv.get().completionChosen).toBe(false);
  });

  it('servidor sem a rota (404) ou falha de leitura: sem política na tela', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'x' }, 404)));
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const m = mount();
    await m.runEffects();
    expect(m.state().policy).toBeNull();
  });
});

describe('conclusão por padrão ao escolher o revisor', () => {
  const chosen = (completion: 'ai' | 'owner'): FlowPolicy => ({ ...legacyPolicy(false), source: 'stored', mode: 'custom', completion, completionChosen: true });

  it('só marca quando o dono ainda não escolheu; escolha já gravada (inclusive "só eu") não é sobrescrita', () => {
    expect(completionDefaultOnReviewer(null)).toBeNull();
    expect(completionDefaultOnReviewer(legacyPolicy(false))).toBe('ai');
    expect(completionDefaultOnReviewer(chosen('owner'))).toBeNull();
    expect(completionDefaultOnReviewer(chosen('ai'))).toBeNull();
  });

  const flow = (policy: FlowPolicy | null) => ({ policy, error: null, saving: false, save: vi.fn(async () => {}) }) satisfies FlowCompletionState;
  const on: BoardConfig = { autoReview: true, reviewerId: 'ana' };

  it('ligar/trocar o revisor grava { completion: ai }; desligar, ou revisão que falhou ao gravar, não toca a política', async () => {
    const f = flow(legacyPolicy(false));
    await saveWithCompletionDefault(async () => true, f, on);
    expect(f.save).toHaveBeenCalledWith('ai');

    const off = flow(legacyPolicy(false));
    await saveWithCompletionDefault(async () => true, off, { autoReview: false, reviewerId: 'ana' });
    expect(off.save).not.toHaveBeenCalled();

    const failed = flow(legacyPolicy(false));
    await saveWithCompletionDefault(async () => false, failed, on);
    expect(failed.save).not.toHaveBeenCalled();

    const already = flow(chosen('owner'));
    await saveWithCompletionDefault(async () => true, already, on);
    expect(already.save).not.toHaveBeenCalled();
  });
});

describe('BoardReview: linha da conclusão', () => {
  const review = (config: BoardConfig): BoardReviewState => ({ config, missing: false, error: null, saving: false, save: async () => true });
  const policy = (p: Partial<FlowPolicy> = {}): FlowPolicy => ({ ...legacyPolicy(false), ...p });
  const render = (config: BoardConfig, flow?: Partial<FlowCompletionState>) =>
    renderToStaticMarkup(createElement(BoardReview, { review: review(config), staff: [person], flow: flow && { policy: null, error: null, saving: false, save: async () => {}, ...flow } }));
  const on: BoardConfig = { autoReview: true, reviewerId: 'ana' };

  it('sem a política (lendo, ou servidor sem a rota) a linha não aparece', () => {
    expect(render(on)).not.toContain('Concluir sozinho');
    expect(render(on, { policy: null })).not.toContain('Concluir sozinho');
  });

  it('ligada (gravada pelo dono, ai): avisa que mescla no principal sem o clique do dono, sem a nota de padrão', () => {
    const html = render(on, { policy: policy({ source: 'stored', mode: 'custom', completion: 'ai', completionChosen: true }) });
    expect(html).toContain('Concluir sozinho quando o revisor aprovar');
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Ligada<\/button>/);
    expect(html).toContain('mesclada no projeto principal sem o seu clique');
    expect(html).not.toContain('você ainda não escolheu');
    expect(html).not.toContain('nada conclui sozinho');
  });

  it("padrão/legado (completion 'ai' herdado, completionChosen false): aparece DESLIGADA, como o servidor, com a nota 'você ainda não escolheu'", () => {
    const legacy = policy();
    expect(legacy).toMatchObject({ source: 'default', completion: 'ai', completionChosen: false });
    expect(completionIsOn(legacy)).toBe(false);
    expect(completionIsOn(policy({ source: 'stored', completion: 'ai', completionChosen: false }))).toBe(false);
    expect(completionIsOn(policy({ source: 'stored', completion: 'ai', completionChosen: true }))).toBe(true);
    expect(completionIsOn(policy({ source: 'stored', completion: 'owner', completionChosen: true }))).toBe(false);
    const html = render(on, { policy: legacy });
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Desligada<\/button>/);
    expect(html).toContain('você ainda não escolheu');
    expect(html).not.toContain('mesclada no projeto principal sem o seu clique');
  });

  it("clicar nesse estado grava { completion: 'ai' } (um clique liga de fato); ligado de verdade, o clique grava 'owner'", () => {
    const click = (p: FlowPolicy) => {
      const save = vi.fn(async () => {});
      const m = mountHooks(BoardReview, { review: review(on), staff: [person], flow: { policy: p, error: null, saving: false, save } });
      const tree = m.view();
      // O botão da conclusão é o rotulado (aria-labelledby) pelo texto "Concluir sozinho…".
      const labelId = tag(tree, 'span').find((s) => textOf(s) === 'Concluir sozinho quando o revisor aprovar')!.props.id;
      const btn = tag(tree, 'button').find((b) => b.props['aria-labelledby'] === labelId)!;
      (btn.props.onClick as () => void)();
      return save;
    };
    expect(click(policy())).toHaveBeenCalledWith('ai');
    expect(click(policy({ source: 'stored', completion: 'ai', completionChosen: true }))).toHaveBeenCalledWith('owner');
  });

  it('escolhida pelo dono, desligada: o revisor revisa mas o aprovado espera o dono; sem o aviso de padrão', () => {
    const html = render(on, { policy: policy({ source: 'stored', mode: 'custom', completion: 'owner', completionChosen: true }) });
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Desligada<\/button>/);
    expect(html).toContain('a tarefa aprovada espera a sua aprovação');
    expect(html).not.toContain('você ainda não escolheu');
  });

  it('revisão automática desligada: a linha continua e diz que nada conclui sozinho sem revisor', () => {
    const html = render({ autoReview: false, reviewerId: null }, { policy: policy() });
    expect(html).toContain('Concluir sozinho quando o revisor aprovar');
    expect(html).toContain('nada conclui sozinho');
  });

  it('erro da rota aparece (sem política, só o erro)', () => {
    const html = render(on, { policy: null, error: 'só pela tela' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('só pela tela');
  });
});
