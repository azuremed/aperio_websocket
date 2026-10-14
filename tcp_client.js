socket.on('data', (data) => {
  try {
    const receivedData = data.toString('utf8');

    logMessage(`Dados brutos recebidos: ${JSON.stringify(receivedData)}`);
    console.log(`Dados recebidos de ${clientInfo}:`, JSON.stringify(receivedData));

    buffer += receivedData;

    const START = String.fromCharCode(0x0B);
    const END   = String.fromCharCode(0x1C);
    const CR    = String.fromCharCode(0x0D);

    // ============================================================
    // MODO 1 — MLLP padrão (com 0x0B ... 0x1C 0x0D)
    // ============================================================
    while (true) {
      const startIndex = buffer.indexOf(START);

      if (startIndex === -1) {
        // ⬇️ FALLBACK: se não tem MLLP, tenta tratar como mensagem "crua"
        //    que começa com "MSH|"
        const mshIndex = buffer.indexOf('MSH|');
        if (mshIndex !== -1) {
          // Procura fim de segmento (\r ou \n)
          const hasCR = buffer.includes(CR);
          const hasLF = buffer.includes('\n');

          if (hasCR || hasLF) {
            logMessage('Fallback: mensagem sem MLLP detectada.');

            let raw = buffer.substring(mshIndex);
            raw = raw.replace(/\r\n/g, '\r').replace(/\n/g, '\r');

            // Se termina com \r, removemos o último (só o separador)
            if (raw.endsWith('\r')) raw = raw.slice(0, -1);

            buffer = '';

            if (raw.trim()) {
              console.log('Mensagem HL7 (fallback) extraída:', raw);
              logMessage(`Mensagem HL7 (fallback) extraída: ${raw}`);

              processing = processing
                .then(() => {
                  if (socket.destroyed) {
                    logMessage(`Socket destruído, ignorando: ${clientInfo}`);
                    return;
                  }
                  return processHL7Message(socket, raw, clientInfo);
                })
                .catch((error) => {
                  logMessage(`Erro inesperado na fila: ${error.message}`);
                  console.error('Erro inesperado na fila:', error);
                });
            }
          }
        } else if (buffer.length > 0) {
          // Nada útil no buffer → limpa
          logMessage('Nenhum START MLLP nem MSH encontrado. Limpando buffer.');
          buffer = '';
        }

        break;
      }

      // Remove lixo antes do START
      if (startIndex > 0) {
        logMessage(`Descartando ${startIndex} bytes antes do START MLLP.`);
        buffer = buffer.substring(startIndex);
      }

      const endIndex = buffer.indexOf(END, 1);
      if (endIndex === -1) break; // mensagem incompleta, aguarda próximo data

      let hl7Message = buffer.substring(1, endIndex);
      buffer = buffer.substring(endIndex + 1);

      if (buffer.startsWith(CR)) buffer = buffer.substring(1);

      hl7Message = hl7Message.replace(/\r\n/g, '\r').replace(/\n/g, '\r');

      if (!hl7Message.trim()) {
        logMessage('Mensagem HL7 vazia ignorada.');
        continue;
      }

      console.log('Mensagem HL7 extraída:', hl7Message);
      logMessage(`Mensagem HL7 extraída do frame: ${hl7Message}`);

      processing = processing
        .then(() => {
          if (socket.destroyed) {
            logMessage(`Socket já foi destruído, ignorando: ${clientInfo}`);
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