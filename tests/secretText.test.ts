import { describe, expect, it } from 'vitest';
import staff from '../client/src/i18n/staff';
import { secretText, type Tr } from '../client/src/inbox/secretText';
import { findSecret, secretAlert } from '../server/chat/secrets';
import type { InboxItem, SecretSource } from '../shared/model';

type Locale = 'pt-BR' | 'en' | 'es';

/** Mesma troca de `{nome}` do `t()`, sobre o dicionário de cada idioma (o `t()` usa o idioma da página). */
const tr = (locale: Locale): Tr => (key, vars) => {
  const text = (staff[locale] as Record<string, string>)[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
};

const item = (secret: InboxItem['secret'], summary = 'Resumo em pt-BR'): Pick<InboxItem, 'summary' | 'secret'> => ({ summary, secret });

const cases: Array<{ name: string; secret: NonNullable<InboxItem['secret']>; 'pt-BR': string; en: string; es: string }> = [
  {
    name: 'chave privada, com origem na saída de um comando',
    secret: { kind: 'private-key', source: 'tool-result' },
    'pt-BR': 'Chave privada apareceu na saída de um comando: troque e não cole segredos na conversa',
    en: 'Private key appeared in a command’s output: change it and don’t paste secrets into the conversation',
    es: 'Clave privada apareció en la salida de un comando: cámbialo y no pegues secretos en la conversación',
  },
  {
    name: 'token do GitHub, com origem na resposta do funcionário',
    secret: { kind: 'api-key', detail: 'github', source: 'staff-reply' },
    'pt-BR': 'Token do GitHub apareceu na resposta do funcionário: troque e não cole segredos na conversa',
    en: 'GitHub token appeared in the staff member’s reply: change it and don’t paste secrets into the conversation',
    es: 'Token de GitHub apareció en la respuesta del empleado: cámbialo y no pegues secretos en la conversación',
  },
  {
    name: 'chave da Anthropic, sem origem (diz "no chat")',
    secret: { kind: 'api-key', detail: 'anthropic' },
    'pt-BR': 'Chave de API da Anthropic apareceu no chat: troque e não cole segredos na conversa',
    en: 'Anthropic API key appeared in the chat: change it and don’t paste secrets into the conversation',
    es: 'Clave de API de Anthropic apareció en el chat: cámbialo y no pegues secretos en la conversación',
  },
  {
    name: 'chave de API sem provedor conhecido (fallback genérico)',
    secret: { kind: 'api-key', source: 'owner' },
    'pt-BR': 'Chave de API apareceu na sua mensagem: troque e não cole segredos na conversa',
    en: 'API key appeared in your message: change it and don’t paste secrets into the conversation',
    es: 'Clave de API apareció en tu mensaje: cámbialo y no pegues secretos en la conversación',
  },
  {
    name: 'senha no comando mysql, com origem no comando que o funcionário rodou',
    secret: { kind: 'password-cli', detail: 'mysql', source: 'tool-input' },
    'pt-BR': 'Senha no comando mysql (-p) apareceu no comando que o funcionário rodou: troque e não cole segredos na conversa',
    en: 'Password in the mysql command (-p) appeared in the command the staff member ran: change it and don’t paste secrets into the conversation',
    es: 'Contraseña en el comando mysql (-p) apareció en el comando que ejecutó el empleado: cámbialo y no pegues secretos en la conversación',
  },
  {
    name: 'senha em --password, com origem na sua mensagem',
    secret: { kind: 'password-cli', source: 'owner' },
    'pt-BR': 'Senha em --password apareceu na sua mensagem: troque e não cole segredos na conversa',
    en: 'Password in --password appeared in your message: change it and don’t paste secrets into the conversation',
    es: 'Contraseña en --password apareció en tu mensaje: cámbialo y no pegues secretos en la conversación',
  },
  {
    name: 'senha na variável DB_PASSWORD, com origem na sua mensagem (o exemplo do pedido)',
    secret: { kind: 'password-env', detail: 'DB_PASSWORD', source: 'owner' },
    'pt-BR': 'Senha na variável DB_PASSWORD apareceu na sua mensagem: troque e não cole segredos na conversa',
    en: 'Password in variable DB_PASSWORD appeared in your message: change it and don’t paste secrets into the conversation',
    es: 'Contraseña en la variable DB_PASSWORD apareció en tu mensaje: cámbialo y no pegues secretos en la conversación',
  },
  {
    name: 'senha numa variável sem nome válido, com origem na saída de um comando',
    secret: { kind: 'password-env', source: 'tool-result' },
    'pt-BR': 'Senha numa variável de ambiente apareceu na saída de um comando: troque e não cole segredos na conversa',
    en: 'Password in an environment variable appeared in a command’s output: change it and don’t paste secrets into the conversation',
    es: 'Contraseña en una variable de entorno apareció en la salida de un comando: cámbialo y no pegues secretos en la conversación',
  },
  {
    name: 'senha numa URL de conexão, com host e origem na sua mensagem',
    secret: { kind: 'password-url', detail: 'db:5432', source: 'owner' },
    'pt-BR': 'Senha numa URL de conexão (host db:5432) apareceu na sua mensagem: troque e não cole segredos na conversa',
    en: 'Password in a connection URL (host db:5432) appeared in your message: change it and don’t paste secrets into the conversation',
    es: 'Contraseña en una URL de conexión (host db:5432) apareció en tu mensaje: cámbialo y no pegues secretos en la conversación',
  },
  {
    name: 'senha numa URL de conexão, sem host e sem origem',
    secret: { kind: 'password-url' },
    'pt-BR': 'Senha numa URL de conexão apareceu no chat: troque e não cole segredos na conversa',
    en: 'Password in a connection URL appeared in the chat: change it and don’t paste secrets into the conversation',
    es: 'Contraseña en una URL de conexión apareció en el chat: cámbialo y no pegues secretos en la conversación',
  },
];

describe('secretText: frase do aviso no idioma da página', () => {
  for (const c of cases) {
    it(`${c.name}`, () => {
      expect(secretText(item(c.secret), tr('pt-BR'))).toBe(c['pt-BR']);
      expect(secretText(item(c.secret), tr('en'))).toBe(c.en);
      expect(secretText(item(c.secret), tr('es'))).toBe(c.es);
    });
  }

  it('sem `secret` (servidor antigo), vale o summary em pt-BR', () => {
    expect(secretText({ summary: 'Chave privada apareceu no chat: troque e não cole segredos na conversa' }, tr('en'))).toBe(
      'Chave privada apareceu no chat: troque e não cole segredos na conversa',
    );
  });

  it('a origem só muda a parte "onde apareceu"', () => {
    const sources: Array<[SecretSource | undefined, string]> = [
      ['owner', 'na sua mensagem'],
      ['staff-reply', 'na resposta do funcionário'],
      ['tool-input', 'no comando que o funcionário rodou'],
      ['tool-result', 'na saída de um comando'],
      [undefined, 'no chat'],
    ];
    for (const [source, onde] of sources) {
      expect(secretText(item({ kind: 'private-key', ...(source && { source }) }), tr('pt-BR'))).toContain(` apareceu ${onde}: `);
    }
  });
});

describe('secretText: o valor do segredo nunca aparece na frase', () => {
  // Montados na hora (nada de chave real no repositório). Para cada tipo, o valor que não pode vazar.
  const noise = (n: number) => Array.from({ length: n }, (_, i) => 'q7Xz2LmP9wKd4RtB'[(i * 7) % 16]).join('');
  const samples: Array<[string, string, string[]]> = [
    ['private-key', `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\nb3Bl...`, ['b3Bl']],
    ['api-key', `use ${'sk-ant-'}api03-${noise(28)}`, [noise(28)]],
    ['password-cli', 'mysql -uroot -pS3nh4Forte app', ['S3nh4Forte']],
    ['password-cli', 'lftp --password=S3nh4fict1ca ftp.exemplo.com', ['S3nh4fict1ca']],
    ['password-env', 'MY_DB_PASSWORD=s3nhaF0rte', ['s3nhaF0rte']],
    ['password-url', 'DATABASE_URL=postgres://usuarioSecreto:S3nh4fict1ca@127.0.0.1:54329/app', ['usuarioSecreto', 'S3nh4fict1ca']],
  ];
  for (const [kind, text, valores] of samples) {
    it(`${kind}: frase (pt, en, es) e rótulo sem o valor`, () => {
      const hit = findSecret(text);
      expect(hit?.kind).toBe(kind);
      for (const source of ['owner', 'tool-input', undefined] as const) {
        const secret = { kind: hit!.kind, ...(hit!.detail && { detail: hit!.detail }), ...(source && { source }) };
        for (const locale of ['pt-BR', 'en', 'es'] as const) {
          const frase = secretText(item(secret), tr(locale));
          for (const v of valores) expect(frase).not.toContain(v);
        }
      }
      expect(JSON.stringify(hit)).not.toContain(valores[0]!);
      expect(secretAlert(hit!.label, 'owner')).not.toContain(valores[0]!);
    });
  }
});
