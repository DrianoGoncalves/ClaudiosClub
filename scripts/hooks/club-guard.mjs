// Hook do Claude Code que o Claudio’s Club liga em todo funcionário (--settings, ver server/staff/launch.ts), nas ferramentas
// de navegador (Claude in Chrome e MCPs com `browser_*`, como o Playwright).
//   pre: nega a chamada que leva o navegador ao próprio Claudio’s Club (claudio.localhost, myco.localhost ou qualquer
//        endereço na porta dele): o navegador é o do dono, já pareado, e um clique do agente aprovaria permissões, planos e
//        mesclas no lugar dele. Vale em todo modo, também em "sem travas" (o hook roda antes da permissão).
// Confere todo texto da entrada (URL, código do javascript_tool, texto digitado). Não pega um link clicado numa página que
// leve ao Club: é uma camada, não a única (a ficha também proíbe; no Codex, o --blocked-origins do Playwright barra na rede).
// Lê o evento em JSON no stdin e responde em JSON no stdout. Qualquer erro: não responde nada (o Claude Code segue).

const PORT = Number(process.env.MYCO_PORT ?? 4848);

const CLUB_NAME = /(?:^|[^a-z0-9-])(?:claudio|myco)\.localhost\b/i;
// Qualquer host na porta do Club (localhost, 127.x, [::1], 0.0.0.0, o IP da máquina...). Só a porta: o projeto do
// funcionário pode rodar em outra porta de localhost à vontade.
const CLUB_PORT = new RegExp(`[a-z0-9.\\]-]:${PORT}(?![0-9])`, 'i');

const NEGADO =
  '[MyCo] O navegador dos funcionários não abre o Claudio’s Club: a tela dele é do dono (aprovações, permissões e mesclas são dele). ' +
  'Siga sem isso. Se precisar de algo do Club, use a API da sua ficha (curl com x-myco-token) ou pergunte ao dono no chat.';

/** Os textos da entrada, até uma profundidade razoável (objetos e listas aninhados). */
function texts(value, depth = 0, out = []) {
  if (depth > 6 || out.length > 500) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) texts(v, depth + 1, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) texts(v, depth + 1, out);
  return out;
}

/** O texto aponta para o Claudio’s Club? Também com a URL codificada (%2E, %3A). */
function pointsToClub(text) {
  let t = text;
  if (t.includes('%')) {
    try {
      t = `${t} ${decodeURIComponent(t)}`;
    } catch {
      // codificação quebrada: confere o texto como veio
    }
  }
  return CLUB_NAME.test(t) || CLUB_PORT.test(t);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(raw);
    if (!ev || typeof ev !== 'object' || process.argv[2] !== 'pre') return;
    if (texts(ev.tool_input).some(pointsToClub)) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NEGADO } }));
    }
  } catch {
    // entrada inesperada: sem resposta
  }
});
