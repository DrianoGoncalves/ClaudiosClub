import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import skillgh from '../client/src/i18n/skillgh';
import { ApiError, type GithubAlert, type GithubBatchItem, type GithubBatchResult, type GithubChoose, type GithubPreview } from '../client/src/api';
import {
  alertTotals,
  batchErrorKind,
  batchItems,
  batchOutcomes,
  dangerOutCount,
  defaultInclude,
  previewRows,
  retryPicks,
  rowNameOk,
  runBatch,
  togglePick,
  togglePickAll,
  worstLevel,
  type BatchOutcome,
  type BatchRow,
} from '../client/src/skills/githubBatch';
import { BatchDoneView, BatchPreviewView, ChooseView } from '../client/src/skills/GithubInstall';
import { GitHubInstallBatchInput } from '../server/skillInstall';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const alert = (level: GithubAlert['level'], message = level as string, code: string = level): GithubAlert => ({ level, code, message });

const skillNames = ['gsap-core', 'gsap-timeline', 'gsap-scrolltrigger', 'gsap-plugins', 'gsap-utils', 'gsap-react', 'gsap-frameworks', 'gsap-performance'];
const choose = (): GithubChoose => ({
  kind: 'choose',
  source: { owner: 'greensock', repo: 'gsap-skills', ref: 'main', sha: SHA_A },
  skills: skillNames.map((name) => ({ path: `skills/${name}`, name, description: `faz ${name}` })),
});

const preview = (name: string, alerts: GithubAlert[] = [], over: Partial<GithubPreview> = {}): GithubPreview => ({
  kind: 'preview',
  source: { owner: 'greensock', repo: 'gsap-skills', ref: 'main', sha: SHA_A, path: `skills/${name}`, treeSha: SHA_B, url: 'https://github.com/greensock/gsap-skills' },
  name,
  skillMd: `---\nname: ${name}\n---\n# ${name}`,
  frontmatter: { name },
  files: [
    { path: 'SKILL.md', size: 40, sha256: 'x', binary: false, executable: false },
    { path: 'scripts/run.sh', size: 2048, sha256: 'y', binary: false, executable: true },
  ],
  alerts,
  totalBytes: 2088,
  digest: name.length.toString(16).padStart(64, 'd'),
  ...over,
});

const row = (name: string, alerts: GithubAlert[] = [], over: Partial<GithubPreview> = {}): BatchRow => ({ path: `skills/${name}`, name, preview: preview(name, alerts, over) });
const failed = (name: string, error: BatchRow['error']): BatchRow => ({ path: `skills/${name}`, name, error: error! });

const chooseView = (over: Partial<Parameters<typeof ChooseView>[0]> = {}) =>
  html(createElement(ChooseView, { choose: choose(), picks: [], busy: false, progress: null, error: null, onToggle: () => {}, onToggleAll: () => {}, onPreview: () => {}, onBack: () => {}, ...over }));

const batchView = (rows: BatchRow[], include: Record<string, boolean>, over: Partial<Parameters<typeof BatchPreviewView>[0]> = {}) =>
  html(createElement(BatchPreviewView, { scope: 'user', rows, include, busy: false, error: null, onToggle: () => {}, onInstall: () => {}, onBack: () => {}, onCancel: () => {}, ...over }));

/** A tag <input> da caixa de uma skill do lote (pelo nome acessível). */
const boxOf = (out: string, name: string): string => out.match(new RegExp(`<input[^>]*aria-label="Instalar ${name}"[^>]*>`))?.[0] ?? '';

