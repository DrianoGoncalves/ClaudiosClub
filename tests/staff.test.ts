import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountUsage, Project, StaffProfile } from '../shared/model';
import { usageStopHit, UsageStopError } from '../server/usageStop';
import { ensureWorktree, worktreeFor } from '../server/staff/worktree';
import { listServers } from '../server/staff/servers';
import { execFileSync } from 'node:child_process';
import type { ToolAdapter } from '../server/adapters/types';
import {
  buildClaudeArgs,
  capAutonomy,
  isClaudeRoot,
  MANUAL_DIR,
  renderFicha,
  systemPrompt,
  sanitizeArg,
  secretDenyRules,
  slugify,
  tabTitleSnippet,
  type FichaContext,
} from '../server/staff/ficha';
import { ROOT } from '../server/root';
import { buildMcpConfig, listMcpServers } from '../server/staff/mcp';
import { StaffError, StaffService } from '../server/staff/service';
import { StateBusyError } from '../server/atomicWrite';
import { readProfile, saveChatChoice, StaffInputSchema, writeAtomic } from '../server/staff/store';
import { AGENT_PRESETS } from '../shared/agentPresets';
import { BUILTIN_ROLES } from '../shared/roles';
import { listRoles, saveRole } from '../server/roles';
import { PERSONALITIES, PERSONALITY_PROMPTS, personalityName, personalityReminder, personalitySection } from '../shared/personality';
import { staffSettings } from '../server/staff/launch';
import { CLEAN_BROWSER_MCP_NAME } from '../server/chat/codexArgs';
import { removeTemp } from './support/tmp';

// Os cargos (server/roles.ts) e a config leem MYCO_HOME: uma pasta temporária, para não usar o ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-staff-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

const profile = (over: Partial<StaffProfile> = {}): StaffProfile => ({
  id: 'ana-1a2b',
  projectId: 'p',
  name: 'Ana "Revisora" Souza',
  role: 'Revisora 100%',
  portrait: null,
  reportsTo: [],
  mission: 'Revisar mudanças',
  firstTask: 'Revise o último commit',
  autonomy: 'plan',
  agents: ['Explore'],
  skills: [],
  mcps: null,
  knowledge: ['docs/arq.md'],
  rules: ['Não altere arquivos'],
  doneWhen: 'Lista de achados',
  model: 'opus',
  effort: 'high',
  canHire: false,
  playbook: null,
  worktree: false,
  servers: [],
  browser: false,
  sessions: [],
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  ...over,
});

const ctx: FichaContext = {
  company: 'Acme & Cia',
  projectName: 'painel',
  projectPath: 'C:\\www\\painel',
  managerNames: [],
  fichaPath: '.myco\\staff\\ana-1a2b.md',
  memoryPath: '.myco\\staff\\ana-1a2b.memory.md',
  mycoUrl: 'http://127.0.0.1:4848',
};

