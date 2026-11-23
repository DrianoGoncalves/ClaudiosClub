import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitHubClient, gitBlobSha, type GitHubClient, type TreeEntry } from '../server/adapters/github/client';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import {
  applyUpdate,
  checkUpdate,
  GitHubInstallBatchInput,
  installBatch,
  installSkill,
  LIMITS,
  parseGitHubUrl,
  previewSkill,
  readOrigin,
  rollback,
  skillOriginStatus,
  SkillConflictError,
  githubSkillsIn,
  unifiedDiff,
  UpdateChecker,
  type InstallTarget,
  type PreviewOk,
} from '../server/skillInstall';
import { removeTemp } from './support/tmp';

// Sem rede: o GitHub é um repositório falso (commits, árvores e arquivos com o sha1 de git de verdade). O relógio é do teste.
// Uma pasta temporária por teste; nada toca ~/.claude nem ~/.myco.

let root: string;
let seq = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-skillinstall-'));
});
afterAll(() => removeTemp(root));

const URL_DIR = 'https://github.com/o/r/tree/main/skills/ponytail';
const SKILL = (desc = 'Envia arquivos para a VPS', body = 'Passo 1.') => `---\nname: ponytail\ndescription: ${desc}\n---\n\n${body}\n`;

interface Snap {
  files: Map<string, Buffer>;
  modes: Map<string, string>;
  extra: TreeEntry[];
  truncated: boolean;
  tamper: Map<string, Buffer>;
}

/** Um GitHub de mentira: `commit()` cria um commit (e aponta o ref), `fetch` responde a API e o raw como o GitHub. */
function fakeGitHub(nowMs: () => number) {
  const snaps = new Map<string, Snap>();
  const refs = new Map<string, string>();
  const calls: string[] = [];
  let n = 0;
  let limited = false;
  const treeOf = (s: Snap) => {
    const blobs: Array<Record<string, unknown>> = [];
    for (const [p, bytes] of s.files) blobs.push({ path: p, mode: s.modes.get(p) ?? '100644', type: 'blob', sha: gitBlobSha(bytes), size: bytes.length });
    for (const e of s.extra) blobs.push({ ...e });
    const dirs = new Set<string>();
    for (const e of blobs) {
      const parts = String(e.path).split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    const tree: Array<Record<string, unknown>> = [...blobs];
    for (const d of dirs) {
      const inside = blobs
        .filter((e) => String(e.path).startsWith(`${d}/`))
        .map((e) => `${String(e.path)}:${String(e.sha)}`)
        .sort()
        .join('\n');
      tree.push({ path: d, mode: '040000', type: 'tree', sha: createHash('sha1').update(`dir ${d}\n${inside}`).digest('hex') });
    }
    const rootSha = createHash('sha1').update(blobs.map((e) => `${String(e.path)}:${String(e.sha)}`).sort().join('\n')).digest('hex');
    return { sha: rootSha, truncated: s.truncated, tree };
  };
  return {
    calls,
    /** Um commit com esses arquivos (texto ou bytes). `ref` (padrão: main) aponta para ele. */
    commit(
      files: Record<string, string | Buffer>,
      o: { ref?: string; modes?: Record<string, string>; extra?: TreeEntry[]; truncated?: boolean; tamper?: Record<string, Buffer> } = {},
    ): string {
      n++;
      const sha = createHash('sha1').update(`commit ${n}`).digest('hex');
      snaps.set(sha, {
        files: new Map(Object.entries(files).map(([p, c]) => [p, Buffer.from(c)])),
        modes: new Map(Object.entries(o.modes ?? {})),
        extra: o.extra ?? [],
        truncated: o.truncated ?? false,
        tamper: new Map(Object.entries(o.tamper ?? {})),
      });
      refs.set(o.ref ?? 'main', sha);
      return sha;
    },
    setLimited(on: boolean) {
      limited = on;
    },
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.href);
      if (limited) {
        const reset = Math.floor(nowMs() / 1000) + 3600;
        return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
      }
      if (url.hostname === 'api.github.com') {
        if (url.pathname === '/repos/o/r') return Response.json({ default_branch: 'main' });
        const c = /^\/repos\/o\/r\/commits\/(.+)$/.exec(url.pathname);
        if (c) {
          const sha = refs.get(decodeURIComponent(c[1] ?? ''));
          return sha ? new Response(sha, { status: 200 }) : new Response('', { status: 404 });
        }
        const t = /^\/repos\/o\/r\/git\/trees\/([0-9a-f]{40})$/.exec(url.pathname);
        const s = t ? snaps.get(t[1] ?? '') : undefined;
        return s ? Response.json(treeOf(s)) : new Response('', { status: 404 });
      }
      const raw = /^\/o\/r\/([0-9a-f]{40})\/(.+)$/.exec(url.pathname);
      const s = raw ? snaps.get(raw[1] ?? '') : undefined;
      const file = raw ? decodeURIComponent(raw[2] ?? '') : '';
      const bytes = s ? (s.tamper.get(file) ?? s.files.get(file)) : undefined;
      return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response('', { status: 404 });
    }) as typeof fetch,
  };
}
type Fake = ReturnType<typeof fakeGitHub>;

/** Cliente com cache próprio (cada teste enxerga o repositório falso, não o de outro teste). */
function ghFor(f: Fake, clock: { now: number }): GitHubClient {
  seq++;
  return createGitHubClient({ fetch: f.fetch, sleep: async () => undefined, random: () => 0, now: () => clock.now, cacheDir: path.join(root, `cache-${seq}`) });
}

const clockNow = () => ({ now: 1_700_000_000_000 });
/** Uma conta de mentira com a pasta de skills e os backups do teste. */
function targetOf(tag: string): InstallTarget {
  return { scope: 'user', owner: 'user', root: path.join(root, tag, 'home', 'skills') };
}
const backupRoot = (tag: string) => path.join(root, tag, 'backups');

