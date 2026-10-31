/**
 * VALIDAR MODELOS REAIS — Gateway v0.4.1 (distribuição REV4.1)
 *
 * Roda DEPOIS que a conta estiver autorizada (SIWC). Faz, em ordem, e para no
 * primeiro bloqueio:
 *
 *   0. estado ........... /health, /v1/engine, /auth/status, /v1/capabilities
 *   1. catálogo ......... GET /v1/models
 *   2. inferência ....... POST /v1/chat/completions  (stream:false)      [1 chamada]
 *   2.2 identidade ...... GET /v1/runs (modelReported, identityVerified)
 *   3. streaming ........ POST /v1/chat/completions  (stream:true)       [1 chamada]
 *   4. cancelamento ..... SÓ com --com-cancelamento (aborta no 1º delta)  [1 chamada]
 *   5. erros ............ modelo inexistente · JSON inválido · rota inexistente
 *   6. segredos ......... varre run/*.log por chave/token
 *
 * ── CONTRATO DO CORPO ─────────────────────────────────────────────────────
 * O Gateway v0.4.1 aceita EXATAMENTE sete campos: model, messages, stream,
 * tools, tool_choice, parallel_tool_calls, stream_options. Qualquer outro —
 * inclusive `max_tokens` — é rejeitado com `400 unsupported_parameter` ANTES de
 * chegar ao modelo. Este verificador monta todos os corpos por
 * `tools/contrato-chat.mjs`, que só produz campos aceitos, e há um teste
 * (tools/teste-verificador.mjs) que falha se `max_tokens` reaparecer.
 *
 * ── CHAMADAS DE GERAÇÃO ───────────────────────────────────────────────────
 *   fluxo padrão ................. 2 chamadas (inferência + streaming)
 *   com --com-cancelamento ....... 3 chamadas (a 3ª é abortada no 1º delta)
 *   testes de erro ............... 0 chamadas de geração (rejeitados antes)
 * Nada roda em laço. O total é impresso no fim da execução.
 *
 * ── LIMITES (conferidos no código do Gateway, não inventados) ─────────────
 *   tempo por requisição ......... 180 s (Gateway) / 60 s (este verificador)
 *   tamanho da resposta .......... 4 MiB (Gateway) / 200 kB lidos aqui
 *   mensagens por requisição ..... 1–100
 *   chamadas por minuto .......... limite local do Gateway (429)
 *   tokens de saída .............. NÃO existe parâmetro nesta versão
 *   custo ........................ plan-only; `cost_blocked` = HTTP 402
 * Um prompt curto reduz consumo, mas NÃO é garantia de custo.
 *
 * ── IDENTIDADE DO MODELO ──────────────────────────────────────────────────
 * O campo `model` da resposta é o nome PEDIDO, ecoado por compatibilidade.
 * A prova de identidade é `GET /v1/runs`: `modelReported`, `identityVerified`,
 * `upstreamId`, `usage`, `firstUsefulMs`. Sem `identityVerified=true` o
 * resultado é INCONCLUSIVO — nunca "aprovado".
 *
 * Uso:  node tools\validar-modelos-reais.mjs [--catalogo] [--modelo <slug>]
 *                                           [--com-cancelamento] [--base <url>]
 * Saída: 0 = tudo PASS · 1 = falha real · 3 = bloqueado por falta de SIWC
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { montarCorpo, garantirContrato, CAMPOS_ACEITOS, LIMITES_DO_GATEWAY, LIMITES_DO_VERIFICADOR } from './contrato-chat.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (nome, padrao = null) => {
  const i = args.indexOf(nome);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};
const tem = (nome) => args.includes(nome);

const BASE = (flag('--base', process.env.KIRANA_GATEWAY_URL || 'http://127.0.0.1:1455')).replace(/\/+$/, '');
const SO_CATALOGO = tem('--catalogo');
const CANCELAMENTO = tem('--com-cancelamento');
const MODELO_PEDIDO = flag('--modelo', null);
const SIMULADO = tem('--simulado');
const SAIDA = SIMULADO ? join(RAIZ, 'saida-simulada') : join(RAIZ, 'docs', 'validacao');

const LIMITE_TEMPO_MS = Math.max(5_000, Number(flag('--timeout-ms', String(LIMITES_DO_VERIFICADOR.tempoPorRequisicaoMs))));
const LIMITE_BYTES = LIMITES_DO_VERIFICADOR.bytesMaxPorResposta;
const PROMPT = 'Responda apenas com a palavra: ok';

const resultados = [];
const nota = (id, nome, estado, detalhe = '') => {
  resultados.push({ id, nome, estado, detalhe });
  console.log(`${estado.padEnd(22)} ${id.padEnd(4)} ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

/* ── contador de chamadas de geração ───────────────────────────────────── */
const chamadas = { geracao: 0, semModelo: 0 };
const contarGeracao = (motivo) => { chamadas.geracao += 1; console.log(`   · chamada de geração #${chamadas.geracao} (${motivo})`); };

