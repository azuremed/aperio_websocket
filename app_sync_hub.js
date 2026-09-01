const net = require('net');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { format } = require('date-fns');
const { randomUUID } = require('crypto');

// Configurações de ambiente
const PORT = process.env.PORT || 3000; // Porta onde este servidor escuta
const HOST = process.env.HOST || '0.0.0.0';
const SYNC_HUB_IP = process.env.SYNC_HUB_IP || '127.0.0.1';
const SYNC_HUB_PORT = process.env.SYNC_HUB_PORT || 6661;
const DOMAIN = process.env.DOMAIN;
const TOKEN = process.env.TOKEN;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS) || 30000; // 30 segundos

const appDir = process.pkg
    ? path.dirname(process.execPath)
    : __dirname;

const logDir = path.join(appDir, 'logs');

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// Funções de log
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

// Função para extrair mensagem HL7 do MLLP
const extractHL7FromMLLP = (buffer) => {
    // Remove caracteres MLLP (0x0B no início, 0x1C 0x0D no final)
    let message = buffer.toString('utf8');
    // Remove caracteres de controle MLLP
    message = message.replace(/[\x0B\x1C\x0D]/g, '');
    // Remove caracteres de escape desnecessários
    message = message.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    return message.trim();
};

// Função para encapsular mensagem em MLLP
const wrapInMLLP = (message) => {
    const START = String.fromCharCode(0x0B);
    const END = String.fromCharCode(0x1C);
    const CR = String.fromCharCode(0x0D);
    return START + message + END + CR;
};

// Função para parsear nome completo
const parseFullName = (fullName) => {
    if (!fullName) return { firstName: '', lastName: '' };
    const parts = fullName.trim().split(' ');
    if (parts.length === 1) {
        return { firstName: parts[0], lastName: '' };
    }
    return {
        firstName: parts[0],
        lastName: parts.slice(1).join(' ')
    };
};

// Função principal: consultar API e construir HL7
async function fetchAndBuildHL7(originalHL7Message) {
    const now = new Date();
    const formattedDate = format(now, 'yyyyMMddHHmmss');

    logMessage('=== Iniciando construção da mensagem HL7 ===');
    
    try {
        // Extrair o ID da amostra do OBR.4
        const lines = originalHL7Message.split(/\r?\n/);
        let sampleId = null;
        let pidData = {};
        let pv1Data = {};

        // Primeiro, vamos extrair informações existentes para preservar
        for (const line of lines) {
            if (line.startsWith('OBR|')) {
                const fields = line.split('|');
                if (fields.length > 4) {
                    sampleId = fields[4];
                    logMessage(`ID da amostra extraído do OBR.4: ${sampleId}`);
                }
            }
            // Extrair dados PID se existirem
            if (line.startsWith('PID|')) {
                const fields = line.split('|');
                if (fields.length > 5) {
                    pidData.patientId = fields[3] || '';
                }
                if (fields.length > 7) {
                    const nameParts = (fields[5] || '').split('^');
                    pidData.firstName = nameParts[1] || '';
                    pidData.lastName = nameParts[0] || '';
                }
                if (fields.length > 10) {
                    pidData.birthDate = fields[7] || '';
                }
                if (fields.length > 11) {
                    pidData.gender = fields[8] || '';
                }
            }
        }

        if (!sampleId) {
            throw new Error('ID da amostra não encontrado no campo OBR.4');
        }

        logMessage(`Buscando dados para amostra: ${sampleId}`);
        
        // Consultar API Klingo
        const url = `https://api-externa.klingo.app/api/aperio/consulta/${DOMAIN}/${TOKEN}/${sampleId}`;
        logMessage(`Requisitando endpoint: ${url}`);
        console.log(`Requisitando endpoint: ${url}`);

        const response = await fetch(url);
        const result = await response.json();
        logMessage(`Resposta da API: ${JSON.stringify(result)}`);
        console.log(`Resposta da API:`, result);

        if (!response.ok) {
            throw new Error(`Erro na requisição: ${response.status} - ${response.statusText}`);
        }

        const record = result;

        if (!record || Object.keys(record).length === 0) {
            throw new Error('Nenhum registro encontrado para o ID fornecido.');
        }

        logMessage('Dados recuperados com sucesso!');

        // Processar dados da API
        const patientName = parseFullName(record.pac_nome || '');
        const doctorName = parseFullName(record.psv_nome || '');
        const doctorCRM = (record.psv_uf || '') + (record.psv_crm || '');
        const patientGender = record.pac_sexo || 'U';
        const patientBirthDate = record.pac_nasc ? format(new Date(record.pac_nasc), 'yyyyMMdd') : '';

        // Construir nova mensagem HL7
        let hl7Segments = [];

        // MSH Segment
        hl7Segments.push(`MSH|^~\\&|${process.env.LIS_NAME || 'LIS'}|${process.env.LIS_FACILITY || 'FACILITY'}|LBS|${process.env.SYSTEM_HIERARCHY || 'CH'}|${formattedDate}|${process.env.DATA_GROUP || 'Default'}|OML^O21|${randomUUID()}|P|2.5.1`);

        // PID Segment
        const pidFields = [
            'PID',
            '',
            record.pac_reg?.toString() || pidData.patientId || '',
            '',
            `${patientName.lastName || pidData.lastName}^${patientName.firstName || pidData.firstName}`,
            '',
            '',
            patientBirthDate || pidData.birthDate || '',
            patientGender || pidData.gender || 'U'
        ];
        // Adicionar campos vazios até o comprimento mínimo
        while (pidFields.length < 12) {
            pidFields.push('');
        }
        hl7Segments.push(pidFields.join('|'));

        // PV1 Segment
        const pv1Fields = [
            'PV1',
            '',
            '',
            '',
            '',
            '',
            `${doctorCRM}^${doctorName.lastName}^${doctorName.firstName}^^Dr^${doctorCRM}`,
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            ''
        ];
        hl7Segments.push(pv1Fields.join('|'));

        // ORC Segment
        hl7Segments.push(`ORC|NW|${sampleId}|||CM|||${formattedDate}`);

        // SAC Segment
        hl7Segments.push(`SAC|${sampleId}|${record.smm_amostra || ''}`);

        // SPM Segment
        const spmFields = [
            'SPM',
            '1',
            sampleId,
            '',
            '',
            '',
            '',
            record.smm_orgao || '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            record.smm_dthr_coleta ? format(new Date(record.smm_dthr_coleta), 'yyyyMMddHHmmss') : '',
            record.smm_dthr_coleta ? format(new Date(record.smm_dthr_coleta), 'yyyyMMddHHmmss') : ''
        ];
        hl7Segments.push(spmFields.join('|'));

        // ZBL Segment (Block)
        const blockId = record.smm_bloco || `${sampleId}.A`;
        hl7Segments.push(`ZBL|${blockId}`);

        // OBR Segment (Slide)
        hl7Segments.push(`OBR|1||${sampleId}`);

        // OBX Segment (Magnification)
        hl7Segments.push(`OBX|1|ST|MAG||40`);

        // OBX Segment (Stain)
        hl7Segments.push(`OBX|2|ST|STN||${record.smm_corante || 'H&E'}`);

        // NTE Segment (Comments)
        if (record.smm_obs) {
            hl7Segments.push(`NTE|1|${record.smm_obs}|C`);
        }

        // Montar mensagem final
        const finalHL7 = hl7Segments.join('\r');
        
        logMessage(`Mensagem HL7 montada com sucesso`);
        logMessage(`HL7: ${finalHL7}`);

        return finalHL7;

    } catch (error) {
        logMessage(`Erro ao processar HL7: ${error.message}`);
        console.error('Erro ao processar HL7:', error);
        throw error;
    }
}

