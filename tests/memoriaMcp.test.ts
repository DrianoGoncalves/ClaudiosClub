import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MEMORIA_MCP_NAME, type StaffProfile } from '../shared/model';
import { buildCodexArgs, codexExtraMcpArgs, CODEX_RESERVED_MCP_NAMES } from '../server/chat/codexArgs';
import { ROOT } from '../server/root';
import { buildClaudeArgs, renderFicha } from '../server/staff/ficha';
import { memoriaLaunchOf, prepareCodexRun, prepareRun, type LaunchContext } from '../server/staff/launch';
import { MEMORY_DETAIL_MAX_BYTES, MEMORY_INDEX_MAX_BYTES, MEMORY_INDEX_MAX_LINES } from '../scripts/hooks/memory-cap.mjs';
import { createMemoriaMcp, MEMORIA_MAX_FILES, memoriaMcpCommand, memoriaMcpServer, memoriaTarget, runMemoriaMcpStdio, TOOLS } from '../server/staff/memoriaMcp';
import { removeTemp } from './support/tmp';

// Funcionário em autonomia `plan` grava a PRÓPRIA memória (índice e pasta <id>.memory/) pelo MCP `myco-memoria`, nos dois motores, e nada mais:
// nem a memória ou a ficha de outra pessoa, nem `..`, nem link, nem arquivo fora de `.myco/staff`.

// MYCO_HOME de teste: o run e a configuração ficam fora do ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-memoria-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

const ID = 'ana-1a2b';
let root: string;
let proj: string;
const staff = (...p: string[]) => path.join(proj, '.myco', 'staff', ...p);
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-memoria-'));
  proj = path.join(root, 'proj');
});
afterAll(() => removeTemp(root, home));

/** Projeto limpo com as fichas de Ana (a dona) e de Bob (outra pessoa), e um arquivo de código. */
async function seed() {
  await fs.rm(proj, { recursive: true, force: true });
  await fs.mkdir(path.join(proj, 'src'), { recursive: true });
  await fs.mkdir(staff('bob.memory'), { recursive: true });
  const files: Record<string, string> = {
    [staff(`${ID}.md`)]: 'ficha de Ana',
    [staff(`${ID}.json`)]: '{"id":"ana"}',
    [staff('bob.md')]: 'ficha de Bob',
    [staff('bob.json')]: '{"id":"bob"}',
    [staff('bob.memory.md')]: 'memória de Bob',
    [staff('bob.memory', 'x.md')]: 'detalhe de Bob',
    [path.join(proj, 'src', 'app.ts')]: 'ORIGINAL',
  };
  for (const [f, c] of Object.entries(files)) await fs.writeFile(f, c);
}

