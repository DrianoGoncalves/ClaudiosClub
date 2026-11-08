import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ChatItem } from '../shared/model';
import { CodexProcess } from '../server/chat/codexProcess';

// Prova real do motor Codex: abre um CodexProcess numa pasta temporária, só leitura, e manda duas mensagens (a segunda sai pelo
// `exec resume`). Imprime o que a conversa recebeu. Usa o `codex` instalado e logado (gasta um pouco da cota do ChatGPT).
//
//   npx tsx scripts/codex-prova.ts [modelo] [--rede]
//
// --rede: uma terceira mensagem pede um `curl` em 127.0.0.1 (um servidor deste script), para ver se a sandbox deixa a rede local
// passar (o despertador e as tarefas da ficha dependem de curl no Claudio’s Club).

const model = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'gpt-6-sol';
const rede = process.argv.includes('--rede');

const show = (it: ChatItem) => {
  const clip = (t: string) => (t.length > 300 ? `${t.slice(0, 300)}…` : t).replace(/\n/g, '\n      ');
  if (it.kind === 'user') return `[você]       ${clip(it.text)}`;
  if (it.kind === 'assistant') return `[codex]      ${clip(it.text)}`;
  if (it.kind === 'tool') return `[${it.name}${it.isError ? ' ERRO' : ''}] ${it.summary}  =>  ${clip(it.result ?? '(sem resultado)')}`;
  if (it.kind === 'notice') return `[aviso ${it.tone}] ${clip(it.text)}`;
  return `[${it.kind}]`;
};

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codex-prova-'));
  const meta = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codex-meta-'));
  await fs.writeFile(path.join(dir, 'nota.txt'), 'conteúdo de teste\n');
  const sessionId = randomUUID();
  const threadFile = path.join(meta, sessionId, 'codex-thread.json');
  let server: http.Server | null = null;
  let port = 0;
  if (rede) {
    server = http.createServer((_req, res) => res.end('resposta-do-servidor-local'));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  }

  let printed = 0;
  let done: () => void = () => {};
  const chat = new CodexProcess({
    sessionId,
    cwd: dir,
    model,
    effort: 'low',
    permissionMode: 'default', // manual → sandbox read-only
    instructions: 'Você é Teste, um funcionário de prova do Claudio’s Club. Responda em português, curto.',
    threadFile,
    onIdle: (reason) => reason === 'turn' && done(),
  });
  chat.start();
  const turn = async (text: string) => {
    const finished = new Promise<void>((r) => (done = r));
    console.log(`\n--- mensagem: ${text}`);
    chat.send(text);
    await Promise.race([finished, new Promise((_, rej) => setTimeout(() => rej(new Error('turno passou de 4 minutos')), 240_000))]);
    const { items, state } = chat.snapshot();
    for (const it of items.slice(printed)) console.log(show(it));
    printed = items.length;
    console.log(`    (busy=${state.busy} thread=${chat.threadId} contexto=${state.context ? `${state.context.used}/${state.context.window}` : 'n/d'})`);
  };

  try {
    console.log(`motor: codex, modelo ${model}, sandbox read-only, pasta ${dir}`);
    await turn('Meu código de teste é pera-azul. Rode o comando `echo $MYCO_SESSION_ID` e responda só com o valor que saiu, mais "anotei o código".');
    await turn('Qual foi a minha primeira mensagem? Depois tente criar o arquivo teste.txt com o texto oi e diga se conseguiu.');
    if (rede) await turn(`Rode exatamente: curl -s -m 5 http://127.0.0.1:${port}/ ; echo "codigo=$?"  e me diga o que saiu.`);
    const wrote = await fs.access(path.join(dir, 'teste.txt')).then(() => true, () => false);
    console.log(`\nteste.txt criado na pasta? ${wrote ? 'SIM (a sandbox deixou escrever!)' : 'não (só leitura, como esperado)'}`);
    console.log(`thread_id gravado: ${(await fs.readFile(threadFile, 'utf8').catch(() => '(nada)')).trim()}`);
  } finally {
    chat.stop();
    server?.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(meta, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