describe('várias skills do GitHub: marcar na lista', () => {
  const all = skillNames.map((n) => `skills/${n}`);

  it('marcar e desmarcar uma skill', () => {
    expect(togglePick([], 'a')).toEqual(['a']);
    expect(togglePick(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('"Selecionar todas": nenhuma ou só algumas → todas; todas → nenhuma', () => {
    expect(togglePickAll(all, [])).toEqual(all);
    expect(togglePickAll(all, [all[0]!, all[3]!])).toEqual(all);
    expect(togglePickAll(all, all)).toEqual([]);
    expect(togglePickAll([], [])).toEqual([]);
  });

  it('lista: uma caixa por skill, "Selecionar todas", contagem e o botão da prévia só com alguma marcada', () => {
    const none = chooseView();
    expect(none).toContain('Este link tem 8 skills');
    expect(none).toContain('Selecionar todas');
    expect(none).toContain('0 de 8 marcadas');
    expect((none.match(/<input type="checkbox"/g) ?? []).length).toBe(9); // 8 + "Selecionar todas"
    expect(none).toMatch(/btn-primary"[^>]*disabled[^>]*>Ver prévia \(0\)</);
    expect(none).toContain('faz gsap-core');

    const two = chooseView({ picks: ['skills/gsap-core', 'skills/gsap-react'] });
    expect(two).toContain('2 de 8 marcadas');
    expect((two.match(/gh-pick is-on/g) ?? []).length).toBe(2);
    expect(two).toMatch(/btn-primary"[^>]*>Ver prévia \(2\)</);
    expect(two).not.toMatch(/btn-primary"[^>]*disabled/);
  });

  it('todas marcadas: "Selecionar todas" marcada e "Ver prévia (8)"', () => {
    const out = chooseView({ picks: skillNames.map((n) => `skills/${n}`) });
    expect(out).toContain('8 de 8 marcadas');
    expect(out).toContain('Ver prévia (8)');
    expect(out.match(/<input type="checkbox" checked=""/g) ?? []).toHaveLength(9);
  });

  it('buscando as prévias: andamento e tudo travado', () => {
    const out = chooseView({ picks: all, busy: true, progress: { done: 3, total: 8 } });
    expect(out).toContain('Buscando 3 de 8…');
    expect(out).toMatch(/btn-primary"[^>]*disabled/);
    expect(out.match(/disabled=""/g)!.length).toBeGreaterThan(9);
  });

  it('só uma marcada, ainda sem andamento: "Buscando…"', () => {
    expect(chooseView({ picks: ['skills/gsap-core'], busy: true })).toContain('Buscando…');
  });
});

describe('várias skills do GitHub: quais entram no lote', () => {
  const rows = [row('gsap-core'), row('gsap-hooks', [alert('danger', 'hooks')]), row('gsap-plugins', [alert('warn')]), failed('gsap-x', { kind: 'other', message: 'não achei' })];

  it('nasce marcada a que dá para instalar e não tem perigo; a de perigo e a sem prévia nascem desmarcadas', () => {
    expect(defaultInclude('user', rows)).toEqual({ 'skills/gsap-core': true, 'skills/gsap-hooks': false, 'skills/gsap-plugins': true, 'skills/gsap-x': false });
  });

  it('nome de pasta que não vale no escopo: não nasce marcada e nunca vai no lote', () => {
    const bad = [row('GSAP-Core'), row('gsap-ok')];
    expect(rowNameOk('library', bad[0]!)).toBe(false);
    expect(rowNameOk('user', bad[0]!)).toBe(true);
    expect(defaultInclude('library', bad)).toEqual({ 'skills/GSAP-Core': false, 'skills/gsap-ok': true });
    expect(batchItems('library', bad, { 'skills/GSAP-Core': true, 'skills/gsap-ok': true }).map((i) => i.name)).toEqual(['gsap-ok']);
  });

  it('o lote leva só as marcadas, cada uma com o ref, o commit e o digest da própria prévia', () => {
    const other = row('gsap-timeline', [], { source: { ...preview('gsap-timeline').source, sha: SHA_B, ref: 'v3' } });
    const items = batchItems('user', [rows[0]!, other, rows[1]!, rows[3]!], { 'skills/gsap-core': true, 'skills/gsap-timeline': true, 'skills/gsap-hooks': false, 'skills/gsap-x': true });
    expect(items).toEqual<GithubBatchItem[]>([
      { path: 'skills/gsap-core', ref: 'main', sha: SHA_A, digest: rows[0]!.preview!.digest, name: 'gsap-core' },
      { path: 'skills/gsap-timeline', ref: 'v3', sha: SHA_B, digest: other.preview!.digest, name: 'gsap-timeline' },
    ]);
  });

  it('o corpo do lote passa no schema do servidor (mesmo link, ref/commit/digest/nome de cada item)', () => {
    const items = batchItems('project', rows, defaultInclude('project', rows));
    const body = { scope: 'project', projectId: 'C--proj', url: 'https://github.com/greensock/gsap-skills', items };
    expect(GitHubInstallBatchInput.parse(body).items).toHaveLength(2);
    expect(() => GitHubInstallBatchInput.parse({ ...body, items: [] })).toThrow(); // lote vazio o servidor recusa: a tela nem deixa enviar
  });

  it('a de perigo só entra se o usuário marcar de novo', () => {
    const include = defaultInclude('user', rows);
    expect(batchItems('user', rows, include).map((i) => i.name)).toEqual(['gsap-core', 'gsap-plugins']);
    expect(batchItems('user', rows, { ...include, 'skills/gsap-hooks': true }).map((i) => i.name)).toEqual(['gsap-core', 'gsap-hooks', 'gsap-plugins']);
  });

  it('alertas somados por nível (de todas, marcadas ou não) e o nível mais grave de cada lista', () => {
    expect(alertTotals([row('a', [alert('danger'), alert('warn'), alert('warn')]), row('b', [alert('info')]), failed('c', { kind: 'changed' })])).toEqual({ danger: 1, warn: 2, info: 1 });
    expect(alertTotals([])).toEqual({ danger: 0, warn: 0, info: 0 });
    expect(worstLevel([alert('info'), alert('warn')])).toBe('warn');
    expect(worstLevel([alert('warn'), alert('danger')])).toBe('danger');
    expect(worstLevel([])).toBeNull();
  });
});

describe('várias skills do GitHub: prévia do lote', () => {
  const rows = [
    row('gsap-core'),
    row('gsap-hooks', [alert('danger', 'o frontmatter tem `hooks`: roda comando')]),
    row('gsap-plugins', [alert('warn', 'script na pasta'), alert('info', 'aviso')]),
    failed('gsap-x', { kind: 'rate', clock: '15:30' }),
  ];
  const include = defaultInclude('user', rows);

  it('alertas somados no topo, com o nível escrito, e o aviso de que a de perigo vem desmarcada', () => {
    const out = batchView(rows, include);
    expect(out).toContain('Prévia de 4 skills');
    expect(out).toContain('greensock/gsap-skills · main');
    expect(out).toContain('Alertas (3)');
    expect(out).toContain('Perigo 1');
    expect(out).toContain('Atenção 1');
    expect(out).toContain('Aviso 1');
    expect(out).toContain('Skills com alerta de perigo vêm desmarcadas (1)');
    expect(out.indexOf('Alertas (3)')).toBeLessThan(out.indexOf('gh-batch'));
  });

  it('sem alerta nenhum: diz que a leitura continua sendo sua e não avisa de perigo', () => {
    const out = batchView([row('a'), row('b')], { 'skills/a': true, 'skills/b': true });
    expect(out).toContain('Alertas (0)');
    expect(out).toContain('Leia o SKILL.md mesmo assim');
    expect(out).not.toContain('vêm desmarcadas');
  });

  it('a nota de perigo só aparece enquanto houver skill de perigo fora do lote, e o N acompanha', () => {
    const two = [...rows.slice(0, 3), row('gsap-eval', [alert('danger', 'roda `eval`')])];
    const base = defaultInclude('user', two);
    expect(batchView(two, base)).toContain('vêm desmarcadas (2)');
    expect(batchView(two, { ...base, 'skills/gsap-hooks': true })).toContain('vêm desmarcadas (1)');
    // Todas as de perigo marcadas: nada mais a avisar (o alerta e o "Perigo:" da linha seguem).
    const all = batchView(two, { ...base, 'skills/gsap-hooks': true, 'skills/gsap-eval': true });
    expect(all).not.toContain('vêm desmarcadas');
    expect(all).not.toContain('gh-warn');
    expect(all).toContain('Perigo 2');
    expect(all).toContain('Perigo: marque só se leu os alertas');
    // Desmarcou uma de novo: a nota volta.
    expect(batchView(two, { ...base, 'skills/gsap-hooks': true, 'skills/gsap-eval': false })).toContain('vêm desmarcadas (1)');
  });

  it('dangerOutCount: perigo desmarcado ou com nome que não vale no escopo conta; sem prévia e sem perigo não', () => {
    const bad = [row('GSAP-Danger', [alert('danger')]), row('gsap-hooks', [alert('danger')]), row('gsap-warn', [alert('warn')]), failed('gsap-x', { kind: 'changed' })];
    const on = { 'skills/GSAP-Danger': true, 'skills/gsap-hooks': true, 'skills/gsap-warn': false };
    expect(dangerOutCount('user', bad, on)).toBe(0);
    expect(dangerOutCount('library', bad, on)).toBe(1); // nome em maiúsculas não vale na biblioteca: nunca vai no lote
    expect(dangerOutCount('user', bad, { ...on, 'skills/gsap-hooks': false })).toBe(1);
    expect(dangerOutCount('user', [], {})).toBe(0);
  });

  it('uma linha por skill: caixa fora do acordeão, desmarcada na de perigo e marcada nas outras', () => {
    const out = batchView(rows, include);
    expect(boxOf(out, 'gsap-core')).toContain('checked=""');
    expect(boxOf(out, 'gsap-plugins')).toContain('checked=""');
    expect(boxOf(out, 'gsap-hooks')).not.toContain('checked=""');
    expect(boxOf(out, 'gsap-hooks')).not.toContain('disabled');
    // A caixa fica antes do <details> da própria skill (clicar nela não abre nem fecha o acordeão).
    expect(out.indexOf(boxOf(out, 'gsap-core'))).toBeLessThan(out.indexOf('<details'));
  });

  it('a de perigo já vem aberta e avisada; as outras fechadas; o perigo marcado de novo fica marcado', () => {
    const out = batchView(rows, include);
    expect((out.match(/<details open=""/g) ?? []).length).toBe(1);
    expect(out).toContain('Perigo: marque só se leu os alertas e quer instalar mesmo assim.');
    expect(out).toContain('<code>hooks</code>');
    expect(boxOf(batchView(rows, { ...include, 'skills/gsap-hooks': true }), 'gsap-hooks')).toContain('checked=""');
  });

  it('dentro do acordeão: alertas, SKILL.md como texto e os arquivos, como na prévia de uma skill', () => {
    const out = batchView([row('gsap-core', [], { skillMd: '<script>alert(1)</script>' })], { 'skills/gsap-core': true });
    expect(out).toContain('scripts/run.sh');
    expect(out).toContain('>script<');
    expect(out).toContain('greensock/gsap-skills · main · commit aaaaaaa');
    expect(out).toContain('Pasta: skills/gsap-core');
    expect(out).toContain('Arquivos: 2 · 2.0 KB');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('skill sem prévia (limite do GitHub): sem caixa, com o motivo; as outras seguem', () => {
    const out = batchView(rows, include);
    expect(out).toContain('sem prévia');
    expect(out).toContain('depois das 15:30');
    expect(out).not.toContain('aria-label="Instalar gsap-x"');
  });

  it('"Instalar N" conta só as marcadas; sem nenhuma, o botão trava; instalando mostra o andamento', () => {
    expect(batchView(rows, include)).toMatch(/btn-primary"[^>]*>Instalar 2</);
    expect(batchView(rows, { ...include, 'skills/gsap-hooks': true })).toContain('>Instalar 3<');
    expect(batchView(rows, {})).toMatch(/btn-primary"[^>]*disabled[^>]*>Instalar 0</);
    const busy = batchView(rows, include, { busy: true });
    expect(busy).toMatch(/btn-primary"[^>]*disabled[^>]*>Instalando 2 skills…</);
    expect(busy).not.toContain('>Instalando…<');
    expect(busy).toContain('aria-label="Instalar gsap-hooks"');
    expect(boxOf(busy, 'gsap-core')).toContain('disabled');
  });

  it('instalando: o N é o das skills do lote (1 no singular; o perigo marcado entra na conta)', () => {
    expect(batchView(rows, { 'skills/gsap-core': true }, { busy: true })).toContain('>Instalando 1 skill…<');
    expect(batchView(rows, { ...include, 'skills/gsap-hooks': true }, { busy: true })).toContain('>Instalando 3 skills…<');
  });

  it.each([
    ['pt-BR', 'Instalando 1 skill…', 'Instalando 4 skills…'],
    ['en', 'Installing 1 skill…', 'Installing 4 skills…'],
    ['es', 'Instalando 1 skill…', 'Instalando 4 skills…'],
  ] as const)('botão do lote instalando, em %s', (id, one, other) => {
    const dict = skillgh[id] as Record<string, string>;
    expect(dict['gh.batchInstallingOne']).toBe(one);
    expect(dict['gh.batchInstallingOther']!.replace('{n}', '4')).toBe(other);
  });

  it('nome de pasta que não vale na biblioteca: caixa travada e o caminho para trocar o nome', () => {
    const bad = [row('GSAP-Core'), row('gsap-ok')];
    const out = batchView(bad, defaultInclude('library', bad), { scope: 'library' });
    expect(boxOf(out, 'GSAP-Core')).toContain('disabled');
    expect(boxOf(out, 'GSAP-Core')).not.toContain('checked');
    expect(out).toContain('Instale só esta skill para poder trocar o nome');
    expect(out).toContain('Instalar não ativa as skills');
    expect(out).toContain('myco:&lt;nome&gt;');
    expect(out).toMatch(/btn-primary"[^>]*>Instalar 1</);
  });

  it('conta e projeto: instalar não ativa e manda marcar na ficha; erro de rede aparece', () => {
    const out = batchView(rows, include, { error: { kind: 'other', message: 'sem rede' } });
    expect(out).toContain('marque cada skill na ficha');
    expect(out).not.toContain('myco:');
    expect(out).toContain('sem rede');
  });
});

describe('várias skills do GitHub: resultado por skill', () => {
  const items: GithubBatchItem[] = ['gsap-core', 'gsap-hooks', 'gsap-x', 'gsap-y'].map((name) => ({ path: `skills/${name}`, ref: 'main', sha: SHA_A, digest: 'd'.repeat(64), name }));
  const results: GithubBatchResult[] = [
    { path: 'skills/gsap-core', status: 'installed', name: 'gsap-core', sha: SHA_B, digest: 'd'.repeat(64) },
    { path: 'skills/gsap-hooks', status: 'error', error: 'já existe a skill gsap-hooks' },
    { path: 'skills/gsap-x', status: 'error', error: 'a skill mudou desde a prévia', code: 'changed' },
  ];

  it('um resultado por item enviado, na ordem; o que o servidor não respondeu vira falha (não some)', () => {
    const out = batchOutcomes(items, results, 'sem resposta');
    expect(out.map((o) => [o.path, o.ok])).toEqual([
      ['skills/gsap-core', true],
      ['skills/gsap-hooks', false],
      ['skills/gsap-x', false],
      ['skills/gsap-y', false],
    ]);
    expect(out[0]).toMatchObject({ ok: true, sha: SHA_B });
    expect(out[1]).toMatchObject({ error: { kind: 'other', message: 'já existe a skill gsap-hooks' } });
    expect(out[2]).toMatchObject({ error: { kind: 'changed' } });
    expect(out[3]).toMatchObject({ name: 'gsap-y', error: { kind: 'other', message: 'sem resposta' } });
  });

  it('o código da falha vira o texto que a tela já sabe explicar', () => {
    expect(batchErrorKind({ path: 'p', status: 'error', error: 'x', code: 'modified' })).toEqual({ kind: 'modified' });
    expect(batchErrorKind({ path: 'p', status: 'error', error: 'x', code: 'rate-limited', resetAt: '2026-11-18T15:30:00.000Z' })).toEqual({ kind: 'rate', clock: expect.any(String) });
    expect(batchErrorKind({ path: 'p', status: 'error', error: 'x', code: 'rate-limited' })).toEqual({ kind: 'rate', clock: null });
    expect(batchErrorKind({ path: 'p', status: 'error', error: 'erro interno' })).toEqual({ kind: 'other', message: 'erro interno' });
  });

  const done = (outcomes: BatchOutcome[], scope: 'user' | 'library' = 'user') => html(createElement(BatchDoneView, { scope, outcomes, onRetry: () => {}, onClose: () => {} }));

  it('lista o que instalou (com o commit) e o que falhou (com o motivo), com texto além do símbolo', () => {
    const out = done(batchOutcomes(items, results, 'sem resposta'));
    expect(out).toContain('1 de 4 instaladas');
    expect(out).toContain('Instalada');
    expect(out).toContain('Falhou');
    expect(out).toContain('bbbbbbb');
    expect(out).toContain('já existe a skill gsap-hooks');
    expect(out).toContain('O repositório mudou desde a prévia');
    expect(out).toContain('sem resposta'); // o texto vem de quem chama
    expect(out).toContain('gh-result is-ok');
    expect(out).toContain('gh-result is-fail');
    expect(out).toContain('Voltar à lista');
    expect(out).toContain('marque cada skill na ficha');
  });

  it('tudo instalado: sem "Voltar à lista"; na biblioteca diz o nome que se marca; nada instalado: sem a nota', () => {
    const ok = (name: string): BatchOutcome => ({ path: `skills/${name}`, name, ok: true, sha: SHA_A });
    const all = done([ok('a'), ok('b')], 'library');
    expect(all).toContain('2 de 2 instaladas');
    expect(all).not.toContain('Voltar à lista');
    expect(all).toContain('myco:&lt;nome&gt;');
    const none = done([{ path: 'p', name: 'a', ok: false, error: { kind: 'other', message: 'x' } }]);
    expect(none).toContain('0 de 1 instaladas');
    expect(none).not.toContain('Instalar não ativa');
  });
});

describe('várias skills do GitHub: prévias em sequência (limite de consultas)', () => {
  const NOT_SKILL = 'não é uma skill';
  const rate = () => new ApiError('limite', null, null, { resetAt: '2026-11-18T15:30:00.000Z' }, 429);
  const stale = () => new ApiError('mudou', 'changed', null, {}, 409);
  const sk = (names: string[]) => names.map((name) => ({ path: `skills/${name}`, name }));
  /** Um GitHub de mentira: cada skill responde o que a tabela manda (prévia, `choose` ou erro) e as consultas ficam anotadas. */
  const github = (table: Record<string, GithubPreview | GithubChoose | Error>) => {
    const asked: string[] = [];
    const fetchPreview = async (path: string) => {
      asked.push(path);
      const r = table[path.replace('skills/', '')];
      if (!r) throw new Error(`sem resposta para ${path}`);
      if (r instanceof Error) throw r;
      return r;
    };
    return { asked, fetchPreview };
  };

  it('limite no meio: as que faltam viram "sem prévia" com o aviso do limite e o GitHub não é mais consultado', async () => {
    const gh = github({ a: preview('a'), b: rate(), c: preview('c'), d: preview('d') });
    const progress: Array<[number, number]> = [];
    const rows = await previewRows(sk(['a', 'b', 'c', 'd']), gh.fetchPreview, NOT_SKILL, (done, total) => progress.push([done, total]));

    expect(gh.asked).toEqual(['skills/a', 'skills/b']);
    expect(rows!.map((r) => [r.path, !!r.preview, r.error?.kind])).toEqual([
      ['skills/a', true, undefined],
      ['skills/b', false, 'rate'],
      ['skills/c', false, 'rate'],
      ['skills/d', false, 'rate'],
    ]);
    // Todas as sem prévia levam o MESMO aviso (hora em que o limite volta) e o nome da lista, já que não há prévia para dar o nome.
    expect(rows![1]).toMatchObject({ name: 'b', error: { kind: 'rate', clock: expect.any(String) } });
    expect(rows![3]).toEqual({ path: 'skills/d', name: 'd', error: rows![1]!.error });
    // O andamento conta as consultas feitas (a 1ª e a que bateu no limite); as puladas não mexem nele.
    expect(progress).toEqual([[0, 4], [1, 4], [2, 4]]);
  });

  it('o limite sem hora (GitHub não disse quando volta) também para as seguintes', async () => {
    const gh = github({ a: new ApiError('limite', null, null, {}, 429), b: preview('b') });
    const rows = await previewRows(sk(['a', 'b']), gh.fetchPreview, NOT_SKILL);
    expect(gh.asked).toEqual(['skills/a']);
    expect(rows!.map((r) => r.error)).toEqual([{ kind: 'rate', clock: null }, { kind: 'rate', clock: null }]);
  });

  it('falha isolada (skill mudou, erro de rede, link que não é skill) não para as outras', async () => {
    const gh = github({ a: preview('a'), b: stale(), c: new Error('Failed to fetch'), d: { kind: 'choose', source: choose().source, skills: [] }, e: preview('e') });
    const rows = await previewRows(sk(['a', 'b', 'c', 'd', 'e']), gh.fetchPreview, NOT_SKILL);

    expect(gh.asked).toEqual(['skills/a', 'skills/b', 'skills/c', 'skills/d', 'skills/e']);
    expect(rows!.map((r) => r.error ?? 'ok')).toEqual(['ok', { kind: 'changed' }, { kind: 'other', message: 'Failed to fetch' }, { kind: 'other', message: NOT_SKILL }, 'ok']);
    expect(rows![4]!.preview?.name).toBe('e');
  });

  it('falha isolada e depois o limite: a falha ficou como estava e só as seguintes ao limite pulam', async () => {
    const gh = github({ a: stale(), b: preview('b'), c: rate(), d: preview('d') });
    const rows = await previewRows(sk(['a', 'b', 'c', 'd']), gh.fetchPreview, NOT_SKILL);
    expect(gh.asked).toEqual(['skills/a', 'skills/b', 'skills/c']);
    expect(rows!.map((r) => r.error?.kind ?? 'ok')).toEqual(['changed', 'ok', 'rate', 'rate']);
  });

  it('o nome da linha vem da prévia quando ela veio (o nome do SKILL.md pode ser outro que o da pasta)', async () => {
    const gh = github({ pasta: preview('nome-do-skill-md') });
    const rows = await previewRows(sk(['pasta']), gh.fetchPreview, NOT_SKILL);
    expect(rows![0]).toMatchObject({ path: 'skills/pasta', name: 'nome-do-skill-md' });
  });

  it('sem pareamento (recusa sem texto): devolve null na 1ª e não consulta mais ninguém', async () => {
    const gh = github({ a: new ApiError('', 'needs-pairing', null, {}, 403), b: preview('b') });
    expect(await previewRows(sk(['a', 'b']), gh.fetchPreview, NOT_SKILL)).toBeNull();
    expect(gh.asked).toEqual(['skills/a']);
  });

  it('as linhas montadas alimentam a prévia do lote: limite e skill mudada sem caixa e com o motivo; só a ok nasce marcada', async () => {
    const gh = github({ a: preview('a'), b: stale(), c: rate() });
    const rows = (await previewRows(sk(['a', 'b', 'c', 'd']), gh.fetchPreview, NOT_SKILL))!;
    const include = defaultInclude('user', rows);
    expect(include).toEqual({ 'skills/a': true, 'skills/b': false, 'skills/c': false, 'skills/d': false });
    expect(batchItems('user', rows, include).map((i) => i.path)).toEqual(['skills/a']);

    const out = batchView(rows, include);
    expect(out).toContain('Prévia de 4 skills');
    expect(boxOf(out, 'a')).toContain('checked=""');
    expect(out).not.toContain('aria-label="Instalar b"');
    expect(out).not.toContain('aria-label="Instalar c"');
    expect(out).not.toContain('aria-label="Instalar d"');
    expect(out).toContain('O repositório mudou desde a prévia');
    expect((out.match(/depois das /g) ?? []).length).toBe(2); // c e d, a que pulou
    expect(out).toMatch(/btn-primary"[^>]*>Instalar 1</);
  });
});

describe('várias skills do GitHub: envio do lote e voltar à lista', () => {
  const items: GithubBatchItem[] = ['a', 'b', 'c'].map((name) => ({ path: `skills/${name}`, ref: 'main', sha: SHA_A, digest: 'd'.repeat(64), name }));
  const sendOk = (results: GithubBatchResult[]) => async () => ({ results });
  const sendFail = (e: Error) => async (): Promise<{ results: GithubBatchResult[] }> => {
    throw e;
  };

  it('manda os itens como estão e devolve um resultado por skill, com "instalou algo" para quem relê a lista', async () => {
    let sent: GithubBatchItem[] = [];
    const run = await runBatch(
      items,
      async (list) => {
        sent = list;
        return {
          results: [
            { path: 'skills/a', status: 'installed', name: 'a', sha: SHA_B, digest: 'd'.repeat(64) },
            { path: 'skills/b', status: 'error', error: 'a skill mudou desde a prévia', code: 'changed' },
            { path: 'skills/c', status: 'error', error: 'limite', code: 'rate-limited' },
          ],
        };
      },
      'sem resposta',
    );
    expect(sent).toBe(items);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.installed).toBe(true);
    expect(run.outcomes.map((o) => [o.path, o.ok])).toEqual([['skills/a', true], ['skills/b', false], ['skills/c', false]]);
    expect(run.outcomes[1]).toMatchObject({ error: { kind: 'changed' } });
    expect(run.outcomes[2]).toMatchObject({ error: { kind: 'rate', clock: null } });
  });

  it('nenhuma instalou: `installed` falso (a lista não é relida à toa)', async () => {
    const run = await runBatch(items.slice(0, 1), sendOk([{ path: 'skills/a', status: 'error', error: 'já existe a skill a' }]), 'sem resposta');
    expect(run).toMatchObject({ ok: true, installed: false });
  });

  it('erro de rede: o envio inteiro falha e o motivo fica na prévia (nenhuma linha vira "falhou")', async () => {
    expect(await runBatch(items, sendFail(new TypeError('Failed to fetch')), 'sem resposta')).toEqual({ ok: false, error: { kind: 'other', message: 'Failed to fetch' } });
  });

  it('o servidor recusa o corpo inteiro: mostra o texto dele; limite e prévia velha têm o texto que a tela já sabe explicar', async () => {
    expect(await runBatch(items, sendFail(new ApiError('lote vazio', null, null, {}, 400)), 'x')).toEqual({ ok: false, error: { kind: 'other', message: 'lote vazio' } });
    expect(await runBatch(items, sendFail(new ApiError('limite', null, null, { resetAt: '2026-11-18T15:30:00.000Z' }, 429)), 'x')).toMatchObject({ ok: false, error: { kind: 'rate', clock: expect.any(String) } });
    expect(await runBatch(items, sendFail(new ApiError('mudou', 'changed', null, {}, 409)), 'x')).toEqual({ ok: false, error: { kind: 'changed' } });
  });

  it('sem pareamento: erro nulo (o aviso do App explica), não uma tela de resultado', async () => {
    expect(await runBatch(items, sendFail(new ApiError('', 'needs-pairing', null, {}, 403)), 'x')).toEqual({ ok: false, error: null });
  });

  it('o erro do envio aparece na prévia do lote, com as linhas e as caixas como estavam', async () => {
    const rows = [row('a'), row('b')];
    const include = defaultInclude('user', rows);
    const run = await runBatch(items, sendFail(new TypeError('Failed to fetch')), 'x');
    const out = batchView(rows, include, { error: run.ok ? null : run.error });
    expect(out).toContain('Failed to fetch');
    expect(boxOf(out, 'a')).toContain('checked=""');
    expect(boxOf(out, 'b')).toContain('checked=""');
    expect(out).toMatch(/btn-primary"[^>]*>Instalar 2</);
  });

  const outcomes = (): BatchOutcome[] => [
    { path: 'skills/gsap-core', name: 'gsap-core', ok: true, sha: SHA_A },
    { path: 'skills/gsap-timeline', name: 'gsap-timeline', ok: false, error: { kind: 'changed' } },
    { path: 'skills/gsap-react', name: 'gsap-react', ok: true, sha: SHA_A },
    { path: 'skills/gsap-utils', name: 'gsap-utils', ok: false, error: { kind: 'rate', clock: null } },
  ];

  it('"Voltar à lista" marca só as que falharam, na ordem do resultado', () => {
    expect(retryPicks(outcomes())).toEqual(['skills/gsap-timeline', 'skills/gsap-utils']);
  });

  it('tudo instalado: nada marcado; nada instalado: todas marcadas', () => {
    const [ok, bad] = [outcomes()[0]!, outcomes()[1]!];
    expect(retryPicks([ok])).toEqual([]);
    expect(retryPicks([])).toEqual([]);
    expect(retryPicks([bad, { ...bad, path: 'skills/outra' }])).toEqual(['skills/gsap-timeline', 'skills/outra']);
  });

  it('a lista volta com as que falharam marcadas, as instaladas desmarcadas, e o botão da prévia conta só as falhas', () => {
    const picks = retryPicks(outcomes());
    const out = chooseView({ picks });
    expect(out).toContain('2 de 8 marcadas');
    expect(out).toMatch(/btn-primary"[^>]*>Ver prévia \(2\)</);
    // Na lista a caixa fica dentro do <label> da skill (o `is-on` diz se está marcada).
    const marked = (name: string) => out.split('<li').find((li) => li.includes(`<strong>${name}</strong>`))?.includes('gh-pick is-on');
    expect(['gsap-core', 'gsap-timeline', 'gsap-react', 'gsap-utils'].map(marked)).toEqual([false, true, false, true]);
    expect(out.match(/<input type="checkbox" checked=""/g) ?? []).toHaveLength(2);
  });
});
