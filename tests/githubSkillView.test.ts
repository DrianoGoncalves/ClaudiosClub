import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError, type GithubAlert, type GithubCheck, type GithubChoose, type GithubDiffItem, type GithubPreview, type GithubSkillStatus } from '../client/src/api';
import { ChooseView, PreviewView } from '../client/src/skills/GithubInstall';
import { GithubBadges, OriginView } from '../client/src/skills/GithubOrigin';
import { AlertList, DiffList, FileList } from '../client/src/skills/GithubParts';
import {
  alertRows,
  diffCounts,
  errorText,
  folderNameOk,
  frontmatterText,
  githubError,
  hasDanger,
  hasNewVersion,
  formatSize,
  patchLines,
  repoLabel,
  safeRepoUrl,
  shortSha,
  sortAlerts,
} from '../client/src/skills/githubSkill';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

const alert = (level: GithubAlert['level'], message: string, code: string = level): GithubAlert => ({ level, code, message });

const preview = (over: Partial<GithubPreview> = {}): GithubPreview => ({
  kind: 'preview',
  source: { owner: 'acme', repo: 'skills', ref: 'main', sha: SHA_A, path: 'revisor', treeSha: SHA_B, url: 'https://github.com/acme/skills' },
  name: 'revisor',
  skillMd: '---\nname: revisor\n---\n# Revisor',
  frontmatter: { name: 'revisor' },
  files: [
    { path: 'SKILL.md', size: 40, sha256: 'x', binary: false, executable: false },
    { path: 'scripts/run.sh', size: 2048, sha256: 'y', binary: false, executable: true },
    { path: 'logo.png', size: 3 * 1024 * 1024, sha256: 'z', binary: true, executable: false },
  ],
  alerts: [],
  totalBytes: 3 * 1024 * 1024 + 2088,
  digest: 'd'.repeat(64),
  ...over,
});

const previewView = (over: Partial<Parameters<typeof PreviewView>[0]> = {}) =>
  html(
    createElement(PreviewView, {
      preview: preview(),
      scope: 'user',
      name: 'revisor',
      ack: false,
      busy: false,
      error: null,
      onName: () => {},
      onAck: () => {},
      onInstall: () => {},
      onRefresh: () => {},
      onBack: () => {},
      onCancel: () => {},
      ...over,
    }),
  );

