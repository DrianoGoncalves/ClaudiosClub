import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { CARDAPIO, calcularTotal, validarItens } from './pedidos.js';

// API da cafeteria: o cardápio e o fechamento de um pedido. Só na própria máquina.

const PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY = 10_000;

const json = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

async function lerCorpo(req) {
  let corpo = '';
  for await (const parte of req) {
    corpo += parte;
    if (corpo.length > MAX_BODY) throw new Error('pedido grande demais');
  }
  return JSON.parse(corpo || '{}');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await readFile(new URL('./public/index.html', import.meta.url)));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/cardapio') return json(res, 200, CARDAPIO);
    if (req.method === 'POST' && req.url === '/api/pedidos') {
      const { itens } = await lerCorpo(req);
      const erro = validarItens(itens);
      if (erro) return json(res, 400, { erro });
      return json(res, 201, { itens, total: calcularTotal(itens) });
    }
    json(res, 404, { erro: 'não encontrado' });
  } catch {
    json(res, 400, { erro: 'pedido inválido' });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Cafeteria em http://localhost:${PORT}`));
