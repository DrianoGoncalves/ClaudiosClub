// Cardápio e regras de pedido da My.Co Pizzaria. Preços em centavos (inteiros: sem erro de arredondamento).

export const CARDAPIO = [
  { id: 'margherita', nome: 'Margherita', descricao: 'Molho de tomate, mussarela e manjericão.', preco: 3990 },
  { id: 'calabresa', nome: 'Calabresa', descricao: 'Calabresa fatiada, cebola e azeitona.', preco: 4490 },
  { id: 'quatro-queijos', nome: 'Quatro queijos', descricao: 'Mussarela, provolone, parmesão e gorgonzola.', preco: 4990 },
  { id: 'frango-catupiry', nome: 'Frango com catupiry', descricao: 'Frango desfiado com catupiry original.', preco: 4790 },
  { id: 'portuguesa', nome: 'Portuguesa', descricao: 'Presunto, ovo, cebola, ervilha e mussarela.', preco: 4690 },
  { id: 'vegetariana', nome: 'Vegetariana', descricao: 'Abobrinha, berinjela, pimentão e tomate seco.', preco: 4290 },
];

const porId = new Map(CARDAPIO.map((pizza) => [pizza.id, pizza]));

const MAX_ITENS = 20;
const QUANTIDADE_MAX = 20;

/**
 * Confere um pedido: { itens: [{ id, quantidade }], cliente: { nome, telefone, endereco } }.
 * Devolve { pedido } com os campos já aparados, ou { erro } com a primeira regra que falhou.
 */
export function validarPedido(entrada) {
  const itens = validarItens(entrada?.itens);
  if (itens.erro) return { erro: itens.erro };
  const cliente = validarCliente(entrada?.cliente);
  if (cliente.erro) return { erro: cliente.erro };
  return { pedido: { itens: itens.itens, cliente: cliente.cliente } };
}

function validarItens(lista) {
  if (!Array.isArray(lista) || lista.length === 0) return { erro: 'o pedido precisa de pelo menos um item' };
  if (lista.length > MAX_ITENS) return { erro: `no máximo ${MAX_ITENS} itens por pedido` };
  const itens = [];
  for (const linha of lista) {
    const id = ehObjeto(linha) ? texto(linha.id) : '';
    if (!porId.has(id)) return { erro: 'item fora do cardápio' };
    const quantidade = linha.quantidade;
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > QUANTIDADE_MAX) {
      return { erro: `quantidade inválida (de 1 a ${QUANTIDADE_MAX})` };
    }
    itens.push({ id, quantidade });
  }
  return { itens };
}

function validarCliente(cliente) {
  if (!ehObjeto(cliente)) return { erro: 'informe nome, telefone e endereço' };
  const nome = texto(cliente.nome);
  if (nome.length < 2 || nome.length > 60) return { erro: 'nome: de 2 a 60 caracteres' };
  const telefone = texto(cliente.telefone);
  if (!/^[0-9]{10,11}$/.test(telefone)) return { erro: 'telefone: 10 ou 11 números, com DDD' };
  const endereco = texto(cliente.endereco);
  if (endereco.length < 5 || endereco.length > 120) return { erro: 'endereço: de 5 a 120 caracteres' };
  return { cliente: { nome, telefone, endereco } };
}

/** Total do pedido, em centavos. */
export function calcularTotal(itens) {
  return itens.reduce((soma, item) => soma + porId.get(item.id).preco, 0);
}

const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const texto = (valor) => (typeof valor === 'string' ? valor.trim() : '');