describe('ficha', () => {
  it('gestor: a equipe dele, com o caminho para passar tarefa, e o roteiro manda o que é da área para a pessoa', () => {
    const team = [
      { id: 'luana-0d88', name: 'Luana', role: 'Design system', mission: 'Cuidar do design system. E de mais coisas.' },
      { id: 'raquel-1', name: 'Raquel', role: 'Infra', mission: 'Servidores.', temporary: true },
    ];
    const md = renderFicha(profile({ projectId: 'proj-x', playbook: 'plan-big-execute-small' }), { ...ctx, team });
    expect(md).toContain('## Sua equipe');
    expect(md).toContain('- Luana (Design system), id `luana-0d88`: Cuidar do design system.');
    expect(md).toContain('- Raquel (Infra, temporário)');
    expect(md).toContain('POST http://127.0.0.1:4848/api/projects/proj-x/tasks');
    expect(md).toContain('acceptance (o critério de pronto), goal (opcional');
    expect(md).toContain('blockedBy (ids das tarefas que precisam terminar antes');
    expect(md).toContain('requestedBy: "ana-1a2b"');
    // Todo pedido da ficha à API leva o token da conversa (MYCO_TOKEN, já no ambiente).
    expect(md).toContain('com os cabeçalhos `x-myco: 1` e `x-myco-token: $MYCO_TOKEN`');
    expect(md).toContain('GET http://127.0.0.1:4848/api/projects/proj-x/tasks (com o cabeçalho `x-myco-token: $MYCO_TOKEN`)');
    expect(md).toContain('Antes de chamar um agent (ou de fazer você mesmo): se a tarefa é da área de alguém da sua equipe');
    // O que é da área não fica com o gestor, ele repassa sem pesquisar o código e confere na medida do risco.
    expect(md).toContain('nem para o executor nem para você');
    expect(md).toContain('Repasse sem pesquisar');
    expect(md).toContain('Confira na medida do risco');
    // Sem equipe, nada disso.
    const solo = renderFicha(profile({ playbook: 'plan-big-execute-small' }), ctx);
    expect(solo).not.toContain('Sua equipe');
    // Contratado sozinho, os agents do roteiro já aparecem como indicados, com os da ficha.
    expect(solo).toContain('Agents: pesquisador, executor, executor-rapido, revisor, Explore.');
    expect(solo).toContain('`executor-rapido` (Haiku)');
    expect(solo).toMatch(/implementar o que já está decidido[^\n]*`executor` \(Sonnet\)/);
    expect(solo).toMatch(/pede julgamento[^\n]*`executor` com model: "opus"/);
    expect(solo).toContain('run_in_background: false');
    // Quem reporta a alguém entrega com as provas; quem não reporta, não tem a seção.
    expect(renderFicha(profile(), { ...ctx, managerNames: ['Daniel'] })).toContain('## Entrega');
    expect(solo).not.toContain('## Entrega');
  });

  it('roteiro de quem implementa: planeja, passa a decisão pronta, confere o diff e só faz sozinho o que é de baixo risco', () => {
    const md = renderFicha(profile({ playbook: 'plan-big-execute-small' }), ctx);
    expect(md).toContain('Planeje primeiro: entenda o pedido');
    expect(md).toContain('Entregue a decisão pronta: o objetivo (o porquê), os arquivos que ele pode mexer (com caminho), o que já foi decidido, o que não mexer e por quê');
    expect(md).toContain('as alterações (arquivo:linha), o que verificou (comando e resultado) e o que ficou pendente');
    expect(md).toContain('Confira o diff de cada entrega antes da próxima (`git diff --stat`');
    // A exceção é por risco, não por número de linhas.
    expect(md).toContain('mudança local, conhecida e de baixo risco');
    expect(md).toContain('O critério é o risco, não o número de linhas');
    expect(md).not.toContain('uma linha num arquivo que você já leu');
    // O modelo que a ficha cita é o do pronto (nada do executor antigo em Haiku).
    const label = (name: string) => {
      const m = AGENT_PRESETS.find((p) => p.name === name)!.model;
      return m[0]!.toUpperCase() + m.slice(1);
    };
    for (const name of ['executor', 'executor-rapido', 'pesquisador']) expect(md).toContain(`\`${name}\` (${label(name)}`);
    expect(md).not.toMatch(/`executor` \(Haiku/);
  });

  it('com SPEC.md na raiz, a ficha manda consultar o guia antes do Conhecimento; sem ele, nada disso', () => {
    const md = renderFicha(profile(), { ...ctx, guide: true });
    expect(md).toContain('## Guia do projeto');
    expect(md).toContain('Leia `SPEC.md` (raiz do projeto) antes de começar algo novo');
    expect(md).toContain('Se o pedido conflitar com o guia, aponte o conflito em vez de seguir.');
    expect(md.indexOf('## Guia do projeto')).toBeLessThan(md.indexOf('## Conhecimento'));
    const none = renderFicha(profile(), ctx);
    expect(none).not.toContain('Guia do projeto');
    expect(none).not.toContain('SPEC.md');
  });

  it('todo funcionário tem a postura antes das regras, com ou sem gestor, equipe ou guia', () => {
    const cases = [
      renderFicha(profile(), ctx),
      renderFicha(profile({ canHire: true, projectId: 'proj-x' }), { ...ctx, managerNames: ['Daniel'], guide: true }),
    ];
    for (const md of cases) {
      expect(md).toContain('## Postura\nAntes de concordar, teste a ideia: aponte primeiro o que está errado, faltando ou arriscado e o contra-argumento mais forte.');
      expect(md).toContain('Sem elogio vazio nem pedido de desculpas: vá direto ao ponto técnico.');
      expect(md).toContain('Não anuncie nem narre os passos');
      expect(md.indexOf('## Postura')).toBeLessThan(md.indexOf('## Regras'));
    }
  });

  it('Codex ligado: o roteiro manda perguntar ao GPT pela ferramenta do MCP; desligado, nada disso', () => {
    const roteiro = profile({ playbook: 'plan-big-execute-small' });
    const on = renderFicha(roteiro, { ...ctx, codex: true });
    expect(on).toContain('pergunte também ao GPT pela ferramenta `mcp__myco-gpt__perguntar_gpt`');
    expect(on).toContain('mostre em 1-2 linhas o veredito do GPT');
    expect(on).toContain('se discordarem, mostre as duas posições em linguagem simples');
    // Os agents do roteiro não mudam: o GPT é uma ferramenta, não um agent.
    expect(on).toContain('Agents: pesquisador, executor, executor-rapido, revisor, Explore.');
    for (const md of [renderFicha(roteiro, ctx), renderFicha(roteiro, { ...ctx, codex: false })]) {
      expect(md).not.toContain('myco-gpt');
      expect(md).not.toContain('perguntar_gpt');
    }
    // Sem roteiro, ou no motor Codex (que não tem MCPs), a ficha não fala disso.
    expect(renderFicha(profile(), { ...ctx, codex: true })).not.toContain('perguntar_gpt');
    expect(renderFicha(profile({ playbook: 'plan-big-execute-small', engine: 'codex' }), { ...ctx, codex: true })).not.toContain('perguntar_gpt');
  });

  it('tem missão, autonomia, regras, memória e a seção de contratação', () => {
    const md = renderFicha(profile(), ctx);
    for (const part of ['## Missão', 'Revisar mudanças', '## Primeira tarefa', 'Só lê e planeja', '- Não altere arquivos', '## Memória', 'ana-1a2b.memory.md', 'substitua o que ficou velho', '`[MyCo:ponto-de-corte]`', 'não pode contratar']) {
      expect(md).toContain(part);
    }
    const hiring = renderFicha(profile({ canHire: true, projectId: 'proj-x' }), ctx);
    expect(hiring).toContain('/api/projects/proj-x/staff com');
    expect(hiring).toContain('reportsTo: ["ana-1a2b"]');
    expect(hiring).toContain('Antes de contratar, nesta ordem');
    expect(hiring).toContain('roleId (um dos cargos prontos abaixo)');
    // Sem cargos na ficha (ctx sem roles), a linha não aparece.
    expect(hiring).not.toContain('Cargos prontos (roleId)');
    expect(hiring).toContain('/api/projects/proj-x/staff/<id dele>/done');
    expect(hiring).toContain('"requestedBy": "ana-1a2b"');
    expect(hiring).toContain('POST http://127.0.0.1:4848/api/projects/proj-x/staff com os cabeçalhos `x-myco: 1` e `x-myco-token: $MYCO_TOKEN`');
    expect(hiring).toContain('/chat/send com {"sessionId", "staffId", "text"} (mesmos cabeçalhos)');
    expect(hiring).toContain('(mesmos cabeçalhos; só vale para quem você contratou)');
    // O próprio temporário sabe que é temporário.
    expect(renderFicha(profile({ temporary: true }), ctx)).toContain('Você é temporário');
    expect(md).not.toContain('Você é temporário');
  });

  it('cargos prontos: a linha com os roleId só para quem pode contratar', () => {
    const roles = [
      { id: 'dados', label: 'Dados (DBA)' },
      { id: 'produto', label: 'Produto (PO)' },
    ];
    const hiring = renderFicha(profile({ canHire: true, projectId: 'proj-x' }), { ...ctx, roles });
    expect(hiring).toContain('Antes de contratar, nesta ordem');
    expect(hiring).toContain('Cargos prontos (roleId): `dados` (Dados (DBA)), `produto` (Produto (PO))');
    const noHire = renderFicha(profile(), { ...ctx, roles });
    expect(noHire).not.toContain('Antes de contratar, nesta ordem');
    expect(noHire).not.toContain('Cargos prontos (roleId)');
  });

  it('despertador: seção curta com o curl (id da conversa em $MYCO_SESSION_ID), os limites e o que preferir para o que roda aqui', () => {
    const md = renderFicha(profile({ projectId: 'proj-x' }), ctx);
    const section = md.slice(md.indexOf('## Despertador'), md.indexOf('## Memória'));
    expect(section.startsWith('## Despertador')).toBe(true);
    for (const part of [
      'deploy em outro servidor',
      'CI do GitHub',
      'Bash em segundo plano',
      'ferramenta Monitor',
      'curl -s -X POST -H "x-myco: 1" -H "x-myco-token: $MYCO_TOKEN"',
      '`$MYCO_TOKEN` é o token dela',
      '"seconds": 120',
      '"text":',
      'http://127.0.0.1:4848/api/projects/proj-x/chat/$MYCO_SESSION_ID/wake`',
      '$MYCO_SESSION_ID/wake/cancel',
      'De 10 s a 24 h',
      'um por conversa',
      'laço curto',
      '20 despertadores seguidos sem o usuário falar',
    ]) {
      expect(section).toContain(part);
    }
    // Curta: cabe em poucas linhas.
    expect(section.trim().split('\n').length).toBeLessThanOrEqual(5);
    // Todo funcionário roda pelo Claudio’s Club, então toda ficha tem; sem o endereço do Claudio’s Club, não.
    expect(renderFicha(profile({ canHire: true }), ctx)).toContain('## Despertador');
    expect(renderFicha(profile(), { ...ctx, mycoUrl: '' })).not.toContain('## Despertador');
  });

  it('"Pode versionar e fazer deploy" (canRelease): a seção da pausa de versão só aparece com a permissão, igual para Claude e Codex, e sem o endereço do Club não sai', () => {
    for (const engine of ['claude', 'codex'] as const) {
      const com = renderFicha(profile({ projectId: 'proj-x', engine, canRelease: true }), ctx).replaceAll('AGENTS.md', 'INSTRUCOES.md');
      const section = com.slice(com.indexOf('## Versão e deploy'), com.indexOf('## Despertador'));
      expect(section, engine).toContain('"Pode versionar e fazer deploy"');
      expect(section).toContain('POST http://127.0.0.1:4848/api/projects/proj-x/version-pause com os cabeçalhos `x-myco: 1` e `x-myco-token: $MYCO_TOKEN`');
      expect(section).toContain('{"minutes": 30} (de 1 a 120, obrigatório)');
      expect(section).toContain('POST http://127.0.0.1:4848/api/projects/proj-x/version-pause/end');
      expect(section).toContain('nada novo começa');
      expect(section).toContain('os arquivos ainda podem mudar');
      expect(section).toContain('sai sozinha no fim do prazo');
      // Sem a permissão (ou com ela desligada, ou numa ficha antiga sem o campo): nada de seção.
      for (const over of [{ canRelease: false }, {}]) expect(renderFicha(profile({ projectId: 'proj-x', engine, ...over }), ctx), engine).not.toContain('Versão e deploy');
      expect(renderFicha(profile({ engine, canRelease: true }), { ...ctx, mycoUrl: '' })).not.toContain('Versão e deploy');
      // No Codex a ficha não cita o que ele não tem (agents, skills, Chrome, Monitor, revisor).
      if (engine === 'codex') for (const banned of [/\bAgent\b/, /agents?\b/i, /subagent/i, /pesquisador|executor|revisor/i, /Chrome/i, /Monitor/, /skills?\b/i, /Claude Code/, /mcp__/]) expect(section, String(banned)).not.toMatch(banned);
    }
  });

  it('memória: a ficha cita a pasta <id>.memory/ como índice, e sem o sufixo .memory.md não mostra a linha da pasta', () => {
    const md = renderFicha(profile(), ctx);
    const section = md.slice(md.indexOf('## Memória'), md.indexOf('- Ponto de corte'));
    expect(section).toContain('Ela é um índice');
    expect(section).toContain('`.myco\\staff\\ana-1a2b.memory/<assunto>.md`');
    expect(section).toContain('apague o arquivo e a linha');
    expect(md).toContain('Sua memória fica em `.myco\\staff\\ana-1a2b.memory.md`');
    const semSufixo = renderFicha(profile(), { ...ctx, memoryPath: '.myco\\staff\\ana-1a2b.txt' });
    expect(semSufixo).not.toContain('Ela é um índice');
  });

  it('prompt de sistema: identidade, onde fica a memória e a ficha inteira (vai por arquivo)', () => {
    const ficha = renderFicha(profile(), ctx);
    const sys = systemPrompt(profile(), ctx, ficha);
    // Por arquivo, nada é cortado (aspas e % não passam pela linha de comando).
    expect(sys).toMatch(/^Você é Ana "Revisora" Souza, Revisora 100%/);
    expect(sys).toContain('.myco\\staff\\ana-1a2b.memory.md');
    expect(sys).toContain('releia .myco\\staff\\ana-1a2b.md');
    expect(sys).toContain(ficha.trim());
    expect(sanitizeArg('a "b"\n%c% & d')).toBe('a b c d');
  });

  it('internet desligada (Configurações): o Claude perde WebSearch e WebFetch no --disallowedTools; ligada ou sem a opção, não muda', () => {
    const base = { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null };
    const denyOf = (o: Parameters<typeof buildClaudeArgs>[1]) => {
      const args = buildClaudeArgs(profile(), o);
      return args[args.indexOf('--disallowedTools') + 1];
    };
    const secrets = secretDenyRules(profile()).join(',');
    expect(denyOf({ ...base, internetAccess: false })).toBe(`${secrets},WebSearch,WebFetch`);
    expect(denyOf({ ...base, internetAccess: true })).toBe(secrets);
    expect(denyOf(base)).toBe(secrets);
  });

  it('Codex: a ficha diz se pode pesquisar na web (internetAccess) e que o terminal não tem internet', () => {
    // Com autonomia de edição: o rótulo do terminal (sem internet) só aparece nela.
    const codex = profile({ engine: 'codex', autonomy: 'acceptEdits' });
    const on = renderFicha(codex, { ...ctx, internetAccess: true });
    expect(on).toContain('Para pesquisar na web e ler páginas, use a sua ferramenta de busca (web_search) direto; não há navegador.');
    expect(on).toContain('o terminal não tem internet');
    const off = renderFicha(codex, { ...ctx, internetAccess: false });
    expect(off).toContain('Sem acesso à internet: se precisar, avise o usuário.');
    expect(off).not.toContain('web_search');
  });

  it('argumentos: prompt primeiro; sessão nova com --session-id; MCP só quando restrito', () => {
    const args = buildClaudeArgs(profile(), { sessionId: 'uuid-1', resume: false, systemPromptFile: 'C:\\run\\system.md', mcpConfigPath: null, firstPrompt: 'Olá' });
    expect(args[0]).toBe('Olá');
    expect(args).toEqual([
      'Olá', '--session-id', 'uuid-1', '--name', 'Ana Revisora Souza - Revisora 100',
      '--append-system-prompt-file', 'C:\\run\\system.md', '--exclude-dynamic-system-prompt-sections',
      '--permission-mode', 'plan', '--model', 'opus', '--effort', 'high',
      '--add-dir', MANUAL_DIR,
      '--no-chrome', '--disallowedTools', secretDenyRules(profile()).join(','),
    ]);
    const withChrome = buildClaudeArgs(profile({ browser: true }), { sessionId: 'u', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null });
    expect(withChrome).toContain('--chrome');
    expect(withChrome).not.toContain('--no-chrome');
    expect(renderFicha(profile({ browser: true }), ctx)).toContain('## Navegador');
    expect(renderFicha(profile(), ctx)).not.toContain('## Navegador');
    // O nome dele no título das abas que usa (o grupo de abas da extensão não dá para renomear).
    const p = profile({ browser: true });
    expect(renderFicha(p, ctx)).toContain(tabTitleSnippet(p.name));
    // Reaproveita a própria aba (achada pelo nome no título) em vez de abrir uma nova a cada vez.
    expect(renderFicha(p, ctx)).toContain(`"[${p.name}]" no começo do título, trabalhe nela`);
    expect(tabTitleSnippet('Ana "Dev"')).toContain(JSON.stringify('[Ana "Dev"] '));
    const resumed = buildClaudeArgs(profile(), { sessionId: 'uuid-1', resume: true, systemPromptFile: 'S', mcpConfigPath: 'C:\\m.json', firstPrompt: 'Olá' });
    expect(resumed.slice(0, 2)).toEqual(['--resume', 'uuid-1']);
    expect(resumed.slice(-3)).toEqual(['--mcp-config', 'C:\\m.json', '--strict-mcp-config']);
  });

  it('navegador liberado sem prompt só a partir de acceptEdits', () => {
    const opts = { sessionId: 'u', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null };
    const edita = buildClaudeArgs(profile({ browser: true, autonomy: 'acceptEdits' }), opts);
    const i = edita.indexOf('--allowedTools');
    expect(i).toBeGreaterThan(-1);
    expect(edita[i + 1]).toBe('mcp__claude-in-chrome');
    expect(buildClaudeArgs(profile({ browser: true, autonomy: 'manual' }), opts)).not.toContain('--allowedTools');
    expect(buildClaudeArgs(profile({ autonomy: 'acceptEdits' }), opts)).not.toContain('--allowedTools');
  });

  it('manual de uso: a ficha manda consultar docs/uso (só leitura); a sessão lê por --add-dir e não edita pelas regras de negação', () => {
    const readme = path.join(ROOT, 'docs', 'uso', 'README.md').replace(/\\/g, '/');
    const md = renderFicha(profile(), ctx);
    const section = md.slice(md.indexOf('## Manual do Claudio’s Club'), md.indexOf('## Regras'));
    expect(section).toContain(`\`${readme}\` (só leitura)`);
    expect(section).toContain('diga que não sabe');
    // Mesma seção com servidor e com retomada: vem sempre.
    expect(renderFicha(profile({ servers: ['prod'] }), { ...ctx, servers: [{ name: 'prod', source: 'vps', protocol: 'ssh', host: 'vps-a', remoteRoot: '/x' }] })).toContain('## Manual do Claudio’s Club');

    // Sempre no --add-dir, junto das pastas que a sessão já tinha (a ficha, quando roda numa worktree).
    const away = buildClaudeArgs(profile(), { sessionId: 's', resume: true, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null, addDirs: ['C:\\www\\painel\\.myco\\staff'] });
    const i = away.indexOf('--add-dir');
    expect(away.slice(i + 1, i + 3)).toEqual(['C:\\www\\painel\\.myco\\staff', MANUAL_DIR]);
    const plain = buildClaudeArgs(profile(), { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null });
    expect(plain.slice(plain.indexOf('--add-dir') + 1, plain.indexOf('--add-dir') + 2)).toEqual([MANUAL_DIR]);

    // Edição negada (Edit, Write, NotebookEdit), sem servidor e com servidor; leitura não é negada (é o que a sessão precisa).
    for (const deny of [secretDenyRules(profile()), secretDenyRules(profile({ servers: ['prod'] }))]) {
      for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
        expect(deny).toContainEqual(expect.stringMatching(new RegExp(`^${tool}\\(.*/docs/uso/\\*\\*\\)$`)));
      }
      expect(deny.some((r) => r.startsWith('Read(') && r.includes('docs/uso'))).toBe(false);
    }
  });

  it('manual editável só quando o projeto é o próprio Claudio’s Club (sem worktree); qualquer outro projeto segue negado', () => {
    const manualDeny = (deny: string[]) => deny.filter((r) => r.includes('docs/uso'));
    // Projeto = ROOT: nenhuma regra do manual.
    expect(manualDeny(secretDenyRules(profile(), [], [], true))).toEqual([]);
    // Outro projeto, ou sem a informação (padrão): as três regras de edição.
    expect(manualDeny(secretDenyRules(profile()))).toHaveLength(3);
    expect(manualDeny(secretDenyRules(profile(), [], [], false))).toHaveLength(3);
    // Pela linha de comando: manualEditable liga/desliga o bloqueio; o resto das regras não muda.
    const base = { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null };
    const denyOf = (o: Parameters<typeof buildClaudeArgs>[1]) => {
      const args = buildClaudeArgs(profile(), o);
      return args[args.indexOf('--disallowedTools') + 1]!.split(',');
    };
    expect(manualDeny(denyOf({ ...base, manualEditable: true }))).toEqual([]);
    expect(manualDeny(denyOf(base))).toHaveLength(3);
    expect(denyOf({ ...base, manualEditable: true }).length).toBe(denyOf(base).length - 3);
    // isClaudeRoot: a própria pasta (com barra final), sim; outra pasta, não.
    expect(isClaudeRoot(ROOT)).toBe(true);
    expect(isClaudeRoot(ROOT + path.sep)).toBe(true);
    if (process.platform === 'win32') expect(isClaudeRoot(ROOT.toUpperCase())).toBe(true);
    expect(isClaudeRoot(path.join(os.tmpdir(), 'outro-projeto'))).toBe(false);
    expect(isClaudeRoot(MANUAL_DIR)).toBe(false);
  });

  it('subfuncionário não passa da autonomia do gestor', () => {
    expect(capAutonomy('auto', 'acceptEdits')).toBe('acceptEdits');
    expect(capAutonomy('plan', 'auto')).toBe('plan');
    // "Sem travas" só passa para baixo se o gestor também for sem travas.
    expect(capAutonomy('bypassPermissions', 'auto')).toBe('auto');
    expect(capAutonomy('bypassPermissions', 'bypassPermissions')).toBe('bypassPermissions');
  });

  it('slug sem acentos', () => {
    expect(slugify('João da Silva!')).toBe('joao-da-silva');
  });
});

