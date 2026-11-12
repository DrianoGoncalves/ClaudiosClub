import { describe, expect, it } from 'vitest';
import { findSecret, findSecrets, legacyLabel, secretAlert } from '../server/chat/secrets';
import { TurnWatcher } from '../server/turns';
import type { LiveSession } from '../shared/model';

/** Texto com cara de chave aleatória, gerado na hora (16 caracteres que se alternam fora de ordem). */
const noise = (n: number) => Array.from({ length: n }, (_, i) => 'q7Xz2LmP9wKd4RtB'[(i * 7) % 16]).join('');

describe('guarda de segredos', () => {
  it('reconhece senha em comando, chaves e tokens conhecidos', () => {
    expect(findSecret('mysql -uroot -ps3nh4fict1ca app')?.label).toBe('senha no comando mysql (-p)');
    expect(findSecret('docker run -e MYSQL_ROOT_PASSWORD=Sup3rSecreta mysql')?.label).toBe('senha na variável MYSQL_ROOT_PASSWORD');
    expect(findSecret('DATABASE_URL=postgres://app:s3nh4forte@db:5432/app')?.label).toBe('senha numa URL de conexão (host db:5432)');
    // Montadas na hora: o arquivo não tem nada com cara de chave real (o GitHub barraria o push, e um
    // funcionário que lesse este arquivo dispararia a guarda).
    expect(findSecret(`use a chave ${'sk-ant-'}api03-${noise(28)}`)?.label).toBe('chave de API da Anthropic');
    expect(findSecret(`token ${'ghp'}_${noise(36)}`)?.label).toBe('token do GitHub');
    expect(findSecret(`-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\nb3Bl...`)?.label).toBe('chave privada');
  });

  it('chave com cara de teste não é segredo; a de verdade no mesmo texto ainda é', () => {
    expect(findSecret(`${'sk-ant-'}api03-${'A'.repeat(28)}`)).toBeNull();
    expect(findSecret(`${'ghp'}_${'abcdefghijklmnopqrstuvwxyz0123456789'}`)).toBeNull();
    expect(findSecret(`${'AKIA'}IOSFODNN7EXAMPLE`)).toBeNull(); // o exemplo da documentação da AWS
    expect(findSecret(`${'ghp'}_${'a'.repeat(36)} e ${'ghp'}_${noise(36)}`)?.label).toBe('token do GitHub');
    // Senha não passa por esse filtro: senha fraca continua sendo senha.
    expect(findSecret('DB_PASSWORD=aaaaaaaa')?.label).toBe('senha na variável DB_PASSWORD');
  });

  it('não acusa placeholders, variáveis nem texto comum', () => {
    expect(findSecret('mysql -uroot -p app')).toBeNull(); // pede a senha no terminal
    expect(findSecret('mysql -uroot -p"$DB_PASS" app')).toBeNull();
    expect(findSecret('PASSWORD=${DB_PASSWORD}')).toBeNull();
    expect(findSecret('DB_PASSWORD=<sua senha>')).toBeNull();
    expect(findSecret('postgres://user:${PASS}@db/app')).toBeNull();
    expect(findSecret('A senha precisa ter 8 caracteres.')).toBeNull();
  });

  it('findSecrets devolve todas as ocorrências, com posição, e não muda o findSecret', () => {
    const text = `${'sk-ant-'}api03-${noise(28)} e depois ${'ghp'}_${noise(36)}`;
    const hits = findSecrets(text);
    expect(hits.map((h) => h.label)).toEqual(['chave de API da Anthropic', 'token do GitHub']);
    expect(hits[0]!.index).toBe(0);
    expect(hits[1]!.index).toBe(text.indexOf('ghp'));
    expect(text.slice(hits[1]!.index, hits[1]!.index + hits[1]!.length)).toBe(`${'ghp'}_${noise(36)}`);
    // Chamar de novo acha o mesmo: nenhum `lastIndex` ficou no meio.
    expect(findSecrets(text)).toEqual(hits);
    expect(findSecrets('mysql -uroot -p app')).toEqual([]);
  });
});

