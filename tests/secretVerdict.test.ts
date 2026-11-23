import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SecretHint, SecretReason, SecretVerdict } from '../shared/model';
import { CodexProcess } from '../server/chat/codexProcess';
import { ChatManager } from '../server/chat/manager';
import { ChatProcess } from '../server/chat/process';
import { findSecret, scanSecrets, type ClassifiedSecret } from '../server/chat/secrets';
import { InboxState } from '../server/inboxState';
import { secretInboxItem, withoutSecretHint } from '../server/inboxItems';
import { removeTemp } from './support/tmp';

// Palpite (real ou exemplo) e dica mascarada do aviso de segredo. Os valores abaixo são montados na hora: o arquivo não tem nada com cara de
// chave real (o GitHub barraria o push, e um funcionário que lesse este arquivo dispararia a guarda).
const noise = (n: number) => Array.from({ length: n }, (_, i) => 'q7Xz2LmP9wKd4RtB'[(i * 7) % 16]).join('');
const TAIL = 'ZyX9'; // fim distinto: se aparecer num log, na extensão ou no resumo, é vazamento da dica
const gh = (body: string) => `${'ghp'}_${body}`;
const realGh = gh(`${noise(32)}${TAIL}`);
const fakeGh = gh('a'.repeat(36));
const ant = `${'sk-ant-'}api03-${noise(24)}${TAIL}`;
const aws = `${'AKIA'}7Q2XK9M4LZ8RT5WB`;
const openai = `${'sk-'}${noise(40)}`;
const pem = (body: string) => `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\n${body}`;

const only = (text: string, ctx?: Parameters<typeof scanSecrets>[1]): ClassifiedSecret => {
  const hits = scanSecrets(text, ctx);
  expect(hits, text).toHaveLength(1);
  return hits[0]!;
};
const verdictOf = (text: string, ctx?: Parameters<typeof scanSecrets>[1]): [SecretVerdict, SecretReason] => {
  const h = only(text, ctx);
  return [h.verdict, h.reason];
};