let root: string;
let projectPath: string;
let claudeJson: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-staff-'));
  projectPath = path.join(root, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(
    path.join(projectPath, '.mcp.json'),
    JSON.stringify({ mcpServers: { db: { command: 'db-mcp', env: { DB_PASS: 'SEGREDO-PROJ' } }, docs: { type: 'http', url: 'https://x' } } }),
  );
  claudeJson = path.join(root, '.claude.json');
  await fs.writeFile(
    claudeJson,
    JSON.stringify({
      oauthAccount: { emailAddress: 'nao@vaza' },
      mcpServers: { n8n: { type: 'http', url: 'https://n8n', headers: { Authorization: 'SEGREDO-USER' } } },
      projects: { [projectPath.replaceAll('\\', '/')]: { mcpServers: { db: { command: 'db-local', env: { DB_PASS: 'SEGREDO-LOCAL' } } } } },
    }),
  );
});

afterAll(() => removeTemp(root, home));

describe('estilo de comunicação', () => {
  it('sem estilo a ficha não tem a seção; com caveman tem, como última seção, com o texto do preset', () => {
    expect(renderFicha(profile(), ctx)).not.toContain('## Estilo de comunicação');
    const md = renderFicha(profile({ personality: 'caveman' }), ctx);
    expect(md).toContain('## Estilo de comunicação');
    expect(md).toContain(PERSONALITY_PROMPTS.caveman);
    expect(md.indexOf('## Estilo de comunicação')).toBeGreaterThan(md.indexOf('## Memória'));
    expect(md.trimEnd().endsWith(personalitySection('caveman'))).toBe(true);
  });

  it('o prompt de sistema ganha uma linha na identidade só com estilo', () => {
    const semEstilo = systemPrompt(profile(), ctx, renderFicha(profile(), ctx));
    expect(semEstilo).not.toContain('Estilo de comunicação:');
    const sys = systemPrompt(profile({ personality: 'nerd' }), ctx, renderFicha(profile({ personality: 'nerd' }), ctx));
    const linhas = sys.split('\n');
    expect(linhas[0]).toMatch(/^Você é /);
    expect(linhas[1]).toBe('Estilo de comunicação: Nerd (seção no fim da ficha): use em toda resposta ao usuário.');
  });

  it('o exemplo de cada preset vai no fim do texto e o escopo usa a regra nova', () => {
    for (const p of PERSONALITIES) {
      expect(PERSONALITY_PROMPTS[p]).toMatch(/ Exemplo: ".+"$/);
      expect(personalitySection(p)).toContain('Use este estilo em toda resposta ao usuário nesta conversa');
    }
    expect(personalityName('caveman')).toBe('Caveman');
    expect(personalityName('tiozao')).toBe('Tiozão do Pavê');
    expect(personalityName(null)).toBe('');
    expect(personalitySection(undefined)).toBe('');
  });

  it('os quatro presets novos: nome e exemplo', () => {
    expect(personalityName('executivo')).toBe('Executivo');
    expect(personalityName('narrador')).toBe('Narrador de futebol');
    expect(personalityName('mineiro')).toBe('Mineiro');
    expect(personalityName('yoda')).toBe('Mestre Yoda');
    expect(PERSONALITY_PROMPTS.executivo).toContain('Exemplo: "Pedido online no ar. Risco: nenhum. Próximo: você testar o checkout."');
    expect(PERSONALITY_PROMPTS.narrador).toContain('Exemplo: "E É DO BUILD! Passou de primeira! Testes: 151 verdes."');
    expect(PERSONALITY_PROMPTS.mineiro).toContain('Exemplo: "Uai, o trem tá pronto, sô. Testes bão, tudo verde."');
    expect(PERSONALITY_PROMPTS.yoda).toContain('Exemplo: "Corrigido o bug está. Verdes, os testes ficaram."');
    for (const p of ['executivo', 'narrador', 'mineiro', 'yoda'] as const) {
      expect(PERSONALITIES).toContain(p);
      expect(PERSONALITY_PROMPTS[p]).not.toMatch(/Chrome|subagent|ferramenta Agent/);
    }
  });

  it('prompt de sistema: memória pessoal antes da ficha; o estilo, última seção da ficha, fica por último', () => {
    const p = profile({ personality: 'yoda' });
    const ficha = renderFicha(p, ctx);
    const sys = systemPrompt(p, ctx, ficha, 'Ana prefere respostas curtas.');
    expect(sys.indexOf('## Memória pessoal')).toBeGreaterThan(-1);
    expect(sys.indexOf('## Memória pessoal')).toBeLessThan(sys.indexOf(ficha.trim()));
    expect(sys.trimEnd().endsWith(personalitySection('yoda'))).toBe(true);
    // Sem memória pessoal, a seção não aparece e o estilo continua por último.
    expect(systemPrompt(p, ctx, ficha).includes('## Memória pessoal')).toBe(false);
    expect(systemPrompt(p, ctx, ficha).trimEnd().endsWith(personalitySection('yoda'))).toBe(true);
  });

  it('settings do run: com estilo (motor Claude) sai outputStyle default; sem estilo, ou no Codex, não sai', () => {
    expect(staffSettings(profile({ personality: 'mineiro' }))).toMatchObject({ outputStyle: 'default' });
    expect(staffSettings(profile())).not.toHaveProperty('outputStyle');
    expect(staffSettings()).not.toHaveProperty('outputStyle');
    expect(staffSettings(profile({ personality: 'mineiro', engine: 'codex' }))).not.toHaveProperty('outputStyle');
  });

  it('lembrete por mensagem: com estilo (motor Claude) o settings tem o hook UserPromptSubmit com o style.txt; sem estilo ou no Codex, não', () => {
    const arquivo = path.join(os.tmpdir(), 'style.txt');
    const hook = path.join(ROOT, 'scripts', 'hooks', 'style-reminder.mjs');
    expect(staffSettings(profile({ personality: 'mineiro' }), arquivo).hooks).toMatchObject({
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: process.execPath, args: [hook, arquivo], timeout: 10 }] }],
    });
    expect(staffSettings(profile(), arquivo).hooks).not.toHaveProperty('UserPromptSubmit');
    expect(staffSettings(profile({ personality: 'mineiro', engine: 'codex' }), arquivo).hooks).not.toHaveProperty('UserPromptSubmit');
    // Com estilo mas sem o caminho do arquivo, não tem como lembrar: sem o hook.
    expect(staffSettings(profile({ personality: 'mineiro' })).hooks).not.toHaveProperty('UserPromptSubmit');
    expect(personalityReminder(null)).toBe('');
    expect(personalityReminder('nerd')).toBe(
      `Estilo de comunicação: ${PERSONALITY_PROMPTS.nerd}\nEscreva a resposta ao usuário nesse estilo, sem anunciar nem nomear o estilo (nenhum rótulo antes da mensagem). Entrega ao gestor, parecer de revisão, mensagem a outro funcionário, commit, código e documentação ficam neutros.`,
    );
  });

  it('o hook do lembrete: com o style.txt responde additionalContext; sem arquivo ou vazio, não responde nada', async () => {
    const script = path.join(ROOT, 'scripts', 'hooks', 'style-reminder.mjs');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-style-'));
    try {
      const arquivo = path.join(dir, 'style.txt');
      await fs.writeFile(arquivo, 'Estilo de comunicação: Nerd');
      expect(JSON.parse(execFileSync(process.execPath, [script, arquivo]).toString())).toEqual({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Estilo de comunicação: Nerd' },
      });
      expect(execFileSync(process.execPath, [script, path.join(dir, 'nao-existe.txt')]).toString()).toBe('');
      await fs.writeFile(arquivo, '  \n');
      expect(execFileSync(process.execPath, [script, arquivo]).toString()).toBe('');
    } finally {
      await removeTemp(dir);
    }
  });

  it('no pedido: valor fora da lista vira null; nulo e ausente seguem como estão', () => {
    const base = { name: 'Bia', role: 'Dev', mission: 'Implementar' };
    expect(StaffInputSchema.parse({ ...base, personality: 'pirata' }).personality).toBeNull();
    expect(StaffInputSchema.parse({ ...base, personality: 'nerd' }).personality).toBe('nerd');
    expect(StaffInputSchema.parse({ ...base, personality: null }).personality).toBeNull();
    expect(StaffInputSchema.parse(base)).not.toHaveProperty('personality');
  });
});

