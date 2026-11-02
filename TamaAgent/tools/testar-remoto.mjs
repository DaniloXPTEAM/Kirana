/**
 * Teste do acesso remoto — roda no CELULAR (Termux) ou em qualquer máquina.
 *
 * Ele fala com o endereço HTTPS privado do Tailscale e verifica, em ordem:
 *   1. alcança o endereço? (Tailscale + Serve + Kirana no ar)
 *   2. a ponte responde e reconhece o caminho do tailnet?
 *   3. o token da ponte é aceito? (e o token errado é recusado?)
 *   4. rota fora da lista é recusada?
 *   5. o Gateway real responde pelo caminho remoto?
 *   6. o modelo lista? (depende do SIWC estar autorizado na máquina)
 *   7. streaming SSE chega token a token, com tempo até o primeiro token?
 *
 * Nada aqui "simula" resposta de modelo: se o Gateway não estiver autorizado,
 * a etapa 6/7 reporta o 401 real e o teste diz que a conversa não foi validada.
 *
 * Uso:
 *   node testar-remoto.mjs --url https://SEU-PC.SEU-TAILNET.ts.net --token <KIRANA_BRIDGE_TOKEN>
 *   node testar-remoto.mjs --url ... --token ... --model <slug>
 */
const args = process.argv.slice(2);
const valor = (flag, padrao = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};

let modoSimulador = false;
const base = (valor('--url', process.env.TAMA_URL) || '').replace(/\/+$/, '');
const token = valor('--token', process.env.KIRANA_BRIDGE_TOKEN || '');
const modelo = valor('--model', null);
const timeoutMs = Number(valor('--timeout', 60_000));

if (!base || !token) {
  console.error('Faltou --url (https://…ts.net) ou --token (KIRANA_BRIDGE_TOKEN).');
  process.exit(2);
}
/**
 * Escape hatch DELIBERADAMENTE estreita: aceita http:// APENAS em loopback, e
 * apenas para exercitar o próprio verificador contra o simulador do Serve. Não
 * serve para validar acesso remoto — e o relatório final deixa isso explícito.
 */
const permitirHttpLocal = args.includes('--permitir-http-local');
const ehLoopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base);
if (!base.startsWith('https://')) {
  if (!(permitirHttpLocal && ehLoopback)) {
    console.error('A URL precisa ser https:// — o Serve fornece o TLS, e a ponte exige HTTPS.');
    console.error('(http:// só é aceito com --permitir-http-local e endereço de loopback, para testar o simulador.)');
    process.exit(2);
  }
  console.log('ATENÇÃO: rodando contra o SIMULADOR em loopback. Isto NÃO valida acesso remoto.\n');
  modoSimulador = true;
}

const auth = { authorization: `Bearer ${token}` };
const resultados = [];
function registrar(nome, ok, detalhe) {
  resultados.push({ nome, ok, detalhe });
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
}

async function passo(nome, funcao) {
  try {
    const detalhe = await funcao();
    registrar(nome, true, detalhe);
    return true;
  } catch (error) {
    registrar(nome, false, error.message);
    return false;
  }
}