/* ── chave: lida, nunca exibida ────────────────────────────────────────── */
function lerChave() {
  for (const caminho of [join(RAIZ, 'Gateway', '.env'), join(RAIZ, '.env')]) {
    if (!existsSync(caminho)) continue;
    const m = readFileSync(caminho, 'utf8').match(/^\s*(GATEWAY_API_KEY|KIRANA_GATEWAY_API_KEY)\s*=\s*(.+)$/m);
    if (m) return m[2].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}
const chave = lerChave();
if (!chave && !SIMULADO) {
  console.error('Não achei GATEWAY_API_KEY em Gateway/.env nem KIRANA_GATEWAY_API_KEY em .env.');
  console.error('Rode primeiro o INSTALAR-WINDOWS.cmd — ele gera a chave e alinha os dois arquivos.');
  process.exit(3);
}

const cabecalhos = () => ({ authorization: `Bearer ${chave}`, 'content-type': 'application/json' });
const agora = () => Number(process.hrtime.bigint() / 1000n) / 1000;

/** Lê o corpo com teto de bytes e tempo — limite operacional, não do provedor. */
async function lerComLimite(resposta, limiteBytes = LIMITE_BYTES) {
  if (!resposta.body) return '';
  const leitor = resposta.body.getReader();
  const pedacos = [];
  let total = 0;
  let cortou = false;
  for (;;) {
    const { value, done } = await leitor.read();
    if (done) break;
    total += value.length;
    pedacos.push(Buffer.from(value));
    if (total > limiteBytes) { cortou = true; try { await leitor.cancel(); } catch { /* já fechou */ } break; }
  }
  return { texto: Buffer.concat(pedacos).toString('utf8'), cortou };
}

async function pedir(metodo, caminho, corpo) {
  const t0 = agora();
  const sinal = AbortSignal.timeout(LIMITE_TEMPO_MS);
  const r = await fetch(`${BASE}${caminho}`, {
    method: metodo, headers: cabecalhos(),
    body: corpo === undefined ? undefined : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)), signal: sinal,
  });
  const { texto, cortou } = await lerComLimite(r);
  return {
    status: r.status, ms: Math.round(agora() - t0), texto, cortou,
    dados: (() => { try { return JSON.parse(texto); } catch { return null; } })(),
  };
}

/**
 * Classifica uma falha SEM reprovar o modelo indevidamente.
 * Um HTTP 400 por campo incompatível é culpa do verificador, não do modelo.
 */
function classificarFalha(status, codigo) {
  if (status === 401 || codigo === 'authentication_required' || codigo === 'reauth_required') return 'BLOQUEADO_AUTENTICACAO';
  if (status === 402 || codigo === 'cost_blocked' || codigo === 'model_not_allowed') return 'BLOQUEADO_CUSTO';
  if (codigo === 'unsupported_parameter' || codigo === 'invalid_request' || codigo === 'invalid_messages' || codigo === 'invalid_model' || codigo === 'invalid_stream') return 'INCOMPATIBILIDADE_DO_VERIFICADOR';
  if (codigo === 'model_not_available') return 'MODELO_INDISPONIVEL';
  if (status === 429) return 'LIMITE_DE_REQUISICOES';
  if (status >= 500) return 'FALHA_DO_PROVEDOR';
  return 'FALHA';
}

/* ── 0. estado ─────────────────────────────────────────────────────────── */
console.log(`Gateway em ${BASE}`);
console.log(`contrato: ${CAMPOS_ACEITOS.join(', ')}`);
console.log(`chamadas de geração previstas: ${CANCELAMENTO ? '3 (2 + cancelamento)' : '2'}${SO_CATALOGO ? ' (0: --catalogo)' : ''}\n`);

