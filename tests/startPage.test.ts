import { describe, expect, it } from 'vitest';
import { buildStartPage } from '../server/startPage';

describe('página de início servida pela porta', () => {
  it('vai num arquivo só: CSS e ícones embutidos, nada relativo à pasta do projeto', async () => {
    const html = await buildStartPage();
    // Só o teste do build (que roda apenas como arquivo) ainda aponta para ../dist.
    expect(html).not.toMatch(/(href|src)="\.\.\//);
    expect(html).not.toContain('../client/');
    expect(html).toContain('<style>');
    expect(html).toMatch(/href="data:image\/png;base64,/);
    expect(html).toMatch(/src="data:image\/png;base64,/);
    // Checklist e log continuam vindo à parte (/status.js, /log.js), para o service worker guardar a versão mais nova.
    expect(html).toContain("loadData('status.js', 'claudioStatus')");
    expect(html).toContain("loadData('log.js', 'claudioLog')");
    expect(html).toContain('Iniciar o Claudio’s Club');
    expect(html).toContain('Preparar e iniciar');
  });
});

describe('log na página de início', () => {
  it('separa hora, origem e mensagem; linha sem carimbo é saída do servidor; tira cores', async () => {
    const { logEntries } = await import('../server/startPage');
    const text = [
      '[2026-10-30 08:05:48] [vigia] iniciando em /x (porta 4848)',
      '\x1b[32m✓ built in 14s\x1b[39m',
      '',
      '[2026-10-30 08:06:00] [link] pedido: myco://setup',
    ].join('\n');
    expect(logEntries(text)).toEqual([
      { at: '2026-10-30 08:05:48', source: 'vigia', text: 'iniciando em /x (porta 4848)' },
      { at: '', source: 'saída', text: '✓ built in 14s' },
      { at: '2026-10-30 08:06:00', source: 'link', text: 'pedido: myco://setup' },
    ]);
    expect(logEntries(text, 1)).toHaveLength(1);
  });

  it('lê só o fim do arquivo e descarta a primeira linha cortada', async () => {
    const { promises: fs } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { readTail } = await import('../server/startPage');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-tail-'));
    try {
      const file = path.join(dir, 'server.log');
      await fs.writeFile(file, 'linha-um-bem-comprida\nlinha-dois\nlinha-tres\n');
      expect(await readTail(file, 22)).toBe('linha-tres\n');
      expect(await readTail(path.join(dir, 'nao-existe.log'))).toBe('');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
