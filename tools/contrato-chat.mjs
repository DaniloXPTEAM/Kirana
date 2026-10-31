/**
 * CONTRATO DO CHAT — fonte única de verdade para o corpo das requisições.
 *
 * Existe por um defeito real: o verificador enviava `max_tokens` e o Gateway
 * o rejeitava com `400 unsupported_parameter` — o teste morria antes de chegar
 * ao modelo, e um 400 desse tipo NÃO é reprovação do modelo.
 *
 * O contrato aqui espelha `validateChatRequest()` em `Gateway/src/responses.js`.
 * Se o Gateway mudar os campos aceitos, o teste `tools/teste-verificador.mjs`
 * acusa a divergência em vez de deixar passar silenciosamente.
 */

/** Campos aceitos pelo Gateway v0.4.1 (responses.js:300). */
export const CAMPOS_ACEITOS = Object.freeze([
  'model', 'messages', 'stream', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream_options',
]);

/**
 * Monta um corpo de Chat Completions usando SOMENTE campos aceitos.
 * Nunca adiciona `max_tokens`, `temperature`, `top_p`, `n` ou qualquer outro.
 */
export function montarCorpo({ modelo, prompt, stream = false, comUso = false, tools = null, toolChoice = null }) {
  const corpo = {
    model: modelo,
    messages: [{ role: 'user', content: prompt }],
    stream: Boolean(stream),
  };
  // `stream_options.include_usage` é campo aceito e faz o Gateway emitir o
  // chunk de `usage` no fim do stream — é assim que se obtém tokens no modo SSE.
  if (comUso) corpo.stream_options = { include_usage: true };
  if (tools) corpo.tools = tools;
  if (toolChoice) corpo.tool_choice = toolChoice;
  return corpo;
}

/** Devolve a lista de campos fora do contrato (vazia = corpo válido). */
export function camposInvalidos(corpo) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return ['(corpo não é objeto)'];
  return Object.keys(corpo).filter((chave) => !CAMPOS_ACEITOS.includes(chave));
}

/** Lança se o corpo violar o contrato — usado antes de cada envio. */
export function garantirContrato(corpo) {
  const invalidos = camposInvalidos(corpo);
  if (invalidos.length) {
    throw new Error(`corpo fora do contrato do Gateway: campo(s) ${invalidos.join(', ')}. Aceitos: ${CAMPOS_ACEITOS.join(', ')}.`);
  }
  return corpo;
}

/**
 * Limites EFETIVOS do Gateway v0.4.1, conferidos no código.
 * São controles diferentes — misturá-los foi o que produziu a promessa falsa
 * de "max_tokens=16".
 */
export const LIMITES_DO_GATEWAY = Object.freeze({
  tempoPorRequisicao: '180 s (responses.js: AbortSignal.timeout(180_000))',
  tamanhoDaResposta: '4 MiB de saída (responses.js: MAX_OUTPUT_CHARS = 4 * 1024 * 1024)',
  tamanhoDoCorpo: 'limite do servidor em gateway.js (MULTIMODAL_CHAT_BODY_LIMIT)',
  mensagensPorRequisicao: '1 a 100 (validateChatRequest)',
  imagensPorRequisicao: 'até 10 imagens e 10 MiB inline (validateChatRequest)',
  chamadasPorMinuto: 'limite local por cliente em gateway.js (gateway_rate_limit, 429)',
  tokensDeSaida: 'NÃO existe parâmetro — `max_tokens`/`max_output_tokens` são REJEITADOS com 400 unsupported_parameter',
  custo: 'política `plan-only` no /v1/engine; `cost_blocked` (HTTP 402) vem do motor, não do chat',
});

/**
 * Limites OPERACIONAIS do verificador (autoimpostos, independentes do provedor).
 * Nenhum deles é apresentado como teto de tokens.
 */
export const LIMITES_DO_VERIFICADOR = Object.freeze({
  tempoPorRequisicaoMs: 60_000,
  bytesMaxPorResposta: 200_000,
  chamadasDeGeracaoNoFluxoPadrao: 2,
  chamadaExtraComCancelamento: 1,
  requisicoesQueNaoChegamAoModelo: '3 (modelo inexistente, JSON inválido, rota inexistente)',
});