describe('palpite: os três estados e o indeterminado', () => {
  it('provável exemplo/teste: senha padrão, enchimento, arquivo de modelo, teste e host de exemplo', () => {
    expect(verdictOf('mysql -uroot -proot app')).toEqual(['example', 'default-password']);
    expect(verdictOf('DB_PASSWORD=changeme')).toEqual(['example', 'default-password']);
    expect(verdictOf('DATABASE_URL=postgres://root:root@localhost:5432/app')).toEqual(['example', 'default-password']); // padrão e local: vale o padrão
    expect(verdictOf('DB_PASSWORD=your-password-here')).toEqual(['example', 'placeholder']);
    expect(verdictOf('DB_PASSWORD=xxxxxxxx')).toEqual(['example', 'placeholder']);
    expect(verdictOf('DB_PASSWORD=S3nh4Forte1', { file: '.env.example' })).toEqual(['example', 'example-file']);
    expect(verdictOf('DB_PASSWORD=S3nh4Forte1', { file: 'config\\app.sample.php' })).toEqual(['example', 'example-file']);
    expect(verdictOf('DB_PASSWORD=S3nh4Forte1', { file: 'tests/fixtures/app.env' })).toEqual(['example', 'test-file']);
    expect(verdictOf('DB_PASSWORD=S3nh4Forte1', { file: 'src/db.spec.ts' })).toEqual(['example', 'test-file']);
    expect(verdictOf('DATABASE_URL=postgres://app:S3nh4fict1ca@db.example.com/app')).toEqual(['example', 'example-host']);
  });

  it('contexto local, autenticidade desconhecida: host loopback ou de desenvolvimento', () => {
    expect(verdictOf('DATABASE_URL=postgres://app:S3nh4fict1ca@localhost:5432/app')).toEqual(['local', 'local-host']);
    expect(verdictOf('DATABASE_URL=postgres://app:S3nh4fict1ca@127.0.0.1:54329/app')).toEqual(['local', 'local-host']);
    expect(verdictOf('DATABASE_URL=postgres://app:S3nh4fict1ca@[::1]:5432/app')).toEqual(['local', 'local-host']);
    expect(verdictOf('DATABASE_URL=mysql://app:S3nh4fict1ca@loja.test/app')).toEqual(['local', 'local-host']);
    expect(verdictOf('mysql -h 127.0.0.1 -uapp -pS3nh4fict1ca app')).toEqual(['local', 'local-host']);
    expect(verdictOf('mysql --host=localhost -uapp -pS3nh4fict1ca app')).toEqual(['local', 'local-host']);
  });

  it('possível credencial exposta: token de provedor, host de verdade, senha longa e variada', () => {
    expect(verdictOf(`use ${realGh}`)).toEqual(['exposed', 'provider-format']);
    expect(verdictOf(`use ${ant}`)).toEqual(['exposed', 'provider-format']);
    expect(verdictOf(aws + ' é a chave')).toEqual(['exposed', 'provider-format']);
    expect(verdictOf(pem('b3BlbnNzaC1rZXk='))).toEqual(['exposed', 'private-key']);
    expect(verdictOf('DATABASE_URL=postgres://app:S3nh4fict1ca@db.empresa.com.br:5432/app')).toEqual(['exposed', 'other-host']);
    expect(verdictOf('mysql -h 10.0.0.5 -uapp -pS3nh4fict1ca app')).toEqual(['exposed', 'other-host']);
    expect(verdictOf('DB_PASSWORD=Xk9mP2vL7qZ4tR!')).toEqual(['exposed', 'strong-value']);
    // Senha padrão num host de verdade é credencial real e fraca, não exemplo.
    expect(verdictOf('DATABASE_URL=postgres://admin:admin@db.empresa.com.br/app')).toEqual(['exposed', 'other-host']);
  });

  it('contexto insuficiente: não foi possível determinar', () => {
    expect(verdictOf('DB_PASSWORD=S3nh4Forte1')).toEqual(['unknown', 'no-context']);
    expect(verdictOf('mysql -uroot -pS3nh4Forte app')).toEqual(['unknown', 'no-context']);
    expect(verdictOf('lftp --password=S3nh4Forte1 ftp.exemplo.com')).toEqual(['unknown', 'no-context']);
    // Nome simples (serviço do compose, rede interna) não diz se é local.
    expect(verdictOf('DATABASE_URL=postgres://app:S3nh4Forte1@db:5432/app')).toEqual(['unknown', 'no-context']);
    expect(verdictOf('mysql -h db -uapp -pS3nh4Forte1 app')).toEqual(['unknown', 'no-context']);
    // Longa e variada (12+, 3 tipos de caractere) sem nada que a denuncie: possível credencial exposta.
    expect(verdictOf('DATABASE_URL=postgres://app:S3nh4fict1ca@db:5432/app')).toEqual(['exposed', 'strong-value']);
    // Caminho absoluto fora da pasta da conversa: só o nome do arquivo conta (a pasta "tests" de quem sabe onde não é do projeto).
    expect(verdictOf('DB_PASSWORD=S3nh4Forte1', { file: '/home/ana/tests/proj/.env', cwd: '/proj' })).toEqual(['unknown', 'no-context']);
    expect(verdictOf('DB_PASSWORD=S3nh4Forte1', { file: '/proj/tests/a.env', cwd: '/proj' })).toEqual(['example', 'test-file']);
  });

  it('token de provedor com formato válido nunca é "exemplo": nem em .env.example, nem em teste', () => {
    for (const file of [undefined, '.env.example', 'tests/fixtures/keys.ts', 'src/a.test.ts']) {
      expect(verdictOf(`GH=${realGh}`, { file }), String(file)).toEqual(['exposed', 'provider-format']);
    }
    // Chave privada: só arquivo de modelo a rebaixa, nunca a pasta de teste (uma chave de verdade pode cair lá).
    expect(verdictOf(pem('b3Bl'), { file: 'keys/id_rsa.example' })).toEqual(['example', 'example-file']);
    expect(verdictOf(pem('b3Bl'), { file: 'tests/id_rsa' })).toEqual(['exposed', 'private-key']);
  });
});

