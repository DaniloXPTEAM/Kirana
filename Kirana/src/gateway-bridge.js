/**
 * Ponte `/api/gateway/*` — acesso controlado ao Gateway a partir do celular.
 *
 * ── Caminho remoto (Tama IA Android) ───────────────────────────────────────
 *   celular → Tailscale (privado) → `tailscale serve` (HTTPS) → Kirana :3000
 *           → ponte `/api/gateway/*` → Gateway 127.0.0.1:1455
 *
 * O `tailscale serve` roda na MESMA máquina e entrega em loopback, então a
 * Kirana continua em `127.0.0.1` — nada de `0.0.0.0`, nada de porta pública, nada
 * no roteador. O TLS é do Tailscale (certificado `.ts.net`), e o acesso já é
 * restrito ao tailnet antes de chegar aqui. A ponte soma três coisas a isso:
 * token próprio, lista fechada de rotas e exigência de HTTPS.
 *
 * ── Problema real (rede local) ─────────────────────────────────────────────
 * O Gateway escuta só em `127.0.0.1` (e recusa bind não-loopback de propósito).
 * Isso é correto: ele guarda a sessão do ChatGPT na memória do processo. Mas o
 * celular, no mesmo Wi-Fi, não alcança `127.0.0.1` do PC. Expor o Gateway na
 * rede seria a solução errada — ele passaria a aceitar pedidos de qualquer
 * aparelho da rede (ou de quem entrar nela).
 *
 * A ponte inverte o desenho: o Gateway **continua** em loopback, e a Kirana
 * (que já serve a interface na porta 3000) faz o repasse. As portas 1455 e 3000
 * não mudam.
 *
 * ── Segurança ─────────────────────────────────────────────────────────────
 * - Desligada por padrão. Só liga com `KIRANA_BRIDGE=on`.
 * - Ligada exige `KIRANA_BRIDGE_TOKEN` (32+ caracteres), comparado em tempo
 *   constante. Sem token, a ponte recusa tudo — não existe "modo aberto".
 * - Se a Kirana estiver exposta além do loopback (`KIRANA_HOST=0.0.0.0`) sem
 *   `KIRANA_ACCESS_TOKEN`, o start falha: abrir a rede sem autenticar a API
 *   inteira exporia `/api/sessions` e `/api/memory`.
 * - A chave do Gateway nunca sai daqui. O cliente da ponte autentica na ponte;
 *   a ponte autentica no Gateway. A chave não aparece em corpo, cabeçalho ou log.
 * - Lista fechada de rotas: só o necessário para usar o motor como API. Nada de
 *   `/v1/files`, `/auth/*` ou `/v1/images/*`.
 * - Limite de requisições por origem, para o celular não virar um laço de gasto.
 */

import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

import { createRateLimiter } from './ratelimit.js';

/** Rotas expostas pela ponte: método + caminho exato ou prefixo declarado. */
const ROTAS = Object.freeze([
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/v1/models' },
  { method: 'GET', path: '/v1/engine' },
  { method: 'GET', path: '/v1/runs' },
  { method: 'GET', path: '/v1/runs/:id', prefix: '/v1/runs/' },
  { method: 'POST', path: '/v1/chat/completions' },
]);

const CORPO_MAX_BYTES = 1024 * 1024; // o Gateway também limita em 1 MiB para texto

export class BridgeError extends Error {
  constructor(message, { code = 'bridge_error', status = 502 } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
  }
}

