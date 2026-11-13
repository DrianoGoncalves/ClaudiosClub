import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatItem } from '../shared/model';
import { externalCut, hasExternalEffect } from '../server/chat/cutAction';
import { ResumeFile, resumeAfterRestart, takeResume, type ResumeEntry } from '../server/chat/resume';
import { capReason, capText } from '../server/chat/turnCap';
import { InboxState } from '../server/inboxState';

// Retomada segura: a ação com efeito fora do projeto cortada pelo reinício não volta sozinha (vai para você).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-cut-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const tool = (name: string, input: unknown, result: string | null, summary = ''): ChatItem => ({
  kind: 'tool',
  id: `t:${name}:${Math.random()}`,
  name,
  summary,
  input: JSON.stringify(input),
  result,
  isError: false,
  at: null,
});
const user = (text: string): ChatItem => ({ kind: 'user', id: `u:${text}`, text, at: null });
const assistant = (text: string): ChatItem => ({ kind: 'assistant', id: `a:${text}`, text, at: null });

describe('hasExternalEffect: o que mexe fora do projeto', () => {
  it.each([
    ['Bash', { command: 'git push origin main' }],
    ['Bash', { command: 'ssh deploy@vps "systemctl restart app"' }],
    ['Bash', { command: 'npm run deploy' }],
    ['Bash', { command: 'curl -X POST https://api.example.com/orders' }],
    ['Bash', { command: 'docker compose up -d' }],
    ['PowerShell', { command: 'Invoke-RestMethod -Method Post https://x' }],
    ['mcp__myco-ssh__ssh_executar', { servidor: 'vps', comando: 'rm -rf /tmp/x' }],
    ['mcp__myco-ftp__ftp_upload', { arquivo: 'index.html' }],
    ['mcp__claude-in-chrome__computer', { action: 'left_click' }],
    ['mcp__claude-in-chrome__form_input', { value: 'x' }],
    ['mcp__playwright__browser_click', {}],
    ['mcp__github__create_issue', { title: 'x' }],
  ])('%s %j: sim', (name, input) => {
    expect(hasExternalEffect(name, JSON.stringify(input))).toBe(true);
  });

  it.each([
    ['Bash', { command: 'npm test' }],
    ['Bash', { command: 'git status && git diff --stat' }],
    ['Bash', { command: 'git commit -m "x"' }],
    ['Edit', { file_path: 'a.ts' }],
    ['Write', { file_path: 'a.ts' }],
    ['Read', { file_path: 'a.ts' }],
    ['WebFetch', { url: 'https://example.com' }],
    ['Agent', { subagent_type: 'executor' }],
    ['mcp__myco-ssh__ssh_ler', { servidor: 'vps' }],
    ['mcp__myco-ssh__ssh_status', { servidor: 'vps' }],
    ['mcp__myco-ftp__ftp_list', {}],
    ['mcp__claude-in-chrome__read_page', {}],
    ['mcp__claude-in-chrome__get_page_text', {}],
    ['mcp__claude-in-chrome__tabs_context_mcp', {}],
    ['mcp__playwright__browser_snapshot', {}],
    ['mcp__github__get_me', {}],
    ['mcp__github__list_issues', {}],
  ])('%s %j: não', (name, input) => {
    expect(hasExternalEffect(name, JSON.stringify(input))).toBe(false);
  });
});

