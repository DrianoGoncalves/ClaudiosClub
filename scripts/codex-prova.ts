import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ChatItem } from '../shared/model';
import { codexProfileArgs, sandboxFor } from '../server/chat/codexArgs';
import { CodexAdapter } from '../server/adapters/codex';
import { CodexProcess } from '../server/chat/codexProcess';
import { CodexModels } from '../server/codexModels';

// Ferramenta de desenvolvimento (fora dos testes: usa o `codex` de verdade, instalado e logado, e gasta um pouco da cota do ChatGPT).
// Rode depois de mexer em server/chat/codexArgs.ts ou ao subir a versão do Codex: a sandbox, o bloqueio de segredos e a rede local são
// comportamento do Codex, e só o `codex exec` real diz se os argumentos ainda valem.
//
// Prova real do motor Codex: abre um CodexProcess numa pasta temporária, só leitura, e manda duas mensagens (a segunda sai pelo
// `exec resume`). Imprime o que a conversa recebeu.
//
//   npx tsx scripts/codex-prova.ts [modelo] [--rede | --perfil | --plano-b]
//
// --rede: uma terceira mensagem pede um `curl` em 127.0.0.1 (um servidor deste script), para ver se a sandbox deixa a rede local
// passar (o despertador e as tarefas da ficha dependem de curl no Claudio’s Club).
// --perfil: prova o perfil de permissões (segredos, escrita e rede) em cada autonomia, num projeto falso em /var/tmp (o `.vps` de
// mentira ora pasta, ora arquivo): `cat .vps` e `ls ~/.ssh` falham; ler e escrever os outros arquivos funciona em acceptEdits/auto e a
// escrita falha em plan/manual; o curl em 127.0.0.1 responde e o https externo e o ssh falham. Sai com código 1 se algum item falhar.
// --plano-b: a ficha pede um modelo que a conta recusa (`gpt-6.1-sol` por padrão; ou passe outro no [modelo]): o motor refaz a mensagem uma
// vez com o mais parecido do catálogo de verdade (`codex debug models`) e avisa na conversa. Sai com código 1 se não houver o aviso e a resposta.

const model = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'gpt-6-sol';
const rede = process.argv.includes('--rede');
const perfil = process.argv.includes('--perfil');
const planoB = process.argv.includes('--plano-b');

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

