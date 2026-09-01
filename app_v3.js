const net = require('net');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const HL7 = require('hl7-standard');
const { format } = require('date-fns');
const { randomUUID } = require('crypto');

// Porta para receber dados e porta para enviar resposta
const LISTEN_PORT = process.env.LISTEN_PORT || 3000;  // Porta para receber
const RESPONSE_PORT = process.env.RESPONSE_PORT || 3001; // Porta para responder
const DOMAIN = process.env.DOMAIN;
const TOKEN = process.env.TOKEN;
const HOST = '0.0.0.0';

const appDir = process.pkg
  ? path.dirname(process.execPath)
  : __dirname;

const logDir = path.join(appDir, 'logs');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logMessage = (message) => {
  const timestamp = new Date().toISOString();
  const logFileName = path.join(logDir, `${timestamp.slice(0, 10)}.log`);
  const logEntry = `[${timestamp}] ${message}\n`;

  fs.appendFile(logFileName, logEntry, (err) => {
    if (err) {
      console.error('Erro ao gravar no arquivo de log:', err.message);
    }
  });
};

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

async function fetchAndBuildHL7(hl7Message) {
  const now = new Date();
  const formattedDate = format(now, 'yyyyMMddHHmmss');

  let hl7 = new HL7(hl7Message, {
    fieldSeparator: '|',
    componentSeparator: '^',
    repetitionSeparator: '~',
    escapeCharacter: '\\',
    subcomponentSeparator: '&',
    lineEnding: '\r',
  });
  hl7.transform();

  logMessage('HL7 transformado com sucesso');

  let id_amostra = hl7.get('OBR.4');
  logMessage(`ID da amostra capturado: ${id_amostra}`);

  logMessage(`Buscando dados para amostra: ${id_amostra}`);
  const domain = DOMAIN;
  const token = TOKEN;
  const url = `https://api-externa.klingo.app/api/aperio/consulta/${domain}/${token}/${id_amostra}`;

  logMessage(`Requisitando o endpoint: ${url}`);
  console.log(`Requisitando o endpoint: ${url}`);

  const response = await fetch(url);
  const responseText = await response.text();

  logMessage(`Status da resposta: ${response.status}`);
  logMessage(`Conteúdo bruto recebido: ${responseText}`);
  console.log(`Conteúdo bruto recebido: ${responseText}`);

  if (!response.ok) {
    throw new Error(`Erro na requisição: ${response.status} - ${response.statusText}`);
  }

  const result = JSON.parse(responseText);
  let record = result;

  if (!record) {
    throw new Error('Nenhum registro encontrado para o ID fornecido.');
  }

  logMessage('Dados recuperados com sucesso!');

  let patientName = record.pac_nome?.trim() ?? '';
  let patientNameSplited = patientName.split(' ');

  let doctorName = record.psv_nome?.trim() ?? '';
  let doctorNameSplited = doctorName.split(' ');

  let doctorCRM = (record.psv_uf || '') + (record.psv_crm || '');

  let patientGender = record.pac_sexo ?? 'U';

  for (let segment of hl7.getSegments()) {
    if (['ORC', 'OBR', 'OBX', 'PID', 'PV1', 'SAC', 'SPM'].includes(segment.type)) {
      hl7.deleteSegment(segment);
    }
  }
  logMessage('Segmentos deletados');

  hl7.set('MSH.7.1', formattedDate);
  hl7.set('MSH.9.1', 'OML');
  hl7.set('MSH.9.2', 'O21');
  hl7.set('MSH.10', randomUUID());

  hl7.createSegment('PID');
  hl7.createSegment('PV1');
  hl7.createSegment('ORC');
  hl7.createSegment('SAC');
  hl7.createSegment('SPM');
  hl7.createSegment('OBR');

  hl7.set('PID.3.1', record.pac_reg?.toString() ?? '');
  hl7.set('PID.5.1', patientNameSplited[patientNameSplited.length - 1] ?? '');
  hl7.set('PID.5.2', patientNameSplited[0] ?? '');
  hl7.set('PID.7', record.pac_nasc ? format(new Date(record.pac_nasc), 'yyyyMMdd') : '');
  hl7.set('PID.8', patientGender);
  hl7.set('PID.23', 'U');

  hl7.set('PV1.7.1', doctorCRM ?? '');
  hl7.set('PV1.7.2', doctorNameSplited[doctorNameSplited.length - 1] ?? '');
  hl7.set('PV1.7.3', doctorNameSplited[0] ?? '');
  hl7.set('PV1.7.6', 'Dr');

  hl7.set('ORC.1', 'NW');

  hl7.set('SAC.1', record.smm_cod_amostra?.toString() ?? '');

  hl7.set('SPM.2.1', record.smm_cod_amostra?.toString() ?? '');
  hl7.set('SPM.17.1', record.smm_dthr_coleta ? format(new Date(record.smm_dthr_coleta), 'yyyyMMddHHmmss') : '');
  hl7.set('SPM.18.1', record.smm_dthr_coleta ? format(new Date(record.smm_dthr_coleta), 'yyyyMMddHHmmss') : '');

  hl7.set('OBR.1', 1);
  hl7.set('OBR.4', record.smm_cod_amostra?.toString() ?? '');

  let responseHl7 = await hl7.build();
  logMessage('HL7 montado com sucesso');
  return responseHl7;
}

