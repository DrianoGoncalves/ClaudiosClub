// Cardápio, carrinho e envio do pedido. Tudo que vem da API entra com textContent, nunca como HTML.

const MAX_QUANTIDADE = 20;

const reais = (centavos) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const listaEl = document.getElementById('cardapio');
const carrinhoEl = document.getElementById('carrinho');
const avisoEl = document.getElementById('aviso');
const formEl = document.getElementById('pedido-form');
const enviarEl = document.getElementById('enviar');

let pizzas = [];
/** id da pizza -> quantidade (só o que tem quantidade maior que zero). */
const quantidades = new Map();
/** id da pizza -> o <output> que mostra a quantidade no card. */
const saidas = new Map();

function mostrar(texto, tipo = '') {
  avisoEl.textContent = texto;
  avisoEl.className = tipo ? `aviso ${tipo}` : 'aviso';
}

function criarBotao(texto, rotulo, aoClicar) {
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.textContent = texto;
  botao.setAttribute('aria-label', rotulo);
  botao.addEventListener('click', aoClicar);
  return botao;
}

function criarCard(pizza) {
  const li = document.createElement('li');
  li.className = 'pizza';

  const titulo = document.createElement('h2');
  titulo.textContent = pizza.nome;

  const descricao = document.createElement('p');
  descricao.textContent = pizza.descricao;

  const preco = document.createElement('p');
  preco.className = 'preco';
  preco.textContent = reais(pizza.preco);

  const controle = document.createElement('div');
  controle.className = 'quantidade';
  const saida = document.createElement('output');
  saida.textContent = '0';
  saidas.set(pizza.id, saida);
  controle.append(
    criarBotao('−', `Tirar uma ${pizza.nome}`, () => ajustar(pizza.id, -1)),
    saida,
    criarBotao('+', `Adicionar uma ${pizza.nome}`, () => ajustar(pizza.id, 1)),
  );

  li.append(titulo, descricao, preco, controle);
  return li;
}

function ajustar(id, delta) {
  const nova = Math.min(MAX_QUANTIDADE, Math.max(0, (quantidades.get(id) ?? 0) + delta));
  if (nova === 0) quantidades.delete(id);
  else quantidades.set(id, nova);
  atualizarTela();
}

function atualizarTela() {
  for (const pizza of pizzas) saidas.get(pizza.id).textContent = String(quantidades.get(pizza.id) ?? 0);

  const linhas = pizzas
    .filter((pizza) => quantidades.has(pizza.id))
    .map((pizza) => {
      const li = document.createElement('li');
      li.textContent = `${quantidades.get(pizza.id)} × ${pizza.nome} (${reais(pizza.preco)} cada)`;
      return li;
    });
  if (linhas.length === 0) {
    const vazio = document.createElement('li');
    vazio.className = 'vazio';
    vazio.textContent = 'Nenhuma pizza escolhida ainda.';
    linhas.push(vazio);
  }
  carrinhoEl.replaceChildren(...linhas);
  enviarEl.disabled = quantidades.size === 0;
}

async function carregarCardapio() {
  try {
    const resposta = await fetch('/api/cardapio');
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    pizzas = await resposta.json();
    listaEl.replaceChildren(...pizzas.map(criarCard));
    atualizarTela();
  } catch {
    mostrar('Não consegui carregar o cardápio. Recarregue a página.', 'erro');
  }
}

formEl.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  if (quantidades.size === 0) return mostrar('Escolha pelo menos uma pizza.', 'erro');
  if (!formEl.reportValidity()) return;

  const dados = new FormData(formEl);
  const corpo = {
    itens: [...quantidades].map(([id, quantidade]) => ({ id, quantidade })),
    cliente: { nome: dados.get('nome'), telefone: dados.get('telefone'), endereco: dados.get('endereco') },
  };

  enviarEl.disabled = true;
  mostrar('Enviando seu pedido…', 'info');
  try {
    const resposta = await fetch('/api/pedidos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const resultado = await resposta.json().catch(() => ({}));
    if (!resposta.ok) return mostrar(resultado.erro ?? 'Não consegui enviar o pedido.', 'erro');

    mostrar(`Pedido nº ${resultado.numero} recebido. Total: ${reais(resultado.total)}.`, 'ok');
    quantidades.clear();
    formEl.reset();
  } catch {
    mostrar('Sem conexão com a pizzaria. Tente de novo.', 'erro');
  } finally {
    atualizarTela();
  }
});

atualizarTela();
carregarCardapio();
