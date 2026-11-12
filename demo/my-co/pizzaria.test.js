import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CARDAPIO, calcularTotal, validarPedido } from './pizzaria.js';

const cliente = { nome: 'Ana Souza', telefone: '11999998888', endereco: 'Rua das Flores, 100' };
const pedido = (itens, extra = {}) => ({ itens, cliente, ...extra });

describe('cardápio', () => {
  test('tem seis pizzas com id, nome, descrição e preço inteiro em centavos', () => {
    assert.equal(CARDAPIO.length, 6);
    for (const pizza of CARDAPIO) {
      assert.equal(typeof pizza.id, 'string');
      assert.equal(typeof pizza.nome, 'string');
      assert.equal(typeof pizza.descricao, 'string');
      assert.ok(Number.isInteger(pizza.preco) && pizza.preco > 0, `preço de ${pizza.id}`);
    }
  });

  test('ids são únicos', () => {
    const ids = CARDAPIO.map((pizza) => pizza.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('validarPedido', () => {
  test('aceita um pedido válido e devolve os campos sem espaços sobrando', () => {
    const r = validarPedido(
      pedido([{ id: ' margherita ', quantidade: 1 }], {
        cliente: { nome: '  Ana Souza ', telefone: ' 11999998888 ', endereco: ' Rua das Flores, 100 ' },
      }),
    );
    assert.equal(r.erro, undefined);
    assert.deepEqual(r.pedido.itens, [{ id: 'margherita', quantidade: 1 }]);
    assert.deepEqual(r.pedido.cliente, { nome: 'Ana Souza', telefone: '11999998888', endereco: 'Rua das Flores, 100' });
  });

  test('ignora campos extras, como preço enviado pelo cliente', () => {
    const r = validarPedido(pedido([{ id: 'margherita', quantidade: 1, preco: 1 }]));
    assert.deepEqual(r.pedido.itens[0], { id: 'margherita', quantidade: 1 });
  });

  test('rejeita pedido sem itens e com mais de 20 linhas', () => {
    assert.match(validarPedido(pedido([])).erro, /pelo menos um item/);
    const muitos = Array.from({ length: 21 }, () => ({ id: 'margherita', quantidade: 1 }));
    assert.match(validarPedido(pedido(muitos)).erro, /no máximo 20/);
  });

  test('rejeita item fora do cardápio', () => {
    assert.match(validarPedido(pedido([{ id: 'hamburguer', quantidade: 1 }])).erro, /fora do cardápio/);
    assert.match(validarPedido(pedido([{ quantidade: 1 }])).erro, /fora do cardápio/);
  });

  test('rejeita quantidade zero, acima de 20, fracionada, negativa ou em texto', () => {
    for (const quantidade of [0, 21, 1.5, -1, '1', null]) {
      assert.match(validarPedido(pedido([{ id: 'margherita', quantidade }])).erro, /quantidade inválida/, String(quantidade));
    }
  });

  test('rejeita nome curto ou longo demais', () => {
    assert.match(validarPedido(pedido([{ id: 'margherita', quantidade: 1 }], { cliente: { ...cliente, nome: 'A' } })).erro, /nome/);
    const longo = 'A'.repeat(61);
    assert.match(validarPedido(pedido([{ id: 'margherita', quantidade: 1 }], { cliente: { ...cliente, nome: longo } })).erro, /nome/);
  });

  test('rejeita telefone com letra, com 9 ou com 12 dígitos', () => {
    for (const telefone of ['119999988a8', '119999988', '119999988888']) {
      assert.match(validarPedido(pedido([{ id: 'margherita', quantidade: 1 }], { cliente: { ...cliente, telefone } })).erro, /telefone/, telefone);
    }
  });

  test('rejeita endereço curto demais', () => {
    assert.match(validarPedido(pedido([{ id: 'margherita', quantidade: 1 }], { cliente: { ...cliente, endereco: 'Rua' } })).erro, /endereço/);
  });

  test('rejeita campo do tipo errado (número no lugar de texto)', () => {
    assert.match(validarPedido(pedido([{ id: 'margherita', quantidade: 1 }], { cliente: { ...cliente, telefone: 11999998888 } })).erro, /telefone/);
    assert.match(validarPedido({ itens: 'margherita', cliente }).erro, /pelo menos um item/);
  });
});

describe('calcularTotal', () => {
  test('um item de 1 unidade custa o preço da pizza', () => {
    assert.equal(calcularTotal([{ id: 'margherita', quantidade: 1 }]), 3990);
  });

  test('pizzas diferentes, uma unidade cada, somam os preços', () => {
    assert.equal(
      calcularTotal([
        { id: 'margherita', quantidade: 1 },
        { id: 'calabresa', quantidade: 1 },
      ]),
      3990 + 4490,
    );
  });
});