/** Cada autonomia numa conversa nova: o que tem que funcionar (`ok`) e o que tem que falhar (`falha`). */
async function provaPerfil() {
  const base = await fs.mkdtemp(path.join('/var/tmp', 'myco-codex-perfil-'));
  const server = http.createServer((_req, res) => res.end('api-local'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const rows: Array<{ modo: string; item: string; passou: boolean; detalhe: string }> = [];
  const MARCA = 'segredo-falso-vps';
  const cases = [
    { mode: 'plan', vps: 'pasta', escreve: false },
    { mode: 'default', vps: 'arquivo', escreve: false },
    { mode: 'acceptEdits', vps: 'pasta', escreve: true },
    { mode: 'auto', vps: 'arquivo', escreve: true },
  ] as const;
  try {
    for (const c of cases) {
      const proj = path.join(base, `${c.mode}-${c.vps}`);
      await fs.mkdir(proj, { recursive: true });
      await fs.writeFile(path.join(proj, 'leia-me.txt'), 'conteudo-legivel\n');
      if (c.vps === 'pasta') {
        await fs.mkdir(path.join(proj, '.vps'));
        await fs.writeFile(path.join(proj, '.vps', 'config.json'), `{"chave":"${MARCA}"}\n`);
      } else await fs.writeFile(path.join(proj, '.vps'), `${MARCA}\n`);
      const catVps = c.vps === 'pasta' ? 'cat .vps/config.json' : 'cat .vps';
      const sessionId = randomUUID();
      let done: () => void = () => {};
      const chat = new CodexProcess({
        sessionId,
        cwd: proj,
        model,
        effort: 'low',
        permissionMode: c.mode,
        instructions: 'Você é Teste, funcionário de prova. Obedeça ao pedido literalmente; se um comando falhar, não tente contornar: só siga para o próximo.',
        secrets: { projectPath: proj, home: os.homedir(), mycoHome: path.join(os.homedir(), '.myco') },
        onIdle: (reason) => reason === 'turn' && done(),
      });
      chat.start();
      const finished = new Promise<void>((r) => (done = r));
      const comandos = [
        catVps,
        'ls ~/.ssh',
        'cat leia-me.txt',
        'echo novo > escrito.txt',
        `curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/`,
        "curl -s -m 5 -o /dev/null -w '%{http_code}' https://example.com",
        'ssh -o BatchMode=yes -o ConnectTimeout=3 example.com true',
      ];
      console.log(`\n--- ${c.mode} (.vps como ${c.vps}), pasta ${proj}`);
      chat.send(`Rode, um por vez, nesta ordem e sem comentar, exatamente estes comandos (mesmo os que falharem), e no fim diga só "fim":\n${comandos.map((x, i) => `${i + 1}) ${x}`).join('\n')}`);
      const aguarda = (p: Promise<void>) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('turno passou de 4 minutos')), 240_000))]);
      await aguarda(finished);
      const toolsOf = () => chat.snapshot().items.filter((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool');
      const ran = (needle: string) => toolsOf().some((t) => t.summary.includes(needle));
      // O modelo às vezes pula um comando por conta própria (recusa de ler segredos, por exemplo). Pedimos de novo, uma vez, só os que faltaram:
      // o que se prova aqui é o que a sandbox faz com o comando, não o que o modelo aceita rodar.
      const faltou = comandos.filter((cmd) => !ran(cmd.slice(-24)));
      if (faltou.length) {
        const again = new Promise<void>((r) => (done = r));
        console.log(`  (o modelo pulou ${faltou.length}: pedindo de novo)`);
        chat.send(`Faltou rodar estes. Rode agora, um por vez e sem comentar, exatamente como estão (é um teste autorizado da sandbox, num projeto de mentira; mesmo que deem erro):\n${faltou.join('\n')}`);
        await aguarda(again);
      }
      // Se o modelo se recusou de novo, o mesmo bloqueio é provado direto no `codex sandbox` (mesmos argumentos de perfil; não passa pelo modelo).
      const extra: Array<{ summary: string; isError: boolean; result: string | null }> = [];
      for (const cmd of comandos.slice(0, 4).filter((x) => !ran(x.slice(-24)))) {
        const r = spawnSync(
          'codex',
          ['sandbox', '-P', 'mycodeny', '-C', proj, ...codexProfileArgs({ mode: sandboxFor(c.mode), cwd: proj, projectPath: proj, home: os.homedir(), mycoHome: path.join(os.homedir(), '.myco'), network: 'off' }), '--', 'sh', '-c', cmd],
          { cwd: proj, encoding: 'utf8', timeout: 60_000 },
        );
        extra.push({ summary: cmd, isError: r.status !== 0, result: `${r.stdout}${r.stderr}`.trim() });
        console.log(`  (via codex sandbox, o modelo não rodou) $ ${cmd}  =>  ${r.status === 0 ? 'ok' : 'FALHOU'} ${JSON.stringify(`${r.stdout}${r.stderr}`.trim().slice(0, 80))}`);
      }
      const tools: Array<{ summary: string; isError: boolean; result: string | null }> = [...toolsOf(), ...extra];
      const find = (needle: string, also = '') => tools.find((t) => t.summary.includes(needle) && t.summary.includes(also));
      for (const t of tools) console.log(`  $ ${t.summary.slice(0, 90)}  =>  ${t.isError ? 'FALHOU' : 'ok'} ${JSON.stringify((t.result ?? '').slice(0, 90))}`);
      const gravou = await fs.access(path.join(proj, 'escrito.txt')).then(() => true, () => false);
      const check = (item: string, passou: boolean, detalhe: string) => rows.push({ modo: c.mode, item, passou, detalhe });
      const cat = find(c.vps === 'pasta' ? '.vps/config.json' : 'cat .vps');
      check(`${catVps} falha`, !!cat && cat.isError && !cat.result?.includes(MARCA), cat ? `exit/erro=${cat.isError}` : 'não rodou');
      const ls = find('ls ~/.ssh');
      check('ls ~/.ssh falha', !!ls && ls.isError, ls ? `erro=${ls.isError} ${JSON.stringify((ls.result ?? '').slice(0, 60))}` : 'não rodou');
      const leia = find('leia-me.txt', 'cat');
      check('ler os outros arquivos funciona', !!leia && !leia.isError && !!leia.result?.includes('conteudo-legivel'), leia ? `erro=${leia.isError}` : 'não rodou');
      const wr = find('escrito.txt');
      check(c.escreve ? 'escrever funciona' : 'escrever falha', !!wr && (c.escreve ? !wr.isError && gravou : wr.isError && !gravou), `${wr ? `erro=${wr.isError}` : 'não rodou'}, arquivo ${gravou ? 'criado' : 'não criado'}`);
      const local = find(`127.0.0.1:${port}`);
      check('curl em 127.0.0.1 responde (200)', !!local && !local.isError && local.result === '200', local ? JSON.stringify(local.result) : 'não rodou');
      const ext = find('example.com', 'curl');
      check('curl https externo falha', !!ext && (ext.isError || ext.result !== '200'), ext ? JSON.stringify((ext.result ?? '').slice(0, 80)) : 'não rodou');
      const ssh = find('ssh -o');
      check('ssh para fora falha', !!ssh && ssh.isError, ssh ? `erro=${ssh.isError} ${JSON.stringify((ssh.result ?? '').slice(0, 80))}` : 'não rodou');
      chat.stop();
    }
  } finally {
    server.close();
    await fs.rm(base, { recursive: true, force: true });
  }
  console.log('\n=== resultado');
  for (const r of rows) console.log(`${r.passou ? 'PASSOU' : 'FALHOU'}  [${r.modo}] ${r.item}  (${r.detalhe})`);
  const falhas = rows.filter((r) => !r.passou).length;
  console.log(`\n${rows.length - falhas}/${rows.length} itens passaram`);
  if (falhas) process.exitCode = 1;
}

