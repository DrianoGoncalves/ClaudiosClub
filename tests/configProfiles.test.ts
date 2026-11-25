import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeProfile, PROFILE_IDS, PROFILE_KEYS, PROFILES, profileChanges, profilePatch } from '../shared/configProfiles';
import { ConfigPatch, readConfig } from '../server/config';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { changeLine, ProfilePicker } from '../client/src/toolbar/ProfilePicker';

// Perfis de uso das Configurações: um clique ajusta gasto, limites e uso da máquina. Privacidade e segurança nunca entram num perfil.

describe('perfis', () => {
  it('o Equilibrado é exatamente o padrão do Claudio’s Club', async () => {
    const defaults = await readConfig(path.join(os.tmpdir(), `myco-sem-config-${process.pid}.json`));
    for (const k of PROFILE_KEYS) expect(PROFILES.balanced[k], k).toEqual(defaults[k]);
    expect(activeProfile(defaults)).toBe('balanced');
  });

  it('todo perfil passa na mesma validação da gravação da tela', () => {
    for (const id of PROFILE_IDS) expect(() => ConfigPatch.parse(profilePatch(id)), id).not.toThrow();
  });

  it('nenhum perfil mexe em privacidade ou segurança, nem no que é de cada funcionário', () => {
    for (const k of ['codexReview', 'codexBrowser', 'internetAccess', 'clubGuard', 'codexModel', 'autoContinue', 'autoRetry', 'stopOnTabClose']) {
      expect(PROFILE_KEYS as readonly string[]).not.toContain(k);
      for (const id of PROFILE_IDS) expect(Object.keys(profilePatch(id))).not.toContain(k);
    }
  });

  it('os perfis são diferentes entre si (cada um tem como ser reconhecido)', () => {
    const seen = new Set(PROFILE_IDS.map((id) => JSON.stringify(PROFILES[id])));
    expect(seen.size).toBe(PROFILE_IDS.length);
  });

  it('qual está ativo: bate tudo = o perfil; um item mexido = Personalizado; config que não chegou = null', () => {
    for (const id of PROFILE_IDS) expect(activeProfile(profilePatch(id))).toBe(id);
    expect(activeProfile({ ...PROFILES.balanced, maxActiveChats: 3 })).toBe('custom'); // a config de hoje do MyCo
    expect(activeProfile({ ...PROFILES.economy, usageStop: { fiveHour: 80, sevenDay: 91 } })).toBe('custom');
    expect(activeProfile(null)).toBeNull();
    expect(activeProfile({ aiTitles: true })).toBeNull();
  });

  it('o que muda: só os itens diferentes, a trava de consumo em duas linhas', () => {
    const c = profileChanges(PROFILES.balanced, PROFILES.light);
    expect(c.map((x) => x.key)).toEqual(['aiTitles', 'minFreeRamGb', 'cpuGate', 'maxActiveChats']);
    const e = profileChanges(PROFILES.balanced, PROFILES.economy);
    expect(e.map((x) => x.key)).toContain('usageStop.fiveHour');
    expect(e.map((x) => x.key)).toContain('usageStop.sevenDay');
    expect(profileChanges(PROFILES.quality, PROFILES.quality)).toEqual([]);
  });

  it('a linha da confirmação: título da tela, de → para, como a pessoa lê', () => {
    expect(changeLine({ key: 'maxActiveChats', from: 0, to: 2 })).toBe('Teto de conversas ao mesmo tempo: sem teto → 2');
    expect(changeLine({ key: 'minFreeRamGb', from: 1.5, to: 2 })).toBe('Reserva de RAM livre: 1,5 GB → 2 GB');
    expect(changeLine({ key: 'aiTitles', from: true, to: false })).toBe('Títulos de conversa por IA: Ligado → Desligado');
    expect(changeLine({ key: 'usageStop.fiveHour', from: 90, to: 80 })).toBe('Trava de consumo: 5 horas: 90% → 80%');
    expect(changeLine({ key: 'maxTurnMinutes', from: 180, to: 60 })).toBe('Teto de minutos por turno: 180 min → 60 min');
  });

  it('o seletor: 4 botões na ordem, o ativo marcado; com itens mexidos à mão, nenhum marcado e o aviso de Personalizado', () => {
    const html = renderToStaticMarkup(createElement(ProfilePicker, { values: profilePatch('light'), onConfig: () => {} }));
    const buttons = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map((m) => [m[2], m[1]]);
    expect(buttons).toEqual([
      ['Equilibrado', 'false'],
      ['Economia de tokens', 'false'],
      ['PC leve', 'true'],
      ['Máxima qualidade', 'false'],
    ]);
    expect(html).toContain('Para computador modesto');
    const custom = renderToStaticMarkup(createElement(ProfilePicker, { values: { ...PROFILES.balanced, maxActiveChats: 3 }, onConfig: () => {} }));
    expect(custom).not.toContain('aria-pressed="true"');
    expect(custom).toContain('Personalizado');
    expect(custom).toContain('Você ajustou itens à mão');
  });

  it('a tela mostra o perfil logo abaixo do nível de uso, no Simples e no Avançado', async () => {
    const menu = await fs.readFile(path.join(__dirname, '..', 'client', 'src', 'toolbar', 'SettingsMenu.tsx'), 'utf8');
    expect(menu.indexOf("id: 'profile'")).toBeGreaterThan(menu.indexOf("id: 'ui-level'"));
    expect(menu).toContain("simple: simpleInfo('level', 'profile', true)");
    const simple = await fs.readFile(path.join(__dirname, '..', 'client', 'src', 'toolbar', 'SettingsSimple.tsx'), 'utf8');
    expect(simple.indexOf("'profile'")).toBe(simple.indexOf("'uiLevel'") + "'uiLevel',\n  ".length);
  });
});
