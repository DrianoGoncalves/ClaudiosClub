/** Mensagens de uma área: o pt-BR define as chaves, en e es precisam ter todas. */
export function defineMessages<T extends Record<string, string>>(m: {
  'pt-BR': T;
  en: Record<keyof T, string>;
  es: Record<keyof T, string>;
}) {
  return m;
}
