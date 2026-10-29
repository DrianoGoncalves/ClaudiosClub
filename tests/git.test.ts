import { describe, expect, it } from 'vitest';
import { parseStatus } from '../server/git';

describe('git status do projeto', () => {
  it('lê branch, remoto, à frente/atrás e arquivos sem commit', () => {
    const out = [
      '# branch.oid 1234abcd',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 aaa bbb client/src/App.tsx',
      '? notas.txt',
      // A pasta do próprio Claudio’s Club não conta.
      '? .myco/',
      '1 A. N... 000000 100644 100644 000 ccc .myco/staff/ana.json',
      '',
    ].join('\n');
    expect(parseStatus(out)).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3, dirty: 2 });
  });

  it('sem remoto e HEAD destacado', () => {
    expect(parseStatus('# branch.oid abc\n# branch.head (detached)\n')).toEqual({ branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0 });
  });
});