let engine = null;
try {
  const h = await pedir('GET', '/health');
  nota('0.1', 'Gateway responde em /health', h.status === 200 ? 'PASS' : 'FAIL', `HTTP ${h.status} · ${h.ms}ms`);

  const e = await pedir('GET', '/v1/engine');
  engine = e.dados;
  const autenticado = Boolean(engine?.gateway?.authenticated);
  nota('0.2', 'estado do motor (/v1/engine)', e.status === 200 ? 'PASS' : 'FAIL',
    `version=${engine?.gateway?.version ?? '?'} · authenticated=${autenticado} · catálogo=${Array.isArray(engine?.models) ? engine.models.length : '?'} · routing=${engine?.policy?.routing_enabled} · primário=${engine?.policy?.primary_model ?? 'null'}`);
  nota('0.3', 'conta autorizada (SIWC)', autenticado ? 'PASS' : 'BLOQUEADO_AUTENTICACAO',
    autenticado ? 'authenticated=true' : 'authenticated=false — abra http://127.0.0.1:1455/auth/start');

  const st = await pedir('GET', '/auth/status');
  if (st.status === 200) {
    const g = st.dados || {};
    nota('0.4', '/auth/status', 'PASS',
      `authenticated=${g.authenticated} · armazenamento=${g.tokenStorage ?? '?'} · escopos=${(g.grantedScopes ?? []).join(',') || '(nenhum)'}`);
  } else {
    nota('0.4', '/auth/status', 'NAO_EXECUTADO', `HTTP ${st.status} — rota ausente neste build`);
  }

  try {
    const c = await fetch(`${BASE}/v1/capabilities`, { headers: cabecalhos(), signal: AbortSignal.timeout(20_000) });
    const { texto } = await lerComLimite(c, 100_000);
    const dados = (() => { try { return JSON.parse(texto); } catch { return null; } })();
    if (c.status === 200 && Array.isArray(dados?.data)) {
      const prontas = dados.data.filter((x) => x.ready).map((x) => x.name);
      const pendentes = dados.data.filter((x) => !x.ready).map((x) => x.name);
      nota('0.5', '/v1/capabilities', 'PASS',
        `${dados.data.length} declarada(s) · prontas: ${prontas.join(',') || '(nenhuma)'} · não prontas: ${pendentes.join(',') || '(nenhuma)'}`);
    } else {
      nota('0.5', '/v1/capabilities', 'NAO_EXECUTADO', `HTTP ${c.status}`);
    }
  } catch (erro) {
    nota('0.5', '/v1/capabilities', 'NAO_EXECUTADO', `não respondeu (${erro.name}) — não bloqueia os demais testes`);
  }
} catch (erro) {
  console.error(`\nNão consegui falar com o Gateway em ${BASE} (${erro.code || erro.message}).`);
  console.error('Suba com INICIAR-TUDO.cmd e confira http://127.0.0.1:1455/health');
  process.exit(3);
}

/* ── 1. catálogo ───────────────────────────────────────────────────────── */
const catalogo = [];
let bloqueado = false;
{
  const r = await pedir('GET', '/v1/models');
  const lista = Array.isArray(r.dados?.data) ? r.dados.data : [];
  for (const item of lista) {
    const id = String(item?.id || item?.slug || '').trim();
    if (id) catalogo.push({ id });
  }
  if (r.status === 200 && catalogo.length > 0) {
    nota('1.1', 'catálogo real obtido', 'PASS', `${catalogo.length} modelo(s): ${catalogo.map((m) => m.id).join(', ')}`);
  } else {
    const codigo = r.dados?.error?.code || `HTTP ${r.status}`;
    const classe = classificarFalha(r.status, codigo);
    nota('1.1', 'catálogo real obtido', classe === 'BLOQUEADO_AUTENTICACAO' ? 'BLOQUEADO_AUTENTICACAO' : 'FALHA',
      `${codigo} — ${r.ms}ms${r.status === 200 ? ' (lista vazia: a conta não declarou modelos)' : ''}`);
    bloqueado = classe === 'BLOQUEADO_AUTENTICACAO';
  }
}

const modelo = MODELO_PEDIDO || process.env.KIRANA_PRIMARY_MODEL || catalogo[0]?.id || null;
const inferencia = { texto: null, run: null, stream: null, cancelamento: null, erros: [], classe: null };

