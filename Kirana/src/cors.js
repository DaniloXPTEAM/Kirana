/**
 * CORS e política de origem.
 *
 * Por que este módulo existe
 * --------------------------
 * Em produção o site (https://opportunity.ia.br) e a Kirana
 * (https://kirana.<algo>) são **origens diferentes**. Sem cabeçalhos CORS:
 *
 *   1. o navegador barra o preflight `OPTIONS` (o servidor respondia 204 sem
 *      `Access-Control-Allow-Origin`);
 *   2. mesmo quando a chamada simples passa, o JS não consegue ler a resposta;
 *   3. o widget embutido no site simplesmente não conversa com a Kirana.
 *
 * A política é de lista fechada (nunca `*`) e aceita três situações:
 *
 *   - requisição sem `Origin` (curl, teste automatizado, server-to-server);
 *   - **mesma origem** (Origin == Host): dev local e a própria interface;
 *   - `Origin` listado em `allowedOrigins` do `site.json` do site OU em
 *     `KIRANA_ALLOWED_ORIGINS` (lista extra, para o domínio de produção).
 *
 * Credencial de navegador (`Access-Control-Allow-Credentials`) fica **false** de
 * propósito: a Kirana não usa cookie de sessão; o acesso privilegiado usa o
 * cabeçalho `Authorization`/`x-kirana-token`, que nunca vai para o público.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Cabeçalhos que o navegador pode mandar nas chamadas à Kirana. */
const ALLOW_HEADERS = ['content-type', 'authorization', 'x-kirana-token', 'x-kirana-site', 'accept', 'last-event-id'];

export function normalizeOrigin(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol)) return '';
    return url.origin.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Origens permitidas = site.json (todos os sites) + KIRANA_ALLOWED_ORIGINS.
 * @returns {Set<string>}
 */
export function allowedOrigins({ siteKit = null, extra = [] } = {}) {
  const out = new Set();
  for (const value of extra) {
    const origin = normalizeOrigin(value);
    if (origin) out.add(origin);
  }
  for (const site of siteKit?.list?.() ?? []) {
    for (const value of site.allowedOrigins ?? []) {
      const origin = normalizeOrigin(value);
      // Nomes de host soltos não servem para CORS: ignorados de propósito.
      if (origin) out.add(origin);
    }
  }
  return out;
}

function hostOrigin(req) {
  const host = String(req.headers.host || '').trim();
  if (!host) return '';
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  return normalizeOrigin(`${proto}://${host}`);
}

/**
 * Decide se a requisição pode prosseguir e devolve os cabeçalhos CORS.
 *
 * @returns {{allowed:boolean, origin:string, sameOrigin:boolean, headers:Record<string,string>}}
 */
export function corsFor(req, { siteKit = null, extraOrigins = [] } = {}) {
  const origin = normalizeOrigin(req.headers.origin);
  if (!origin) {
    // Sem Origin: não é navegador. Nada a adicionar, nada a bloquear.
    return { allowed: true, origin: '', sameOrigin: false, headers: {} };
  }

  const sameOrigin = origin === hostOrigin(req);
  const permitido = sameOrigin || allowedOrigins({ siteKit, extra: extraOrigins }).has(origin);

  if (!permitido) {
    // Sem cabeçalho CORS: o navegador bloqueia sozinho. Não devolvemos 403 para
    // não transformar um erro de configuração em página quebrada — o log avisa.
    return { allowed: false, origin, sameOrigin: false, headers: {} };
  }

  const headers = {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': ALLOW_HEADERS.join(', '),
    'Access-Control-Max-Age': '600',
    // Sem cookies: a autenticação privilegiada é por cabeçalho, nunca por sessão
    // do navegador. Assim não existe CSRF por cookie.
    'Access-Control-Allow-Credentials': 'false',
  };

  return { allowed: true, origin, sameOrigin, headers };
}

/** `true` quando o método não altera estado (usado para checar origem). */
export const isSafeMethod = (method) => SAFE_METHODS.has(String(method || 'GET').toUpperCase());

/**
 * Impõe a política de origem sobre um handler de terceiro.
 *
 * O runtime do CopilotKit monta o endpoint com `cors: true`, que responde
 * `Access-Control-Allow-Origin: *` — qualquer site poderia então gastar o plano
 * do Gateway em nome do dono. Aqui filtramos/reescrevemos o cabeçalho na saída
 * para valer SEMPRE a lista fechada do `src/cors.js`, sem tocar no runtime.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{allowed:boolean, origin:string}} cors resultado de `corsFor`
 */
export function enforceCors(res, cors) {
  const setHeaderOriginal = res.setHeader.bind(res);
  const writeHeadOriginal = res.writeHead.bind(res);
  const COR = 'access-control-';
  const permitido = cors.allowed && cors.origin ? cors.origin : null;

  res.setHeader = (name, value) => {
    const key = String(name).toLowerCase();
    if (key === 'access-control-allow-origin') {
      return permitido ? setHeaderOriginal('Access-Control-Allow-Origin', permitido) : res;
    }
    if (key === 'access-control-allow-credentials') {
      return setHeaderOriginal('Access-Control-Allow-Credentials', 'false');
    }
    if (key.startsWith(COR) && !permitido) return res; // nada de CORS para origem não autorizada
    if (key === 'vary') {
      const atual = res.getHeader('Vary');
      const valor = atual ? `${atual}, ${value}` : String(value);
      return setHeaderOriginal('Vary', valor);
    }
    return setHeaderOriginal(name, value);
  };

  res.writeHead = (status, ...rest) => {
    const headersIndex = rest.findIndex((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (headersIndex >= 0) {
      const headers = { ...rest[headersIndex] };
      for (const name of Object.keys(headers)) {
        if (!name.toLowerCase().startsWith(COR) && name.toLowerCase() !== 'vary') continue;
        delete headers[name];
      }
      if (permitido) {
        headers['Access-Control-Allow-Origin'] = permitido;
        headers['Access-Control-Allow-Credentials'] = 'false';
        headers.Vary = 'Origin';
      }
      const copia = [...rest];
      copia[headersIndex] = headers;
      return writeHeadOriginal(status, ...copia);
    }
    return writeHeadOriginal(status, ...rest);
  };
}