// Função para enviar mensagem ao Sync Hub e aguardar resposta
const sendToSyncHub = async (hl7Message) => {
    return new Promise((resolve, reject) => {
        logMessage(`=== Conectando ao Sync Hub ${SYNC_HUB_IP}:${SYNC_HUB_PORT} ===`);
        console.log(`Conectando ao Sync Hub ${SYNC_HUB_IP}:${SYNC_HUB_PORT}`);

        const client = new net.Socket();
        let responseData = '';
        let timeoutId = null;

        // Configurar timeout
        timeoutId = setTimeout(() => {
            client.destroy();
            reject(new Error(`Timeout ao aguardar resposta do Sync Hub (${TIMEOUT_MS}ms)`));
        }, TIMEOUT_MS);

        client.connect(SYNC_HUB_PORT, SYNC_HUB_IP, () => {
            logMessage(`Conectado ao Sync Hub com sucesso`);
            
            // Encapsular em MLLP
            const mllpMessage = wrapInMLLP(hl7Message);
            logMessage(`Enviando mensagem MLLP para Sync Hub (${mllpMessage.length} bytes)`);
            console.log(`Mensagem MLLP enviada:`, mllpMessage);

            client.write(mllpMessage);
        });

        // Receber dados do Sync Hub
        client.on('data', (data) => {
            const received = data.toString();
            logMessage(`Dados recebidos do Sync Hub: ${received}`);
            console.log(`Dados recebidos do Sync Hub:`, received);
            responseData += received;
        });

        client.on('close', () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            
            if (responseData) {
                logMessage(`Conexão com Sync Hub fechada. Resposta recebida.`);
                // Extrair ACK da resposta MLLP
                const ackMessage = extractHL7FromMLLP(responseData);
                resolve(ackMessage);
            } else {
                logMessage(`Conexão com Sync Hub fechada sem resposta.`);
                reject(new Error('Sync Hub não respondeu com ACK'));
            }
        });

        client.on('error', (err) => {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            logMessage(`Erro na conexão com Sync Hub: ${err.message}`);
            console.error('Erro na conexão com Sync Hub:', err.message);
            reject(err);
        });
    });
};

