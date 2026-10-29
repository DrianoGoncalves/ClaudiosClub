import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ContextSwitch } from '../shared/model';
import { contextNotice, rereadUsd, switchDecision } from '../server/chat/contextPolicy';
import { CHECKPOINT, CONTEXT_NOTICE, hasCheckpoint, isInjectedUserText, stripCheckpoint } from '../server/chat/items';
import { ChatManager } from '../server/chat/manager';

const turn = (over: Partial<Parameters<typeof switchDecision>[0]> = {}) => ({ at: 0, used: 200_000, checkpoint: true, model: 'claude-opus-5-5', ...over });

describe('quando vale começar uma conversa nova', () => {
  it('só depois do ponto de corte, e só quando compensa', () => {
    expect(switchDecision(turn(), 1000, 'auto')).toBe('switch');
    expect(switchDecision(turn(), 1000, 'suggest')).toBe('suggest');
    expect(switchDecision(turn(), 1000, 'off')).toBeNull();
    // Sem ponto de corte (no meio de um trabalho): nunca troca sozinho.
    expect(switchDecision(turn({ checkpoint: false, used: 900_000 }), 1000, 'auto')).toBeNull();
    // Conversa pequena: continuar sai mais barato que reler ficha e memória numa nova.
    expect(switchDecision(turn({ used: 30_000 }), 1000, 'auto')).toBeNull();
    // Média, mas o cache já esfriou (pausa > 5 min): a próxima resposta reescreveria tudo.
    expect(switchDecision(turn({ used: 60_000 }), 60_000, 'auto')).toBeNull();
    expect(switchDecision(turn({ used: 60_000 }), 6 * 60_000, 'auto')).toBe('switch');
  });

  it('o aviso para o funcionário traz o tamanho e quanto custa reler', () => {
    expect(rereadUsd(400_000, 'claude-opus-5-5')).toBeCloseTo(0.08);
    expect(contextNotice(412_000, 'claude-opus-5-5', CONTEXT_NOTICE)).toBe(
      '[MyCo] Contexto desta conversa: 412k tokens (cerca de US$ 0,08 por resposta só para reler). Feche o assunto atual e use o ponto de corte assim que for natural.',
    );
    // A conversa não mostra o aviso como se fosse você falando.
    expect(isInjectedUserText(contextNotice(200_000, null, CONTEXT_NOTICE))).toBe(true);
  });

  it('o ponto de corte vale só na última linha e some do texto', () => {
    expect(hasCheckpoint(`Pronto, entregue.\n\n${CHECKPOINT}\n`)).toBe(true);
    expect(hasCheckpoint(`Vou usar ${CHECKPOINT} quando terminar.\nAinda falta o teste.`)).toBe(false);
    expect(stripCheckpoint(`Pronto.\n\n${CHECKPOINT}`)).toBe('Pronto.');
    expect(stripCheckpoint('Sem marcador.')).toBe('Sem marcador.');
  });
});

/** Um processo `claude` falso por conversa aberta, com o que o Claudio’s Club escreveu nele. */
function setup(opts: { policy?: ContextSwitch; keep?: boolean } = {}) {
  const procs: Array<{ sid: string; written: Array<{ message?: { content?: Array<{ text?: string }> } }>; emit: (ev: object) => void }> = [];
  let n = 0;
  const m = new ChatManager({
    transcriptsDir: '.',
    usageFile: 'nao-usado.json',
    listLive: async () => [],
    resolve: async (_p, sid) => ({ sessionId: sid ?? `nova-${++n}`, cwd: '.', args: [] }),
    spawnImpl: () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 1000 + procs.length, kill: () => proc.emit('exit', 0) });
      const entry = { sid: '', written: [] as never[], emit: (ev: object) => void stdout.write(JSON.stringify(ev) + '\n') };
      stdin.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => entry.written.push(JSON.parse(l) as never)));
      procs.push(entry);
      return proc as never;
    },
    contextSwitch: async () => opts.policy ?? 'auto',
    keepSession: async () => !!opts.keep,
  });
  const reply = async (i: number, text: string, used: number) => {
    procs[i]!.emit({ type: 'assistant', message: { id: `m${Math.random()}`, model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: used - 10 } } });
    procs[i]!.emit({ type: 'result', is_error: false });
    await new Promise((r) => setTimeout(r, 15));
  };
  const lastText = (i: number) => (procs[i]!.written.at(-1)?.message?.content ?? []).map((b) => b.text ?? '').join('\n');
  /** Os textos de um tipo de item da conversa aberta. */
  const texts = async (sid: string, kind: 'assistant' | 'notice') =>
    ((await m.snapshot('p', sid)).live?.items ?? []).filter((i) => i.kind === kind).map((i) => (i as { text: string }).text);
  return { m, procs, reply, lastText, texts };
}

describe('conversa nova no momento barato', () => {
  it('conversa grande: avisa o funcionário; depois do ponto de corte, a sua mensagem segue numa nova', async () => {
    const { m, procs, reply, lastText, texts } = setup();
    expect(await m.sendFromUser('p', null, 'ana', 'comece')).toBe('nova-1');
    await reply(0, 'Começando a análise.', 200_000);

    // Grande, sem ponto de corte: continua nela, e o funcionário fica sabendo do tamanho.
    expect(await m.sendFromUser('p', 'nova-1', 'ana', 'e o resto?')).toBe('nova-1');
    expect(lastText(0)).toContain('[MyCo] Contexto desta conversa: 200k tokens');
    await reply(0, `Tudo entregue; memória atualizada.\n\n${CHECKPOINT}`, 210_000);
    // O marcador some do que você vê.
    expect((await texts('nova-1', 'assistant')).at(-1)).toBe('Tudo entregue; memória atualizada.');

    // Assunto fechado numa conversa grande: a próxima mensagem vai para uma conversa nova.
    expect(await m.sendFromUser('p', 'nova-1', 'ana', 'outro assunto')).toBe('nova-2');
    expect(procs).toHaveLength(2);
    expect(lastText(1)).toBe('outro assunto');
    expect((await texts('nova-2', 'notice'))[0]).toContain('Seguiu numa conversa nova: a anterior tinha 210k');
  });

  it('conversa de tarefa nunca troca; em "só avisar", avisa e fica', async () => {
    const task = setup({ keep: true });
    await task.m.sendFromUser('p', null, 'ana', 'tarefa');
    await task.reply(0, `Entregue.\n${CHECKPOINT}`, 300_000);
    expect(await task.m.sendFromUser('p', 'nova-1', 'ana', 'ajuste')).toBe('nova-1');

    const suggest = setup({ policy: 'suggest' });
    await suggest.m.sendFromUser('p', null, 'ana', 'oi');
    await suggest.reply(0, `Feito.\n${CHECKPOINT}`, 150_000);
    expect(await suggest.m.sendFromUser('p', 'nova-1', 'ana', 'mais')).toBe('nova-1');
    expect((await suggest.texts('nova-1', 'notice')).some((t) => t.includes('a próxima pergunta sai mais barata numa conversa nova'))).toBe(true);
  });

  it('passou do teto sem fechar o assunto: avisa você, uma vez a cada 100k', async () => {
    const { m, reply, texts } = setup();
    await m.sendFromUser('p', null, 'ana', 'oi');
    await reply(0, 'Trabalhando…', 320_000);
    await m.sendFromUser('p', 'nova-1', 'ana', 'segue');
    await reply(0, 'Ainda trabalhando…', 350_000);
    expect((await texts('nova-1', 'notice')).filter((t) => t.startsWith('Esta conversa tem'))).toHaveLength(1);
  });
});
