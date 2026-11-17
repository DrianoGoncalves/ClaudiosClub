import { call, ClubError } from './lib/api.js';
import { CLUB } from './lib/config.js';
import { applyI18n, msg } from './lib/i18n.js';
import { clubLink } from './lib/inbox.js';
import { buildTaskBody, isWebUrl, pageSource, SELECTION_MAX } from './lib/task.js';
import { clearPairing, getState, setState } from './lib/storage.js';

// O popup: parear (código de 5 min gerado nas Configurações do Club) e criar uma tarefa rápida com responsável. Sem fila offline: com o Club
// fora do ar o formulário dá lugar ao aviso "Club offline" e nada fica guardado para depois.

const $ = (id) => document.getElementById(id);
const VIEWS = ['loading', 'offline', 'error', 'pair', 'task'];
const PREVIEW_MAX = 300;

/** @type {{ projects: any[], page: { url: string, title: string, selection: string } | null }} */
const state = { projects: [], page: null };

function view(name) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  $('unpair').hidden = name !== 'task' && name !== 'offline';
  const conn = $('conn');
  conn.hidden = name !== 'task' && name !== 'offline';
  conn.className = name === 'offline' ? 'conn is-offline' : 'conn';
  conn.textContent = msg(name === 'offline' ? 'connOffline' : 'connOk');
}

function say(el, text, kind) {
  el.hidden = !text;
  el.textContent = text ?? '';
  el.className = kind ? `status is-${kind}` : 'status';
}

// ---- abrir o popup ----

async function init() {
  view('loading');
  const { token, status } = await getState(['token', 'status']);
  // Revogado nas Configurações do Club: quem leu o aviso "!" no ícone encontra a explicação aqui.
  if (!token) return showPair(status === 'revoked' ? 'pairRevoked' : undefined);
  try {
    const { projects } = await call('/api/ext/v1/projects', { token });
    state.projects = projects.filter((p) => p.staff.length);
  } catch (err) {
    if (await onFailure(err)) return;
    // O Club respondeu, mas recusou (limite de pedidos, erro dele): o motivo na tela, sem esconder atrás de "offline".
    $('error-text').textContent = failureText(err);
    view('error');
    $('retry-error').focus();
    return;
  }
  state.page = await readPage();
  await showTask();
}

/** @returns {Promise<boolean>} true se o erro foi tratado aqui (offline ou pareamento perdido) */
async function onFailure(err) {
  if (err instanceof ClubError && err.kind === 'offline') {
    await setState({ status: 'offline' });
    view('offline');
    $('retry').focus();
    return true;
  }
  if (err instanceof ClubError && err.kind === 'unauthorized') {
    await clearPairing();
    await setState({ status: 'revoked' });
    void chrome.runtime.sendMessage({ type: 'poll' });
    showPair('pairRevoked');
    return true;
  }
  return false;
}

function showPair(noticeKey) {
  view('pair');
  const notice = $('pair-notice');
  notice.hidden = !noticeKey;
  notice.textContent = noticeKey ? msg(noticeKey) : '';
  say($('pair-error'), '');
  $('pair-code').focus();
}

// ---- parear ----

$('view-pair').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = $('pair-submit');
  const error = $('pair-error');
  submit.disabled = true;
  submit.textContent = msg('pairBusy');
  error.hidden = true;
  try {
    const { token, id } = await call('/api/ext/v1/pair', { method: 'POST', body: { code: $('pair-code').value.trim() } });
    await setState({ token, pairingId: id, seen: [], seeded: false, targets: {}, status: 'ok' });
    $('pair-code').value = '';
    void chrome.runtime.sendMessage({ type: 'poll' });
    await init();
  } catch (err) {
    if (err instanceof ClubError && err.kind === 'offline') await onFailure(err);
    else {
      error.hidden = false;
      error.textContent = pairError(err);
    }
  } finally {
    submit.disabled = false;
    submit.textContent = msg('pairButton');
  }
});

function pairError(err) {
  if (!(err instanceof ClubError)) return msg('errGeneric');
  if (err.status === 409) return msg('pairFull');
  if (err.kind === 'limited') return msg('errLimited', String(err.retryAfter ?? 60));
  if (err.status === 403) return msg('pairInvalid');
  return err.message;
}

// ---- tarefa rápida ----

const projectSelect = $('project');
const staffSelect = $('staff');

async function showTask() {
  const { choice } = await getState('choice');
  projectSelect.replaceChildren(...state.projects.map((p) => new Option(p.name, p.id)));
  const known = state.projects.find((p) => p.id === choice?.projectId);
  if (known) projectSelect.value = known.id;
  fillStaff(choice?.staffId);
  renderPage();
  view('task');
  $('title').focus();
}

