// Cardápio e regra de preço da cafeteria. Preços em centavos (inteiros: sem erro de arredondamento).

export const CARDAPIO = [
  { id: 'espresso', nome: 'Espresso', preco: 700 },
  { id: 'cappuccino', nome: 'Cappuccino', preco: 1200 },
  { id: 'pao-de-queijo', nome: 'Pão de queijo', preco: 600 },
  { id: 'bolo-de-cenoura', nome: 'Bolo de cenoura', preco: 900 },
];

const porId = new Map(CARDAPIO.map((item) => [item.id, item]));

/**
 * Confere os itens de um pedido: [{ id, quantidade }]. Devolve a mensagem do primeiro problema,
 * ou null se está tudo certo.
 */
export function validarItens(itens) {
  if (!Array.isArray(itens) || itens.length === 0) return 'o pedido precisa de pelo menos um item';
  if (itens.length > 20) return 'no máximo 20 itens por pedido';
  for (const item of itens) {
    if (!item || !porId.has(item.id)) return 'item fora do cardápio';
    if (!Number.isInteger(item.quantidade) || item.quantidade < 1 || item.quantidade > 50) {
      return 'quantidade inválida (de 1 a 50)';
    }
  }
  return null;
}

/** Total do pedido, em centavos. */
export function calcularTotal(itens) {
  // BUG de propósito (é a primeira tarefa do quadro): ignora a quantidade de cada item.
  return itens.reduce((soma, item) => soma + porId.get(item.id).preco, 0);
}
