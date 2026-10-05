const net = require('net');
net.createServer((socket) => {
  console.log('>>> [44390] Receptor conectado por alguém!');
  socket.on('data', (data) => {
    console.log('>>> [44390] Dados brutos recebidos (com MLLP):', JSON.stringify(data.toString()));
    console.log('>>> [44390] Dados legíveis:\n', data.toString().replace(/\x0b/g, '[START]').replace(/\x1c/g, '[END]').replace(/\x0d/g, '[CR]\n'));
  });
  socket.on('close', () => console.log('>>> [44390] Conexão fechada.'));
}).listen(44390, '127.0.0.1', () => console.log('Servidor de teste rodando na porta 44390...'));