function fillStaff(preferred) {
  const project = state.projects.find((p) => p.id === projectSelect.value);
  const staff = project?.staff ?? [];
  staffSelect.replaceChildren(...staff.map((s) => new Option(s.role ? `${s.name} · ${s.role}` : s.name, s.id)));
  if (staff.some((s) => s.id === preferred)) staffSelect.value = preferred;
  $('no-staff').hidden = state.projects.length > 0;
  $('create').disabled = staff.length === 0;
}

projectSelect.addEventListener('change', () => fillStaff());

// ---- a página atual (conteúdo externo: sempre marcado como tal) ----

async function readPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    let selection = '';
    if (isWebUrl(tab.url) && tab.id !== undefined) {
      try {
        const [run] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => String(getSelection() ?? '') });
        selection = typeof run?.result === 'string' ? run.result : '';
      } catch {
        // página que o Chrome não deixa ler (loja de extensões, PDF): fica sem a seleção
      }
    }
    return { url: tab.url, title: tab.title ?? '', selection };
  } catch {
    return null;
  }
}

function renderPage() {
  const page = state.page;
  const web = !!page && isWebUrl(page.url);
  const selection = web ? page.selection.trim() : '';
  $('page-none').hidden = web;
  $('page-pick').hidden = !web;
  $('selection-pick').hidden = !selection;
  $('selection-label').textContent = msg('attachSelection', String(Math.min(selection.length, SELECTION_MAX)));
  $('attach-page').checked = false;
  $('attach-selection').checked = false;
  renderExternal();
}

/** O que vai com a tarefa, como vai: a pessoa vê o conteúdo externo antes de criar. */
function currentSource() {
  if (!state.page) return null;
  return pageSource(state.page, { page: $('attach-page').checked, selection: $('attach-selection').checked });
}

function renderExternal() {
  const source = currentSource();
  $('external').hidden = !source;
  const rows = [];
  if (source?.url) rows.push([msg('rowUrl'), source.url]);
  if (source?.title) rows.push([msg('rowTitle'), source.title]);
  if (source?.selection) rows.push([msg('rowSelection'), source.selection.length > PREVIEW_MAX ? `${source.selection.slice(0, PREVIEW_MAX)}…` : source.selection]);
  $('external-rows').replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

$('attach-page').addEventListener('change', renderExternal);
$('attach-selection').addEventListener('change', renderExternal);

// ---- criar ----

$('view-task').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('task-status');
  const built = buildTaskBody({
    projectId: projectSelect.value,
    staffId: staffSelect.value,
    title: $('title').value,
    description: $('description').value,
    start: $('start').checked,
    source: currentSource(),
  });
  if (!built.ok) return say(status, msg(built.error), 'error');
  const { token } = await getState('token');
  const create = $('create');
  create.disabled = true;
  create.textContent = msg('creating');
  say(status, '');
  try {
    const task = await call('/api/ext/v1/tasks', { method: 'POST', body: built.body, token });
    await setState({ choice: { projectId: built.body.projectId, staffId: built.body.staffId } });
    $('title').value = '';
    $('description').value = '';
    $('start').checked = false;
    $('attach-page').checked = false;
    $('attach-selection').checked = false;
    renderExternal();
    say(status, msg('created', msg(STATUS_MESSAGE[task.status] ?? 'statusOther')), 'ok');
  } catch (err) {
    if (!(await onFailure(err))) say(status, failureText(err), 'error');
  } finally {
    create.disabled = false;
    create.textContent = msg('create');
  }
});

/** A mensagem de cada status em que o servidor pode devolver a tarefa criada. */
const STATUS_MESSAGE = { waiting: 'statusWaiting', todo: 'statusTodo', planning: 'statusDoing', doing: 'statusDoing', review: 'statusDoing' };

function failureText(err) {
  if (err instanceof ClubError && err.kind === 'limited') return msg('errLimited', String(err.retryAfter ?? 60));
  return err instanceof ClubError ? err.message : msg('errGeneric');
}

// ---- rodapé e tentar de novo ----

$('retry').addEventListener('click', () => void init());
$('retry-error').addEventListener('click', () => void init());
$('open-club').addEventListener('click', () => void chrome.tabs.create({ url: CLUB }));
$('open-tasks').addEventListener('click', () => void chrome.tabs.create({ url: clubLink({ view: 'tasks', projectId: projectSelect.value }) }));
$('unpair').addEventListener('click', async () => {
  await clearPairing();
  await setState({ status: 'unpaired' });
  void chrome.runtime.sendMessage({ type: 'poll' });
  showPair();
});

document.documentElement.lang = chrome.i18n.getUILanguage();
applyI18n();
void init();