/** Comparação em tempo constante que não vaza comprimento por exceção. */
function tokenConfere(recebido, esperado) {
  if (typeof recebido !== 'string' || typeof esperado !== 'string' || !esperado) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Identidade do cliente para o limite de requisições.
 *
 * Atrás do `tailscale serve`, todo pedido chega com `remoteAddress` 127.0.0.1 —
 * um único balde para o tailnet inteiro. Quando `trustProxy` está ligado, a
 * identidade passa a ser o login Tailscale (ou o `X-Forwarded-For`) e cada
 * aparelho tem seu próprio limite. Fora do proxy, `remoteAddress` é o certo:
 * confiar em cabeçalho sem proxy na frente é convite a burlar o limite.
 */
function identidadeDoCliente(req, { trustProxy }) {
  if (trustProxy) {
    const login = String(req.headers['tailscale-user-login'] || '').trim();
    if (login) return `tailnet:${login}`;
    const encaminhado = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (encaminhado) return `xff:${encaminhado}`;
  }
  return req.socket?.remoteAddress || 'local';
}

/**
 * O pedido chegou por HTTPS?
 *
 * Quem decide é o proxy (`tailscale serve` injeta `X-Forwarded-Proto: https`).
 * Sem proxy confiável, considera-se inseguro — a ponte não adivinha.
 */
function veioPorHttps(req, { trustProxy }) {
  if (!trustProxy) return false;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

/** Extrai o token da ponte do pedido — cabeçalho padrão ou o da Kirana. */
function tokenDoPedido(req) {
  const header = String(req.headers.authorization || '');
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return String(req.headers['x-kirana-bridge'] || '').trim();
}

function rotaPermitida(method, pathname) {
  return ROTAS.some((rota) => {
    if (rota.method !== method) return false;
    if (rota.prefix) return pathname.startsWith(rota.prefix) && pathname.length > rota.prefix.length;
    return pathname === rota.path;
  });
}

function enviarJson(res, status, dados) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(corpo),
  });
  res.end(corpo);
}

function enviarErro(res, status, code, message) {
  enviarJson(res, status, { error: { message, type: 'bridge_error', code } });
}

async function lerCorpo(req, limite = CORPO_MAX_BYTES) {
  const partes = [];
  let total = 0;
  for await (const parte of req) {
    total += parte.length;
    if (total > limite) throw new BridgeError('Corpo do pedido grande demais para a ponte.', { code: 'request_too_large', status: 413 });
    partes.push(parte);
  }
  return Buffer.concat(partes);
}