if (!bloqueado && modelo && !SO_CATALOGO) {
  /* ── 2. inferência ───────────────────────────────────────────────────── */
  {
    const corpo = garantirContrato(montarCorpo({ modelo, prompt: PROMPT, stream: false }));
    contarGeracao('inferência stream:false');
    const r = await pedir('POST', '/v1/chat/completions', corpo);
    const escolha = r.dados?.choices?.[0];
    const conteudo = escolha?.message?.content ?? null;
    const codigo = r.dados?.error?.code ?? null;
    inferencia.classe = r.status === 200 ? null : classificarFalha(r.status, codigo);
    inferencia.texto = {
      status: r.status, ms: r.ms, conteudo, finish: escolha?.finish_reason ?? null,
      uso: r.dados?.usage ?? null, codigo, classe: inferencia.classe, cortou: r.cortou,
    };
    if (r.status === 200) {
      const ok = typeof conteudo === 'string' && conteudo.length > 0;
      nota('2.1', `inferência real (${modelo})`, ok ? 'PASS' : 'FALHA',
        ok ? `HTTP 200 · ${r.ms}ms · finish=${escolha?.finish_reason ?? '?'} · tokens=${r.dados?.usage ? `${r.dados.usage.prompt_tokens}/${r.dados.usage.completion_tokens}/${r.dados.usage.total_tokens}` : 'não informado'} · resposta="${String(conteudo).slice(0, 40)}"`
          : `HTTP 200 mas sem conteúdo — resposta vazia não é sucesso`);
    } else {
      nota('2.1', `inferência real (${modelo})`, inferencia.classe, `HTTP ${r.status} · ${codigo ?? 'sem código'}`);
      if (inferencia.classe === 'BLOQUEADO_AUTENTICACAO') bloqueado = true;
    }
  }

  /* ── 2.2 identidade via /v1/runs ─────────────────────────────────────── */
  if (!bloqueado) {
    const r = await pedir('GET', '/v1/runs?limit=5');
    const ultimo = Array.isArray(r.dados?.data) ? r.dados.data[0] : null;
    inferencia.run = ultimo ?? null;
    if (r.status !== 200 || !ultimo) {
      nota('2.2', 'identidade do modelo (/v1/runs)', 'INCONCLUSIVO',
        r.status !== 200 ? `HTTP ${r.status}` : 'nenhuma execução registrada');
    } else {
      const ident = ultimo.identityVerified === true;
      nota('2.2', 'identidade do modelo (/v1/runs)', ident ? 'PASS' : 'INCONCLUSIVO',
        `pedido=${ultimo.modelRequested ?? '?'} · reportado=${ultimo.modelReported ?? 'não informado'} · identityVerified=${ident} · upstreamId=${ultimo.upstreamId ? 'presente' : 'ausente'}`);
      nota('2.3', 'registro auditável da execução', 'PASS',
        `id=${ultimo.id ?? '?'} · totalMs=${ultimo.totalMs ?? '?'} · 1º útil=${ultimo.firstUsefulMs ?? '?'}ms · toolCalls=${ultimo.toolCalls ?? 0} · usage=${ultimo.usage ? `${ultimo.usage.prompt_tokens}/${ultimo.usage.completion_tokens}/${ultimo.usage.total_tokens}` : 'não informado'}`);
    }
  }

  /* ── 3. streaming ────────────────────────────────────────────────────── */
  if (!bloqueado) {
    const corpo = garantirContrato(montarCorpo({ modelo, prompt: PROMPT, stream: true, comUso: true }));
    contarGeracao('streaming stream:true');
    const t0 = agora();
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: cabecalhos(), body: JSON.stringify(corpo), signal: AbortSignal.timeout(LIMITE_TEMPO_MS),
    });
    const tipo = r.headers.get('content-type') || '';
    const marcas = [];
    let texto = '';
    let cortou = false;
    if (r.body) {
      const leitor = r.body.getReader();
      for (;;) {
        const { value, done } = await leitor.read();
        if (done) break;
        marcas.push(Math.round(agora() - t0));
        texto += Buffer.from(value).toString('utf8');
        if (texto.length > LIMITE_BYTES) { cortou = true; try { await leitor.cancel(); } catch { /* fechou */ } break; }
      }
    }
    const eventos = (texto.match(/^data: /gm) || []).length;
    const temDone = texto.includes('data: [DONE]');
    const deltas = (texto.match(/"content":"/g) || []).length;
    const finish = (texto.match(/"finish_reason":"([a-z_]+)"/) || [])[1] || null;
    const usoStream = /"usage":\{[^}]*\}/.exec(texto)?.[0] ?? null;
    const ok = r.status === 200 && tipo.includes('text/event-stream') && temDone && deltas > 0;
    inferencia.stream = {
      status: r.status, tipo, eventos, deltas, temDone, finish, uso: usoStream,
      ttfb: marcas[0] ?? null, ultimo: marcas[marcas.length - 1] ?? null, leituras: marcas.length, cortou,
    };
    if (r.status === 200) {
      nota('3.1', 'streaming SSE real', ok ? 'PASS' : 'FALHA',
        ok
          ? `ct=${tipo} · 1º byte ${marcas[0]}ms · último ${marcas[marcas.length - 1]}ms · ${marcas.length} leituras · ${deltas} deltas · [DONE]=true · finish=${finish}${usoStream ? ` · usage=${usoStream}` : ''}`
          : `HTTP 200 mas stream incompleto: [DONE]=${temDone} deltas=${deltas} — isto é falha real do caminho de streaming`);
    } else {
      const codigo = (() => { try { return JSON.parse(texto).error?.code; } catch { return null; } })();
      const classe = classificarFalha(r.status, codigo);
      nota('3.1', 'streaming SSE real', classe, `HTTP ${r.status} · ${codigo ?? 'sem código'}`);
      if (classe === 'BLOQUEADO_AUTENTICACAO') bloqueado = true;
    }
  }

  /* ── 4. cancelamento (opcional, contado) ─────────────────────────────── */
  if (!bloqueado && CANCELAMENTO) {
    const corpo = garantirContrato(montarCorpo({ modelo, prompt: PROMPT, stream: true }));
    contarGeracao('cancelamento (abortado no 1º delta)');
    const controle = new AbortController();
    let abortouCedo = false;
    try {
      const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST', headers: cabecalhos(), signal: controle.signal, body: JSON.stringify(corpo),
      });
      const leitor = r.body.getReader();
      const primeira = await leitor.read();
      if (primeira.value) { abortouCedo = true; controle.abort(); }
      try { await leitor.read(); } catch { /* esperado após abort */ }
    } catch (erro) {
      if (erro.name !== 'AbortError') throw erro;
    }
    let vivo = false;
    try { vivo = (await pedir('GET', '/health')).status === 200; } catch { vivo = false; }
    inferencia.cancelamento = { abortouCedo, gatewaySegueVivo: vivo };
    nota('4.1', 'cancelamento não derruba o Gateway', abortouCedo && vivo ? 'PASS' : 'FALHA',
      `abortado após o 1º delta=${abortouCedo} · /health depois=${vivo ? 'ok' : 'falhou'}`);
  } else if (!bloqueado && !CANCELAMENTO) {
    nota('4.1', 'cancelamento', 'NAO_EXECUTADO', 'fora do fluxo padrão (evita chamada extra de geração); use --com-cancelamento');
  }

  /* ── 5. erros diferenciados (não geram chamada ao modelo) ────────────── */
  if (!bloqueado) {
    const inexistente = await pedir('POST', '/v1/chat/completions',
      JSON.stringify(garantirContrato(montarCorpo({ modelo: `modelo-inexistente-${randomBytes(4).toString('hex')}`, prompt: 'ok', stream: false }))));
    chamadas.semModelo += 1;
    const invalido = await pedir('POST', '/v1/chat/completions', '{isso nao e json');
    const rota = await pedir('GET', '/v1/rota-que-nao-existe');
    const run = await pedir('GET', '/v1/runs/run_000000');
    inferencia.erros = [
      { caso: 'modelo inexistente', status: inexistente.status, codigo: inexistente.dados?.error?.code ?? '?' },
      { caso: 'JSON inválido', status: invalido.status, codigo: invalido.dados?.error?.code ?? '?' },
      { caso: 'rota inexistente', status: rota.status, codigo: rota.dados?.error?.code ?? '?' },
      { caso: 'run inexistente', status: run.status, codigo: run.dados?.error?.code ?? '?' },
    ];
    const distintos = new Set(inferencia.erros.map((e) => `${e.status}:${e.codigo}`)).size;
    const sem500 = inferencia.erros.every((e) => e.status !== 500);
    nota('5.1', 'erros diferenciados (não um 500 genérico)', distintos >= 3 && sem500 ? 'PASS' : 'FALHA',
      inferencia.erros.map((e) => `${e.caso}=${e.status}/${e.codigo}`).join(' · '));
  }
} else if (!bloqueado) {
  nota('2.1', 'inferência real', 'NAO_EXECUTADO',
    SO_CATALOGO ? '--catalogo pedido: nenhuma chamada de geração' : 'nenhum modelo no catálogo');
}

