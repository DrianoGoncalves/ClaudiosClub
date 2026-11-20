import fs from 'node:fs/promises';
import { editorEnv, hasGraphicalSession } from './openInEditor';
import { ProjectFileError } from './projectFiles';
import { openTerminal, type TerminalResult } from './terminal';

// O botão "Abrir terminal" do painel do projeto: o servidor local abre um terminal do computador do dono já dentro da pasta do projeto.
//
// Não é um lançador: o programa é fixo por sistema (o shell, sem argumento nenhum vindo da tela) e o único dado de fora é o projeto, cuja pasta vem do
// cadastro (nunca do corpo do pedido). Só o navegador pareado (`fromBrowser`): ferramenta, funcionário e sandbox levam 403. O ambiente do terminal sai
// sem os tokens do Club/CLI e sem chaves (`editorEnv`), como o do editor de segredo.
//   Windows: cmd.exe /k  (console próprio, na pasta)       Linux: o shell do ambiente (SHELL, caminho absoluto) ou /bin/sh, no 1º terminal instalado
//   macOS: sem abertura automática (`openTerminal` recusa).

export interface OpenProjectTerminalResult {
  opened: true;
}

/** Códigos de recusa que a tela entende (`code` no corpo do erro). */
export type OpenTerminalCode = 'no-display' | 'no-terminal' | 'folder-missing';

export interface OpenProjectTerminalOptions {
  /** Os testes trocam (para não abrir janela de verdade e cobrir os sistemas). */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  open?: typeof openTerminal;
  log?: (line: string) => void;
}

const refuse = (code: OpenTerminalCode, message: string, status = 409) => new ProjectFileError(status, message, { code });

/** O comando do shell deste sistema (programa e argumentos fixos). */
export function shellCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') return ['cmd.exe', '/k'];
  const shell = env.SHELL ?? '';
  return [shell.startsWith('/') && !/\s/.test(shell) ? shell : '/bin/sh'];
}

/**
 * Abre o terminal na pasta do projeto (`projectDir`; null = projeto desconhecido, devolve null e a rota responde 404). Recusas: fora do navegador pareado
 * (403); pasta que não existe mais (409, 'folder-missing'); sem sessão gráfica (409, 'no-display'); nenhum terminal que abra (409, 'no-terminal').
 */
export async function openProjectTerminalRoute(
  req: { fromBrowser: boolean; projectDir: string | null },
  o: OpenProjectTerminalOptions = {},
): Promise<OpenProjectTerminalResult | null> {
  if (!req.fromBrowser) throw new ProjectFileError(403, 'o terminal só é aberto pelo Claudio’s Club');
  if (!req.projectDir) return null;
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const cwd = await fs.realpath(req.projectDir).catch(() => null);
  if (!cwd || !(await fs.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
    throw refuse('folder-missing', 'a pasta do projeto não existe mais neste computador');
  }
  if (!hasGraphicalSession(platform, env)) {
    throw refuse('no-display', 'este computador não tem sessão gráfica para abrir o terminal (o Claudio’s Club roda sem tela): abra um terminal na pasta do projeto');
  }
  const result: TerminalResult = (o.open ?? openTerminal)(shellCommand(platform, env), { title: 'Claudio’s Club', env: editorEnv(env), cwd });
  if (!result.ok) {
    // A mensagem do sistema pode trazer caminho do usuário: vai só ao log; a tela recebe o texto fixo.
    o.log?.(`[terminal] não abriu: ${(result.error ?? 'erro').slice(0, 200)}`);
    throw refuse('no-terminal', 'não deu para abrir um terminal neste computador: abra um na pasta do projeto');
  }
  o.log?.('[terminal] aberto na pasta de um projeto');
  return { opened: true };
}