/** Instala a skill (v1, com `Passo 1.`) no `tag`; devolve o que os testes de volta precisam. */
async function installed(tag: string, f: Fake, clock: { now: number }) {
  const v1 = f.commit({ 'skills/ponytail/SKILL.md': SKILL() });
  const gh = ghFor(f, clock);
  const target = targetOf(tag);
  const deps = { gh, backupRoot: backupRoot(tag) };
  const p1 = (await previewSkill({ url: URL_DIR }, { gh })) as PreviewOk;
  await installSkill({ target, url: URL_DIR, path: 'skills/ponytail', ref: 'main', sha: v1, digest: p1.digest }, deps);
  return { v1, gh, target, deps, dir: path.join(target.root, 'ponytail') };
}

/** Aplica uma v2 (`Passo 2.`) sobre a instalação; devolve o backup da versão anterior. */
async function updated(s: Awaited<ReturnType<typeof installed>>, f: Fake, clock: { now: number }) {
  const v2 = f.commit({ 'skills/ponytail/SKILL.md': SKILL(undefined, 'Passo 2.') });
  clock.now += 11 * 60_000;
  const check = await checkUpdate({ target: s.target, name: 'ponytail' }, s.deps);
  if (check.upToDate) throw new Error('devia ter novidade');
  return applyUpdate({ target: s.target, name: 'ponytail', sha: v2, digest: check.digest }, s.deps);
}

describe('URL do GitHub', () => {
  it('aceita pasta, SKILL.md e .git; ignora query e #; recusa usuário, porta, outro host e SKILL.md fora do fim', () => {
    expect(parseGitHubUrl('https://github.com/dietrichgebert/ponytail')).toEqual({ owner: 'dietrichgebert', repo: 'ponytail', kind: 'root', rest: [] });
    expect(parseGitHubUrl('https://github.com/o/r/tree/main/skills/ponytail?tab=readme#x')).toMatchObject({ kind: 'tree', rest: ['main', 'skills', 'ponytail'] });
    expect(parseGitHubUrl('https://www.github.com/o/r.git/blob/main/skills/x/SKILL.md')).toMatchObject({ repo: 'r', kind: 'blob' });
    for (const bad of ['https://user:pw@github.com/o/r', 'http://github.com/o/r', 'https://github.com:444/o/r', 'https://evil.com/o/r', 'https://github.com/o/..', 'https://github.com/o/r/blob/main/skills/x/README.md']) {
      expect(() => parseGitHubUrl(bad), bad).toThrow();
    }
  });
});