describe('skills do GitHub: regras puras', () => {
  it('commit curto: 7 caracteres', () => {
    expect(shortSha(SHA_A)).toBe('aaaaaaa');
  });

  it('link da origem: só https do github.com, sem usuário, senha ou porta', () => {
    expect(safeRepoUrl('https://github.com/acme/skills/tree/main/revisor')).toBe('https://github.com/acme/skills/tree/main/revisor');
    expect(safeRepoUrl('https://www.github.com/acme/skills')).not.toBeNull();
    for (const bad of ['javascript:alert(1)', 'http://github.com/a/b', 'https://evil.com/a/b', 'https://github.com.evil.com/a/b', 'https://u:p@github.com/a/b', 'https://github.com:8443/a/b', 'não é link']) {
      expect(safeRepoUrl(bad)).toBeNull();
    }
  });

  it('rótulo do repositório: dono/repo sem .git; link ruim não tem', () => {
    expect(repoLabel('https://github.com/acme/skills/tree/main/revisor')).toBe('acme/skills');
    expect(repoLabel('https://github.com/acme/skills.git')).toBe('acme/skills');
    expect(repoLabel('https://evil.com/acme/skills')).toBeNull();
  });

  it('alertas: perigo primeiro, depois atenção, depois aviso (estável); só perigo pede ciência', () => {
    const list = [alert('info', 'i1'), alert('warn', 'w1'), alert('danger', 'd1'), alert('warn', 'w2'), alert('danger', 'd2')];
    expect(sortAlerts(list).map((a) => a.message)).toEqual(['d1', 'd2', 'w1', 'w2', 'i1']);
    expect(list[0]!.message).toBe('i1');
    expect(hasDanger(list)).toBe(true);
    expect(hasDanger([alert('warn', 'w'), alert('info', 'i')])).toBe(false);
    expect(hasDanger([])).toBe(false);
  });

  it('alertas repetidos por arquivo (script, binário) viram uma linha a partir de 3; abaixo disso ficam separados', () => {
    const exec = (file: string): GithubAlert => ({ level: 'warn', code: 'executable', message: `${file} é script`, file });
    const rows = alertRows([exec('a.py'), alert('danger', 'hooks'), exec('b.py'), exec('c.py'), { level: 'warn', code: 'binary', message: 'x.png é binário', file: 'x.png' }]);
    expect(rows.map((r) => r.kind)).toEqual(['one', 'group', 'one']);
    expect(rows[0]).toMatchObject({ kind: 'one', alert: { message: 'hooks' } });
    expect(rows[1]).toEqual({ kind: 'group', code: 'executable', level: 'warn', files: ['a.py', 'b.py', 'c.py'] });
    expect(alertRows([exec('a.py'), exec('b.py')]).map((r) => r.kind)).toEqual(['one', 'one']);
    // alerta de outro tipo nunca se agrupa, mesmo repetido
    expect(alertRows([alert('warn', 'm', 'allowed-tools'), alert('warn', 'm', 'allowed-tools'), alert('warn', 'm', 'allowed-tools')])).toHaveLength(3);
  });

  it('nome da pasta por escopo: biblioteca minúscula; a conta não aceita synced; barra e ponto nunca', () => {
    expect(folderNameOk('library', 'revisor-ui')).toBe(true);
    expect(folderNameOk('library', 'Revisor')).toBe(false);
    expect(folderNameOk('project', 'Revisor_UI')).toBe(true);
    expect(folderNameOk('user', 'synced')).toBe(false);
    expect(folderNameOk('user', 'Synced')).toBe(false);
    expect(folderNameOk('project', 'synced')).toBe(true);
    for (const bad of ['', '..', 'a/b', 'a\\b', '.oculta', '-x', 'a'.repeat(65)]) {
      for (const scope of ['library', 'user', 'project'] as const) expect(folderNameOk(scope, bad)).toBe(false);
    }
  });

  it('tamanhos legíveis', () => {
    expect(formatSize(12)).toBe('12 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('patch unificado em linhas: trecho, entra, sai e contexto', () => {
    expect(patchLines('@@ -1,2 +1,2 @@\n a\n-b\n+c\n')).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'c' },
    ]);
  });

  it('contagem do diff e valor do cabeçalho em uma linha curta', () => {
    const diff: GithubDiffItem[] = [
      { path: 'a', status: 'added', binary: false, patch: '' },
      { path: 'b', status: 'changed', binary: false, patch: '' },
      { path: 'c', status: 'changed', binary: false, patch: '' },
      { path: 'd', status: 'removed', binary: false, patch: '' },
    ];
    expect(diffCounts(diff)).toEqual({ added: 1, removed: 1, changed: 2 });
    expect(frontmatterText(null)).toBe('—');
    expect(frontmatterText(['Bash', 'Read'])).toBe('["Bash","Read"]');
    expect(frontmatterText('x'.repeat(300))).toHaveLength(161);
  });

  it('erros: limite do GitHub (com a hora), prévia velha, skill mexida e o resto como veio', () => {
    const rate = new ApiError('limite', null, null, { resetAt: '2026-11-16T15:30:00.000Z' }, 429);
    const kind = githubError(rate)!;
    expect(kind.kind).toBe('rate');
    expect(errorText(kind)).toContain('60 por hora');
    expect(errorText(githubError(new ApiError('limite', null, null, {}, 429))!)).toContain('mais tarde');
    expect(kind).toEqual({ kind: 'rate', clock: expect.any(String) });
    expect(githubError(new ApiError('mudou', 'changed', null, {}, 409))).toEqual({ kind: 'changed' });
    expect(githubError(new ApiError('mexida', 'modified', null, {}, 409))).toEqual({ kind: 'modified' });
    expect(githubError(new ApiError('já existe a skill x', null, null, {}, 400))).toEqual({ kind: 'other', message: 'já existe a skill x' });
    expect(errorText({ kind: 'other', message: 'não achei no GitHub' })).toBe('não achei no GitHub');
    // Sem pareamento a recusa vem sem texto: nada a mostrar (o aviso do App explica).
    expect(githubError(new ApiError('', 'needs-pairing', null, {}, 403))).toBeNull();
  });
});