// Servidor que escuta na porta LISTEN_PORT
const listenServer = net.createServer((socket) => {
  const clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[Escutando ${LISTEN_PORT}] Cliente conectado:`, clientInfo);
  logMessage(`[Escutando ${LISTEN_PORT}] Cliente conectado: ${clientInfo}`);

  let receivedData = '';

  socket.on('data', async (data) => {
    try {
      const chunk = data.toString();
      logMessage(`[Escutando ${LISTEN_PORT}] Dados brutos recebidos: ${chunk}`);
      receivedData += chunk;

      // Processa a mensagem quando completa
      const messages = receivedData.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      
      let hl7Message = null;

      messages.forEach((message) => {
        if (message.trim()) {
          logMessage(`[Escutando ${LISTEN_PORT}] Mensagem recebida: ${message}`);
          if (hl7Message == null) {
            message = message.replace(/[\x0B]/g, '');
            hl7Message = message;
          } else {
            hl7Message = hl7Message + '\n' + message;
          }
        }
      });

      console.log(`[Escutando ${LISTEN_PORT}] Mensagem HL7 recebida:`, hl7Message);
      logMessage(`[Escutando ${LISTEN_PORT}] Mensagem HL7 completa: ${hl7Message}`);

      // Processa a mensagem
      const hl7Response = await fetchAndBuildHL7(hl7Message);
      logMessage(`[Escutando ${LISTEN_PORT}] HL7 processado com sucesso`);

      // Envia a resposta para a porta RESPONSE_PORT
      const responseClient = new net.Socket();
      
      // Conecta na porta de resposta
      responseClient.connect(RESPONSE_PORT, HOST, () => {
        console.log(`[Resposta ${RESPONSE_PORT}] Conectado para enviar resposta`);
        logMessage(`[Resposta ${RESPONSE_PORT}] Conectado para enviar resposta`);

        const START = String.fromCharCode(0x0B);
        const END = String.fromCharCode(0x1C);
        const CR = String.fromCharCode(0x0D);

        const fullMessage = START + hl7Response + END + CR;
        console.log(`[Resposta ${RESPONSE_PORT}] Mensagem formatada para envio:`, fullMessage);
        logMessage(`[Resposta ${RESPONSE_PORT}] Mensagem enviada: ${fullMessage}`);

        // Envia a resposta
        responseClient.write(fullMessage, () => {
          console.log(`[Resposta ${RESPONSE_PORT}] Mensagem enviada com sucesso.`);
          logMessage(`[Resposta ${RESPONSE_PORT}] Mensagem enviada com sucesso.`);
          responseClient.end();
        });
      });

      responseClient.on('error', (err) => {
        console.error(`[Resposta ${RESPONSE_PORT}] Erro ao enviar resposta:`, err.message);
        logMessage(`[Resposta ${RESPONSE_PORT}] Erro ao enviar resposta: ${err.message}`);
        socket.write(`Erro ao enviar resposta: ${err.message}`, () => socket.end());
      });

      // Limpa os dados recebidos após processar
      receivedData = '';

    } catch (error) {
      logMessage(`[Escutando ${LISTEN_PORT}] Erro no processamento: ${error.message}`);
      console.error(`[Escutando ${LISTEN_PORT}] Erro no processamento:`, error.message);
      socket.write('Erro ao processar a mensagem', () => socket.end());
    }
  });

  socket.on('end', () => {
    console.log(`[Escutando ${LISTEN_PORT}] Cliente desconectado:`, clientInfo);
    logMessage(`[Escutando ${LISTEN_PORT}] Cliente desconectado: ${clientInfo}`);
  });

  socket.on('error', (err) => {
    console.error(`[Escutando ${LISTEN_PORT}] Erro na conexão:`, err.message);
    logMessage(`[Escutando ${LISTEN_PORT}] Erro na conexão: ${err.message}`);
  });
});

// Servidor que escuta na porta RESPONSE_PORT para receber as respostas
const responseServer = net.createServer((socket) => {
  const clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[Resposta ${RESPONSE_PORT}] Cliente conectado (servidor de resposta):`, clientInfo);
  logMessage(`[Resposta ${RESPONSE_PORT}] Cliente conectado: ${clientInfo}`);

  // Este servidor apenas recebe e encaminha as respostas
  // Ele não processa nada, apenas recebe as conexões do servidor de escuta
  
  socket.on('data', (data) => {
    const received = data.toString();
    console.log(`[Resposta ${RESPONSE_PORT}] Dado recebido:`, received);
    logMessage(`[Resposta ${RESPONSE_PORT}] Dado recebido: ${received}`);
    // Não precisa fazer nada com os dados, pois já foram processados
  });

  socket.on('end', () => {
    console.log(`[Resposta ${RESPONSE_PORT}] Cliente desconectado:`, clientInfo);
    logMessage(`[Resposta ${RESPONSE_PORT}] Cliente desconectado: ${clientInfo}`);
  });

  socket.on('error', (err) => {
    console.error(`[Resposta ${RESPONSE_PORT}] Erro na conexão:`, err.message);
    logMessage(`[Resposta ${RESPONSE_PORT}] Erro na conexão: ${err.message}`);
  });
});

// Inicia o servidor de escuta
listenServer.listen(LISTEN_PORT, HOST, () => {
  console.log(`Servidor escutando em ${HOST}:${LISTEN_PORT}`);
  logMessage(`Servidor escutando em ${HOST}:${LISTEN_PORT}`);
});

// Inicia o servidor de resposta
responseServer.listen(RESPONSE_PORT, HOST, () => {
  console.log(`Servidor de resposta rodando em ${HOST}:${RESPONSE_PORT}`);
  logMessage(`Servidor de resposta rodando em ${HOST}:${RESPONSE_PORT}`);
  cleanOldLogs();
  setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);
});