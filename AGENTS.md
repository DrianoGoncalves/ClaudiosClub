# Claudio's Club (repo `MyCo`): comandos e travas

Windows, PowerShell 5.1 (sem `&&`/`||`; encadeie com `;`). Node >= 22. Visão e regras de produto: `SPEC.md` (não repetido aqui).

## Verificar
- Tipos: `npx tsc --noEmit` (na raiz, cobre server, client e shared).
- Testes do que você mexeu: `npx vitest related <arquivos> --passWithNoTests --maxWorkers=2`.
- Rode tsc e vitest um depois do outro, nunca juntos (pesa a máquina).
- A suíte inteira (`npm test`) roda no CI do PR; localmente só com motivo (`MYCO_FULL_TESTS=1` força no fluxo do Club).
- Vitest roda em `environment: node` (sem DOM): tela se testa por `renderToStaticMarkup`.

## Rodar
- Ver tela em desenvolvimento: `npx vite --port 5173` (o Vite repassa a API ao servidor).
- A porta 4848 só serve o build (`npm run build`), não o código novo.
- Pareamento com a porta do Vite: `npm run pair:dev`.

## Travas
- Nunca `npm ci`/`npm install` com o servidor do Club no ar (o `esbuild.exe` fica travado).
- Fora do git: `.myco/`, `PLANO.md`, `.claude/agents/`, `faces/`, `undefined/` (traz `secrets/pairing.key`: nunca vai para commit), `.env*`.
- Nada de segredo no código, no client nem em log; dado sensível só no servidor.
- `main` só recebe PR com o job `test` verde (`.github/workflows/ci.yml`). Nunca force-push.
- Antes de mexer em leitura do quadro, git, processo de fundo ou lista grande: leia "Desempenho: regras que não podem voltar atrás" no `SPEC.md`.
- Mudou comportamento visível: atualize `docs/uso/` e `client/public/manual.html`.
- Cor e espaçamento vêm dos tokens `--*` de `client/src/styles.css`; guia em `docs/design-system.md`.

## Onde fica o quê
- `server/`: servidor (rotas, chat, tarefas, git, Codex/Claude).
- `client/`: tela React/Vite (`client/src`, `client/public`).
- `shared/`: tipos e regras usados por server e client.
- `tests/`: testes vitest.
- `docs/uso/`: manual do usuário; `docs/`: deploy, formatos, design system.
- `scripts/`: daily, doctor, bundle, hooks.
