import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectFileError } from '../server/projectFiles';
import {
  cleanUploadName,
  deleteAttachment,
  downloadHeaders,
  listAttachments,
  MAX_ATTACHMENT_BYTES,
  mimeOf,
  readAttachment,
  saveAttachment,
} from '../server/projectAttachments';

let base: string;
let proj: string;
const dirOf = (p = proj) => path.join(p, '.myco', 'attachments');
const buf = (s: string) => Buffer.from(s);

async function statusOf(p: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof ProjectFileError) return err.status;
    throw err;
  }
}

async function probeSymlink(): Promise<boolean> {
  const target = path.join(os.tmpdir(), `myco-att-probe-${process.pid}`);
  const link = `${target}-link`;
  try {
    await fs.mkdir(target, { recursive: true });
    await fs.symlink(target, link, 'junction');
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(link, { force: true, recursive: true }).catch(() => {});
    await fs.rm(target, { force: true, recursive: true }).catch(() => {});
  }
}
const canLink = await probeSymlink();

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-att-'));
  proj = path.join(base, 'projeto');
  await fs.mkdir(proj);
  await fs.writeFile(path.join(base, 'segredo.txt'), 'fora');
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('listar', () => {
  it('sem a pasta, lista vazia e não cria nada', async () => {
    const r = await listAttachments(proj);
    expect(r.attachments).toEqual([]);
    expect(r.maxBytes).toBe(MAX_ATTACHMENT_BYTES);
    await expect(fs.stat(dirOf())).rejects.toThrow();
  });
});