export function createGatewayBridge({ config, logger, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const log = logger?.child?.('bridge') ?? logger;
  const ponte = config?.bridge ?? {};
  const habilitada = Boolean(ponte.enabled);
  const token = String(ponte.token || '').trim();
  const base = String(config?.gateway?.url || 'http://127.0.0.1:1455').replace(/\/+$/, '');
  const apiKey = config?.gateway?.apiKey || '';
  const limite = createRateLimiter({ max: ponte.rateMax ?? 30, windowMs: 60_000, now });

  /**
   * Devolve o estado da ponte para logs e diagnóstico. Nunca inclui o token nem
   * a chave do Gateway — só se estão configurados.
   */
  const status = () => ({
    enabled: habilitada,
    tokenConfigured: Boolean(token),
    gatewayKeyConfigured: Boolean(apiKey),
    gatewayUrl: new URL(base).origin,
    requireHttps: Boolean(ponte.requireHttps),
    trustProxy: Boolean(ponte.trustProxy),
    routes: ROTAS.map((rota) => `${rota.method} ${rota.path}`),
  });

  async function repassar(req, res, url, method) {
    const controller = new AbortController();
    // Se o celular fechar a conexão, o pedido ao Gateway é abortado: não faz
    // sentido deixar o PC gerando tokens para ninguém.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new DOMException('client closed', 'AbortError'));
    });

    const alvo = new URL(`${base}${url.pathname}${url.search}`);
    const headers = { authorization: `Bearer ${apiKey}` };
    const contentType = req.headers['content-type'];
    if (contentType) headers['content-type'] = contentType;
    if (req.headers.accept) headers.accept = String(req.headers.accept);

    let corpo;
    if (method !== 'GET' && method !== 'HEAD') corpo = await lerCorpo(req);

    const tempoLimite = setTimeout(() => controller.abort(new Error('bridge timeout')), ponte.timeoutMs ?? 180_000);
    let upstream;
    try {
      upstream = await fetchImpl(alvo, { method, headers, body: corpo, signal: controller.signal });
    } catch (error) {
      clearTimeout(tempoLimite);
      if (error?.name === 'AbortError') {
        if (res.writableEnded) return;
        return enviarErro(res, 504, 'gateway_timeout', 'O Gateway não respondeu dentro do tempo da ponte.');
      }
      throw new BridgeError('Não foi possível falar com o Gateway em loopback.', { code: 'gateway_unreachable', status: 502 });
    }
    clearTimeout(tempoLimite);

    // Repasse de cabeçalhos: só o que é seguro e útil. Nada de `set-cookie`.
    const cabecalhos = {};
    for (const nome of ['content-type', 'cache-control']) {
      const valor = upstream.headers.get(nome);
      if (valor) cabecalhos[nome] = valor;
    }
    if (!cabecalhos['content-type']) cabecalhos['content-type'] = 'application/json; charset=utf-8';

    res.writeHead(upstream.status, cabecalhos);
    if (!upstream.body) {
      res.end();
      return;
    }
    // Streaming sem buffer: o primeiro token chega ao celular no mesmo instante.
    try {
      const fluxo = Readable.fromWeb(upstream.body);
      fluxo.on('error', () => res.end());
      fluxo.pipe(res);
    } catch {
      // Ambiente sem Readable.fromWeb: cai para leitura manual.
      const leitor = upstream.body.getReader();
      for (;;) {
        const { value, done } = await leitor.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
      res.end();
    }
  }

  async function handle(req, res, url, method = req.method) {
    const caminho = url.pathname.replace(/^\/api\/gateway(?=\/|$)/, '') || '/';

    if (!habilitada) {
      return enviarErro(res, 404, 'bridge_disabled', 'Ponte do Gateway desligada. Ligue com KIRANA_BRIDGE=on no .env.');
    }

    if (!token) {
      // Fail-closed: ponte ligada sem token não atende ninguém.
      log?.warn?.('Ponte ligada sem KIRANA_BRIDGE_TOKEN — recusando todos os pedidos.');
      return enviarErro(res, 403, 'bridge_not_configured', 'A ponte exige KIRANA_BRIDGE_TOKEN (32+ caracteres).');
    }

    if (!tokenConfere(tokenDoPedido(req), token)) {
      return enviarErro(res, 401, 'bridge_unauthorized', 'Token da ponte ausente ou inválido.');
    }

    if (ponte.requireHttps && !veioPorHttps(req, { trustProxy: Boolean(ponte.trustProxy) })) {
      /**
       * Recusa explícita em vez de degradar: se alguém apontar um proxy HTTP
       * claro para a Kirana, o token da ponte trafegaria em texto aberto. A
       * mensagem diz exatamente o que fazer.
       */
      return enviarErro(res, 403, 'bridge_https_required', 'A ponte exige HTTPS (X-Forwarded-Proto: https). Use o endereço https://…ts.net do `tailscale serve`.');
    }

    const origem = identidadeDoCliente(req, { trustProxy: Boolean(ponte.trustProxy) });
    const decisao = limite.check(origem);
    if (!decisao.allowed) {
      res.setHeader?.('retry-after', String(Math.ceil(decisao.retryAfterMs / 1000)));
      return enviarErro(res, 429, 'bridge_rate_limited', 'Muitos pedidos pela ponte. Tente em instantes.');
    }

    if (caminho === '/ping' || caminho === '/status') {
      const trustProxy = Boolean(ponte.trustProxy);
      /**
       * Diagnóstico para o celular conferir o caminho: se `viaTailscale` é
       * `true`, o pedido passou pelo `tailscale serve` (cabeçalho injetado por
       * ele). Exponho apenas isso — não devolvo login, IP nem nome do tailnet.
       */
      return enviarJson(res, 200, {
        bridge: 'on',
        ...status(),
        request: {
          https: veioPorHttps(req, { trustProxy }),
          viaTailscale: Boolean(String(req.headers['tailscale-user-login'] || '').trim()),
        },
      });
    }

    if (!rotaPermitida(method, caminho)) {
      // Recusa explícita: a ponte não é um proxy genérico.
      return enviarErro(res, 404, 'bridge_route_not_exposed', `A ponte não expõe ${method} ${caminho}.`);
    }

    if (!apiKey) {
      return enviarErro(res, 503, 'gateway_not_configured', 'Falta KIRANA_GATEWAY_API_KEY no .env da Kirana.');
    }

    try {
      await repassar(req, res, { pathname: caminho, search: url.search }, method);
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 502;
      const code = error?.code || 'bridge_error';
      if (!res.headersSent) {
        enviarErro(res, status, code, error?.message || 'Falha na ponte do Gateway.');
      } else if (!res.writableEnded) {
        res.end();
      }
      if (status >= 500) log?.warn?.('Falha na ponte do Gateway', { code, status });
    }
  }

  return { handle, status, routes: ROTAS, enabled: habilitada };
}
