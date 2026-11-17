import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_DIR, EXTENSION_KEY, EXTENSION_ID } from '../server/extension/identity';
import { buildExtensionZip, checkManifest } from '../server/extension/zip';
import { badgeText, clubLink, KIND_MESSAGE, MAX_SINGLE, MAX_TARGETS, planNotifications, whoOf, withTarget } from '../extension/lib/inbox.js';
import { buildTaskBody, DESCRIPTION_MAX, isWebUrl, pageSource, safeUrl, SELECTION_MAX, SOURCE_TITLE_MAX, TITLE_MAX, URL_MAX } from '../extension/lib/task.js';

// A extensão do Chrome (extension/): o pacote, os textos nos 3 idiomas, as regras puras e o service worker (com o `chrome` e o `fetch` falsos).

const read = (...parts: string[]) => fs.readFileSync(path.join(EXTENSION_DIR, ...parts), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

describe('pacote da extensão', () => {
  it('o manifest passa na conferência do servidor (chave fixa, permissões e host do combinado)', () => {
    expect(checkManifest(manifest, 4848)).toBeNull();
    expect(manifest.key).toBe(EXTENSION_KEY);
    expect(manifest.manifest_version).toBe(3);
  });

  it('permissões no mínimo: sem host além do Club e sem script em página', () => {
    expect(manifest.permissions.sort()).toEqual(['activeTab', 'alarms', 'notifications', 'scripting', 'storage']);
    expect(manifest.host_permissions).toEqual(['http://127.0.0.1:4848/*']);
    for (const banned of ['content_scripts', 'externally_connectable', 'web_accessible_resources', 'optional_permissions', 'optional_host_permissions']) {
      expect(manifest[banned], banned).toBeUndefined();
    }
  });

  it('todo arquivo que o manifest cita existe', () => {
    const files = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      ...Object.values<string>(manifest.icons),
      ...Object.values<string>(manifest.action.default_icon),
    ];
    for (const f of files) expect(fs.existsSync(path.join(EXTENSION_DIR, f)), f).toBe(true);
  });

  it('vira o .zip do config sem recusa, com o manifest e o service worker dentro', async () => {
    const zip = await buildExtensionZip(EXTENSION_DIR, 4848);
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    const text = zip.toString('latin1');
    for (const name of ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'popup.css', 'lib/api.js', '_locales/pt_BR/messages.json']) {
      expect(text, name).toContain(name);
    }
    expect(zip.length).toBeLessThan(1024 * 1024);
  });

  it('não fala com nada além do Club: nenhuma URL externa nos arquivos de código', () => {
    const code = ['background.js', 'popup.js', 'popup.html', 'popup.css', ...fs.readdirSync(path.join(EXTENSION_DIR, 'lib')).map((f) => `lib/${f}`)].map((f) => read(f)).join('\n');
    const urls = [...code.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
    for (const url of urls) expect(url, url).toMatch(/^http:\/\/(127\.0\.0\.1|claudio\.localhost):4848/);
    expect(code).not.toMatch(/\beval\s*\(|new Function\(|innerHTML|insertAdjacentHTML|document\.write/);
  });

  it('o ID da extensão é o do servidor (a chave fixa)', () => {
    expect(EXTENSION_ID).toBe('eadddhkfbbohinnnpnakbabjlmbijjgc');
  });
});

describe('textos da extensão (_locales)', () => {
  const locales = ['pt_BR', 'en', 'es'];
  const messages = Object.fromEntries(locales.map((l) => [l, JSON.parse(read('_locales', l, 'messages.json')) as Record<string, { message: string; placeholders?: object }>]));
  const keys = Object.keys(messages.pt_BR!);
  const sources = ['background.js', 'popup.js', 'popup.html', 'lib/inbox.js', 'lib/task.js'].map((f) => read(f)).join('\n') + read('manifest.json');

  it('os 3 idiomas têm as mesmas chaves e os mesmos marcadores de troca', () => {
    for (const l of ['en', 'es']) expect(Object.keys(messages[l]!).sort(), l).toEqual([...keys].sort());
    for (const key of keys) {
      const marks = (l: string) => (messages[l]![key]!.message.match(/\$[A-Z]+\$/g) ?? []).sort().join();
      expect(marks('en'), key).toBe(marks('pt_BR'));
      expect(marks('es'), key).toBe(marks('pt_BR'));
      expect(Object.keys(messages.pt_BR![key]!.placeholders ?? {}).length, key).toBe((messages.pt_BR![key]!.message.match(/\$[A-Z]+\$/g) ?? []).length);
    }
    for (const l of locales) for (const key of keys) expect(messages[l]![key]!.message.trim(), `${l}.${key}`).not.toBe('');
  });

  it('toda chave que o código pede existe, e nenhuma chave ficou sem uso', () => {
    const asked = new Set<string>();
    for (const m of sources.matchAll(/\bmsg\(\s*'([A-Za-z]+)'/g)) asked.add(m[1]!);
    for (const m of sources.matchAll(/data-i18n="([A-Za-z]+)"/g)) asked.add(m[1]!);
    for (const m of sources.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1]!.split(';')) asked.add(pair.split(':')[1]!.trim());
    for (const m of sources.matchAll(/__MSG_([A-Za-z]+)__/g)) asked.add(m[1]!);
    for (const m of sources.matchAll(/'((?:kind|status|err|conn)[A-Z][A-Za-z]*)'/g)) asked.add(m[1]!);
    for (const key of asked) expect(keys, key).toContain(key);
    for (const key of keys) expect(sources, `chave sem uso: ${key}`).toMatch(new RegExp(`[^A-Za-z]${key}[^A-Za-z]`));
  });

  it('cada tipo de aviso da caixa tem o texto "Fulano …" (os mesmos tipos da aba do Club)', () => {
    const model = fs.readFileSync(path.join(__dirname, '..', 'shared', 'model.ts'), 'utf8');
    const kinds = /export type InboxKind = ([^;]+);/.exec(model)![1]!.match(/'(\w+)'/g)!.map((k) => k.slice(1, -1));
    expect(Object.keys(KIND_MESSAGE).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) expect(keys).toContain(KIND_MESSAGE[kind as keyof typeof KIND_MESSAGE]);
  });
});

describe('avisos: regras puras', () => {
  const item = (id: string) => ({ id, kind: 'waiting', projectId: 'p-1', projectName: 'Projeto', staffId: 'ana', name: 'Ana', summary: 'oi', at: null });

  it('a primeira leitura só semeia: nada avisa, tudo vira visto', () => {
    expect(planNotifications([item('a'), item('b')], [], false)).toEqual({ fresh: [], seen: ['a', 'b'] });
  });

  it('depois, só o id que não estava antes é novo; quem sumiu e voltou avisa de novo', () => {
    expect(planNotifications([item('a'), item('b')], ['a'], true).fresh.map((i) => i.id)).toEqual(['b']);
    expect(planNotifications([item('a')], ['a'], true).fresh).toEqual([]);
    const gone = planNotifications([item('b')], ['a'], true);
    expect(gone.seen).toEqual(['b']);
    expect(planNotifications([item('a')], gone.seen, true).fresh.map((i) => i.id)).toEqual(['a']);
  });

  it('selo: vazio sem aviso, número, 99+', () => {
    expect([0, 1, 7, 99, 100, 250].map(badgeText)).toEqual(['', '1', '7', '99', '99+', '99+']);
    expect(badgeText(-2)).toBe('');
  });

  it('quem é o aviso: o funcionário, ou o projeto quando não há ficha', () => {
    expect(whoOf(item('a'))).toBe('Ana');
    expect(whoOf({ ...item('a'), name: '' })).toBe('Projeto');
  });

  it('o link do clique leva só ids simples', () => {
    expect(clubLink({ kind: 'plan', projectId: 'p-1', staffId: 'ana' })).toBe('http://claudio.localhost:4848/#abrir?kind=plan&projeto=p-1&funcionario=ana');
    expect(clubLink({ kind: 'plan', projectId: '../x', staffId: 'a b' })).toBe('http://claudio.localhost:4848/#abrir?kind=plan');
    expect(clubLink({})).toBe('http://claudio.localhost:4848/#abrir?');
    expect(clubLink({ view: 'tasks', projectId: 'p-1' })).toContain('tela=tarefas&projeto=p-1');
  });

  it('aviso de tarefa (esquecida ou esperando outra) abre o quadro de tarefas do projeto', () => {
    for (const kind of ['notStarted', 'blocked']) {
      expect(clubLink({ kind, projectId: 'p-1', staffId: null })).toBe(`http://claudio.localhost:4848/#abrir?kind=${kind}&tela=tarefas&projeto=p-1`);
    }
  });

  it('os destinos das notificações são limitados às mais recentes', () => {
    let targets: Record<string, unknown> = {};
    for (let i = 0; i < MAX_TARGETS + 10; i++) targets = withTarget(targets, `club:${i}`, { kind: 'waiting', projectId: 'p', staffId: null });
    expect(Object.keys(targets)).toHaveLength(MAX_TARGETS);
    expect(targets['club:0']).toBeUndefined();
    expect(targets[`club:${MAX_TARGETS + 9}`]).toBeDefined();
  });
});

describe('tarefa rápida: o corpo do pedido', () => {
  const form = { projectId: 'p-1', staffId: 'ana', title: '  Corrigir o botão ', description: ' detalhe ', start: false, source: null };

  it('apara o texto e manda `start` falso por padrão (cai em Aguardar)', () => {
    const built = buildTaskBody(form);
    expect(built).toEqual({ ok: true, body: { projectId: 'p-1', staffId: 'ana', title: 'Corrigir o botão', description: 'detalhe', start: false } });
  });

  it('iniciar já só vale com `true` de verdade', () => {
    expect(buildTaskBody({ ...form, start: true })).toMatchObject({ ok: true, body: { start: true } });
    expect(buildTaskBody({ ...form, start: 'sim' as unknown as boolean })).toMatchObject({ ok: true, body: { start: false } });
  });

  it('recusa o que o servidor recusaria, com a chave do texto', () => {
    expect(buildTaskBody({ ...form, projectId: '' })).toEqual({ ok: false, error: 'errNoProject' });
    expect(buildTaskBody({ ...form, staffId: '' })).toEqual({ ok: false, error: 'errNoStaff' });
    expect(buildTaskBody({ ...form, title: '   ' })).toEqual({ ok: false, error: 'errNoTitle' });
    expect(buildTaskBody({ ...form, title: 'x'.repeat(TITLE_MAX + 1) })).toEqual({ ok: false, error: 'errTitleLong' });
    expect(buildTaskBody({ ...form, description: 'x'.repeat(DESCRIPTION_MAX + 1) })).toEqual({ ok: false, error: 'errDescriptionLong' });
    expect(buildTaskBody({ ...form, title: 'x'.repeat(TITLE_MAX) }).ok).toBe(true);
  });

  it('a página só vai se a pessoa marcou; chrome:// e file:// nunca vão como URL', () => {
    const page = { url: 'https://exemplo.com/a?b=1', title: ' Título ', selection: ' trecho ' };
    expect(pageSource(page, { page: false, selection: false })).toBeNull();
    expect(pageSource(page, { page: true, selection: false })).toEqual({ url: 'https://exemplo.com/a?b=1', title: 'Título' });
    expect(pageSource(page, { page: false, selection: true })).toEqual({ selection: 'trecho' });
    expect(pageSource({ ...page, url: 'chrome://extensions' }, { page: true, selection: false })).toEqual({ title: 'Título' });
    expect(pageSource({ ...page, url: 'file:///C:/segredo.txt' }, { page: true, selection: false })?.url).toBeUndefined();
    expect(isWebUrl('http://localhost:3000')).toBe(true);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('não é url')).toBe(false);
  });

  it('a URL sai do navegador sem segredo: usuário, senha, fragmento e parâmetros sensíveis', () => {
    const page = { url: 'https://ana:senha@exemplo.com/a?id=42&access_token=abc&Code=9&utm=x#parte-privada', title: '', selection: '' };
    expect(pageSource(page, { page: true, selection: false })).toEqual({ url: 'https://exemplo.com/a?id=42&access_token=REDACTED&Code=REDACTED&utm=x' });
    expect(safeUrl('https://exemplo.com/a?b=1')).toBe('https://exemplo.com/a?b=1');
  });

  it('respeita os tetos do servidor: seleção, título e URL', () => {
    const page = { url: `https://exemplo.com/${'a'.repeat(URL_MAX)}`, title: 't'.repeat(500), selection: 's'.repeat(SELECTION_MAX + 500) };
    const source = pageSource(page, { page: true, selection: true })!;
    expect(source.url).toBeUndefined();
    expect(source.title).toHaveLength(SOURCE_TITLE_MAX);
    expect(source.selection).toHaveLength(SELECTION_MAX);
  });
});

// ---- o service worker, com o chrome e o fetch falsos ----

interface Fake {
  store: Record<string, any>;
  notified: Array<{ id: string; title: string; message: string }>;
  badge: { text: string; title: string; color: string };
  alarm: (alarm: { name: string }) => void;
  click: (id: string) => Promise<void> | void;
  message: (m: unknown) => void;
  tabs: Array<{ url: string }>;
  settled: () => Promise<void>;
}

function installChrome(store: Record<string, any> = {}): Fake {
  const fake = { store, notified: [], badge: { text: '', title: '', color: '' }, tabs: [] } as unknown as Fake;
  const handlers: Record<string, (...a: any[]) => any> = {};
  const listen = (name: string) => ({ addListener: (fn: (...a: any[]) => any) => (handlers[name] = fn) });
  const keysOf = (keys: string | string[]) => (typeof keys === 'string' ? [keys] : keys);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string | string[]) => Object.fromEntries(keysOf(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
        set: async (values: Record<string, unknown>) => void Object.assign(store, structuredClone(values)),
        remove: async (keys: string[]) => void keys.forEach((k) => delete store[k]),
      },
    },
    alarms: { get: async () => undefined, create: vi.fn(), onAlarm: listen('alarm') },
    runtime: { onInstalled: listen('installed'), onStartup: listen('startup'), onMessage: listen('message') },
    notifications: {
      create: async (id: string, o: { title: string; message: string }) => void fake.notified.push({ id, title: o.title, message: o.message }),
      clear: vi.fn(),
      onClicked: listen('click'),
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => void (fake.badge.text = text),
      setBadgeBackgroundColor: async ({ color }: { color: string }) => void (fake.badge.color = color),
      setTitle: async ({ title }: { title: string }) => void (fake.badge.title = title),
    },
    tabs: { create: async (o: { url: string }) => void fake.tabs.push(o) },
    i18n: { getMessage: (key: string, subs?: string | string[]) => (subs === undefined ? key : `${key}[${[subs].flat().join(',')}]`) },
  });
  fake.alarm = (alarm) => handlers.alarm!(alarm);
  fake.click = (id) => handlers.click!(id);
  fake.message = (m) => handlers.message!(m);
  // O selo é a última coisa que uma leitura grava: esperar por ele é esperar a leitura acabar.
  fake.settled = async () => {
    fake.badge.title = '';
    fake.alarm({ name: 'club-inbox' });
    await vi.waitFor(() => expect(fake.badge.title).not.toBe(''));
  };
  return fake;
}