describe('infra: servidores por SSH', () => {
  it('lista só as conexões completas do projeto, sem usuário nem chave (o ~/.ssh/config fica de fora)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-srv-'));
    try {
      const key = path.join(dir, 'chave');
      await fs.writeFile(key, 'x');
      await fs.mkdir(path.join(dir, 'proj', '.vps'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'proj', '.vps', 'config.json'),
        JSON.stringify({
          connections: {
            prod: { host: 'vps-a.example.com', user: 'deploy', identityFile: key, remoteRoot: '/var/www/app' },
            apelido: { host: 'VPS' },
            'mal nome': { host: 'x' },
          },
        }),
      );
      const list = await listServers(path.join(dir, 'proj'));
      expect(list).toEqual([{ name: 'prod', source: 'vps', protocol: 'ssh', host: 'vps-a.example.com', remoteRoot: '/var/www/app' }]);
      expect(JSON.stringify(list)).not.toMatch(/chave|deploy|identity/i);
    } finally {
      await removeTemp(dir);
    }
  });

  it('a ficha traz as conexões e as regras; a linha de comando bloqueia chaves e .env', () => {
    const p = profile({ servers: ['prod', 'sumiu'] });
    const md = renderFicha(p, { ...ctx, servers: [{ name: 'prod', source: 'vps', protocol: 'ssh', host: 'vps-a', remoteRoot: '/var/www/app' }] });
    // O ssh_config é o dele (só as conexões da ficha), não um com todas as do projeto.
    // Sem o MCP (o ssh do terminal está bloqueado): nada de `ssh -F` apontando para o ssh_config.
    for (const part of ['## Servidores', '- `prod`: vps-a', '/var/www/app', 'ssh, scp, sftp e rsync ficam bloqueados', 'não existe mais no projeto', 'Nunca, sem pedir antes']) {
      expect(md).toContain(part);
    }
    expect(md).not.toMatch(/ssh -F|scp -F/);
    expect(md).not.toContain('skill `vps`');
    // A skill `vps` entra na lista de skills (sem o texto fixo sobre servidor: o acesso é o do Club).
    expect(renderFicha({ ...p, skills: ['vps'] }, ctx)).toContain('Skills: vps.');
    // Sem servidor: a ficha explica o bloqueio; só nomes, nunca host nem pasta.
    const none = renderFicha(profile(), ctx);
    expect(none).toContain('## Servidores');
    expect(none).toContain('bloqueia ssh, scp, sftp e rsync');
    expect(none).toContain('ainda não tem conexão cadastrada');
    const withConns = renderFicha(profile(), { ...ctx, servers: [{ name: 'prod', source: 'vps', protocol: 'ssh', host: 'vps-a', remoteRoot: '/var/www/app' }] });
    expect(withConns).toContain('`prod`');
    expect(withConns).not.toContain('vps-a');
    expect(withConns).not.toContain('/var/www/app');
    expect(withConns).not.toContain('ainda não tem conexão');
    // Só FTP: o ssh continua bloqueado e a ficha diz isso.
    const ftpOnly = renderFicha(profile({ servers: ['site'] }), { ...ctx, servers: [{ name: 'site', source: 'ftp', protocol: 'ftps', host: 'ftp.x', remoteRoot: '/' }] });
    expect(ftpOnly).toContain('as suas conexões são só FTP');
    expect(md).not.toContain('as suas conexões são só FTP');
    // O workspace do projeto entra como contexto, sem tomar o lugar da empresa.
    expect(renderFicha(profile(), { ...ctx, workspace: 'Cliente X' })).toContain('Empresa: Acme & Cia. Workspace: Cliente X.');
    expect(renderFicha(profile(), ctx)).not.toContain('Workspace:');
    const args = buildClaudeArgs(p, { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null, keyFiles: ['C:\\chaves\\ia', 'C:/com espaço/k'] });
    const deny = args[args.indexOf('--disallowedTools') + 1]!.split(',');
    expect(deny).toEqual(expect.arrayContaining(['Read(~/.ssh/**)', 'Read(**/.env)', 'Read(**/.vps/**)', 'Read(//c/chaves/ia)']));
    expect(deny.join(',')).not.toContain('espaço');
    // Com servidor, o ssh continua bloqueado no terminal: o acesso é só pelo MCP myco-ssh.
    expect(deny).toContain('Bash(ssh:*)');
    expect(deny).toContain('PowerShell(scp:*)');
  });

  it('ssh, scp, sftp, rsync e afins bloqueados no Bash e no PowerShell, com ou sem servidor na ficha', () => {
    const deny = secretDenyRules(profile());
    expect(deny).toEqual(expect.arrayContaining(['Bash(ssh:*)', 'PowerShell(ssh:*)', 'Bash(scp:*)', 'PowerShell(scp.exe:*)', 'Bash(rsync:*)', 'Edit(**/.vps/**)']));
    expect(deny).toEqual(expect.arrayContaining(['Bash(plink:*)', 'PowerShell(psftp.exe:*)', 'Bash(sshpass:*)', 'PowerShell(mosh:*)']));
    expect(secretDenyRules(profile({ servers: ['prod'] }))).toEqual(expect.arrayContaining(['Bash(ssh:*)', 'PowerShell(ssh:*)', 'Bash(rsync.exe:*)']));
  });

  it('.env de verdade e chaves privadas: negados para todos; o .env.example só fica livre sem servidor', () => {
    const none = secretDenyRules(profile());
    const prod = secretDenyRules(profile({ servers: ['prod'] }));
    for (const deny of [none, prod]) {
      expect(deny).toEqual(expect.arrayContaining(['Read(**/.env)', 'Edit(**/.env)', 'Read(**/.env.local)', 'Read(**/.env.*.local)', 'Read(**/.env.production)', 'Read(**/*.pem)', 'Read(**/*.key)']));
    }
    expect(none).not.toContain('Read(**/.env.*)');
    expect(none.some((r) => /example|sample|template/.test(r))).toBe(false);
    expect(prod).toEqual(expect.arrayContaining(['Read(**/.env.*)', 'Edit(**/.env.*)']));
  });
});

describe('linha de parada do consumo', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const usage = (fiveHour: number, sevenDay: number, resetsAt = '2026-10-26T14:00:00Z'): AccountUsage => ({
    tapInstalled: true,
    updatedAt: '2026-10-26T11:59:00Z',
    limits: [
      { kind: 'five_hour', percentUsed: fiveHour, resetsAt },
      { kind: 'seven_day', percentUsed: sevenDay, resetsAt: '2026-10-30T00:00:00Z' },
    ],
  });
  const company = { fiveHour: 90, sevenDay: 95 };

  it('para no primeiro limite que passou da linha; null na empresa = sem trava', () => {
    expect(usageStopHit(usage(50, 50), company, now)).toBeNull();
    expect(usageStopHit(usage(90, 50), company, now)).toMatchObject({ kind: 'five_hour', limit: 90 });
    expect(usageStopHit(usage(10, 96), company, now)).toMatchObject({ kind: 'seven_day', limit: 95 });
    expect(usageStopHit(usage(100, 100), { fiveHour: null, sevenDay: null }, now)).toBeNull();
  });

  it('ignora leitura de uma janela que já renovou', () => {
    expect(usageStopHit(usage(99, 10, '2026-10-26T11:00:00Z'), company, now)).toBeNull();
  });
});

describe('MCPs', () => {
  it('lista nomes, ref e escopo sem configuração; o local (fora do git) vence o .mcp.json e aparece como Projeto', async () => {
    const list = await listMcpServers(projectPath, claudeJson);
    expect(list).toEqual([
      { name: 'db', ref: 'project:db', scope: 'project', outOfGit: true, source: 'project', transport: 'stdio' },
      { name: 'docs', ref: 'project:docs', scope: 'project', source: 'project', transport: 'http' },
      { name: 'n8n', ref: 'global:n8n', scope: 'global', source: 'user', transport: 'http' },
    ]);
    expect(JSON.stringify(list)).not.toContain('SEGREDO');
  });

  it('monta a config só com os escolhidos (por ref; ref que não existe fica de fora)', async () => {
    const cfg = await buildMcpConfig(projectPath, ['project:db', 'project:inexistente', 'global:n8n'], claudeJson);
    expect(Object.keys(cfg.mcpServers)).toEqual(['db', 'n8n']);
    expect(cfg.mcpServers.db).toMatchObject({ command: 'db-local' });
    // Nome antigo (sem escopo) ainda vale: Projeto se existe lá, senão Global.
    expect(Object.keys((await buildMcpConfig(projectPath, ['db', 'n8n'], claudeJson)).mcpServers)).toEqual(['db', 'n8n']);
  });
});

