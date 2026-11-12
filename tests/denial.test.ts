import { describe, expect, it } from 'vitest';
import { classifyDenial, denialNotice } from '../server/chat/denial';
import { ChatProcess } from '../server/chat/process';

// Textos reais do Claude Code (resultado de ferramenta negada).
const CLASSIFIER_REASON = 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Production Deploy]. Ask the user before continuing.';
const CLASSIFIER_NO_REASON = 'Permission for this action was denied. Reason: The server-side auto mode classifier judged this action dangerous (it gave no explanation).';
const CLASSIFIER_NO_VERDICT = 'The server-side auto mode classifier gave no verdict (error). Try again.';
const CLASSIFIER_CUT = 'The server-side auto mode classifier gave no verdict (the response ended before its verdict arrived).';
const CLUB_SSH = 'Permission to use PowerShell with command ssh deploy@10.0.0.5 "ls" has been denied.';
const CLUB_SCP = 'Permission to use Bash with command scp ./a.txt deploy@host:/tmp has been denied.';
const CLUB_SECRET = 'Permission to use PowerShell with command Get-Content .ssh/id_ed25519 has been denied.';

describe('classifyDenial', () => {
  it('classificador com motivo entre colchetes', () => {
    expect(classifyDenial(CLASSIFIER_REASON)).toEqual({ layer: 'classifier', reason: 'Production Deploy', hint: 'autonomy' });
  });

  it('classificador sem motivo: não inventa um', () => {
    expect(classifyDenial(CLASSIFIER_NO_REASON)).toEqual({ layer: 'classifier', hint: 'autonomy' });
  });

  it('classificador sem veredito (erro ou resposta cortada) pede nova tentativa', () => {
    expect(classifyDenial(CLASSIFIER_NO_VERDICT)).toEqual({ layer: 'classifierError', hint: 'retry' });
    expect(classifyDenial(CLASSIFIER_CUT)).toEqual({ layer: 'classifierError', hint: 'retry' });
  });

  it('bloqueio do Club com ssh, scp, sftp ou rsync sugere dar acesso a servidores', () => {
    expect(classifyDenial(CLUB_SSH)).toEqual({ layer: 'club', hint: 'servers' });
    expect(classifyDenial(CLUB_SCP)).toEqual({ layer: 'club', hint: 'servers' });
    expect(classifyDenial('Permission to use Bash with command sftp -b x host has been denied.')).toEqual({ layer: 'club', hint: 'servers' });
    expect(classifyDenial('Permission to use Bash with command rsync -a src host:/x has been denied.')).toEqual({ layer: 'club', hint: 'servers' });
  });

  it('bloqueio do Club de outro comando é arquivo protegido, sem dica', () => {
    expect(classifyDenial(CLUB_SECRET)).toEqual({ layer: 'club', hint: null });
    // "ssh" no meio do comando não conta; "ssh-keygen" também não é conexão.
    expect(classifyDenial('Permission to use Bash with command cat notes.txt ssh has been denied.')).toEqual({ layer: 'club', hint: null });
    expect(classifyDenial('Permission to use Bash with command ssh-keygen -t ed25519 has been denied.')).toEqual({ layer: 'club', hint: null });
  });

  it('erro comum, sem negação, fica em other', () => {
    expect(classifyDenial('exit code 1: arquivo não encontrado')).toEqual({ layer: 'other', hint: null });
    expect(classifyDenial('')).toEqual({ layer: 'other', hint: null });
  });
});

describe('denialNotice', () => {
  it('textos pt-BR de cada camada', () => {
    expect(denialNotice('Bash', classifyDenial(CLASSIFIER_REASON))).toBe(
      '`Bash` barrado pelo classificador do Claude Code (modo Autônomo): Production Deploy.',
    );
    expect(denialNotice('Bash', classifyDenial(CLASSIFIER_NO_REASON))).toBe(
      '`Bash` barrado pelo classificador do Claude Code (modo Autônomo): sem motivo informado.',
    );
    expect(denialNotice('Bash', classifyDenial(CLASSIFIER_NO_VERDICT))).toBe(
      '`Bash`: o classificador do Claude Code não respondeu; peça para tentar de novo.',
    );
    expect(denialNotice('PowerShell', classifyDenial(CLUB_SSH))).toBe('`PowerShell` bloqueado pelo Club: a ficha não tem conexão SSH.');
    expect(denialNotice('PowerShell', classifyDenial(CLUB_SECRET))).toBe('`PowerShell` bloqueado pelo Club: arquivo protegido (segredo ou chave).');
    expect(denialNotice('Read', classifyDenial('exit code 1'))).toBe('Read: permissão negada');
  });
});

describe('aviso de negação no chat (ChatProcess)', () => {
  /** Monta um turno com uma ferramenta: o tool_use e, depois, o resultado com `is_error`. */
  function turn(name: string, input: object) {
    const chat = new ChatProcess({ sessionId: 's-denial', cwd: 'C:\\proj', args: [] });
    chat.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name, input }] } });
    return chat;
  }
  const notices = (chat: ChatProcess) => chat.snapshot().items.filter((i) => i.kind === 'notice');
  const result = (chat: ChatProcess, text: string, isError = true) =>
    chat.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: text, is_error: isError }] } });

  it('evento de negação seguido do resultado: o aviso ganha o motivo do classificador', () => {
    const chat = turn('Bash', { command: 'npm run deploy' });
    chat.handle({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu1' });
    expect(notices(chat)).toEqual([expect.objectContaining({ text: 'Bash: permissão negada', tool: 'Bash' })]);
    expect(notices(chat)[0]).not.toHaveProperty('denial');

    result(chat, CLASSIFIER_REASON);
    const [n] = notices(chat);
    expect(n).toMatchObject({
      kind: 'notice',
      tone: 'warn',
      tool: 'Bash',
      text: '`Bash` barrado pelo classificador do Claude Code (modo Autônomo): Production Deploy.',
      denial: { layer: 'classifier', reason: 'Production Deploy', hint: 'autonomy' },
    });
    // Troca o aviso, não duplica.
    expect(notices(chat)).toHaveLength(1);
  });

  it('bloqueio do Club sem evento: o resultado abre o aviso com a dica de servidores', () => {
    const chat = turn('PowerShell', { command: 'ssh deploy@10.0.0.5 ls' });
    result(chat, CLUB_SSH);
    expect(notices(chat)).toEqual([
      expect.objectContaining({
        text: '`PowerShell` bloqueado pelo Club: a ficha não tem conexão SSH.',
        tool: 'PowerShell',
        denial: { layer: 'club', hint: 'servers' },
      }),
    ]);
  });

  it('erro comum (não é negação) não gera aviso', () => {
    const chat = turn('Read', { file_path: 'x.ts' });
    result(chat, 'arquivo não encontrado');
    expect(notices(chat)).toEqual([]);
  });

  it('negação sem texto reconhecível mantém o aviso genérico, com o denial em other', () => {
    const chat = turn('Read', { file_path: 'x.ts' });
    chat.handle({ type: 'system', subtype: 'permission_denied', tool_name: 'Read', tool_use_id: 'tu1' });
    result(chat, 'texto novo que não conheço');
    expect(notices(chat)).toEqual([
      expect.objectContaining({ text: 'Read: permissão negada', denial: { layer: 'other', hint: null } }),
    ]);
  });
});