describe('looksFake gera alerta "exemplo" (e o findSecret dos bloqueios segue ignorando)', () => {
  it('token com cara de exemplo vira achado `example`', () => {
    for (const fake of [fakeGh, gh('abcdefghijklmnopqrstuvwxyz0123456789'), `${'AKIA'}IOSFODNN7EXAMPLE`, `${'sk-ant-'}api03-${'A'.repeat(28)}`]) {
      expect(findSecret(fake), fake).toBeNull();
      const hit = only(`veja ${fake}`);
      expect(hit).toMatchObject({ verdict: 'example', reason: 'fake-token', kind: 'api-key' });
      expect(hit.hint?.tail).toBe(fake.slice(-4)); // o dono vê todos, com a dica para reconhecer
    }
  });

  it('exemplo antes (ou depois) de um real no mesmo texto: o real aparece, e é o mais grave', () => {
    for (const text of [`${fakeGh} e ${realGh}`, `${realGh} e ${fakeGh}`, `${fakeGh} ${fakeGh} ${realGh}`]) {
      const hit = only(text);
      expect(hit).toMatchObject({ label: 'token do GitHub', verdict: 'exposed', reason: 'provider-format' });
      expect(hit.hint?.tail).toBe(TAIL);
    }
  });

  it('rótulos diferentes: um achado por rótulo, do mais grave ao menos grave', () => {
    const hits = scanSecrets(`${`${'sk-ant-'}api03-${'A'.repeat(28)}`} depois ${realGh} e DB_PASSWORD=changeme`);
    expect(hits.map((h) => [h.label, h.verdict])).toEqual([
      ['token do GitHub', 'exposed'],
      ['chave de API da Anthropic', 'example'],
      ['senha na variável DB_PASSWORD', 'example'],
    ]);
  });
});