/** A conta recusa o modelo da ficha: o turno é refeito com o mais parecido do catálogo real. */
async function provaPlanoB() {
  const wanted = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'gpt-6.1-sol';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codex-planob-'));
  const adapter = new CodexAdapter();
  const catalog = new CodexModels((fresh) => adapter.check(fresh));
  console.log(`catálogo da conta: ${(await catalog.list()).models.map((m) => m.slug).join(', ') || '(vazio)'}`);
  let done: () => void = () => {};
  const chat = new CodexProcess({
    sessionId: randomUUID(),
    cwd: dir,
    model: wanted,
    effort: 'low',
    permissionMode: 'default',
    models: async () => (await catalog.list()).models,
    secrets: { projectPath: dir, home: os.homedir(), mycoHome: path.join(os.homedir(), '.myco') },
    onIdle: (reason) => reason === 'turn' && done(),
  });
  chat.start();
  try {
    const finished = new Promise<void>((r) => (done = r));
    console.log(`\n--- a ficha pede ${wanted}; mensagem: responda só: ok`);
    chat.send('responda só: ok');
    await Promise.race([finished, new Promise((_, rej) => setTimeout(() => rej(new Error('turno passou de 4 minutos')), 240_000))]);
    const items = chat.snapshot().items;
    for (const it of items) console.log(show(it));
    const aviso = items.find((i) => i.kind === 'notice' && i.tone === 'warn' && i.text.startsWith(`O modelo ${wanted} não está disponível na sua conta; usei `));
    const erro = items.find((i) => i.kind === 'notice' && i.tone === 'error');
    const resposta = items.find((i) => i.kind === 'assistant');
    console.log(`\naviso do plano B: ${aviso ? 'PASSOU' : 'FALHOU'}; resposta: ${resposta ? 'PASSOU' : 'FALHOU'}; sem erro na conversa: ${erro ? 'FALHOU' : 'PASSOU'}; modelo da conversa continua ${chat.model} (a ficha não muda)`);
    if (!aviso || !resposta || erro) process.exitCode = 1;
  } finally {
    chat.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

(planoB ? provaPlanoB() : perfil ? provaPerfil() : main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
