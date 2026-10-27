import { describe, expect, it } from 'vitest';
import { findSecret } from '../server/chat/secrets';
import { TurnWatcher } from '../server/turns';
import type { LiveSession } from '../shared/model';

describe('guarda de segredos', () => {
  it('reconhece senha em comando, chaves e tokens conhecidos', () => {
    expect(findSecret('mysql -uroot -ps3nh4fict1ca app')?.label).toBe('uma senha');
    expect(findSecret('docker run -e MYSQL_ROOT_PASSWORD=Sup3rSecreta mysql')?.label).toBe('uma senha');
    expect(findSecret('DATABASE_URL=postgres://app:s3nh4forte@db:5432/app')?.label).toBe('uma senha numa URL de conexão');
    // Montadas por partes: o arquivo não tem nada com cara de chave real (o GitHub barraria o push).
    expect(findSecret(`use a chave ${'sk-ant-'}api03-${'A'.repeat(28)}`)?.label).toBe('uma chave da API da Anthropic');
    expect(findSecret(`token ${'ghp'}_${'a'.repeat(36)}`)?.label).toBe('um token do GitHub');
    expect(findSecret(`-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\nb3Bl...`)?.label).toBe('uma chave privada');
  });

  it('não acusa placeholders, variáveis nem texto comum', () => {
    expect(findSecret('mysql -uroot -p app')).toBeNull(); // pede a senha no terminal
    expect(findSecret('mysql -uroot -p"$DB_PASS" app')).toBeNull();
    expect(findSecret('PASSWORD=${DB_PASSWORD}')).toBeNull();
    expect(findSecret('DB_PASSWORD=<sua senha>')).toBeNull();
    expect(findSecret('postgres://user:${PASS}@db/app')).toBeNull();
    expect(findSecret('A senha precisa ter 8 caracteres.')).toBeNull();
  });
});

describe('aviso "terminou"', () => {
  const live = (status: string): LiveSession[] => [
    { sessionId: 's1', pid: 1, cwd: null, name: null, status: status as LiveSession['status'], alive: true, entrypoint: 'cli', kind: null, startedAt: null, statusUpdatedAt: null },
  ];

  it('registra a passagem de trabalhando para parado, com o começo da resposta', async () => {
    let now = live('busy');
    const w = new TurnWatcher(async () => now, () => '**Pronto.** Corrigi o layout.\nDetalhes…');
    await w.tick(new Date('2026-10-26T10:00:00Z'));
    now = live('idle');
    await w.tick(new Date('2026-10-26T10:00:05Z'));
    expect(w.since('2026-10-26T09:59:00Z')).toEqual([
      expect.objectContaining({ sessionId: 's1', at: '2026-10-26T10:00:05.000Z', text: 'Pronto. Corrigi o layout.' }),
    ]);
    expect(w.since('2026-10-26T10:00:05.000Z')).toEqual([]);
  });

  it('esperar você (waiting) não é terminar; sem "since" não devolve nada', async () => {
    let now = live('busy');
    const w = new TurnWatcher(async () => now, () => null);
    await w.tick();
    now = live('waiting');
    await w.tick();
    expect(w.since('2000-01-01T00:00:00Z')).toEqual([]);
    expect(w.since(null)).toEqual([]);
  });
});