const wire = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'waiting',
  projectId: 'p-1',
  projectName: 'Projeto',
  staffId: 'ana',
  name: 'Ana',
  summary: 'quer saber se pode seguir',
  at: null,
  ...over,
});

function stubInbox(reply: () => Response | Promise<Response>) {
  const fetchFake = vi.fn(async (_url: string, _init?: RequestInit) => reply());
  vi.stubGlobal('fetch', fetchFake);
  return fetchFake;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('service worker: avisos do inbox', () => {
  let fake: Fake;
  const start = async (state: Record<string, unknown> = { token: 'tok'.padEnd(43, 'x') }) => {
    fake = installChrome({ ...state });
    vi.resetModules();
    await import('../extension/background.js');
  };

  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.unstubAllGlobals());

  it('sem pareamento não consulta o Club e deixa o selo vazio', async () => {
    const fetchFake = stubInbox(() => json({ items: [] }));
    await start({});
    await fake.settled();
    expect(fetchFake).not.toHaveBeenCalled();
    expect(fake.badge.text).toBe('');
    expect(fake.badge.title).toBe('titleUnpaired');
    expect(fake.store.status).toBe('unpaired');
  });

  it('a primeira leitura não avisa (só conta no selo); a seguinte avisa só o novo, uma vez', async () => {
    let items = [wire('a'), wire('b')];
    const fetchFake = stubInbox(() => json({ items }));
    await start();
    await fake.settled();
    expect(fake.notified).toEqual([]);
    expect(fake.badge.text).toBe('2');
    expect(fake.store.seeded).toBe(true);
    // O token vai em Bearer, para o endereço do Club.
    const [url, init] = fetchFake.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4848/api/ext/v1/inbox');
    expect((init!.headers as Record<string, string>).authorization).toMatch(/^Bearer tok/);

    items = [wire('a'), wire('b'), wire('c', { kind: 'plan', name: 'Bia', staffId: 'bia', summary: 'plano pronto' })];
    await fake.settled();
    expect(fake.notified).toEqual([{ id: 'club:c', title: 'Bia kindPlan', message: 'plano pronto' }]);
    expect(fake.badge.text).toBe('3');

    await fake.settled(); // nada mudou: não repete
    expect(fake.notified).toHaveLength(1);
  });

  it('o clique abre o Club na tela do aviso e limpa a notificação', async () => {
    let items = [wire('a')];
    stubInbox(() => json({ items }));
    await start();
    await fake.settled();
    items = [wire('a'), wire('c', { kind: 'error', projectId: 'p-9', staffId: 'bia' })];
    await fake.settled();
    await fake.click('club:c');
    expect(fake.tabs).toEqual([{ url: 'http://claudio.localhost:4848/#abrir?kind=error&projeto=p-9&funcionario=bia' }]);
  });

  it('aviso sem funcionário usa o nome do projeto', async () => {
    let items: ReturnType<typeof wire>[] = [];
    stubInbox(() => json({ items }));
    await start();
    await fake.settled();
    items = [wire('x', { staffId: null, name: '', kind: 'usage' })];
    await fake.settled();
    expect(fake.notified[0]).toMatchObject({ title: 'Projeto kindUsage' });
  });

  it('muitos novos de uma vez viram uma notificação só', async () => {
    let items: ReturnType<typeof wire>[] = [];
    stubInbox(() => json({ items }));
    await start();
    await fake.settled();
    items = Array.from({ length: MAX_SINGLE + 2 }, (_, i) => wire(`n${i}`));
    await fake.settled();
    expect(fake.notified).toHaveLength(1);
    expect(fake.notified[0]).toMatchObject({ id: 'club-many', title: `notifMany[${MAX_SINGLE + 2}]` });
    expect(fake.badge.text).toBe(String(MAX_SINGLE + 2));
  });

  it('Club offline: selo "off", nada guardado para depois, e volta a funcionar quando o Club volta', async () => {
    let up = false;
    stubInbox(() => (up ? json({ items: [wire('a')] }) : Promise.reject(new TypeError('failed to fetch'))));
    await start();
    await fake.settled();
    expect(fake.badge.text).toBe('off');
    expect(fake.badge.title).toBe('titleOffline');
    expect(fake.store.seeded).toBeUndefined();
    expect(fake.notified).toEqual([]);
    up = true;
    await fake.settled();
    expect(fake.badge.text).toBe('1');
    expect(fake.notified).toEqual([]); // a primeira leitura com o Club de volta semeia, não avisa
  });

  it('outro programa na porta (resposta que não é JSON) conta como offline', async () => {
    stubInbox(() => new Response('<html>Club parado</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await start();
    await fake.settled();
    expect(fake.badge.text).toBe('off');
  });

  it('token revogado (401): esquece o pareamento, mostra "!" e segue assim nas leituras seguintes', async () => {
    stubInbox(() => json({ error: 'token da extensão inválido ou revogado' }, 401));
    await start({ token: 'tok'.padEnd(43, 'x'), pairingId: 'ext-1', seen: ['a'], seeded: true });
    await fake.settled();
    expect(fake.badge.text).toBe('!');
    expect(fake.badge.title).toBe('titleRevoked');
    expect(fake.store.token).toBeUndefined();
    expect(fake.store.seen).toBeUndefined();
    await fake.settled();
    expect(fake.badge.text).toBe('!');
  });

  it('o popup pede a leitura logo depois de parear', async () => {
    const fetchFake = stubInbox(() => json({ items: [wire('a')] }));
    await start();
    fake.badge.title = '';
    fake.message({ type: 'poll' });
    await vi.waitFor(() => expect(fake.badge.title).not.toBe(''));
    expect(fetchFake).toHaveBeenCalledTimes(1);
    fake.message({ type: 'outra-coisa' });
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it('notificação recusada pelo Chrome não derruba a leitura nem repete no minuto seguinte', async () => {
    let items = [wire('a')];
    stubInbox(() => json({ items }));
    await start();
    await fake.settled();
    (globalThis as any).chrome.notifications.create = async () => {
      throw new Error('desligadas');
    };
    items = [wire('a'), wire('b')];
    await fake.settled();
    expect(fake.badge.text).toBe('2');
    expect(fake.store.seen).toEqual(['a', 'b']);
  });
});
