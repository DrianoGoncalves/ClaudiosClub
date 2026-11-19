import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type PickFolderResult } from '../client/src/api';
import { FolderField, type FolderPick } from '../client/src/office/FolderField';
import { createFolderPicker, isLocalPage, PICK_IDLE, viewForError, type PickView } from '../client/src/office/folderPick';

// "Novo projeto → Procurar…": o que a tela faz com cada resposta da janela de escolher pasta (contrato do servidor em server/folderPicker.ts).

const err = (status: number | null, code: string | null = null) => new ApiError('texto pt do servidor', code, null, {}, status);

/** Um servidor falso: cada chamada fica pendente até o teste responder. */
function harness() {
  const calls: Array<{ resolve: (r: PickFolderResult) => void; reject: (e: unknown) => void }> = [];
  const paths: string[] = [];
  const views: PickView[] = [];
  const picker = createFolderPicker({
    call: () => new Promise<PickFolderResult>((resolve, reject) => calls.push({ resolve, reject })),
    onPath: (p) => paths.push(p),
    onView: (v) => views.push(v),
  });
  const last = (): PickView => {
    const v = views[views.length - 1];
    if (!v) throw new Error('nenhum estado emitido');
    return v;
  };
  const at = (i: number) => {
    const c = calls[i];
    if (!c) throw new Error('pedido ' + i + ' não feito');
    return c;
  };
  return { calls, paths, views, picker, last, at };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('isLocalPage: só abre a janela no computador de quem olha', () => {
  it.each(['localhost', 'LOCALHOST', 'claudio.localhost', '127.0.0.1', '127.0.0.2', '[::1]', '::1'])('%s é local', (h) => {
    expect(isLocalPage(h)).toBe(true);
  });
  it.each(['192.168.0.10', 'meu-servidor.com', 'localhost.evil.com', '127.0.0.1.evil.com', '10.0.0.1', ''])('%s não é local', (h) => {
    expect(isLocalPage(h)).toBe(false);
  });
});

describe('viewForError: a frase sai do status, nunca do texto do servidor', () => {
  it('409 busy: avisa e mantém o botão', () => {
    expect(viewForError(err(409, 'busy'))).toEqual({ busy: false, unsupported: false, note: 'busy' });
  });
  it('409 sem o código busy não é "janela aberta"', () => {
    expect(viewForError(err(409)).note).toBe('failed');
  });
  it.each([400, 403, 404])('%i: servidor que não aceita/não tem a rota = não abre a janela (botão desligado)', (status) => {
    expect(viewForError(err(status))).toEqual({ busy: false, unsupported: true, note: 'unsupported' });
  });
  it.each([500, 502, null])('%s: falha passageira, botão segue ligado', (status) => {
    expect(viewForError(err(status))).toEqual({ busy: false, unsupported: false, note: 'failed' });
  });
  it('pareamento recusado: sem aviso próprio (o do App explica)', () => {
    expect(viewForError(err(403, 'needs-pairing'))).toEqual(PICK_IDLE);
  });
  it('erro que não é do servidor (TypeError etc.): falha passageira', () => {
    expect(viewForError(new TypeError('x')).note).toBe('failed');
  });
});

describe('createFolderPicker', () => {
  it('escolheu: preenche o campo e volta ao repouso; enquanto espera, fica ocupado', async () => {
    const h = harness();
    const done = h.picker.pick();
    expect(h.last()).toEqual({ busy: true, unsupported: false, note: 'open' });
    h.at(0).resolve({ path: 'C:\\Users\\voce\\projetos\\loja' });
    await done;
    expect(h.paths).toEqual(['C:\\Users\\voce\\projetos\\loja']);
    expect(h.last()).toEqual(PICK_IDLE);
  });

  it('cancelou: não mexe no campo e volta ao repouso', async () => {
    const h = harness();
    const done = h.picker.pick();
    h.at(0).resolve({ cancelled: true });
    await done;
    expect(h.paths).toEqual([]);
    expect(h.last()).toEqual(PICK_IDLE);
  });

  it('unsupported: desliga o botão e não pede de novo', async () => {
    const h = harness();
    const done = h.picker.pick();
    h.at(0).resolve({ unsupported: true });
    await done;
    expect(h.paths).toEqual([]);
    expect(h.last()).toEqual({ busy: false, unsupported: true, note: 'unsupported' });
    await h.picker.pick();
    expect(h.calls).toHaveLength(1);
  });

  it('dois cliques seguidos = um pedido (trava síncrona, antes de o React redesenhar)', async () => {
    const h = harness();
    const first = h.picker.pick();
    const second = h.picker.pick();
    expect(h.calls).toHaveLength(1);
    h.at(0).resolve({ cancelled: true });
    await Promise.all([first, second]);
    // Fechada a janela, vale pedir de novo.
    const again = h.picker.pick();
    expect(h.calls).toHaveLength(2);
    h.at(1).resolve({ path: '/home/a/loja' });
    await again;
    expect(h.paths).toEqual(['/home/a/loja']);
  });

  it('409 busy: avisa, não preenche, e dá para tentar de novo', async () => {
    const h = harness();
    const done = h.picker.pick();
    h.at(0).reject(err(409, 'busy'));
    await done;
    expect(h.last()).toEqual({ busy: false, unsupported: false, note: 'busy' });
    void h.picker.pick();
    expect(h.calls).toHaveLength(2);
  });

  it('erro de rede/500: aviso de falha, campo intacto, botão segue ligado', async () => {
    const h = harness();
    const done = h.picker.pick();
    h.at(0).reject(err(null, 'offline'));
    await done;
    expect(h.paths).toEqual([]);
    expect(h.last()).toEqual({ busy: false, unsupported: false, note: 'failed' });
    void h.picker.pick();
    expect(h.calls).toHaveLength(2);
  });

  it('404 (servidor sem a rota): desliga o botão como unsupported', async () => {
    const h = harness();
    const done = h.picker.pick();
    h.at(0).reject(err(404));
    await done;
    expect(h.last().unsupported).toBe(true);
    await h.picker.pick();
    expect(h.calls).toHaveLength(1);
  });

  it('resposta fora do contrato (sem caminho, caminho vazio): falha, não preenche', async () => {
    for (const bad of [{}, { path: '' }, { path: 42 }] as unknown as PickFolderResult[]) {
      const h = harness();
      const done = h.picker.pick();
      h.at(0).resolve(bad);
      await done;
      expect(h.paths).toEqual([]);
      expect(h.last().note).toBe('failed');
    }
  });

  it('a tela saiu (dispose): a resposta que chega depois não preenche nem mexe no estado', async () => {
    const h = harness();
    const done = h.picker.pick();
    const before = h.views.length;
    h.picker.dispose();
    h.at(0).resolve({ path: 'C:\\x' });
    await done;
    await settle();
    expect(h.paths).toEqual([]);
    expect(h.views).toHaveLength(before);
  });
});

describe('FolderField (tela)', () => {
  const noop = () => {};
  const render = (view: PickView, canPick = true, value = '') => {
    const pick: FolderPick = { view, run: noop };
    return renderToStaticMarkup(createElement(FolderField, { value, onChange: noop, pick, canPick }));
  };
  const button = (html: string) => /<button[^>]*>[^<]*<\/button>/.exec(html)?.[0] ?? '';

  it('em repouso: campo editável com o caminho digitado e botão "Procurar…" ao lado, ligado, sem aviso', () => {
    const html = render(PICK_IDLE, true, 'C:\\a\\b');
    expect(html).toContain('value="C:\\a\\b"');
    expect(html).not.toMatch(/<input[^>]*(readonly|disabled)/i);
    expect(html).toContain('maxLength="400"');
    expect(button(html)).toContain('Procurar…');
    expect(button(html)).not.toContain('disabled');
    expect(button(html)).toContain('type="button"');
    expect(html).not.toContain('role="status"');
    // O botão fica DENTRO da mesma linha do campo (ao lado), não depois do rótulo.
    expect(html).toMatch(/<div class="path-row"><input[^>]*\/><button/);
  });

  it('rótulo ligado ao campo por for/id (o botão não entra no nome do campo)', () => {
    const html = render(PICK_IDLE);
    const id = /<label for="([^"]+)">Caminho da pasta<\/label>/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<input id="${id}"`);
  });

  it('janela aberta: botão ocupado e desligado, dica de que abriu no computador, campo segue editável', () => {
    const html = render({ busy: true, unsupported: false, note: 'open' });
    expect(button(html)).toContain('disabled');
    expect(button(html)).toContain('aria-busy="true"');
    expect(button(html)).toContain('Janela aberta…');
    expect(html).toContain('A janela abriu no seu computador');
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/<input[^>]*(readonly|disabled)/i);
  });

  it('unsupported: botão desligado + dica de digitar o caminho; campo editável', () => {
    const html = render({ busy: false, unsupported: true, note: 'unsupported' });
    expect(button(html)).toContain('disabled');
    expect(button(html)).not.toContain('aria-busy');
    expect(html).toContain('Digite o caminho no campo');
    expect(html).not.toMatch(/<input[^>]*(readonly|disabled)/i);
  });

  it('falha passageira: aviso em vermelho e botão ligado; busy 409: aviso neutro', () => {
    const failed = render({ busy: false, unsupported: false, note: 'failed' });
    expect(failed).toMatch(/<p[^>]*class="error"[^>]*>Não deu para abrir a janela/);
    expect(button(failed)).not.toContain('disabled');
    const busy = render({ busy: false, unsupported: false, note: 'busy' });
    expect(busy).toContain('Já há uma janela de escolher pasta aberta');
    expect(busy).not.toContain('class="error"');
  });

  it('o aviso liga ao campo por aria-describedby', () => {
    const html = render({ busy: false, unsupported: true, note: 'unsupported' });
    const ref = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(ref).toBeTruthy();
    expect(html).toContain(`<p id="${ref}"`);
    expect(render(PICK_IDLE)).not.toContain('aria-describedby');
  });

  it('página por outro endereço (canPick falso): só o campo, sem botão nem aviso', () => {
    const html = render({ busy: false, unsupported: true, note: 'unsupported' }, false);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('role="status"');
    expect(html).toContain('<input');
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
    return import('../client/src/office/FolderField');
  };
  const view = (note: PickView['note'], busy = false, unsupported = false): PickView => ({ busy, unsupported, note });
  const html = (mod: typeof import('../client/src/office/FolderField'), v: PickView) =>
    renderToStaticMarkup(createElement(mod.FolderField, { value: '', onChange: () => {}, pick: { view: v, run: () => {} }, canPick: true }));

  it.each([
    ['en', 'Browse…', 'Window open…', 'The window opened on your computer', 'Type the path in the field'],
    ['es', 'Buscar…', 'Ventana abierta…', 'La ventana se abrió en tu computadora', 'Escribe la ruta en el campo'],
  ])('%s: botão, ocupado, dica e unsupported traduzidos', async (locale, browse, working, opened, typeIt) => {
    const mod = await inLocale(locale);
    expect(html(mod, view(null))).toContain(`>${browse}</button>`);
    const busy = html(mod, view('open', true));
    expect(busy).toContain(`>${working}</button>`);
    expect(busy).toContain(opened);
    expect(html(mod, view('unsupported', false, true))).toContain(typeIt);
    // Nenhum texto em português sobra.
    for (const v of [view(null), view('open', true), view('unsupported', false, true), view('busy'), view('failed')]) {
      expect(html(mod, v), JSON.stringify(v)).not.toMatch(/\b(Procurar|Janela|janela|caminho|pasta|computador)\b/);
    }
  });
});
