/**
 * SIMULADOR de `tailscale serve` — NÃO é o Tailscale.
 *
 * Para que serve: o `tailscale serve` fica na máquina Windows do dono, então
 * neste ambiente não há Tailscale para exercitar. Este processo reproduz o que
 * ele faz do ponto de vista da aplicação — entrega o pedido em LOOPBACK e injeta
 * os cabeçalhos que o Serve injeta:
 *
 *   X-Forwarded-Proto: https
 *   X-Forwarded-For:   <ip do cliente no tailnet>
 *   Tailscale-User-Login: <login no tailnet>
 *
 * O que isto prova: a ponte reage corretamente a esses cabeçalhos (exige HTTPS,
 * separa limites por identidade, não repassa cabeçalho do cliente ao Gateway).
 * O que NÃO prova: que o seu tailnet, o DNS `.ts.net`, o certificado TLS e o
 * caminho até o celular funcionam. Isso só o aparelho real prova.
 *
 *   node tools/simular-tailscale-serve.mjs --alvo http://127.0.0.1:3000 \
 *        --porta 8443 --login voce@exemplo.com --encaminhar-para 192.168.0.10
 */
import http from 'node:http';

const args = process.argv.slice(2);
const valor = (flag, padrao = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};

const alvo = valor('--alvo', 'http://127.0.0.1:3000');
const porta = Number(valor('--porta', 8443));
const host = valor('--host', '127.0.0.1');
const login = valor('--login', 'simulador@tailnet.invalid');
const ipSimulado = valor('--encaminhar-para', '100.64.0.10');
const proto = valor('--proto', 'https');

const url = new URL(alvo);

const servidor = http.createServer(async (req, res) => {
  const partes = [];
  for await (const parte of req) partes.push(parte);
  const corpo = Buffer.concat(partes);

  // Cabeçalhos do cliente que o Serve NÃO repassa (e que a ponte também não deve
  // repassar ao Gateway). Simulo o comportamento mais seguro: removo os do
  // Tailscale vindos de fora e reinjeto os "oficiais".
  const cabecalhos = { ...req.headers };
  for (const nome of Object.keys(cabecalhos)) {
    if (nome.toLowerCase().startsWith('tailscale-')) delete cabecalhos[nome];
  }
  delete cabecalhos['x-forwarded-proto'];
  delete cabecalhos['x-forwarded-for'];

  cabecalhos['x-forwarded-proto'] = proto;
  cabecalhos['x-forwarded-for'] = ipSimulado;
  cabecalhos['tailscale-user-login'] = login;
  if (corpo.length) cabecalhos['content-length'] = String(corpo.length);

  let upstream;
  try {
    upstream = await fetch(new URL(req.url, url.origin), {
      method: req.method,
      headers: cabecalhos,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : corpo,
    });
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'simulador_sem_alvo', message: `Alvo ${alvo} não respondeu: ${error.message}` } }));
    return;
  }

  const saida = {};
  for (const nome of ['content-type', 'cache-control']) {
    const v = upstream.headers.get(nome);
    if (v) saida[nome] = v;
  }
  res.writeHead(upstream.status, saida);
  if (!upstream.body) return res.end();
  for await (const pedaco of upstream.body) res.write(Buffer.from(pedaco));
  res.end();
});

servidor.listen(porta, host, () => {
  console.log(`SIMULADOR do tailscale serve em http://${host}:${porta} → ${alvo}`);
  console.log(`Injeta: X-Forwarded-Proto=${proto} · X-Forwarded-For=${ipSimulado} · Tailscale-User-Login=${login}`);
  console.log('Isto NÃO é o Tailscale: prova só o comportamento da ponte diante desses cabeçalhos.');
});