describe('rótulo: diz o tipo e o contexto, nunca o valor', () => {
  it('cada tipo tem o seu kind e o rótulo com o contexto', () => {
    expect(findSecret(`-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\nb3Bl...`)).toEqual({ kind: 'private-key', label: 'chave privada' });
    expect(findSecret(`use ${'sk-ant-'}api03-${noise(28)}`)).toEqual({ kind: 'api-key', label: 'chave de API da Anthropic', detail: 'anthropic' });
    expect(findSecret('mariadb -uroot -pS3nh4fict1ca app')).toEqual({ kind: 'password-cli', label: 'senha no comando mariadb (-p)', detail: 'mariadb' });
    expect(findSecret('lftp --password=S3nh4fict1ca ftp.exemplo.com')).toEqual({ kind: 'password-cli', label: 'senha em --password' });
    expect(findSecret('DB_PASSWORD=S3nh4fict1ca')).toEqual({ kind: 'password-env', label: 'senha na variável DB_PASSWORD', detail: 'DB_PASSWORD' });
    expect(findSecret('DATABASE_URL=postgres://app:S3nh4fict1ca@127.0.0.1:54329/app')).toEqual({
      kind: 'password-url',
      label: 'senha numa URL de conexão (host 127.0.0.1:54329)',
      detail: '127.0.0.1:54329',
    });
  });

  it('o valor (e o usuário da URL) nunca aparece no rótulo', () => {
    const casos: Array<[string, string[]]> = [
      ['mysql -uroot -pS3nh4fict1ca app', ['S3nh4fict1ca']],
      ['docker run -e MYSQL_ROOT_PASSWORD=Sup3rSecreta mysql', ['Sup3rSecreta']],
      ['DATABASE_URL=postgres://usuarioSecreto:S3nh4fict1ca@db:5432/app', ['usuarioSecreto', 'S3nh4fict1ca']],
      ['lftp --password=S3nh4fict1ca ftp.exemplo.com', ['S3nh4fict1ca']],
    ];
    for (const [texto, valores] of casos) {
      const hit = findSecret(texto);
      expect(hit).not.toBeNull();
      for (const v of valores) expect(hit!.label).not.toContain(v);
    }
  });

  it('o host da URL só entra se for host de verdade; senão a URL fica genérica', () => {
    expect(findSecret('postgres://app:S3nh4fict1ca@db$ruim/app')?.label).toBe('senha numa URL de conexão');
    expect(findSecret('url="postgres://app:S3nh4fict1ca@db:5432"')?.label).toBe('senha numa URL de conexão (host db:5432)');
  });

  it('o aviso junta o rótulo e a origem; sem origem diz "no chat"', () => {
    expect(secretAlert('senha no comando mysql (-p)', 'tool-input')).toBe(
      'Senha no comando mysql (-p) apareceu no comando que o funcionário rodou: troque e não cole segredos na conversa',
    );
    expect(secretAlert('senha na variável DB_PASSWORD', 'owner')).toBe(
      'Senha na variável DB_PASSWORD apareceu na sua mensagem: troque e não cole segredos na conversa',
    );
    expect(secretAlert('chave privada', 'tool-result')).toBe('Chave privada apareceu na saída de um comando: troque e não cole segredos na conversa');
    expect(secretAlert('token do GitHub', 'staff-reply')).toBe('Token do GitHub apareceu na resposta do funcionário: troque e não cole segredos na conversa');
    expect(secretAlert('chave privada')).toBe('Chave privada apareceu no chat: troque e não cole segredos na conversa');
  });
});

describe('variável com prefixo (MY_DB_PASSWORD=…), só no formato .env/shell', () => {
  it('pega o nome completo da variável', () => {
    expect(findSecret('MY_DB_PASSWORD=s3nhaF0rte')).toEqual({ kind: 'password-env', label: 'senha na variável MY_DB_PASSWORD', detail: 'MY_DB_PASSWORD' });
    expect(findSecret('DATABASE_PASSWORD=s3nhaF0rte')?.label).toBe('senha na variável DATABASE_PASSWORD');
    expect(findSecret('SMTP_PASSWORD="s3nhaF0rte"')?.label).toBe('senha na variável SMTP_PASSWORD');
    expect(findSecret("docker run -e APP_DB_PASS='s3nhaF0rte' app")?.label).toBe('senha na variável APP_DB_PASS');
  });

  it('não acusa nome de chave de i18n/constante, nem PASS sozinho, nem valor com espaço', () => {
    expect(findSecret("FORGOT_PASSWORD: 'Esqueci a senha'")).toBeNull();
    expect(findSecret('RESET_PASSWORD_LABEL=Redefinir senha')).toBeNull();
    expect(findSecret('PASSWORD_MIN_LENGTH=12')).toBeNull();
    expect(findSecret('MY_PASS=s3nhaF0rte')).toBeNull();
    expect(findSecret("MY_DB_PASSWORD = 'Esqueci a senha'")).toBeNull();
  });

  it('placeholders continuam fora', () => {
    for (const v of ['$X', '<senha>', '${X}', '***', '"***"']) expect(findSecret(`MY_DB_PASSWORD=${v}`)).toBeNull();
  });
});

describe('rótulo da versão anterior (dispensa "não é segredo" gravada em inbox.json)', () => {
  it('casa o rótulo genérico de antes com o rótulo atual', () => {
    expect(legacyLabel('senha na variável DB_PASSWORD')).toBe('uma senha');
    expect(legacyLabel('senha no comando mysql (-p)')).toBe('uma senha');
    expect(legacyLabel('senha numa URL de conexão (host db:5432)')).toBe('uma senha numa URL de conexão');
    expect(legacyLabel('chave de API da Anthropic')).toBe('uma chave da API da Anthropic');
    expect(legacyLabel('chave privada')).toBe('uma chave privada');
    expect(legacyLabel('frase qualquer')).toBeNull();
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