const buscar = async (caminho, init = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${base}${caminho}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

console.log(`Testando ${base}\n`);

await passo('1. alcança o endereço HTTPS', async () => {
  const t0 = Date.now();
  const r = await buscar('/health');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const corpo = await r.json();
  return `Kirana v${corpo.version ?? '?'} em ${Date.now() - t0} ms`;
});

let infoPonte = null;
await passo('2. ponte ativa e caminho do tailnet', async () => {
  const r = await buscar('/api/gateway/ping', { headers: auth });
  const corpo = await r.json();
  if (r.status === 401) throw new Error('token da ponte recusado (401)');
  if (r.status === 403) throw new Error(`ponte recusou: ${corpo?.error?.message || 403}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  infoPonte = corpo;
  const via = corpo.request?.viaTailscale ? 'via tailscale' : 'SEM cabeçalho do tailnet';
  const https = corpo.request?.https ? 'HTTPS' : 'sem HTTPS';
  return `${https} · ${via} · ${corpo.routes?.length ?? 0} rotas expostas`;
});

await passo('3. token errado é recusado', async () => {
  const r = await buscar('/api/gateway/ping', { headers: { authorization: 'Bearer token-errado-de-proposito' } });
  if (r.status !== 401) throw new Error(`esperava 401, veio ${r.status}`);
  return '401 como esperado';
});

await passo('4. rota fora da lista é recusada', async () => {
  const r = await buscar('/api/gateway/v1/files', { headers: auth });
  if (r.status !== 404) throw new Error(`esperava 404, veio ${r.status}`);
  const corpo = await r.json();
  return corpo?.error?.code || '404';
});

await passo('5. Gateway real responde pelo caminho remoto', async () => {
  const r = await buscar('/api/gateway/v1/engine', { headers: auth });
  const corpo = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${corpo?.error?.message || ''}`);
  return `Gateway v${corpo.gateway?.version} · roteamento ${corpo.policy?.routing_enabled ? 'ligado' : 'desligado'} · custo ${corpo.policy?.cost_policy}`;
});

let modelos = [];
await passo('6. lista de modelos da conta', async () => {
  const r = await buscar('/api/gateway/v1/models', { headers: auth });
  const corpo = await r.json();
  if (r.status === 401) {
    throw new Error('Gateway sem SIWC autorizado — a conversa real NÃO pode ser validada ainda (não é falha da ponte)');
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  modelos = (corpo.data || []).map((m) => m.id);
  if (!modelos.length) throw new Error('lista vazia');
  return `${modelos.length} modelo(s): ${modelos.slice(0, 3).join(', ')}${modelos.length > 3 ? '…' : ''}`;
});

const modeloUsado = modelo || modelos[0];
if (!modeloUsado) {
  registrar('7. streaming de resposta real', false, 'sem modelo autorizado — etapa não executada (nada inventado)');
} else {
  await passo(`7. streaming real com "${modeloUsado}"`, async () => {
    const t0 = Date.now();
    const r = await buscar('/api/gateway/v1/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: modeloUsado, stream: true, messages: [{ role: 'user', content: 'Diga apenas: teste remoto ok' }] }),
    });
    if (!r.ok) {
      const corpo = await r.json().catch(() => null);
      throw new Error(`HTTP ${r.status}: ${corpo?.error?.code || ''}`);
    }
    const leitor = r.body.getReader();
    const dec = new TextDecoder();
    let texto = '';
    let primeiroToken = null;
    let buffer = '';
    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      for (const linha of buffer.split('\n')) {
        if (!linha.startsWith('data:')) continue;
        const bruto = linha.slice(5).trim();
        if (!bruto || bruto === '[DONE]') continue;
        try {
          const evento = JSON.parse(bruto);
          const delta = evento.choices?.[0]?.delta?.content;
          if (delta) {
            primeiroToken ??= Date.now() - t0;
            texto += delta;
          }
        } catch { /* frame parcial */ }
      }
    }
    if (!texto.trim()) throw new Error('stream vazio');
    return `1º token em ${primeiroToken} ms · ${texto.length} caracteres · "${texto.trim().slice(0, 60)}"`;
  });
}

const falhas = resultados.filter((r) => !r.ok);
console.log('');
if (modoSimulador) {
  console.log('RESULTADO: verificador exercitado contra o simulador. Nada aqui valida o acesso remoto real:');
  console.log('o Tailscale, o certificado .ts.net e o celular continuam fora deste teste.');
  process.exit(4);
}
if (falhas.length === 0) {
  console.log('RESULTADO: caminho remoto validado de ponta a ponta, incluindo resposta real do modelo.');
  process.exit(0);
}
const soSiwc = falhas.every((f) => /SIWC|modelo autorizado|401/i.test(f.detalhe || ''));
if (soSiwc) {
  console.log('RESULTADO: transporte privado, autenticação e recusas OK. A RESPOSTA REAL do modelo não foi validada');
  console.log('porque o Gateway está sem autorização SIWC. Autorize em http://127.0.0.1:1455/auth/start na máquina');
  console.log('da Kirana e rode de novo. Este resultado NÃO afirma que o acesso remoto completo foi validado.');
  process.exit(3);
}
console.log(`RESULTADO: ${falhas.length} etapa(s) falharam. Veja acima.`);
process.exit(1);
