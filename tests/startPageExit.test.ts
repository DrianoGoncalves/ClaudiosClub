import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// A página de início (scripts/start.html) roda de verdade aqui, num contexto do `vm` com um DOM de mentira: o aviso "Por que parou" nasce na subida que traz o Claudio’s Club de volta
// (o vigia só descobre que a saída anterior não foi limpa ao subir), então é na hora em que o servidor passa a responder que ele tem de aparecer: a página fica com o motivo e um botão
// para abrir o app, em vez de entrar direto nele. Sem node:DOM no vitest, o que se prova é o fluxo do script da página.

const APP = 'http://claudio.localhost:4848';

interface FakeEl {
  [k: string]: unknown;
  hidden: boolean;
  textContent: string;
  listeners: Record<string, () => unknown>;
}

function fakeEl(): FakeEl {
  const store: Record<string, unknown> = { hidden: false, textContent: '', disabled: false, open: false, className: '', onclick: null, listeners: {}, classList: { add() {}, remove() {}, toggle() {} }, style: {}, dataset: {} };
  return new Proxy(store, {
    get(t, k) {
      if (typeof k === 'symbol') return undefined;
      if (k in t) return t[k];
      if (k === 'addEventListener') return (type: string, fn: () => unknown) => void ((t.listeners as Record<string, () => unknown>)[type] = fn);
      return () => undefined;
    },
    set(t, k, v) {
      t[k as string] = v;
      return true;
    },
  }) as FakeEl;
}

type Exit = { cause: string; message: string; detectedAt: string; at?: string; lastBeat?: string } | null;

