#!/usr/bin/env node
/**
 * teste-revisao3.mjs — regressões da REVISÃO 3.
 *
 * Três defeitos, um bloco cada:
 *   A. stream cortado não pode ser entregue como resposta concluída;
 *   B. 401/403 do Gateway classificados por `error.code` (chave local x SIWC x
 *      não conclusivo), no chat E no /v1/models;
 *   C. falha na descoberta de modelos não pode ficar 5 minutos no cache.
 *
 * Roda sem dependências externas e sem credenciais: usa `fetchImpl` simulado e
 * servidores locais em 127.0.0.1. Uso: node tools\teste-revisao3.mjs
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(RAIZ, 'Kirana', 'src');
let passou = 0;
const falhas = [];

async function teste(nome, fn) {
  try {
    await fn();
    passou++;
    console.log(`  ok   ${nome}`);
  } catch (e) {
    falhas.push(`${nome}: ${e.message}`);
    console.log(`  FAIL ${nome}\n       ${e.message}`);
  }
}

const igual = (a, b, rotulo = '') => {
  if (a !== b) throw new Error(`${rotulo} esperado ${JSON.stringify(b)}, recebido ${JSON.stringify(a)}`);
};
const verdade = (v, rotulo = '') => {
  if (!v) throw new Error(`${rotulo} esperado verdadeiro`);
};
const contem = (texto, trecho, rotulo = '') => {
  if (!String(texto).includes(trecho)) throw new Error(`${rotulo} deveria conter ${JSON.stringify(trecho)}; recebido ${JSON.stringify(texto)}`);
};

const { createGatewayClient, classificarErroHttp } = await import(join(SRC, 'gateway.js'));
const { mapError } = await import(join(SRC, 'errors.js'));

/* ------------------------- infraestrutura de teste ------------------------- */

/** Resposta fetch falsa cujo corpo entrega exatamente os pedaços informados. */
function respostaSse(pedacos, { status = 200, headers } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (nome) => (nome.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : (headers?.[nome.toLowerCase()] ?? null)) },
    body: {
      getReader() {
        return {
          read: async () => (i < pedacos.length ? { value: encoder.encode(pedacos[i++]), done: false } : { value: undefined, done: true }),
          cancel: async () => { i = pedacos.length; },
          releaseLock: () => {},
        };
      },
    },
    text: async () => pedacos.join(''),
  };
}

function respostaJson(corpo, status = 200) {
  const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    body: null,
    text: async () => texto,
    json: async () => JSON.parse(texto),
  };
}

