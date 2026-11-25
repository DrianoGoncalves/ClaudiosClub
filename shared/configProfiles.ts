import type { AppConfig } from './model';

// Perfis de uso das Configurações: ajustam de uma vez as configurações de gasto, de limites e de uso da máquina. Só mexem no que está em `PROFILE_KEYS`.
// Privacidade e segurança (Codex revisando o diff, o GPT no Chrome, internet, bloqueio da tela do Club) nunca entram num perfil: seguem do jeito que o dono
// escolheu, item por item. O modelo e o esforço de cada funcionário também não: são da ficha dele.

export const PROFILE_IDS = ['balanced', 'economy', 'light', 'quality'] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

/** As configurações que um perfil ajusta (todas existem e são gravadas pelo mesmo `saveConfig` da tela). */
export const PROFILE_KEYS = [
  'aiTitles',
  'optimizeQuota',
  'contextSwitch',
  'usageStop',
  'maxTurnTools',
  'maxTurnMinutes',
  'resourceGate',
  'minFreeRamGb',
  'cpuGate',
  'maxActiveChats',
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];
export type ProfileValues = Pick<AppConfig, ProfileKey>;

export const PROFILES: Record<ProfileId, ProfileValues> = {
  // Os padrões do Claudio’s Club.
  balanced: {
    aiTitles: true,
    optimizeQuota: false,
    contextSwitch: 'suggest',
    usageStop: { fiveHour: 90, sevenDay: 95 },
    maxTurnTools: 500,
    maxTurnMinutes: 180,
    resourceGate: true,
    minFreeRamGb: 1.5,
    cpuGate: false,
    maxActiveChats: 0,
  },
  // Menos tokens: sem títulos por IA, conversa nova quando o assunto fecha (contexto menor), turnos com freio mais curto e trava de consumo mais cedo.
  economy: {
    aiTitles: false,
    optimizeQuota: false,
    contextSwitch: 'auto',
    usageStop: { fiveHour: 80, sevenDay: 90 },
    maxTurnTools: 200,
    maxTurnMinutes: 60,
    resourceGate: true,
    minFreeRamGb: 1.5,
    cpuGate: false,
    maxActiveChats: 3,
  },
  // Máquina modesta (8 GB, HDD): poucas conversas ao mesmo tempo, mais RAM de reserva, espera a CPU baixar, sem processo extra de títulos.
  light: {
    aiTitles: false,
    optimizeQuota: false,
    contextSwitch: 'suggest',
    usageStop: { fiveHour: 90, sevenDay: 95 },
    maxTurnTools: 500,
    maxTurnMinutes: 180,
    resourceGate: true,
    minFreeRamGb: 2,
    cpuGate: true,
    maxActiveChats: 2,
  },
  // Resultado em primeiro lugar: usa a folga da cota para subir o esforço, turnos mais longos, mais conversas ao mesmo tempo (para máquina com folga).
  quality: {
    aiTitles: true,
    optimizeQuota: true,
    contextSwitch: 'suggest',
    usageStop: { fiveHour: 95, sevenDay: 97 },
    maxTurnTools: 1000,
    maxTurnMinutes: 240,
    resourceGate: true,
    minFreeRamGb: 1.5,
    cpuGate: false,
    maxActiveChats: 4,
  },
};

const same = (a: unknown, b: unknown): boolean => (typeof a === 'object' && a && b && typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b);

/** O perfil que bate com a config agora, `custom` se nenhum bate (alguém ajustou um item), ou null se a config ainda não chegou. */
export function activeProfile(c: Partial<ProfileValues> | null | undefined): ProfileId | 'custom' | null {
  if (!c || PROFILE_KEYS.some((k) => c[k] === undefined || c[k] === null)) return null;
  for (const id of PROFILE_IDS) if (PROFILE_KEYS.every((k) => same(c[k], PROFILES[id][k]))) return id;
  return 'custom';
}

/** O que muda ao aplicar `to` sobre `from`, item por item (só os que mudam), na ordem de `PROFILE_KEYS`. A trava de consumo vira duas linhas (5 h e 7 dias). */
export type ProfileChange =
  | { key: Exclude<ProfileKey, 'usageStop'>; from: ProfileValues[Exclude<ProfileKey, 'usageStop'>]; to: ProfileValues[Exclude<ProfileKey, 'usageStop'>] }
  | { key: 'usageStop.fiveHour' | 'usageStop.sevenDay'; from: number | null; to: number | null };

export function profileChanges(from: ProfileValues, to: ProfileValues): ProfileChange[] {
  const out: ProfileChange[] = [];
  for (const k of PROFILE_KEYS) {
    if (k === 'usageStop') {
      if (from.usageStop.fiveHour !== to.usageStop.fiveHour) out.push({ key: 'usageStop.fiveHour', from: from.usageStop.fiveHour, to: to.usageStop.fiveHour });
      if (from.usageStop.sevenDay !== to.usageStop.sevenDay) out.push({ key: 'usageStop.sevenDay', from: from.usageStop.sevenDay, to: to.usageStop.sevenDay });
    } else if (!same(from[k], to[k])) out.push({ key: k, from: from[k], to: to[k] } as ProfileChange);
  }
  return out;
}

/** O patch do `saveConfig` que aplica o perfil (só as chaves do perfil). */
export const profilePatch = (id: ProfileId): ProfileValues => ({ ...PROFILES[id], usageStop: { ...PROFILES[id].usageStop } });
