import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { externalCut } from '../server/chat/cutAction';
import { ChatManager, type ChatManagerOptions } from '../server/chat/manager';
import { capReason, capText } from '../server/chat/turnCap';
import type { ChatItem } from '../shared/model';
import { removeTemp } from './support/tmp';

// "A conversa parou no meio de…" com o turno vivo (t-95cc72, caso t-3dbd93): `restartCut` lê o transcript em disco, que vai só até o início do processo de agora. Se o processo
// anterior morreu numa ação com efeito fora do projeto e outro continuou a conversa, o transcript ainda mostra a ação sem resultado, e a conversa viva era dada como parada.
// A conferência não pode segurar a conversa que trabalha (ou que uma mensagem está reabrindo), e um turno que termina normal desmente a parada guardada. A ação cortada também
// não leva o código de pareamento da URL.

let root: string;
let n = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-cutlive-'));
});
afterAll(() => removeTemp(root));

const tick = () => new Promise((r) => setTimeout(r, 15));
const PAIR = 'http://127.0.0.1:5175/api/pair?code=mwp4h60q.WisPwZXvUwJjjSGc_JMjhw.fJxo3csAb';
const NAVIGATE = 'mcp__myco-navegador__browser_navigate';

/** O claude falso: sai quando o stdin fecha. */
function fakeClaude(pid: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid });
  stdin.on('end', () => setImmediate(() => proc.emit('exit', 1)));
  const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
  return { proc, emit };
}
type Fake = ReturnType<typeof fakeClaude>;

const turnEnd = { type: 'result', is_error: false, result: 'pronto' };

/** O transcript da conversa `sx` como o processo que morreu o deixou: a navegação à URL de pareamento sem resultado. */
async function deadTranscript(dir: string) {
  await fs.mkdir(path.join(dir, 'p'), { recursive: true });
  const lines = [
    { type: 'user', timestamp: '2026-11-20T15:16:00.000Z', message: { content: 'ajuste a tela' } },
    { type: 'assistant', timestamp: '2026-11-20T15:16:05.000Z', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: NAVIGATE, input: { url: PAIR } }] } },
  ];
  await fs.writeFile(path.join(dir, 'p', 'sx.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
}

function build(extra: Partial<ChatManagerOptions> = {}) {
  const dir = path.join(root, `m-${++n}`);
  const procs: Fake[] = [];
  /** Segura a abertura do processo (abrir a conversa leva segundos) até `open()`. */
  const gate = { open: () => {}, wait: null as Promise<void> | null };
  const m = new ChatManager({
    transcriptsDir: dir,
    usageFile: path.join(dir, 'usage.json'),
    listLive: async () => [],
    resolve: async (_p, sid) => {
      await gate.wait;
      return { sessionId: sid ?? 'sx', cwd: '.', args: [] };
    },
    spawnImpl: () => {
      const f = fakeClaude(4242 + procs.length);
      procs.push(f);
      return f.proc as never;
    },
    log: () => {},
    ...extra,
  });
  return { m, procs, dir, gate };
}

describe('restartCut não segura a conversa com turno vivo', () => {
  it('controle: sem processo, a ação sem resultado do transcript é um corte, guardado sem o código de pareamento', async () => {
    const h = build();
    await deadTranscript(h.dir);
    const cut = await h.m.restartCut('p', 'sx');
    expect(cut).toMatchObject({ kind: 'restart', action: expect.stringContaining('api/pair?code=[segredo]') });
    expect(JSON.stringify(cut)).not.toContain('mwp4h60q');
    expect(h.m.turnCapOf('sx')).toMatchObject({ kind: 'restart' });
  });

  it('caso t-3dbd93: outro processo continuou a conversa e o turno roda; o transcript velho não a faz parar no meio', async () => {
    const h = build();
    await deadTranscript(h.dir);
    await h.m.send('p', 'sx', 'ana', 'continue de onde parou'); // abre o processo novo; o turno está rodando
    expect(h.m.isBusy('sx')).toBe(true);
    expect(await h.m.restartCut('p', 'sx')).toBeNull();
    expect(h.m.turnCapOf('sx')).toBeNull();
  });

  it('mensagem a caminho (o processo ainda abrindo): a conversa já não está parada, e a conferência não a segura', async () => {
    const h = build();
    await deadTranscript(h.dir);
    h.gate.wait = new Promise<void>((resolve) => (h.gate.open = resolve));
    const sending = h.m.send('p', 'sx', 'ana', 'continue de onde parou');
    await tick(); // a mensagem já saiu e o processo ainda está abrindo
    expect(h.m.isBusy('sx')).toBe(false);
    expect(await h.m.restartCut('p', 'sx')).toBeNull();
    expect(h.m.turnCapOf('sx')).toBeNull();
    h.gate.open();
    await sending;
    expect(await h.m.restartCut('p', 'sx')).toBeNull(); // o turno roda
    // O envio acabou e o turno também: o contador saiu, e a conversa parada volta a ser conferida pelo transcript.
    h.procs[0]!.emit(turnEnd);
    await tick();
    expect(await h.m.restartCut('p', 'sx')).toMatchObject({ kind: 'restart' });
  });

  it('o turno termina normal com uma parada presumida guardada: ela sai (o fim de turno da tarefa não a lê mais)', async () => {
    const h = build();
    await h.m.send('p', 'sx', 'ana', 'faça a tarefa');
    h.m.holdCut('sx', 'git push'); // a parada marcada com o turno já vivo
    expect(h.m.turnCapOf('sx')).toMatchObject({ kind: 'restart' });
    h.procs[0]!.emit(turnEnd);
    await tick();
    expect(h.m.turnCapOf('sx')).toBeNull();
  });
});

describe('a ação cortada não leva o valor de ?code= da URL', () => {
  const tool = (name: string, input: unknown, summary: string): ChatItem => ({ kind: 'tool', id: `t:${name}`, name, summary, input: JSON.stringify(input), result: null }) as ChatItem;

  it('o resumo da ação (caixa, histórico, resume.json) sai com o código trocado, mesmo que o corte de 80 caracteres o deixasse pela metade', () => {
    const action = externalCut([{ kind: 'user', id: 'u', text: 'vai' } as ChatItem, tool(NAVIGATE, { url: PAIR }, PAIR)])!;
    expect(action).toBe('http://127.0.0.1:5175/api/pair?code=[segredo]');
    expect(action).not.toContain('mwp4h60q');
  });

  it('o aviso e o motivo de Aguardar mascaram também a ação já guardada com o código inteiro', () => {
    const hit = { kind: 'restart' as const, action: PAIR };
    const cut = { kind: 'retry' as const, why: 'cut' as const, action: PAIR, error: 'queda' };
    for (const text of [capText(hit), capReason(hit), capText(cut), capReason(cut)]) {
      expect(text).toContain('?code=[segredo]');
      expect(text).not.toContain('mwp4h60q');
    }
  });
});
