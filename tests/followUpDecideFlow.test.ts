import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowUpDecide } from '../client/src/tasks/TaskFollowUps';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// O fluxo de "Criar card" de verdade, clique a clique: o componente real (`FollowUpDecide`) rodando sobre um despachante de hooks mínimo (o projeto não tem jsdom nem renderizador de teste),
// com o servidor falso na borda (fetch). Cada `view()` renderiza de novo com o estado que os cliques deixaram. Serve a quatro coisas: expandir não duplica o botão, o botão que sobra é o
// que cria o card (a rota e o corpo que saem), o botão desliga enquanto envia e um segundo envio nesse intervalo não chama o servidor.

type El = { type: unknown; props: Record<string, any> };
const isEl = (n: unknown): n is El => !!n && typeof n === 'object' && 'props' in (n as object) && 'type' in (n as object);

/** Todos os elementos da árvore (em ordem), sem entrar em componentes: o que `FollowUpDecide` devolve é só HTML. */
function all(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => all(n, out));
  else if (isEl(node)) {
    out.push(node);
    all(node.props.children, out);
  }
  return out;
}
const textOf = (node: unknown): string => (Array.isArray(node) ? node.map(textOf).join('') : isEl(node) ? textOf(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '');
const tag = (tree: unknown, type: string) => all(tree).filter((e) => e.type === type);

/** Roda o componente com `useState`, `useRef` e `useMemo` de verdade (o que ele usa); `useEffect` não roda (foco e rolagem são do navegador). */
function mount<P extends object>(Comp: (p: P) => unknown, props: P) {
  const slots: any[] = [];
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const view = () => {
    let i = 0;
    const dispatcher = {
      useState: (init: unknown) => {
        const k = i++;
        if (!(k in slots)) slots[k] = typeof init === 'function' ? (init as () => unknown)() : init;
        return [slots[k], (v: unknown) => void (slots[k] = typeof v === 'function' ? (v as (p: unknown) => unknown)(slots[k]) : v)];
      },
      useRef: (init: unknown) => (slots[i] ??= { current: init }, slots[i++]),
      useMemo: (fn: () => unknown, deps: unknown[]) => {
        const k = i++;
        const prev = slots[k] as { v: unknown; deps: unknown[] } | undefined;
        if (prev && prev.deps.length === deps.length && prev.deps.every((d, j) => Object.is(d, deps[j]))) return prev.v;
        slots[k] = { v: fn(), deps };
        return slots[k].v;
      },
      useEffect: () => void i++,
    };
    const before = internals.current;
    internals.current = dispatcher;
    try {
      return Comp(props);
    } finally {
      internals.current = before;
    }
  };
  return view;
}

const CARD_URL = '/api/projects/p-1/tasks/t-aaaaaa/followup/f-a1b2c3/card';
const open = () => {
  const onDone = vi.fn();
  const onDecided = vi.fn();
  const view = mount(FollowUpDecide, {
    projectId: 'p-1',
    taskId: 't-aaaaaa',
    followUp: { id: 'f-a1b2c3', title: 'Juntar o helper', text: 'achado inteiro', staffId: 'beto' },
    task: { status: 'doing', staffId: 'beto' },
    team: [{ id: 'beto', name: 'Beto' }],
    onDone,
    onDecided,
  });
  return { view, onDone, onDecided };
};
const buttons = (tree: unknown) => tag(tree, 'button').map((b) => ({ label: textOf(b).trim(), type: b.props.type as string, disabled: !!b.props.disabled, props: b.props }));
/** Toca no botão primário do estado fechado (o último da linha). */
const openDraft = (view: () => unknown) => buttons(view()).find((b) => b.label === 'Revisar e criar card')!.props.onClick();
const labels = (tree: unknown) => buttons(tree).map((b) => b.label);
const stubFetch = (answer: () => Promise<Response>) => {
  const fetch = vi.fn(answer);
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  return fetch;
};
const created = () => Promise.resolve(new Response(JSON.stringify({ task: { id: 't-bbbbbb', title: 'Juntar o helper' } }), { status: 200 }));
const submitEvent = () => ({ preventDefault: vi.fn() });

describe('criar card, clique a clique', () => {
  it('fechado: "Descartar" e, por último, a primária "Revisar e criar card"; clicar no primeiro abre o rascunho e NÃO envia nada', () => {
    const fetch = stubFetch(created);
    const { view } = open();
    expect(labels(view())).toEqual(['Descartar', 'Revisar e criar card']);
    expect(tag(view(), 'form')).toHaveLength(0);
    openDraft(view);
    expect(fetch).not.toHaveBeenCalled();
    expect(tag(view(), 'form')).toHaveLength(1);
  });

  it('expandir não duplica: aberto, há um só "Criar card", é o submit do formulário e nenhum botão do estado fechado sobra', () => {
    const { view } = open();
    openDraft(view);
    const tree = view();
    expect(labels(tree)).toEqual(['Voltar', 'Criar card']);
    expect(labels(tree).filter((l) => l === 'Criar card')).toHaveLength(1);
    const form = tag(tree, 'form')[0]!;
    const submit = buttons(form).find((b) => b.label === 'Criar card')!;
    expect(submit.type).toBe('submit');
    expect(submit.disabled).toBe(false);
    expect(typeof form.props.onSubmit).toBe('function');
    // Nenhum botão sem efeito: todos habilitados e todos com ação (o submit age pelo formulário; "Voltar" tem onClick).
    expect(buttons(tree).every((b) => !b.disabled)).toBe(true);
    expect(typeof buttons(tree)[0]!.props.onClick).toBe('function');
  });

  it('"Voltar" fecha o rascunho e traz de volta os botões do estado fechado, sem enviar', () => {
    const fetch = stubFetch(created);
    const { view } = open();
    openDraft(view);
    buttons(view()).find((b) => b.label === 'Voltar')!.props.onClick();
    expect(labels(view())).toEqual(['Descartar', 'Revisar e criar card']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('o botão visível cria o card: enviar o formulário faz POST na rota do card com o responsável, relê a lista e diz qual card nasceu', async () => {
    const fetch = stubFetch(created);
    const { view, onDone, onDecided } = open();
    openDraft(view);
    const event = submitEvent();
    tag(view(), 'form')[0]!.props.onSubmit(event);
    expect(event.preventDefault).toHaveBeenCalled();
    // O envio roda em segundo plano (o onSubmit do formulário não devolve a promessa): espera a releitura e o aviso.
    await vi.waitFor(() => expect(onDecided).toHaveBeenLastCalledWith(expect.stringContaining('t-bbbbbb')));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CARD_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ staffId: 'beto' });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDecided).toHaveBeenLastCalledWith(expect.stringContaining('t-bbbbbb'));
  });

  it('enquanto envia: o submit fica desligado ("enviando…") e um segundo envio não chama o servidor (sem card duplicado)', async () => {
    let finish: (r: Response) => void = () => {};
    const fetch = stubFetch(() => new Promise<Response>((resolve) => (finish = resolve)));
    const { view } = open();
    openDraft(view);
    const form = tag(view(), 'form')[0]!;
    form.props.onSubmit(submitEvent());
    // O segundo envio chega antes de o primeiro voltar (Enter repetido): não pode virar outra chamada.
    form.props.onSubmit(submitEvent());
    const sending = buttons(view());
    expect(sending.map((b) => [b.label, b.disabled])).toEqual([
      ['Voltar', true],
      ['enviando…', true],
    ]);
    finish(await created());
    // Terminou: destravado (um envio novo, por exemplo depois de um erro, volta a funcionar).
    await vi.waitFor(() => expect(buttons(view()).every((b) => !b.disabled)).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
