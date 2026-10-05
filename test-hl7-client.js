// test-hl7-client.js
require('dotenv').config();
const net = require('net');

const SERVER_HOST = process.env.SERVER_HOST || '127.0.0.1';
const SERVER_PORT = parseInt(process.env.WEBSOCKET_PORT || '3000', 10);

// Porta de saída (para onde o servidor envia o HL7 enriquecido)
const OUTPUT_HOST = process.env.OUTPUT_HOST || '127.0.0.1';
const OUTPUT_PORT = parseInt(process.env.OUTPUT_PORT || '44390', 10);

const START = String.fromCharCode(0x0B);
const END = String.fromCharCode(0x1C);
const CR = String.fromCharCode(0x0D);

// Mensagem de teste
const HL7_MESSAGE =
  'MSH|^~\\&|LAB|HOSPITAL|APERIO|SYSTEM|20260722180000||ORM^O01|12345|P|2.5\r' +
  'PID|||123456||Silva^Joao\r' +
  'OBR|1|||045357283867\r';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 1) Sobe um "listener" fake na porta de saída (OUTPUT_PORT)
 *    para capturar o HL7 enriquecido que o servidor enviar.
 *    Se você já tem um destino real rodando nessa porta, comente isso.
 */
function startFakeOutputListener() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      console.log(
        `\n📥 [FAKE OUTPUT] Conexão recebida de ${socket.remoteAddress}:${socket.remotePort}`
      );

      socket.on('data', (data) => {
        buffer += data.toString('utf8');

        // Detecta frame MLLP completo
        const startIdx = buffer.indexOf(START);
        const endIdx = buffer.indexOf(END);
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          const payload = buffer.substring(startIdx + 1, endIdx);
          console.log('\n✅ [FAKE OUTPUT] HL7 enriquecido recebido:');
          console.log('--------------------------------------------------');
          console.log(payload.replace(/\r/g, '\n'));
          console.log('--------------------------------------------------');

          // Responde com um ACK fake (opcional, mas simula destino real)
          const ack =
            START +
            `MSH|^~\\&|FAKE|DEST||${new Date()
              .toISOString()
              .replace(/[-:TZ.]/g, '')
              .slice(0, 14)}||ACK^021|999|P|2.5.1\r` +
            `MSA|AA|12345\r` +
            END +
            CR;

          socket.write(ack);
          buffer = buffer.substring(endIdx + 1);
        }
      });

      socket.on('error', () => {});
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(
          `⚠️  Porta ${OUTPUT_PORT} já está em uso. Não vou subir o listener fake. ` +
            `Se for o destino real, ótimo — vamos ouvir a resposta dele.`
        );
        resolve(null);
      } else {
        reject(err);
      }
    });

    server.listen(OUTPUT_PORT, OUTPUT_HOST, () => {
      console.log(
        `🎧 [FAKE OUTPUT] Escutando em ${OUTPUT_HOST}:${OUTPUT_PORT} para capturar o HL7 enriquecido`
      );
      resolve(server);
    });
  });
}

/**
 * 2) Conecta no servidor principal, envia a mensagem e espera ACK
 */
function sendToServer(message) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let responseBuffer = '';

    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('Timeout aguardando ACK do servidor'));
    }, 10000);

    client.connect(SERVER_PORT, SERVER_HOST, () => {
      console.log(
        `\n📤 Conectado ao servidor ${SERVER_HOST}:${SERVER_PORT}`
      );

      const framed = START + message + END + CR;

      console.log('📨 Enviando mensagem HL7:');
      console.log('--------------------------------------------------');
      console.log(message.replace(/\r/g, '\n'));
      console.log('--------------------------------------------------');

      client.write(framed, (err) => {
        if (err) {
          clearTimeout(timeout);
          return reject(err);
        }
      });
    });

    client.on('data', (data) => {
      responseBuffer += data.toString('utf8');

      const endIdx = responseBuffer.indexOf(END);
      if (endIdx !== -1) {
        clearTimeout(timeout);

        const startIdx = responseBuffer.indexOf(START);
        const payload =
          startIdx !== -1
            ? responseBuffer.substring(startIdx + 1, endIdx)
            : responseBuffer.substring(0, endIdx);

        console.log('\n📥 ACK recebido do servidor:');
        console.log('--------------------------------------------------');
        console.log(payload.replace(/\r/g, '\n'));
        console.log('--------------------------------------------------');

        client.end();
        resolve(payload);
      }
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    client.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

(async () => {
  console.log('==================================================');
  console.log(' TESTE CLIENTE HL7 / MLLP');
  console.log('==================================================');
  console.log(`Servidor alvo : ${SERVER_HOST}:${SERVER_PORT}`);
  console.log(`Destino saída : ${OUTPUT_HOST}:${OUTPUT_PORT}`);
  console.log('');

  // Sobe listener fake na porta de saída
  const fakeServer = await startFakeOutputListener();

  // Aguarda um instante pra garantir que subiu
  await wait(300);

  try {
    await sendToServer(HL7_MESSAGE);
    console.log('\n✅ Teste finalizado com sucesso.');
  } catch (err) {
    console.error('\n❌ Erro no teste:', err.message);
  }

  // Espera um pouco pra receber o HL7 enriquecido no listener fake
  await wait(2000);

  if (fakeServer) {
    fakeServer.close();
    console.log('🔒 Listener fake encerrado.');
  }

  process.exit(0);
})();