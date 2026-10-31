/**
 * Logger simples com níveis e redação de segredos.
 * Nenhuma credencial do gateway deve aparecer em log.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger({ level = 'info', secrets = [] } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const secretList = secrets.filter((s) => typeof s === 'string' && s.length >= 6);

  const redact = (value) => {
    let text = typeof value === 'string' ? value : safeStringify(value);
    for (const secret of secretList) {
      text = text.split(secret).join('[REDACTED]');
    }
    text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]');
    text = text.replace(/("?(?:api[_-]?key|authorization|access_token|token)"?\s*[:=]\s*"?)[^",\s}]{6,}/gi, '$1[REDACTED]');
    return text;
  };

  const write = (level, message, meta) => {
    if ((LEVELS[level] ?? 2) > threshold) return;
    const stamp = new Date().toISOString();
    const suffix = meta === undefined ? '' : ` ${redact(meta)}`;
    const line = `[${stamp}] ${level.toUpperCase()} ${redact(String(message))}${suffix}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };

  return {
    error: (m, meta) => write('error', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    info: (m, meta) => write('info', m, meta),
    debug: (m, meta) => write('debug', m, meta),
    redact,
    child: (prefix) => {
      const base = createLogger({ level, secrets });
      const tag = (m) => `[${prefix}] ${m}`;
      return {
        error: (m, meta) => base.error(tag(m), meta),
        warn: (m, meta) => base.warn(tag(m), meta),
        info: (m, meta) => base.info(tag(m), meta),
        debug: (m, meta) => base.debug(tag(m), meta),
        redact: base.redact,
        child: (sub) => base.child(`${prefix}:${sub}`),
      };
    },
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
