import { call, ClubError } from './lib/api.js';
import { badgeText, clubLink, KIND_MESSAGE, MAX_SINGLE, planNotifications, whoOf, withTarget } from './lib/inbox.js';
import { msg } from './lib/i18n.js';
import { clearPairing, getState, setState } from './lib/storage.js';

// O service worker: de minuto em minuto lê o inbox do Club ("precisa de mim"), avisa o que é novo (chrome.notifications) e põe o número
// no ícone. Funciona com a aba do Club fechada, mas o Club (o servidor) e o Chrome precisam estar abertos. Sem fila offline: se o Club
// não responde, só o selo "off" avisa, e a próxima leitura tenta de novo.

const ALARM = 'club-inbox';
const ICON = 'icons/icon-192.png';
const MANY_ID = 'club-many';

/** Cores do selo: as do Club (--accent no claro, --waiting, --muted). */
const BADGE_COLOR = { ok: '#1f4fbf', offline: '#6b7076', revoked: '#d08000' };

/** Uma leitura por vez: o alarme, o popup e o início do navegador podem chamar juntos. */
let running = null;

function ensureAlarm() {
  chrome.alarms.get(ALARM).then((alarm) => {
    // Recriar a cada acordada zeraria o relógio do alarme.
    if (!alarm) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  void poll();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  void poll();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void poll();
});
chrome.notifications.onClicked.addListener((id) => void openFromNotification(id));
// O popup avisa quando pareia (ou desparea): a primeira leitura é já, não daqui a 1 min.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'poll') void poll();
});
ensureAlarm();

function poll() {
  if (!running) running = readInbox().finally(() => (running = null));
  return running;
}

/** @param {'ok' | 'offline' | 'revoked' | 'unpaired'} status @param {number} [count] */
async function show(status, count = 0) {
  await setState({ status });
  const text = status === 'ok' ? badgeText(count) : status === 'offline' ? 'off' : status === 'revoked' ? '!' : '';
  const title =
    status === 'ok'
      ? count > 0
        ? msg('titleCount', String(count))
        : msg('titleNone')
      : status === 'offline'
        ? msg('titleOffline')
        : status === 'revoked'
          ? msg('titleRevoked')
          : msg('titleUnpaired');
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR[status] ?? BADGE_COLOR.ok });
  await chrome.action.setTitle({ title });
}

async function readInbox() {
  const { token, seen = [], seeded = false, targets = {} } = await getState(['token', 'seen', 'seeded', 'targets']);
  if (!token) {
    // Revogado continua valendo como aviso (o "!") até parear de novo; só quem nunca pareou fica sem selo.
    const { status } = await getState('status');
    return show(status === 'revoked' ? 'revoked' : 'unpaired');
  }
  let items;
  try {
    ({ items } = await call('/api/ext/v1/inbox', { token }));
  } catch (err) {
    if (err instanceof ClubError && err.kind === 'unauthorized') {
      // Revogado nas Configurações do Club: o token não vale mais.
      await clearPairing();
      return show('revoked');
    }
    // Offline, limite de pedidos ou erro do servidor: nada muda, o próximo minuto tenta de novo.
    return show('offline');
  }
  const plan = planNotifications(items, seen, seeded);
  let next = targets;
  for (const item of plan.fresh.length > MAX_SINGLE ? [] : plan.fresh) {
    const id = `club:${item.id}`;
    next = withTarget(next, id, { kind: item.kind, projectId: item.projectId, staffId: item.staffId, taskId: item.taskId ?? null });
    await notify(id, `${whoOf(item)} ${msg(KIND_MESSAGE[item.kind] ?? 'kindWaiting')}`, item.summary || msg(KIND_MESSAGE[item.kind] ?? 'kindWaiting'));
  }
  if (plan.fresh.length > MAX_SINGLE) {
    next = withTarget(next, MANY_ID, { kind: '', projectId: '', staffId: null });
    await notify(MANY_ID, msg('notifMany', String(plan.fresh.length)), msg('notifManyBody'));
  }
  // Visto é visto, mesmo que o Chrome tenha recusado a notificação (sem permissão): senão repetiria todo minuto.
  await setState({ seen: plan.seen, seeded: true, targets: next });
  await show('ok', items.length);
}

async function notify(id, title, message) {
  try {
    await chrome.notifications.create(id, { type: 'basic', iconUrl: ICON, title, message });
  } catch {
    // notificações desligadas no sistema ou no Chrome: o selo do ícone segue mostrando
  }
}

async function openFromNotification(id) {
  const { targets = {} } = await getState('targets');
  const target = targets[id];
  chrome.notifications.clear(id);
  await chrome.tabs.create({ url: clubLink(target ?? {}) });
}
