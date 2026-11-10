import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { DELIVERY_NOTE_MAX, DELIVERY_NOTES_MAX, parseDeliveryNotes, relativePath } from '../server/deliveryNotes';
import { TaskService } from '../server/tasks';

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

describe('notas da entrega: gravadas no Task', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-delivery-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

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
    expect(saved.delivery).toMatchObject({ summary: reply.trim().slice(0, 1500), notes: { 'src/Botao.tsx': 'novo token de cor' } });
    expect(saved.delivery!.summary.length).toBe(1500);
    expect(Date.parse(saved.delivery!.at)).not.toBeNaN();
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
