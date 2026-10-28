// Tradução da interface (pt-BR, en, es), sem biblioteca. O idioma vale para a página inteira:
// trocar grava a escolha e recarrega, então `t()` pode ser chamado até em constantes de módulo.
// Cada área tem seu arquivo de mensagens; o pt-BR é a fonte e o TypeScript exige as mesmas chaves em en e es.
import app from './app';
import board from './board';
import chat from './chat';
import detail from './detail';
import office from './office';
import staff from './staff';
import tasks from './tasks';
import toolbar from './toolbar';

export type Locale = 'pt-BR' | 'en' | 'es';

// Nome de cada idioma nele mesmo (não se traduz).
export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'pt-BR', label: 'Português (Brasil)' },
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
];

const STORAGE_KEY = 'myco.locale';
const AREAS = [app, board, chat, detail, office, staff, tasks, toolbar];

type Messages = (typeof app)['pt-BR'] &
  (typeof board)['pt-BR'] &
  (typeof chat)['pt-BR'] &
  (typeof detail)['pt-BR'] &
  (typeof office)['pt-BR'] &
  (typeof staff)['pt-BR'] &
  (typeof tasks)['pt-BR'] &
  (typeof toolbar)['pt-BR'];
export type MsgKey = keyof Messages & string;

const isLocale = (v: unknown): v is Locale => LOCALES.some((l) => l.id === v);

function detect(): Locale {
  // Fora do navegador (testes) fica no pt-BR, o idioma em que os testes foram escritos.
  if (typeof window === 'undefined') return 'pt-BR';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* localStorage bloqueado: segue para o idioma do navegador */
  }
  const nav = (navigator.language || '').toLowerCase();
  if (nav.startsWith('pt')) return 'pt-BR';
  if (nav.startsWith('es')) return 'es';
  return 'en';
}

const current: Locale = detect();
if (typeof document !== 'undefined') document.documentElement.lang = current;

const dicts = {} as Record<Locale, Record<string, string>>;
for (const { id } of LOCALES) dicts[id] = Object.assign({}, ...AREAS.map((a) => a[id]));

/** Idioma da página, para `toLocaleString(locale(), ...)` e afins. */
export const locale = (): Locale => current;

/** Grava o idioma escolhido e recarrega a página. */
export function setLocale(next: Locale) {
  if (next === current) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    return;
  }
  window.location.reload();
}

/** Texto da chave no idioma atual; `{nome}` no texto é trocado por `vars.nome`. */
export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  const text = dicts[current][key] ?? dicts['pt-BR'][key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}
