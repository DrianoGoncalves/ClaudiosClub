import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { CARDAPIO, calcularTotal, validarPedido } from './pizzaria.js';

// Site e API da My.Co Pizzaria: landing, cardápio e pedidos (só em memória). Só na própria máquina.

const PORT = Number(process.env.PORT ?? 3000);
const MAX_CORPO = 10 * 1024;
const CSP_HTML = "default-src 'self'";

// Só estes arquivos saem do disco: o nome vem daqui, nunca do caminho que chegou na requisição.
const PAGINAS = { '/': 'index.html', '/cardapio': 'cardapio.html' };
const ESTATICOS = {
  '/style.css': { arquivo: 'style.css', tipo: 'text/css; charset=utf-8' },
  '/app.js': { arquivo: 'app.js', tipo: 'text/javascript; charset=utf-8' },
};

const pedidos = [];

class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

const arquivoPublico = (nome) => readFile(new URL(`./public/${nome}`, import.meta.url));

function enviar(res, status, tipo, corpo, extra = {}) {
  res.writeHead(status, { 'content-type': tipo, 'x-content-type-options': 'nosniff', ...extra });
  res.end(corpo);
}

const json = (res, status, dados) => enviar(res, status, 'application/json; charset=utf-8', JSON.stringify(dados));

async function lerPedido(req) {
  const partes = [];
  let tamanho = 0;
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho > MAX_CORPO) throw new ErroHttp(413, 'pedido grande demais');
    partes.push(parte);
  }
  try {
    return JSON.parse(Buffer.concat(partes).toString('utf8'));
  } catch {
    throw new ErroHttp(400, 'JSON inválido');
  }
}

async function criarPedido(req, res) {
  const { pedido, erro } = validarPedido(await lerPedido(req));
  if (erro) return json(res, 400, { erro });
  // O preço sai do cardápio daqui de dentro: o que o cliente mandar de preço é ignorado.
  const total = calcularTotal(pedido.itens);
  const numero = pedidos.length + 1;
  pedidos.push({ numero, ...pedido, total, criadoEm: new Date().toISOString() });
  console.log(`Pedido nº ${numero} recebido (total ${total} centavos).`);
  return json(res, 201, { numero, total });
}

async function atender(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && Object.hasOwn(PAGINAS, pathname)) {
    return enviar(res, 200, 'text/html; charset=utf-8', await arquivoPublico(PAGINAS[pathname]), { 'content-security-policy': CSP_HTML });
  }
  if (req.method === 'GET' && Object.hasOwn(ESTATICOS, pathname)) {
    const { arquivo, tipo } = ESTATICOS[pathname];
    return enviar(res, 200, tipo, await arquivoPublico(arquivo));
  }
  if (req.method === 'GET' && pathname === '/api/cardapio') return json(res, 200, CARDAPIO);
  if (req.method === 'POST' && pathname === '/api/pedidos') return criarPedido(req, res);
  json(res, 404, { erro: 'não encontrado' });
}

const server = http.createServer(async (req, res) => {
  try {
    await atender(req, res);
  } catch (err) {
    if (err instanceof ErroHttp) {
      res.setHeader('connection', 'close');
      return json(res, err.status, { erro: err.message });
    }
    // Sem a mensagem do erro no log: ela pode trazer pedaço do corpo.
    console.error('erro ao atender requisição:', err.name);
    json(res, 500, { erro: 'erro interno' });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`My.Co Pizzaria em http://localhost:${PORT}`));