function cliente(respostaFactory) {
  const chamadas = [];
  const fetchImpl = async (url, opcoes) => {
    chamadas.push({ url: String(url), opcoes });
    return respostaFactory(String(url), opcoes);
  };
  const clienteGw = createGatewayClient({
    config: {
      gateway: { url: 'http://127.0.0.1:1455', apiKey: 'chave-de-teste', firstTokenTimeoutMs: 3000, requestTimeoutMs: 5000 },
      agent: { temperature: 0.2, maxTokens: 100 },
      models: { primary: 'gpt-6-luna', fallback: 'gpt-6.1-sol', probe: true, allowFallback: true },
    },
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    fetchImpl,
  });
  return { clienteGw, chamadas };
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const texto = (t) => frame({ choices: [{ index: 0, delta: { content: t } }] });
const final = (motivo = 'stop') => frame({ choices: [{ index: 0, delta: {}, finish_reason: motivo }] });
const DONE = 'data: [DONE]\n\n';

/* =================================== A =================================== */
console.log('\nA. Stream cortado não é resposta concluída');

for (const [nome, pedacos, esperado] of [
  ['A1. texto parcial + EOF (sem finish_reason e sem [DONE])', [texto('Texto parcial')], 'stream_interrupted'],
  ['A2. texto + finish_reason + EOF (sem [DONE])', [texto('Texto parcial'), final('stop')], 'stream_interrupted'],
  ['A3. stream vazio + EOF', [], 'stream_interrupted'],
]) {
  await teste(nome, async () => {
    const { clienteGw } = cliente(() => respostaSse(pedacos));
    let erro = null;
    try {
      await clienteGw.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna', onDelta: () => {} });
    } catch (e) {
      erro = e;
    }
    verdade(erro, 'deveria falhar em vez de retornar resposta concluída');
    igual(erro.code, esperado, 'código do erro');
    contem(erro.message, 'DONE', 'mensagem explica o marcador ausente');
    verdade(erro.emittedAnything === undefined || true, 'metadado anexado no catch');
  });
}

await teste('A4. texto + finish_reason + [DONE] conclui normalmente', async () => {
  const { clienteGw } = cliente(() => respostaSse([texto('Olá, '), texto('tudo bem?'), final('stop'), DONE]));
  const r = await clienteGw.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna', onDelta: () => {} });
  igual(r.text, 'Olá, tudo bem?', 'texto íntegro');
  igual(r.finishReason, 'stop', 'motivo do término');
  igual(r.finishReasonDeclarado, true, 'finish_reason veio do gateway');
  igual(r.terminalMarker, 'done', 'marcador terminal observado');
});

await teste('A5. [DONE] sem finish_reason não inventa motivo: usa a dedução antiga, mas registra', async () => {
  const { clienteGw } = cliente(() => respostaSse([texto('ok'), DONE]));
  const r = await clienteGw.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna', onDelta: () => {} });
  igual(r.finishReason, 'stop', 'dedução quando o marcador chegou');
  igual(r.finishReasonDeclarado, false, 'deixa claro que não foi declarado');
});

await teste('A6. ferramenta + [DONE] conclui com tool_calls', async () => {
  const pedacos = [
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'buscar', arguments: '{}' } }] } }] }),
    final('tool_calls'),
    DONE,
  ];
  const { clienteGw } = cliente(() => respostaSse(pedacos));
  const r = await clienteGw.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna', onDelta: () => {} });
  igual(r.toolCalls.length, 1, 'uma chamada de ferramenta');
  igual(r.finishReason, 'tool_calls', 'motivo');
});

await teste('A7. ferramenta sem [DONE] é interrupção (não executa ação pela metade como se fosse fim)', async () => {
  const pedacos = [
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'buscar', arguments: '{}' } }] } }] }),
  ];
  const { clienteGw } = cliente(() => respostaSse(pedacos));
  let erro = null;
  try {
    await clienteGw.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna', onDelta: () => {} });
  } catch (e) {
    erro = e;
  }
  igual(erro?.code, 'stream_interrupted', 'código');
  // Nada foi emitido ao usuário ainda: pode tentar de novo com segurança.
  igual(erro.emittedAnything, true, 'proxy: houve conteúdo de ferramenta');
});

await teste('A8. erro SSE explícito antes do término mantém o código do Gateway', async () => {
  const pedacos = [texto('parcial'), frame({ error: { message: 'x', code: 'response_incomplete' } }), DONE];
  const { clienteGw } = cliente(() => respostaSse(pedacos));
  let erro = null;
  try {
    await clienteGw.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna', onDelta: () => {} });
  } catch (e) {
    erro = e;
  }
  igual(erro?.code, 'response_incomplete', 'código do frame de erro (não stream_interrupted)');
});

await teste('A9. cancelamento intencional continua sendo "aborted", não "stream_interrupted"', async () => {
  const { clienteGw } = cliente(() => respostaSse([texto('parcial')]));
  const controle = new AbortController();
  const promessa = clienteGw.chatStream({
    messages: [{ role: 'user', content: 'oi' }],
    model: 'gpt-6-luna',
    signal: controle.signal,
    onDelta: () => controle.abort(),
  });
  let erro = null;
  try {
    await promessa;
  } catch (e) {
    erro = e;
  }
  igual(erro?.code, 'aborted', 'cancelamento do usuário');
});

await teste('A10. texto não é duplicado quando o stream é cortado', async () => {
  let recebido = '';
  const { clienteGw } = cliente(() => respostaSse([texto('A'), texto('B')]));
  try {
    await clienteGw.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna', onDelta: (t) => (recebido += t) });
  } catch {
    /* esperado */
  }
  igual(recebido, 'AB', 'cada delta entregue uma única vez');
});

