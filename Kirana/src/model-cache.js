/**
 * Política de cache da descoberta de modelos.
 *
 * Módulo puro de propósito: a regra é testável sem rede, sem timers e sem
 * carregar @langchain/@copilotkit.
 *
 * O defeito que isto corrige (revisão 3, item C): a falha de descoberta era
 * guardada com o mesmo TTL de 5 minutos do sucesso. Quem abria a Kirana antes de
 * autorizar a conta (SIWC) carimbava "descoberta_falhou" e, depois de autorizar
 * no navegador, continuava até 5 minutos tentando o modelo primário antigo, sem
 * consultar /v1/models de novo.
 *
 * Regra agora:
 *  - sucesso: 5 minutos (catálogo não muda a cada turno);
 *  - falha: janela MUITO curta (3 s) e só para não repetir a consulta em rajada.
 *    Serve de freio contra laço, não de cache de verdade;
 *  - erro de autorização invalida na hora: quem sabe que a autorização mudou é o
 *    erro que acabou de chegar, não o relógio.
 */

/** Catálogo válido vale 5 minutos. */
export const CACHE_TTL_OK_MS = 5 * 60_000;

/** Falha só é lembrada por 3 s (freio de rajada). */
export const CACHE_TTL_FALHA_MS = 3_000;

/** Códigos que significam "a autorização/configuração mudou ou está errada". */
const CODIGOS_DE_AUTORIZACAO = new Set([
  'gateway_auth',
  'gateway_auth_unknown',
  'unauthorized',
  'gateway_unauthorized_upstream',
  'gateway_not_configured',
]);

/**
 * Decide se é hora de consultar o catálogo de novo.
 *
 * @param {{ value: any, at: number, falhou?: boolean }} cache  estado atual
 * @param {number} agora  Date.now()
 * @param {{ descobertaFalhou?: boolean }} [extra]  força reconsulta (ex.: o turno
 *        anterior falhou por autorização)
 */
export function decidirReconsulta(cache, agora, extra = {}) {
  if (extra.descobertaFalhou) {
    return { consultar: true, motivo: 'erro_de_autorizacao_no_turno_anterior' };
  }
  if (!cache || !cache.value) return { consultar: true, motivo: 'sem_cache' };
  const idade = Math.max(0, agora - (Number(cache.at) || 0));
  const falhou = Boolean(cache.falhou);
  const ttl = falhou ? CACHE_TTL_FALHA_MS : CACHE_TTL_OK_MS;
  if (idade >= ttl) {
    return { consultar: true, motivo: falhou ? 'falha_expirou' : 'catalogo_expirado', idadeMs: idade, ttlMs: ttl };
  }
  return { consultar: false, motivo: falhou ? 'falha_recente' : 'catalogo_recente', idadeMs: idade, ttlMs: ttl };
}

/** Este código de erro indica que a descoberta precisa ser refeita? */
export function ehErroDeAutorizacao(code) {
  return typeof code === 'string' && CODIGOS_DE_AUTORIZACAO.has(code);
}

/** Monta a entrada de cache de sucesso. */
export function cacheDeSucesso(value, agora) {
  return { at: agora, value, falhou: false, ttlMs: CACHE_TTL_OK_MS };
}

/** Monta a entrada de cache de falha (janela curta). */
export function cacheDeFalha(value, agora) {
  return { at: agora, value, falhou: true, ttlMs: CACHE_TTL_FALHA_MS };
}
