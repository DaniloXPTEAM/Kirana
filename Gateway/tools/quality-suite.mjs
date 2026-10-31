/**
 * Suíte comparativa de qualidade do Gateway.
 *
 * O que ela faz: envia tarefas REAIS ao Gateway (conversação em pt-BR, cálculo,
 * planejamento, código, chamada de ferramenta, resposta estruturada e — se
 * disponível — interpretação de imagem) e registra, por tarefa:
 *   • passou/reprovou por critério OBJETIVO (o que é verificável por código);
 *   • latência até o primeiro token e total;
 *   • modelo pedido × modelo declarado pelo provedor × fallback;
 *   • uso de tokens informado pelo provedor;
 *   • código do erro, quando falha.
 *
 * O que ela NÃO faz: julgar qualidade subjetiva. "Resposta boa" não é medido
 * aqui — o campo `qualidade_subjetiva` fica como `nao_avaliada` de propósito.
 * Quem decide se o texto está bom é o responsável pelo produto, lendo a saída.
 *
 * ── Como usar ──────────────────────────────────────────────────────────────
 *   # contra um Gateway REAL (exige SIWC autorizado no navegador):
 *   GATEWAY_API_KEY=... node test/quality-suite.mjs \
 *       --url http://127.0.0.1:1455 --model <slug de /v1/models> --out resultados.json
 *
 *   # sem provedor real: prova que o harness funciona (resultado marcado MOCK)
 *   node test/quality-suite.mjs --mock
 *
 * Sem `--mock` e sem SIWC, a suíte termina com código 2 e diz "não executada".
 * Ela NUNCA inventa resultado: se o provedor não respondeu, não há nota.
 */
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { createGateway } from '../src/gateway.js';
import { ResponsesClient } from '../src/responses.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const BASE_URL = value('--url', process.env.GATEWAY_URL || 'http://127.0.0.1:1455');
const API_KEY = value('--key', process.env.GATEWAY_API_KEY || '');
let MODEL = value('--model', process.env.KIRANA_PRIMARY_MODEL || '');
const OUT = value('--out', 'resultados-qualidade.json');
const MOCK = has('--mock');
const TIMEOUT_MS = Number(value('--timeout', 120_000));

/* ------------------------------- tarefas --------------------------------- */

