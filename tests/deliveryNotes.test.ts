import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { DELIVERY_NOTE_MAX, DELIVERY_NOTES_MAX, DELIVERY_SUMMARY_MAX, fitDeliverySummary, parseDeliveryNotes, relativePath } from '../server/deliveryNotes';
import { TaskService } from '../server/tasks';
import { removeTemp } from './support/tmp';

describe('notas da entrega: parse', () => {
  it('lê uma linha por arquivo, com `:` ou travessão, e normaliza `\\` para `/`', () => {
    const text = [
      'Pronto. Mudei o botão.',
      '- `src/Botao.tsx`: troquei o token de cor pelo novo',
      '- `server\\rota.ts` — ajustei o status HTTP',
      'Testes: passaram.',
    ].join('\n');
    expect(parseDeliveryNotes(text)).toEqual({
      'src/Botao.tsx': 'troquei o token de cor pelo novo',
      'server/rota.ts': 'ajustei o status HTTP',
    });
  });

  it('descarta caminho absoluto, com `..`, com `~` ou com caractere proibido', () => {
    const text = [
      '- `/etc/passwd`: x',
      '- `C:\\Windows\\win.ini`: x',
      '- `\\\\servidor\\share\\a.ts`: x',
      '- `../fora.ts`: x',
      '- `src/../../fora.ts`: x',
      '- `~/.ssh/config`: x',
      '- `a<b>.ts`: x',
      '- `src/ok.ts`: entra',
    ].join('\n');
    expect(parseDeliveryNotes(text)).toEqual({ 'src/ok.ts': 'entra' });
    expect(parseDeliveryNotes('- `../fora.ts`: x')).toBeUndefined();
    expect(relativePath('./src//a.ts')).toBe('src/a.ts');
  });

  it('limita a nota a 200 caracteres, sem HTML, e a 50 entradas', () => {
    const long = 'x'.repeat(400);
    const notes = parseDeliveryNotes(`- \`a.ts\`: <b>${long}</b>`)!;
    expect(notes['a.ts']!.length).toBe(DELIVERY_NOTE_MAX);
    expect(notes['a.ts']).not.toMatch(/[<>]/);

    const many = Array.from({ length: 80 }, (_, i) => `- \`f${i}.ts\`: motivo ${i}`).join('\n');
    expect(Object.keys(parseDeliveryNotes(many)!)).toHaveLength(DELIVERY_NOTES_MAX);
  });

  it('sem lista (ou linha sem motivo) devolve undefined', () => {
    expect(parseDeliveryNotes('Fiz o botão. Testes passaram.')).toBeUndefined();
    expect(parseDeliveryNotes('- `src/a.ts`:   ')).toBeUndefined();
  });

  it('repetido fica a primeira vez; chave como `constructor` não quebra', () => {
    expect(parseDeliveryNotes('- `a.ts`: um\n- `a.ts`: dois\n- `constructor`: três')).toEqual({ 'a.ts': 'um', constructor: 'três' });
  });
});

describe('resumo da entrega: o corte', () => {
  const MARK = /\n… \(entrega cortada: (\d+) caracteres a mais\)$/;

  it('o teto é 2500, e o texto que cabe passa inteiro (só sem as pontas)', () => {
    expect(DELIVERY_SUMMARY_MAX).toBe(2500);
    expect(fitDeliverySummary('  Feito.\n')).toBe('Feito.');
    const exact = 'a'.repeat(DELIVERY_SUMMARY_MAX);
    expect(fitDeliverySummary(exact)).toBe(exact);
    expect(fitDeliverySummary(`${exact}b`)).toMatch(MARK);
  });

  it('passando do teto, corta em fim de linha: só linhas inteiras, a marca diz quanto saiu e tudo cabe no teto', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `${i + 1}. item ${'x'.repeat(40)}`);
    const full = lines.join('\n');
    const out = fitDeliverySummary(full);
    expect(out.length).toBeLessThanOrEqual(DELIVERY_SUMMARY_MAX);
    const m = MARK.exec(out)!;
    const kept = out.replace(MARK, '');
    expect(kept.split('\n').every((l) => lines.includes(l))).toBe(true);
    expect(full.startsWith(kept)).toBe(true);
    expect(Number(m[1])).toBe(full.length - kept.length);
    expect(out.length).toBeGreaterThan(DELIVERY_SUMMARY_MAX - 200); // aproveita o espaço: perde no máximo uma linha e a marca
  });

  it('o corte cai exato no fim de uma linha: a linha de antes fica, sem perder uma só', () => {
    const mark = (n: number) => `\n… (entrega cortada: ${n} caracteres a mais)`;
    const max = 100;
    const head = 'a'.repeat(100 - mark(150).length); // o que cabe junto da marca
    const full = `${head}\n${'b'.repeat(80)}`; // 150+ caracteres, e a quebra está logo depois de `head`
    const out = fitDeliverySummary(full, max);
    expect(out.startsWith(`${head}\n… (entrega cortada:`)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(max);
  });

  it('texto de uma linha só, longo: corta por palavra (nunca no meio dela), com a marca', () => {
    const words = Array.from({ length: 500 }, (_, i) => `palavra${i}`);
    const full = words.join(' ');
    const out = fitDeliverySummary(full);
    const kept = out.replace(MARK, '');
    expect(out).toMatch(MARK);
    expect(out.length).toBeLessThanOrEqual(DELIVERY_SUMMARY_MAX);
    expect(kept.split(' ').every((w) => words.includes(w))).toBe(true);
    expect(full.startsWith(`${kept} `)).toBe(true);
    expect(Number(MARK.exec(out)![1])).toBe(full.length - kept.length);
  });

  it('uma quebra logo no começo de um texto longo não esvazia o resumo: usa a palavra', () => {
    const full = `Feito.\n${Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ')}`;
    const kept = fitDeliverySummary(full).replace(MARK, '');
    expect(kept.length).toBeGreaterThan(DELIVERY_SUMMARY_MAX / 2);
  });

  it('sem nenhum espaço (um texto colado): corte seco no teto, sem partir um par substituto', () => {
    const blob = 'x'.repeat(5000);
    const out = fitDeliverySummary(blob);
    expect(out).toMatch(MARK);
    expect(out.length).toBeLessThanOrEqual(DELIVERY_SUMMARY_MAX);
    expect(out.length).toBeGreaterThan(DELIVERY_SUMMARY_MAX - 60);
    const emoji = '😀'.repeat(2000); // cada um ocupa 2 unidades
    const cut = fitDeliverySummary(emoji).replace(MARK, '');
    expect(cut).toBe('😀'.repeat(cut.length / 2));
  });

  it('cortar o que já foi cortado não muda nada (o aviso ao gestor passa o resumo gravado de novo)', () => {
    const once = fitDeliverySummary(Array.from({ length: 200 }, (_, i) => `linha ${i} ${'y'.repeat(30)}`).join('\n'));
    expect(fitDeliverySummary(once)).toBe(once);
  });
});