describe('externalCut: a ação que ficou pela metade no fim da conversa', () => {
  it('a última ferramenta sem resultado e com efeito fora: devolve o resumo', () => {
    const items = [user('publica'), assistant('vou'), tool('Bash', { command: 'git push' }, null, 'git push')];
    expect(externalCut(items)).toBe('git push');
  });

  it('chamadas em paralelo: acha a de efeito fora entre as sem resultado', () => {
    const items = [user('vai'), tool('Bash', { command: 'git push' }, null, 'git push'), tool('Read', { file_path: 'a' }, null, 'a')];
    expect(externalCut(items)).toBe('git push');
  });

  it('terminou (tem resultado), ficou no projeto ou veio antes da sua última mensagem: null', () => {
    expect(externalCut([user('x'), tool('Bash', { command: 'git push' }, 'ok', 'git push')])).toBeNull();
    expect(externalCut([user('x'), tool('Edit', { file_path: 'a.ts' }, null, 'a.ts')])).toBeNull();
    expect(externalCut([tool('Bash', { command: 'git push' }, null, 'git push'), user('e agora?')])).toBeNull();
    expect(externalCut([])).toBeNull();
  });

  it('sem resumo usa o nome; resumo longo é cortado', () => {
    expect(externalCut([tool('mcp__myco-ftp__ftp_upload', {}, null)])).toBe('mcp__myco-ftp__ftp_upload');
    const long = `ssh vps ${'x'.repeat(200)}`;
    const out = externalCut([tool('Bash', { command: long }, null, long)])!;
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('reinício pelo navegador: a conversa cortada numa ação externa', () => {
  const NOW = Date.parse('2026-11-13T12:00:00Z');
  const entry = (over: Partial<ResumeEntry> = {}): ResumeEntry => ({ projectId: 'p', sessionId: 'sx', staffId: 'ana', engine: 'claude', cwd: '.', hadPending: false, ...over });

  it('não envia: segura para você e diz no log; as outras retomam', async () => {
    const file = path.join(root, 'resume-cut.json');
    await new ResumeFile(file).save([entry({ sessionId: 'sx', cut: 'git push' }), entry({ sessionId: 'sy' })], NOW);
    const sent: string[] = [];
    const held: Array<{ id: string; cut: string }> = [];
    const logs: string[] = [];
    let limitAsked = 0;
    await resumeAfterRestart({
      file,
      now: () => NOW + 60_000,
      log: (l) => logs.push(l),
      stopHit: async () => (limitAsked++, null),
      send: async (e) => void sent.push(e.sessionId),
      hold: (e) => void held.push({ id: e.sessionId, cut: e.cut }),
    });
    expect(sent).toEqual(['sy']);
    expect(held).toEqual([{ id: 'sx', cut: 'git push' }]);
    expect(limitAsked).toBe(1); // a cortada nem confere o limite
    expect(logs[0]).toBe('sx: não retomada: o reinício cortou "git push" no meio (vai para você)');
  });

  it('o arquivo de antes (sem `cut`) segue valendo; `cut` vazio não passa', async () => {
    const file = path.join(root, 'resume-old.json');
    const old = { savedAt: new Date(NOW).toISOString(), sessions: [entry(), { ...entry({ sessionId: 'sz' }), cut: '' }] };
    await fs.writeFile(file, JSON.stringify(old));
    const got = await takeResume(file, NOW + 60_000, () => {});
    expect(got.map((e) => e.sessionId)).toEqual(['sx']);
    expect(got[0]).not.toHaveProperty('cut');
  });
});

describe('o aviso do corte, na caixa e na tarefa', () => {
  it('texto da caixa e motivo da tarefa', () => {
    expect(capText({ kind: 'restart', action: 'git push' })).toContain('a conversa parou no meio de "git push"');
    expect(capReason({ kind: 'restart', action: 'git push' })).toBe('a conversa parou no meio de "git push": confira se aconteceu antes de retomar');
    expect(capReason({ kind: 'tools', limit: 50 })).toBe('turno parado: passou de 50 ferramentas');
  });

  it('a caixa lembra o corte depois de reabrir', async () => {
    const file = path.join(root, 'inbox-cut.json');
    const a = new InboxState(file);
    a.setTurnCap('s1', { kind: 'restart', action: 'git push', at: '2026-11-13T12:00:00Z' });
    a.setTurnCap('s2', { kind: 'tools', limit: 50, at: '2026-11-13T12:00:00Z' });
    await a.flush();
    const b = new InboxState(file);
    expect(b.turnCapOf('s1')).toEqual({ kind: 'restart', action: 'git push' });
    expect(b.turnCapOf('s2')).toEqual({ kind: 'tools', limit: 50 });
  });
});
