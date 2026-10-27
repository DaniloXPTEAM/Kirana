/**
 * Utilitários HTTP: leitura de corpo, respostas JSON, SSE de saída e
 * arquivos estáticos com proteção contra path traversal.
 */
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { error: { code, message, ...extra } });
}

export async function readJsonBody(req, { maxBytes = 32 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new HttpError(413, 'payload_too_large', `Corpo da requisição acima de ${maxBytes} bytes.`);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not-an-object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Corpo da requisição não é um JSON de objeto válido.');
  }
}

/** Abre uma resposta SSE e devolve helpers de escrita. */
export function startSse(res, headers = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...headers,
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }
  }, 15_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };

  return {
    send(event) {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        finish();
      }
    },
    ping() {
      if (!closed) {
        try {
          res.write(': ping\n\n');
        } catch {
          finish();
        }
      }
    },
    close: finish,
    get closed() {
      return closed;
    },
  };
}

export function serveStatic(publicDir, urlPath, res) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(publicDir, relative);

  if (!target.startsWith(path.resolve(publicDir) + path.sep) && target !== path.resolve(publicDir)) {
    sendError(res, 403, 'forbidden', 'Caminho não permitido.');
    return true;
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(body.length),
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60',
  });
  res.end(body);
  return true;
}

/**
 * Cabeçalhos de segurança.
 *
 * `allowEmbed` existe apenas para prévias em sandbox/ambientes de
 * desenvolvimento que exibem a interface dentro de um iframe de outra origem.
 * Em uso normal (padrão) a interface só pode ser enquadrada pela própria origem.
 */
export function securityHeaders({ allowEmbed = false, embedOrigins = [] } = {}) {
  // Lista explícita tem prioridade: libera o iframe só para os domínios do site.
  // Nesse caso `X-Frame-Options` é omitido (ele não aceita lista; quem decide é
  // o `frame-ancestors` do CSP, que os navegadores atuais respeitam).
  const lista = (embedOrigins ?? []).map((item) => String(item).trim()).filter(Boolean);
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...(lista.length ? {} : { 'X-Frame-Options': allowEmbed ? 'ALLOWALL' : 'SAMEORIGIN' }),
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      // Áudio da resposta (TTS): vem de /api/voice/tts e da URL de blob usada
      // para tocar o MP3 em streaming. Sem isto o navegador bloqueia o play().
      "media-src 'self' blob:",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${lista.length ? lista.join(' ') : allowEmbed ? '*' : "'self'"}`,
    ].join('; '),
    // `microphone=(self)` libera o microfone apenas para esta origem (o botão
    // de voz usa SpeechRecognition). Câmera e geolocalização seguem bloqueadas.
    'Permissions-Policy': 'geolocation=(), microphone=(self), camera=()',
  };
}
