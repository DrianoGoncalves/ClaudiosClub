# My.Co Pizzaria: especificação

## O que é
Site de uma pizzaria de exemplo: landing page, cardápio online e pedidos. É o projeto demo do Claudio’s Club.
Serve para a equipe trabalhar em cima dele, não para vender nada.

## Telas
- `/` (landing): nome da pizzaria, três destaques, horário e o botão "Ver cardápio".
- `/cardapio`: lista de pizzas com preço e quantidade, carrinho e formulário de entrega (nome, telefone, endereço).
- Depois de enviar: número do pedido e total.

## Cardápio
Seis pizzas, cada uma com id, nome, descrição e preço em centavos. O preço fica só no servidor.

## Regras do pedido
- Itens: de 1 a 20 linhas. Cada linha tem um id do cardápio e quantidade inteira de 1 a 20.
- Cliente: nome de 2 a 60 caracteres; telefone só com números, 10 ou 11 (com DDD); endereço de 5 a 120 caracteres.
- Textos são aparados (sem espaço no início e no fim) antes da validação.
- Total: soma dos itens em centavos, com o preço do cardápio. Preço que vier do cliente é ignorado.
- Sucesso: 201 com `{ numero, total }`. Validação: 400 com `{ erro }`. Corpo acima de 10 kB: 413.
- Pedidos ficam só na memória do servidor; reiniciar apaga tudo.

## API
- `GET /api/cardapio`
- `POST /api/pedidos`, corpo JSON `{ itens, cliente }`.

## Critérios de aceite
- Landing e cardápio funcionam em 360 px de largura, sem rolagem horizontal.
- O servidor valida todo pedido; a página só ajuda com `required`, `maxlength` e `pattern`.
- Nome, telefone e endereço não aparecem em log.
- Páginas HTML com `Content-Security-Policy: default-src 'self'` e `X-Content-Type-Options: nosniff`.
- Cada regra de validação tem teste em `pizzaria.test.js`.

## Fora do escopo
Pagamento, login, banco de dados, acompanhamento de entrega e área da loja.