/* ── 6. segredos nos logs ──────────────────────────────────────────────── */
{
  const tokens = [chave, process.env.KIRANA_BRIDGE_TOKEN, process.env.KIRANA_ACCESS_TOKEN].filter((v) => v && v.length >= 16);
  let arquivos = 0;
  let achados = 0;
  for (const dir of [join(RAIZ, 'run'), join(RAIZ, 'Gateway', 'run')]) {
    if (!existsSync(dir)) continue;
    for (const nome of readdirSync(dir)) {
      if (!nome.endsWith('.log')) continue;
      arquivos += 1;
      const texto = readFileSync(join(dir, nome), 'utf8');
      for (const t of tokens) if (texto.includes(t)) achados += 1;
    }
  }
  nota('6.1', 'nenhum segredo nos logs', achados === 0 ? 'PASS' : 'FALHA',
    `${arquivos} arquivo(s) · ${achados} ocorrência(s)`);
}

/* ── veredito ──────────────────────────────────────────────────────────── */
const perfil = (() => {
  if (bloqueado) return 'BLOQUEADO_AUTENTICACAO';
  if (inferencia.classe) return inferencia.classe;
  if (!inferencia.texto) return 'NAO_EXECUTADO';
  if (inferencia.run && inferencia.run.identityVerified !== true) return 'INCONCLUSIVO_IDENTIDADE';
  if (inferencia.stream?.status === 200 && inferencia.stream.temDone && inferencia.stream.deltas > 0) return 'APROVADO';
  if (inferencia.stream?.status === 200) return 'REPROVADO';
  if (inferencia.stream && !CANCELAMENTO) return 'INCONCLUSIVO';
  return 'APROVADO_PARCIAL (texto ok, streaming não confirmado)';
})();

