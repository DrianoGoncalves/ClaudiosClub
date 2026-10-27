import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { PROJECT_COLORS, type BoardBackground, type ProjectColor } from '../../../shared/model';

// Cores escolhidas pelo usuário: a caneta da parede de cada sala e o fundo do quadro em cada tema.
// Os tons das canetas são variáveis do styles.css (`--pen-<cor>`), um para o claro e outro para o escuro.

export const PROJECT_COLOR_LABEL: Record<ProjectColor, string> = {
  red: 'vermelho',
  orange: 'laranja',
  yellow: 'amarelo',
  green: 'verde',
  teal: 'verde-água',
  blue: 'azul',
  purple: 'roxo',
  pink: 'rosa',
};

export type Theme = keyof BoardBackground;

/** Fundo de fábrica de cada tema (o mesmo `--board` do styles.css). */
export const BACKGROUND_DEFAULT: Record<Theme, { hex: string; label: string }> = {
  light: { hex: '#fbfaf6', label: 'quadro branco' },
  dark: { hex: '#1f2a25', label: 'lousa' },
};

export const BACKGROUND_PRESETS: Record<Theme, Array<{ hex: string; label: string }>> = {
  light: [
    { hex: '#ffffff', label: 'branco' },
    { hex: '#f6f0e1', label: 'creme' },
    { hex: '#eef0f2', label: 'cinza' },
    { hex: '#edf3fb', label: 'azulado' },
    { hex: '#eef6ee', label: 'verde-claro' },
  ],
  dark: [
    { hex: '#1e2124', label: 'grafite' },
    { hex: '#18212f', label: 'azul-noite' },
    { hex: '#121212', label: 'preto' },
    { hex: '#241f2c', label: 'roxo-noite' },
    { hex: '#2a2420', label: 'café' },
  ],
};

const HEX = /^#[0-9a-f]{6}$/i;

/** Bolinhas de cor para a parede da sala; a primeira volta à padrão. */
export function RoomColorPicker({
  value,
  onChange,
  label = 'Cor da sala',
  small,
}: {
  value: ProjectColor | null;
  onChange: (color: ProjectColor | null) => Promise<void>;
  label?: string;
  small?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (color: ProjectColor | null) => {
    if (color === value) return;
    setBusy(true);
    setError(null);
    try {
      await onChange(color);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={`swatches ${small ? 'swatches-sm' : ''}`} role="radiogroup" aria-label={label}>
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        className="swatch swatch-default"
        title="Padrão (grafite)"
        aria-label="padrão"
        disabled={busy}
        onClick={() => void pick(null)}
      />
      {PROJECT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          className="swatch"
          style={{ '--swatch': `var(--pen-${c})` } as CSSProperties}
          title={PROJECT_COLOR_LABEL[c]}
          aria-label={PROJECT_COLOR_LABEL[c]}
          disabled={busy}
          onClick={() => void pick(c)}
        />
      ))}
      {error && <span className="error small">{error}</span>}
    </span>
  );
}

/** Fundo de um tema: padrão, sugestões ou qualquer cor (o seletor do sistema). */
export function BackgroundPicker({
  theme,
  value,
  onChange,
}: {
  theme: Theme;
  value: string | null;
  onChange: (hex: string | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const save = (hex: string | null) => {
    setError(null);
    onChange(hex).then(
      () => setDraft(null),
      (e: Error) => setError(e.message),
    );
  };
  // O seletor do sistema dispara a cada movimento: grava só quando a mão para.
  const pickCustom = (hex: string) => {
    setDraft(hex);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(hex), 300);
  };

  const shown = draft ?? value;
  const def = BACKGROUND_DEFAULT[theme];
  const presets = BACKGROUND_PRESETS[theme];
  const custom = shown !== null && !presets.some((p) => p.hex === shown);
  return (
    <span className="swatches swatches-bg" role="radiogroup" aria-label={`Fundo no tema ${theme === 'light' ? 'claro' : 'escuro'}`}>
      <button
        type="button"
        role="radio"
        aria-checked={shown === null}
        className="swatch"
        style={{ '--swatch': def.hex } as CSSProperties}
        title={`Padrão (${def.label})`}
        aria-label={`padrão (${def.label})`}
        onClick={() => save(null)}
      />
      {presets.map((p) => (
        <button
          key={p.hex}
          type="button"
          role="radio"
          aria-checked={shown === p.hex}
          className="swatch"
          style={{ '--swatch': p.hex } as CSSProperties}
          title={p.label}
          aria-label={p.label}
          onClick={() => save(p.hex)}
        />
      ))}
      <label className={`swatch swatch-custom ${custom ? 'is-on' : ''}`} title="Outra cor" style={custom ? ({ '--swatch': shown } as CSSProperties) : undefined}>
        <input type="color" aria-label="Outra cor" value={shown ?? def.hex} onChange={(e) => pickCustom(e.target.value)} />
        {!custom && <span aria-hidden="true">+</span>}
      </label>
      <span className="muted small mono">{shown ?? 'padrão'}</span>
      {error && <span className="error small">{error}</span>}
    </span>
  );
}

const STYLE_ID = 'myco-board-background';

/**
 * Aplica o fundo escolhido sobre os tokens do styles.css: o quadro, os pontinhos e os cartões
 * acompanham o tom (os pontinhos puxam para a tinta; os cartões, para o branco).
 */
export function useBoardBackground(bg: BoardBackground | null | undefined) {
  const light = bg?.light && HEX.test(bg.light) ? bg.light : null;
  const dark = bg?.dark && HEX.test(bg.dark) ? bg.dark : null;
  useEffect(() => {
    const rule = (hex: string, dot: number, card: number) =>
      `:root:root { --board: ${hex}; --board-dot: color-mix(in srgb, ${hex}, var(--ink) ${dot}%); --card: color-mix(in srgb, ${hex}, #fff ${card}%); }`;
    const css = [
      light && `@media (prefers-color-scheme: light) { ${rule(light, 14, 60)} }`,
      dark && `@media (prefers-color-scheme: dark) { ${rule(dark, 10, 5)} }`,
    ]
      .filter(Boolean)
      .join('\n');
    let el = document.getElementById(STYLE_ID);
    if (!css) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = css;
  }, [light, dark]);
}

/** O tema do sistema agora (acompanha a troca sem recarregar). */
export function useSystemTheme(): Theme {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark ? 'dark' : 'light';
}
