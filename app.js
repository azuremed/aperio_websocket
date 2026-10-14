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

// Nova porta para onde enviar o HL7 enriquecido
const OUTPUT_PORT = process.env.OUTPUT_PORT || 44390;
const OUTPUT_HOST = process.env.OUTPUT_HOST || '127.0.0.1';

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

/**
 * ============================================================
 * ENVIA HL7 PARA A PORTA DESTINO
 * ============================================================
 */
function sendHL7ToOutput(hl7Message, clientInfo) {
  return new Promise((resolve, reject) => {
    const START = String.fromCharCode(0x0B);
    const END = String.fromCharCode(0x1C);
    const CR = String.fromCharCode(0x0D);

    const fullMessage = START + hl7Message + END + CR;

    console.log(`Enviando HL7 enriquecido para ${OUTPUT_HOST}:${OUTPUT_PORT}`);

    const client = new net.Socket();

    const timeout = setTimeout(() => {
      client.destroy();
      const error = new Error('Timeout ao conectar ao destino');
      logMessage(`Timeout ao enviar HL7: ${error.message}`);
      reject(error);
    }, 10000);

    client.connect(OUTPUT_PORT, OUTPUT_HOST, () => {
      clearTimeout(timeout);
      logMessage(`Conectado ao destino ${OUTPUT_HOST}:${OUTPUT_PORT}`);

      client.write(fullMessage, (error) => {
        if (error) {
          logMessage(`Erro ao enviar HL7 para destino: ${error.message}`);
          reject(error);
        } else {
          logMessage(`HL7 enriquecido enviado com sucesso para ${OUTPUT_HOST}:${OUTPUT_PORT}`);
          console.log(`HL7 enriquecido enviado com sucesso para ${OUTPUT_HOST}:${OUTPUT_PORT}`);
          resolve();
        }
      });
    });

    client.on('error', (error) => {
      clearTimeout(timeout);
      logMessage(`Erro no cliente de saída: ${error.message}`);
      reject(error);
    });

    let responseBuffer = '';
    client.on('data', (data) => {
      responseBuffer += data.toString('utf8');
      logMessage(`Resposta do destino: ${responseBuffer}`);

      if (responseBuffer.includes('MSA')) {
        client.destroy();
      }
    });

    client.on('close', () => {
      clearTimeout(timeout);
      logMessage(`Conexão com destino fechada`);
    });
  });
}

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
    logMessage(`API retornou erro: ${response.status} ${response.statusText}`);
    return {
      success: false,
      error: `Erro na API externa: ${response.status} ${response.statusText}`
    };
  }

  logMessage(`Status da resposta: ${response.status}`);
  logMessage(`Conteúdo bruto recebido: ${responseText}`);
  console.log(`Conteúdo bruto recebido: ${responseText}`);

  const record = JSON.parse(responseText);

  if (!record) {
    return {
      success: false,
      error: 'Nenhum registro encontrado para o ID fornecido.'
    };
  }

  logMessage('Dados recuperados com sucesso!');

  const patientName = record.pac_nome?.trim() ?? '';
  const patientNameSplited = patientName.split(' ');
  const lastName = patientNameSplited.length > 1 ? patientNameSplited.pop() : '';
  const firstName = patientNameSplited.join(' ');

  const doctorName = record.psv_nome?.trim() ?? '';
  const doctorNameSplited = doctorName.split(' ');
  const docLastName = doctorNameSplited.length > 1 ? doctorNameSplited.pop() : '';
  const docFirstName = doctorNameSplited.join(' ');

  const doctorCRM = (record.psv_uf || '') + (record.psv_crm || '');
  const patientGender = record.pac_sexo ?? 'U';

  const dthrColeta = record.smm_dthr_coleta
    ? format(new Date(record.smm_dthr_coleta), 'yyyyMMddHHmmss')
    : formattedDate;

  const segmentsToDelete = ['ORC', 'OBR', 'OBX', 'PID', 'PV1', 'SAC', 'SPM', 'ZBL', 'NTE'];
  for (const segment of hl7.getSegments()) {
    if (segmentsToDelete.includes(segment.type)) {
      hl7.deleteSegment(segment);
    }
  }

  logMessage('Segmentos antigos removidos');

  hl7.set('MSH.3', record.sending_app || 'LIMS');
  hl7.set('MSH.5', record.receiving_app || 'LEICA');
  hl7.set('MSH.6', record.receiving_facility || 'CH');
  hl7.set('MSH.7.1', formattedDate);
  hl7.set('MSH.8', record.security || 'Default');
  hl7.set('MSH.9.1', 'OML');
  hl7.set('MSH.9.2', '021');
  hl7.set('MSH.10', randomUUID());
  hl7.set('MSH.11', 'P');
  hl7.set('MSH.12', '2.5.1');

  hl7.createSegment('PID');
  hl7.set('PID.3.1', `${record.pac_reg ?? ''}^^^^MR`);
  hl7.set('PID.5.1', lastName);
  hl7.set('PID.5.2', firstName);
  hl7.set('PID.7', record.pac_nasc ? format(new Date(record.pac_nasc), 'yyyyMMdd') : '');
  hl7.set('PID.8', patientGender);
  hl7.set('PID.23', 'U');

  hl7.createSegment('PV1');
  hl7.set('PV1.3.1', record.pv1_location ?? '^^^NYP');
  if (doctorCRM || docLastName || docFirstName) {
    hl7.set('PV1.7.1', doctorCRM);
    hl7.set('PV1.7.2', docLastName);
    hl7.set('PV1.7.3', docFirstName);
    hl7.set('PV1.7.6', 'Dr');
  }

  hl7.createSegment('ORC');
  hl7.set('ORC.1', 'NW');

  hl7.createSegment('SAC');
  hl7.set('SAC.1', record.osm_num?.toString() ?? record.case_id ?? '');

  if (record.patient_notes && Array.isArray(record.patient_notes)) {
    record.patient_notes.forEach((note, idx) => {
      const nteSeg = hl7.createSegment('NTE');
      nteSeg.set('NTE.1', idx + 1);
      nteSeg.set('NTE.3', note.text || note);
      nteSeg.set('NTE.4', note.type || 'C');
    });
  }

  const spmSeg = hl7.createSegment('SPM');
  const specId = record.smm_cod_amostra?.toString() ?? record.specimen_id ?? '';
  spmSeg.set('SPM.1', '1');
  spmSeg.set('SPM.2.1', specId + "0");
  spmSeg.set('SPM.7.1', record.specimen_type || 'Laparoscopic');
  spmSeg.set('SPM.8.1', record.organ_site || 'Liver');
  spmSeg.set('SPM.17.1', dthrColeta);
  spmSeg.set('SPM.18.1', dthrColeta);

  if (record.specimen_note) {
    const nteSpm = hl7.createSegment('NTE');
    nteSpm.set('NTE.1', '1');
    nteSpm.set('NTE.3', record.specimen_note);
    nteSpm.set('NTE.4', 'C');
  }

  const zblSeg = hl7.createSegment('ZBL');
  const blockId = record.zbl || `${specId}.A`;
  zblSeg.set('ZBL.1', blockId);

  const obrSeg = hl7.createSegment('OBR');
  const slideId = id_amostra?.toString() ?? `${blockId}.1`;
  obrSeg.set('OBR.1', '1');
  obrSeg.set('OBR.4.1', slideId);

  const obxList = record.obx_fields || [
    { type: 'TX', key: 'MAG', val: record.magnification || '40' },
    { type: 'TX', key: 'STN', val: record.stain || 'PAS^Periodic Acid Stain' },
    { type: 'TX', key: 'Custom^Case', subKey: 'PatientHobbies', val: record.patient_hobbies || '' },
    { type: 'TX', key: 'Custom^Specimen', subKey: 'RiskCode', val: record.risk_code || '' },
    { type: 'TX', key: 'Custom^Block', subKey: 'Block_SlideNumber', val: record.block_slide_num || '' },
    { type: 'TX', key: 'Custom^Slide', subKey: 'ScarType', val: record.scar_type || '' },
  ];

  let obxSeq = 1;
  obxList.forEach((obx) => {
    if (!obx.val) return;
    const obxSeg = hl7.createSegment('OBX');
    obxSeg.set('OBX.1', obxSeq++);
    obxSeg.set('OBX.2', obx.type || 'TX');
    obxSeg.set('OBX.3.1', obx.key);
    if (obx.subKey) {
      obxSeg.set('OBX.4', obx.subKey);
    }
    obxSeg.set('OBX.5', obx.val);
  });

  if (record.slide_note) {
    const nteObr = hl7.createSegment('NTE');
    nteObr.set('NTE.1', '1');
    nteObr.set('NTE.3', record.slide_note);
    nteObr.set('NTE.4', 'C');
  }

  const responseHl7 = await hl7.build();
  logMessage('HL7 montado com sucesso');

  return responseHl7;
}