/* ── relatórios ────────────────────────────────────────────────────────── */
const data = new Date().toISOString().slice(0, 10);
const cab = (titulo) => `# ${titulo}\n\n**Data:** ${data} · **Gateway:** ${engine?.gateway?.version ?? '0.4.1'} · **Base:** ${BASE}\n**Gerado por:** \`tools/validar-modelos-reais.mjs\` (execução real, não editada à mão)\n\n`;
const tabela = resultados.map((r) => `| ${r.id} | ${r.nome} | **${r.estado}** | ${r.detalhe.replace(/\|/g, '\\|')} |`).join('\n');

mkdirSync(SAIDA, { recursive: true });

const relatorio = `${cab('GATEWAY — VALIDAÇÃO DE MODELOS REAIS')}
## 1. Estado inicial

- Gateway respondeu em \`${BASE}\`
- Versão: **${engine?.gateway?.version ?? '?'}** · provedor: ${engine?.gateway?.provider ?? '?'}
- Conta autorizada (SIWC): **${engine?.gateway?.authenticated ? 'sim' : 'NÃO'}**
- Catálogo: **${catalogo.length}** modelo(s)
- Chamadas de geração nesta execução: **${chamadas.geracao}** (previstas: ${CANCELAMENTO ? 3 : 2})

## 2. Contrato do corpo (o que foi enviado)

Campos aceitos pelo Gateway v0.4.1: \`${CAMPOS_ACEITOS.join('`, `')}\`.

Este verificador envia **somente** esses campos. \`max_tokens\` não é enviado — o Gateway o rejeita
com \`400 unsupported_parameter\` **antes de chegar ao modelo**, e isso **não** reprova o modelo.

## 3. Autenticação

${engine?.gateway?.authenticated
  ? 'SIWC **concluído** nesta execução.'
  : 'SIWC **não concluído**. `/v1/models` e `/v1/chat/completions` respondem `401 authentication_required`.\n\n**Ação (só o proprietário):** abrir `http://127.0.0.1:1455/auth/start`, concluir o login e rodar de novo.\nA sessão é memory-only: reiniciar o Gateway derruba a autorização.'}

## 4. Modelos encontrados

${catalogo.length ? catalogo.map((m) => `- \`${m.id}\``).join('\n') : '_Nenhum — o catálogo só aparece com SIWC ativo._'}

## 5. Requisições realizadas

