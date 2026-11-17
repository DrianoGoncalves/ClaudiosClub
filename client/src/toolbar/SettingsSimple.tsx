import type { ReactNode } from 'react';
import { GaugeIcon, GlobeIcon, LayoutGridIcon, LifeBuoyIcon, MessageIcon, PaletteIcon, ShieldCheckIcon, SlidersIcon } from '../icons';
import { t, type MsgKey } from '../i18n';

// Configurações no nível Simples: os mesmos itens (e os mesmos controles e gravações) do SettingsMenu, mostrados por tema,
// em cartões com ícone, título em linguagem comum, uma frase do que muda e o controle direto. Cada item do menu leva um
// `simple` (ver `simpleInfo`); o texto técnico dele segue valendo no nível Avançado.

export type SimpleGroupId = 'level' | 'look' | 'board' | 'chat' | 'usage' | 'web' | 'care' | 'help';

/** Nome do item nas chaves `ss.<nome>.title` e `ss.<nome>.effect` (tirado das mensagens, então um nome sem texto não compila). */
export type SimpleKey = MsgKey extends infer K ? (K extends `ss.${infer N}.title` ? N : never) : never;

export interface SimpleInfo {
  key: SimpleKey;
  group: SimpleGroupId;
  title: string;
  effect: string;
  /** Controle largo (editor, lista, passo a passo): vai abaixo do texto, na largura toda. */
  wide: boolean;
}

export const simpleInfo = (group: SimpleGroupId, key: SimpleKey, wide = false): SimpleInfo => ({
  key,
  group,
  title: t(`ss.${key}.title` as MsgKey),
  effect: t(`ss.${key}.effect` as MsgKey),
  wide,
});

/** Ordem dos itens dentro de cada cartão (a do menu avançado segue outra, por isso fica aqui). */
export const SIMPLE_ORDER: readonly SimpleKey[] = [
  'uiLevel',
  'theme',
  'language',
  'animations',
  'workspaces',
  'archived',
  'chatDetail',
  'contextSwitch',
  'aiTitles',
  'usageStop5h',
  'usageStop7d',
  'autoContinue',
  'optimizeQuota',
  'queueGate',
  'internet',
  'extension',
  'pair',
  'update',
  'manual',
  'demo',
  'credits',
];

/** Os temas, na ordem da tela. */
export const SIMPLE_GROUPS: Array<{ id: SimpleGroupId; label: string; icon: ReactNode }> = [
  { id: 'level', label: t('ss.group.level'), icon: <SlidersIcon size={16} /> },
  { id: 'look', label: t('ss.group.look'), icon: <PaletteIcon size={16} /> },
  { id: 'board', label: t('ss.group.board'), icon: <LayoutGridIcon size={16} /> },
  { id: 'chat', label: t('ss.group.chat'), icon: <MessageIcon size={16} /> },
  { id: 'usage', label: t('ss.group.usage'), icon: <GaugeIcon size={16} /> },
  { id: 'web', label: t('ss.group.web'), icon: <GlobeIcon size={16} /> },
  { id: 'care', label: t('ss.group.care'), icon: <ShieldCheckIcon size={16} /> },
  { id: 'help', label: t('ss.group.help'), icon: <LifeBuoyIcon size={16} /> },
];

/** O que a vista Simples precisa de um item do menu (o item do menu tem isso e mais). */
export interface SimpleItem {
  id: string;
  simple: SimpleInfo;
  badge?: string;
  toggle?: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean };
  control?: ReactNode;
}

/** Itens agrupados por tema, só os temas que têm item, cada grupo na ordem de `SIMPLE_ORDER`. */
export function groupSimple<T extends SimpleItem>(items: T[]): Array<{ group: (typeof SIMPLE_GROUPS)[number]; items: T[] }> {
  const rank = (s: T) => SIMPLE_ORDER.indexOf(s.simple.key);
  return SIMPLE_GROUPS.map((group) => ({ group, items: items.filter((s) => s.simple.group === group.id).sort((a, b) => rank(a) - rank(b)) })).filter((g) => g.items.length > 0);
}

/** Liga/desliga do DS (botão com aria-pressed), com o estado escrito: "Ligado" / "Desligado". */
function SimpleToggle({ toggle, labelledBy }: { toggle: NonNullable<SimpleItem['toggle']>; labelledBy: string }) {
  return (
    <button
      type="button"
      className="btn-secondary btn-toggle ss-toggle"
      aria-pressed={toggle.checked}
      aria-labelledby={labelledBy}
      disabled={toggle.disabled}
      onClick={() => toggle.onChange(!toggle.checked)}
    >
      {toggle.checked ? t('ss.on') : t('ss.off')}
    </button>
  );
}

export function SimpleRow({ item: s }: { item: SimpleItem }) {
  const titleId = `ss-title-${s.id}`;
  return (
    <div className={`ss-item${s.simple.wide ? ' is-wide' : ''}`} id={`setting-${s.id}`}>
      <div className="ss-text">
        <div className="ss-title" id={titleId}>
          {s.simple.title}
          {s.badge && <span className="badge">{s.badge}</span>}
        </div>
        <p className="ss-effect">{s.simple.effect}</p>
      </div>
      <div className="ss-control">
        {s.toggle && <SimpleToggle toggle={s.toggle} labelledBy={titleId} />}
        {s.control}
      </div>
    </div>
  );
}

/**
 * A lista do nível Simples: introdução, um cartão por tema e, no fim, o convite para o Avançado quando há mais itens.
 * Sem estado e sem rede (testável por renderização no servidor).
 */
export function SimpleList({ items, hidden, empty, onAdvanced }: { items: SimpleItem[]; hidden: number; empty?: ReactNode; onAdvanced: () => void }) {
  return (
    <div className="ss-list">
      <p className="muted small ss-intro">{t('ss.intro')}</p>
      {groupSimple(items).map(({ group, items: rows }) => (
        <section key={group.id} data-group={group.id} className="ss-card" aria-labelledby={`ss-card-${group.id}`}>
          <header className="ss-head">
            <span className="ss-icon" aria-hidden="true">
              {group.icon}
            </span>
            <h3 id={`ss-card-${group.id}`}>{group.label}</h3>
          </header>
          {rows.map((s) => (
            <SimpleRow key={s.id} item={s} />
          ))}
        </section>
      ))}
      {empty}
      <p className="muted small settings-about">{t('toolbar.about')}</p>
      {hidden > 0 && (
        <p className="muted small ss-more">
          {t(hidden === 1 ? 'ss.moreOne' : 'ss.moreOther', { n: hidden })}{' '}
          <button type="button" className="link" onClick={onAdvanced}>
            {t('ss.goAdvanced')}
          </button>
        </p>
      )}
    </div>
  );
}