describe('dica mascarada', () => {
  const hintOf = (text: string, ctx?: Parameters<typeof scanSecrets>[1]) => only(text, ctx).hint;

  it('token de provedor: prefixo público + últimos 4 + tamanho', () => {
    expect(hintOf(ant)).toEqual({ prefix: 'sk-ant-', tail: TAIL, length: ant.length });
    expect(hintOf(realGh)).toEqual({ prefix: 'ghp_', tail: TAIL, length: realGh.length });
    expect(hintOf(aws)).toEqual({ prefix: 'AKIA', tail: aws.slice(-4), length: 20 });
    expect(hintOf(openai)).toEqual({ prefix: 'sk-', tail: openai.slice(-4), length: openai.length });
  });

  it('senha com 12+ caracteres: só os últimos 2 + tamanho; com menos: só o tamanho', () => {
    expect(hintOf('DB_PASSWORD=Xk9mP2vL7qZ4tR!')).toEqual({ tail: 'R!', length: 15 });
    expect(hintOf('DB_PASSWORD=S3nh4Forte12')).toEqual({ tail: '12', length: 12 }); // 12: já mostra o fim
    expect(hintOf('DB_PASSWORD=S3nh4Forte1')).toEqual({ length: 11 }); // 11: só o tamanho
    expect(hintOf('mysql -uroot -pS3nh4Forte app')).toEqual({ length: 10 });
    expect(hintOf('lftp --password=S3nh4fict1ca ftp.exemplo.com')).toEqual({ tail: 'ca', length: 12 });
    expect(hintOf('DATABASE_URL=postgres://app:S3nh4fict1ca@db:5432/app')).toEqual({ tail: 'ca', length: 12 });
  });

  it('senha padrão conhecida: só indica que é padrão (nem o tamanho); chave privada: sem dica', () => {
    expect(hintOf('DB_PASSWORD=changeme')).toEqual({ isDefault: true });
    expect(hintOf('mysql -uroot -proot app')).toEqual({ isDefault: true });
    expect(hintOf('DATABASE_URL=postgres://admin:admin@db.empresa.com.br/app')).toEqual({ isDefault: true });
    expect(only(pem('b3BlbnNzaC1rZXk=')).hint).toBeUndefined();
    expect(only(pem('b3Bl'))).not.toHaveProperty('hint');
  });

  it('nunca mais de 4 caracteres do valor, e em senha nunca início e fim juntos; o valor não aparece em lugar nenhum do achado', () => {
    const casos: Array<[string, string, boolean]> = [
      [`use ${ant}`, ant, true],
      [`use ${realGh}`, realGh, true],
      [aws, aws, true],
      ['DB_PASSWORD=Xk9mP2vL7qZ4tR!', 'Xk9mP2vL7qZ4tR!', false],
      ['DB_PASSWORD=S3nh4Forte1', 'S3nh4Forte1', false],
      ['mysql -uroot -pS3nh4fict1ca-longa-demais app', 'S3nh4fict1ca-longa-demais', false],
      ['DATABASE_URL=postgres://usuarioSecreto:Sup3rSenh4Longa@db.empresa.com.br/app', 'Sup3rSenh4Longa', false],
    ];
    for (const [text, valor, token] of casos) {
      const hit = only(text);
      const hint = hit.hint as SecretHint;
      expect((hint.tail ?? '').length, text).toBeLessThanOrEqual(4);
      if (!token) expect(!!(hint.prefix && hint.tail), text).toBe(false);
      expect(hint.length).toBe(valor.length);
      // Fora o fim e o prefixo público, nenhum pedaço de 5+ caracteres do valor vai no achado (rótulo, dica, ocorrência).
      const json = JSON.stringify(hit);
      for (let i = 0; i + 5 <= valor.length; i++) {
        const pedaco = valor.slice(i, i + 5);
        if (token && (hint.prefix ?? '').includes(pedaco)) continue;
        expect(json.includes(pedaco), `${text} → ${pedaco}`).toBe(false);
      }
      expect(json).not.toContain('usuarioSecreto');
    }
  });
});

describe('identidade da ocorrência', () => {
  it('mesmo valor = mesma ocorrência; outro valor, outro sal ou outro tipo = outra; não é o valor', () => {
    const a = only('DB_PASSWORD=S3nh4Forte1').occurrence;
    expect(only('docker run -e DB_PASSWORD=S3nh4Forte1 app').occurrence).toBe(a);
    expect(only('DB_PASSWORD=OutraSenha99').occurrence).not.toBe(a);
    expect(only('DB_PASSWORD=S3nh4Forte1', { pepper: 'aa'.repeat(16) }).occurrence).not.toBe(a);
    expect(only('DB_PASSWORD=S3nh4Forte1', { pepper: 'aa'.repeat(16) }).occurrence).toBe(only('DB_PASSWORD=S3nh4Forte1', { pepper: 'aa'.repeat(16) }).occurrence);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it('duas chaves privadas com o mesmo cabeçalho são ocorrências diferentes', () => {
    expect(only(pem('AAAAchaveUm')).occurrence).not.toBe(only(pem('AAAAchaveDois')).occurrence);
    expect(only(pem('AAAAchaveUm')).occurrence).toBe(only(pem('AAAAchaveUm')).occurrence);
  });
});

// ---- do motor ao aviso (Claude e Codex) ----

let root: string;
let proj: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-secretverdict-'));
  proj = path.join(root, 'proj');
  await fs.mkdir(proj, { recursive: true });
});
afterAll(() => removeTemp(root));

const tick = () => new Promise((r) => setTimeout(r, 15));

function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 4242, kill: () => proc.emit('exit', 0) });
  const spawnImpl = () => proc as never;
  const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
  return { proc, spawnImpl, emit };
}