describe('StaffService', () => {
  const project = (): Project => ({
    id: 'proj-id',
    path: projectPath,
    name: 'proj',
    exists: true,
    worktreeOf: null,
    hasClaudeMd: false,
    agentCount: 0,
    skillCount: 0,
    sessionCount: 0,
    lastActivityAt: null,
  });
  const adapter = { listProjects: async () => [project()] } as unknown as ToolAdapter;
  const noUsage = async (): Promise<AccountUsage> => ({ tapInstalled: true, limits: [], updatedAt: null });
  const service = (readUsage = noUsage) =>
    new StaffService(adapter, {
      runDir: path.join(root, 'run'),
      claudeConfigFile: claudeJson,
      mycoUrl: 'http://127.0.0.1:4848',
      readUsage,
    });

  const input = { name: 'Bia', role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', mcps: ['docs'], launch: true };

  it('contrata pelo navegador com "começar a conversa": abre no Claudio’s Club', async () => {
    const chats: Array<{ staffId: string; text: string }> = [];
    const svc = new StaffService(adapter, {
      runDir: path.join(root, 'run'),
      claudeConfigFile: claudeJson,
      mycoUrl: 'x',
      readUsage: noUsage,
      openChat: async (_p, staffId, text) => (chats.push({ staffId, text }), 'conversa-1'),
    });
    const r = (await svc.hire('proj-id', { ...input, name: 'Joe', canHire: true }, true))!;
    expect(r.launch).toEqual({ ok: true, sessionId: 'conversa-1', command: '', error: null });
    expect(chats).toEqual([{ staffId: r.profile.id, text: 'Olá, Joe. Leia sua memória e diga em poucas linhas como pretende começar.' }]);
  });

  it('contrata sem começar a conversa: grava ficha e memória; a conversa nova sai com a ficha', async () => {
    const svc = service();
    const r = await svc.hire('proj-id', { ...input, launch: false }, true);
    expect(r?.launch).toBeNull();
    const p = r!.profile;
    expect(p.id).toMatch(/^bia-[0-9a-f]{4}$/);
    expect(p.browser).toBe(true); // usa o Chrome por padrão
    // O nome antigo do MCP vira ref ao contratar (o `docs` está no .mcp.json do projeto).
    expect(p.mcps).toEqual(['project:docs']);

    const dir = path.join(projectPath, '.myco', 'staff');
    const ficha = await fs.readFile(path.join(dir, `${p.id}.md`), 'utf8');
    expect(ficha).toContain('# Ficha de Bia — Dev');
    expect(await fs.readFile(path.join(dir, `${p.id}.memory.md`), 'utf8')).toContain('Memória de Bia');

    const spawn = (await svc.chatSpawn('proj-id', null, p.id))!;
    const sid = spawn.sessionId;
    expect(spawn.args).toEqual(expect.arrayContaining(['--session-id', sid, '--permission-mode', 'acceptEdits', '--strict-mcp-config']));
    // A config de MCP (com possíveis segredos) fica fora do projeto, só com o escolhido. O navegador limpo (ficha com Navegador) entra à
    // parte, se o Chrome ou o Edge estiver nesta máquina: não conta aqui (ver cleanBrowser.test.ts).
    const mcp = JSON.parse(await fs.readFile(path.join(root, 'run', sid, 'mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers).filter((k) => k !== CLEAN_BROWSER_MCP_NAME)).toEqual(['docs']);
  });

  it('retomar a conversa usa --resume na mesma sessão, sem duplicar', async () => {
    const svc = service();
    const { profile: p } = (await svc.hire('proj-id', { ...input, name: 'Caio', launch: false }, true))!;
    const first = (await svc.chatSpawn('proj-id', null, p.id))!;
    const r = (await svc.chatSpawn('proj-id', first.sessionId, p.id))!;
    expect(r.sessionId).toBe(first.sessionId);
    expect(r.args.slice(0, 2)).toEqual(['--resume', first.sessionId]);
    const list = await svc.listAll([project()]);
    expect(list.find((s) => s.id === p.id)?.sessions).toHaveLength(1);
  });

  it('Chrome só com a extensão instalada; sem como saber (ou com erro), vale a ficha; a ficha salva não muda', async () => {
    const withStatus = (extension: boolean | null | 'erro') =>
      new StaffService(adapter, {
        runDir: path.join(root, 'run'),
        claudeConfigFile: claudeJson,
        mycoUrl: 'x',
        readUsage: noUsage,
        browserStatus: async () => {
          if (extension === 'erro') throw new Error('falhou');
          return extension === null ? null : { extension, bridge: false, installUrl: 'u' };
        },
      });
    const { profile: p } = (await service().hire('proj-id', { ...input, name: 'Nav', launch: false }, true))!;
    const open = async (extension: boolean | null | 'erro') => {
      const s = (await withStatus(extension).chatSpawn('proj-id', null, p.id))!;
      return { args: s.args, prompt: await fs.readFile(path.join(root, 'run', s.sessionId, 'system.md'), 'utf8') };
    };
    for (const ok of [true, null, 'erro'] as const) {
      const r = await open(ok);
      expect(r.args).toContain('--chrome');
      expect(r.prompt).toContain('## Navegador');
    }
    const off = await open(false);
    expect(off.args).toContain('--no-chrome');
    expect(off.args).not.toContain('--chrome');
    // Sem a extensão, a parte do Chrome do usuário some; o navegador limpo não depende dela (pode entrar, conforme o Chrome instalado).
    expect(off.prompt).not.toContain('Claude in Chrome');
    expect((await readProfile(projectPath, p.id))!.browser).toBe(true);
  });

  it('pela API (sem navegador), só um gestor que pode contratar, e com a autonomia dele no máximo', async () => {
    const svc = service();
    await expect(svc.hire('proj-id', { ...input, name: 'Solto', launch: false }, false)).rejects.toBeInstanceOf(StaffError);

    const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Chefe', autonomy: 'acceptEdits', canHire: true, launch: false }, true))!;
    // Contratado sem sessão: a ficha já fica no projeto.
    expect(await fs.readFile(path.join(projectPath, '.myco', 'staff', `${boss.id}.md`), 'utf8')).toContain('Para contratar: POST');
    // Pela API chega como texto (formato antigo): vira lista.
    const r = await svc.hire('proj-id', { ...input, name: 'Sub', autonomy: 'auto', canHire: true, reportsTo: boss.id, launch: false, servers: ['prod'] }, false);
    expect(r?.profile).toMatchObject({ reportsTo: [boss.id], autonomy: 'acceptEdits', canHire: false, servers: [], hiredBy: boss.id, temporary: true });
    // Só o gestor passa tarefa (pela API) para quem reporta a ele.
    expect(await svc.isManagerOf('proj-id', boss.id, r!.profile.id)).toBe(true);
    expect(await svc.isManagerOf('proj-id', r!.profile.id, boss.id)).toBe(false);
    expect(await svc.isManagerOf('proj-id', 'ninguem', r!.profile.id)).toBe(false);
  });

  it('canRelease: padrão desligado; o navegador liga; contratado pela API nasce sem (mesmo pedindo); editar sem o campo mantém e com false desliga; ficha antiga lê como desligada', async () => {
    const svc = service();
    const staffDir = path.join(projectPath, '.myco', 'staff');
    const off = (await svc.hire('proj-id', { ...input, name: 'Sem Permissao', launch: false }, true))!.profile;
    expect(off.canRelease).toBe(false);
    const on = (await svc.hire('proj-id', { ...input, name: 'Com Permissao', canHire: true, canRelease: true, launch: false }, true))!.profile;
    expect(on.canRelease).toBe(true);
    expect(await fs.readFile(path.join(staffDir, `${on.id}.md`), 'utf8')).toContain('## Versão e deploy');
    expect(await fs.readFile(path.join(staffDir, `${off.id}.md`), 'utf8')).not.toContain('Versão e deploy');

    // Pela API (gestor com canHire): o subfuncionário nasce sem a permissão, mesmo que o pedido a traga.
    const sub = (await svc.hire('proj-id', { ...input, name: 'Subordinada', canRelease: true, reportsTo: on.id, launch: false }, false))!.profile;
    expect(sub.canRelease).toBe(false);
    expect(await fs.readFile(path.join(staffDir, `${sub.id}.md`), 'utf8')).not.toContain('Versão e deploy');

    // Editar pela tela atual (que ainda não manda o campo) não desliga a permissão; mandar false desliga, e a seção sai da ficha.
    const corpo = { name: 'Com Permissao', role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', mcps: ['docs'], canHire: true };
    await svc.update('proj-id', on.id, corpo);
    expect((await readProfile(projectPath, on.id))!.canRelease).toBe(true);
    expect(await fs.readFile(path.join(staffDir, `${on.id}.md`), 'utf8')).toContain('## Versão e deploy');
    await svc.update('proj-id', on.id, { ...corpo, canRelease: false });
    expect((await readProfile(projectPath, on.id))!.canRelease).toBe(false);
    expect(await fs.readFile(path.join(staffDir, `${on.id}.md`), 'utf8')).not.toContain('Versão e deploy');
    await svc.update('proj-id', on.id, { ...corpo, canRelease: true });
    expect((await readProfile(projectPath, on.id))!.canRelease).toBe(true);

    // Ficha gravada antes do campo existir: lê como desligada.
    const file = path.join(staffDir, `${off.id}.json`);
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    delete raw.canRelease;
    await fs.writeFile(file, JSON.stringify(raw));
    expect((await readProfile(projectPath, off.id))!.canRelease).toBe(false);
  });

  it('PATCH: sem o campo mantém o estilo; null tira, e a seção sai da ficha', async () => {
    const svc = service();
    const { profile: p } = (await svc.hire('proj-id', { ...input, name: 'Estilo', personality: 'nerd', launch: false }, true))!;
    const ficha = path.join(projectPath, '.myco', 'staff', `${p.id}.md`);
    const corpo = { name: 'Estilo', role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', mcps: ['docs'] };
    await svc.update('proj-id', p.id, corpo);
    expect((await readProfile(projectPath, p.id))!.personality).toBe('nerd');
    expect(await fs.readFile(ficha, 'utf8')).toContain('## Estilo de comunicação');
    await svc.update('proj-id', p.id, { ...corpo, personality: null });
    expect((await readProfile(projectPath, p.id))!.personality).toBeNull();
    expect(await fs.readFile(ficha, 'utf8')).not.toContain('## Estilo de comunicação');
  });

  describe('contratar pela API com cargo pronto (roleId)', () => {
    const dev = BUILTIN_ROLES.find((r) => r.id === 'desenvolvedor')!;
    const apiHire = (svc: StaffService, boss: string, extra: Record<string, unknown>) =>
      svc.hire('proj-id', { name: 'Cargo', firstTask: 'Corrigir o login', reportsTo: [boss], launch: false, ...extra }, false);

    it('o cargo preenche cargo, missão, regras, pronto, modelo, esforço e autonomia; temporário e sem poder contratar', async () => {
      const svc = service();
      const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Gestor Cargo', autonomy: 'acceptEdits', canHire: true, launch: false }, true))!;
      // A ficha do gestor (que pode contratar) grava a lista de cargos prontos.
      const bossFicha = await fs.readFile(path.join(projectPath, '.myco', 'staff', `${boss.id}.md`), 'utf8');
      expect(bossFicha).toContain('Cargos prontos (roleId): `');
      expect(bossFicha).toContain(`\`${dev.id}\` (${dev.label})`);
      const r = (await apiHire(svc, boss.id, { roleId: dev.id, canHire: true }))!;
      expect(r.profile).toMatchObject({
        name: 'Cargo',
        firstTask: 'Corrigir o login',
        role: dev.role,
        mission: dev.mission,
        rules: dev.rules,
        doneWhen: dev.doneWhen,
        model: dev.model,
        effort: dev.effort,
        autonomy: dev.autonomy,
        canHire: false,
        hiredBy: boss.id,
        temporary: true,
      });
      // O id do cargo não vai para o perfil.
      expect(r.profile).not.toHaveProperty('roleId');
      expect(await readProfile(projectPath, r.profile.id)).not.toHaveProperty('roleId');
    });

    it('cargo que implementa já contrata com o roteiro e os 4 agents na ficha; o que só audita, sem roteiro', async () => {
      const svc = service();
      const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Gestor Roteiro', autonomy: 'acceptEdits', canHire: true, launch: false }, true))!;
      const r = (await apiHire(svc, boss.id, { name: 'Pensa', roleId: dev.id }))!;
      expect(r.profile.playbook).toBe('plan-big-execute-small');
      const ficha = await fs.readFile(path.join(projectPath, '.myco', 'staff', `${r.profile.id}.md`), 'utf8');
      expect(ficha).toContain('Agents: pesquisador, executor, executor-rapido, revisor.');
      expect(ficha).toContain('## Roteiro: Planeja grande, executa pequeno');
      expect(ficha).toContain('mudança local, conhecida e de baixo risco');
      // Quem só audita não implementa: sem roteiro, sem agents de execução.
      const sec = (await apiHire(svc, boss.id, { name: 'Audita', roleId: 'seguranca' }))!;
      expect(sec.profile.playbook).toBeNull();
      expect(await fs.readFile(path.join(projectPath, '.myco', 'staff', `${sec.profile.id}.md`), 'utf8')).not.toContain('## Roteiro');
    });

    it('o que vier no pedido ganha do cargo (a missão escrita substitui a do cargo)', async () => {
      const svc = service();
      const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Gestor Missao', autonomy: 'acceptEdits', canHire: true, launch: false }, true))!;
      const r = (await apiHire(svc, boss.id, { name: 'Missao', roleId: dev.id, mission: 'Só o login' }))!;
      expect(r.profile).toMatchObject({ mission: 'Só o login', role: dev.role, rules: dev.rules });
    });

    it('cargo que não existe: erro, sem contratar', async () => {
      const svc = service();
      const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Gestor Sem', autonomy: 'acceptEdits', canHire: true, launch: false }, true))!;
      await expect(apiHire(svc, boss.id, { name: 'Fantasma', roleId: 'nao-existe' })).rejects.toThrow('cargo não encontrado: nao-existe');
    });

    it('a autonomia do cargo também é limitada à do gestor', async () => {
      const svc = service();
      // O cargo é acceptEdits; o gestor só plan: o temporário fica em plan.
      const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Gestor Plan', autonomy: 'plan', canHire: true, launch: false }, true))!;
      expect(dev.autonomy).toBe('acceptEdits');
      const r = (await apiHire(svc, boss.id, { name: 'Limitado', roleId: dev.id }))!;
      expect(r.profile.autonomy).toBe('plan');
    });

    it('MCP: sem a chave mcps no pedido, o contratado nasce sem nenhum (não todos)', async () => {
      const svc = service();
      const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Gestor Mcp Todos', autonomy: 'acceptEdits', canHire: true, mcps: null, launch: false }, true))!;
      const r = (await apiHire(svc, boss.id, { roleId: dev.id }))!;
      expect(r.profile.mcps).toEqual([]);
    });

    it('MCP: o contratado pela API só ganha MCP que o gestor tem', async () => {
      const svc = service();
      const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Gestor Mcp A', autonomy: 'acceptEdits', canHire: true, mcps: ['a'], launch: false }, true))!;
      const r = (await apiHire(svc, boss.id, { roleId: dev.id, mcps: ['a', 'b'] }))!;
      // Nome antigo vira ref (nenhum dos dois existe no projeto: Global), e o filtro do gestor vale sobre as refs.
      expect(boss.mcps).toEqual(['global:a']);
      expect(r.profile.mcps).toEqual(['global:a']);
    });

    it('MCP: marcar o mesmo nome na Global e no Projeto recusa (a conversa sobe um servidor por nome)', async () => {
      const svc = service();
      await expect(svc.hire('proj-id', { ...input, name: 'Dup Mcp', mcps: ['global:db', 'project:db'], launch: false }, true)).rejects.toThrow('marcado na Global e no Projeto');
    });

    it('MCP: gestor com MCP e pedido sem a chave mcps: contratado sem nenhum', async () => {
      const svc = service();
      const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Gestor Mcp Sem', autonomy: 'acceptEdits', canHire: true, mcps: ['a'], launch: false }, true))!;
      const r = (await apiHire(svc, boss.id, { roleId: dev.id }))!;
      expect(r.profile.mcps).toEqual([]);
    });

    it('skills do cargo (nome sem escopo) entram como Global; o pedido com `skills` ganha; salvar o cargo não mexe nas fichas', async () => {
      const role = await saveRole({ label: 'Cargo com skill', role: 'Deploy', mission: 'Publicar a versão', autonomy: 'manual', skills: ['deploy'] });
      const id = role.find((r) => r.label === 'Cargo com skill')!.id;
      const svc = service();
      const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Gestor Skill Cargo', autonomy: 'acceptEdits', canHire: true, launch: false }, true))!;
      const r = (await apiHire(svc, boss.id, { roleId: id }))!;
      expect(r.profile.skills).toEqual(['global:deploy']);
      const outro = (await apiHire(svc, boss.id, { roleId: id, skills: ['project:x'] }))!;
      expect(outro.profile.skills).toEqual(['project:x']);

      // Mudar o cargo depois não mexe na ficha que já foi contratada.
      await saveRole({ id, label: 'Cargo com skill', role: 'Deploy', mission: 'Publicar a versão', autonomy: 'manual', skills: ['outra'] });
      expect((await readProfile(projectPath, r.profile.id))!.skills).toEqual(['global:deploy']);
    });

    it('cargo com skill de nome inválido recusa ao salvar; no arquivo, a skill inválida sai sem derrubar o cargo', async () => {
      await expect(saveRole({ label: 'Ruim', role: 'x', mission: 'x', autonomy: 'manual', skills: ['Com Espaço'] })).rejects.toThrow('skill do cargo');
      const file = path.join(process.env.MYCO_HOME!, 'roles.json');
      await fs.writeFile(file, JSON.stringify({ items: [{ id: 'com-lixo', label: 'Com lixo', role: 'x', mission: 'x', autonomy: 'manual', skills: ['bom', '../ruim'] }] }));
      const cargos = await listRoles(file);
      expect(cargos.find((c) => c.id === 'com-lixo')!.skills).toEqual(['bom']);
    });
  });

  it('copiar de outro projeto: "todos" (null) da origem vira nenhum neste projeto', async () => {
    const origin = await fs.mkdtemp(path.join(root, 'orig-'));
    const other = { ...project(), id: 'orig', path: origin, name: 'Origem' };
    const svc = new StaffService({ listProjects: async () => [project(), other] } as unknown as ToolAdapter, {
      runDir: path.join(root, 'run'),
      claudeConfigFile: claudeJson,
      mycoUrl: 'x',
      readUsage: noUsage,
    });
    const { profile: all } = (await svc.hire('orig', { ...input, name: 'Todos MCP', mcps: null, launch: false }, true))!;
    const copy = (await svc.copyFrom('proj-id', { fromProjectId: 'orig', staffId: all.id }, true))!;
    expect(copy.profile.mcps).toEqual([]);
  });

  it('temporário: abre numa conversa do Claudio’s Club, o gestor encerra, você efetiva; parado há dias sai sozinho', async () => {
    const archived = new Set<string>();
    const chats: Array<{ staffId: string; text: string }> = [];
    const working = new Set<string>();
    const sessions: Array<{ id: string; updatedAt: string }> = [];
    const adapterTemp = { listProjects: async () => [project()], getProjectSessions: async () => sessions } as unknown as ToolAdapter;
    const svc = new StaffService(adapterTemp, {
      runDir: path.join(root, 'run'),
      claudeConfigFile: claudeJson,
      mycoUrl: 'x',
      readUsage: noUsage,
      openChat: async (_p, staffId, text) => (chats.push({ staffId, text }), 'conversa-1'),
      isWorking: (_p, id) => working.has(id),
      archive: { has: async (k) => archived.has(k), set: async (k, v) => void (v ? archived.add(k) : archived.delete(k)) },
    });
    const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Gestora', canHire: true, launch: false }, true))!;
    const r = (await svc.hire('proj-id', { ...input, name: 'Temp', firstTask: 'Mapear as rotas', reportsTo: [boss.id], launch: true }, false))!;
    expect(r.launch).toEqual({ ok: true, sessionId: 'conversa-1', command: '', error: null });
    expect(chats).toEqual([{ staffId: r.profile.id, text: 'Olá, Temp. Leia sua memória e comece pela primeira tarefa da ficha.' }]);

    // Você não é encerrado por outro; o temporário é.
    await expect(svc.end('proj-id', boss.id, 'x')).rejects.toThrow(/não é temporário/);
    // Pela API (requestedBy), só quem contratou encerra: outro funcionário, não.
    const { profile: other } = (await svc.hire('proj-id', { ...input, name: 'Outra', canHire: true, launch: false }, true))!;
    await expect(svc.end('proj-id', r.profile.id, 'x', other.id)).rejects.toThrow(/só quem contratou/);
    await expect(svc.end('proj-id', r.profile.id, 'x', r.profile.id)).rejects.toThrow(/só quem contratou/);
    expect(archived.has(`staff:${r.profile.id}`)).toBe(false);
    expect((await svc.end('proj-id', r.profile.id, 'pelo gestor', boss.id))?.ended).toMatchObject({ reason: 'pelo gestor' });
    archived.delete(`staff:${r.profile.id}`);
    const ended = (await svc.end('proj-id', r.profile.id, 'entregou o mapa'))!;
    expect(ended.ended).toMatchObject({ reason: 'entregou o mapa' });
    expect(archived.has(`staff:${r.profile.id}`)).toBe(true);
    // Efetivar: volta ao quadro e deixa de ser temporário.
    expect(await svc.keep('proj-id', r.profile.id)).toMatchObject({ temporary: false, ended: null });
    expect(archived.has(`staff:${r.profile.id}`)).toBe(false);

    // Parado há dias: sai sozinho; trabalhando ou com conversa recente, fica.
    const { profile: idle } = (await svc.hire('proj-id', { ...input, name: 'Parado', reportsTo: [boss.id], launch: false }, false))!;
    const in4days = new Date(Date.now() + 4 * 86_400_000);
    // (O projeto dos testes tem outros temporários: olha só para este.)
    const sweep = async (when: Date) => (await svc.sweepTemporaries(when)).filter((s) => s.id === idle.id).map((s) => s.ended?.reason);
    working.add(idle.id);
    expect(await sweep(in4days)).toEqual([]);
    working.delete(idle.id);
    expect(await sweep(new Date(Date.now() + 86_400_000))).toEqual([]);
    expect(await sweep(in4days)).toEqual(['parado há 4 dias']);
    // Restaurado: os dias recomeçam a contar.
    archived.delete(`staff:${idle.id}`);
    await svc.restored(idle.id);
    expect(await sweep(new Date(Date.now() + 2 * 86_400_000))).toEqual([]);
  });

  it('edita a ficha guardando a versão anterior, restaura, e não aceita ciclo de gestores', async () => {
    const svc = service();
    const { profile: a } = (await svc.hire('proj-id', { ...input, name: 'Ana', launch: false }, true))!;
    const { profile: b } = (await svc.hire('proj-id', { ...input, name: 'Beto', reportsTo: [a.id], launch: false }, true))!;
    const { id: _i, projectId: _p, portrait: _pt, sessions: _s, createdAt: _c, updatedAt: _u, ...fields } = a;

    const edited = await svc.update('proj-id', a.id, { ...fields, role: 'Tech lead', mission: 'Liderar' });
    expect(edited).toMatchObject({ role: 'Tech lead', mission: 'Liderar', createdAt: a.createdAt });
    expect(await fs.readFile(path.join(projectPath, '.myco', 'staff', `${a.id}.md`), 'utf8')).toContain('Liderar');

    const versions = (await svc.versions('proj-id', a.id))!;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ role: 'Dev' });
    const restored = await svc.restore('proj-id', a.id, versions[0]!.version);
    expect(restored).toMatchObject({ role: 'Dev', mission: 'Implementar' });

    // Ana chefiar a si mesma, ou passar a reportar a um subordinado dela: recusado.
    await expect(svc.update('proj-id', a.id, { ...fields, reportsTo: [a.id] })).rejects.toThrow('si mesmo');
    await expect(svc.update('proj-id', a.id, { ...fields, reportsTo: [b.id] })).rejects.toThrow('ciclo');
  });

  it('dá ficha a um funcionário criado fora do Claudio’s Club, sem abrir outra sessão', async () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    const adapterWithSession = {
      listProjects: async () => [project()],
      getProjectSessions: async () => [{ id: sid, title: 'Sessão solta', startedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' }],
    } as unknown as ToolAdapter;
    const chats: string[] = [];
    const svc = new StaffService(adapterWithSession, {
      runDir: path.join(root, 'run'),
      claudeConfigFile: claudeJson,
      mycoUrl: 'x',
      openChat: async (_p, staffId) => (chats.push(staffId), 'conversa-1'),
    });

    const r = await svc.hire('proj-id', { name: 'Gil', role: 'Dev', mission: 'Continuar', adoptSessionId: sid, launch: true }, true);
    expect(r?.launch).toBeNull();
    expect(chats).toEqual([]); // não abriu outra conversa
    expect(r?.profile.sessions).toEqual([{ id: sid, startedAt: '2026-10-01T00:00:00.000Z' }]);

    await expect(svc.hire('proj-id', { name: 'Outro', role: 'Dev', mission: 'x', adoptSessionId: sid }, true)).rejects.toThrow('já é de Gil');
    await expect(
      svc.hire('proj-id', { name: 'X', role: 'Dev', mission: 'x', adoptSessionId: '99999999-2222-4333-8444-555555555555' }, true),
    ).rejects.toThrow('sessão não encontrada');
  });

  it('acrescenta um segundo gestor (arrastar o + até outro funcionário)', async () => {
    const svc = service();
    const { profile: a } = (await svc.hire('proj-id', { ...input, name: 'Duda', launch: false }, true))!;
    const { profile: c } = (await svc.hire('proj-id', { ...input, name: 'Eva', launch: false }, true))!;
    const { profile: x } = (await svc.hire('proj-id', { ...input, name: 'Fred', reportsTo: [a.id], launch: false }, true))!;
    const linked = await svc.addManager('proj-id', x.id, c.id);
    expect(linked?.reportsTo).toEqual([a.id, c.id]);
    expect((await svc.addManager('proj-id', x.id, c.id))?.reportsTo).toEqual([a.id, c.id]);
  });

  it('desfaz o vínculo com um gestor (botão na linha do quadro), com volta pelo histórico', async () => {
    const svc = service();
    const { profile: a } = (await svc.hire('proj-id', { ...input, name: 'Gui', launch: false }, true))!;
    const { profile: c } = (await svc.hire('proj-id', { ...input, name: 'Hana', launch: false }, true))!;
    const { profile: x } = (await svc.hire('proj-id', { ...input, name: 'Ivo', reportsTo: [a.id, c.id], launch: false }, true))!;
    expect((await svc.removeManager('proj-id', x.id, a.id))?.reportsTo).toEqual([c.id]);
    // Sem vínculo, nada muda; sem gestores, passa a reportar a você.
    expect((await svc.removeManager('proj-id', x.id, a.id))?.reportsTo).toEqual([c.id]);
    expect((await svc.removeManager('proj-id', x.id, c.id))?.reportsTo).toEqual([]);
    expect((await svc.versions('proj-id', x.id))?.length).toBe(2);
  });

  it('trava de consumo: recusa contratar começando a conversa e conversar acima da linha da empresa', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const high = async (): Promise<AccountUsage> => ({
      tapInstalled: true,
      updatedAt: future,
      limits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: future }],
    });
    const svc = service(high);
    await expect(svc.hire('proj-id', { ...input, name: 'Gui' }, true)).rejects.toBeInstanceOf(UsageStopError);
    // Contratar sem começar a conversa não gasta: passa. Conversar, não.
    expect((await svc.hire('proj-id', { ...input, name: 'Hel', launch: false }, true))?.profile.name).toBe('Hel');
    await expect(svc.checkUsage('proj-id')).rejects.toThrow('linha de parada: 90%');
  });

  it('worktree própria: sessão nova roda nela, lê a ficha por --add-dir e retoma na mesma pasta', async () => {
    const created: string[] = [];
    const svc = new StaffService(adapter, {
      runDir: path.join(root, 'run'),
      claudeConfigFile: claudeJson,
      mycoUrl: 'x',
      readUsage: noUsage,
      ensureWorktree: async (projectPath, staffId) => {
        created.push(staffId);
        return worktreeFor(projectPath, staffId);
      },
    });
    const { profile: hired } = (await svc.hire('proj-id', { ...input, name: 'Wal', worktree: true, playbook: 'review-gate', launch: false }, true))!;
    const first = (await svc.chatSpawn('proj-id', null, hired.id))!;
    const wt = worktreeFor(projectPath, hired.id);
    expect(created).toEqual([hired.id]);
    expect(first.cwd).toBe(wt.path);
    expect(first.args).toEqual(expect.arrayContaining(['--add-dir', path.join(projectPath, '.myco', 'staff')]));
    const ficha = await fs.readFile(path.join(projectPath, '.myco', 'staff', `${hired.id}.md`), 'utf8');
    expect(ficha).toContain('## Worktree própria');
    expect(ficha).toContain(`myco/${hired.id}`);
    expect(ficha).toContain('## Roteiro: Portão de revisão');

    const spawn = await svc.chatSpawn('proj-id', first.sessionId, hired.id);
    expect(spawn?.cwd).toBe(wt.path);
  });

  it('worktree: recusa projeto sem git, cria uma vez e reaproveita', async () => {
    const plain = path.join(root, 'sem-git');
    await fs.mkdir(plain, { recursive: true });
    await expect(ensureWorktree(plain, 'x-1')).rejects.toThrow('não é um repositório git');

    const repo = path.join(root, 'com-git');
    await fs.mkdir(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '-q');
    await fs.writeFile(path.join(repo, 'a.txt'), 'a');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
    const wt = await ensureWorktree(repo, 'ana-1');
    expect(await fs.readFile(path.join(wt.path, 'a.txt'), 'utf8')).toBe('a');
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).not.toBe('myco/ana-1');
    expect((await ensureWorktree(repo, 'ana-1')).path).toBe(wt.path);
    // git de verdade: no Windows, com a máquina ocupada, passa fácil dos 5 s padrão.
  }, 30_000);

  it('valida a ficha e o retrato', async () => {
    await expect(service().hire('proj-id', { name: '', role: 'x', mission: 'y' }, true)).rejects.toThrow('informe o nome');
    await expect(service().hire('proj-id', { ...input, portraitDataUrl: 'data:text/html;base64,AAAA' }, true)).rejects.toThrow('retrato inválido');
    expect(await service().hire('outro', input, true)).toBeNull();
  });

  describe('modelo e esforço por conversa', () => {
    const argOf = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
    const hireStaff = async (svc: StaffService, name: string, extra: Record<string, unknown> = {}) =>
      (await svc.hire('proj-id', { ...input, name, launch: false, ...extra }, true))!.profile;
    const disk = async (id: string) => (await readProfile(projectPath, id))!;

    it('conversa nova usa o modelo e o esforço da ficha, mesmo havendo um "último" escolhido no chat', async () => {
      const svc = service();
      const p = await hireStaff(svc, 'Ficha', { model: 'sonnet', effort: 'low' });
      await svc.rememberChoice('proj-id', p.id, null, { model: 'haiku', effort: 'max' });
      const spawn = (await svc.chatSpawn('proj-id', null, p.id))!;
      expect(argOf(spawn.args, '--model')).toBe('sonnet');
      expect(argOf(spawn.args, '--effort')).toBe('low');
    });

    it('ficha sem modelo: conversa nova herda o último escolhido no chat; sem nenhum, nada na linha de comando', async () => {
      const svc = service();
      const p = await hireStaff(svc, 'Ultimo');
      const none = (await svc.chatSpawn('proj-id', null, p.id))!;
      expect(none.args).not.toContain('--model');
      expect(none.args).not.toContain('--effort');

      await svc.rememberChoice('proj-id', p.id, none.sessionId, { model: 'haiku', effort: 'max' });
      const next = (await svc.chatSpawn('proj-id', null, p.id))!;
      expect(argOf(next.args, '--model')).toBe('haiku');
      expect(argOf(next.args, '--effort')).toBe('max');
      // O resolvido não é gravado na conversa nova: só escolha explícita do chat.
      const saved = (await disk(p.id)).sessions.find((x) => x.id === next.sessionId)!;
      expect(saved.model).toBeUndefined();
      expect(saved.effort).toBeUndefined();
    });

    it('reabrir usa a escolha gravada na conversa, mesmo com a ficha tendo outro; duplicar parte da escolha da origem', async () => {
      const svc = service();
      const p = await hireStaff(svc, 'Reabre', { model: 'sonnet', effort: 'low' });
      const a = (await svc.chatSpawn('proj-id', null, p.id))!;
      const b = (await svc.chatSpawn('proj-id', null, p.id))!;
      await svc.rememberChoice('proj-id', p.id, a.sessionId, { model: 'opus', effort: 'high' });

      const reopenA = (await svc.chatSpawn('proj-id', a.sessionId, p.id))!;
      expect(argOf(reopenA.args, '--model')).toBe('opus');
      expect(argOf(reopenA.args, '--effort')).toBe('high');
      // A outra conversa não escolheu nada: segue a ficha.
      const reopenB = (await svc.chatSpawn('proj-id', b.sessionId, p.id))!;
      expect(argOf(reopenB.args, '--model')).toBe('sonnet');
      expect(argOf(reopenB.args, '--effort')).toBe('low');
      // Duplicar a A: a cópia sai com a escolha da A; duplicar a B, com a ficha.
      const copyA = (await svc.chatSpawn('proj-id', null, p.id, a.sessionId))!;
      expect(copyA.args).toEqual(expect.arrayContaining(['--resume', a.sessionId, '--fork-session']));
      expect(argOf(copyA.args, '--model')).toBe('opus');
      expect(argOf(copyA.args, '--effort')).toBe('high');
      expect(argOf((await svc.chatSpawn('proj-id', null, p.id, b.sessionId))!.args, '--model')).toBe('sonnet');
    });

    it('duplicar grava a escolha herdada na cópia: ao reabrir depois, ela sai igual, mesmo com a ficha e a origem mudando', async () => {
      const svc = service();
      const p = await hireStaff(svc, 'Copia', { model: 'sonnet', effort: 'low' });
      const a = (await svc.chatSpawn('proj-id', null, p.id))!;
      const plain = (await svc.chatSpawn('proj-id', null, p.id))!;
      await svc.rememberChoice('proj-id', p.id, a.sessionId, { model: 'opus', effort: 'high' });

      const copy = (await svc.chatSpawn('proj-id', null, p.id, a.sessionId))!;
      expect((await disk(p.id)).sessions.find((x) => x.id === copy.sessionId)).toMatchObject({ model: 'opus', effort: 'high' });
      // A cópia de uma conversa sem escolha não ganha nada (segue a ficha).
      const copyPlain = (await svc.chatSpawn('proj-id', null, p.id, plain.sessionId))!;
      const plainEntry = (await disk(p.id)).sessions.find((x) => x.id === copyPlain.sessionId)!;
      expect(plainEntry.model).toBeUndefined();
      expect(plainEntry.effort).toBeUndefined();

      // Depois a origem troca de novo e a ficha muda: a cópia reabre com o que herdou.
      await svc.rememberChoice('proj-id', p.id, a.sessionId, { model: 'haiku', effort: 'max' });
      await svc.update('proj-id', p.id, { name: 'Copia', role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', model: 'sonnet', effort: 'medium' });
      const reopen = (await svc.chatSpawn('proj-id', copy.sessionId, p.id))!;
      expect(argOf(reopen.args, '--model')).toBe('opus');
      expect(argOf(reopen.args, '--effort')).toBe('high');
    });

    it('chatSpawn sinaliza `chosen` só quando modelo/esforço vieram da conversa (ou da origem); ficha e "último" não contam', async () => {
      const svc = service();
      const p = await hireStaff(svc, 'Sinal', { model: 'sonnet' });
      const a = (await svc.chatSpawn('proj-id', null, p.id))!;
      expect(a.chosen).toBeUndefined(); // da ficha
      await svc.rememberChoice('proj-id', p.id, a.sessionId, { effort: 'max' }); // grava também o "último"
      expect((await svc.chatSpawn('proj-id', null, p.id))!.chosen).toBeUndefined(); // conversa nova herdando o último
      const b = (await svc.chatSpawn('proj-id', null, p.id))!;
      expect((await svc.chatSpawn('proj-id', b.sessionId, p.id))!.chosen).toBeUndefined(); // reabrir sem escolha própria

      expect((await svc.chatSpawn('proj-id', a.sessionId, p.id))!.chosen).toBe(true); // reabrir com escolha
      expect((await svc.chatSpawn('proj-id', null, p.id, a.sessionId))!.chosen).toBe(true); // duplicar com escolha
      expect((await svc.chatSpawn('proj-id', null, p.id, b.sessionId))!.chosen).toBeUndefined(); // duplicar sem escolha
    });

    it('trocas simultâneas da mesma ficha não se perdem: modelo e esforço juntos, e conversa nova no meio', async () => {
      const svc = service();
      const p = await hireStaff(svc, 'Corrida');
      const a = (await svc.chatSpawn('proj-id', null, p.id))!;
      const [, , nova] = await Promise.all([
        saveChatChoice(projectPath, p.id, a.sessionId, { model: 'opus' }),
        saveChatChoice(projectPath, p.id, a.sessionId, { effort: 'high' }),
        svc.chatSpawn('proj-id', null, p.id),
        saveChatChoice(projectPath, p.id, a.sessionId, { model: 'haiku' }),
      ]);
      const saved = await disk(p.id);
      expect(saved.sessions.find((x) => x.id === a.sessionId)).toMatchObject({ model: 'haiku', effort: 'high' });
      expect(saved).toMatchObject({ lastModel: 'haiku', lastEffort: 'high' });
      expect(saved.sessions.some((x) => x.id === nova!.sessionId)).toBe(true);
    });

    it('writeAtomic: gravações ao mesmo tempo no mesmo arquivo não se atropelam', async () => {
      const file = path.join(root, 'atomic', 'f.json');
      await Promise.all(Array.from({ length: 20 }, (_, i) => writeAtomic(file, `${i}\n`)));
      expect(await fs.readFile(file, 'utf8')).toMatch(/^\d+\n$/);
      expect((await fs.readdir(path.dirname(file))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    });

    it('writeAtomic: rename que falha sempre (EPERM) esgota as tentativas em StateBusyError (causa = o erro original) e não deixa .tmp', async () => {
      const file = path.join(root, 'atomic-fail', 'f.json');
      const eperm = Object.assign(new Error('EPERM simulado'), { code: 'EPERM' });
      const spy = vi.spyOn(fs, 'rename').mockRejectedValue(eperm);
      // As esperas (alguns segundos no total) correm na hora: o que se testa é o desfecho, não o relógio (ver stateBusy.test.ts).
      const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
        queueMicrotask(fn);
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof setTimeout);
      try {
        const err = await writeAtomic(file, 'x\n').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StateBusyError);
        expect((err as StateBusyError).cause).toBe(eperm);
        expect(spy.mock.calls.length).toBeGreaterThan(1); // tentou de novo
      } finally {
        timer.mockRestore();
        spy.mockRestore();
      }
      expect((await fs.readdir(path.dirname(file))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
      // a falha não trava a fila: a próxima gravação funciona
      await writeAtomic(file, 'ok\n');
      expect(await fs.readFile(file, 'utf8')).toBe('ok\n');
    });

    it('writeAtomic: erro que não é de arquivo ocupado (ENOENT) sobe na hora, sem repetir', async () => {
      const file = path.join(root, 'atomic-enoent', 'f.json');
      const enoent = Object.assign(new Error('ENOENT simulado'), { code: 'ENOENT' });
      const spy = vi.spyOn(fs, 'rename').mockRejectedValue(enoent);
      try {
        await expect(writeAtomic(file, 'x\n')).rejects.toBe(enoent);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      expect((await fs.readdir(path.dirname(file))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    });

    it('rememberChoice grava na conversa e no "último", só o JSON: sem reescrever a ficha .md nem avisar; valor inválido é ignorado', async () => {
      const changes: string[] = [];
      const svc = new StaffService(adapter, {
        runDir: path.join(root, 'run'),
        claudeConfigFile: claudeJson,
        mycoUrl: 'x',
        readUsage: noUsage,
        onChange: (_prev, next) => void changes.push(next.id),
      });
      const p = await hireStaff(svc, 'Grava');
      const a = (await svc.chatSpawn('proj-id', null, p.id))!;
      const b = (await svc.chatSpawn('proj-id', null, p.id))!;
      const mdFile = path.join(projectPath, '.myco', 'staff', `${p.id}.md`);
      const md = await fs.readFile(mdFile, 'utf8');
      const mdTime = (await fs.stat(mdFile)).mtimeMs;
      const updatedAt = (await disk(p.id)).updatedAt;

      await svc.rememberChoice('proj-id', p.id, a.sessionId, { model: 'opus' });
      await svc.rememberChoice('proj-id', p.id, a.sessionId, { effort: 'xhigh' });
      await svc.rememberChoice('proj-id', p.id, b.sessionId, { model: 'haiku; rm -rf', effort: 'enorme' });
      let saved = await disk(p.id);
      expect(saved).toMatchObject({ lastModel: 'opus', lastEffort: 'xhigh' });
      expect(saved.sessions.find((x) => x.id === a.sessionId)).toMatchObject({ model: 'opus', effort: 'xhigh' });
      expect(saved.sessions.find((x) => x.id === b.sessionId)!.model).toBeUndefined();
      expect(saved.updatedAt).toBe(updatedAt);

      // Nada de ficha atualizada: nem o .md foi reescrito, nem o aviso às conversas saiu.
      expect(await fs.readFile(mdFile, 'utf8')).toBe(md);
      expect((await fs.stat(mdFile)).mtimeMs).toBe(mdTime);
      expect(changes).toEqual([]);

      // Valor ruim que já estava no disco também é ignorado ao ler.
      const jsonFile = path.join(projectPath, '.myco', 'staff', `${p.id}.json`);
      const raw = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
      raw.lastModel = 'x; y';
      raw.sessions[0].effort = 'enorme';
      await fs.writeFile(jsonFile, JSON.stringify(raw));
      saved = await disk(p.id);
      expect(saved.lastModel).toBeUndefined();
      expect(saved.sessions[0]!.effort).toBeUndefined();
    });

    it('salvar a ficha pelo formulário (e restaurar uma versão) mantém o último modelo e o das conversas', async () => {
      const svc = service();
      const p = await hireStaff(svc, 'Forma', { model: 'sonnet' });
      const a = (await svc.chatSpawn('proj-id', null, p.id))!;
      await svc.rememberChoice('proj-id', p.id, a.sessionId, { model: 'opus', effort: 'high' });

      // O corpo do formulário não traz lastModel nem sessões, e ainda esvazia o modelo da ficha.
      const form = { name: 'Forma', role: 'Dev', mission: 'Outra missão', autonomy: 'acceptEdits', model: null, effort: null };
      await svc.update('proj-id', p.id, form);
      let saved = await disk(p.id);
      expect(saved).toMatchObject({ mission: 'Outra missão', model: null, lastModel: 'opus', lastEffort: 'high' });
      expect(saved.sessions.find((x) => x.id === a.sessionId)).toMatchObject({ model: 'opus', effort: 'high' });
      // Sem modelo na ficha, a conversa nova herda o último do chat.
      expect(argOf((await svc.chatSpawn('proj-id', null, p.id))!.args, '--model')).toBe('opus');

      // Voltar a uma versão antiga traz os campos da ficha, mas o "último" e as conversas são do presente.
      const [old] = (await svc.versions('proj-id', p.id))!;
      await svc.restore('proj-id', p.id, old!.version);
      saved = await disk(p.id);
      expect(saved).toMatchObject({ model: 'sonnet', lastModel: 'opus', lastEffort: 'high' });
      expect(saved.sessions.find((x) => x.id === a.sessionId)).toMatchObject({ model: 'opus', effort: 'high' });

      // Mudar o gestor (addManager/removeManager passam pelo mesmo update) também mantém.
      const boss = await hireStaff(svc, 'Chefona');
      await svc.addManager('proj-id', p.id, boss.id);
      expect(await disk(p.id)).toMatchObject({ reportsTo: [boss.id], lastModel: 'opus', lastEffort: 'high' });
    });
  });
});