describe('notas da entrega: gravadas no Task', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-delivery-'));
  });
  afterAll(() => removeTemp(root));

  it('tarefa sem gestor também grava delivery (resumo cortado e notas)', async () => {
    const dir = path.join(root, 'sem-gestor');
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const reply = 'Botão pronto. ' + 'y'.repeat(2000) + '\n- `src/Botao.tsx`: novo token de cor';
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async () => 'sess-sg',
      branchFor: async () => null,
      lastText: () => reply,
    });
    const t = (await svc.create('p', { title: 'Botão', description: '', staffId: 'ana-1', reviewerId: null }))!;
    await svc.start('p', t.id);
    await svc.onTurnDone('sess-sg');

    const saved = (await svc.list('p'))![0]!;
    expect(saved.status).toBe('review');
    // 2051 caracteres: cabe no teto de 2500, então o resumo é a entrega inteira (o corte de 1500 a partia no meio).
    expect(reply.length).toBeLessThan(DELIVERY_SUMMARY_MAX);
    expect(saved.delivery).toMatchObject({ summary: reply.trim(), notes: { 'src/Botao.tsx': 'novo token de cor' } });
    expect(Date.parse(saved.delivery!.at)).not.toBeNaN();
  });

  it('entrega acima do teto: o resumo gravado é cortado em fim de linha, com a marca, e as notas vêm do texto inteiro', async () => {
    const dir = path.join(root, 'longa');
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const body = Array.from({ length: 80 }, (_, i) => `${i + 1}. feito: ${'w'.repeat(50)}`);
    const reply = [...body, '- `src/Fim.tsx`: está depois do corte'].join('\n');
    expect(reply.length).toBeGreaterThan(DELIVERY_SUMMARY_MAX);
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async () => 'sess-longa',
      branchFor: async () => null,
      lastText: () => reply,
    });
    const t = (await svc.create('p', { title: 'Botão', description: '', staffId: 'ana-1', reviewerId: null }))!;
    await svc.start('p', t.id);
    await svc.onTurnDone('sess-longa');

    const { summary, notes } = (await svc.list('p'))![0]!.delivery!;
    expect(summary.length).toBeLessThanOrEqual(DELIVERY_SUMMARY_MAX);
    expect(summary).toMatch(/\n… \(entrega cortada: \d+ caracteres a mais\)$/);
    const shown = summary.replace(/\n… \(entrega cortada: \d+ caracteres a mais\)$/, '');
    expect(body.join('\n').startsWith(shown)).toBe(true);
    expect(body).toContain(shown.split('\n').at(-1)); // a última linha que ficou está inteira
    expect(notes).toEqual({ 'src/Fim.tsx': 'está depois do corte' });
  });

  it('com gestor, a entrega também fica no Task; sem lista, sem `notes`', async () => {
    const dir = path.join(root, 'com-gestor');
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'lu-1': { id: 'lu-1', name: 'Luana', role: 'Front-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async () => 's-cg',
      branchFor: async () => null,
      notify: async () => {},
      lastText: () => 'Pronto, sem arquivos novos.',
    });
    const t = (await svc.create('p', { title: 'Ajuste', description: '', staffId: 'lu-1', reviewerId: null }, 'gio-1'))!;
    await svc.start('p', t.id);
    await svc.onTurnDone('s-cg');

    const saved = (await svc.list('p'))![0]!;
    expect(saved.delivery).toEqual({ at: expect.any(String), summary: 'Pronto, sem arquivos novos.' });
    expect(saved.delivery).not.toHaveProperty('notes');
  });
});
