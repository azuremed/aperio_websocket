const net = require('net');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const HL7 = require('hl7-standard');
const { format } = require('date-fns');
const { randomUUID } = require('crypto');

const PORT = process.env.WEBSOCKET_PORT || 3000;
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

  if (!response.ok) {
    throw new Error(`Erro na requisição: ${response.status} - ${response.statusText}`);
  }


  logMessage(`Status da resposta: ${response.status}`);
  logMessage(`Conteúdo bruto recebido: ${responseText}`);
  console.log(`Conteúdo bruto recebido: ${responseText}`);

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

  // logMessage(`Erro ao processar HL7: ${err.message}`);
  // console.error('Erro ao processar ou transformar a mensagem HL7:', err);
  // // throw new Error(`Erro ao processar HL7: ${err.message}`);

}

const server = net.createServer((socket) => {
  const clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log('Cliente conectado:', clientInfo);
  logMessage(`Cliente conectado: ${clientInfo}`);

  socket.on('data', async (data) => {
    try {
      const receivedData = data.toString();
      logMessage(`Dados brutos recebidos: ${receivedData}`);

      const messages = receivedData.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

      let hl7Message = null;

      messages.forEach((message) => {
        if (message.trim()) {
          logMessage(`Mensagem recebida: ${message}`);
          if (hl7Message == null) {
            message = message.replace(/[\x0B]/g, '');
            hl7Message = message;
          } else {
            hl7Message = hl7Message + '\n' + message;
          }
        }
      });

      console.log('Mensagem HL7 recebida:', hl7Message);
      logMessage(`Mensagem HL7 completa: ${hl7Message}`);

      const hl7Response = await fetchAndBuildHL7(hl7Message);

      logMessage(`HL7 processado com sucesso`);

      const START = String.fromCharCode(0x0B);
      const END = String.fromCharCode(0x1C);
      const CR = String.fromCharCode(0x0D);

      const fullMessage = START + hl7Response + END + CR;
      console.log('Mensagem formatada para envio:', fullMessage);
      logMessage(`Mensagem enviada ao cliente: ${fullMessage}`);

      socket.write(fullMessage, () => {
        console.log('Mensagem enviada ao Mirth com sucesso.');
        logMessage('Mensagem enviada ao Mirth com sucesso.');
        socket.end();
      });

    } catch (error) {
      logMessage(`Erro no processamento: ${error.message}`);
      console.error('Erro no processamento:', error.message);
      socket.write('Erro ao processar a mensagem', () => socket.end());
    }
  });

  socket.on('end', () => {
    console.log('Cliente desconectado:', clientInfo);
    logMessage(`Cliente desconectado: ${clientInfo}`);
  });

  socket.on('error', (err) => {
    console.error('Erro na conexão:', err.message);
    logMessage(`Erro na conexão: ${err.message}`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Servidor TCP rodando em ${HOST}:${PORT}`);
  logMessage(`Servidor TCP iniciado em ${HOST}:${PORT}`);
  cleanOldLogs();
  setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);
});