// Servidor TCP principal
const server = net.createServer((socket) => {
    const clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log('Cliente conectado:', clientInfo);
    logMessage(`Cliente conectado: ${clientInfo}`);

    let receivedData = '';

    socket.on('data', async (data) => {
        try {
            // Acumular dados recebidos
            receivedData += data.toString();
            
            // Processar apenas se tiver uma mensagem completa (termina com 0x1C 0x0D)
            if (receivedData.includes('\x1C\x0D')) {
                logMessage(`Dados brutos recebidos do cliente: ${receivedData}`);
                
                // Extrair mensagem HL7 do MLLP
                const originalHL7 = extractHL7FromMLLP(receivedData);
                logMessage(`Mensagem HL7 extraída do MLLP: ${originalHL7}`);
                console.log(`Mensagem HL7 recebida:`, originalHL7);

                try {
                    // 1. Construir nova mensagem HL7 com dados da API
                    logMessage('Passo 1: Construindo mensagem HL7 com dados da API...');
                    const newHL7Message = await fetchAndBuildHL7(originalHL7);
                    
                    // 2. Enviar para o Sync Hub
                    logMessage('Passo 2: Enviando mensagem para o Sync Hub...');
                    const syncHubResponse = await sendToSyncHub(newHL7Message);
                    
                    // 3. Gerar ACK para o cliente
                    let ackMessage;
                    if (syncHubResponse && syncHubResponse.includes('MSA')) {
                        // Usar ACK recebido do Sync Hub
                        logMessage('Passo 3a: Usando ACK recebido do Sync Hub');
                        ackMessage = syncHubResponse;
                    } else {
                        // Gerar ACK local
                        logMessage('Passo 3b: Gerando ACK local');
                        const now = new Date();
                        const timestamp = format(now, 'yyyyMMddHHmmss');
                        const messageId = randomUUID();
                        const ackSegments = [
                            `MSH|^~\\&|LBS|${process.env.SYSTEM_HIERARCHY || 'CH'}|${process.env.LIS_NAME || 'LIS'}|${timestamp}|${process.env.DATA_GROUP || 'Default'}|ACK^O21|${messageId}|P|2.5.1`,
                            `MSA|AA|${messageId}|Mensagem processada com sucesso pelo proxy`
                        ];
                        ackMessage = ackSegments.join('\r');
                    }

                    // 4. Encapsular em MLLP e enviar ao cliente
                    const mllpResponse = wrapInMLLP(ackMessage);
                    logMessage(`Enviando resposta MLLP ao cliente (${mllpResponse.length} bytes)`);
                    console.log(`Resposta para o cliente:`, ackMessage);

                    socket.write(mllpResponse, () => {
                        logMessage('Resposta enviada ao cliente com sucesso');
                        console.log('Resposta enviada ao cliente com sucesso');
                        socket.end();
                    });

                } catch (error) {
                    logMessage(`Erro no processamento: ${error.message}`);
                    console.error('Erro no processamento:', error);
                    
                    // Enviar NACK para o cliente
                    const nackMessage = generateNACK(error.message);
                    const mllpNack = wrapInMLLP(nackMessage);
                    socket.write(mllpNack, () => {
                        logMessage('NACK enviado ao cliente');
                        socket.end();
                    });
                }
            }
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

// Função para gerar NACK
const generateNACK = (errorMessage) => {
    const now = new Date();
    const timestamp = format(now, 'yyyyMMddHHmmss');
    const messageId = randomUUID();
    return [
        `MSH|^~\\&|LBS|${process.env.SYSTEM_HIERARCHY || 'CH'}|${process.env.LIS_NAME || 'LIS'}|${timestamp}|${process.env.DATA_GROUP || 'Default'}|ACK^O21|${messageId}|P|2.5.1`,
        `MSA|AE|${messageId}|${errorMessage}`
    ].join('\r');
};

// Iniciar servidor
server.listen(PORT, HOST, () => {
    console.log(`Servidor Proxy TCP rodando em ${HOST}:${PORT}`);
    console.log(`Sync Hub configurado em ${SYNC_HUB_IP}:${SYNC_HUB_PORT}`);
    console.log(`Timeout configurado: ${TIMEOUT_MS}ms`);
    logMessage(`=== SERVIDOR INICIADO ===`);
    logMessage(`Servidor proxy TCP rodando em ${HOST}:${PORT}`);
    logMessage(`Sync Hub configurado em ${SYNC_HUB_IP}:${SYNC_HUB_PORT}`);
    logMessage(`Timeout configurado: ${TIMEOUT_MS}ms`);
    cleanOldLogs();
    setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);
});

// Tratamento de erros não capturados
process.on('uncaughtException', (err) => {
    logMessage(`Erro não capturado: ${err.message}`);
    console.error('Erro não capturado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    logMessage(`Promessa rejeitada não tratada: ${reason}`);
    console.error('Promessa rejeitada não tratada:', reason);
});