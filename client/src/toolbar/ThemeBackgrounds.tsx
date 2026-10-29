import type { CSSProperties } from 'react';
import type { BoardBackground } from '../../../shared/model';
import { BACKGROUND_DEFAULT, BackgroundPicker, type Theme } from '../board/colors';
import { t } from '../i18n';

// Fundo do quadro nos dois temas, lado a lado: cada coluna com o nome do tema, uma amostra da cor
// que vale agora, as bolinhas e o que acontece sem cor (o padrão de fábrica ou o fundo geral).

const THEMES: Theme[] = ['light', 'dark'];

export function ThemeBackgrounds({
  value,
  fallback,
  current,
  onChange,
}: {
  value: BoardBackground;
  /** Cor que vale sem escolha (no workspace, o fundo geral do quadro). Sem ele, o padrão de fábrica. */
  fallback?: BoardBackground | null;
  current: Theme;
  onChange: (theme: Theme, hex: string | null) => Promise<void>;
}) {
  return (
    <div className="bg-themes">
      {THEMES.map((theme) => {
        const def = BACKGROUND_DEFAULT[theme];
        const shown = value[theme] ?? fallback?.[theme] ?? def.hex;
        return (
          <div key={theme} className="bg-theme">
            <div className="bg-theme-head">
              <b>{t(theme === 'light' ? 'toolbar.themeLight' : 'toolbar.themeDark')}</b>
              {current === theme && <span className="badge">{t('toolbar.inUseNow')}</span>}
            </div>
            <span className="bg-theme-preview" style={{ '--swatch': shown } as CSSProperties} aria-hidden="true" />
            <BackgroundPicker theme={theme} value={value[theme]} onChange={(hex) => onChange(theme, hex)} />
            <span className="muted small">{fallback ? t('toolbar.bgDefaultGeneral') : t('toolbar.bgDefault', { name: def.label, hex: def.hex })}</span>
          </div>
        );
      })}
    </div>
  );
}
