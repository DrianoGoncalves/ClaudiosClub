import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defenderTip, exclusionCommand, isExcluded, psQuote } from '../scripts/defender';

// Dica opcional da página de início: tirar da verificação do Windows Defender as pastas que o Club abre o tempo todo. A página só mostra o comando (Copiar);
// quem roda é o dono, como administrador.

describe('comando do Defender', () => {
  it('aspas simples do PowerShell: nada é interpretado e a aspa simples sai dobrada', () => {
    expect(psQuote('C:\\Users\\ana\\.claude\\projects')).toBe("'C:\\Users\\ana\\.claude\\projects'");
    expect(psQuote("C:\\Users\\o'brien\\x")).toBe("'C:\\Users\\o''brien\\x'");
    expect(psQuote('C:\\pasta $(rm -r x) `n')).toBe("'C:\\pasta $(rm -r x) `n'");
  });

  it('adiciona e desfaz com a lista separada por vírgula', () => {
    expect(exclusionCommand(['C:\\a', 'C:\\b c'])).toBe("Add-MpPreference -ExclusionPath 'C:\\a', 'C:\\b c'");
    expect(exclusionCommand(['C:\\a'], 'Remove')).toBe("Remove-MpPreference -ExclusionPath 'C:\\a'");
  });
});

describe('o que já está fora da verificação', () => {
  it('a própria pasta ou uma acima dela; sem diferença de maiúsculas nem de barra no fim', () => {
    expect(isExcluded('C:\\Users\\ana\\.claude\\projects', ['c:\\users\\ana\\.claude\\projects\\'])).toBe(true);
    expect(isExcluded('C:\\www\\MyCo\\.git', ['C:\\www'])).toBe(true);
  });

  it('pasta de nome parecido não conta (C:\\www\\My não cobre C:\\www\\MyCo)', () => {
    expect(isExcluded('C:\\www\\MyCo\\.git', ['C:\\www\\My'])).toBe(false);
    expect(isExcluded('C:\\www\\MyCo\\.git', [])).toBe(false);
  });
});

describe('dica para esta instalação', () => {
  it('recomendado: transcripts e o git do Club; opcional: o node_modules; com o estado de cada pasta', () => {
    const tip = defenderTip('C:\\Users\\ana', 'C:\\www\\MyCo', ['C:\\Users\\ana\\.claude\\projects']);
    expect(tip.recommended.paths).toEqual([
      { path: 'C:\\Users\\ana\\.claude\\projects', excluded: true },
      { path: 'C:\\www\\MyCo\\.git', excluded: false },
    ]);
    expect(tip.recommended.cmd).toBe("Add-MpPreference -ExclusionPath 'C:\\Users\\ana\\.claude\\projects', 'C:\\www\\MyCo\\.git'");
    expect(tip.optional.paths).toEqual([{ path: 'C:\\www\\MyCo\\node_modules', excluded: false }]);
    expect(tip.optional.undo).toBe("Remove-MpPreference -ExclusionPath 'C:\\www\\MyCo\\node_modules'");
    expect(tip.excludedKnown).toBe(true);
  });

  it('sem permissão para ler as exclusões: estado desconhecido em cada pasta (a página avisa para conferir)', () => {
    const tip = defenderTip('C:\\Users\\ana', 'C:\\www\\MyCo', null);
    expect(tip.excludedKnown).toBe(false);
    expect([...tip.recommended.paths, ...tip.optional.paths].every((p) => p.excluded === null)).toBe(true);
  });
});

describe('página de início', () => {
  it('a seção do Defender é opcional e recolhida, monta tudo por textContent e só copia (nunca roda o comando)', async () => {
    const html = await fs.readFile(path.join(__dirname, '..', 'scripts', 'start.html'), 'utf8');
    expect(html).toContain('<details class="log defender" id="defender" hidden>');
    expect(html).toContain('renderDefender(st && st.defender)');
    const fn = html.slice(html.indexOf('const DEFENDER_GROUPS'), html.indexOf('function render(st'));
    expect(fn).toContain('function renderDefender');
    expect(fn).not.toMatch(/innerHTML|insertAdjacentHTML|location\.href|myco:\/\//);
    // Cada comando vai numa linha com o botão Copiar.
    expect(fn).toContain("p.append(`${label} `, code, ' ', copyButton(cmd));");
  });
});
