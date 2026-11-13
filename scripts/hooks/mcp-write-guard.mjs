// Hook do Claude Code que o Claudio’s Club põe em toda conversa de funcionário com política de escrita por MCP (campo
// `mcpWrite` da ficha; ver server/staff/mcpTools.ts). PreToolUse com matcher `mcp__.*` (server/staff/launch.ts). Autocontido:
// a cópia dele fica na pasta da conversa (prepareRun), para o agente não editar o hook que o guarda.
//
// Lê a política da conversa (caminho no argumento; arquivo `mcp-write.json`) no formato:
//   { "<servidor>": { "policy": "ask" | "deny", "readOnly": ["<ferramenta>", ...] } }
// e decide por ferramenta `mcp__<servidor>__<ferramenta>`:
//   - servidor sem política: não responde (segue o fluxo normal do Claude Code).
//   - ferramenta em `readOnly` (leitura, do último teste): não responde. Não é allow: a permissão segue como era.
//   - qualquer outra, inclusive a que o MCP ganhou depois do teste: "deny" (bloqueada) ou "ask" (pede antes).
//     Em bypassPermissions, "ask" vira "deny": não se comprova que o pedido aparece nesse modo.
// Fail-closed: arquivo ausente, ilegível ou fora do formato; nome que não separa servidor de ferramenta; nome que casa com mais
// de uma política; entrada ilegível; qualquer erro: "deny" (nunca libera por erro). Sem política nenhuma, não responde.
// Nome do servidor como o Claude Code o põe no nome da ferramenta: o caractere fora de [A-Za-z0-9_-] vira `_` (igual a
// claudeName em mcpTools.ts). Não se tem certeza dessa regra para todo caractere (o Club aceita `.`), então o nome da política
// casa também com as outras formas plausíveis (`-` ou o caractere como está): a chamada que casa com uma delas segue a política,
// sem ser lida como "sem política". Não se considera apagar o caractere: `github` casaria com `git.hub` e liberaria o servidor
// sem política (ver ../../tests/mcpWriteGuard.test.ts).
// Lê o evento em JSON no stdin e responde em JSON no stdout.

import { readFileSync } from 'node:fs';

const MCP = 'mcp__';
const clean = (s) => s.replace(/[^A-Za-z0-9_-]/g, '_');

/** As formas em que o nome do servidor pode aparecer na ferramenta (a de `clean` e as que trocam o caractere estranho). */
function forms(name) {
  // Até 6 caracteres estranhos com as 3 opções (4^6 formas no pior caso); além disso, só a de `_` (a de `clean`).
  let out = [''];
  let odd = 0;
  for (const ch of name.split('')) {
    const plain = /[A-Za-z0-9_-]/.test(ch);
    const opts = plain ? [ch] : odd++ < 6 ? ['_', '-', ch] : ['_'];
    out = out.flatMap((a) => opts.map((o) => a + o));
  }
  return [...new Set(out)];
}

const out = (permissionDecision, reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: `[MyCo] ${reason}` },
});

/** O arquivo da política, já com o nome normalizado. Fora do formato: lança (quem chama responde deny). */
function loadPolicy(file) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('política fora do formato');
  return Object.entries(doc).map(([name, e]) => {
    const ok =
      name !== '' &&
      e && typeof e === 'object' && (e.policy === 'ask' || e.policy === 'deny') &&
      Array.isArray(e.readOnly) && e.readOnly.every((t) => typeof t === 'string' && t !== '');
    if (!ok) throw new Error(`entrada fora do formato: ${name}`);
    return { name, forms: forms(name), policy: e.policy, readOnly: new Set(e.readOnly.map(clean)) };
  });
}

/** A resposta para uma chamada `mcp__…`; null = não responde. */
function decide(tool, policies, bypass) {
  if (policies.length === 0) return null;
  const rest = tool.slice(MCP.length);
  // Servidor e ferramenta precisam estar separados por `__`, com as duas partes preenchidas.
  const sep = rest.indexOf('__');
  if (sep < 1 || sep + 2 >= rest.length) {
    return out('deny', `não dá para conferir a política de escrita de "${tool}" (nome fora do padrão): bloqueado por segurança.`);
  }
  // Para cada política, as ferramentas que a chamada tem com alguma forma do nome dela.
  const hits = [];
  for (const p of policies) {
    const suffixes = p.forms.filter((f) => rest.startsWith(`${f}__`) && rest.length > f.length + 2).map((f) => rest.slice(f.length + 2));
    if (suffixes.length) hits.push({ p, suffixes });
  }
  if (hits.length === 0) return null;
  // Nome que casa com mais de uma política (ex.: `a` e `a__b`): não se sabe qual é: bloqueado.
  if (hits.length > 1) return out('deny', `"${tool}" casa com mais de um MCP da política de escrita: bloqueado por segurança.`);
  const { p, suffixes } = hits[0];
  const name = p.name;
  const toolName = suffixes[0];
  if (suffixes.every((t) => p.readOnly.has(t))) return null;
  if (p.policy === 'deny') return out('deny', `a ficha bloqueia escrita por MCP: "${toolName}" do MCP "${name}" não é só leitura. Siga sem essa ferramenta.`);
  if (bypass) {
    return out('deny', `a ficha pede confirmação antes de "${toolName}" do MCP "${name}", e no modo sem travas não há quem confirme: bloqueado. Siga sem essa ferramenta.`);
  }
  return out('ask', `a ficha pede confirmação antes de usar "${toolName}" do MCP "${name}" (não é só leitura).`);
}

/** Decide a entrada inteira. Lança só em erro inesperado (quem chama responde deny). */
function verdict(raw, file) {
  const ev = JSON.parse(raw);
  const tool = ev && typeof ev === 'object' ? ev.tool_name : undefined;
  // Sem nome de ferramenta, não dá para provar que não é MCP: bloqueia.
  if (typeof tool !== 'string') return out('deny', 'entrada da ferramenta sem nome: bloqueado por segurança.');
  if (!tool.startsWith(MCP)) return null;
  let policies;
  try {
    policies = loadPolicy(file);
  } catch {
    return out('deny', 'a política de escrita dos MCPs desta conversa está ausente ou ilegível: bloqueado por segurança. Siga sem essa ferramenta.');
  }
  return decide(tool, policies, ev.permission_mode === 'bypassPermissions');
}

/** Erro inesperado: se o evento for de MCP (ou não der para ler), bloqueia; se não for, não responde. */
function failClosed(raw) {
  try {
    const t = JSON.parse(raw)?.tool_name;
    if (typeof t === 'string' && !t.startsWith(MCP)) return null;
  } catch {
    // entrada ilegível: segue para o bloqueio
  }
  return out('deny', 'não deu para conferir a política de escrita dos MCPs: bloqueado por segurança.');
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('error', () => process.stdout.write(JSON.stringify(out('deny', 'entrada do hook indisponível: bloqueado por segurança.'))));
process.stdin.on('end', () => {
  let res;
  try {
    res = verdict(raw, process.argv[2]);
  } catch {
    res = failClosed(raw);
  }
  if (res) process.stdout.write(JSON.stringify(res));
});
