// Hook do Claude Code que o Claudio’s Club liga em todo funcionário (--settings, ver server/staff/launch.ts), nas ferramentas
// de navegador (Claude in Chrome e MCPs com `browser_*`, como o Playwright).
//   pre: nega a chamada que leva o navegador ao próprio Claudio’s Club (claudio.localhost, myco.localhost ou qualquer
//        endereço na porta dele, ou na de uma origem registrada que serve a tela dele, como o Vite do `npm run dev`; ver
//        club-origins.mjs): o navegador é o do dono, já pareado, e um clique do agente aprovaria permissões, planos e
//        mesclas no lugar dele. Vale em todo modo, também em "sem travas" (o hook roda antes da permissão).
// Confere todo texto da entrada (URL, código do javascript_tool, texto digitado). Não pega um link clicado numa página que
// leve ao Club: é uma camada, não a única (a ficha também proíbe; no Codex, o --blocked-origins do Playwright barra na rede).
// Lê o evento em JSON no stdin e responde em JSON no stdout. Qualquer erro: não responde nada (o Claude Code segue).

import { registeredPorts } from './club-origins.mjs';

const PORT = Number(process.env.MYCO_PORT ?? 4848);

const CLUB_NAME = /(?:^|[^a-z0-9-])(?:claudio|myco)\.localhost\b/i;
// Qualquer host numa porta que serve a tela do Club (localhost, 127.x, [::1], 0.0.0.0, o IP da máquina...): a do servidor e as das origens
// registradas e vivas (o Vite do dev, 5173, com proxy de /api para ele). Só essas portas: o projeto do funcionário pode rodar em outra porta
// de localhost à vontade, e a prévia de interface (127.0.0.1:5199, sem servidor) não está no registro. Zeros à esquerda contam: o navegador lê
// :04848 como :4848. O registro é relido a cada chamada (um Vite que sobe depois da conversa também vale).
const clubPortPattern = () => new RegExp(`[a-z0-9.\\]-]:0*(?:${[...new Set([PORT, ...registeredPorts()])].join('|')})(?![0-9])`, 'i');

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
function pointsToClub(text, clubPort) {
  let t = text;
  if (t.includes('%')) {
    try {
      t = `${t} ${decodeURIComponent(t)}`;
    } catch {
      // codificação quebrada: confere o texto como veio
    }
  }
  return CLUB_NAME.test(t) || clubPort.test(t);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(raw);
    if (!ev || typeof ev !== 'object' || process.argv[2] !== 'pre') return;
    const clubPort = clubPortPattern();
    if (texts(ev.tool_input).some((text) => pointsToClub(text, clubPort))) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NEGADO } }));
    }
  } catch {
    // entrada inesperada: sem resposta
  }
});
