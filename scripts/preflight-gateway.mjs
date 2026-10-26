#!/usr/bin/env node
/**
 * Homologação do Gateway REAL — sondas read-only (e uma chamada opcional).
 *
 * Por que existe
 * --------------
 * Até aqui toda a evidência de integração vinha do gateway SIMULADO. Este
 * script fala com o Gateway ChatGPT local de verdade (`GATEWAY_API_KEY` do
 * `.env` dele), na porta em que ele já roda, e verifica **exatamente** o que a
 * Kirana depende:
 *
 *   1. `GET /health`            — o processo está de pé?
 *   2. `GET /auth/status`       — a conta ChatGPT está autorizada (escopos)?
 *   3. `GET /v1/models`         — os slugs configurados existem nesta conta?
 *   4. `GET /v1/capabilities`   — o que o Gateway declara saber fazer
 *                                 (confirmar: NÃO existe busca web)
 *   5. `POST /v1/chat/completions` com ferramenta declarada — o nome volta como
 *      `gateway.<nome>`? (é este formato que a v0.5.2 normaliza)
 *   6. round-trip da ferramenta (role `tool` + `tool_call_id`) — o modelo
 *      responde texto depois de receber o resultado?
 *   7. rigor de payload — campo não suportado (`temperature`) volta como 400
 *      `unsupported_parameter`?
 *
 * As sondas 1–4 e 7 não gastam uso da conta. As sondas 5 e 6 fazem UMA chamada
 * de modelo cada (duas no total) e por isso só rodam com `--live`.
 *
 * Regras de segurança (não negociáveis):
 *   - a chave do Gateway nunca é impressa, logada ou gravada: só "presente";
 *   - nada de corpo de requisição com dados do usuário, nada de token OAuth;
 *   - fala SÓ com `KIRANA_GATEWAY_URL` (loopback por padrão). O Gateway não é
 *     exposto, não é alterado e não é reiniciado por este script.
 *
 * Uso:
 *   node scripts/preflight-gateway.mjs              # read-only (sem custo)
 *   node scripts/preflight-gateway.mjs --live       # inclui as 2 chamadas
 *   node scripts/preflight-gateway.mjs --live --out homologacao/preflight.json
 *
 * Saída: relatório no console + arquivo JSON sem segredos. Código de saída 1 se
 * qualquer sonda falhar (serve para `if errorlevel` no Windows).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
/** Aceita `--nome=valor` e `--nome valor` (uso típico no .bat do Windows). */
const value = (name, fallback = '') => {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.split('=').slice(1).join('=');
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
  return fallback;
};

const LIVE = flag('live');
const OUT = value('out', path.join(ROOT, 'homologacao', `preflight-gateway-${stamp()}.json`));
const TIMEOUT_MS = Number(value('timeout', '30000'));

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const results = [];
function record(id, status, summary, detail = null) {
  results.push({ id, status, summary, detail });
  const tag = status === 'ok' ? '[OK]  ' : status === 'warn' ? '[!!]  ' : status === 'skip' ? '[--]  ' : '[XX]  ';
  console.log(`${tag}${summary}`);
  if (detail && status !== 'ok') console.log(`       ${detail}`);
}

const mask = (text) => String(text ?? '').replace(/[A-Za-z0-9_-]{24,}/g, '<omitido>');

