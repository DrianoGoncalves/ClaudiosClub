import { describe, expect, it } from 'vitest';
import { formatBytes, pastedName, splitBySize } from '../client/src/detail/attachmentFiles';

describe('anexos no cliente', () => {
  it('formata o tamanho', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3.4 * 1024)).toBe('3,4 KB');
    expect(formatBytes(250 * 1024)).toBe('250 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatBytes(1.25 * 1024 * 1024, 'en')).toBe('1.3 MB');
  });

  it('separa vazio e acima do limite antes de enviar', () => {
    const max = 10;
    const r = splitBySize(
      [
        { name: 'a', size: 0 },
        { name: 'b', size: 10 },
        { name: 'c', size: 11 },
      ],
      max,
    );
    expect(r.empty.map((f) => f.name)).toEqual(['a']);
    expect(r.ok.map((f) => f.name)).toEqual(['b']);
    expect(r.tooBig.map((f) => f.name)).toEqual(['c']);
  });

  it('dá nome ao print colado e mantém o nome de arquivo real', () => {
    const now = new Date(2026, 10, 4, 9, 5, 7);
    expect(pastedName('image.png', 'image/png', now)).toBe('print 2026-11-04 09-05-07.png');
    expect(pastedName('', 'image/jpeg', now)).toBe('print 2026-11-04 09-05-07.jpg');
    expect(pastedName('relatorio.pdf', 'application/pdf', now)).toBe('relatorio.pdf');
  });
});