describe('skills do GitHub: alertas, arquivos e diff', () => {
  it('alerta: o nível vem escrito, o mais grave primeiro e a crase vira código', () => {
    const out = html(createElement(AlertList, { alerts: [alert('info', 'só aviso'), alert('danger', 'o frontmatter tem `hooks`: roda comando')] }));
    expect(out).toContain('Alertas (2)');
    expect(out.indexOf('Perigo')).toBeLessThan(out.indexOf('Aviso'));
    expect(out).toContain('<code>hooks</code>');
    expect(out).toContain('gh-alert is-danger');
  });

  it('crase solta (a sintaxe do aviso de comando embutido) não embaralha o texto', () => {
    const out = html(createElement(AlertList, { alerts: [alert('danger', 'comando que roda (!`...` ou bloco ```!)')] }));
    expect(out).toContain('<code>...</code>');
    expect(out).toContain('ou bloco ```!)');
  });

  it('sem alerta: diz que a leitura do SKILL.md continua sendo de quem instala', () => {
    const out = html(createElement(AlertList, { alerts: [] }));
    expect(out).toContain('Alertas (0)');
    expect(out).toContain('Leia o SKILL.md mesmo assim');
  });

  it('texto do repositório nunca vira HTML', () => {
    const out = html(createElement(AlertList, { alerts: [alert('warn', '<img src=x onerror=alert(1)> `a`')] }));
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('arquivos: script e binário com etiqueta, tamanho e total', () => {
    const p = preview();
    const out = html(createElement(FileList, { files: p.files, totalBytes: p.totalBytes }));
    expect(out).toContain('Arquivos (3 · 3.0 MB)');
    expect(out).toContain('scripts/run.sh');
    expect(out).toContain('>script<');
    expect(out).toContain('>binário<');
  });

  it('diff: todos os arquivos, SKILL.md aberto; muitos arquivos ficam fechados', () => {
    const item = (path: string, status: GithubDiffItem['status'] = 'changed'): GithubDiffItem => ({ path, status, binary: false, patch: '@@ -1,1 +1,1 @@\n-velho\n+novo\n' });
    const few = html(createElement(DiffList, { diff: [item('SKILL.md'), item('a.md'), item('b.md')] }));
    expect((few.match(/<details open/g) ?? []).length).toBe(3);
    const many = html(createElement(DiffList, { diff: [item('SKILL.md'), item('a.md'), item('b.md'), item('c.md', 'added')] }));
    expect((many.match(/<details open/g) ?? []).length).toBe(1);
    expect(many).toContain('gh-line is-del');
    expect(many).toContain('gh-line is-add');
    expect(many).toContain('>novo<');
  });

  it('diff: binário só com tamanho; grande demais e vazio com aviso; nenhum arquivo', () => {
    const binary: GithubDiffItem = { path: 'logo.png', status: 'changed', binary: true, before: { size: 1024, sha256: 'a' }, after: { size: 2048, sha256: 'b' } };
    const out = html(createElement(DiffList, { diff: [binary, { path: 'big.md', status: 'changed', binary: false, patch: null, tooLarge: true }, { path: 'same.md', status: 'changed', binary: false, patch: '' }] }));
    expect(out).toContain('1.0 KB → 2.0 KB');
    expect(out).toContain('grande demais');
    expect(out).toContain('Sem mudança de texto');
    expect(html(createElement(DiffList, { diff: [] }))).toContain('Nenhum arquivo muda');
  });
});

describe('skills do GitHub: prévia de instalação', () => {
  it('mostra origem, SKILL.md como texto, arquivos, nome e que instalar não ativa', () => {
    const out = previewView();
    expect(out).toContain('acme/skills · main · commit aaaaaaa');
    expect(out).toContain('Pasta: revisor');
    expect(out).toContain('# Revisor');
    expect(out).toContain('scripts/run.sh');
    expect(out).toContain('Instalar não ativa a skill');
    expect(out).toContain('marque a skill na ficha');
  });

  it('biblioteca diz o nome que se marca na ficha', () => {
    expect(previewView({ scope: 'library' })).toContain('myco:revisor');
  });

  it('SKILL.md com HTML aparece escapado', () => {
    const out = previewView({ preview: preview({ skillMd: '<script>alert(1)</script>' }) });
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('sem perigo: Instalar liberado e sem caixa de ciência', () => {
    const out = previewView({ preview: preview({ alerts: [alert('warn', 'script')] }) });
    expect(out).not.toContain('Li os alertas de perigo');
    expect(out).toMatch(/btn-primary"[^>]*>Instalar</);
    expect(out).not.toMatch(/btn-primary"[^>]*disabled[^>]*>Instalar</);
  });

  it('com perigo: Instalar travado até marcar a ciência', () => {
    const danger = preview({ alerts: [alert('danger', 'hooks')] });
    const locked = previewView({ preview: danger });
    expect(locked).toContain('Li os alertas de perigo');
    expect(locked).toMatch(/btn-primary"[^>]*disabled[^>]*>Instalar</);
    const unlocked = previewView({ preview: danger, ack: true });
    expect(unlocked).not.toMatch(/btn-primary"[^>]*disabled[^>]*>Instalar</);
  });

  it('o alerta vem antes do SKILL.md e dos arquivos', () => {
    const out = previewView({ preview: preview({ alerts: [alert('danger', 'hooks')] }) });
    expect(out.indexOf('Alertas (1)')).toBeLessThan(out.indexOf('gh-md'));
    expect(out.indexOf('Alertas (1)')).toBeLessThan(out.indexOf('Arquivos ('));
  });

  it('nome inválido trava o Instalar; instalando mostra o andamento', () => {
    const bad = previewView({ scope: 'library', name: 'Revisor UI' });
    expect(bad).toContain('Nome inválido para este escopo');
    expect(bad).toMatch(/btn-primary"[^>]*disabled[^>]*>Instalar</);
    expect(previewView({ busy: true })).toContain('Instalando…');
  });

  it('prévia velha: o botão vira "Ver prévia de novo" e o motivo aparece', () => {
    const out = previewView({ error: { kind: 'changed' } });
    expect(out).toContain('O repositório mudou desde a prévia');
    expect(out).toContain('Ver prévia de novo');
    expect(out).not.toMatch(/btn-primary"[^>]*>Instalar</);
  });

  it('link com várias skills: uma linha por skill, com a descrição', () => {
    const choose: GithubChoose = {
      kind: 'choose',
      source: { owner: 'acme', repo: 'skills', ref: 'main', sha: SHA_A },
      skills: [
        { path: 'a/um', name: 'um', description: 'faz o primeiro' },
        { path: 'b/dois', name: 'dois', description: '' },
      ],
    };
    const out = html(createElement(ChooseView, { choose, busy: false, onPick: () => {} }));
    expect(out).toContain('Este link tem 2 skills');
    expect(out).toContain('faz o primeiro');
    expect(out).toContain('sem descrição');
    expect(out).toContain('a/um');
  });
});

describe('skills do GitHub: origem da skill instalada', () => {
  const status = (over: Partial<GithubSkillStatus> = {}): GithubSkillStatus => ({
    name: 'revisor',
    origin: { url: 'https://github.com/acme/skills/tree/main/revisor', ref: 'main', sha: SHA_A, installedAt: '2026-11-10T12:00:00.000Z' },
    modified: false,
    update: null,
    ...over,
  });
  const newer = (over: Partial<Extract<GithubCheck, { upToDate: false }>> = {}): GithubCheck => ({
    upToDate: false,
    name: 'revisor',
    source: { url: 'https://github.com/acme/skills/tree/main/revisor', owner: 'acme', repo: 'skills', ref: 'main', path: 'revisor' },
    ref: 'main',
    fromSha: SHA_A,
    toSha: SHA_B,
    digest: 'd'.repeat(64),
    localModified: false,
    diff: [{ path: 'SKILL.md', status: 'changed', binary: false, patch: '@@ -1,1 +1,1 @@\n-velho\n+novo\n' }],
    frontmatter: [{ key: 'description', before: 'antes', after: 'depois' }],
    alerts: [],
    ...over,
  });
  const view = (over: Partial<Parameters<typeof OriginView>[0]> = {}) =>
    html(
      createElement(OriginView, {
        name: 'revisor',
        status: status(),
        check: null,
        phase: 'idle',
        confirm: null,
        ack: false,
        modified: false,
        notice: null,
        error: null,
        onCheck: () => {},
        onAck: () => {},
        onAsk: () => {},
        onApply: () => {},
        onRollback: () => {},
        ...over,
      }),
    );

  it('origem: link do repositório, commit curto, branch e data; sem versão nova, sem selo', () => {
    const out = view();
    expect(out).toContain('href="https://github.com/acme/skills/tree/main/revisor"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('>acme/skills<');
    expect(out).toContain('aaaaaaa');
    expect(out).toContain('>main<');
    expect(out).not.toContain('há versão nova');
    expect(out).toContain('Verificar atualização');
  });

  it('link de origem estranho (metadado mexido) fica só como texto', () => {
    const out = view({ status: status({ origin: { url: 'javascript:alert(1)', ref: 'main', sha: SHA_A, installedAt: '2026-11-10T12:00:00.000Z' } }) });
    expect(out).not.toContain('href="javascript');
    expect(out).not.toContain('<a ');
  });

  it('checagem diária achou versão nova: selo e aviso até verificar', () => {
    const out = view({ status: status({ update: { available: true, latestSha: SHA_B, checkedAt: '2026-11-16T00:00:00.000Z' } }) });
    expect(out).toContain('há versão nova');
    expect(out).toContain('Verifique para ver o que muda');
    expect(html(createElement(GithubBadges, { status: status({ update: { available: true, latestSha: SHA_B, checkedAt: 'x' } }) }))).toContain('gh-badge is-new');
  });

  it('selo velho: depois de aplicar, o commit da checagem diária já é o instalado e o "há versão nova" não aparece', () => {
    const stale = status({ origin: { url: 'https://github.com/acme/skills', ref: 'main', sha: SHA_B, installedAt: '2026-11-16T12:00:00.000Z' }, update: { available: true, latestSha: SHA_B, checkedAt: 'x' } });
    expect(hasNewVersion(stale)).toBe(false);
    expect(view({ status: stale })).not.toContain('há versão nova');
    expect(hasNewVersion(status({ update: { available: true, latestSha: SHA_B, checkedAt: 'x' } }))).toBe(true);
    expect(hasNewVersion(status({ update: { available: false, latestSha: SHA_B, checkedAt: 'x' } }))).toBe(false);
    expect(hasNewVersion(status())).toBe(false);
  });

  it('verificou e está em dia: o selo some e diz que está em dia', () => {
    const out = view({ status: status({ update: { available: true, latestSha: SHA_B, checkedAt: 'x' } }), check: { upToDate: true } });
    expect(out).toContain('Em dia');
    expect(out).not.toContain('há versão nova');
    expect(view({ check: { upToDate: true, sha: SHA_B } })).toContain('a pasta desta skill não mudou');
  });

  it('versão nova: de onde vem, contagem, cabeçalho que muda e o diff de todos os arquivos', () => {
    const out = view({ check: newer() });
    expect(out).toContain('Versão nova: aaaaaaa → bbbbbbb');
    expect(out).toContain('Vem de acme/skills (main)');
    expect(out).toContain('0 novos · 0 apagados · 1 alterados');
    expect(out).toContain('description: antes → depois');
    expect(out).toContain('gh-line is-add');
    expect(out).toContain('Aplicar atualização');
  });

  it('skill mexida aqui: aviso forte com selo, sem prometer que Voltar restaura', () => {
    const out = view({ status: status({ modified: true }), modified: true });
    expect(out).toContain('modificada aqui');
    expect(out).toContain('gh-warn');
    expect(out).toContain('suas mudanças saem da pasta');
    expect(out).toContain('não restaura mudanças locais');
  });

  it('aplicar pede confirmação; a confirmação de skill mexida é vermelha e diz que apaga as mudanças', () => {
    const plain = view({ check: newer(), confirm: 'apply' });
    expect(plain).toContain('A atual (aaaaaaa) fica guardada e dá para voltar');
    expect(plain).toMatch(/btn-secondary "[^>]*>Aplicar</);
    expect(plain).not.toContain('is-danger');
    const local = view({ check: newer({ localModified: true }), status: status({ modified: true }), confirm: 'apply', modified: true });
    expect(local).toContain('apaga as suas mudanças locais');
    expect(local).toMatch(/btn-secondary is-danger"[^>]*>Sobrescrever e aplicar</);
  });

  it('alerta de perigo na versão nova trava Aplicar até a ciência', () => {
    const danger = newer({ alerts: [alert('danger', 'hooks')] });
    expect(view({ check: danger })).toMatch(/btn-primary"[^>]*disabled[^>]*>Aplicar atualização</);
    expect(view({ check: danger, ack: true })).not.toMatch(/btn-primary"[^>]*disabled[^>]*>Aplicar atualização</);
    expect(view({ check: danger, confirm: 'apply' })).toMatch(/disabled[^>]*>Aplicar</);
  });

  it('andamento, aviso de sucesso e erros (prévia velha da versão nova, limite do GitHub)', () => {
    expect(view({ phase: 'checking' })).toContain('Verificando…');
    expect(view({ check: newer(), confirm: 'apply', phase: 'applying' })).toContain('Aplicando…');
    expect(view({ notice: 'Atualizada para bbbbbbb.' })).toContain('Atualizada para bbbbbbb.');
    expect(view({ check: newer(), error: { kind: 'changed' } })).toContain('A versão nova mudou desde a verificação');
    expect(view({ error: { kind: 'rate', clock: '15:30' } })).toContain('depois das 15:30');
    expect(view({ error: { kind: 'other', message: 'a skill está em uso' } })).toContain('a skill está em uso');
  });

  it('voltar: sempre explica que só vale depois de atualizar, e confirma antes', () => {
    const out = view();
    expect(out).toContain('Versão anterior');
    expect(out).toContain('Sem atualização feita, não há para onde voltar');
    expect(out).toContain('Voltar à versão anterior');
    const ask = view({ confirm: 'rollback' });
    expect(ask).toContain('A atual fica guardada em backup');
    expect(ask).toMatch(/btn-secondary"[^>]*>Voltar</);
    expect(view({ confirm: 'rollback', phase: 'rolling' })).toContain('Voltando…');
  });
});
