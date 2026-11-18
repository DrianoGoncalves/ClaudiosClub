import { describe, expect, it } from 'vitest';
import taskMessages from '../client/src/i18n/tasks';
import { queueKeys } from '../client/src/tasks/TasksBoard';

// Com bloqueadora segurando a tarefa (aprovada e ainda sem mesclar também), a fila só mostra a posição: não promete início.

type Locale = 'pt-BR' | 'en' | 'es';
const LOCALES: Locale[] = ['pt-BR', 'en', 'es'];
const tr = (locale: Locale, key: string, vars: Record<string, string | number>) =>
  ((taskMessages[locale] as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));

describe('queueKeys', () => {
  it('com bloqueadora pendente: dica e linha só de posição, esteja o dono ocupado ou não', () => {
    for (const busy of [true, false]) {
      expect(queueKeys(true, busy)).toEqual({ chip: 'tasks.queuedOrderHint', detail: 'tasks.queueOnly' });
    }
  });

  it('sem bloqueadora: os textos de sempre', () => {
    expect(queueKeys(false, true)).toEqual({ chip: 'tasks.queuedHint', detail: 'tasks.queueBusy' });
    expect(queueKeys(false, false)).toEqual({ chip: 'tasks.queuedHint', detail: 'tasks.queueFree' });
  });
});

describe('textos da fila com bloqueadora', () => {
  it.each(LOCALES)('%s: tem as 2 chaves e a linha mostra quem e a posição', (locale) => {
    const line = tr(locale, 'tasks.queueOnly', { who: 'Ana', pos: 2, title: 'Outra' });
    expect(line).toContain('Ana');
    expect(line).toContain('2');
    expect(line).not.toContain('{');
    expect(line).not.toContain('Outra');
    expect((taskMessages[locale] as Record<string, string>)['tasks.queuedOrderHint']?.trim()).toBeTruthy();
  });

  it.each(LOCALES)('%s: nenhum dos dois promete início', (locale) => {
    const promise = /começa|inicia|starts?|empieza/i;
    expect(tr(locale, 'tasks.queueOnly', { who: 'Ana', pos: 1 })).not.toMatch(promise);
    expect(tr(locale, 'tasks.queuedOrderHint', {})).not.toMatch(promise);
  });
});
