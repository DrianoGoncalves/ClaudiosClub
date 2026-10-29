# Cafeteria (projeto demo do Claudio's Club)

Uma API pequena de cafeteria para ver a equipe do Claudio's Club trabalhando: o cardápio e o fechamento de um
pedido. Sem dependências: só Node 22.

| Comando | O que faz |
|---|---|
| `npm start` | Sobe em http://localhost:3000 |
| `npm test` | Roda os testes (`node --test`) |

- `pedidos.js`: cardápio, validação dos itens e o total (com um bug de propósito).
- `server.js`: `GET /api/cardapio` e `POST /api/pedidos` com `{ "itens": [{ "id": "espresso", "quantidade": 2 }] }`.
- `public/index.html`: a página do cardápio.

As tarefas do quadro do Claudio's Club partem daqui: corrigir o total, cobrir com testes, mostrar o pedido na
página e planejar cupons de desconto.