/** Todos os arquivos sob `dir` com o conteúdo: antes e depois de uma chamada recusada, nada mudou. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await snapshot(f));
    else out[path.relative(root, f)] = await fs.readFile(f, 'utf8');
  }
  return out;
}

const mcp = () => createMemoriaMcp({ projectPath: proj, staffId: ID });

describe('memoria_gravar: a própria memória', () => {
  it('índice (caminho relativo, como a ficha mostra): grava normalizado (LF, sem espaço no fim) e diz o que gravou', async () => {
    await seed();
    const r = await mcp().callTool('memoria_gravar', { arquivo: '.myco/staff/ana-1a2b.memory.md', conteudo: '# Memória\r\n\r\n- decisão  \r\n- outra\r\n\r\n\r\n' });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('gravado: .myco/staff/ana-1a2b.memory.md');
    expect(await fs.readFile(staff(`${ID}.memory.md`), 'utf8')).toBe('# Memória\n\n- decisão\n- outra\n');
  });

  it('índice com o caminho absoluto (conversa em worktree) e com barras do Windows', async () => {
    await seed();
    expect((await mcp().callTool('memoria_gravar', { arquivo: staff(`${ID}.memory.md`), conteudo: 'a' })).isError).toBeUndefined();
    expect(await fs.readFile(staff(`${ID}.memory.md`), 'utf8')).toBe('a\n');
    expect((await mcp().callTool('memoria_gravar', { arquivo: '.myco\\staff\\ana-1a2b.memory.md', conteudo: 'b' })).isError).toBeUndefined();
    expect(await fs.readFile(staff(`${ID}.memory.md`), 'utf8')).toBe('b\n');
  });

  it('detalhe em <id>.memory/: cria a pasta, substitui o arquivo e não deixa .tmp', async () => {
    await seed();
    const arquivo = '.myco/staff/ana-1a2b.memory/linha-autonoma.md';
    expect((await mcp().callTool('memoria_gravar', { arquivo, conteudo: 'v1' })).isError).toBeUndefined();
    expect((await mcp().callTool('memoria_gravar', { arquivo, conteudo: 'v2' })).isError).toBeUndefined();
    expect(await fs.readFile(staff(`${ID}.memory`, 'linha-autonoma.md'), 'utf8')).toBe('v2\n');
    expect((await fs.readdir(staff(`${ID}.memory`))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('memoria_apagar: apaga um detalhe da própria pasta; o índice e o que não existe são recusados', async () => {
    await seed();
    await mcp().callTool('memoria_gravar', { arquivo: '.myco/staff/ana-1a2b.memory/velho.md', conteudo: 'x' });
    const ok = await mcp().callTool('memoria_apagar', { arquivo: '.myco/staff/ana-1a2b.memory/velho.md' });
    expect(ok.isError).toBeUndefined();
    await expect(fs.stat(staff(`${ID}.memory`, 'velho.md'))).rejects.toThrow();
    expect(text(await mcp().callTool('memoria_apagar', { arquivo: '.myco/staff/ana-1a2b.memory/velho.md' }))).toContain('não existe');
    await mcp().callTool('memoria_gravar', { arquivo: '.myco/staff/ana-1a2b.memory.md', conteudo: 'índice' });
    const idx = await mcp().callTool('memoria_apagar', { arquivo: '.myco/staff/ana-1a2b.memory.md' });
    expect(idx.isError).toBe(true);
    expect(await fs.readFile(staff(`${ID}.memory.md`), 'utf8')).toBe('índice\n');
  });
});

describe('recusas: nada além da própria memória', () => {
  const alvos: Array<[string, string]> = [
    ['memória de outra pessoa (índice)', '.myco/staff/bob.memory.md'],
    ['memória de outra pessoa (detalhe)', '.myco/staff/bob.memory/x.md'],
    ['memória de outra pessoa, novo detalhe', '.myco/staff/bob.memory/novo.md'],
    ['a própria ficha .md', `.myco/staff/${ID}.md`],
    ['a própria ficha .json', `.myco/staff/${ID}.json`],
    ['ficha .md de outra pessoa', '.myco/staff/bob.md'],
    ['ficha .json de outra pessoa', '.myco/staff/bob.json'],
    ['traversal para a memória de outra pessoa', `.myco/staff/${ID}.memory/../bob.memory.md`],
    ['traversal que volta à própria memória (a regra é uma só)', `.myco/staff/${ID}.memory/../${ID}.memory.md`],
    ['traversal com barras do Windows', '.myco\\staff\\..\\..\\src\\app.ts'],
    ['traversal para fora do projeto', '../fora.md'],
    ['código do projeto', 'src/app.ts'],
    ['dentro de .myco mas fora de staff', '.myco/outro.md'],
    ['absoluto fora do projeto', path.join(os.tmpdir(), 'myco-memoria-fora.md')],
    ['subpasta da memória', `.myco/staff/${ID}.memory/sub/x.md`],
    ['nome com maiúscula', `.myco/staff/${ID}.memory/Maiuscula.md`],
    ['extensão que não é .md', `.myco/staff/${ID}.memory/x.txt`],
    ['nome de dispositivo do Windows', `.myco/staff/${ID}.memory/con.md`],
    ['fluxo alternativo do NTFS', `.myco/staff/${ID}.memory.md::$DATA`],
    ['sufixo no índice', `.myco/staff/${ID}.memory.md.bak`],
    ['vazio', ''],
    ['só espaços', '   '],
    ['caractere de controle', `.myco/staff/${ID}.memory/x\u0000.md`],
  ];

  for (const [nome, arquivo] of alvos) {
    it(`${nome}: gravar e apagar recusam e nenhum arquivo muda`, async () => {
      await seed();
      const antes = await snapshot(root);
      const g = await mcp().callTool('memoria_gravar', { arquivo, conteudo: 'invasão' });
      const a = await mcp().callTool('memoria_apagar', { arquivo });
      expect(g.isError).toBe(true);
      expect(a.isError).toBe(true);
      expect(await snapshot(root)).toEqual(antes);
      await expect(fs.stat(path.join(os.tmpdir(), 'myco-memoria-fora.md'))).rejects.toThrow();
    });
  }

  it('arquivo que não é texto: não-string', async () => {
    await seed();
    const antes = await snapshot(root);
    for (const arquivo of [undefined, null, 7, ['.myco/staff/ana-1a2b.memory.md'], { a: 1 }]) {
      expect((await mcp().callTool('memoria_gravar', { arquivo, conteudo: 'x' })).isError).toBe(true);
    }
    expect(await snapshot(root)).toEqual(antes);
  });

  it('memoriaTarget: só o índice e <assunto>.md direto na pasta; a ficha dona vem do lançamento, não do pedido', () => {
    expect(memoriaTarget(proj, ID, '.myco/staff/ana-1a2b.memory.md')).toEqual({ file: staff(`${ID}.memory.md`), index: true });
    expect(memoriaTarget(proj, ID, '.myco/staff/ana-1a2b.memory/a-b-1.md')).toEqual({ file: staff(`${ID}.memory`, 'a-b-1.md'), index: false });
    // A memória de Bob só é de Bob para quem foi lançado como Bob.
    expect(memoriaTarget(proj, 'bob', '.myco/staff/bob.memory.md').index).toBe(true);
    expect(() => memoriaTarget(proj, ID, '.myco/staff/bob.memory.md')).toThrow();
    // Id de ficha malformado nunca monta um caminho.
    for (const bad of ['', '../x', 'A', 'a/b', 'a b', 'x'.repeat(41)]) expect(() => memoriaTarget(proj, bad, '.myco/staff/x.memory.md')).toThrow('ficha inválida');
  });

  it('link: a pasta da memória que é uma junção/link para fora não recebe a gravação', async () => {
    await seed();
    const fora = path.join(root, 'fora');
    await fs.mkdir(fora, { recursive: true });
    try {
      await fs.symlink(fora, staff(`${ID}.memory`), 'junction');
    } catch {
      return; // sem permissão para criar link neste computador: o caso não se aplica
    }
    const r = await mcp().callTool('memoria_gravar', { arquivo: `.myco/staff/${ID}.memory/x.md`, conteudo: 'invasão' });
    expect(r.isError).toBe(true);
    expect(await fs.readdir(fora)).toEqual([]);
    expect((await mcp().callTool('memoria_apagar', { arquivo: `.myco/staff/${ID}.memory/x.md` })).isError).toBe(true);
  });

  it('link: o índice que é um link de arquivo não é seguido', async () => {
    await seed();
    const alvo = path.join(root, 'alvo.md');
    await fs.writeFile(alvo, 'ORIGINAL');
    try {
      await fs.symlink(alvo, staff(`${ID}.memory.md`), 'file');
    } catch {
      return; // sem permissão para criar link neste computador: o caso não se aplica
    }
    const r = await mcp().callTool('memoria_gravar', { arquivo: `.myco/staff/${ID}.memory.md`, conteudo: 'invasão' });
    expect(r.isError).toBe(true);
    expect(await fs.readFile(alvo, 'utf8')).toBe('ORIGINAL');
  });
});

describe('conteúdo e limites', () => {
  const arquivo = `.myco/staff/${ID}.memory.md`;

  it('recusa vazio, não-texto, caractere de controle e arquivo grande; o arquivo que existe fica como estava', async () => {
    await seed();
    await mcp().callTool('memoria_gravar', { arquivo, conteudo: 'bom' });
    for (const conteudo of ['', '   \n', undefined, 5, 'a\u0000b', 'x'.repeat(MEMORY_INDEX_MAX_BYTES + 1)]) {
      expect((await mcp().callTool('memoria_gravar', { arquivo, conteudo })).isError).toBe(true);
    }
    expect(await fs.readFile(staff(`${ID}.memory.md`), 'utf8')).toBe('bom\n');
    // No limite passa (o texto normalizado ganha uma quebra no fim).
    expect((await mcp().callTool('memoria_gravar', { arquivo, conteudo: 'x'.repeat(MEMORY_INDEX_MAX_BYTES - 1) })).isError).toBeUndefined();
  });

  it(`a pasta aceita até ${MEMORIA_MAX_FILES} detalhes: o próximo novo é recusado, mas substituir um existente passa`, async () => {
    await seed();
    await fs.mkdir(staff(`${ID}.memory`), { recursive: true });
    for (let i = 0; i < MEMORIA_MAX_FILES; i++) await fs.writeFile(staff(`${ID}.memory`, `n${i}.md`), 'x');
    const novo = await mcp().callTool('memoria_gravar', { arquivo: `.myco/staff/${ID}.memory/novo.md`, conteudo: 'x' });
    expect(novo.isError).toBe(true);
    expect(text(novo)).toContain(String(MEMORIA_MAX_FILES));
    expect((await mcp().callTool('memoria_gravar', { arquivo: `.myco/staff/${ID}.memory/n0.md`, conteudo: 'y' })).isError).toBeUndefined();
    expect((await mcp().callTool('memoria_apagar', { arquivo: `.myco/staff/${ID}.memory/n1.md` })).isError).toBeUndefined();
    expect((await mcp().callTool('memoria_gravar', { arquivo: `.myco/staff/${ID}.memory/novo.md`, conteudo: 'x' })).isError).toBeUndefined();
  });
});

describe('teto de tamanho da memória', () => {
  const indice = `.myco/staff/${ID}.memory.md`;
  const detalhe = `.myco/staff/${ID}.memory/assunto.md`;
  /** `n` linhas curtas (cabe no teto de bytes; passa do de linhas se n > 60). */
  const linhas = (n: number) => Array.from({ length: n }, (_, i) => `- linha ${i}`).join('\n');
  const grava = (arquivo: string, conteudo: string) => mcp().callTool('memoria_gravar', { arquivo, conteudo });
  const naoMudou = async (arquivo: string, esperado: string) => expect(await fs.readFile(path.join(proj, arquivo), 'utf8')).toBe(esperado);

  it('índice acima do teto de bytes: recusado com a orientação de resumir e de mandar o detalhe para <id>.memory/; abaixo, grava como antes', async () => {
    await seed();
    await grava(indice, 'bom');
    const r = await grava(indice, 'x'.repeat(MEMORY_INDEX_MAX_BYTES + 1));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('passa do teto');
    expect(text(r)).toContain('resuma');
    expect(text(r)).toContain(`.myco/staff/${ID}.memory/<assunto>.md`);
    expect(text(r)).toContain('60 linhas e 8 KB');
    expect(text(r)).not.toContain('já passa do teto'); // a memória atual é pequena: nada de "já passa"
    await naoMudou(indice, 'bom\n');
    expect((await grava(indice, 'x'.repeat(MEMORY_INDEX_MAX_BYTES - 1))).isError).toBeUndefined();
  });

  it(`índice acima de ${MEMORY_INDEX_MAX_LINES} linhas: recusado (mesmo curto em bytes); com ${MEMORY_INDEX_MAX_LINES} passa`, async () => {
    await seed();
    expect((await grava(indice, linhas(MEMORY_INDEX_MAX_LINES))).isError).toBeUndefined();
    const r = await grava(indice, linhas(MEMORY_INDEX_MAX_LINES + 1));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`${MEMORY_INDEX_MAX_LINES + 1} linhas`);
    await naoMudou(indice, `${linhas(MEMORY_INDEX_MAX_LINES)}\n`);
  });

  it('o teto conta bytes (UTF-8), não caracteres', async () => {
    await seed();
    // `é` tem 2 bytes: 4097 deles passam de 8 KB, mesmo com menos caracteres que o teto.
    expect((await grava(indice, 'é'.repeat(MEMORY_INDEX_MAX_BYTES / 2 + 1))).isError).toBe(true);
    expect((await grava(indice, 'é'.repeat(MEMORY_INDEX_MAX_BYTES / 2 - 1))).isError).toBeUndefined();
  });

  it(`detalhe: teto próprio de ${MEMORY_DETAIL_MAX_BYTES / 1024} KB (maior que o do índice) e sem teto de linhas`, async () => {
    await seed();
    expect((await grava(detalhe, 'y'.repeat(MEMORY_INDEX_MAX_BYTES + 1))).isError).toBeUndefined(); // passaria como índice
    expect((await grava(detalhe, linhas(300))).isError).toBeUndefined();
    const r = await grava(detalhe, 'y'.repeat(MEMORY_DETAIL_MAX_BYTES + 1));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('o detalhe da memória passa do teto');
    expect(text(r)).toContain('16 KB');
    await naoMudou(detalhe, `${linhas(300)}\n`);
  });

  it('arquivo novo acima do teto também é recusado (nada é criado)', async () => {
    await seed();
    expect((await grava(indice, linhas(MEMORY_INDEX_MAX_LINES + 5))).isError).toBe(true);
    expect((await grava(detalhe, 'y'.repeat(MEMORY_DETAIL_MAX_BYTES + 1))).isError).toBe(true);
    await expect(fs.stat(staff(`${ID}.memory.md`))).rejects.toThrow();
    await expect(fs.stat(staff(`${ID}.memory`, 'assunto.md'))).rejects.toThrow();
  });

  it('memória que já passa do teto não trava: grava versão menor (mesmo ainda acima, com aviso), recusa igual ou maior e aceita a que cabe', async () => {
    await seed();
    const gorda = linhas(200); // 200 linhas, acima do teto de linhas
    await fs.writeFile(staff(`${ID}.memory.md`), `${gorda}\n`);
    // Maior, ou igual: recusado, e a mensagem diz que o arquivo atual já passa do teto.
    const maior = await grava(indice, linhas(201));
    expect(maior.isError).toBe(true);
    expect(text(maior)).toContain('já passa do teto');
    expect(text(maior)).toContain('versão menor');
    expect((await grava(indice, gorda)).isError).toBe(true);
    // Menos linhas e menos bytes, mas ainda acima do teto: aceito, com aviso de que falta reduzir.
    const menor = await grava(indice, linhas(100));
    expect(menor.isError).toBeUndefined();
    expect(text(menor)).toContain('ainda passa do teto (60 linhas e 8 KB)');
    await naoMudou(indice, `${linhas(100)}\n`);
    // Menos bytes, porém MAIS linhas (linhas curtas): é crescer em linhas, recusado.
    expect((await grava(indice, Array.from({ length: 150 }, () => '-').join('\n'))).isError).toBe(true);
    // Cabe no teto: aceito, sem aviso. Depois disso a regra volta ao normal (crescer acima do teto é recusado).
    const cabe = await grava(indice, linhas(40));
    expect(cabe.isError).toBeUndefined();
    expect(text(cabe)).not.toContain('ainda passa');
    expect((await grava(indice, linhas(61))).isError).toBe(true);
  });

  it('memória gorda só em bytes (poucas linhas longas) também reduz aos poucos', async () => {
    await seed();
    await fs.writeFile(staff(`${ID}.memory.md`), `${'z'.repeat(60_000)}\n`);
    expect((await grava(indice, 'z'.repeat(60_001))).isError).toBe(true);
    expect((await grava(indice, 'z'.repeat(30_000))).isError).toBeUndefined();
    expect((await grava(indice, 'z'.repeat(1_000))).isError).toBeUndefined();
  });

  it('detalhe que já passa do teto: o mesmo caminho (menor passa, maior não)', async () => {
    await seed();
    await fs.mkdir(staff(`${ID}.memory`), { recursive: true });
    await fs.writeFile(staff(`${ID}.memory`, 'assunto.md'), `${'d'.repeat(40_000)}\n`);
    expect((await grava(detalhe, 'd'.repeat(40_001))).isError).toBe(true);
    const menor = await grava(detalhe, 'd'.repeat(20_000));
    expect(menor.isError).toBeUndefined();
    expect(text(menor)).toContain('ainda passa do teto (16 KB)');
    expect((await grava(detalhe, 'd'.repeat(2_000))).isError).toBeUndefined();
  });

  it('a descrição da ferramenta diz o teto', () => {
    const gravar = TOOLS.find((t) => t.name === 'memoria_gravar')!;
    expect(gravar.description).toContain('60 linhas e 8 KB');
    expect(gravar.description).toContain('16 KB');
  });
});