const TAREFAS = [
  {
    id: 'conversacao-ptbr',
    capacidade: 'text.chat',
    rotulo: 'Conversação em português',
    mensagens: [
      { role: 'system', content: 'Responda em português do Brasil, de forma curta.' },
      { role: 'user', content: 'Explique em duas frases o que é um gateway de IA.' },
    ],
    // Critério objetivo: respondeu, em português, com tamanho plausível.
    verificar: ({ texto }) => {
      if (!texto || texto.trim().length < 40) return 'resposta curta demais para o pedido';
      if (!/\b(é|são|um|uma|de|que|para|não)\b/i.test(texto)) return 'sem marcadores de português';
      return null;
    },
  },
  {
    id: 'calculo',
    capacidade: 'reasoning',
    rotulo: 'Cálculo verificável',
    mensagens: [
      { role: 'system', content: 'Responda apenas com o número final.' },
      { role: 'user', content: 'Quanto é (37 * 19) - 84?' },
    ],
    // 37*19 = 703; 703-84 = 619
    verificar: ({ texto }) => (String(texto).replace(/[.\s]/g, '').includes('619') ? null : 'não trouxe o valor correto (619)'),
  },
  {
    id: 'planejamento',
    capacidade: 'reasoning',
    rotulo: 'Planejamento em etapas',
    mensagens: [
      { role: 'user', content: 'Liste em 4 passos numerados como migrar um atendimento manual para um agente de IA.' },
    ],
    verificar: ({ texto }) => {
      const passos = String(texto).match(/(^|\n)\s*\d[.)]/g) || [];
      return passos.length >= 3 ? null : `esperava 3+ passos numerados, veio ${passos.length}`;
    },
  },
  {
    id: 'codigo',
    capacidade: 'coding',
    rotulo: 'Geração de código',
    mensagens: [
      { role: 'system', content: 'Responda apenas com o bloco de código, sem explicação.' },
      { role: 'user', content: 'Escreva uma função JavaScript chamada agruparPedidos que recebe uma lista de pedidos com {cliente, valor} e devolve um objeto agrupado por cliente somando os valores.' },
    ],
    verificar: ({ texto }) => {
      const fonte = String(texto);
      if (!/agruparPedidos/.test(fonte)) return 'não definiu a função pedida';
      if (!/[=:]\s*\(|function\s+agruparPedidos/.test(fonte)) return 'não parece código';
      if (!/(reduce|for)/.test(fonte)) return 'sem laço/agregação';
      return null;
    },
  },
  {
    id: 'ferramenta',
    capacidade: 'tools',
    rotulo: 'Chamada de ferramenta',
    ferramentas: [
      {
        type: 'function',
        function: {
          name: 'consultar_status_projeto',
          description: 'Consulta o status de um projeto pelo nome.',
          parameters: { type: 'object', properties: { projeto: { type: 'string' } }, required: ['projeto'] },
        },
      },
    ],
    mensagens: [{ role: 'user', content: 'Consulte o status do projeto Atlas.' }],
    verificar: ({ toolCalls }) =>
      toolCalls.length > 0 && toolCalls.some((c) => String(c.name).includes('consultar_status_projeto'))
        ? null
        : 'não pediu a ferramenta disponível',
  },
  {
    id: 'json-estruturado',
    capacidade: 'json',
    rotulo: 'Resposta estruturada (JSON)',
    mensagens: [
      { role: 'system', content: 'Responda SOMENTE com JSON válido, sem markdown.' },
      { role: 'user', content: 'Devolva {"produto":"crm","pronto":true,"etapas":3} exatamente com essas três chaves.' },
    ],
    verificar: ({ texto }) => {
      const limpo = String(texto).replace(/```json|```/g, '').trim();
      try {
        const dados = JSON.parse(limpo);
        if (!('produto' in dados) || !('pronto' in dados) || !('etapas' in dados)) return 'faltou chave obrigatória';
        if (dados.etapas !== 3) return 'etapas diferente de 3';
        return null;
      } catch {
        return 'não devolveu JSON válido';
      }
    },
  },
  {
    id: 'imagem',
    capacidade: 'images.analyze',
    rotulo: 'Interpretação de imagem',
    precisaCapacidade: 'images.analyze',
    // Requer um modelo de visão APROVADO no catálogo. Sem isso, a tarefa é
    // marcada como `nao_aplicavel` — nunca como aprovada.
    mensagens: [{ role: 'user', content: 'Descreva a imagem em uma frase.' }],
    verificar: ({ texto }) => (String(texto).trim().length > 10 ? null : 'descrição vazia'),
  },
];

/* ------------------------------- execução -------------------------------- */

