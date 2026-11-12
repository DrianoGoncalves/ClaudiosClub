import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProjectSessions, sessionTopic } from '../server/adapters/claude/sessions';

const user = (content: unknown) => ({ type: 'user', message: { content } });
const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const CP = '[MyCo:ponto-de-corte]';

describe('assunto da conversa', () => {
  it('a tarefa do quadro dá o nome; senão, a 1ª linha da 1ª mensagem sua', () => {
    expect(sessionTopic([user('[Tarefa "Scrollbar do kanban"] deixe o scroll com a classe do DS')])).toBe('Scrollbar do kanban');
    expect(sessionTopic([user([{ type: 'text', text: 'Corrija o total do pedido\ncom teste' }])])).toBe('Corrija o total do pedido');
  });

  it('pula o que é injetado, os avisos do Claudio’s Club e a saudação de sessão nova', () => {
    const lines = [
      { type: 'summary' },
      user('<local-command-stdout>ok</local-command-stdout>'),
      user('Olá, Belchior. Leia sua memória e diga em poucas linhas como pretende começar.'),
      user([{ type: 'tool_result', content: 'x' }]),
      user([
        { type: 'text', text: '[MyCo] Contexto desta conversa: 160k' },
        { type: 'text', text: 'Deixe o botão azul' },
      ]),
    ];
    expect(sessionTopic(lines)).toBe('Deixe o botão azul');
    expect(sessionTopic([user('Olá, Ana. Leia sua memória e comece pela primeira tarefa da ficha.')])).toBeNull();
    // A saudação de versões antigas também.
    expect(sessionTopic([user('Olá, Luana. Leia sua ficha e sua memória e diga como pretende começar.')])).toBeNull();
  });

  it('corta texto longo numa linha só', () => {
    const topic = sessionTopic([user(`  ${'palavra '.repeat(30)}`)])!;
    expect(topic.length).toBe(80);
    expect(topic.endsWith('…')).toBe(true);
  });
});

describe('assunto: vale a última virada (cauda do transcript)', () => {
  it('sem virada, a 1ª mensagem sua continua valendo mesmo com cauda', () => {
    expect(sessionTopic([user('Primeira'), user('Segunda')], [user('Terceira?')])).toBe('Primeira');
  });

  it('uma tarefa puxada depois do começo vira o assunto', () => {
    expect(sessionTopic([user('Corrija o total')], [user('[Tarefa "Pedido em lote"] faça o CSV')])).toBe('Pedido em lote');
  });

  it('ponto de corte + nova pergunta: a pergunta vira o assunto', () => {
    const head = [user('Corrija o total'), assistant(`Feito.\n${CP}`)];
    expect(sessionTopic(head, [user('Agora, como exporto o CSV?')])).toBe('Agora, como exporto o CSV?');
  });

  it('ponto de corte + "ok": mantém o assunto anterior', () => {
    const head = [user('Corrija o total'), assistant(`Feito.\n${CP}`)];
    expect(sessionTopic(head, [user('ok')])).toBe('Corrija o total');
    expect(sessionTopic(head, [user('Ok, valeu! 👍')])).toBe('Corrija o total');
  });

  it('ponto de corte + pedido curto que não é confirmação: vira o assunto', () => {
    const head = [user('Corrija o total'), assistant(`Feito.\n${CP}`)];
    expect(sessionTopic(head, [user('Corrige o bug')])).toBe('Corrige o bug');
  });

  it('ponto de corte + "pode seguir" + pergunta: a pergunta, não a confirmação', () => {
    const head = [user('Corrija o total'), assistant(`Feito.\n${CP}`)];
    expect(sessionTopic(head, [user('pode seguir'), assistant('Seguindo.'), user('E o frete, como fica?')])).toBe('E o frete, como fica?');
  });

  it('o ponto de corte só vale na última linha da resposta', () => {
    const head = [user('Corrija o total'), assistant(`${CP}\nmais texto depois`)];
    expect(sessionTopic(head, [user('Agora, como exporto o CSV?')])).toBe('Corrija o total');
  });

  it('pula a mensagem injetada que vem antes da pergunta depois do ponto de corte', () => {
    const head = [user('Corrija o total'), assistant(CP)];
    const tail = [user([{ type: 'text', text: '[MyCo] Contexto desta conversa: 160k' }, { type: 'text', text: 'Como fica o frete?' }])];
    expect(sessionTopic(head, tail)).toBe('Como fica o frete?');
  });

  it('a tarefa mais recente vence um ponto de corte anterior, e o ponto de corte mais recente vence a tarefa', () => {
    expect(sessionTopic([user('Corrija o total'), assistant(CP)], [user('[Tarefa "Nova"] faça')])).toBe('Nova');
    expect(sessionTopic([user('[Tarefa "Antiga"] x'), assistant(CP)], [user('Estoque, como conto?')])).toBe('Estoque, como conto?');
  });

  it('arquivo pequeno (head e tail são o mesmo): não repete a cauda e acha a pergunta', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-topic-'));
    try {
      const rows = [user('Corrija o total'), assistant(`Feito.\n${CP}`), user('Como exporto o CSV?')];
      await fs.writeFile(path.join(dir, 's1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const [s] = await readProjectSessions(dir, new Map());
      expect(s?.topic).toBe('Como exporto o CSV?');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('arquivo grande: a virada está só na cauda e a janela do começo não a vê', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-topic-'));
    try {
      const filler = Array.from({ length: 200 }, () => assistant('x'.repeat(1000)));
      const withCut = [user('Corrija o total'), ...filler, assistant(`Feito.\n${CP}`), user('Como exporto o CSV?')];
      await fs.writeFile(path.join(dir, 'grande.jsonl'), withCut.map((r) => JSON.stringify(r)).join('\n') + '\n');
      expect((await readProjectSessions(dir, new Map())).find((s) => s.id === 'grande')?.topic).toBe('Como exporto o CSV?');

      // Sem virada na cauda: segue a 1ª mensagem, como antes.
      const plain = [user('Corrija o total'), ...filler, assistant('Feito.'), user('Mais uma coisa')];
      await fs.writeFile(path.join(dir, 'plano.jsonl'), plain.map((r) => JSON.stringify(r)).join('\n') + '\n');
      expect((await readProjectSessions(dir, new Map())).find((s) => s.id === 'plano')?.topic).toBe('Corrija o total');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
