import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodexRun, CodexRunner } from '../server/adapters/codex';
import { CodexModels, codexFamily, MODELS_TTL, parseCodexModels, pickCodexSubstitute } from '../server/codexModels';

// GET /api/codex/models: catálogo do `codex debug models` (só visibility "list"), com cache e sem erro 500 quando o Codex falta.

/** Recorte do `codex debug models` do Codex CLI 0.156.1 (a saída real tem uns 40 campos por modelo; aqui os que importam). */
const CATALOG = JSON.stringify({
  models: [
    { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ effort, description: 'x' })) },
    { slug: 'gpt-6-chat-thinking', display_name: 'GPT-6 Chat Thinking', visibility: 'hide', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort })) },
    { slug: 'sem-nome', visibility: 'list', supported_reasoning_levels: [] },
    { display_name: 'sem slug', visibility: 'list' },
    'lixo',
  ],
});

function fake(over: Partial<CodexRun> = {}, status: { available: boolean; reason: string | null } = { available: true, reason: null }) {
  const calls: string[][] = [];
  let checks = 0;
  const run: CodexRunner = async (args) => {
    calls.push(args);
    return { code: 0, stdout: CATALOG, stderr: '', ...over };
  };
  let now = 1_000_000;
  const models = new CodexModels(
    async () => (checks++, status),
    run,
    () => now,
  );
  return { models, calls, checks: () => checks, advance: (ms: number) => void (now += ms) };
}

describe('catálogo de modelos do Codex', () => {
  it('lê só os da lista: slug, nome e os esforços aceitos (ultra só nos Sol)', () => {
    expect(parseCodexModels(CATALOG)).toEqual([
      { slug: 'gpt-6-sol', displayName: 'GPT-6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
      { slug: 'gpt-6-luna', displayName: 'GPT-6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
      { slug: 'sem-nome', displayName: 'sem-nome', efforts: [], defaultEffort: null },
    ]);
    expect(parseCodexModels('Reading additional input...\n' + CATALOG + '\n')?.length).toBe(3); // ruído em volta do JSON
    expect(parseCodexModels('não é json')).toBeNull();
    expect(parseCodexModels('{"models": 3}')).toBeNull();
  });

  it('lista, guarda por 5 minutos e `fresh` ignora o que está guardado', async () => {
    const f = fake();
    const first = await f.models.list();
    expect(first.reason).toBeNull();
    expect(first.models.map((m) => m.slug)).toEqual(['gpt-6-sol', 'gpt-6-luna', 'sem-nome']);
    expect(f.calls).toEqual([['debug', 'models']]);
    await f.models.list();
    f.advance(MODELS_TTL - 1);
    await f.models.list();
    expect(f.calls).toHaveLength(1); // do cache, sem abrir o codex
    expect(f.checks()).toBe(1);
    f.advance(2);
    await f.models.list();
    expect(f.calls).toHaveLength(2); // passou do tempo
    await f.models.list(true);
    expect(f.calls).toHaveLength(3);
  });

  it('sem o Codex instalado ou sem login: lista vazia com o motivo, sem lançar e sem abrir `debug models`', async () => {
    const off = fake({}, { available: false, reason: 'o Codex CLI está sem login (rode codex login)' });
    expect(await off.models.list()).toEqual({ models: [], reason: 'o Codex CLI está sem login (rode codex login)' });
    expect(off.calls).toEqual([]);
    const boom = new CodexModels(async () => { throw new Error('quebrou'); });
    expect(await boom.list()).toEqual({ models: [], reason: 'não consegui verificar o Codex: quebrou' });
  });

  it('o `debug models` falhando (não instalado, erro, tempo, JSON estranho) vira lista vazia com o motivo, e a falha não fica guardada', async () => {
    const enoent = Object.assign(new Error('x'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
    expect((await fake({ code: null, spawnError: enoent }).models.list()).reason).toMatch(/não está instalado/);
    expect((await fake({ code: 1, stdout: '', stderr: 'boom\nresto' }).models.list()).reason).toBe('o codex debug models falhou: boom');
    expect((await fake({ code: null, timedOut: true }).models.list()).reason).toMatch(/demorou demais/);
    expect((await fake({ stdout: 'oi' }).models.list()).reason).toMatch(/formato que não reconheço/);
    expect(await fake({ stdout: '{"models":[]}' }).models.list()).toEqual({ models: [], reason: 'o Codex não listou nenhum modelo' });
    // Falhou, depois deu certo: não ficou a lista vazia guardada.
    const flaky = fake({ code: 1, stdout: '', stderr: 'x' });
    expect((await flaky.models.list()).models).toEqual([]);
    const ok = new CodexModels(async () => ({ available: true, reason: null }), async () => ({ code: 0, stdout: CATALOG, stderr: '' }));
    expect((await ok.list()).models).toHaveLength(3);
  });

  it('substituto de um modelo recusado: mesma família (último pedaço do slug), versão mais nova, sem o próprio; sem parecido, null', () => {
    // O catálogo de hoje do `codex debug models` (só os da lista).
    const hoje = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map((slug) => ({ slug }));
    expect(codexFamily('gpt-6.1-sol')).toBe('sol');
    // O caso do dono: gpt-6.1-sol configurado, a conta recusa. Vai para o Sol mais novo que existe.
    expect(pickCodexSubstitute('gpt-6.1-sol', hoje)).toBe('gpt-6-sol');
    expect(pickCodexSubstitute('gpt-7-luna', hoje)).toBe('gpt-6-luna');
    expect(pickCodexSubstitute('gpt-7-terra', hoje)).toBe('gpt-5.6-terra'); // só tem uma terra
    expect(pickCodexSubstitute('gpt-6.2-astra', hoje)).toBe('gpt-6-astra');
    // Entre 6 e 5.6, o 6 é o mais novo, qualquer que seja a ordem do catálogo.
    expect(pickCodexSubstitute('gpt-9-sol', [...hoje].reverse())).toBe('gpt-6-sol');
    expect(pickCodexSubstitute('gpt-5.10-sol', [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.9-sol' }])).toBe('gpt-5.9-sol'); // 5.9 antes de 5.6; 10 > 9 na comparação numérica
    // O próprio modelo (mesmo no catálogo) não é o substituto; sem família parecida, sem -m.
    expect(pickCodexSubstitute('gpt-6-sol', [{ slug: 'gpt-6-sol' }])).toBeNull();
    expect(pickCodexSubstitute('gpt-9-nova', hoje)).toBeNull();
    expect(pickCodexSubstitute('gpt-6.1-sol', [])).toBeNull();
    // Slug fora do padrão gpt-N: a família continua sendo o último pedaço.
    expect(pickCodexSubstitute('codex-mini', [{ slug: 'gpt-6-mini' }, { slug: 'gpt-6-sol' }])).toBe('gpt-6-mini');
  });

  it('a rota GET /api/codex/models está ligada ao catálogo, fora do ajuste da segunda opinião', async () => {
    const index = await fs.readFile(path.join(process.cwd(), 'server', 'index.ts'), 'utf8');
    expect(index).toMatch(/\['GET', \/\^\\\/api\\\/codex\\\/models\$\/, \(\{ url \}\) => codexModels\.list\(url\.searchParams\.has\('fresh'\)\)\]/);
    expect(index).toContain('new CodexModels((fresh) => codex.check(fresh))');
  });
});