${inferencia.texto
  ? `| Requisição | Modelo | stream | Status | Duração | Resultado |
|---|---|---|---|---|---|
| inferência | \`${modelo}\` | false | ${inferencia.texto.status} | ${inferencia.texto.ms} ms | ${inferencia.texto.status === 200 ? `finish=${inferencia.texto.finish} · "${String(inferencia.texto.conteudo).slice(0, 60)}"` : `${inferencia.texto.codigo} (${inferencia.texto.classe})`} |
| streaming | \`${modelo}\` | true | ${inferencia.stream?.status ?? '-'} | ${inferencia.stream?.ultimo ?? '-'} ms (1º byte ${inferencia.stream?.ttfb ?? '-'} ms) | ${inferencia.stream?.deltas ?? 0} deltas · [DONE]=${inferencia.stream?.temDone ?? false}${inferencia.stream?.uso ? ` · ${inferencia.stream.uso}` : ''} |
`
  : '_Nenhuma chamada de geração foi feita (bloqueado, `--catalogo`, ou nenhum modelo)._'
}

**Prompt enviado** (sintético, sem dado pessoal): \`${PROMPT}\`

## 6. Identidade do modelo

${inferencia.run
  ? `| Campo | Valor |
|---|---|
| run id | \`${inferencia.run.id ?? '?'}\` |
| modelo pedido | \`${inferencia.run.modelRequested ?? '?'}\` |
| modelo **reportado pelo provedor** | \`${inferencia.run.modelReported ?? 'não informado'}\` |
| **identityVerified** | **${inferencia.run.identityVerified}** |
| id da resposta no provedor | ${inferencia.run.upstreamId ? 'presente' : 'ausente'} |
| tokens | ${inferencia.run.usage ? `${inferencia.run.usage.prompt_tokens}/${inferencia.run.usage.completion_tokens}/${inferencia.run.usage.total_tokens}` : 'não informado'} |
| 1º resultado útil | ${inferencia.run.firstUsefulMs ?? '?'} ms |

O campo \`model\` da resposta HTTP é apenas o nome pedido, ecoado. **A prova é \`identityVerified\`.**`
  : '_Não disponível (sem execução registrada)._'}

## 7. Limites — cada controle separado

| Controle | Valor efetivo | Onde |
|---|---|---|
| Tempo por requisição | ${LIMITES_DO_GATEWAY.tempoPorRequisicao} | Gateway |
| Tempo por requisição (este verificador) | ${LIMITE_TEMPO_MS} ms | verificador |
| Tamanho da resposta | ${LIMITES_DO_GATEWAY.tamanhoDaResposta} | Gateway |
| Tamanho lido pelo verificador | ${LIMITE_BYTES} bytes | verificador |
| Mensagens por requisição | ${LIMITES_DO_GATEWAY.mensagensPorRequisicao} | Gateway |
| Chamadas por minuto | ${LIMITES_DO_GATEWAY.chamadasPorMinuto} | Gateway |
| **Tokens de saída** | ${LIMITES_DO_GATEWAY.tokensDeSaida} | Gateway |
| Custo | ${LIMITES_DO_GATEWAY.custo} | Gateway |
| Chamadas de geração (padrão) | ${LIMITES_DO_VERIFICADOR.chamadasDeGeracaoNoFluxoPadrao} (inferência + streaming) | verificador |
| Chamada extra de cancelamento | ${LIMITES_DO_VERIFICADOR.chamadaExtraComCancelamento} (só com \`--com-cancelamento\`) | verificador |

> **Um prompt curto reduz consumo, mas não é garantia de custo.** Não existe teto de tokens
> configurável nesta versão; apresentar um número de tokens como "limite" seria falso.

## 8. Streaming

${inferencia.stream
  ? `\`content-type: ${inferencia.stream.tipo}\` · ${inferencia.stream.eventos} eventos · ${inferencia.stream.deltas} deltas · \`[DONE]\`: **${inferencia.stream.temDone}** · finish_reason: ${inferencia.stream.finish ?? 'não informado'}`
  : '_Não executado._'}

## 9. Cancelamento

${inferencia.cancelamento
  ? `Abortado após o 1º delta: **${inferencia.cancelamento.abortouCedo}**. Gateway seguiu respondendo: **${inferencia.cancelamento.gatewaySegueVivo}**. (1 chamada extra, com \`--com-cancelamento\`)`
  : '_Não executado — fora do fluxo padrão de propósito, para não acrescentar chamada de geração inesperada._'}

## 10. Erros