describe('prévia', () => {
  it('pasta com SKILL.md: lista os arquivos, alerta de script, digest; a URL do blob dá o mesmo pacote', async () => {
    const f = fakeGitHub(() => 0);
    const sha = f.commit({ 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/scripts/run.sh': 'echo ok\n' });
    const gh = ghFor(f, clockNow());
    const p = (await previewSkill({ url: URL_DIR }, { gh })) as PreviewOk;
    expect(p).toMatchObject({ kind: 'preview', name: 'ponytail', source: { owner: 'o', repo: 'r', ref: 'main', sha, path: 'skills/ponytail' } });
    expect(p.files.map((x) => x.path)).toEqual(['SKILL.md', 'scripts/run.sh']);
    expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.alerts.map((a) => a.code)).toContain('executable');
    const viaBlob = (await previewSkill({ url: 'https://github.com/o/r/blob/main/skills/ponytail/SKILL.md' }, { gh })) as PreviewOk;
    expect(viaBlob.digest).toBe(p.digest);
  });

  it('várias skills numa pasta: `choose` (sem descer dentro de outra skill); nenhuma: erro', async () => {
    const f = fakeGitHub(() => 0);
    f.commit({
      'skills/a/SKILL.md': SKILL('Faz A'),
      'skills/b/SKILL.md': SKILL('Faz B'),
      'skills/b/sub/SKILL.md': SKILL('Dentro de B'),
      'skills/readme.md': 'x',
    });
    const gh = ghFor(f, clockNow());
    const c = (await previewSkill({ url: 'https://github.com/o/r/tree/main/skills' }, { gh })) as unknown as { kind: string; skills: Array<{ path: string; name: string; description: string }> };
    expect(c.kind).toBe('choose');
    expect(c.skills).toEqual([
      { path: 'skills/a', name: 'a', description: 'Faz A' },
      { path: 'skills/b', name: 'b', description: 'Faz B' },
    ]);
    const f2 = fakeGitHub(() => 0);
    f2.commit({ 'docs/x.md': 'x' });
    await expect(previewSkill({ url: 'https://github.com/o/r/tree/main/docs' }, { gh: ghFor(f2, clockNow()) })).rejects.toThrow('nenhuma pasta com SKILL.md');
  });

  it('o ref pode ter barra: tenta os cortes do mais curto ao mais longo', async () => {
    const f = fakeGitHub(() => 0);
    f.commit({ 'skills/ponytail/SKILL.md': SKILL() }, { ref: 'feature/x' });
    const p = (await previewSkill({ url: 'https://github.com/o/r/tree/feature/x/skills/ponytail' }, { gh: ghFor(f, clockNow()) })) as PreviewOk;
    expect(p.source).toMatchObject({ ref: 'feature/x', path: 'skills/ponytail' });
  });

  it('recusas: nada é baixado nem gravado quando a pasta tem algo proibido', async () => {
    // `early`: recusa antes de baixar qualquer arquivo (o segredo só aparece depois do download).
    type Case = [string, Record<string, string | Buffer>, NonNullable<Parameters<Fake['commit']>[1]>, string, boolean];
    const cases: Case[] = [
      ['symlink', { 'skills/ponytail/SKILL.md': SKILL() }, { extra: [{ path: 'skills/ponytail/link', mode: '120000', type: 'blob', sha: 'a'.repeat(40), size: 3 }] }, 'link simbólico', true],
      ['submódulo', { 'skills/ponytail/SKILL.md': SKILL() }, { extra: [{ path: 'skills/ponytail/sub', mode: '160000', type: 'commit', sha: 'b'.repeat(40) }] }, 'submódulo', true],
      ['traversal', { 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/../evil.md': 'x' }, {}, 'segmento vazio, . ou ..', true],
      ['barra invertida', { 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/a\\b.md': 'x' }, {}, 'caractere ou começo não permitido', true],
      ['dois-pontos', { 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/x:y.md': 'x' }, {}, 'caractere ou começo não permitido', true],
      ['nome reservado', { 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/CON.md': 'x' }, {}, 'nome reservado do Windows', true],
      ['termina em ponto', { 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/x.': 'x' }, {}, 'termina em ponto', true],
      ['colisão de caixa', { 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/Notas.md': 'a', 'skills/ponytail/notas.md': 'b' }, {}, 'mesmo arquivo', true],
      ['metadado reservado', { 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/.myco-origin.json': '{}' }, {}, 'reservado', true],
      ['SKILL.md grande', { 'skills/ponytail/SKILL.md': 'x'.repeat(131_073) }, {}, 'passa do limite de 128 KB', true],
      ['arquivo maior que 1 MB', { 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/big.bin': 'x'.repeat(1_100_000) }, {}, 'passa do limite de 1024 KB', true],
      ['mais de 5 MB no total', { 'skills/ponytail/SKILL.md': SKILL(), ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`skills/ponytail/d${i}.txt`, 'a'.repeat(900_000)])) }, {}, 'no total', true],
      ['árvore cortada', { 'skills/ponytail/SKILL.md': SKILL() }, { truncated: true }, 'grande demais', true],
      ['segredo no arquivo', { 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/config.txt': 'Use DB_PASSWORD=senhaForte123 no comando' }, {}, 'senha na variável DB_PASSWORD', false],
    ];
    for (const [name, files, opts, msg, early] of cases) {
      const f = fakeGitHub(() => 0);
      f.commit(files, opts);
      const err = await previewSkill({ url: URL_DIR }, { gh: ghFor(f, clockNow()) }).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(Error);
      expect((err as Error).message, name).toContain(msg);
      expect((err as Error).message, name).not.toContain('senhaForte123');
      if (early) expect(f.calls.filter((c) => c.startsWith('https://raw.githubusercontent.com')), name).toHaveLength(0);
    }
  });

  it('arquivo maior no stream que o declarado, e sha1 que não bate: recusados (o conteúdo não entra)', async () => {
    const big = fakeGitHub(() => 0);
    big.commit({ 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/run.sh': 'echo' }, { tamper: { 'skills/ponytail/run.sh': Buffer.from('echo muito maior que o declarado') } });
    await expect(previewSkill({ url: URL_DIR }, { gh: ghFor(big, clockNow()) })).rejects.toThrow('maior que o declarado');
    // Mesmo tamanho, outro conteúdo: o tamanho passa e só o sha1 denuncia.
    const wrong = fakeGitHub(() => 0);
    wrong.commit({ 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/run.sh': 'echo' }, { tamper: { 'skills/ponytail/run.sh': Buffer.from('ECHO') } });
    await expect(previewSkill({ url: URL_DIR }, { gh: ghFor(wrong, clockNow()) })).rejects.toThrow('sha1');
  });

  it('alertas que não recusam: hooks, !`cmd`, allowed-tools, nome diferente, BOM', async () => {
    const f = fakeGitHub(() => 0);
    const md = `---\nname: outro\ndescription: x\nallowed-tools: Bash\nhooks:\n  Stop:\n    - hooks: []\n---\n\nRode !\`ls\` antes.\n`;
    f.commit({ 'skills/ponytail/SKILL.md': md, 'skills/ponytail/bin/tool': '#!/bin/sh\necho\n' });
    const p = (await previewSkill({ url: URL_DIR }, { gh: ghFor(f, clockNow()) })) as PreviewOk;
    const codes = p.alerts.map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(['hooks', 'allowed-tools', 'inline-shell', 'name-mismatch', 'executable']));
    expect(p.alerts.find((a) => a.code === 'hooks')?.level).toBe('danger');
    const g = fakeGitHub(() => 0);
    g.commit({ 'skills/ponytail/SKILL.md': '﻿' + SKILL() });
    expect(((await previewSkill({ url: URL_DIR }, { gh: ghFor(g, clockNow()) })) as PreviewOk).alerts.map((a) => a.code)).toContain('bom');
  });
});

describe('instalar', () => {
  it('grava a pasta com metadado (sha256 completo), sem staging sobrando; não sobrescreve; digest diferente recusa', async () => {
    const tag = 'inst';
    const f = fakeGitHub(() => 0);
    const sha = f.commit({ 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/scripts/run.sh': 'echo ok\n' });
    const gh = ghFor(f, clockNow());
    const p = (await previewSkill({ url: URL_DIR }, { gh })) as PreviewOk;
    const target = targetOf(tag);
    const deps = { gh, backupRoot: backupRoot(tag) };
    const r = await installSkill({ target, url: URL_DIR, path: 'skills/ponytail', ref: 'main', sha, digest: p.digest }, deps);
    expect(r).toEqual({ name: 'ponytail', sha, digest: p.digest });

    const dir = path.join(target.root, 'ponytail');
    expect(await fs.readFile(path.join(dir, 'scripts', 'run.sh'), 'utf8')).toBe('echo ok\n');
    const meta = JSON.parse(await fs.readFile(path.join(dir, '.myco-origin.json'), 'utf8'));
    expect(meta).toMatchObject({ v: 1, owner: 'o', repo: 'r', path: 'skills/ponytail', ref: 'main', sha });
    expect(Object.keys(meta.files).sort()).toEqual(['SKILL.md', 'scripts/run.sh']);
    for (const h of Object.values(meta.files)) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await skillOriginStatus(dir)).toMatchObject({ modified: false });
    expect(await fs.readdir(path.join(root, tag, 'home', '.myco-staging'))).toEqual([]);

    await expect(installSkill({ target, url: URL_DIR, path: 'skills/ponytail', ref: 'main', sha, digest: p.digest }, deps)).rejects.toThrow('já existe');

    const other = targetOf('inst-digest');
    await expect(
      installSkill({ target: other, url: URL_DIR, path: 'skills/ponytail', ref: 'main', sha, digest: 'f'.repeat(64) }, { gh, backupRoot: backupRoot('inst-digest') }),
    ).rejects.toMatchObject({ code: 'changed' });
    await expect(fs.stat(path.join(other.root, 'ponytail'))).rejects.toThrow();
  });

  it('recusa nome inválido e nome que já existe, em conta e projeto; nada é gravado nas recusas', async () => {
    const tag = 'inst-nomes';
    const f = fakeGitHub(() => 0);
    const sha = f.commit({ 'skills/ponytail/SKILL.md': SKILL() });
    const gh = ghFor(f, clockNow());
    const p = (await previewSkill({ url: URL_DIR }, { gh })) as PreviewOk;
    const deps = { gh, backupRoot: backupRoot(tag) };
    const user = targetOf(tag);
    const proj: InstallTarget = { scope: 'project', owner: 'p1', root: path.join(root, tag, 'projeto', '.claude', 'skills') };
    const base = { url: URL_DIR, path: 'skills/ponytail', ref: 'main', sha, digest: p.digest };
    // Nome com espaço, caminho ou começo com hífen: recusa nas duas pastas (o regex é o do skillWrite; maiúscula ele aceita).
    for (const target of [user, proj]) {
      for (const name of ['com espaco', '../fora', 'a/b', '-sem-inicio']) {
        await expect(installSkill({ ...base, target, name }, deps)).rejects.toThrow('nome inválido');
      }
    }
    await expect(fs.stat(path.join(root, tag, 'home', 'skills'))).rejects.toThrow();
    await expect(fs.stat(path.join(root, tag, 'projeto'))).rejects.toThrow();
    // Nome que já existe: recusa, sem sobrescrever (a pasta de quem já está lá fica).
    await installSkill({ ...base, target: user }, deps);
    await expect(installSkill({ ...base, target: user }, deps)).rejects.toThrow('já existe');
    await installSkill({ ...base, target: proj }, deps);
    await expect(installSkill({ ...base, target: proj }, deps)).rejects.toThrow('já existe');
  });

  it('a skill instalada aparece na lista com origem e modificada=false', async () => {
    const tag = 'lista';
    const f = fakeGitHub(() => 0);
    const sha = f.commit({ 'skills/ponytail/SKILL.md': SKILL() });
    const gh = ghFor(f, clockNow());
    const p = (await previewSkill({ url: URL_DIR }, { gh })) as PreviewOk;
    const target = targetOf(tag);
    await installSkill({ target, url: URL_DIR, path: 'skills/ponytail', ref: 'main', sha, digest: p.digest }, { gh, backupRoot: backupRoot(tag) });
    expect(await githubSkillsIn(target)).toEqual([{ name: 'ponytail', origin: expect.objectContaining({ ref: 'main', sha }), modified: false }]);
  });
});

describe('atualizar e voltar', () => {
  it('diff de tudo (troca, adição, binário, frontmatter), aplica com backup e volta à versão anterior', async () => {
    const tag = 'upd';
    const f = fakeGitHub(() => 0);
    const v1 = f.commit({ 'skills/ponytail/SKILL.md': SKILL('Envia arquivos', 'Passo 1.'), 'skills/ponytail/scripts/run.sh': 'echo 1\n', 'skills/ponytail/fixo.txt': 'igual\n' });
    const clock = clockNow();
    const gh = ghFor(f, clock);
    const target = targetOf(tag);
    const deps = { gh, backupRoot: backupRoot(tag) };
    const p1 = (await previewSkill({ url: URL_DIR }, { gh })) as PreviewOk;
    await installSkill({ target, url: URL_DIR, path: 'skills/ponytail', ref: 'main', sha: v1, digest: p1.digest }, deps);

    // `fixo.txt` some na versão nova (vira `removed`); `notas.md` é nova (vira `added`).
    const v2 = f.commit({
      'skills/ponytail/SKILL.md': SKILL('Envia e baixa arquivos', 'Passo 2.'),
      'skills/ponytail/scripts/run.sh': 'echo 2\n',
      'skills/ponytail/notas.md': 'nova\n',
      'skills/ponytail/img.bin': Buffer.from([0, 1, 2]),
    });
    clock.now += 11 * 60_000; // o ref some do cache (TTL de 10 min)
    const check = await checkUpdate({ target, name: 'ponytail' }, deps);
    if (check.upToDate) throw new Error('devia ter novidade');
    expect(check).toMatchObject({ fromSha: v1, toSha: v2, localModified: false });
    const byPath = Object.fromEntries(check.diff.map((d) => [d.path, d]));
    expect(byPath['SKILL.md']).toMatchObject({ status: 'changed', binary: false });
    expect(byPath['SKILL.md']?.patch).toContain('-Passo 1.');
    expect(byPath['SKILL.md']?.patch).toContain('+Passo 2.');
    expect(byPath['notas.md']).toMatchObject({ status: 'added', binary: false });
    expect(byPath['img.bin']).toMatchObject({ status: 'added', binary: true, after: { size: 3 } });
    expect(byPath['fixo.txt']).toMatchObject({ status: 'removed', binary: false });
    expect(byPath['run.sh'] ?? byPath['scripts/run.sh']).toMatchObject({ status: 'changed' });
    expect(check.frontmatter.map((x) => x.key)).toEqual(['description']);
    // De onde veio a versão nova (a tela mostra antes da aprovação).
    expect(check.source).toEqual({ url: URL_DIR, owner: 'o', repo: 'r', ref: 'main', path: 'skills/ponytail' });

    const applied = await applyUpdate({ target, name: 'ponytail', sha: v2, digest: check.digest }, deps);
    const dir = path.join(target.root, 'ponytail');
    expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toContain('Passo 2.');
    const meta = JSON.parse(await fs.readFile(path.join(dir, '.myco-origin.json'), 'utf8'));
    expect(meta).toMatchObject({ sha: v2, previous: { sha: v1, backup: applied.backup } });
    expect(await fs.readFile(path.join(applied.backup, 'SKILL.md'), 'utf8')).toContain('Passo 1.');

    const back = await rollback({ target, name: 'ponytail' }, deps);
    expect(back).toEqual({ name: 'ponytail', sha: v1 });
    expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toContain('Passo 1.');
    expect(JSON.parse(await fs.readFile(path.join(dir, '.myco-origin.json'), 'utf8'))).toMatchObject({ sha: v1 });
    expect((await fs.readdir(path.join(root, tag, 'home', 'skills'))).sort()).toEqual(['ponytail']);
  });

  it('pasta modificada aqui pede confirmação; com overwriteLocal troca e guarda o que o usuário tinha', async () => {
    const tag = 'mod';
    const f = fakeGitHub(() => 0);
    const v1 = f.commit({ 'skills/ponytail/SKILL.md': SKILL(), 'skills/ponytail/run.sh': 'echo 1\n' });
    const clock = clockNow();
    const gh = ghFor(f, clock);
    const target = targetOf(tag);
    const deps = { gh, backupRoot: backupRoot(tag) };
    const p1 = (await previewSkill({ url: URL_DIR }, { gh })) as PreviewOk;
    await installSkill({ target, url: URL_DIR, path: 'skills/ponytail', ref: 'main', sha: v1, digest: p1.digest }, deps);
    const dir = path.join(target.root, 'ponytail');
    await fs.writeFile(path.join(dir, 'run.sh'), 'echo meu ajuste\n');
    expect(await skillOriginStatus(dir)).toMatchObject({ modified: true });

    const v2 = f.commit({ 'skills/ponytail/SKILL.md': SKILL(undefined, 'Passo 2.'), 'skills/ponytail/run.sh': 'echo 2\n' });
    clock.now += 11 * 60_000;
    const check = await checkUpdate({ target, name: 'ponytail' }, deps);
    if (check.upToDate) throw new Error('devia ter novidade');
    expect(check.localModified).toBe(true);
    const err = await applyUpdate({ target, name: 'ponytail', sha: v2, digest: check.digest }, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillConflictError);
    expect(err).toMatchObject({ code: 'modified' });
    expect(await fs.readFile(path.join(dir, 'run.sh'), 'utf8')).toBe('echo meu ajuste\n');

    const applied = await applyUpdate({ target, name: 'ponytail', sha: v2, digest: check.digest, overwriteLocal: true }, deps);
    expect(await fs.readFile(path.join(dir, 'run.sh'), 'utf8')).toBe('echo 2\n');
    expect(await fs.readFile(path.join(applied.backup, 'run.sh'), 'utf8')).toBe('echo meu ajuste\n');
    // A cópia de uma versão que tinha edição local não bate com o registro: o rollback recusa (os arquivos ficam no backup).
    await expect(rollback({ target, name: 'ponytail' }, deps)).rejects.toThrow('não bate com o registro dele');
  });

  it('digest que não bate com a versão nova recusa a troca (a prévia não vale mais)', async () => {
    const tag = 'chg';
    const f = fakeGitHub(() => 0);
    const v1 = f.commit({ 'skills/ponytail/SKILL.md': SKILL() });
    const clock = clockNow();
    const gh = ghFor(f, clock);
    const target = targetOf(tag);
    const deps = { gh, backupRoot: backupRoot(tag) };
    const p1 = (await previewSkill({ url: URL_DIR }, { gh })) as PreviewOk;
    await installSkill({ target, url: URL_DIR, path: 'skills/ponytail', ref: 'main', sha: v1, digest: p1.digest }, deps);
    const v2 = f.commit({ 'skills/ponytail/SKILL.md': SKILL(undefined, 'Outro.') });
    clock.now += 11 * 60_000;
    await expect(applyUpdate({ target, name: 'ponytail', sha: v2, digest: 'e'.repeat(64) }, deps)).rejects.toMatchObject({ code: 'changed' });
  });

  it('rollback recusa cópia fora da pasta de backups ou com nome de outra skill, e não mexe em nada', async () => {
    const clock = clockNow();
    const f = fakeGitHub(() => clock.now);
    const s = await installed('fora', f, clock);
    const applied = await updated(s, f, clock);
    const metaFile = path.join(s.dir, '.myco-origin.json');
    const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    const pointTo = (b: string) => fs.writeFile(metaFile, JSON.stringify({ ...meta, previous: { sha: meta.previous.sha, backup: b } }));
    // Mesmo nome, mas fora da pasta de backups.
    const outside = path.join(root, 'fora', 'escondido', path.basename(applied.backup));
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.cp(applied.backup, outside, { recursive: true });
    await pointTo(outside);
    await expect(rollback({ target: s.target, name: 'ponytail' }, s.deps)).rejects.toThrow('não está na pasta de backups');
    // Dentro da pasta de backups, mas o nome é de outra skill.
    const other = path.join(backupRoot('fora'), 'user-user-outra-20260101-000000-000000');
    await fs.cp(applied.backup, other, { recursive: true });
    await pointTo(other);
    await expect(rollback({ target: s.target, name: 'ponytail' }, s.deps)).rejects.toThrow('não está na pasta de backups');
    expect(await fs.readFile(path.join(s.dir, 'SKILL.md'), 'utf8')).toContain('Passo 2.');
  });

  it('rollback recusa backup adulterado (arquivo mudado ou a mais) e volta quando está igual', async () => {
    const clock = clockNow();
    const f = fakeGitHub(() => clock.now);
    const s = await installed('adulter', f, clock);
    const applied = await updated(s, f, clock);
    const file = path.join(applied.backup, 'SKILL.md');
    const good = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, good + 'mexido\n');
    await expect(rollback({ target: s.target, name: 'ponytail' }, s.deps)).rejects.toThrow('não bate com o registro dele');
    await fs.writeFile(file, good);
    await fs.writeFile(path.join(applied.backup, 'a-mais.txt'), 'x');
    await expect(rollback({ target: s.target, name: 'ponytail' }, s.deps)).rejects.toThrow('não bate com o registro dele');
    await fs.rm(path.join(applied.backup, 'a-mais.txt'));
    expect(await rollback({ target: s.target, name: 'ponytail' }, s.deps)).toEqual({ name: 'ponytail', sha: s.v1 });
    expect(await fs.readFile(path.join(s.dir, 'SKILL.md'), 'utf8')).toContain('Passo 1.');
  });

  it('readOrigin recusa metadado com dono, pasta, sha, URL ou arquivo inválido (vira "não veio do GitHub")', async () => {
    const clock = clockNow();
    const f = fakeGitHub(() => clock.now);
    const s = await installed('meta', f, clock);
    const metaFile = path.join(s.dir, '.myco-origin.json');
    const good = JSON.parse(await fs.readFile(metaFile, 'utf8')) as Record<string, unknown>;
    const files = good.files as Record<string, string>;
    expect(await readOrigin(s.dir)).not.toBeNull();
    const bad: Array<Record<string, unknown>> = [
      { owner: '../x' },
      { repo: 'a b' },
      { path: '../fora' },
      { path: 'skills/CON' },
      { ref: '../main' },
      { sha: 'xyz' },
      { treeSha: 'a'.repeat(39) },
      { url: 'https://evil.example/o/r' },
      { files: { ...files, '../evil.md': 'a'.repeat(64) } },
      { files: { 'scripts/run.sh': 'a'.repeat(64) } },
      { files: { ...files, 'SKILL.md': 'nao-e-hash' } },
      { files: { ...files, '.myco-origin.json': 'a'.repeat(64) } },
    ];
    for (const b of bad) {
      await fs.writeFile(metaFile, JSON.stringify({ ...good, ...b }));
      expect(await readOrigin(s.dir), JSON.stringify(b)).toBeNull();
    }
    await fs.writeFile(metaFile, JSON.stringify(good));
    expect(await readOrigin(s.dir)).not.toBeNull();
  });

  it('mudança só fora da pasta: é "em dia" pelo treeSha, e só anota o checkedSha', async () => {
    const tag = 'same';
    const f = fakeGitHub(() => 0);
    const v1 = f.commit({ 'skills/ponytail/SKILL.md': SKILL(), 'README.md': 'a' });
    const clock = clockNow();
    const gh = ghFor(f, clock);
    const target = targetOf(tag);
    const p1 = (await previewSkill({ url: URL_DIR }, { gh })) as PreviewOk;
    await installSkill({ target, url: URL_DIR, path: 'skills/ponytail', ref: 'main', sha: v1, digest: p1.digest }, { gh, backupRoot: backupRoot(tag) });
    const v2 = f.commit({ 'skills/ponytail/SKILL.md': SKILL(), 'README.md': 'b' });
    clock.now += 11 * 60_000;
    expect(await checkUpdate({ target, name: 'ponytail' }, { gh, backupRoot: backupRoot(tag) })).toEqual({ upToDate: true, sha: v2 });
    const meta = JSON.parse(await fs.readFile(path.join(target.root, 'ponytail', '.myco-origin.json'), 'utf8'));
    expect(meta.checkedSha).toBe(v2);
  });
});

describe('diff e selo', () => {
  it('diff de texto: patch com contexto; igual dá vazio; grande demais não vem patch', () => {
    expect(unifiedDiff('a\nb\nc', 'a\nB\nc').patch).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
    expect(unifiedDiff('x\ny', 'x\ny')).toEqual({ patch: '', tooLarge: false });
    const many = Array.from({ length: 3000 }, (_, i) => `linha ${i}`).join('\n');
    expect(unifiedDiff(many, many + '\nnova')).toEqual({ patch: null, tooLarge: true });
  });

  it('o selo: uma varredura por dia, marca a skill com versão nova; limite de consultas adia para o próximo dia', async () => {
    const tag = 'selo';
    const clock = clockNow();
    const f = fakeGitHub(() => clock.now);
    const v1 = f.commit({ 'skills/ponytail/SKILL.md': SKILL() });
    const gh = ghFor(f, clock);
    const target = targetOf(tag);
    const p1 = (await previewSkill({ url: URL_DIR }, { gh })) as PreviewOk;
    await installSkill({ target, url: URL_DIR, path: 'skills/ponytail', ref: 'main', sha: v1, digest: p1.digest }, { gh, backupRoot: backupRoot(tag) });
    const checker = new UpdateChecker({ gh, targets: async () => [target], now: () => clock.now, file: path.join(root, tag, 'checks.json') });

    expect(await checker.runIfDue()).toBe(true);
    expect(await checker.statusOf('user', 'user', 'ponytail')).toMatchObject({ available: false, latestSha: v1 });
    expect(await checker.runIfDue()).toBe(false);

    const v2 = f.commit({ 'skills/ponytail/SKILL.md': SKILL(undefined, 'Novo.') });
    clock.now += 25 * 60 * 60_000;
    expect(await checker.runIfDue()).toBe(true);
    expect(await checker.statusOf('user', 'user', 'ponytail')).toMatchObject({ available: true, latestSha: v2 });

    // Limite de consultas: não dá erro, só não grava nada neste dia e tenta no próximo.
    f.setLimited(true);
    clock.now += 25 * 60 * 60_000;
    await expect(checker.runIfDue()).resolves.toBe(true);
    expect(await checker.statusOf('user', 'user', 'ponytail')).toMatchObject({ available: true, latestSha: v2 });
    f.setLimited(false);
    clock.now += 25 * 60 * 60_000;
    expect(await checker.runIfDue()).toBe(true);
  });
});

describe('instalação em lote', () => {
  const REPO_URL = 'https://github.com/o/r/tree/main/skills';
  const THREE = { 'skills/a/SKILL.md': SKILL('Faz A'), 'skills/b/SKILL.md': SKILL('Faz B'), 'skills/c/SKILL.md': SKILL('Faz C') };
  const apiCalls = (f: Fake) => f.calls.filter((c) => c.startsWith('https://api.github.com')).length;

  /** O que a tela faz: a prévia (a atual, uma por skill escolhida) vira o item do lote. */
  async function itemsOf(gh: GitHubClient, names: string[]) {
    return Promise.all(
      names.map(async (n) => {
        const p = (await previewSkill({ url: REPO_URL, path: `skills/${n}` }, { gh })) as PreviewOk;
        return { path: p.source.path, ref: p.source.ref, sha: p.source.sha, digest: p.digest };
      }),
    );
  }

  it('1 ok + 1 falha: a falha de um item não aborta os outros, e a resposta vem na ordem do pedido', async () => {
    const f = fakeGitHub(() => 0);
    f.commit(THREE);
    const gh = ghFor(f, clockNow());
    const target = targetOf('batch-mix');
    const [a, b, c] = await itemsOf(gh, ['a', 'b', 'c']);
    await installSkill({ target, url: REPO_URL, ...b! }, { gh }); // b já está instalada
    const results = await installBatch({ target, url: REPO_URL, items: [a!, b!, c!] }, { gh });
    expect(results).toEqual([
      { path: 'skills/a', status: 'installed', name: 'a', sha: a!.sha, digest: a!.digest },
      { path: 'skills/b', status: 'error', error: 'já existe a skill b' },
      { path: 'skills/c', status: 'installed', name: 'c', sha: c!.sha, digest: c!.digest },
    ]);
    expect((await fs.readdir(target.root)).sort()).toEqual(['a', 'b', 'c']);
    expect(await readOrigin(path.join(target.root, 'c'))).toMatchObject({ owner: 'o', repo: 'r', path: 'skills/c', ref: 'main', sha: c!.sha });
  });

  it('digest errado recusa só aquele item (`changed`) e não grava nada dele', async () => {
    const f = fakeGitHub(() => 0);
    f.commit(THREE);
    const gh = ghFor(f, clockNow());
    const target = targetOf('batch-digest');
    const [a, b, c] = await itemsOf(gh, ['a', 'b', 'c']);
    const results = await installBatch({ target, url: REPO_URL, items: [a!, { ...b!, digest: 'f'.repeat(64) }, c!] }, { gh });
    expect(results.map((r) => r.status)).toEqual(['installed', 'error', 'installed']);
    expect(results[1]).toEqual({ path: 'skills/b', status: 'error', error: 'a skill mudou desde a prévia: confira de novo', code: 'changed' });
    expect((await fs.readdir(target.root)).sort()).toEqual(['a', 'c']);
    expect(await fs.readdir(path.join(path.dirname(target.root), '.myco-staging'))).toEqual([]);
  });

  it('cada item instala no próprio sha (a prévia dele), mesmo que o branch já tenha andado', async () => {
    const f = fakeGitHub(() => 0);
    const clock = clockNow();
    const v1 = f.commit({ 'skills/a/SKILL.md': SKILL('Faz A') });
    const gh = ghFor(f, clock);
    const [a] = await itemsOf(gh, ['a']);
    clock.now += 11 * 60_000; // o ref guardado vence
    const v2 = f.commit({ 'skills/a/SKILL.md': SKILL('Faz A'), 'skills/b/SKILL.md': SKILL('Faz B') });
    const [b] = await itemsOf(gh, ['b']);
    expect(a!.sha).toBe(v1);
    expect(b!.sha).toBe(v2);
    const target = targetOf('batch-shas');
    const results = await installBatch({ target, url: REPO_URL, items: [a!, b!] }, { gh });
    expect(results.map((r) => r.status)).toEqual(['installed', 'installed']);
    expect((await readOrigin(path.join(target.root, 'a')))?.sha).toBe(v1);
    expect((await readOrigin(path.join(target.root, 'b')))?.sha).toBe(v2);
  });

  it('duas pastas com o mesmo nome (a/foo e b/foo): a segunda é recusada como a individual', async () => {
    const f = fakeGitHub(() => 0);
    f.commit({ 'skills/x/foo/SKILL.md': SKILL('Foo X'), 'skills/y/foo/SKILL.md': SKILL('Foo Y') });
    const gh = ghFor(f, clockNow());
    const items = await Promise.all(
      ['x', 'y'].map(async (d) => {
        const p = (await previewSkill({ url: REPO_URL, path: `skills/${d}/foo` }, { gh })) as PreviewOk;
        return { path: p.source.path, ref: p.source.ref, sha: p.source.sha, digest: p.digest };
      }),
    );
    const results = await installBatch({ target: targetOf('batch-same-name'), url: REPO_URL, items }, { gh });
    expect(results).toMatchObject([{ status: 'installed', name: 'foo' }, { status: 'error', error: 'já existe a skill foo' }]);
  });

  it('limite de consultas do GitHub: o 1º item toca a API, os outros são recusados na hora pelo disjuntor (`rate-limited`, com `resetAt`)', async () => {
    const clock = clockNow();
    const f = fakeGitHub(() => clock.now);
    f.commit(THREE);
    const items = await itemsOf(ghFor(f, clock), ['a', 'b', 'c']);
    const target = targetOf('batch-rate');
    const fresh = ghFor(f, clock); // cache vazio: a árvore só vem da API
    f.setLimited(true);
    const before = apiCalls(f);
    const results = await installBatch({ target, url: REPO_URL, items }, { gh: fresh });
    expect(apiCalls(f) - before).toBe(1);
    expect(results).toHaveLength(3);
    for (const r of results) expect(r).toMatchObject({ status: 'error', code: 'rate-limited', resetAt: new Date(clock.now + 3_600_000).toISOString() });
    await expect(fs.readdir(target.root)).resolves.toEqual([]);
  });

  it('a prévia segue por skill: N prévias gastam 2 consultas à API (ref + árvore), em paralelo ou em sequência', async () => {
    const f = fakeGitHub(() => 0);
    f.commit(THREE);
    await itemsOf(ghFor(f, clockNow()), ['a', 'b', 'c']);
    expect(apiCalls(f)).toBe(2);
    const g = fakeGitHub(() => 0);
    g.commit(THREE);
    const gh = ghFor(g, clockNow());
    for (const n of ['a', 'b', 'c']) await previewSkill({ url: REPO_URL, path: `skills/${n}` }, { gh });
    expect(apiCalls(g)).toBe(2);
  });

  it(`acima de ${LIMITS.chooseSkills} itens é recusado (corpo e função), sem ir ao GitHub nem gravar`, async () => {
    const item = { path: 'skills/a', ref: 'main', sha: 'a'.repeat(40), digest: 'b'.repeat(64) };
    const body = (n: number) => ({ scope: 'user', url: REPO_URL, items: Array.from({ length: n }, () => item) });
    expect(GitHubInstallBatchInput.safeParse(body(LIMITS.chooseSkills)).success).toBe(true);
    const over = GitHubInstallBatchInput.safeParse(body(LIMITS.chooseSkills + 1));
    expect(over.success ? null : over.error.issues[0]?.message).toBe(`até ${LIMITS.chooseSkills} skills por vez`);
    const none = GitHubInstallBatchInput.safeParse(body(0));
    expect(none.success ? null : none.error.issues[0]?.message).toBe('escolha ao menos uma skill');

    const f = fakeGitHub(() => 0);
    f.commit(THREE);
    const target = targetOf('batch-over');
    await expect(installBatch({ target, url: REPO_URL, items: body(LIMITS.chooseSkills + 1).items }, { gh: ghFor(f, clockNow()) })).rejects.toThrow(`até ${LIMITS.chooseSkills} skills por vez`);
    expect(f.calls).toEqual([]);
    expect(await fs.stat(target.root).catch(() => null)).toBeNull();
  });

  it('o corpo é conferido como o da instalação individual: sha, digest, caminho e o `url` de item não conta', () => {
    const ok = { path: 'skills/a', ref: 'main', sha: 'a'.repeat(40), digest: 'b'.repeat(64) };
    const parse = (item: Record<string, unknown>) => GitHubInstallBatchInput.safeParse({ scope: 'user', url: REPO_URL, items: [item] });
    expect(parse(ok).success).toBe(true);
    for (const bad of [{ ...ok, sha: 'abc' }, { ...ok, digest: 'B'.repeat(64) }, { ...ok, path: 'x'.repeat(301) }, { ...ok, ref: '' }, { ...ok, name: 'n'.repeat(65) }]) {
      expect(parse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const sneaky = parse({ ...ok, url: 'https://github.com/outro/repo' });
    expect(sneaky.success && sneaky.data.items[0]).toEqual(ok); // o repositório é um só, o do corpo
    expect(GitHubInstallBatchInput.safeParse({ scope: 'user', items: [ok] }).success).toBe(false);
  });

  it('só pela tela: a rota recusa sem `fromBrowser` antes de ler o corpo, usa o alvo da individual (refuseLibrary) e o gate/sandbox não a liberam', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    const at = src.indexOf('/^\\/api\\/skills\\/github\\/install-batch$/');
    expect(at).toBeGreaterThan(0);
    const route = src.slice(at, src.indexOf('\n  ],', at));
    const order = ['if (!fromBrowser) throw new BadRequest(', 'parse(GitHubInstallBatchInput, body)', 'githubTargetOf(b.scope, b.projectId)', 'installBatch({ target'].map((s) => route.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(/async function githubTargetOf[^{]*\{\s*if \(scope === 'library'\) refuseLibrary\(\);/.test(src)).toBe(true);
    // POST que não é da tela (ferramenta, funcionário) é 400 no gate; pela sandbox do Codex é 403.
    expect(staffMayPost('/api/skills/github/install-batch')).toBe(false);
    expect(sandboxVerdict('POST', '/api/skills/github/install-batch', 'p1')).toMatchObject({ status: 403 });
  });
});
