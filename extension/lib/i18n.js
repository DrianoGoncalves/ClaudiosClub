// Textos da extensão (_locales/): o idioma é o do Chrome (pt-BR, en ou es; fora disso, pt-BR).

/**
 * @param {string} key
 * @param {string | string[]} [subs]
 */
export const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

/**
 * Preenche o que tem `data-i18n="chave"` (texto) e `data-i18n-attr="atributo:chave; outro:chave"` (placeholder, title, aria-label).
 * @param {ParentNode} [root]
 */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = msg(el.getAttribute('data-i18n') ?? '');
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of (el.getAttribute('data-i18n-attr') ?? '').split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, msg(key));
    }
  }
}