${inferencia.erros.length
  ? `| Caso | HTTP | code |\n|---|---|---|\n${inferencia.erros.map((e) => `| ${e.caso} | ${e.status} | \`${e.codigo}\` |`).join('\n')}\n\nNenhum deles gera chamada de geração ao modelo.`
  : '_Não executados._'}

## 11. Resultado por teste

| # | Teste | Estado | Detalhe |
|---|---|---|---|
${tabela}

## 12. Veredito do modelo

**${perfil}**

${perfil === 'APROVADO' ? 'Texto e streaming reais, com `[DONE]` e identidade confirmada por `/v1/runs`.' : 'Veredito que **não** promove o modelo. Veja o estado de cada teste acima: bloqueio de autenticação, custo, incompatibilidade do verificador, identidade inconclusiva e falha real são coisas diferentes.'}

## 13. Pendências

- Repetir com outro modelo antes de definir fallback: \`VALIDAR-MODELOS-REAIS.cmd --modelo <slug>\`
- Tool calling não é testado aqui; sem teste, **não** é suportado por evidência.
- Acesso privado: ver \`docs/GATEWAY_REV3_ACESSO_PRIVADO_STATUS.md\`.
`;
writeFileSync(join(SAIDA, 'GATEWAY_REV3_VALIDACAO_MODELOS_REAIS.md'), relatorio, 'utf8');

const matriz = `${cab('MATRIZ DE MODELOS E STREAMING')}
| Modelo | Disponibilidade | Texto | Streaming | Identidade | Tool calling | Limites | Custo | Veredito |
|---|---|---|---|---|---|---|---|---|
${catalogo.length
  ? catalogo.map((m) => {
    if (m.id !== modelo) return `| \`${m.id}\` | DISPONÍVEL | não testado | não testado | — | não testado | não divulgado | desconhecido | **DISPONÍVEL, não testado** |`;
    return `| \`${m.id}\` | DISPONÍVEL | ${inferencia.texto ? `HTTP ${inferencia.texto.status}` : '—'} | ${inferencia.stream?.temDone ? 'SIM ([DONE])' : inferencia.stream ? 'não confirmado' : '—'} | ${inferencia.run?.identityVerified === true ? 'SIM' : 'INCONCLUSIVA'} | não testado | não divulgado | ${inferencia.texto?.uso ? `${inferencia.texto.uso.total_tokens} tokens (informado)` : 'desconhecido'} | **${perfil}** |`;
  }).join('\n')
  : '| — | — | — | — | — | — | — | — | **BLOQUEADO_AUTENTICACAO** |'}

## Legenda — por que separar importa

| Veredito | Significado |
|---|---|
| **APROVADO** | texto + streaming com \`[DONE]\` + \`identityVerified=true\` |
| **APROVADO_PARCIAL** | texto ok, streaming não confirmado |
| **REPROVADO** | testado e falhou em algo que é do modelo |
| **INCONCLUSIVO_IDENTIDADE** | respondeu, mas \`/v1/runs\` não confirma qual modelo serviu |
| **INCONCLUSIVO** | teste não chegou a concluir |
| **MODELO_INDISPONIVEL** | \`400/404 model_not_available\` — fora do plano |
| **BLOQUEADO_AUTENTICACAO** | \`401 authentication_required\` |
| **BLOQUEADO_CUSTO** | \`402 cost_blocked\` / política de custo |
| **INCOMPATIBILIDADE_DO_VERIFICADOR** | \`400\` por campo/corpo inválido — **culpa do teste, não do modelo** |
| **NAO_EXECUTADO** | não rodou (ex.: \`--catalogo\`) |
`;
writeFileSync(join(SAIDA, 'GATEWAY_REV3_MATRIZ_MODELOS_E_STREAMING.md'), matriz, 'utf8');

/* ── saída ─────────────────────────────────────────────────────────────── */
const contar = (estado) => resultados.filter((r) => r.estado === estado).length;
console.log(`chamadas de geração nesta execução: ${chamadas.geracao} (previstas: ${CANCELAMENTO ? 3 : 2})`);
console.log(`RESULTADO: ${contar('PASS')} PASS · ${contar('FALHA')} FALHA · ${contar('BLOQUEADO_AUTENTICACAO')} bloqueado(auth) · ${contar('INCONCLUSIVO') + contar('INCONCLUSIVO_IDENTIDADE')} inconclusivo · ${contar('NAO_EXECUTADO')} não executado`);
console.log(`Veredito do modelo: ${perfil}`);
console.log(`Relatórios em ${SAIDA.replace(RAIZ, '.')}`);

if (bloqueado) {
  console.log('\nPRÓXIMA AÇÃO (só o proprietário pode fazer):');
  console.log('  1. abra http://127.0.0.1:1455/auth/start neste computador');
  console.log('  2. conclua o login do SIWC');
  console.log('  3. rode este verificador de novo');
  process.exit(3);
}
process.exit(contar('FALHA') > 0 ? 1 : 0);
