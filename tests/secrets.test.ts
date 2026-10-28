import { describe, expect, it } from 'vitest';
import { findSecret } from '../server/chat/secrets';
import { TurnWatcher } from '../server/turns';
import type { LiveSession } from '../shared/model';

/** Texto com cara de chave aleatória, gerado na hora (16 caracteres que se alternam fora de ordem). */
const noise = (n: number) => Array.from({ length: n }, (_, i) => 'q7Xz2LmP9wKd4RtB'[(i * 7) % 16]).join('');

describe('guarda de segredos', () => {
  it('reconhece senha em comando, chaves e tokens conhecidos', () => {
    expect(findSecret('mysql -uroot -ps3nh4fict1ca app')?.label).toBe('uma senha');
    expect(findSecret('docker run -e MYSQL_ROOT_PASSWORD=Sup3rSecreta mysql')?.label).toBe('uma senha');
    expect(findSecret('DATABASE_URL=postgres://app:s3nh4forte@db:5432/app')?.label).toBe('uma senha numa URL de conexão');
    // Montadas na hora: o arquivo não tem nada com cara de chave real (o GitHub barraria o push, e um
    // funcionário que lesse este arquivo dispararia a guarda).
    expect(findSecret(`use a chave ${'sk-ant-'}api03-${noise(28)}`)?.label).toBe('uma chave da API da Anthropic');
    expect(findSecret(`token ${'ghp'}_${noise(36)}`)?.label).toBe('um token do GitHub');
    expect(findSecret(`-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\nb3Bl...`)?.label).toBe('uma chave privada');
  });

  it('chave com cara de teste não é segredo; a de verdade no mesmo texto ainda é', () => {
    expect(findSecret(`${'sk-ant-'}api03-${'A'.repeat(28)}`)).toBeNull();
    expect(findSecret(`${'ghp'}_${'abcdefghijklmnopqrstuvwxyz0123456789'}`)).toBeNull();
    expect(findSecret(`${'AKIA'}IOSFODNN7EXAMPLE`)).toBeNull(); // o exemplo da documentação da AWS
    expect(findSecret(`${'ghp'}_${'a'.repeat(36)} e ${'ghp'}_${noise(36)}`)?.label).toBe('um token do GitHub');
    // Senha não passa por esse filtro: senha fraca continua sendo senha.
    expect(findSecret('DB_PASSWORD=aaaaaaaa')?.label).toBe('uma senha');
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