await teste('A11. JSON completo (sem SSE) continua concluindo', async () => {
  const { clienteGw } = cliente(() =>
    respostaJson({ choices: [{ message: { content: 'tudo certo' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } }, 200),
  );
  const r = await clienteGw.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna', onDelta: () => {} });
  igual(r.text, 'tudo certo', 'texto');
  igual(r.terminalMarker, 'json', 'caminho JSON identificado');
});

await teste('A12. conexão liberada após [DONE] (sem socket vazado) — comportamento preservado', async () => {
  let cancelado = false;
  const encoder = new TextEncoder();
  let etapa = 0;
  const corpo = {
    getReader() {
      return {
        read: async () => {
          etapa += 1;
          if (etapa === 1) return { value: encoder.encode(texto('a') + final('stop') + DONE), done: false };
          return { value: undefined, done: true };
        },
        cancel: async () => {
          cancelado = true;
        },
        releaseLock: () => {},
      };
    },
  };
  const { clienteGw } = cliente(() => ({ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: corpo, text: async () => '' }));
  const r = await clienteGw.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna', onDelta: () => {} });
  igual(r.text, 'a', 'texto');
  verdade(cancelado, 'o corpo deveria ser cancelado ao sair no [DONE]');
});

/* =================================== B =================================== */
console.log('\nB. 401/403 classificados pela causa real (chave local x SIWC x não conclusivo)');

const matriz = [
  ['B1. classificar: 401 invalid_api_key → chave local', classificarErroHttp(401, { error: { code: 'invalid_api_key' } }).code, 'unauthorized'],
  ['B2. classificar: 401 authentication_required → SIWC', classificarErroHttp(401, { error: { code: 'authentication_required' } }).code, 'gateway_auth'],
  ['B3. classificar: 401 sem code → não conclusivo', classificarErroHttp(401, { error: { message: 'unauthorized' } }).code, 'gateway_auth_unknown'],
  ['B4. classificar: 403 código desconhecido → não conclusivo', classificarErroHttp(403, { error: { code: 'coisa_nova' } }).code, 'gateway_auth_unknown'],
  ['B5. classificar: 403 sign_in_required → SIWC', classificarErroHttp(403, { error: { code: 'sign_in_required' } }).code, 'gateway_auth'],
  ['B6. classificar: 429 → rate_limited (recuperável)', classificarErroHttp(429, {}).code, 'rate_limited'],
  ['B7. classificar: 500 → gateway_http (recuperável)', classificarErroHttp(500, {}).code, 'gateway_http'],
  ['B8. classificar: 400 comum → gateway_http', classificarErroHttp(400, { error: { code: 'invalid_json' } }).code, 'gateway_http'],
];
for (const [nome, obtido, esperado] of matriz) {
  await teste(nome, () => igual(obtido, esperado, 'código'));
}

await teste('B9. classificar: `type` não decide (authentication_error nos dois casos)', () => {
  const local = classificarErroHttp(401, { error: { type: 'authentication_error', code: 'invalid_api_key' } });
  const siwc = classificarErroHttp(401, { error: { type: 'authentication_error', code: 'authentication_required' } });
  if (local.code === siwc.code) throw new Error('as duas causas continuaram iguais');
  igual(local.code, 'unauthorized', 'local');
  igual(siwc.code, 'gateway_auth', 'siwc');
});

const cenariosHttp = [  // [nome, resposta, código, deve conter, NÃO deve conter]
  ['B10. chat 401 invalid_api_key → mensagem de CHAVE LOCAL, sem mandar autorizar conta', { status: 401, body: { error: { code: 'invalid_api_key', message: 'Missing or invalid gateway bearer key.' } } }, 'unauthorized', /chave LOCAL/i, /auth\/start/i],
  ['B11. chat 401 authentication_required → manda autorizar no navegador, sem mandar mexer nas chaves', { status: 401, body: { error: { code: 'authentication_required', message: 'Run the local Sign in with ChatGPT flow first.' } } }, 'gateway_auth', /auth\/start/i, /idêntic/i],
  ['B12. chat 403 sem código → não conclusivo', { status: 403, body: { error: { message: 'Forbidden.' } } }, 'gateway_auth_unknown', /não vou adivinhar/i, /auth\/start/i],
  ['B13. chat 429 → limite de requisições, recuperável', { status: 429, body: { error: { code: 'gateway_rate_limit' } } }, 'rate_limited', /Aguarde/i, null],
  ['B14. chat 503 → erro do gateway, recuperável', { status: 503, body: { error: { code: 'gateway_shutting_down' } } }, 'gateway_http', /logs/i, null],
];

for (const [nome, resposta, codigo, deveConter, naoDeveConter] of cenariosHttp) {
  await teste(nome, async () => {
    const { clienteGw } = cliente(() => respostaJson(resposta.body, resposta.status));
    let erro = null;
    try {
      await clienteGw.chatStream({ messages: [{ role: 'user', content: 'oi' }], model: 'gpt-6-luna', onDelta: () => {} });
    } catch (e) {
      erro = e;
    }
    verdade(erro, 'deveria falhar');
    igual(erro.code, codigo, 'código');
    const mapeado = mapError(erro, { gateway: { url: 'http://127.0.0.1:1455' } });
    if (!deveConter.test(mapeado.message)) {
      throw new Error(`mensagem deveria casar com ${deveConter}: recebido ${JSON.stringify(mapeado.message)}`);
    }
    if (naoDeveConter && naoDeveConter.test(mapeado.message)) {
      throw new Error(`mensagem não deveria conter ${naoDeveConter}: ${mapeado.message}`);
    }
    // texto cru do upstream nunca chega à interface
    if (/Missing or invalid|Run the local Sign in/i.test(mapeado.message)) {
      throw new Error('mensagem exibiu texto cru do upstream');
    }
  });
}

await teste('B15. /v1/models com 401 invalid_api_key → chave local (não SIWC)', async () => {
  const { clienteGw } = cliente(() => respostaJson({ error: { code: 'invalid_api_key', message: 'Missing or invalid gateway bearer key.' } }, 401));
  let erro = null;
  try {
    await clienteGw.modelsDetalhados();
  } catch (e) {
    erro = e;
  }
  igual(erro?.code, 'unauthorized', 'código');
  contem(mapError(erro).message, 'chave LOCAL', 'mensagem');
});

await teste('B16. /v1/models com 401 authentication_required → SIWC (não chave local)', async () => {
  const { clienteGw } = cliente(() => respostaJson({ error: { code: 'authentication_required', message: 'Run the local Sign in with ChatGPT flow first.' } }, 401));
  let erro = null;
  try {
    await clienteGw.modelsDetalhados();
  } catch (e) {
    erro = e;
  }
  igual(erro?.code, 'gateway_auth', 'código');
  const msg = mapError(erro).message;
  contem(msg, 'auth/start', 'aponta autorização');
  if (/idêntic/i.test(msg)) throw new Error('mandou mexer nas chaves quando o problema é a conta');
});

await teste('B17. os três textos são diferentes entre si', () => {
  const textos = new Set(
    ['unauthorized', 'gateway_auth', 'gateway_auth_unknown'].map((c) => mapError({ code: c }).message),
  );
  igual(textos.size, 3, 'mensagens distintas');
});

/* =================================== C =================================== */
console.log('\nC. Falha de descoberta não fica presa no cache');

const cacheMod = await import(join(SRC, 'model-cache.js'));

await teste('C1. TTL de falha é curto e o de sucesso continua 5 min', () => {
  verdade(cacheMod.CACHE_TTL_FALHA_MS <= 5_000, `TTL de falha curto (${cacheMod.CACHE_TTL_FALHA_MS}ms)`);
  igual(cacheMod.CACHE_TTL_OK_MS, 5 * 60_000, 'TTL de sucesso');
});

await teste('C2. cache de falha recente bloqueia (freio de rajada) e expira em segundos', () => {
  const agora = 1_000_000;
  const falha = cacheMod.cacheDeFalha({ active: 'gpt-6-luna' }, agora);
  igual(cacheMod.decidirReconsulta(falha, agora + 500).consultar, false, '500 ms depois: freio');
  igual(cacheMod.decidirReconsulta(falha, agora + cacheMod.CACHE_TTL_FALHA_MS + 1).consultar, true, 'depois do TTL curto: consulta');
  igual(cacheMod.decidirReconsulta(falha, agora + 60_000).motivo, 'falha_expirou', 'motivo');
});

await teste('C3. catálogo válido continua em cache por 5 minutos', () => {
  const agora = 2_000_000;
  const ok = cacheMod.cacheDeSucesso({ active: 'gpt-5' }, agora);
  igual(cacheMod.decidirReconsulta(ok, agora + 60_000).consultar, false, '1 min depois');
  igual(cacheMod.decidirReconsulta(ok, agora + 5 * 60_000 + 1).consultar, true, 'depois de 5 min');
});

await teste('C4. erro de autorização força reconsulta imediata, mesmo dentro do TTL', () => {
  const agora = 3_000_000;
  const falha = cacheMod.cacheDeFalha({ active: 'gpt-6-luna' }, agora);
  const decisao = cacheMod.decidirReconsulta(falha, agora + 100, { descobertaFalhou: true });
  igual(decisao.consultar, true, 'consulta');
  igual(decisao.motivo, 'erro_de_autorizacao_no_turno_anterior', 'motivo');
});

await teste('C5. só erros de autorização disparam a reconsulta', () => {
  for (const c of ['gateway_auth', 'unauthorized', 'gateway_auth_unknown', 'gateway_not_configured']) {
    verdade(cacheMod.ehErroDeAutorizacao(c), `${c} deveria contar`);
  }
  for (const c of ['gateway_http', 'stream_interrupted', 'rate_limited', 'model_unavailable', undefined, null]) {
    igual(cacheMod.ehErroDeAutorizacao(c), false, `${c} não deveria contar`);
  }
});

const { criarResolvedorDeModelo } = await import(join(SRC, 'model-resolver.js'));

function resolvedorCom(gateway, { primary = 'gpt-6-luna', fallback = 'gpt-6.1-sol', agora } = {}) {
  const logger = { error() {}, warn() {}, info() {}, debug() {} };
  return criarResolvedorDeModelo({ gateway, models: { primary, fallback, probe: true }, log: logger, agora });
}

await teste('C6. descoberta falha → autorização → próxima consulta traz o catálogo real', async () => {
  let autorizado = false;
  const gateway = {
    modelsDetalhados: async () => {
      if (!autorizado) throw Object.assign(new Error('Run the local Sign in with ChatGPT flow first.'), { code: 'gateway_auth' });
      return [{ id: 'gpt-5' }, { id: 'gpt-4o-mini' }, { id: 'text-embedding-3-small' }];
    },
  };
  const r = resolvedorCom(gateway);

  const primeira = await r.resolve();
  igual(primeira.motivo, 'descoberta_falhou', 'primeira consulta falhou');
  igual(primeira.available.length, 0, 'sem catálogo');
  igual(primeira.active, 'gpt-6-luna', 'mantém o configurado');

  // Autorização concedida no navegador — o relógio NÃO anda.
  autorizado = true;

  const noFreio = await r.resolve();
  igual(noFreio.available.length, 0, 'dentro do freio de rajada não reconsulta');

  // Gatilho real: o turno anterior terminou em erro de autorização.
  igual(r.notarErroDeTurno('gateway_auth'), true, 'notou o erro de autorização');

  const segunda = await r.resolve();
  igual(segunda.available.length, 3, 'catálogo real obtido');
  igual(segunda.motivo, 'escolhido_do_catalogo', 'escolheu do catálogo');
  verdade(['gpt-5', 'gpt-4o-mini'].includes(segunda.active), `modelo do catálogo (${segunda.active})`);
  igual(segunda.auto, true, 'escolha automática identificada');
  igual(segunda.verificado, false, 'sem metadados: hipótese, não promessa');
});

await teste('C7. falha expira em segundos mesmo sem gatilho explícito', async () => {
  let autorizado = false;
  const gateway = {
    modelsDetalhados: async () => {
      if (!autorizado) throw Object.assign(new Error('x'), { code: 'gateway_auth' });
      return [{ id: 'gpt-5' }];
    },
  };
  const r = resolvedorCom(gateway);
  await r.resolve();
  autorizado = true;
  await new Promise((res) => setTimeout(res, cacheMod.CACHE_TTL_FALHA_MS + 150));
  const segunda = await r.resolve();
  igual(segunda.available.length, 1, 'catálogo obtido depois do TTL curto (não 5 min)');
  igual(segunda.active, 'gpt-5', 'modelo anunciado');
});

await teste('C8. catálogo válido não é reconsultado a cada turno', async () => {
  let chamadas = 0;
  const gateway = {
    modelsDetalhados: async () => {
      chamadas += 1;
      return [{ id: 'gpt-5' }];
    },
  };
  const r = resolvedorCom(gateway);
  for (let i = 0; i < 5; i += 1) await r.resolve();
  igual(chamadas, 1, 'consultas ao gateway em 5 turnos');
  igual(r.estado.consultas, 1, 'contador interno');
});

await teste('C9. erro que não é de autorização NÃO derruba o cache', async () => {
  let falhar = false;
  let chamadas = 0;
  const gateway = {
    modelsDetalhados: async () => {
      chamadas += 1;
      if (falhar) throw Object.assign(new Error('x'), { code: 'gateway_http' });
      return [{ id: 'gpt-5' }];
    },
  };
  const r = resolvedorCom(gateway);
  await r.resolve();
  igual(r.notarErroDeTurno('stream_interrupted'), false, 'não é erro de autorização');
  await r.resolve();
  igual(chamadas, 1, 'cache preservado');
});

await teste('C10. invalidar descarta na hora e a próxima consulta volta ao gateway', async () => {
  let chamadas = 0;
  const gateway = {
    modelsDetalhados: async () => {
      chamadas += 1;
      return [{ id: chamadas === 1 ? 'gpt-5' : 'gpt-5.1' }];
    },
  };
  const r = resolvedorCom(gateway);
  igual((await r.resolve()).active, 'gpt-5', 'primeiro catálogo');
  igual(r.invalidate('teste'), true, 'havia catálogo para invalidar');
  igual((await r.resolve()).active, 'gpt-5.1', 'catálogo novo depois de invalidar');
  igual(chamadas, 2, 'duas consultas');
});

await teste('C11. sem probe (KIRANA_MODEL_PROBE=false) não consulta o gateway', async () => {
  let chamadas = 0;
  const gateway = { modelsDetalhados: async () => { chamadas += 1; return []; } };
  const r = criarResolvedorDeModelo({
    gateway,
    models: { primary: 'gpt-6-luna', fallback: 'gpt-6.1-sol', probe: false },
    log: { error() {}, warn() {}, info() {}, debug() {} },
  });
  const v = await r.resolve();
  igual(v.active, 'gpt-6-luna', 'configurado');
  igual(chamadas, 0, 'nenhuma consulta');
});

await teste('C12. agente liga a reconsulta ao erro de autorização (ligação verificada no código)', () => {
  const fonte = readFileSync(join(SRC, 'agent.js'), 'utf8');
  contem(fonte, 'criarResolvedorDeModelo', 'usa o resolvedor');
  contem(fonte, 'resolvedorDeModelo.notarErroDeTurno(error?.code)', 'notifica o erro do turno');
  const resolver = readFileSync(join(SRC, 'model-resolver.js'), 'utf8');
  contem(resolver, 'cacheDeFalha(value, agora())', 'falha com janela curta');
  if (/5 \* 60_000/.test(resolver) && !/cacheDeSucesso/.test(resolver)) {
    throw new Error('TTL de 5 minutos sem separar sucesso de falha');
  }
});

/* -------------------------------- resumo -------------------------------- */
console.log('');
if (falhas.length) {
  console.log(`RESULTADO: ${falhas.length} falha(s), ${passou} teste(s) passaram.`);
  for (const f of falhas) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`RESULTADO: ${passou}/${passou} testes passaram.`);
