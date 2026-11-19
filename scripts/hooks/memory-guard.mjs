// Hook do Claude Code que o Claudio’s Club põe em todo funcionário (launch.ts, staffSettings), em Write, Edit e MultiEdit
// (matcher `Write|Edit|MultiEdit`). Fora do `plan` (onde só o MCP myco-memoria grava a memória, com o teto dele), o funcionário edita
// `.myco/staff/<id>.memory.md` e `<id>.memory/*.md` por estas ferramentas: o hook faz valer o mesmo teto de tamanho (memory-cap.mjs, ao lado).
// Calcula como o arquivo ficaria (Write: o `content`; Edit e MultiEdit: a troca aplicada ao arquivo de hoje) e nega se passar do teto,
// salvo uma versão menor que a atual quando ela já passa (reduzir nunca fica preso). Outro arquivo, ou troca que não se aplica: não responde.
// Higiene de custo, não segurança: ao contrário dos outros hooks, erro inesperado NÃO bloqueia (não responde), para um defeito aqui não
// travar a edição de todo arquivo. Não cobre o terminal (Bash e PowerShell) nem o Codex.
// Lê o evento em JSON no stdin e responde em JSON no stdout. Só nega; nunca libera.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { memoryJudge, memoryMeasure, memoryRefusal } from './memory-cap.mjs';

const TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
// Caminho já resolvido; as duas barras, e sem diferenciar caixa (Windows).
const INDEX = /[\\/]\.myco[\\/]staff[\\/]([a-z0-9-]{1,40})\.memory\.md$/i;
const DETAIL = /[\\/]\.myco[\\/]staff[\\/]([a-z0-9-]{1,40})\.memory[\\/][a-z0-9][a-z0-9-]{0,59}\.md$/i;

const out = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[MyCo] ${reason}` },
});

/** Uma troca do Edit aplicada a `text` (null = o arquivo não existe); null se não se aplica (o próprio Edit vai recusar). */
function applyEdit(text, e) {
  if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null;
  if (e.old_string === '') return text === null ? e.new_string : null;
  if (text === null || !text.includes(e.old_string)) return null;
  // Função na troca: `$&` e afins no texto novo valem como texto.
  return e.replace_all === true ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string);
}

/** Como o arquivo fica depois da chamada; null = não dá para saber (não responde). */
function nextText(tool, input, current) {
  if (tool === 'Write') return typeof input.content === 'string' ? input.content : null;
  const edits = tool === 'Edit' ? [input] : Array.isArray(input.edits) ? input.edits : null;
  if (!edits || edits.length === 0) return null;
  let text = current;
  for (const e of edits) {
    text = applyEdit(text, e);
    if (text === null) return null;
  }
  return text;
}

/** A resposta para a entrada; null = não responde. */
function verdict(raw) {
  const ev = JSON.parse(raw);
  const tool = ev && typeof ev === 'object' ? ev.tool_name : undefined;
  if (typeof tool !== 'string' || !TOOLS.has(tool)) return null;
  const input = ev.tool_input;
  if (!input || typeof input.file_path !== 'string') return null;
  const file = path.resolve(typeof ev.cwd === 'string' ? ev.cwd : process.cwd(), input.file_path);
  const index = INDEX.exec(file);
  const detail = index ? null : DETAIL.exec(file);
  if (!index && !detail) return null;
  let current = null;
  try {
    current = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') return null;
  }
  const text = nextText(tool, input, current);
  if (text === null) return null;
  const kind = index ? 'index' : 'detail';
  const next = memoryMeasure(text);
  const v = memoryJudge(kind, next, current === null ? null : memoryMeasure(current));
  if (v.ok) return null;
  return out(memoryRefusal(kind, next, { currentOver: v.currentOver, detailDir: `.myco/staff/${(index ?? detail)[1]}.memory` }));
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  let res = null;
  try {
    res = verdict(raw);
  } catch {
    // erro inesperado: não bloqueia (ver o topo)
  }
  if (res) process.stdout.write(JSON.stringify(res));
});