describe('enviar', () => {
  it('guarda, cria a pasta sob demanda e ignora a pasta no git', async () => {
    const r = await saveAttachment(proj, 'nota.txt', buf('oi'), true);
    expect(r).toMatchObject({ name: 'nota.txt', size: 2, type: 'text/plain', previewable: false, renamed: false });
    expect(await fs.readFile(path.join(dirOf(), 'nota.txt'), 'utf8')).toBe('oi');
    expect(await fs.readFile(path.join(proj, '.myco', '.gitignore'), 'utf8')).toContain('attachments/');
    // sem restos do temporário
    expect((await fs.readdir(dirOf())).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const list = await listAttachments(proj);
    expect(list.attachments.map((a) => a.name)).toContain('nota.txt');
  });

  it('recusa escrita que não veio da página (fromBrowser)', async () => {
    expect(await statusOf(saveAttachment(proj, 'x.txt', buf('x'), false))).toBe(403);
    expect(await statusOf(deleteAttachment(proj, 'nota.txt', false))).toBe(403);
    await expect(fs.stat(path.join(dirOf(), 'x.txt'))).rejects.toThrow();
    expect((await fs.stat(path.join(dirOf(), 'nota.txt'))).isFile()).toBe(true);
  });

  it('colisão de nome: sufixo " (2)", " (3)", sem sobrescrever', async () => {
    const p = path.join(base, 'colisao');
    await fs.mkdir(p);
    const a = await saveAttachment(p, 'foto.png', buf('um'), true);
    const b = await saveAttachment(p, 'foto.png', buf('dois'), true);
    const c = await saveAttachment(p, 'foto.png', buf('tres'), true);
    expect([a.name, b.name, c.name]).toEqual(['foto.png', 'foto (2).png', 'foto (3).png']);
    expect([a.renamed, b.renamed, c.renamed]).toEqual([false, true, true]);
    expect(await fs.readFile(path.join(dirOf(p), 'foto.png'), 'utf8')).toBe('um');
    expect(await fs.readFile(path.join(dirOf(p), 'foto (2).png'), 'utf8')).toBe('dois');
  });

  it('envios simultâneos com o mesmo nome não se sobrescrevem', async () => {
    const p = path.join(base, 'paralelo');
    await fs.mkdir(p);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => saveAttachment(p, 'a.txt', buf(`v${i}`), true)));
    expect(new Set(rs.map((r) => r.name)).size).toBe(6);
  });

  it('limite de 10 MB: o exato passa, 1 byte a mais é 413 e nada fica gravado', async () => {
    const p = path.join(base, 'limite');
    await fs.mkdir(p);
    expect(await statusOf(saveAttachment(p, 'ok.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES, 1), true))).toBe('ok');
    expect(await statusOf(saveAttachment(p, 'grande.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1), true))).toBe(413);
    expect(await fs.readdir(dirOf(p))).toEqual(['ok.bin']);
  });

  it('corpo vazio ou que não são bytes é 400', async () => {
    expect(await statusOf(saveAttachment(proj, 'v.txt', Buffer.alloc(0), true))).toBe(400);
    expect(await statusOf(saveAttachment(proj, 'v.txt', { a: 1 }, true))).toBe(400);
    expect(await statusOf(saveAttachment(proj, null, buf('x'), true))).toBe(400);
    expect(await statusOf(saveAttachment(proj, '', buf('x'), true))).toBe(400);
  });
});

describe('nomes e path traversal', () => {
  it('caminho no nome é 403, no envio, no download e ao apagar', async () => {
    for (const bad of ['../segredo.txt', '..', '.', 'a/b.txt', 'a\\b.txt', '/etc/passwd', 'C:\\Windows\\x.txt', 'C:x.txt', '..\\..\\x', 'a\0b']) {
      expect(await statusOf(saveAttachment(proj, bad, buf('x'), true)), `enviar ${JSON.stringify(bad)}`).toBe(403);
      expect(await statusOf(readAttachment(proj, bad)), `baixar ${JSON.stringify(bad)}`).toBe(403);
      expect(await statusOf(deleteAttachment(proj, bad, true)), `apagar ${JSON.stringify(bad)}`).toBe(403);
    }
    await expect(fs.stat(path.join(base, 'x.txt'))).rejects.toThrow();
    expect(await fs.readFile(path.join(base, 'segredo.txt'), 'utf8')).toBe('fora');
  });

  it('nome reservado do Windows é 400', async () => {
    for (const bad of ['CON', 'nul', 'COM1', 'lpt9', 'aux.txt', 'PRN.tar.gz', 'con.']) {
      expect(await statusOf(saveAttachment(proj, bad, buf('x'), true)), bad).toBe(400);
    }
    expect(await statusOf(readAttachment(proj, 'NUL'))).toBe(400);
  });

  it('limpa caracteres inválidos, pontos, espaços e encurta nomes longos', () => {
    expect(cleanUploadName('a<b>:c|d?.png')).toEqual({ stem: 'a_b__c_d_', ext: '.png' });
    expect(cleanUploadName('  ..env  ')).toEqual({ stem: 'env', ext: '' });
    expect(cleanUploadName('relatório final.pdf.')).toEqual({ stem: 'relatório final', ext: '.pdf' });
    const long = cleanUploadName(`${'x'.repeat(400)}.pdf`);
    expect(long.ext).toBe('.pdf');
    expect(long.stem.length + long.ext.length).toBeLessThanOrEqual(120);
    expect(() => cleanUploadName('...')).toThrow(ProjectFileError);
  });

  it('baixar um nome que o envio nunca grava é 400 (ponto inicial, temporário)', async () => {
    expect(await statusOf(readAttachment(proj, '.gitignore'))).toBe(400);
    expect(await statusOf(readAttachment(proj, 'a<b.txt'))).toBe(400);
  });

  it.skipIf(!canLink)('pasta de anexos que é link para fora: recusa (403) e nada vai para fora', async () => {
    const p = path.join(base, 'comlink');
    const fora = path.join(base, 'destino');
    await fs.mkdir(path.join(p, '.myco'), { recursive: true });
    await fs.mkdir(fora);
    await fs.writeFile(path.join(fora, 'segredo.txt'), 'fora');
    await fs.symlink(fora, dirOf(p), 'junction');
    expect(await statusOf(saveAttachment(p, 'x.txt', buf('x'), true))).toBe(403);
    expect(await statusOf(readAttachment(p, 'segredo.txt'))).toBe(403);
    expect(await statusOf(listAttachments(p))).toBe(403);
    expect(await fs.readdir(fora)).toEqual(['segredo.txt']);
  });
});

describe('baixar e apagar', () => {
  it('devolve os bytes; ausente é 404; apaga e some da lista', async () => {
    const p = path.join(base, 'ciclo');
    await fs.mkdir(p);
    expect(await statusOf(readAttachment(p, 'nada.txt'))).toBe(404);
    await saveAttachment(p, 'dados.csv', buf('a,b'), true);
    const r = await readAttachment(p, 'dados.csv');
    expect(r.bytes.toString()).toBe('a,b');
    expect(r.type).toBe('text/csv');
    expect(await deleteAttachment(p, 'dados.csv', true)).toEqual({ ok: true });
    expect(await statusOf(deleteAttachment(p, 'dados.csv', true))).toBe(404);
    expect((await listAttachments(p)).attachments).toEqual([]);
  });

  it('arquivo acima de 10 MB posto na pasta à mão não é servido (413)', async () => {
    const p = path.join(base, 'gordo');
    await fs.mkdir(dirOf(p), { recursive: true });
    await fs.writeFile(path.join(dirOf(p), 'enorme.bin'), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    expect(await statusOf(readAttachment(p, 'enorme.bin'))).toBe(413);
  });
});

describe('cabeçalhos de download', () => {
  it('svg e html (e pdf) sempre como attachment, com nosniff', async () => {
    const p = path.join(base, 'cab');
    await fs.mkdir(p);
    for (const [name, type] of [
      ['x.svg', 'image/svg+xml'],
      ['x.html', 'text/html'],
      ['x.htm', 'text/html'],
      ['x.pdf', 'application/pdf'],
      ['x.exe', 'application/octet-stream'],
    ] as const) {
      await saveAttachment(p, name, buf('<script>alert(1)</script>'), true);
      const r = await readAttachment(p, name);
      expect(r.type).toBe(type);
      expect(r.headers['content-disposition']).toMatch(/^attachment;/);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-security-policy']).toContain('sandbox');
    }
    const list = await listAttachments(p);
    expect(list.attachments.every((a) => !a.previewable)).toBe(true);
  });

  it('só raster vai inline (pré-visualização)', async () => {
    const p = path.join(base, 'raster');
    await fs.mkdir(p);
    for (const name of ['a.png', 'b.jpg', 'c.JPEG', 'd.gif', 'e.webp']) {
      await saveAttachment(p, name, buf('x'), true);
      const r = await readAttachment(p, name);
      expect(r.headers['content-disposition'], name).toMatch(/^inline;/);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
    expect((await listAttachments(p)).attachments.every((a) => a.previewable)).toBe(true);
  });

  it('um png que na verdade é svg continua sendo servido pelo tipo do nome (nunca por conteúdo)', () => {
    expect(mimeOf('x.png')).toBe('image/png');
    expect(mimeOf('x.SVG')).toBe('image/svg+xml');
    expect(mimeOf('sem-extensao')).toBe('application/octet-stream');
  });

  it('nome codificado (RFC 5987), sem aspas nem quebra de linha no filename', () => {
    const h = downloadHeaders('relatório "final" (v2)*.pdf', 'application/pdf')['content-disposition']!;
    expect(h).toContain("filename*=UTF-8''relat%C3%B3rio%20%22final%22%20%28v2%29%2A.pdf");
    expect(h).toContain('filename="relat_rio _final_ (v2)*.pdf"');
    expect(h).not.toMatch(/[\r\n]/);
  });
});
