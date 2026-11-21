# Guia do projeto

> A equipe consulta este arquivo em caso de dúvida.
>
> Se tiver informação privada (senhas, dados de clientes, endereços internos),
> não escreva aqui: ponha o arquivo no `.gitignore`.

## Visão

<!--
O que é o projeto, em duas ou três frases, e para quem é.
-->

## Problema que resolve

<!--
Qual dor existe hoje e o que muda para quem usa
quando o projeto estiver pronto.
-->

## Escopo

<!--
O que o projeto faz. Uma função principal por linha.
-->

## Fora do escopo

<!--
O que o projeto não faz, mesmo que alguém peça.
Evita trabalho que contraria a visão.
-->

## Princípios e regras inegociáveis

<!--
Regras que não se quebram por conveniência.
Ex.: dados sensíveis só no servidor; dependência nova só com aprovação.
-->

## Glossário

<!--
Termos do projeto e o que significam, para todos falarem a mesma língua.
-->

## Decisões

<!--
Cada decisão com data e o porquê.
Ex.: 2026-11-06: SQLite, porque o cliente não tem servidor de banco.
-->

## Dúvidas em aberto

<!--
O que ainda não foi decidido. Quando resolver, passe para Decisões.
-->

## Lições da revisão

<!--
Regras que saíram de um 🔴 da revisão e valem para o projeto todo, uma por linha, com data.
No máximo 15: ao passar disso, junte ou tire as que ficaram velhas.
Ex.: 2026-11-06: toda rota que grava confere o cabeçalho x-myco.
-->

- 2026-11-20: `.myco/` está no `.gitignore`, então o revisor que lê pelo diff não vê os prints: na entrega liste o caminho absoluto de cada print com a hora de gravação e, na rodada de ajuste, regrave-os depois da última edição do CSS.
- 2026-11-20: no celular, ação de decisão do dono (rodapé fixo, Aprovar, Responder) nunca some com o foco em campo ou o teclado aberto; o corpo é que encolhe e rola.
- 2026-11-20: "com o teclado aberto" se prova no navegador nos dois modelos (layout que encolhe: viewport baixo; teclado que só cobre: `visualViewport` reduzido), não só com regra de CSS; no segundo o rodapé precisa seguir `visualViewport` (`client/src/tasks/useKeyboardInset.ts`).
- 2026-11-20: print de tela só vale se for posterior ao último mtime de `client/src/styles.css` (arquivo compartilhado, outras tarefas regravam); conferir os mtimes e trazer na entrega a saída de `npx tsc --noEmit` e a contagem dos testes.
- 2026-11-20: teste que simula "parada resolvida" (`stuckState`, caixa, selos derivados) parte de um estado resolvido de verdade (revisão aberta, veredito, resposta dada), não de tirar só o campo que causou a parada: `stuckState` ganha regras novas e o fixture fica vermelho (conferir o teste do tema no `tasks.ts` sujo de hoje, não só o do dia).
- 2026-11-21: a revisão lê o diff da pasta principal do projeto; entrega feita só em outra branch/worktree/PR não aparece nele e reprova. A mudança também tem que estar na pasta principal (sem commit), além do PR, se houver.