function fakeCodex() {
  const runs: Array<{ emit: (ev: object) => void }> = [];
  const spawnImpl = () => {
    const stdout = new PassThrough();
    runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n') });
    return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 4243 }) as never;
  };
  return { spawnImpl, last: () => runs[runs.length - 1]! };
}

const place = { projectId: 'p', projectName: 'Projeto', sessionId: 'sx', staffId: 'ana', name: 'Ana' };

async function manager(inbox = new InboxState()) {
  const procs: Array<ReturnType<typeof fakeClaude>> = [];
  const logs: string[] = [];
  const m = new ChatManager({
    transcriptsDir: root,
    usageFile: path.join(root, 'usage.json'),
    listLive: async () => [],
    resolve: async (_p, sid) => ({ sessionId: sid ?? 'sx', cwd: proj, args: ['--permission-mode', 'acceptEdits'] }),
    spawnImpl: (() => {
      const f = fakeClaude();
      f.proc.stdin.on('finish', () => f.proc.emit('exit', 0));
      procs.push(f);
      return f.spawnImpl();
    }) as never,
    log: (l) => logs.push(l),
    inbox,
  });
  await m.send('p', 'sx', 'ana', 'rode');
  const f = procs[0]!;
  let n = 0;
  /** O funcionário roda um comando (Bash) com este texto: o aviso nasce da entrada da ferramenta. */
  const say = async (text: string) => {
    f.emit({ type: 'assistant', message: { id: `m${++n}`, content: [{ type: 'tool_use', id: `tu${n}`, name: 'Bash', input: { command: text } }] } });
    await tick();
  };
  return { m, say, logs, inbox };
}

describe('gravidade sobe no aviso que já existe (um aviso por conversa e tipo)', () => {
  it('exemplo primeiro, real depois: o mesmo aviso passa a "exposed", com a dica da ocorrência real', async () => {
    const { m, say } = await manager();
    await say(`echo ${fakeGh}`);
    let [hit] = m.secretHits();
    expect(m.secretHits()).toHaveLength(1);
    expect(hit).toMatchObject({ id: 'sx:token do GitHub', verdict: 'example', reason: 'fake-token' });
    const firstAt = hit!.at;

    await tick();
    await say(`echo ${realGh}`);
    expect(m.secretHits()).toHaveLength(1);
    [hit] = m.secretHits();
    expect(hit).toMatchObject({ id: 'sx:token do GitHub', verdict: 'exposed', reason: 'provider-format', hint: { prefix: 'ghp_', tail: TAIL, length: realGh.length } });
    expect(hit!.at >= firstAt).toBe(true);

    // Outro exemplo depois não rebaixa o aviso.
    await say(`echo ${fakeGh}`);
    expect(m.secretHits()).toHaveLength(1);
    expect(m.secretHits()[0]).toMatchObject({ verdict: 'exposed', hint: { tail: TAIL } });
  });

  it('ocorrência igual ou menos grave não troca a primeira (fica o arquivo e a dica dela)', async () => {
    const { m, say } = await manager();
    await say('DB_PASSWORD=S3nh4Forte1');
    await say('DB_PASSWORD=changeme'); // example: menos grave que unknown
    expect(m.secretHits()).toHaveLength(1);
    expect(m.secretHits()[0]).toMatchObject({ verdict: 'unknown', hint: { length: 11 } });
    await say('DB_PASSWORD=Xk9mP2vL7qZ4tR!'); // exposed: sobe
    expect(m.secretHits()[0]).toMatchObject({ verdict: 'exposed', reason: 'strong-value', hint: { tail: 'R!', length: 15 } });
  });

  it('exemplo e real no mesmo texto: nasce o aviso do real', async () => {
    const { m, say } = await manager();
    await say(`${fakeGh} e ${realGh}`);
    expect(m.secretHits()).toHaveLength(1);
    expect(m.secretHits()[0]).toMatchObject({ verdict: 'exposed', hint: { tail: TAIL } });
  });
});