async function main() {
  console.log('=== Preflight do Gateway real (Kirana) ===\n');

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    record('config', 'fail', 'Configuração inválida.', error.message);
    return finish(null);
  }

  const base = String(config.gateway.url || '').replace(/\/+$/, '');
  const hasKey = Boolean(config.gateway.apiKey);

  console.log(`Gateway: ${base}`);
  console.log(`Chave:   ${hasKey ? `presente (${config.gateway.apiKey.length} caracteres, não exibida)` : 'AUSENTE'}`);
  console.log(`Modelos: primário=${config.models.primary} | fallback=${config.models.fallback}`);
  console.log(`Modo:    ${LIVE ? 'com 2 chamadas de modelo (--live)' : 'read-only (sem gasto de uso)'}\n`);

  if (!hasKey) {
    record('key', 'fail', 'KIRANA_GATEWAY_API_KEY vazia: o Gateway vai responder 401.', 'Copie a GATEWAY_API_KEY do .env do Gateway para o .env da Kirana.');
    return finish(config);
  }

  /* --------------------------------- 1. /health ------------------------- */
  const health = await request(config, '/health', { auth: false });
  if (!health.ok) {
    record('health', 'fail', 'GET /health não respondeu.', health.error);
    return finish(config, { unreachable: true });
  }
  record(
    'health',
    health.body?.status === 'ok' ? 'ok' : 'warn',
    `GET /health -> ${health.status} (status=${health.body?.status ?? '?'}, authenticated=${health.body?.authenticated ?? 'não informado'}, versão=${health.body?.version ?? '?'})`,
  );
  if (health.body?.authenticated === false) {
    record(
      'auth-consent',
      'fail',
      'O Gateway está sem sessão ChatGPT autorizada (authenticated=false).',
      'Abra http://127.0.0.1:1455/auth/start no navegador do dono da conta e conclua o consentimento. Sem isso, nenhuma chamada de modelo funciona.',
    );
  }

  /* ------------------------------ 2. /auth/status ----------------------- */
  const status = await request(config, '/auth/status');
  if (status.ok) {
    const scopes = status.body?.grantedScopes ?? status.body?.scopes ?? [];
    const scopeNames = Array.isArray(scopes) ? scopes.map(String) : [];
    const direct = scopeNames.some((s) => s.includes('chatgpt.tokens.use.direct'));
    record(
      'auth-status',
      direct || scopeNames.length === 0 ? 'ok' : 'warn',
      `GET /auth/status -> ${status.status} (escopos: ${scopeNames.length ? scopeNames.join(', ') : 'não informados'})`,
      direct || scopeNames.length === 0 ? null : 'Escopo chatgpt.tokens.use.direct não apareceu na lista.',
    );
  } else {
    record('auth-status', status.status === 404 ? 'warn' : 'fail', `GET /auth/status -> ${status.status}.`, status.error);
  }

  /* ------------------------------ 3. /v1/models ------------------------- */
  const models = await request(config, '/v1/models');
  if (!models.ok) {
    record('models', 'fail', `GET /v1/models -> ${models.status}.`, models.error);
  } else {
    const list = Array.isArray(models.body?.data) ? models.body.data : Array.isArray(models.body) ? models.body : [];
    const slugs = list.map((item) => (typeof item === 'string' ? item : item?.id)).filter(Boolean);
    const primary = slugs.includes(config.models.primary);
    const fallback = slugs.includes(config.models.fallback);
    record(
      'models',
      primary ? 'ok' : 'fail',
      `GET /v1/models -> ${slugs.length} modelo(s): ${slugs.join(', ') || 'nenhum'}`,
      primary ? null : `O modelo primário "${config.models.primary}" não está nesta conta. Ajuste KIRANA_PRIMARY_MODEL para um dos slugs acima.`,
    );
    record(
      'models-fallback',
      fallback ? 'ok' : 'warn',
      `Fallback "${config.models.fallback}" ${fallback ? 'disponível' : 'NÃO disponível nesta conta'}.`,
      fallback ? null : 'Sem fallback, uma falha do primário encerra o turno. Escolha outro slug ou deixe KIRANA_ALLOW_FALLBACK=false.',
    );
  }

  /* --------------------------- 4. /v1/capabilities ----------------------- */
  const caps = await request(config, '/v1/capabilities');
  if (!caps.ok) {
    record('capabilities', caps.status === 404 ? 'warn' : 'fail', `GET /v1/capabilities -> ${caps.status}.`, caps.error);
  } else {
    const ids = collectCapabilityIds(caps.body);
    const web = ids.filter((id) => /web|search|browse|crawl|fetch_url/i.test(id));
    record('capabilities', web.length ? 'warn' : 'ok', `Capacidades declaradas: ${ids.join(', ') || '(nenhuma)'}`, null);
    record(
      'no-web-search',
      web.length ? 'warn' : 'ok',
      web.length
        ? `O Gateway declara capacidade de busca: ${web.join(', ')} — revisar antes de prometer pesquisa.`
        : 'Confirmado: o Gateway não declara busca/pesquisa web. A Kirana não deve prometer pesquisa.',
    );
  }

  /* --------------------- 7. rigor de payload (sem custo) ---------------- */
  const strict = await request(config, '/v1/chat/completions', {
    method: 'POST',
    body: { model: config.models.primary, messages: [{ role: 'user', content: 'ping' }], temperature: 0.5, stream: false },
  });
  if (strict.ok) {
    record('payload-strict', 'warn', 'O Gateway aceitou "temperature": os campos opcionais da Kirana podem ser ligados (KIRANA_SEND_TEMPERATURE).');
  } else if (strict.status === 400) {
    const code = strict.body?.error?.code ?? '';
    record(
      'payload-strict',
      code === 'unsupported_parameter' ? 'ok' : 'warn',
      `O Gateway recusou "temperature" com 400 ${code || '(sem código)'} — mantenha KIRANA_SEND_TEMPERATURE=false.`,
    );
  } else {
    record('payload-strict', 'warn', `Resposta inesperada ao campo extra: ${strict.status}.`, strict.error);
  }

  /* ------------------- 5 e 6. streaming + tool call (custa uso) --------- */
  if (!LIVE) {
    record('stream-tool', 'skip', 'Sonda de streaming/ferramenta não executada (use --live).');
    record('tool-roundtrip', 'skip', 'Round-trip de ferramenta não executado (use --live).');
    return finish(config);
  }

  const toolCall = await probeToolCall(config);
  record(
    'stream-tool',
    toolCall.ok ? 'ok' : 'fail',
    toolCall.ok
      ? `Chamada de ferramenta voltou como "${toolCall.name}" (TTFT ${toolCall.ttftMs} ms)`
      : 'Não foi possível completar a sonda de ferramenta.',
    toolCall.ok ? null : toolCall.error,
  );
  if (toolCall.ok && !String(toolCall.name).startsWith('gateway.')) {
    record('namespace', 'warn', `O nome voltou SEM o prefixo "gateway." ("${toolCall.name}") — a Kirana aceita os dois formatos, mas isso indica um Gateway diferente do v0.4.x.`);
  } else if (toolCall.ok) {
    record('namespace', 'ok', 'O nome da ferramenta voltou com o namespace do Gateway (gateway.<nome>) — é o formato que a v0.5.2 normaliza.');
  }

  if (toolCall.ok) {
    const roundtrip = await probeRoundtrip(config, toolCall);
    record(
      'tool-roundtrip',
      roundtrip.ok ? 'ok' : 'fail',
      roundtrip.ok ? `Round-trip concluído; resposta final com ${roundtrip.chars} caracteres.` : 'Round-trip da ferramenta falhou.',
      roundtrip.ok ? null : roundtrip.error,
    );
  }

  return finish(config);
}

