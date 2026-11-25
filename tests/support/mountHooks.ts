import * as React from 'react';

// Despachante de hooks mínimo (o projeto não tem jsdom nem renderizador de teste): roda um componente de função com `useState`, `useRef`, `useMemo` e `useCallback` de verdade, devolve a árvore
// de elementos que ele produz (sem entrar nos componentes filhos) e guarda os efeitos para o teste rodar quando quiser (`runEffects`). Mesma ideia de `tests/followUpDecideFlow.test.ts`.

export type El = { type: unknown; props: Record<string, any> };
export const isEl = (n: unknown): n is El => !!n && typeof n === 'object' && 'props' in (n as object) && 'type' in (n as object);

/** Todos os elementos da árvore, em ordem. */
export function all(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => all(n, out));
  else if (isEl(node)) {
    out.push(node);
    all(node.props.children, out);
  }
  return out;
}
export const textOf = (node: unknown): string => (Array.isArray(node) ? node.map(textOf).join('') : isEl(node) ? textOf(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '');
export const tag = (tree: unknown, type: string) => all(tree).filter((e) => e.type === type);
/** Os botões da árvore, com o rótulo (texto), a classe e o estado. */
export const buttons = (tree: unknown) => tag(tree, 'button').map((b) => ({ label: textOf(b).trim(), className: String(b.props.className ?? ''), disabled: !!b.props.disabled, props: b.props }));

/** Deixa as promessas pendentes (fetch falso, setState depois do await) terminarem. */
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

export function mountHooks<P extends object>(Comp: (p: P) => unknown, props: P) {
  const slots: any[] = [];
  let effects: Array<() => unknown> = [];
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const view = () => {
    let i = 0;
    effects = [];
    const dispatcher = {
      useState: (init: unknown) => {
        const k = i++;
        if (!(k in slots)) slots[k] = typeof init === 'function' ? (init as () => unknown)() : init;
        return [slots[k], (v: unknown) => void (slots[k] = typeof v === 'function' ? (v as (p: unknown) => unknown)(slots[k]) : v)];
      },
      useRef: (init: unknown) => (slots[i] ??= { current: init }, slots[i++]),
      useMemo: (fn: () => unknown) => (i++, fn()),
      useCallback: (fn: unknown) => (i++, fn),
      useId: () => `:id${i++}:`,
      useEffect: (fn: () => unknown) => {
        i++;
        effects.push(fn);
      },
    };
    const before = internals.current;
    internals.current = dispatcher;
    try {
      return Comp(props);
    } finally {
      internals.current = before;
    }
  };
  /** Roda os efeitos da última renderização (o que o navegador faz depois de pintar) e espera as promessas que eles soltaram. */
  const runEffects = async () => {
    view();
    for (const fn of effects) fn();
    await flush();
  };
  return { view, runEffects };
}