describe('protocolo MCP', () => {
  it('initialize, ping e tools/list: duas ferramentas, nenhuma de leitura', async () => {
    const s = mcp();
    const init = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.serverInfo.name).toBe(MEMORIA_MCP_NAME);
    expect(await s.handle({ jsonrpc: '2.0', id: 2, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    const list = (await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as { result: { tools: typeof TOOLS } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['memoria_gravar', 'memoria_apagar']);
    expect(list.result.tools.every((t) => t.annotations.readOnlyHint === false)).toBe(true);
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('ferramenta desconhecida e método desconhecido são erro JSON-RPC; argumentos que não são objeto, erro da ferramenta', async () => {
    const s = mcp();
    expect(await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ssh_executar', arguments: {} } })).toMatchObject({ error: { code: -32602 } });
    expect(await s.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } });
    expect(await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memoria_gravar', arguments: 'x' } })).toMatchObject({ result: { isError: true } });
  });

  it('runMemoriaMcpStdio: uma linha por pedido, na ordem; linha inválida vira Parse error; uso errado lança', async () => {
    await seed();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: object[] = [];
    output.setEncoding('utf8');
    output.on('data', (c: string) => lines.push(...c.split('\n').filter(Boolean).map((l) => JSON.parse(l) as object)));
    const done = runMemoriaMcpStdio(['--project', proj, '--staff', ID], input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write('não é json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memoria_gravar', arguments: { arquivo: `.myco/staff/${ID}.memory.md`, conteudo: 'oi' } } })}\n`);
    input.end();
    await done;
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ id: 1 });
    expect(lines[1]).toMatchObject({ error: { code: -32700 } });
    expect(lines[2]).toMatchObject({ id: 2, result: { content: [{ text: expect.stringContaining('gravado') }] } });
    await expect(runMemoriaMcpStdio([], new PassThrough(), new PassThrough())).rejects.toThrow('uso:');
    await expect(runMemoriaMcpStdio(['--project', proj, '--staff', '../bob'], new PassThrough(), new PassThrough())).rejects.toThrow('uso:');
    await expect(runMemoriaMcpStdio(['--project', 'relativo', '--staff', ID], new PassThrough(), new PassThrough())).rejects.toThrow('uso:');
  });

  it('processo de verdade (a entrada server/memoria-mcp.ts, como a conversa sobe): grava a própria memória e recusa a de Bob', async () => {
    await seed();
    const { command, args } = memoriaMcpServer({ projectPath: proj, staffId: ID }, false);
    const child = spawn(command, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const replies: Array<{ id: number; result?: { isError?: boolean; content?: Array<{ text: string }> } }> = [];
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      buf += c;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        replies.push(JSON.parse(buf.slice(0, nl)) as (typeof replies)[number]);
        buf = buf.slice(nl + 1);
      }
    });
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    const call = (id: number, arquivo: string) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'memoria_gravar', arguments: { arquivo, conteudo: 'do processo' } } });
    child.stdin.write(`${call(1, `.myco/staff/${ID}.memory.md`)}\n${call(2, '.myco/staff/bob.memory.md')}\n`);
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(replies.find((r) => r.id === 1)?.result?.isError).toBeUndefined();
    expect(replies.find((r) => r.id === 2)?.result?.isError).toBe(true);
    expect(await fs.readFile(staff(`${ID}.memory.md`), 'utf8')).toBe('do processo\n');
    expect(await fs.readFile(staff('bob.memory.md'), 'utf8')).toBe('memória de Bob');
  }, 30_000);

  it('memoriaMcpCommand: sem o pacote usa o .ts pelo tsx; o servidor leva só o projeto e a ficha dona (nenhum segredo)', () => {
    expect(memoriaMcpCommand(false).args).toEqual(expect.arrayContaining(['--import', expect.stringMatching(/server[\\/]memoria-mcp\.ts$/)]));
    expect(memoriaMcpServer({ projectPath: '/p', staffId: ID }, false).args.slice(-4)).toEqual(['--project', '/p', '--staff', ID]);
  });
});

// ---- as conversas: lançamento, argumentos e texto da ficha ----

const profile = (over: Partial<StaffProfile> = {}) =>
  ({
    id: ID,
    projectId: 'proj-id',
    name: 'Ana',
    role: 'Analista',
    mission: 'Analisar',
    firstTask: '',
    autonomy: 'plan',
    agents: [],
    skills: [],
    mcps: null,
    mcpAccess: {},
    knowledge: [],
    rules: ['Nunca edite fora de .myco/backups/analise-*/'],
    doneWhen: '',
    reportsTo: [],
    engine: 'claude',
    model: null,
    effort: null,
    canHire: false,
    playbook: null,
    worktree: false,
    servers: [],
    sshWrite: [],
    browser: false,
    portrait: null,
    sessions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as unknown as StaffProfile;

const launch = (projectPath: string): LaunchContext => ({
  company: 'Co',
  projectName: 'proj',
  projectPath,
  managerNames: [],
  mycoUrl: 'http://127.0.0.2:1',
  runDir: path.join(home, 'run'),
  claudeConfigFile: path.join(projectPath, 'claude.json'),
  userAgentsDir: path.join(root, 'agents'),
});

const fichaDe = (p: string) => fs.readFile(path.join(p, '.myco', 'staff', `${ID}.md`), 'utf8');
const memoriaEm = (md: string) => md.slice(md.indexOf('## Memória'), md.indexOf('- Ponto de corte'));

describe('memoriaLaunchOf: só em plan, e só se a ficha não desliga o MCP', () => {
  it('plan: o servidor leva o projeto e a ficha dona', () => {
    const r = memoriaLaunchOf(profile(), { projectPath: proj });
    expect(r.info).toEqual({ mcp: true });
    expect(r.server!.args.slice(-4)).toEqual(['--project', proj, '--staff', ID]);
  });

  it('outras autonomias: nada muda (sem servidor e sem texto)', () => {
    for (const autonomy of ['manual', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      expect(memoriaLaunchOf(profile({ autonomy }), { projectPath: proj })).toEqual({ server: null });
    }
  });

  it('acesso ao MCP desligado (off), ou só leitura/pergunta (sem lista de leitura): fora, e a ficha diz', () => {
    for (const level of ['off', 'readonly', 'ask'] as const) {
      expect(memoriaLaunchOf(profile({ mcpAccess: { [MEMORIA_MCP_NAME]: level } }), { projectPath: proj })).toEqual({ info: { mcp: false }, server: null });
    }
  });
});

describe('Claude em plan: mcp.json, --allowedTools e a ficha', () => {
  it('o MCP entra no mcp.json (mesmo sem lista de MCPs, strict false), é liberado em --allowedTools e a ficha manda usá-lo', async () => {
    await seed();
    const p = profile();
    const run = await prepareRun(p, launch(proj), 'sess-plan', proj);
    expect(run.memoriaMcp).toBe(true);
    expect(run.strictMcp).toBe(false);
    const cfg = JSON.parse(await fs.readFile(run.mcpConfigPath!, 'utf8')) as { mcpServers: Record<string, { type: string; args: string[] }> };
    expect(cfg.mcpServers[MEMORIA_MCP_NAME]!.type).toBe('stdio');
    expect(cfg.mcpServers[MEMORIA_MCP_NAME]!.args.slice(-4)).toEqual(['--project', proj, '--staff', ID]);
    const args = buildClaudeArgs(p, { ...run, sessionId: 's', resume: false, firstPrompt: null });
    // Junto com o MCP de tarefa (cancelar a própria tarefa; ver tests/tarefaMcp.test.ts), que entra em toda conversa do Claude fora da revisão.
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(`mcp__${MEMORIA_MCP_NAME},mcp__myco-tarefa`);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    const md = memoriaEm(await fichaDe(proj));
    expect(md).toContain('é sempre permitido, mesmo que uma regra da ficha proíba editar arquivos');
    expect(md).toContain('`mcp__myco-memoria__memoria_gravar`');
    expect(md).toContain('`mcp__myco-memoria__memoria_apagar`');
    expect(md).toContain('Em plan a edição de arquivos fica bloqueada, e a sua memória é a única exceção');
  });

  it('fora de plan: sem o MCP, sem --allowedTools da memória; a ficha só diz que gravar a memória vale mesmo com regra de não editar', async () => {
    await seed();
    const p = profile({ autonomy: 'acceptEdits' });
    const run = await prepareRun(p, launch(proj), 'sess-edit', proj);
    expect(run.memoriaMcp).toBe(false);
    const cfg = run.mcpConfigPath ? (JSON.parse(await fs.readFile(run.mcpConfigPath, 'utf8')) as { mcpServers: Record<string, unknown> }) : { mcpServers: {} };
    expect(cfg.mcpServers[MEMORIA_MCP_NAME]).toBeUndefined();
    const args = buildClaudeArgs(p, { ...run, sessionId: 's', resume: false, firstPrompt: null });
    expect(args.includes('--allowedTools') ? args[args.indexOf('--allowedTools') + 1] : '').not.toContain(MEMORIA_MCP_NAME);
    const md = memoriaEm(await fichaDe(proj));
    expect(md).toContain('é sempre permitido, mesmo que uma regra da ficha proíba editar arquivos');
    expect(md).not.toContain('Em plan');
    expect(md).not.toContain('memoria_gravar');
  });

  it('plan com o MCP desligado na ficha: sem servidor, sem --allowedTools, e a ficha diz que não dá para gravar', async () => {
    await seed();
    const p = profile({ mcpAccess: { [MEMORIA_MCP_NAME]: 'off' } });
    const run = await prepareRun(p, launch(proj), 'sess-off', proj);
    expect(run.memoriaMcp).toBe(false);
    const args = buildClaudeArgs(p, { ...run, sessionId: 's', resume: false, firstPrompt: null });
    // Só o MCP de tarefa (outro assunto) sobra em --allowedTools: a memória não.
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__myco-tarefa');
    // `off` também sai pelo --disallowedTools (regra do mcpAccess, que não foi afrouxada).
    expect(args[args.indexOf('--disallowedTools') + 1]!.split(',')).toContain(`mcp__${MEMORIA_MCP_NAME}`);
    const md = memoriaEm(await fichaDe(proj));
    expect(md).toContain('está desligada na sua ficha');
    expect(md).not.toContain('memoria_gravar');
  });
});

describe('Codex em plan: o MCP na linha de comando e na ficha (a sandbox segue só leitura)', () => {
  const codex = (over: Partial<StaffProfile> = {}) => profile({ engine: 'codex', ...over });

  it('prepareCodexRun: o servidor sobe com o cwd do Club; os -c de mcp_servers.myco-memoria vão com approve, e o sandbox continua read-only', async () => {
    await seed();
    const run = await prepareCodexRun(codex(), launch(proj), 'sess-cx', proj);
    expect(run.memoriaMcp).not.toBeNull();
    expect(run.memoriaMcp!.cwd).toBe(ROOT);
    expect(run.memoriaMcp!.args.slice(-4)).toEqual(['--project', proj, '--staff', ID]);
    const args = buildCodexArgs({
      cwd: proj,
      sandbox: 'read-only',
      secrets: { projectPath: proj, home: path.join(root, 'h'), mycoHome: home },
      network: 'off',
      platform: 'linux',
      memoriaMcp: run.memoriaMcp,
    });
    expect(args.filter((a) => a.startsWith('mcp_servers.myco-memoria.'))).toHaveLength(4); // command, args, cwd, approve
    expect(args).toContain('mcp_servers.myco-memoria.default_tools_approval_mode="approve"');
    expect(args).toContain('permissions.mycodeny.extends=":read-only"');
    // Nenhum caminho de escrita é aberto na sandbox: a exceção é só o MCP.
    expect(args.join(' ')).not.toContain('="write"');
    const md = memoriaEm(await fichaDe(proj));
    expect(md).toContain('grave com `memoria_gravar`');
    expect(md).not.toContain('mcp__myco-memoria');
  });

  it('sem memoriaMcp (fora de plan ou desligado): nenhuma linha de mcp_servers.myco-memoria', async () => {
    await seed();
    const base = { cwd: proj, sandbox: 'read-only' as const, secrets: { projectPath: proj, home: path.join(root, 'h'), mycoHome: home }, network: 'off' as const, platform: 'linux' as const };
    expect(buildCodexArgs(base).some((a) => a.includes('mcp_servers'))).toBe(false);
    expect((await prepareCodexRun(codex({ autonomy: 'acceptEdits' }), launch(proj), 'sess-cx2', proj)).memoriaMcp).toBeNull();
    expect((await prepareCodexRun(codex({ mcpAccess: { [MEMORIA_MCP_NAME]: 'off' } }), launch(proj), 'sess-cx3', proj)).memoriaMcp).toBeNull();
    expect(memoriaEm(await fichaDe(proj))).toContain('está desligada na sua ficha');
  });

  it('um MCP da biblioteca com o nome myco-memoria não sobrescreve o interno (nome reservado)', () => {
    expect(CODEX_RESERVED_MCP_NAMES.has(MEMORIA_MCP_NAME)).toBe(true);
    expect(codexExtraMcpArgs([{ name: MEMORIA_MCP_NAME, command: 'node', args: ['x.js'] }])).toEqual([]);
  });
});

describe('aviso na abertura quando o índice da memória passa do teto', () => {
  const AVISO = 'ATENÇÃO: a sua memória passa do teto';
  const gorda = `${Array.from({ length: 90 }, (_, i) => `- linha ${i}`).join('\n')}\n`;

  it('Claude: o prompt da conversa avisa (com o tamanho, o teto e o que fazer); o .md da ficha não leva o aviso', async () => {
    await seed();
    await fs.writeFile(staff(`${ID}.memory.md`), gorda);
    const run = await prepareRun(profile({ autonomy: 'acceptEdits' }), launch(proj), 'sess-gorda', proj);
    const prompt = await fs.readFile(run.systemPromptFile, 'utf8');
    expect(prompt).toContain(AVISO);
    expect(prompt).toContain('90 linhas');
    expect(prompt).toContain('o teto é 60 linhas e 8 KB');
    expect(prompt).toContain('resuma antes de seguir');
    expect(prompt).toContain(`${path.join('.myco', 'staff', `${ID}.memory`)}/<assunto>.md`); // as barras do sistema, como o memoryPath da ficha
    // O aviso fica ao lado de "leia a memória", antes da ficha.
    expect(prompt.indexOf(AVISO)).toBeLessThan(prompt.indexOf('## Memória'));
    // O .md da ficha vai para o git: o tamanho da memória não entra nele.
    expect(await fichaDe(proj)).not.toContain(AVISO);
  });

  it('Codex: as instruções avisam do mesmo jeito', async () => {
    await seed();
    await fs.writeFile(staff(`${ID}.memory.md`), gorda);
    const run = await prepareCodexRun(profile({ engine: 'codex', autonomy: 'acceptEdits' }), launch(proj), 'sess-gorda-cx', proj);
    expect(run.instructions).toContain(AVISO);
    expect(run.instructions).toContain('90 linhas');
  });

  it('também avisa quando só os bytes passam (poucas linhas longas), em plan', async () => {
    await seed();
    await fs.writeFile(staff(`${ID}.memory.md`), `${'z'.repeat(9_000)}\n`);
    const run = await prepareRun(profile(), launch(proj), 'sess-gorda-bytes', proj);
    expect(await fs.readFile(run.systemPromptFile, 'utf8')).toContain(AVISO);
  });

  it('memória dentro do teto (e a recém-criada): sem aviso, nos dois motores', async () => {
    await seed();
    const claude = await prepareRun(profile(), launch(proj), 'sess-ok', proj);
    expect(await fs.readFile(claude.systemPromptFile, 'utf8')).not.toContain(AVISO);
    await fs.writeFile(staff(`${ID}.memory.md`), `${Array.from({ length: 60 }, (_, i) => `- linha ${i}`).join('\n')}\n`); // no limite
    expect(await fs.readFile((await prepareRun(profile(), launch(proj), 'sess-ok2', proj)).systemPromptFile, 'utf8')).not.toContain(AVISO);
    expect((await prepareCodexRun(profile({ engine: 'codex' }), launch(proj), 'sess-ok-cx', proj)).instructions).not.toContain(AVISO);
  });

  it('a seção Memória diz o teto do índice e do detalhe, nos dois motores', () => {
    const ctx = { company: 'Co', projectName: 'proj', projectPath: '/proj', managerNames: [], fichaPath: `.myco/staff/${ID}.md`, memoryPath: `.myco/staff/${ID}.memory.md`, mycoUrl: 'http://127.0.0.2:1' };
    for (const engine of ['claude', 'codex'] as const) {
      expect(memoriaEm(renderFicha(profile({ engine }), ctx))).toContain('o índice tem teto de 60 linhas e 8 KB (cada detalhe, 16 KB)');
    }
  });
});

describe('seção Memória da ficha (renderFicha)', () => {
  const ctx = { company: 'Co', projectName: 'proj', projectPath: '/proj', managerNames: [], fichaPath: `.myco/staff/${ID}.md`, memoryPath: `.myco/staff/${ID}.memory.md`, mycoUrl: 'http://127.0.0.2:1' };

  it('plan sem o contexto da conversa (ficha gravada na contratação): segue o padrão (MCP ligado), nunca diz "desligada"', () => {
    const md = memoriaEm(renderFicha(profile(), ctx));
    expect(md).toContain('`mcp__myco-memoria__memoria_gravar`');
    expect(md).not.toContain('desligada');
    expect(md).toContain(`\`.myco/staff/${ID}.memory.md\` e \`.myco/staff/${ID}.memory/*.md\``);
  });

  it('as regras da ficha que proíbem editar continuam na ficha: a seção Memória é quem abre a exceção da memória', () => {
    const md = renderFicha(profile(), ctx);
    expect(md).toContain('Nunca edite fora de .myco/backups/analise-*/');
    expect(md.indexOf('é sempre permitido, mesmo que uma regra da ficha proíba editar arquivos')).toBeGreaterThan(md.indexOf('## Memória'));
  });
});