/* ------------------------------- utilidades ----------------------------- */

function collectCapabilityIds(payload) {
  const found = new Set();
  const walk = (node, depth = 0) => {
    if (!node || depth > 4) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, depth + 1));
      return;
    }
    for (const [key, val] of Object.entries(node)) {
      if ((key === 'id' || key === 'name' || key === 'capability') && typeof val === 'string') found.add(val);
      else walk(val, depth + 1);
    }
  };
  walk(payload);
  return [...found];
}

async function request(config, pathname, { method = 'GET', body = null, auth = true } = {}) {
  const url = `${String(config.gateway.url).replace(/\/+$/, '')}${pathname}`;
  const headers = { accept: 'application/json' };
  if (auth) headers.authorization = `Bearer ${config.gateway.apiKey}`;
  if (body) headers['content-type'] = 'application/json';
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      body: parsed,
      error: response.ok ? null : `${parsed?.error?.code ?? ''} ${parsed?.error?.message ?? mask(text).slice(0, 200)}`.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error?.name === 'TimeoutError'
        ? `Tempo esgotado (${TIMEOUT_MS} ms) ao falar com ${url}.`
        : `Não foi possível alcançar ${url}: ${error?.cause?.code || error?.message}`,
    };
  }
}

/** Sonda 5: streaming com uma ferramenta declarada e inofensiva. */
async function probeToolCall(config) {
  const url = `${String(config.gateway.url).replace(/\/+$/, '')}/v1/chat/completions`;
  const payload = {
    model: config.models.primary,
    stream: true,
    messages: [
      {
        role: 'system',
        content: 'Você é um verificador de contrato. Use a ferramenta consultar_status_projeto. Não escreva texto antes da chamada.',
      },
      { role: 'user', content: 'Consulte o status do projeto pelo identificador verificacao-contrato.' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'consultar_status_projeto',
          description: 'Consulta simulada e inofensiva usada apenas para validar o contrato.',
          parameters: { type: 'object', properties: { projeto: { type: 'string' } }, required: ['projeto'] },
        },
      },
    ],
  };

  const startedAt = Date.now();
  let ttftMs = null;
  let name = '';
  let argsText = '';
  let sawDone = false;
  let error = null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${config.gateway.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `HTTP ${response.status}: ${mask(text).slice(0, 200)}` };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') {
          sawDone = true;
          continue;
        }
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk?.error) error = mask(JSON.stringify(chunk.error)).slice(0, 200);
        const delta = chunk?.choices?.[0]?.delta;
        if (delta && ttftMs === null) ttftMs = Date.now() - startedAt;
        for (const call of delta?.tool_calls ?? []) {
          if (call?.function?.name) name = call.function.name;
          if (call?.function?.arguments) argsText += call.function.arguments;
        }
      }
      if (sawDone) break;
    }
  } catch (caught) {
    return { ok: false, error: `Falha de rede/timeout: ${caught?.cause?.code || caught?.message}` };
  }

  if (!name) return { ok: false, error: error || 'O modelo não devolveu chamada de ferramenta (pode ter respondido em texto).' };
  if (!sawDone) return { ok: false, error: 'O stream terminou sem [DONE].' };
  return { ok: true, name, args: argsText, ttftMs: ttftMs ?? Date.now() - startedAt, callId: `call_preflight_${Date.now()}` };
}

