const net = require('net');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const HL7 = require('hl7-standard');
const { format } = require('date-fns');
const { randomUUID } = require('crypto');

// Configurações do servidor Mirth (destino)
const MIRTH_HOST = process.env.MIRTH_HOST || 'localhost';
const MIRTH_PORT = process.env.MIRTH_PORT || 6661;
const DOMAIN = process.env.DOMAIN;
const TOKEN = process.env.TOKEN;

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
  const result = await response.json();
  logMessage(`Resposta do servidor:`);
  logMessage(result);
  console.log(`Resposta do servidor:`);
  console.log(result);

  if (!response.ok) {
    throw new Error(`Erro na requisição: ${response.status} - ${response.statusText}`);
  }

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

// Função para enviar mensagem HL7 para o servidor Mirth
function sendHL7Message(hl7Message) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let responseData = '';
    let isConnected = false;

    client.connect(MIRTH_PORT, MIRTH_HOST, () => {
      isConnected = true;
      console.log(`Conectado ao servidor Mirth em ${MIRTH_HOST}:${MIRTH_PORT}`);
      logMessage(`Conectado ao servidor Mirth em ${MIRTH_HOST}:${MIRTH_PORT}`);

      const START = String.fromCharCode(0x0B);
      const END = String.fromCharCode(0x1C);
      const CR = String.fromCharCode(0x0D);

      const fullMessage = START + hl7Message + END + CR;
      console.log('Mensagem formatada para envio:', fullMessage);
      logMessage(`Mensagem enviada ao servidor: ${fullMessage}`);

      client.write(fullMessage);
    });

    client.on('data', (data) => {
      const receivedData = data.toString();
      logMessage(`Dados recebidos do servidor: ${receivedData}`);
      console.log(`Dados recebidos do servidor: ${receivedData}`);
      responseData += receivedData;
    });

    client.on('end', () => {
      console.log('Conexão com o servidor finalizada pelo servidor');
      logMessage('Conexão com o servidor finalizada pelo servidor');
      
      // Processa a resposta recebida
      const cleanedResponse = responseData.replace(/[\x0B\x1C\x0D]/g, '').trim();
      logMessage(`Resposta processada: ${cleanedResponse}`);
      
      resolve(cleanedResponse);
    });

    client.on('error', (err) => {
      console.error('Erro na conexão com o servidor:', err.message);
      logMessage(`Erro na conexão com o servidor: ${err.message}`);
      
      if (!isConnected) {
        reject(new Error(`Não foi possível conectar ao servidor Mirth: ${err.message}`));
      } else {
        reject(err);
      }
    });

    // Timeout para a conexão
    const timeout = setTimeout(() => {
      if (client.writable) {
        client.destroy();
        reject(new Error('Timeout na conexão com o servidor Mirth'));
      }
    }, 30000);

    // Limpa o timeout quando a conexão termina
    client.once('close', () => {
      clearTimeout(timeout);
    });
  });
}

// Função principal para processar e enviar mensagem
async function processAndSendMessage(initialHL7Message) {
  try {
    logMessage(`Processando mensagem HL7: ${initialHL7Message}`);
    console.log(`Processando mensagem HL7: ${initialHL7Message}`);

    // Processa a mensagem HL7 (fetchAndBuildHL7 já faz a transformação e consulta)
    const processedHL7 = await fetchAndBuildHL7(initialHL7Message);
    logMessage('HL7 processado com sucesso');
    
    // Envia para o servidor Mirth
    const response = await sendHL7Message(processedHL7);
    logMessage(`Resposta do servidor Mirth: ${response}`);
    console.log(`Resposta do servidor Mirth: ${response}`);
    
    return response;
  } catch (error) {
    logMessage(`Erro no processamento: ${error.message}`);
    console.error('Erro no processamento:', error.message);
    throw error;
  }
}

// Função para ler mensagens de entrada (exemplo: arquivo ou entrada padrão)
function readInputMessage() {
  return new Promise((resolve) => {
    // Aqui você pode adaptar para ler de diferentes fontes
    // Exemplo: ler de um arquivo, entrada padrão, etc.
    
    // Para este exemplo, vamos ler da entrada padrão
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('Digite a mensagem HL7 (ou "exit" para sair):');
    rl.on('line', (input) => {
      if (input.toLowerCase() === 'exit') {
        rl.close();
        process.exit(0);
      }
      rl.close();
      resolve(input);
    });
  });
}

// Função principal para executar o cliente
async function runClient() {
  console.log(`Cliente HL7 iniciado`);
  logMessage(`Cliente HL7 iniciado`);
  
  console.log(`Servidor Mirth alvo: ${MIRTH_HOST}:${MIRTH_PORT}`);
  logMessage(`Servidor Mirth alvo: ${MIRTH_HOST}:${MIRTH_PORT}`);
  
  // Limpa logs antigos
  cleanOldLogs();
  setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);

  // Exemplo de uso - loop principal
  while (true) {
    try {
      // Lê a mensagem de entrada
      const inputMessage = await readInputMessage();
      
      if (inputMessage) {
        // Processa e envia a mensagem
        const response = await processAndSendMessage(inputMessage);
        console.log('Processamento concluído com sucesso!');
        console.log('Resposta:', response);
      }
    } catch (error) {
      console.error('Erro no processamento:', error.message);
      // Aguarda um pouco antes de tentar novamente
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Executa o cliente
runClient().catch((error) => {
  console.error('Erro fatal no cliente:', error.message);
  logMessage(`Erro fatal no cliente: ${error.message}`);
  process.exit(1);
});