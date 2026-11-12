# My.Co Pizzaria (projeto demo do Claudio’s Club)

Uma pizzaria de exemplo para você conhecer o Claudio’s Club em uns 10 minutos: landing page, cardápio online e
pedidos, com uma equipe pronta para tocar o projeto. Sem dependências: só Node 22.

| Comando | O que faz |
|---|---|
| `npm start` | Sobe em http://localhost:3000 (landing) e http://localhost:3000/cardapio |
| `npm test` | Roda os testes (`node --test`) |

Regras do pedido e critérios de aceite estão em `SPEC.md`.

## Quem é quem

| Nome | Cargo | Reporta a | O que faz aqui |
|---|---|---|---|
| Lia | Orquestradora (Orquestrador(a)) | ninguém (topo) | Divide o trabalho em tarefas e acompanha a entrega de cada um. |
| Paulo | Product Owner (requisitos) | Lia | Define o que o pedido precisa fazer (critérios no `SPEC.md`). |
| Bruno | Desenvolvedor(a) back-end | Lia | Cuida da API: `server.js` e `pizzaria.js`. |
| Fernanda | Desenvolvedor(a) front-end | Lia | Cuida das páginas e da experiência no celular. |
| Duda | Guardiã do design system | Fernanda | Cores, tipografia e o CSS compartilhado (`public/style.css`). |
| Taís | Analista de QA | Lia | Testa o pedido e as regras de validação. |
| Sérgio | Analista de segurança (AppSec) | Lia | Revisa o formulário e o `POST /api/pedidos`. Só dá parecer. |

## Roteiro (cerca de 10 minutos)

1. **Organograma.** Veja a hierarquia: Lia está no topo, e a maioria reporta a ela. Duda reporta a Fernanda, não à Lia.
2. **Quadro de tarefas.** Veja a tarefa já concluída (a API do cardápio e do pedido, do Bruno) e as pendentes. Todas
   foram pedidas pela Lia.
3. **Converse com a Lia.** Peça algo, por exemplo: "comece pela tarefa do QA". Ela reparte o trabalho entre a equipe.
4. **Acompanhe.** Veja a delegação (quem recebeu o quê), a entrega de cada um e a revisão pelo gestor (cada funcionário
   reporta a alguém: Lia, ou Fernanda no caso da Duda).
5. **Rode o app.** Num terminal, na pasta do projeto:
   - `npm start` e abra http://localhost:3000. Depois faça um pedido em `/cardapio`.
   - `npm test` roda os testes. Tem pelo menos um bug esperando o QA.

## Antes de começar

- Abrir um funcionário gasta a cota do Claude da sua conta. Ver o quadro, as fichas e o organograma não gasta nada.
- Os funcionários do demo não têm navegador nem servidor. A conferência visual no celular (360 px) é com você: abra a
  página no celular ou no modo de dispositivo do navegador.