function buildErrorResponse(error) {
  const START = String.fromCharCode(0x0B);
  const END = String.fromCharCode(0x1C);
  const CR = String.fromCharCode(0x0D);

  const errorResponse =
    `MSH|^~\\&|LEICA|CH||${format(new Date(), 'yyyyMMddHHmmss')}||ACK^021|${randomUUID()}|P|2.5.1\r` +
    `MSA|AE||${error.message}\r`;

  return START + errorResponse + END + CR;
}

function sendResponse(socket, message) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      return reject(new Error('Socket já foi encerrado.'));
    }

    socket.write(message, (error) => {
      if (error) {
        logMessage(`Erro ao escrever no socket: ${error.message}`);
        reject(error);
        return;
      }

      logMessage('Resposta enviada com sucesso');
      resolve();
    });
  });
}

/**
 * ============================================================
 * PROCESSA UMA MENSAGEM HL7
 * ============================================================
 */
async function processHL7Message(socket, hl7Message, clientInfo) {
  try {
    logMessage(`Processando mensagem HL7 do cliente ${clientInfo}`);
    console.log('Mensagem HL7 recebida:', hl7Message);

    // ============================================================
    // VALIDAÇÃO: Ignorar mensagens de retorno do Mirth (ex: OUL^R21, ACK, etc.)
    // ============================================================
    const mshSegment = hl7Message.split('\r')[0];
    const messageTypeMatch = mshSegment?.match(/MSH\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|([^|^~]*[\^]?[^|]*)/);
    const messageType = messageTypeMatch ? messageTypeMatch[1] : '';

    // Se o tipo de mensagem for OUL^R21 ou começar com ACK, tratamos apenas como retorno/confirmação
    if (messageType.includes('OUL^R21') || messageType.startsWith('ACK')) {
      logMessage(`Mensagem de retorno/confirmação ignorada (${messageType}). Nenhuma ação necessária.`);
      console.log(`Mensagem de retorno/confirmação ignorada (${messageType}).`);
      return;
    }

    const hl7Response = await fetchAndBuildHL7(hl7Message);

    if (hl7Response && hl7Response.success === false) {
      throw new Error(hl7Response.error);
    }

    logMessage('HL7 processado com sucesso');

    try {
      await sendHL7ToOutput(hl7Response, clientInfo);
      logMessage('HL7 enriquecido enviado para a porta de saída com sucesso');
    } catch (outputError) {
      logMessage(`Erro ao enviar HL7 para porta de saída: ${outputError.message}`);
      console.error('Erro ao enviar HL7 para porta de saída:', outputError.message);
    }

    const START = String.fromCharCode(0x0B);
    const END = String.fromCharCode(0x1C);
    const CR = String.fromCharCode(0x0D);

    const ackMessage = `MSH|^~\\&|LEICA|CH||${format(new Date(), 'yyyyMMddHHmmss')}||ACK^021|${randomUUID()}|P|2.5.1\r` +
      `MSA|AA|${hl7Message.match(/MSH\|.*\|([^\|]*?)\|/)?.[1] || 'N/A'}\r`;

    const fullMessage = START + ackMessage + END + CR;

    await sendResponse(socket, fullMessage);
    console.log('Mensagem enviada ao Mirth com sucesso.');
    logMessage('Mensagem enviada ao Mirth com sucesso.');

  } catch (error) {
    logMessage(`Erro no processamento: ${error.message}`);
    console.error('Erro no processamento:', error.message);

    try {
      const fullErrorMessage = buildErrorResponse(error);
      await sendResponse(socket, fullErrorMessage);
      logMessage('Resposta de erro enviada ao Mirth.');
    } catch (sendError) {
      logMessage(`Erro ao enviar resposta de erro: ${sendError.message}`);
      console.error('Erro ao enviar resposta de erro:', sendError);
    }
  }
}

