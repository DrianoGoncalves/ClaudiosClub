// Pede ao menu de Configurações para abrir, já num grupo (ex.: "usage" a partir do aviso de consumo na caixa "precisa de mim").
// Quem pede não conhece o menu: o estado de aberto/fechado mora no SettingsMenu, que escuta este evento.

export const OPEN_SETTINGS_EVENT = 'myco:open-settings';

export function openSettings(group: string): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_SETTINGS_EVENT, { detail: group }));
}
