const net = require('net');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config(); 

// Configuração do servidor
const PORT = process.env.WEBSOCKET_PORT; // Substitua pela porta desejada
const HOST = '0.0.0.0'; // Substitua pelo IP desejado, use '0.0.0.0' para escutar em todas as interfaces

// Configuração dos logs
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// Função para registrar logs
const logMessage = (message) => {
  const timestamp = new Date().toISOString();
  const logFileName = path.join(logDir, `${timestamp.slice(0, 10)}.log`); // Nome do arquivo baseado na data
  const logEntry = `[${timestamp}] ${message}\n`;
  
  fs.appendFile(logFileName, logEntry, (err) => {
    if (err) {
      console.error('Erro ao gravar no arquivo de log:', err.message);
    }
  });
};

// Função para limpar logs mais antigos que 7 dias
const cleanOldLogs = () => {
  fs.readdir(logDir, (err, files) => {
    if (err) {
      console.error('Erro ao ler diretório de logs:', err.message);
      return;
    }

    const now = Date.now();
    files.forEach((file) => {
      const filePath = path.join(logDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) {
          console.error('Erro ao obter informações do arquivo:', err.message);
          return;
        }

        const fileAgeInDays = (now - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
        if (fileAgeInDays > 7) {
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error('Erro ao excluir log antigo:', err.message);
            } else {
              console.log(`Log antigo removido: ${file}`);
            }
          });
        }
      });
    });
  });
};

// Resposta que o servidor enviará
const responseMessage = `
ACK|MSH|Message received successfully
`;

// Cria um servidor TCP
const server = net.createServer((socket) => {
  console.log('Cliente conectado:', socket.remoteAddress, socket.remotePort);

  // Evento ao receber dados do cliente
  socket.on('data', (data) => {
    const receivedData = data.toString(); // Converte o buffer para string
    logMessage(`Dados brutos recebidos: ${receivedData}`); // Log dos dados brutos

    // Normaliza as quebras de linha para '\n' e divide as mensagens
    const messages = receivedData.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    
    let hl7Message = null;

    // Processa cada mensagem separadamente

    messages.forEach((message) => {
        if (message.trim()) { // Ignora mensagens vazias
            logMessage(`Mensagem recebida: ${message}`);
            if (hl7Message == null){
              message = message.replace(/[\x0B]/g, '');
              hl7Message = message;
            }
            else
              hl7Message = hl7Message + '\n' + message; // Concatena corretamente usando '\r'
        }
    });
    
    console.log(hl7Message); // Exibe a mensagem HL7 completa no console

    axios.post(`http://localhost:3001/receive-hl7`, { hl7Message })
      .then((response) => {
        logMessage(`Resposta da API: ${JSON.stringify(response.data)}`); // Log da resposta da API
        const hl7Response = response.data.hl7; // Captura o valor de response.data.hl7
        const START = String.fromCharCode(0x0B);  // VT / STX
        const END = String.fromCharCode(0x1C);    // FS / ETX
        const CR = String.fromCharCode(0x0D);     // Carriage Return

        const fullMessage = START + hl7Response + END + CR;
        console.log('Mensagem formatada para envio:', fullMessage);

        // Enviar para o socket
        socket.write(fullMessage, () => {
          console.log('Mensagem enviada ao Mirth com sucesso.');
          socket.end(); // Encerra a conexão após o envio
        });

        socket.on('data', (data) => {
          console.log('Resposta do Mirth:', data.toString());
          socket.end(); // Fecha o socket após receber a resposta
        });

        socket.on('timeout', () => {
          console.error('O socket atingiu o tempo limite.');
          socket.destroy(); // Destrói o socket em caso de timeout
        });

        socket.on('error', (err) => {
          console.error('Erro no socket:', err.message);
          socket.destroy(); // Destrói o socket em caso de erro
        });
      })
      .catch((error) => {
        logMessage(`Erro na requisição: ${error.message}`); // Log do erro da API
        console.error('Erro na requisição:', error.message);
        socket.write('Erro ao processar a mensagem', () => socket.end()); // Envia erro ao cliente e encerra
      });
  });

  // Evento ao encerrar a conexão
  socket.on('end', () => {
    console.log('Cliente desconectado');
  });

  // Evento ao detectar erros na conexão
  socket.on('error', (err) => {
    console.error('Erro na conexão:', err.message);
  });
});

// Inicia o servidor e configura limpeza periódica de logs
server.listen(PORT, HOST, () => {
  console.log(`Servidor TCP rodando em ${HOST}:${PORT}`);
  cleanOldLogs(); // Limpa logs antigos ao iniciar
  setInterval(cleanOldLogs, 24 * 60 * 60 * 1000); // Agendamento diário para limpar logs
});
