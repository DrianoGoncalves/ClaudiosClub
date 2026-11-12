import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SystemStats } from '../../../shared/model';
import { api } from '../api';
import { locale, t } from '../i18n';

// Monitor do canto superior direito: CPU e RAM da máquina (config → Geral liga e desliga, neste navegador). Uma camada
// meio transparente (inteira com o mouse em cima); a posição é do CornerDock. Pergunta a cada 5 s, só com a aba visível.

const KEY = 'myco.systemMonitor';
const POLL_MS = 5000;
/** A partir daqui o número fica em vermelho e a camada, opaca: é o que deixa a máquina lenta. */
const HOT_CPU = 85;
const HOT_MEM = 90;
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

let value = read();

function set(v: boolean) {
  value = v;
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    // sem armazenamento: vale só nesta aba
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSystemMonitor(): [boolean, (v: boolean) => void] {
  return [useSyncExternalStore(subscribe, () => value), set];
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function Meter({ label, pct, text }: { label: string; pct: number | null; text: string }) {
  const hot = pct !== null && pct >= (label === 'CPU' ? HOT_CPU : HOT_MEM);
  return (
    <div className={`sysmon-row${hot ? ' is-hot' : ''}`}>
      <span>{label}</span>
      <span className="sysmon-bar">
        <span style={{ width: `${pct ?? 0}%` }} />
      </span>
      <span>{text}</span>
    </div>
  );
}

export function SystemMonitor() {
  const [on] = useSystemMonitor();
  const [stats, setStats] = useState<SystemStats | null>(null);
  useEffect(() => {
    if (!on) return;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      api.system().then(setStats, () => setStats(null));
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [on]);

  if (!on || !stats) return null;
  const used = stats.memTotal - stats.memFree;
  const memPct = Math.round((used / stats.memTotal) * 100);
  const hot = (stats.cpu ?? 0) >= HOT_CPU || memPct >= HOT_MEM;
  return (
    <div className={`sysmon${hot ? ' is-hot' : ''}`} role="group" aria-label={t('toolbar.sysmonLabel')}>
      <Meter label="CPU" pct={stats.cpu} text={stats.cpu === null ? '…' : `${stats.cpu}%`} />
      <Meter label="RAM" pct={memPct} text={`${gb(used)}/${gb(stats.memTotal)} GB`} />
    </div>
  );
}
