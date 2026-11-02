/**
 * Decodificador de SSE tolerante a fragmentação.
 *
 * O gateway transmite SSE; os pedaços podem chegar cortados no meio de uma
 * linha, de um JSON ou de um par de CRLF. Este parser guarda o resto no buffer
 * e só entrega eventos completos.
 */
export function createSseParser() {
  let buffer = '';

  function parseFrame(frame) {
    const lines = frame.split(/\r?\n/);
    let event = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (!dataLines.length) return null;
    return { event, data: dataLines.join('\n') };
  }

  return {
    push(chunk) {
      buffer += chunk;
      const events = [];
      let match = buffer.match(/\r?\n\r?\n/);
      while (match && match.index !== undefined) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseFrame(frame);
        if (parsed) events.push(parsed);
        match = buffer.match(/\r?\n\r?\n/);
      }
      return events;
    },
    flush() {
      if (!buffer.trim()) {
        buffer = '';
        return [];
      }
      const parsed = parseFrame(buffer);
      buffer = '';
      return parsed ? [parsed] : [];
    },
    get pending() {
      return buffer;
    },
  };
}

/**
 * Converte um stream de bytes (ReadableStream) em eventos SSE já desserializados.
 * Ignora frames inválidos e o marcador [DONE].
 */
export async function* readSseStream(body, { signal } = {}) {
  const decoder = new TextDecoder('utf-8');
  const parser = createSseParser();
  const reader = body.getReader();
  let fullyRead = false;

  const handle = (events) => {
    const out = [];
    for (const evt of events) {
      if (evt.data === '[DONE]') {
        out.push({ done: true });
        continue;
      }
      try {
        out.push({ done: false, event: evt.event, data: JSON.parse(evt.data) });
      } catch {
        // Frame parcial ou comentário de keep-alive: ignorado de propósito.
      }
    }
    return out;
  };

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) {
        fullyRead = true;
        break;
      }
      const text = decoder.decode(value, { stream: true });
      for (const item of handle(parser.push(text))) yield item;
    }
    const tail = decoder.decode();
    if (tail) for (const item of handle(parser.push(tail))) yield item;
    for (const item of handle(parser.flush())) yield item;
  } finally {
    // Se o consumidor parou antes do fim (ex.: recebeu `[DONE]`), cancelar o
    // corpo fecha a conexão com o gateway. Sem isso o socket fica aberto até o
    // servidor derrubar — um vazamento por turno quando o gateway usa keep-alive.
    if (!fullyRead) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