describe('"não é segredo" vale só para a ocorrência', () => {
  it('o mesmo valor não volta; outro valor do mesmo tipo avisa de novo', async () => {
    const { m, say } = await manager();
    await say('DB_PASSWORD=S3nh4Forte1');
    const [hit] = m.secretHits();
    expect(m.dismissSecret(hit!.id, true)).toBe(true);
    expect(m.secretHits()).toEqual([]);
    await say('docker run -e DB_PASSWORD=S3nh4Forte1 app'); // o mesmo valor, em outro texto
    expect(m.secretHits()).toEqual([]);
    await say('DB_PASSWORD=OutraSenha99'); // outro valor, mesmo rótulo: antes ficava calado
    expect(m.secretHits()).toHaveLength(1);
    expect(m.secretHits()[0]).toMatchObject({ label: 'senha na variável DB_PASSWORD', hint: { length: 12, tail: '99' } });
  });

  it('"já troquei" não cala nada: o mesmo valor volta', async () => {
    const { m, say } = await manager();
    await say('DB_PASSWORD=S3nh4Forte1');
    m.dismissSecret(m.secretHits()[0]!.id);
    await say('DB_PASSWORD=S3nh4Forte1');
    expect(m.secretHits()).toHaveLength(1);
  });

  it('dispensa antiga (o rótulo todo, como estava gravada em inbox.json) continua valendo para qualquer valor', async () => {
    const inbox = new InboxState();
    inbox.mute('sx:senha na variável DB_PASSWORD'); // formato de antes: sessão:rótulo
    inbox.mute('sx:uma chave da API da Anthropic'); // e o rótulo da versão anterior ao contexto
    const { m, say } = await manager(inbox);
    await say('DB_PASSWORD=S3nh4Forte1');
    await say('DB_PASSWORD=OutraSenha99');
    await say(`echo ${ant}`);
    expect(m.secretHits()).toEqual([]);
    await say(`echo ${realGh}`); // outro rótulo: avisa
    expect(m.secretHits()).toHaveLength(1);
  });

  it('a dispensa por ocorrência sobrevive ao reinício (o sal fica no inbox.json)', async () => {
    const file = path.join(root, 'inbox-ocorrencia.json');
    const a = await manager(new InboxState(file));
    await a.say('DB_PASSWORD=S3nh4Forte1');
    a.m.dismissSecret(a.m.secretHits()[0]!.id, true);
    await a.inbox.flush();

    const b = await manager(new InboxState(file));
    await b.say('DB_PASSWORD=S3nh4Forte1');
    expect(b.m.secretHits()).toEqual([]);
    await b.say('DB_PASSWORD=OutraSenha99');
    expect(b.m.secretHits()).toHaveLength(1);
  });

  it('aviso que já não está na lista (tela velha): dispensar não cala o rótulo', async () => {
    const { m, say } = await manager();
    expect(m.dismissSecret('sx:senha na variável DB_PASSWORD', true)).toBe(true);
    await say('DB_PASSWORD=S3nh4Forte1');
    expect(m.secretHits()).toHaveLength(1);
  });
});

