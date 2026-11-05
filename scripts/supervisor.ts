import fs from 'node:fs';

// O laço do vigia (scripts/daemon.ts), sem nada do sistema: quem chama passa como subir, gerar e esperar.
// Regra: código novo só entra pelo botão. Reiniciar (ou Atualizar) no config faz o servidor gravar o pedido antes de
// sair; aí o vigia refaz pacote e cliente. Saída sem pedido é queda: sobe de novo a mesma versão, sem gerar nada
// (só o cliente, se sumiu, porque sem ele não há tela). O vigia não observa arquivos: editar código não reinicia.

export interface SupervisorDeps {
  /** Parada pedida (botão Parar, daily:stop, sinal): sai do laço. */
  shouldStop(): boolean;
  /** O servidor saiu pelo botão Reiniciar/Atualizar? Consome o pedido. */
  takeRestartRequest(): boolean;
  /** Subida completa (a primeira e a do botão): gera o que mudou e devolve os argumentos do servidor. */
  prepare(): Promise<string[]>;
  /** Depois de uma queda: só o indispensável para ter tela, sem trazer código novo. */
  repair(): Promise<void>;
  /** Roda o servidor até ele sair; devolve o código de saída. */
  run(args: string[]): Promise<number | null>;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  now?(): number;
}

/** Consome um arquivo-sinal (ex.: o pedido de reinício que o servidor grava): existia? */
export function takeFlag(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export interface StartIO {
  clientChanged(): boolean;
  clientMissing(): boolean;
  buildClient(): void;
  /** Refaz os pacotes que ficaram velhos e diz como subir o servidor. */
  serverArgs(): Promise<string[]>;
}

/** O `prepare` e o `repair` do vigia: a subida completa gera o que mudou; depois de uma queda, só o cliente que falta. */
export function startSteps(io: StartIO): Pick<SupervisorDeps, 'prepare' | 'repair'> {
  return {
    prepare: async () => {
      if (io.clientChanged()) io.buildClient();
      return io.serverArgs();
    },
    repair: async () => {
      if (io.clientMissing()) io.buildClient();
    },
  };
}

/** Caiu antes disto (ms) conta como queda na subida: espera cada vez mais. */
export const QUICK_EXIT_MS = 30_000;
/** Quedas seguidas na subida até o vigia desistir da versão no ar e gerar a do disco (não há conversa a perder). */
export const QUICK_EXITS_BEFORE_REBUILD = 3;

export async function supervise(d: SupervisorDeps): Promise<void> {
  const now = d.now ?? Date.now;
  /** Como o servidor no ar foi subido; null: a próxima subida é completa. */
  let args: string[] | null = null;
  let delay = 5;
  let quickExits = 0;
  while (!d.shouldStop()) {
    if (args) await d.repair();
    else args = await d.prepare();
    const started = now();
    const code = await d.run(args);
    if (d.shouldStop()) break;

    const quick = now() - started < QUICK_EXIT_MS;
    // Caiu logo de novo (porta ocupada, erro na subida): espera cada vez mais, até 1 min.
    delay = quick ? Math.min(delay * 2, 60) : 5;
    if (d.takeRestartRequest()) {
      args = null;
      quickExits = 0;
      d.log(`reinício pedido pelo config; subindo em ${delay} s com o código atual`);
    } else {
      quickExits = quick ? quickExits + 1 : 0;
      if (quickExits >= QUICK_EXITS_BEFORE_REBUILD) {
        args = null;
        quickExits = 0;
        d.log(`o servidor saiu (código ${code}) ${QUICK_EXITS_BEFORE_REBUILD}x seguidas na subida; religando em ${delay} s com o código atual`);
      } else {
        d.log(`o servidor saiu (código ${code}); religando em ${delay} s com a mesma versão`);
      }
    }
    await d.sleep(delay * 1000);
  }
}
