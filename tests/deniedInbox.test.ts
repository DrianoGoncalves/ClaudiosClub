import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../shared/model';
import { api } from '../client/src/api';
import staffMessages from '../client/src/i18n/staff';
import { deniedAction, deniedOf, deniedText } from '../client/src/inbox/deniedAlert';
import { inboxText } from '../client/src/inbox/inboxText';
import type { Tr } from '../client/src/inbox/secretText';
import { dismissCall } from '../client/src/inbox/useInbox';

// Alerta "ação barrada" na caixa (kind `denied`, contrato em `InboxItem.denied`): a frase sai da estrutura no idioma da página, o atalho segue a dica e o
// Ignorar chama a rota própria do servidor com o id inteiro.

type Denied = NonNullable<InboxItem['denied']>;

const denied = (over: Partial<Denied> = {}): Denied => ({
  taskId: 't-abc123',
  taskTitle: 'Publicar o site',
  tool: 'Bash',
  layer: 'classifier',
  reason: 'Production Deploy',
  hint: 'autonomy',
  text: 'texto do servidor',
  count: 1,
  tools: ['Bash'],
  ...over,
});

const item = (d: Partial<Denied> = {}, over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'denied:s1:turn1',
  kind: 'denied',
  projectId: 'p1',
  projectName: 'Loja',
  sessionId: 's1',
  staffId: 'jinx',
  name: 'Jinx',
  summary: 'resumo do servidor',
  at: '2026-11-18T10:00:00.000Z',
  denied: denied(d),
  ...over,
});

/** `t()` de um idioma só, sem recarregar a página: o mesmo troca de `{nome}` do `t` real. */
const trFor =
  (lang: 'pt-BR' | 'en' | 'es'): Tr =>
  (key, vars) => {
    const text = (staffMessages[lang] as Record<string, string>)[key] ?? key;
    return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
  };

describe('frase do item "ação barrada" por camada', () => {
  const tr = trFor('pt-BR');

  it('classificador do Autônomo: ferramenta, motivo e a tarefa', () => {
    expect(deniedText(item(), tr)).toBe('“Publicar o site”: Bash barrado pelo classificador do Claude Code (modo Autônomo): Production Deploy.');
  });

  it('sem motivo informado, diz que não veio', () => {
    expect(deniedText(item({ reason: undefined }), tr)).toContain('sem motivo informado');
  });

  it('cada camada tem a sua frase (club com e sem SSH, safety, settings, sandbox do Codex, outra, classificador sem resposta)', () => {
    const text = (d: Partial<Denied>) => deniedText(item(d), tr);
    expect(text({ layer: 'club', hint: 'servers', reason: undefined })).toContain('a ficha não tem conexão SSH');
    expect(text({ layer: 'club', hint: null, reason: undefined })).toContain('arquivo protegido (segredo ou chave)');
    expect(text({ layer: 'safety', hint: null, reason: 'caminho do sistema' })).toContain('checagem de segurança do Claude Code: caminho do sistema');
    expect(text({ layer: 'safety', hint: null, reason: undefined })).toContain('caminho protegido');
    expect(text({ layer: 'settings', tool: 'Edit', hint: null, reason: undefined })).toContain('Edit bloqueado: arquivo ou pasta negado nas regras de permissão');
    expect(text({ layer: 'sandbox', hint: 'autonomy', reason: undefined })).toContain('sandbox do Codex: a conversa roda só com leitura');
    expect(text({ layer: 'sandbox', hint: null, reason: undefined })).toContain('fora da pasta de trabalho');
    expect(text({ layer: 'other', hint: null, reason: 'sem rede' })).toContain('Bash: permissão negada (sem rede)');
    expect(text({ layer: 'other', hint: null, reason: undefined })).toContain('Bash: permissão negada');
    expect(text({ layer: 'classifierError', hint: 'retry', reason: undefined })).toContain('não respondeu; vale tentar de novo');
  });

  it('várias negações no turno: "(+N neste turno)"; uma só, nada', () => {
    expect(deniedText(item({ count: 3 }), tr)).toMatch(/ \(\+2 neste turno\)$/);
    expect(deniedText(item({ count: 1 }), tr)).not.toContain('neste turno');
  });

  it('camada que a tela não conhece (servidor mais novo): cai no texto do servidor; sem `denied`, no resumo', () => {
    expect(deniedText(item({ layer: 'futura' as never }), tr)).toBe('“Publicar o site”: texto do servidor');
    expect(deniedText({ kind: 'denied', summary: 'resumo do servidor' }, tr)).toBe('resumo do servidor');
  });

  it('é o texto do item na lista e na notificação (inboxText), e só para o kind `denied`', () => {
    expect(inboxText(item())).toContain('barrado pelo classificador');
    expect(inboxText(item({}, { kind: 'error' }))).toBe('resumo do servidor');
    expect(deniedOf(item({}, { kind: 'error' }))).toBeNull();
  });

  it('en e es traduzem a frase inteira, com a tarefa e a ferramenta, e sem variável solta', () => {
    for (const layer of ['classifier', 'classifierError', 'club', 'safety', 'settings', 'sandbox', 'other'] as const) {
      const pt = deniedText(item({ layer, count: 2 }), tr);
      for (const lang of ['en', 'es'] as const) {
        const text = deniedText(item({ layer, count: 2 }), trFor(lang));
        expect(text, `${lang} ${layer}`).not.toBe(pt);
        expect(text).toContain('“Publicar o site”');
        expect(text).toContain('Bash');
        expect(text).not.toMatch(/\{\w+\}/);
        expect(text).not.toContain('inbox.denied');
      }
    }
    expect(deniedText(item({ count: 2 }), trFor('en'))).toMatch(/\(\+1 in this turn\)$/);
    expect(deniedText(item({ count: 2 }), trFor('es'))).toMatch(/\(\+1 en este turno\)$/);
  });
});

