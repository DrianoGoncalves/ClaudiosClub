import { describe, expect, it } from 'vitest';
import type { AskedQuestion, ChatItem } from '../shared/model';
import { permissionInboxItem, questionInboxItem } from '../server/inboxItems';

const place = { projectId: 'p', projectName: 'Projeto', sessionId: 'sx', staffId: 'ana', name: 'Ana' };
type Permission = Extract<ChatItem, { kind: 'permission' }>;
const card = (over: Partial<Permission> = {}): Permission => ({
  kind: 'permission',
  id: 'p:r1',
  tool: 'Bash',
  summary: 'npm test',
  description: null,
  input: '{}',
  status: 'pending',
  at: '2026-10-30T10:00:00Z',
  ...over,
});

describe('aviso da caixa que leva ao ponto da conversa', () => {
  it('pergunta com opções: diz que é pergunta e mostra o texto dela', () => {
    const q: AskedQuestion = { question: 'Qual banco?', header: 'Banco', kind: 'choice', multiSelect: false, options: [{ label: 'SQLite', description: '' }] };
    expect(permissionInboxItem(card({ tool: 'AskUserQuestion', summary: 'Qual banco?', questions: [q] }), place)).toMatchObject({
      kind: 'permission',
      summary: 'pergunta para você: Qual banco?',
      itemId: 'p:r1',
    });
  });

  it('permissão: o alvo é o cartão dela', () => {
    expect(permissionInboxItem(card(), place)).toEqual({
      ...place,
      id: 'perm:p:r1',
      kind: 'permission',
      summary: 'Bash npm test',
      at: '2026-10-30T10:00:00Z',
      itemId: 'p:r1',
    });
  });

  it('plano: o alvo é o cartão do plano', () => {
    expect(permissionInboxItem(card({ id: 'p:r2', tool: 'ExitPlanMode', plan: '# Plano' }), place)).toMatchObject({
      kind: 'plan',
      summary: 'plano pronto para aprovar',
      itemId: 'p:r2',
    });
  });

  it('pergunta: o alvo é o balão da resposta, e a pergunta vai junto para achar o trecho', () => {
    const q = { sessionId: 'sx', text: '3. O ajuste do item 5 fica para depois?', at: '2026-10-30T10:05:00Z', itemId: 'a:m1' };
    expect(questionInboxItem(q, place)).toEqual({
      ...place,
      id: 'question:sx:2026-10-30T10:05:00Z',
      kind: 'waiting',
      summary: 'perguntou: 3. O ajuste do item 5 fica para depois?',
      at: '2026-10-30T10:05:00Z',
      itemId: 'a:m1',
      quote: '3. O ajuste do item 5 fica para depois?',
    });
  });

  it('pergunta lembrada sem o balão (de antes desta versão): só a pergunta', () => {
    const item = questionInboxItem({ sessionId: 'sx', text: 'Faço o commit?', at: '2026-10-30T10:05:00Z' }, place);
    expect(item.quote).toBe('Faço o commit?');
    expect('itemId' in item).toBe(false);
  });
});