/**
 * ============================================================
 * SERVIDOR TCP / MLLP
 * ============================================================
 */
const server = net.createServer((socket) => {
  socket.setKeepAlive(true, 30000);
  socket.setTimeout(0);

  const clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;

  console.log('Cliente conectado:', clientInfo);
  logMessage(`Cliente conectado: ${clientInfo}`);

  let buffer = '';
  let processing = Promise.resolve();

  socket.on('data', (data) => {
    try {
      const receivedData = data.toString('utf8');
      buffer += receivedData;

      const START = String.fromCharCode(0x0B);
      const END = String.fromCharCode(0x1C);

      while (true) {
        const startIndex = buffer.indexOf(START);

        if (startIndex === -1) {
          if (buffer.length > 0) {
            buffer = '';
          }
          break;
        }

        if (startIndex > 0) {
          buffer = buffer.substring(startIndex);
        }

        const endIndex = buffer.indexOf(END, 1);

        if (endIndex === -1) {
          break;
        }

        let hl7Message = buffer.substring(1, endIndex);
        buffer = buffer.substring(endIndex + 1);

        if (buffer.startsWith(String.fromCharCode(0x0D))) {
          buffer = buffer.substring(1);
        }

        hl7Message = hl7Message
          .replace(/\r\n/g, '\r')
          .replace(/\n/g, '\r');

        if (!hl7Message.trim()) {
          continue;
        }

        processing = processing
          .then(() => {
            if (socket.destroyed) {
              return;
            }
            return processHL7Message(socket, hl7Message, clientInfo);
          })
          .catch((error) => {
            logMessage(`Erro inesperado na fila: ${error.message}`);
            console.error('Erro inesperado na fila:', error);
          });
      }
    } catch (error) {
      logMessage(`Erro ao receber dados: ${error.message}`);
      console.error('Erro ao receber dados:', error);
    }
  });

  socket.on('end', () => {
    console.log('Cliente desconectou (end):', clientInfo);
    logMessage(`Cliente desconectou (end): ${clientInfo}`);
  });

  socket.on('close', (hadError) => {
    console.log(`Socket fechado (close): ${clientInfo}, hadError: ${hadError}`);
    logMessage(`Socket fechado (close): ${clientInfo}, hadError: ${hadError}`);
  });

  socket.on('error', (err) => {
    console.error('Erro na conexão:', err.message, clientInfo);
    logMessage(`Erro na conexão: ${err.message} ${clientInfo}`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Servidor TCP rodando em ${HOST}:${PORT}`);
  logMessage(`Servidor TCP iniciado em ${HOST}:${PORT}`);
  cleanOldLogs();
  setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);
});

server.on('error', (err) => {
  console.error('Erro no servidor:', err);
  logMessage(`Erro no servidor: ${err.message}`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  server.close(() => {
    process.exit(0);
  });
});