/** Sonda 6: devolve o resultado da ferramenta e espera texto final. */
async function probeRoundtrip(config, previous) {
  const url = `${String(config.gateway.url).replace(/\/+$/, '')}/v1/chat/completions`;
  const payload = {
    model: config.models.primary,
    stream: true,
    messages: [
      { role: 'system', content: 'Você é um verificador de contrato.' },
      { role: 'user', content: 'Consulte o status do projeto verificacao-contrato.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: previous.callId, type: 'function', function: { name: previous.name, arguments: previous.args || '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: previous.callId,
        content: JSON.stringify({ ok: true, dados: { projeto: 'verificacao-contrato', estado: 'em_andamento' } }),
      },
    ],
  };

  let chars = 0;
  let sawDone = false;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${config.gateway.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `HTTP ${response.status}: ${mask(text).slice(0, 200)}` };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          sawDone = true;
          continue;
        }
        if (!data) continue;
        try {
          const chunk = JSON.parse(data);
          chars += String(chunk?.choices?.[0]?.delta?.content ?? '').length;
        } catch {
          /* linha não-JSON é ignorada */
        }
      }
      if (sawDone) break;
    }
  } catch (caught) {
    return { ok: false, error: `Falha de rede/timeout: ${caught?.cause?.code || caught?.message}` };
  }
  if (!sawDone) return { ok: false, error: 'Stream sem [DONE] no round-trip.' };
  if (chars === 0) return { ok: false, error: 'O modelo não devolveu texto depois do resultado da ferramenta.' };
  return { ok: true, chars };
}

function finish(config, extra = {}) {
  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');
  const skipped = results.filter((r) => r.status === 'skip');

  const report = {
    kind: 'preflight-gateway',
    generatedAt: new Date().toISOString(),
    live: LIVE,
    gatewayUrl: config?.gateway?.url ?? null,
    // Nunca a chave. Só a informação de que existe.
    keyPresent: Boolean(config?.gateway?.apiKey),
    primaryModel: config?.models?.primary ?? null,
    fallbackModel: config?.models?.fallback ?? null,
    ...extra,
    summary: { ok: results.filter((r) => r.status === 'ok').length, warn: warnings.length, fail: failures.length, skip: skipped.length },
    results,
  };

  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.log(`\n[--]  Não foi possível gravar o relatório em ${OUT}: ${error.message}`);
  }

  console.log('\n--- Resumo ---');
  console.log(`OK: ${report.summary.ok} | avisos: ${warnings.length} | falhas: ${failures.length} | ignoradas: ${skipped.length}`);
  if (failures.length) {
    console.log('\nFalhas que impedem declarar a integração:');
    for (const failure of failures) console.log(`  - ${failure.summary}${failure.detail ? `\n    ${failure.detail}` : ''}`);
  }
  if (skipped.length) console.log('\nLembrete: rodar com --live para validar streaming e ferramenta (gasta 2 chamadas de modelo).');
  console.log(`\nRelatório: ${path.relative(ROOT, OUT)}`);
  console.log(failures.length ? '\nRESULTADO: REPROVADO' : '\nRESULTADO: APROVADO (no que este script cobre)');

  process.exitCode = failures.length ? 1 : 0;
  return report;
}

main().catch((error) => {
  console.error(`\n[XX]  Erro inesperado no preflight: ${error?.message}`);
  process.exitCode = 1;
});
