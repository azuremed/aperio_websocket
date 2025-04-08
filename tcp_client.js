const HL7 = require('hl7-standard/src/api');
const net = require('net');
require('dotenv').config(); 

// Texto a ser enviado
const message = `MSH|^~\\&|ESM||LIS||20240816115408871||OUL^R21|97e24704-672c-4abe-89f2-829faa6e8eb7|P|2.5.1\nORC|RE\nOBR||||01332467610\nOBX|1|ST|URL|SLIDE|https://patologiadigital.com.br/view/v2/LApi.Slide/1800179333010B||||||F\nOBX|3|ST|DATE|SCANNED|20240816114404000||||||F\nOBX|4|ST|MAG|SCAN|40||||||F\nOBX|5|ST|SCANSCOPEID||SS12175||||||F`;

const options = {
  host: '127.0.0.1',
  port: 12345
};


// Cria um cliente TCP
const client = new net.Socket();

// Conecta ao servidor
client.connect(options, () => {
  console.log('Conectado ao servidor');
  client.write(message); // Envia a mensagem
  console.log('Mensagem enviada');
});

// Lida com dados recebidos do servidor
client.on('data', (data) => {
  console.log('Resposta do servidor:', data.toString());
  client.destroy(); // Fecha a conexão após receber a resposta
});

// Lida com o encerramento da conexão
client.on('close', () => {
  console.log('Conexão encerrada');
});

// Lida com erros
client.on('error', (err) => {
  console.error('Erro:', err.message);
});