async function chamarGateway(base, key, tarefa, model) {
  const inicio = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages: tarefa.mensagens,
        ...(tarefa.ferramentas ? { tools: tarefa.ferramentas, tool_choice: 'auto' } : {}),
      }),
      signal: controller.signal,
    });
    const tipo = response.headers.get('content-type') || '';
    if (!response.ok) {
      const corpo = await response.json().catch(() => null);
      return {
        ok: false,
        status: response.status,
        erro: corpo?.error?.code || `http_${response.status}`,
        mensagem: corpo?.error?.message || null,
        latenciaMs: Date.now() - inicio,
        primeiroTokenMs: null,
        texto: '',
        toolCalls: [],
      };
    }
    let texto = '';
    let primeiroTokenMs = null;
    const toolCalls = [];
    if (tipo.includes('text/event-stream')) {
      const leitor = response.body.getReader();
      const decodificador = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await leitor.read();
        if (done) break;
        buffer += decodificador.decode(value, { stream: true });
        for (const linha of buffer.split('\n')) {
          if (!linha.startsWith('data:')) continue;
          const bruto = linha.slice(5).trim();
          if (!bruto || bruto === '[DONE]') continue;
          try {
            const evento = JSON.parse(bruto);
            const delta = evento.choices?.[0]?.delta;
            if (delta?.content) {
              primeiroTokenMs ??= Date.now() - inicio;
              texto += delta.content;
            }
            for (const chamada of delta?.tool_calls || []) {
              primeiroTokenMs ??= Date.now() - inicio;
              const indice = chamada.index ?? toolCalls.length;
              toolCalls[indice] ??= { name: '', arguments: '' };
              if (chamada.function?.name) toolCalls[indice].name += chamada.function.name;
              if (chamada.function?.arguments) toolCalls[indice].arguments += chamada.function.arguments;
            }
            if (evento.error) return { ok: false, status: 502, erro: evento.error.code, mensagem: evento.error.message, latenciaMs: Date.now() - inicio, primeiroTokenMs, texto, toolCalls };
          } catch {
            /* frame parcial */
          }
        }
      }
    } else {
      const corpo = await response.json();
      texto = corpo.choices?.[0]?.message?.content || '';
      primeiroTokenMs = Date.now() - inicio;
      for (const chamada of corpo.choices?.[0]?.message?.tool_calls || []) toolCalls.push({ name: chamada.function?.name, arguments: chamada.function?.arguments });
    }
    return {
      ok: true,
      status: response.status,
      erro: null,
      latenciaMs: Date.now() - inicio,
      primeiroTokenMs,
      texto,
      toolCalls: toolCalls.filter(Boolean),
      identidade: { modelo_usado_header: response.headers.get('x-gateway-model-used') || null },
    };
  } catch (error) {
    return { ok: false, status: 0, erro: error.name === 'AbortError' ? 'timeout_local' : 'network_error', mensagem: String(error.message || error), latenciaMs: Date.now() - inicio, primeiroTokenMs: null, texto: '', toolCalls: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function ultimaExecucao(base, key) {
  try {
    const dados = await fetch(`${base}/v1/runs?limit=1`, { headers: { authorization: `Bearer ${key}` } }).then((r) => r.json());
    return dados?.data?.[0] || null;
  } catch {
    return null;
  }
}

/** Upstream falso — só para `--mock`. Prova o harness, não o modelo. */
function mockUpstream() {
  const fetchImpl = async (url, init = {}) => {
    const alvo = String(url);
    if (alvo.endsWith('/v1/models')) return Response.json({ models: [{ slug: 'modelo-mock', display_name: 'Mock', visibility: 'list' }] });
    if (alvo.endsWith('/v1/responses')) {
      const corpo = JSON.parse(init.body || '{}');
      const ultima = corpo.input?.at(-1)?.content || '';
      let eventos;
      if ((corpo.tools || []).length) {
        eventos = [
          { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'c1', call_id: 'c1', name: 'consultar_status_projeto' } },
          { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"projeto":"Atlas"}' },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'c1', call_id: 'c1', name: 'consultar_status_projeto', arguments: '{"projeto":"Atlas"}' } },
          { type: 'response.completed', response: { id: 'r', model: corpo.model, status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } },
        ];
      } else if (/\{"produto"/.test(ultima)) {
        eventos = [
          { type: 'response.output_text.delta', delta: '{"produto":"crm","pronto":true,"etapas":3}' },
          { type: 'response.completed', response: { id: 'r', model: corpo.model, status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } },
        ];
      } else if (/agruparPedidos/.test(ultima)) {
        eventos = [
          { type: 'response.output_text.delta', delta: '```javascript\nfunction agruparPedidos(pedidos) {\n  return pedidos.reduce((acc, p) => {\n    acc[p.cliente] = (acc[p.cliente] || 0) + p.valor;\n    return acc;\n  }, {});\n}\n```' },
          { type: 'response.completed', response: { id: 'r', model: corpo.model, status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } },
        ];
      } else if (/37 \* 19/.test(ultima)) {
        eventos = [
          { type: 'response.output_text.delta', delta: '619' },
          { type: 'response.completed', response: { id: 'r', model: corpo.model, status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } },
        ];
      } else if (/migrar um atendimento/i.test(ultima)) {
        eventos = [
          { type: 'response.output_text.delta', delta: '1. Mapear os atendimentos repetitivos.\n2. Escrever as respostas aprovadas.\n3. Piloto com uma equipe.\n4. Medir e ampliar com revisão humana.' },
          { type: 'response.completed', response: { id: 'r', model: corpo.model, status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } },
        ];
      } else {
        eventos = [
          { type: 'response.output_text.delta', delta: 'Um gateway de IA é a camada que recebe os pedidos e os encaminha ao modelo escolhido. ' },
          { type: 'response.output_text.delta', delta: 'Ele concentra autenticação, limite de uso e registro, para que o aplicativo não fale direto com o provedor.' },
          { type: 'response.completed', response: { id: 'r', model: corpo.model, status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } },
        ];
      }
      const texto = eventos.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
      return new Response(texto, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`mock: URL inesperada ${alvo}`);
  };
  return { fetchImpl };
}

async function subirMock() {
  const key = randomBytes(32).toString('base64url');
  const auth = { status: () => ({ authenticated: true }), accessToken: async () => 'mock', initialize: async () => {}, clear() {} };
  const app = createGateway({
    apiKey: key,
    stateDir: resolve('.local-state', 'quality-mock'),
    port: 0,
    authClient: auth,
    responseClient: new ResponsesClient({ auth, fetchImpl: mockUpstream().fetchImpl }),
    engineOptions: { routing: true, primaryModel: 'modelo-mock' },
  });
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const porta = app.server.address().port;
  return { base: `http://127.0.0.1:${porta}`, key, fechar: () => new Promise((ok) => app.server.close(ok)) };
}

function tabela(linhas) {
  const cabecalho = '| Tarefa | Capacidade | Resultado | 1º token | total | modelo usado | declarado pelo provedor | fallback | erro |';
  const separador = '|---|---|---|---|---|---|---|---|---|';
  const corpo = linhas.map(
    (l) =>
      `| ${l.rotulo} | ${l.capacidade} | ${l.resultado} | ${l.primeiroTokenMs ?? '—'} ms | ${l.latenciaMs ?? '—'} ms | ${l.modeloUsado || '—'} | ${l.modeloDeclarado || '—'} | ${l.fallback === true ? 'sim' : l.fallback === false ? 'não' : '—'} | ${l.erro || l.motivo || '—'} |`,
  );
  return [cabecalho, separador, ...corpo].join('\n');
}

async function main() {
  let base = BASE_URL;
  let key = API_KEY;
  let model = MODEL;
  let fechar = async () => {};
  let modo = 'real';

  if (MOCK) {
    const mock = await subirMock();
    base = mock.base;
    key = mock.key;
    model = 'modelo-mock';
    fechar = mock.fechar;
    modo = 'mock';
  }

  if (!key) {
    console.error('Falta a chave do Gateway (--key ou GATEWAY_API_KEY).');
    process.exit(2);
  }
  // Sem --model: descobre pelo que a conta REALMENTE expõe. Nunca inventa slug.
  if (!model) {
    try {
      const lista = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } }).then((r) => r.json());
      const primeiro = (lista.data || [])[0]?.id;
      if (!primeiro) {
        console.error('Nenhum modelo visível em /v1/models. A conta pode não estar autenticada como esperado.');
        console.error('Suíte NÃO executada.');
        await fechar();
        process.exit(2);
      }
      model = primeiro;
      console.log(`Modelo não informado: usando "${model}" (primeiro visível em GET /v1/models).`);
    } catch (error) {
      console.error(`Não foi possível descobrir o modelo: ${error.message}`);
      await fechar();
      process.exit(2);
    }
  }

  // Pré-voo: o Gateway está no ar e autenticado no provedor?
  let preVoo;
  try {
    const saude = await fetch(`${base}/health`).then((r) => r.json());
    const motor = await fetch(`${base}/v1/engine`, { headers: { authorization: `Bearer ${key}` } }).then((r) => r.json());
    preVoo = { saude, motor };
    if (!MOCK && !saude.authenticated) {
      console.error('Gateway no ar, mas SEM autorização do provedor (SIWC). Rode /auth/start no navegador.');
      console.error('Suíte NÃO executada — nenhum resultado inventado.');
      await fechar();
      process.exit(2);
    }
  } catch (error) {
    console.error(`Gateway não respondeu em ${base}: ${error.message}`);
    console.error('Suíte NÃO executada.');
    await fechar();
    process.exit(2);
  }

  const catalogo = new Map((preVoo.motor.models || []).map((m) => [m.model, m]));
  const resultados = [];

  for (const tarefa of TAREFAS) {
    // Capacidade especial sem modelo aprovado: não aplicável (nunca "aprovado").
    if (tarefa.precisaCapacidade) {
      const aprovado = [...catalogo.values()].some(
        (m) => m.capabilities?.[tarefa.precisaCapacidade] === 'tested',
      );
      if (!aprovado) {
        resultados.push({
          id: tarefa.id,
          rotulo: tarefa.rotulo,
          capacidade: tarefa.capacidade,
          resultado: 'nao_aplicavel',
          motivo: 'nenhum modelo com esta capacidade aprovada por teste no catálogo',
          latenciaMs: null,
          primeiroTokenMs: null,
          erro: null,
        });
        continue;
      }
    }

    const saida = await chamarGateway(base, key, tarefa, model);
    // A identidade REAL vem do histórico do motor (não de um cabeçalho nosso).
    const corrida = await ultimaExecucao(base, key);
    let reprovacao = null;
    if (!saida.ok) reprovacao = `falha de transporte: ${saida.erro}`;
    else reprovacao = tarefa.verificar({ texto: saida.texto, toolCalls: saida.toolCalls });

    resultados.push({
      id: tarefa.id,
      rotulo: tarefa.rotulo,
      capacidade: tarefa.capacidade,
      resultado: saida.ok ? (reprovacao ? 'reprovado' : 'aprovado') : 'falhou',
      motivo: reprovacao,
      status_http: saida.status,
      erro: saida.erro,
      latenciaMs: saida.latenciaMs,
      primeiroTokenMs: saida.primeiroTokenMs,
      modeloDeclarado: corrida?.model_reported ?? null,
      modeloUsado: corrida?.model_used ?? saida.identidade?.modelo_usado_header ?? null,
      fallback: corrida?.fallback_used ?? null,
      uso: corrida?.usage ?? null,
      execucao_id: corrida?.id ?? null,
      toolCalls: saida.toolCalls?.map((c) => c.name) || [],
      texto: (saida.texto || '').slice(0, 600),
      // Qualidade do TEXTO não é medida por código — fica explícito.
      qualidade_subjetiva: 'nao_avaliada',
    });
  }

  // Identidade observada depois da bateria.
  let identidadeFinal = null;
  try {
    const motor = await fetch(`${base}/v1/engine`, { headers: { authorization: `Bearer ${key}` } }).then((r) => r.json());
    identidadeFinal = motor.identity;
  } catch {
    /* histórico é opcional para o relatório */
  }

  const relatorio = {
    modo, // 'real' ou 'mock' — NUNCA confundir
    geradoEm: new Date().toISOString(),
    gateway: BASE_URL,
    modelo_pedido: model,
    identidade_observada: identidadeFinal,
    pre_voo: { authenticated: preVoo.saude?.authenticated ?? null, versao: preVoo.saude?.version ?? null, politica: preVoo.motor?.policy ?? null },
    resumo: {
      tarefas: resultados.length,
      aprovadas: resultados.filter((r) => r.resultado === 'aprovado').length,
      reprovadas: resultados.filter((r) => r.resultado === 'reprovado').length,
      falhas: resultados.filter((r) => r.resultado === 'falhou').length,
      nao_aplicaveis: resultados.filter((r) => r.resultado === 'nao_aplicavel').length,
      latencia_media_ms: Math.round(resultados.filter((r) => r.latenciaMs).reduce((s, r) => s + r.latenciaMs, 0) / Math.max(1, resultados.filter((r) => r.latenciaMs).length)),
    },
    tarefas: resultados,
  };

  await writeFile(OUT, JSON.stringify(relatorio, null, 2), 'utf8');

  const aviso = modo === 'mock' ? '\n⚠ MODO MOCK: prova o harness, NÃO a qualidade de nenhum modelo real.\n' : '';
  console.log(`${aviso}\n## Resultado da suíte de qualidade (${modo})\n`);
  console.log(tabela(resultados));
  console.log(`\nResumo: ${JSON.stringify(relatorio.resumo)}`);
  console.log(`Identidade observada: ${JSON.stringify(identidadeFinal)}`);
  console.log(`\nJSON completo: ${OUT}`);

  await fechar();
  // Código 1 se algo reprovou/falhou — util para CI.
  process.exit(relatorio.resumo.reprovadas + relatorio.resumo.falhas > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  process.exit(2);
});
