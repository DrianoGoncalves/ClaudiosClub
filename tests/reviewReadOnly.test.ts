import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountUsage, Project } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { CodexProcess } from '../server/chat/codexProcess';
import { StaffService, type StaffServiceOptions } from '../server/staff/service';
import { readProfile } from '../server/staff/store';

// A conversa de revisão de tarefa não edita arquivo do projeto (t-d74d52), nos dois motores: no Claude saem Edit, MultiEdit, Write e NotebookEdit
// (`--disallowedTools`); no Codex a sandbox é só de leitura. A memória do próprio revisor segue pelo MCP `myco-memoria`. Vale ao reabrir a conversa.

let root: string;
let projectPath: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-review-ro-'));
  projectPath = path.join(root, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const project = (): Project => ({ id: 'proj-id', path: projectPath, name: 'proj', exists: true, worktreeOf: null, hasClaudeMd: false, agentCount: 0, skillCount: 0, sessionCount: 0, lastActivityAt: null });
const adapter = { listProjects: async () => [project()] } as unknown as ToolAdapter;
const noUsage = async (): Promise<AccountUsage> => ({ tapInstalled: true, limits: [], updatedAt: null });
const service = (over: Partial<StaffServiceOptions> = {}) =>
  new StaffService(adapter, { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'http://127.0.0.1:4848', readUsage: noUsage, codexEnabled: async () => true, ...over });
const base = { name: 'Rui', role: 'Revisor', mission: 'Revisar', autonomy: 'acceptEdits', launch: false };

const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? '';
const REVIEW_DENIED = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

describe('revisão no Claude', () => {
  it('sem Edit, MultiEdit, Write e NotebookEdit; a conversa comum, com eles; a memória vai pelo MCP e a ficha diz isso', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Rui Claude' }, true))!.profile;
    const review = (await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, true))!;
    expect(argOf(review.args, '--disallowedTools').split(',')).toEqual(expect.arrayContaining(REVIEW_DENIED));
    expect(argOf(review.args, '--allowedTools').split(',')).toContain('mcp__myco-memoria');
    expect(await fs.readFile(argOf(review.args, '--append-system-prompt-file'), 'utf8')).toContain('Nesta conversa de revisão a edição de arquivos fica bloqueada');
    expect(await fs.readFile(argOf(review.args, '--mcp-config'), 'utf8')).toContain('myco-memoria');

    const plain = (await svc.chatSpawn('proj-id', null, p.id))!;
    for (const tool of REVIEW_DENIED) expect(argOf(plain.args, '--disallowedTools').split(',')).not.toContain(tool);
    expect(plain.args.join(' ')).not.toContain('mcp__myco-memoria');
  });

  it('reabrir a conversa de revisão (sem o pedido) mantém o bloqueio: a ficha guardou na conversa', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Rui Reabre' }, true))!.profile;
    const first = (await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, true))!;
    expect((await readProfile(projectPath, p.id))!.sessions.find((s) => s.id === first.sessionId)).toMatchObject({ readOnly: true });
    const again = (await svc.chatSpawn('proj-id', first.sessionId, p.id))!;
    expect(argOf(again.args, '--disallowedTools').split(',')).toEqual(expect.arrayContaining(REVIEW_DENIED));
    // E a conversa comum do mesmo funcionário não ganha a marca.
    const other = (await svc.chatSpawn('proj-id', null, p.id))!;
    expect((await readProfile(projectPath, p.id))!.sessions.find((s) => s.id === other.sessionId)?.readOnly).toBeUndefined();
  });

  it('em plan a regra é a de sempre (a edição já é bloqueada): a ficha continua dizendo "em plan"', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Rui Plan', autonomy: 'plan' }, true))!.profile;
    const review = (await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, true))!;
    const ficha = await fs.readFile(argOf(review.args, '--append-system-prompt-file'), 'utf8');
    expect(ficha).toContain('Em plan a edição de arquivos fica bloqueada');
    expect(ficha).not.toContain('Nesta conversa de revisão');
  });
});

describe('revisão no Codex', () => {
  it('sandbox só de leitura (modo manual) com a memória pelo MCP; a conversa comum segue na autonomia da ficha', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Rui Codex', engine: 'codex', model: 'gpt-6-sol' }, true))!.profile;
    const review = (await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, true))!;
    expect(review.codex).toMatchObject({ readOnly: true, autonomy: 'manual' });
    expect(review.codex!.memoriaMcp).not.toBeNull();
    expect(review.codex!.instructions).toContain('Nesta conversa de revisão a edição de arquivos fica bloqueada');

    const plain = (await svc.chatSpawn('proj-id', null, p.id))!;
    expect(plain.codex).toMatchObject({ autonomy: 'acceptEdits' });
    expect(plain.codex!.readOnly).toBeUndefined();
    expect(plain.codex!.memoriaMcp ?? null).toBeNull();
  });

  it('reabrir mantém a sandbox de leitura; a ficha em plan também revisa no modo manual (sem o "proponha o plano e espere o ok")', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Rui Codex 2', engine: 'codex', model: 'gpt-6-sol' }, true))!.profile;
    const first = (await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, true))!;
    expect((await svc.chatSpawn('proj-id', first.sessionId, p.id))!.codex).toMatchObject({ readOnly: true, autonomy: 'manual' });
    const plan = (await svc.hire('proj-id', { ...base, name: 'Rui Codex Plan', engine: 'codex', model: 'gpt-6-sol', autonomy: 'plan' }, true))!.profile;
    const review = (await svc.chatSpawn('proj-id', null, plan.id, undefined, undefined, true))!.codex!;
    expect(review).toMatchObject({ readOnly: true, autonomy: 'manual' });
    expect(review.memoriaMcp).not.toBeNull();
  });

  it('o processo roda com a sandbox de leitura mesmo que o modo de permissão seja de escrita', async () => {
    const argv: string[][] = [];
    const spawnImpl = (_cmd: string, args: string[]) => {
      argv.push(args);
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 7000 + argv.length });
      return child as never;
    };
    const secrets = { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' };
    const run = async (readOnly: boolean) => {
      const chat = new CodexProcess({ cwd: '/proj', sessionId: `s-${readOnly}`, permissionMode: 'acceptEdits', readOnly, secrets, spawnImpl });
      chat.start();
      chat.send('revise');
      await new Promise((r) => setTimeout(r, 30));
      return argv[argv.length - 1]!.join(' ');
    };
    const ro = await run(true);
    expect(ro).toContain(':read-only');
    expect(ro).not.toContain(':workspace');
    const rw = await run(false);
    expect(rw).toContain(':workspace');
  });
});