async function runStartPage(o: { up: boolean; exit?: Exit; seen?: string; viaFile?: boolean }) {
  const html = await fs.readFile(path.join(__dirname, '..', 'scripts', 'start.html'), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
  // O estado inicial vem do HTML: o que tem o atributo `hidden` começa escondido.
  const hiddenIds = new Set([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)].filter((m) => /\shidden(\s|>|\/)/.test(m[0])).map((m) => m[1]!));
  const els = new Map<string, FakeEl>();
  const el = (id: string) => {
    if (!els.has(id)) {
      const made = fakeEl();
      made.hidden = hiddenIds.has(id);
      els.set(id, made);
    }
    return els.get(id)!;
  };
  const state = { up: o.up };
  const files: Record<string, unknown> = {
    'status.js': { at: new Date().toISOString(), checks: [], defender: null, deps: null },
    'log.js': { at: new Date().toISOString(), entries: [], exit: o.exit ?? null },
  };
  const keys: Record<string, string> = { 'status.js': 'claudioStatus', 'log.js': 'claudioLog' };
  const storage = new Map<string, string>(o.seen ? [['claudioExitSeen', o.seen]] : []);
  const replaced: string[] = [];
  const hrefs: string[] = [];
  const sandbox: Record<string, unknown> = {
    console,
    Date,
    URLSearchParams,
    Promise,
    JSON,
    Math,
    isNaN,
    Array,
    Object,
    String,
    Number,
    encodeURIComponent,
    navigator: {},
    // A espera de 2 s entre as sondas do Iniciar vira 5 ms; o prazo de 2,5 s da sonda fica como está.
    setTimeout: (fn: () => void, ms = 0) => setTimeout(fn, ms === 2000 ? 5 : ms),
    clearTimeout,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) },
    location: {
      search: '',
      port: '4848',
      protocol: o.viaFile ? 'file:' : 'http:',
      replace: (url: string) => void replaced.push(url),
      set href(url: string) {
        hrefs.push(url);
      },
      get href() {
        return '';
      },
    },
    Image: class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        setTimeout(() => (state.up ? this.onload?.() : this.onerror?.()), 0);
      }
    },
    document: {
      getElementById: el,
      createElement: () => fakeEl(),
      head: {
        appendChild: (node: { src?: string; onload?: () => void; onerror?: () => void }) => {
          const name = String(node.src).split('?')[0]!;
          setTimeout(() => {
            if (!(name in files)) return node.onerror?.();
            sandbox[keys[name]!] = files[name];
            node.onload?.();
          }, 0);
        },
      },
      execCommand: () => true,
      body: fakeEl(),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  return { el, state, replaced, hrefs, storage, settle };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const exit = (detectedAt = minutesAgo(0.1)): Exit => ({
  cause: 'oom',
  message: 'a saída anterior não foi limpa: encerrado pelo sistema por falta de memória (systemd-oomd) às 09:25',
  detectedAt,
});

describe('página de início: o motivo da saída anterior aparece quando o Claudio’s Club volta', () => {
  it('abrindo com o Club no ar e uma saída não limpa recente: não redireciona; mostra o motivo e o botão Abrir; Abrir marca como visto e entra no app', async () => {
    const e = exit();
    const page = await runStartPage({ up: true, exit: e });
    await page.settle();
    expect(page.replaced).toEqual([]);
    expect(page.el('last-exit').hidden).toBe(false);
    expect(page.el('last-exit-text').textContent).toContain('A saída anterior não foi limpa: encerrado pelo sistema por falta de memória');
    expect(page.el('last-exit-hint').textContent).toContain('Feche programas pesados');
    expect(page.el('down-main').hidden).toBe(false);
    expect(page.el('start-controls').hidden).toBe(true);
    expect(page.el('open-app').hidden).toBe(false);
    expect(page.el('checking').hidden).toBe(true);
    // O botão leva ao app e o aviso não volta neste navegador.
    (page.el('open-app').onclick as () => void)();
    expect(page.replaced).toEqual([APP]);
    expect(page.storage.get('claudioExitSeen')).toBe(e!.detectedAt);
  });

  it('sem aviso, aviso já visto, ou aviso com mais de 30 min (cópia velha do log guardada pelo service worker): entra direto no app', async () => {
    const e = exit();
    const none = await runStartPage({ up: true, exit: null });
    await none.settle();
    expect(none.replaced).toEqual([APP]);
    const seen = await runStartPage({ up: true, exit: e, seen: e!.detectedAt });
    await seen.settle();
    expect(seen.replaced).toEqual([APP]);
    const old = await runStartPage({ up: true, exit: exit(minutesAgo(31)) });
    await old.settle();
    expect(old.replaced).toEqual([APP]);
  });

  it('parado de propósito: a página parada não mostra aviso velho (visto, antigo ou sem aviso)', async () => {
    const e = exit();
    for (const o of [{ exit: null }, { exit: e, seen: e!.detectedAt }, { exit: exit(minutesAgo(45)) }]) {
      const page = await runStartPage({ up: false, ...o });
      await page.settle();
      expect(page.el('down-main').hidden).toBe(false);
      expect(page.el('last-exit').hidden).toBe(true);
    }
  });

  it('parado, com o aviso recente e não visto (o vigia já anotou, o servidor ainda sobe): a página mostra o motivo junto do Iniciar', async () => {
    const page = await runStartPage({ up: false, exit: exit() });
    await page.settle();
    expect(page.el('last-exit').hidden).toBe(false);
    expect(page.el('start-controls').hidden).toBe(false);
    expect(page.el('open-app').hidden).toBe(true);
  });
});

describe('página de início: o clique em Iniciar', () => {
  it('o servidor responde depois do clique e há saída não limpa: a página NÃO redireciona; mostra o quadro e o botão para abrir o app', async () => {
    const e = exit();
    const page = await runStartPage({ up: false, exit: e });
    await page.settle();
    expect(page.replaced).toEqual([]);
    const click = page.el('start').listeners.click as () => Promise<void>;
    const running = click();
    await page.settle(30);
    expect(page.hrefs).toEqual(['myco://start']);
    page.state.up = true; // o Club subiu
    await running;
    expect(page.replaced).toEqual([]);
    expect(page.el('last-exit').hidden).toBe(false);
    expect(page.el('down-title').textContent).toBe('O Claudio’s Club está no ar de novo.');
    expect(page.el('open-app').hidden).toBe(false);
    expect(page.el('start-controls').hidden).toBe(true);
    (page.el('open-app').onclick as () => void)();
    expect(page.replaced).toEqual([APP]);
  });

  it('o servidor responde depois do clique e a saída anterior foi limpa: entra direto no app, como sempre', async () => {
    const page = await runStartPage({ up: false, exit: null });
    await page.settle();
    const running = (page.el('start').listeners.click as () => Promise<void>)();
    await page.settle(30);
    page.state.up = true;
    await running;
    expect(page.replaced).toEqual([APP]);
    expect(page.el('open-app').hidden).toBe(true);
  });

  it('aberta como arquivo, o Iniciar abre o app pareado noutra aba (myco://open): a página mostra o motivo, sem botão para abrir de novo', async () => {
    const page = await runStartPage({ up: false, exit: exit(), viaFile: true });
    await page.settle();
    const running = (page.el('start').listeners.click as () => Promise<void>)();
    await page.settle(30);
    expect(page.hrefs).toEqual(['myco://open']);
    page.state.up = true;
    await running;
    expect(page.replaced).toEqual([]);
    expect(page.el('last-exit').hidden).toBe(false);
    expect(page.el('down-title').textContent).toContain('abriu numa aba nova');
    expect(page.el('open-app').hidden).toBe(true);
  });
});
