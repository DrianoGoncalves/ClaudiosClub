import type { XYPosition } from '@xyflow/react';
import type { AppConfig } from '../../../shared/model';
import { TAB_ALL, TAB_NONE } from '../office/workspaces';

// Posições arrastadas ficam no navegador por enquanto; vão para `.myco/` quando houver escrita no disco.
// v4: uma planta por aba (Todos, cada workspace, Sem workspace): arrastar ou "reorganizar" numa não mexe nas outras.
// v3 era uma só para todas as abas; vale como ponto de partida de cada aba até ela ser mexida (a v3 não é reescrita).
const POSITIONS_KEY = 'myco.positions.v4';
const LEGACY_KEY = 'myco.positions.v3';
// Ordem dos projetos que o "reorganizar" fixa (ids, por aba): sem ela a grade nova voltaria à ordem alfabética.
const ORDER_KEY = 'myco.order.v1';

export type Positions = Record<string, XYPosition>;

export interface PositionStore {
  byTab: Record<string, Positions>;
  legacy: Positions;
  order: Record<string, string[]>;
}

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

export function loadPositions(): PositionStore {
  return {
    byTab: read<Record<string, Positions>>(POSITIONS_KEY) ?? {},
    legacy: read<Positions>(LEGACY_KEY) ?? {},
    order: read<Record<string, string[]>>(ORDER_KEY) ?? {},
  };
}

export function savePositions(store: PositionStore) {
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(store.byTab));
    localStorage.setItem(ORDER_KEY, JSON.stringify(store.order));
  } catch {
    // armazenamento indisponível: as posições valem só nesta aba
  }
}

/** Planta da aba: aba de workspace que não existe mais vale como "Todos" (ver `inTab`). */
export function layoutKey(tab: string, config: Pick<AppConfig, 'workspaces'> | null): string {
  return tab === TAB_ALL || tab === TAB_NONE || config?.workspaces.some((w) => w.id === tab) ? tab : TAB_ALL;
}

export const positionsOf = (store: PositionStore, key: string): Positions => store.byTab[key] ?? store.legacy;

/** Grava as posições dos nós arrastados só na planta da aba. */
export function withMoved(store: PositionStore, key: string, moved: Positions): PositionStore {
  return { ...store, byTab: { ...store.byTab, [key]: { ...positionsOf(store, key), ...moved } } };
}

/**
 * "Reorganizar": zera só a planta da aba (`{}` explícito, para não voltar à v3) e guarda a ordem
 * dos projetos que a grade nova deve seguir.
 */
export function withReset(store: PositionStore, key: string, order: string[]): PositionStore {
  return { ...store, byTab: { ...store.byTab, [key]: {} }, order: { ...store.order, [key]: order } };
}