describe('a dica não sai do item da tela do Club', () => {
  it('o item leva verdict, reason e hint; o resumo, o log e a ocorrência não levam a dica', async () => {
    const { m, say, logs } = await manager();
    await say(`echo ${realGh}`);
    const [hit] = m.secretHits();
    const item = secretInboxItem(hit!, place, proj);
    expect(item.secret).toEqual({ kind: 'api-key', detail: 'github', source: 'tool-input', verdict: 'exposed', reason: 'provider-format', hint: { prefix: 'ghp_', tail: TAIL, length: realGh.length } });
    // Resumo (o que a notificação mostra), log e a identidade da ocorrência: nada do valor nem da dica.
    expect(item.summary).not.toContain(TAIL);
    expect(item.summary).not.toMatch(/ghp_|exposed|provider-format/);
    expect(JSON.stringify(item)).not.toContain(hit!.occurrence);
    const log = logs.join('\n');
    expect(log).toContain('token do GitHub apareceu na conversa');
    expect(log).not.toContain(TAIL);
    expect(log).not.toContain(hit!.occurrence);
    expect(log).not.toContain(realGh.slice(4, 24));
    expect(log).not.toMatch(/ghp_/);
  });

  it('para quem não é a tela (agente pela API, curl): withoutSecretHint tira palpite, motivo e dica e deixa o resto', async () => {
    const { m, say } = await manager();
    await say(`echo ${realGh}`);
    const secret = secretInboxItem(m.secretHits()[0]!, place, proj);
    const other = { id: 'waiting:sx', kind: 'waiting', projectId: 'p', projectName: 'Projeto', sessionId: 'sx', staffId: null, name: '', summary: 'x', at: null } as const;
    const [semHint, intacto] = withoutSecretHint([secret, other]);
    expect(semHint!.secret).toEqual({ kind: 'api-key', detail: 'github', source: 'tool-input' });
    expect(JSON.stringify(semHint)).not.toMatch(new RegExp(`${TAIL}|verdict|reason|hint|exposed`));
    expect(intacto).toBe(other);
    expect(secret.secret).toHaveProperty('hint'); // o original não muda
  });

  it('o aviso que sobe de gravidade também não põe a dica no log', async () => {
    const { say, logs } = await manager();
    await say(`echo ${fakeGh}`);
    await say(`echo ${realGh}`);
    const log = logs.join('\n');
    expect(log).toContain('voltou mais grave (exposed)');
    expect(log).not.toContain(TAIL);
  });
});

describe('paridade Claude e Codex', () => {
  it('Claude: arquivo de modelo, token de exemplo e exemplo + real no mesmo texto', async () => {
    const f = fakeClaude();
    const found: Array<[ClassifiedSecret, string | undefined, string | undefined]> = [];
    const chat = new ChatProcess({ sessionId: 's-v', cwd: proj, args: [], spawnImpl: f.spawnImpl, onSecret: (h, source, file) => found.push([h, source, file]) });
    chat.start();
    chat.send('oi');
    const tool = (id: string, name: string, input: object) => f.emit({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
    const result = (id: string, content: string) => f.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] } });
    tool('r1', 'Read', { file_path: path.join(proj, '.env.example') });
    result('r1', 'DB_PASSWORD=S3nh4Forte1\n');
    tool('b1', 'Bash', { command: `echo ${fakeGh} ${realGh}` });
    await tick();
    expect(found.map(([h]) => [h.label, h.verdict, h.reason])).toEqual([
      ['senha na variável DB_PASSWORD', 'example', 'example-file'],
      ['token do GitHub', 'exposed', 'provider-format'],
    ]);
  });

  it('Codex: o mesmo (arquivo de modelo lido por cat, token de exemplo, exemplo + real)', async () => {
    const f = fakeCodex();
    const found: Array<[ClassifiedSecret, string | undefined, string | undefined]> = [];
    const profile = { cwd: '/proj', sessionId: 'sess-v', permissionMode: 'default', secrets: { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' } };
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onSecret: (h, source, file) => found.push([h, source, file]) });
    chat.start();
    chat.send('rode isso');
    const r = f.last();
    r.emit({ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'cat .env.example', aggregated_output: 'DB_PASSWORD=S3nh4Forte1\n', exit_code: 0, status: 'completed' } });
    r.emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: `${fakeGh} e ${realGh}` } });
    await tick();
    expect(found.map(([h]) => [h.label, h.verdict, h.reason])).toEqual([
      ['senha na variável DB_PASSWORD', 'example', 'example-file'],
      ['token do GitHub', 'exposed', 'provider-format'],
    ]);
    expect(found[1]![0].hint).toEqual({ prefix: 'ghp_', tail: TAIL, length: realGh.length });
  });
});
