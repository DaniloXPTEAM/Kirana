/**
 * Mapeamento de erro técnico -> mensagem para a pessoa na tela.
 *
 * Módulo separado de propósito (mesma razão de model-choice.js): é lógica pura,
 * testável sem carregar @langchain/@copilotkit. O agent.js reexporta daqui, para
 * não quebrar quem já importava `mapError` de './agent.js'.
 *
 * Regras que este arquivo garante:
 *  1. cada causa tem mensagem PRÓPRIA (chave local ≠ SIWC ≠ modelo ≠ resposta
 *     parcial) — antes tudo virava "a resposta foi interrompida";
 *  2. nenhuma mensagem exibe texto cru vindo do upstream: o texto é fixo aqui e
 *     o detalhe técnico fica em `details`/log;
 *  3. código desconhecido cai no genérico, nunca no otimista ("deu certo").
 */

export const MENSAGENS_ERRO = {
  aborted: { message: 'Geração interrompida.', recoverable: true },

  // ---- configuração local (não é conta, não é modelo) ----
  gateway_not_configured: {
    message:
      'A Kirana está sem a chave do Gateway (KIRANA_GATEWAY_API_KEY). Rode INSTALAR-WINDOWS.cmd: ele grava e confere a mesma chave nos dois arquivos.',
    recoverable: false,
  },
  gateway_contract_error: {
    message:
      'O backend montou uma requisição incompatível com o gateway e bloqueou o envio (proteção local). Rode .\\DIAGNOSTICO.cmd e envie a saída para a equipe técnica.',
    recoverable: false,
  },
  unsupported_parameter: {
    message:
      'O gateway recusou um campo da requisição que não faz parte do contrato dele. O backend já tentou remover o campo; se persistir, rode .\\DIAGNOSTICO.cmd e confira a versão do gateway.',
    recoverable: false,
  },

  // ---- rede / disponibilidade ----
  gateway_unreachable: {
    message: `Não consegui falar com o gateway em ${'{URL}'}. Verifique se ele está em execução (GET /health) e tente de novo.`,
    recoverable: true,
  },
  gateway_timeout: { message: 'O gateway não respondeu no tempo esperado. Tente novamente.', recoverable: true },
  first_token_timeout: {
    message: 'A resposta demorou demais para começar. Tente novamente; se persistir, verifique o gateway.',
    recoverable: true,
  },
  request_timeout: { message: 'A resposta passou do tempo limite. Tente novamente.', recoverable: true },
  rate_limited: { message: 'Muitas mensagens em pouco tempo. Aguarde alguns segundos e tente de novo.', recoverable: true },
  gateway_http: { message: 'O gateway retornou um erro. Veja os logs em run\\gateway.log para o detalhe técnico.', recoverable: true },

  // ---- autorização: três causas diferentes, três textos diferentes ----
  // 1) chave local (Bearer entre Kirana e Gateway) recusada -> conserta com INSTALAR
  unauthorized: {
    message:
      'O Gateway recusou a chave LOCAL. Ela precisa ser idêntica em Gateway\\.env (GATEWAY_API_KEY) e Kirana\\.env (KIRANA_GATEWAY_API_KEY) — rode INSTALAR-WINDOWS.cmd para alinhar automaticamente. Isso não tem relação com a sua conta.',
    recoverable: false,
  },
  // 2) gateway sem autorização da conta (SIWC) -> resolve no navegador
  gateway_auth: {
    message:
      'O Gateway está sem autorização da conta nesta sessão. Abra http://127.0.0.1:1455/auth/start e autorize uma vez (a autorização vive na memória: fechar o Gateway apaga).',
    recoverable: false,
  },
  // 3) o Gateway recusou com 401/403, mas sem um código que permita saber qual
  //    das duas causas acima é. Antes, este caso caía em "autorize a conta" por
  //    adivinhação; agora a mensagem diz que não deu para concluir.
  gateway_auth_unknown: {
    message:
      'O Gateway recusou a requisição (401/403) e não disse o motivo de forma reconhecível. Isso pode ser a chave local (Gateway\\.env x Kirana\\.env) ou a autorização da conta — não vou adivinhar qual. Rode `node tools\\diagnosticar-modelos.mjs`, que separa as duas causas.',
    recoverable: false,
  },
  gateway_unauthorized_upstream: {
    message:
      'O provedor recusou a autorização da conta (não é a chave local). Abra http://127.0.0.1:1455/auth/start e autorize de novo. Se a tela mostrar erro, veja run\\gateway.log.',
    recoverable: false,
  },

  // ---- modelo: existe no catálogo ou não ----
  model_not_available: {
    message:
      'O modelo escolhido não existe no catálogo da sua conta. Rode `node tools\\diagnosticar-modelos.mjs` para ver a lista real (o comando não mostra a chave) e ajuste KIRANA_PRIMARY_MODEL se quiser fixar um modelo.',
    recoverable: false,
  },
  model_unavailable: {
    message: 'O modelo configurado não está disponível no gateway agora. Tente novamente ou ajuste KIRANA_PRIMARY_MODEL.',
    recoverable: true,
  },
  model_no_tools: {
    message:
      'O modelo escolhido não aceita ferramentas, então as ações que dependem delas não vão funcionar neste turno. Rode `node tools\\diagnosticar-modelos.mjs` e fixe em KIRANA_PRIMARY_MODEL um modelo com ferramentas.',
    recoverable: true,
  },

  // ---- streaming: parcial não é igual a concluído ----
  stream_interrupted: {
    message:
      'A resposta foi interrompida no meio: o provedor encerrou o stream antes do evento de conclusão. O que apareceu acima está incompleto. Tente de novo; se repetir, veja run\\gateway.log (procure stream_interrupted).',
    recoverable: true,
  },
  response_incomplete: {
    message: 'O modelo parou antes de concluir a resposta. Tente novamente ou divida o pedido em partes.',
    recoverable: true,
  },
  invalid_upstream_event: {
    message: 'A resposta do provedor chegou corrompida (evento inválido no stream). Tente novamente.',
    recoverable: true,
  },
  gateway_stream_error: {
    message:
      'A resposta foi interrompida antes do fim e o gateway não informou o motivo específico. Tente novamente; o detalhe técnico está em run\\gateway.log.',
    recoverable: true,
  },
};

const GENERICO = { message: 'Algo deu errado ao processar sua mensagem.', recoverable: true };

export function mapError(error, config = {}) {
  const code = error?.code || 'internal_error';
  const encontrado = MENSAGENS_ERRO[code];
  const url = config.gateway?.url || 'http://127.0.0.1:1455';
  const base = encontrado || GENERICO;
  const message = base.message.includes('{URL}') ? base.message.replace('{URL}', url) : base.message;
  return {
    code,
    message,
    recoverable: base.recoverable,
    status: error?.status || 500,
    // motivo técnico curto e sanitizado, sem texto arbitrário do upstream
    detail: typeof error?.detail === 'string' ? error.detail.slice(0, 200) : undefined,
  };
}

/** Códigos que este módulo conhece — usado nos testes e no diagnóstico. */
export const CODIGOS_CONHECIDOS = Object.keys(MENSAGENS_ERRO);
