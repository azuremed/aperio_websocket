const HL7 = require('hl7-standard/src/api');
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
    const receivedMessage = data.toString();
    logMessage(`Mensagem recebida: ${receivedMessage}`); // Grava no log a mensagem recebida

    console.log('Mensagem recebida:');
    
    // Transforma a mensagem HL7
    let hl7 = new HL7(receivedMessage, {
        fieldSeparator: '|',
        componentSeparator: '^',
        repetitionSeparator: '~',
        escapeCharacter: '\\',
        subcomponentSeparator: '&',
        lineEnding: '\r',
    });
    hl7.transform();

    console.log('HL7 transformado');

    //Capturando o ID da amostra
    let obr = hl7.get('OBR.4');

    axios.get(`http://localhost:3002/amostra/${obr}`)
    .then((response) => {
        logMessage(`Resposta da API: ${JSON.stringify(response.data)}`); // Log da resposta da API
        console.log(response.data); // Exibe o objeto JSON
    })
    .catch((error) => {
        logMessage(`Erro na requisição: ${error.message}`); // Log do erro da API
        console.error('Erro na requisição:', error.message);
    });
    
    // Envia uma resposta ao cliente
    socket.write(responseMessage);
    console.log('Resposta enviada ao cliente');

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
