import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskPause } from '../shared/model';
import { PauseNote, pauseText } from '../client/src/tasks/TaskPause';
import taskMessages from '../client/src/i18n/tasks';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const released = (over: Partial<TaskPause> = {}): TaskPause => ({
  state: 'released',
  reason: 'dúvida escalada sem edição: pausada esperando você',
  since: '2026-11-16T11:48:00Z',
  movedTo: { id: 't-b', title: 'Ajustar o login' },
  ...over,
});
const holding = (): TaskPause => ({ state: 'holding', reason: 'dúvida com edição em andamento', since: '2026-11-16T11:48:00Z', movedTo: null });

describe('aviso da tarefa pausada pela dúvida', () => {
  it('pausada: diz que espera a resposta, há quanto tempo e para qual tarefa o funcionário seguiu', () => {
    const text = pauseText(released(), 'Ana', NOW)!;
    expect(text.state).toBe('released');
    expect(text.head).toContain('Pausada');
    expect(text.head).toContain('12');
    expect(text.body).toBe('Ana seguiu para “Ajustar o login”');
  });

  it('pausada sem outra tarefa (movedTo null): o funcionário está livre', () => {
    expect(pauseText(released({ movedTo: null }), 'Ana', NOW)!.body).toBe('Ana está sem outra tarefa agora');
  });

  it('ocupando: diz o motivo (já há edição) e que ele fica até a resposta', () => {
    const text = pauseText(holding(), 'Ana', NOW)!;
    expect(text.state).toBe('holding');
    expect(text.head).toBe('Ocupando Ana até você responder');
    expect(text.body).toContain('edição');
  });

  it('sem ficha na lista usa o texto genérico; `since` ruim não quebra', () => {
    expect(pauseText(released(), null, NOW)!.body).toContain('o funcionário seguiu');
    expect(pauseText(released({ since: 'lixo' }), 'Ana', NOW)!.head).toBe('Pausada, espera a sua resposta');
  });

  it('sem `pause` (dúvida com o gestor, respondida ou sem dúvida): nada na tela', () => {
    expect(pauseText(undefined, 'Ana', NOW)).toBeNull();
    expect(renderToStaticMarkup(createElement(PauseNote, { pause: undefined, staffName: 'Ana', now: NOW }))).toBe('');
  });

  it('cartão: classe do estado, texto escapado e a regra inteira no title', () => {
    const html = renderToStaticMarkup(
      createElement(PauseNote, { pause: released({ movedTo: { id: 't-b', title: '<b>x</b> & y' } }), staffName: 'Ana', now: NOW }),
    );
    expect(html).toContain('task-pause is-released');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
    expect(html).toContain('title="A dúvida está com você e nada foi editado');
    expect(renderToStaticMarkup(createElement(PauseNote, { pause: holding(), staffName: 'Ana', now: NOW }))).toContain('task-pause is-holding');
  });

  it('en e es têm as mesmas chaves do pt', () => {
    const keys = Object.keys(taskMessages['pt-BR']).filter((k) => k.startsWith('tasks.pause'));
    expect(keys).toHaveLength(8);
    for (const locale of ['en', 'es'] as const) {
      for (const k of keys) expect((taskMessages[locale] as Record<string, string>)[k], `${locale} ${k}`).toBeTruthy();
    }
  });
});