describe('atalho de destrave pela dica', () => {
  const tr = trFor('pt-BR');

  it('autonomia e servidores levam à ficha; tentar de novo abre a conversa', () => {
    expect(deniedAction(item({ hint: 'autonomy' }), tr)).toMatchObject({ to: 'sheet', label: 'Ajustar autonomia' });
    expect(deniedAction(item({ hint: 'servers' }), tr)).toMatchObject({ to: 'sheet', label: 'Dar acesso a servidores' });
    expect(deniedAction(item({ hint: 'retry' }), tr)).toMatchObject({ to: 'chat', label: 'Abrir a conversa' });
  });

  it('sem dica: sem atalho; dica que a tela não conhece também', () => {
    expect(deniedAction(item({ hint: null }), tr)).toBeNull();
    expect(deniedAction(item({ hint: 'mcp' as never }), tr)).toBeNull();
  });

  it('conversa sem ficha: autonomia e servidores não têm onde ir (o clique no item já abre a conversa); tentar de novo segue', () => {
    expect(deniedAction(item({ hint: 'autonomy' }, { staffId: null }), tr)).toBeNull();
    expect(deniedAction(item({ hint: 'servers' }, { staffId: null }), tr)).toBeNull();
    expect(deniedAction(item({ hint: 'retry' }, { staffId: null }), tr)).toMatchObject({ to: 'chat' });
  });

  it('outro tipo de item não ganha atalho; todo rótulo e título existe nos 3 idiomas', () => {
    expect(deniedAction(item({}, { kind: 'error' }), tr)).toBeNull();
    for (const lang of ['pt-BR', 'en', 'es'] as const) {
      for (const hint of ['autonomy', 'servers', 'retry'] as const) {
        const a = deniedAction(item({ hint }), trFor(lang))!;
        expect(a.label).toBeTruthy();
        expect(a.label).not.toContain('inbox.denied');
        expect(a.title).not.toContain('inbox.denied');
      }
    }
  });
});

describe('Ignorar', () => {
  it('chama a rota de ação barrada com o id inteiro (`denied:<sessão>:<turno>`), e nenhuma das outras', async () => {
    const calls: string[] = [];
    const names = ['dismissDenied', 'dismissError', 'dismissSecret', 'dismissRoutineAlert', 'dismissQuestion', 'dismissWaiting'] as const;
    const slots = api as unknown as Record<string, unknown>;
    const original = Object.fromEntries(names.map((n) => [n, slots[n]]));
    for (const name of names) slots[name] = async (...a: unknown[]) => (calls.push(`${name}:${a.join(',')}`), { ok: true });
    try {
      await dismissCall(item());
    } finally {
      Object.assign(slots, original);
    }
    expect(calls).toEqual(['dismissDenied:denied:s1:turn1']);
  });
});
