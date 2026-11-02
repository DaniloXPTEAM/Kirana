/**
 * Resolução do modelo ativo: consulta o catálogo, escolhe e mantém o cache.
 *
 * Módulo separado de propósito (mesma razão de model-choice.js e errors.js):
 * a lógica fica testável sem carregar @langchain/@copilotkit, que o agent.js
 * importa. A política de cache vive em model-cache.js.
 *
 * Regras (defeito C da revisão 3):
 *  - sucesso: cache de 5 minutos;
 *  - falha: janela curta (3 s) só para não repetir consulta em rajada;
 *  - `notarErroDeTurno(code)` marca reconsulta quando o turno falhou por
 *    autorização — quem sabe que a autorização mudou é o erro, não o relógio;
 *  - `invalidate()` descarta na hora.
 */

import { escolherModelo } from './model-choice.js';
import { decidirReconsulta, cacheDeSucesso, cacheDeFalha, ehErroDeAutorizacao } from './model-cache.js';

const SEM_LOG = { info() {}, warn() {}, error() {}, debug() {} };

export function criarResolvedorDeModelo({ gateway, models = {}, log = SEM_LOG, agora = () => Date.now() } = {}) {
  const { primary = '', fallback = '', probe = true } = models;
  let cache = { at: 0, value: null, falhou: false };
  let forcarReconsulta = false;
  let consultas = 0;

  async function resolve() {
    if (!probe) return { active: primary, fallback, available: [] };

    const decisao = decidirReconsulta(cache, agora(), { descobertaFalhou: forcarReconsulta });
    if (!decisao.consultar) return cache.value;

    if (cache.value && (decisao.motivo === 'catalogo_expirado' || decisao.motivo === 'falha_expirou')) {
      log.info?.('Cache de modelos expirado; consultando o gateway de novo', {
        motivo: decisao.motivo,
        idadeMs: decisao.idadeMs,
        ttlMs: decisao.ttlMs,
        falhou: Boolean(cache.falhou),
      });
    }
    if (cache.falhou && decisao.motivo === 'erro_de_autorizacao_no_turno_anterior') {
      log.info?.('Falha de autorização no turno anterior: descartando catálogo em falha e reconsultando agora', {
        modeloAnterior: cache.value?.active ?? null,
      });
    }
    const veioDeFalha = Boolean(cache.falhou);
    forcarReconsulta = false;
    consultas += 1;

    try {
      // modelsDetalhados carrega capacidades quando o Gateway as declarar.
      // `requerFerramentas` é o mínimo honesto: este agente usa ferramentas.
      const catalogo =
        typeof gateway.modelsDetalhados === 'function' ? await gateway.modelsDetalhados() : await gateway.models();
      const escolha = escolherModelo({ models: catalogo, primary, fallback, requerFerramentas: true });
      const lista = escolha.available || catalogo.map((m) => (typeof m === 'string' ? m : m.id));
      const value = {
        active: escolha.active,
        fallback,
        available: lista,
        degraded: escolha.degraded,
        auto: escolha.auto,
        verificado: escolha.verificado,
        motivo: escolha.motivo,
        note: escolha.note,
      };
      cache = cacheDeSucesso(value, agora());
      if (veioDeFalha) {
        log.info?.('Catálogo obtido depois de uma falha: cache de modelos restabelecido', {
          catalogo: lista.length,
          ativo: escolha.active,
        });
      }
      if (escolha.auto) {
        log.warn('Modelo configurado fora do catálogo; escolhido automaticamente', {
          primary,
          ativo: escolha.active,
          catalogo: lista.length,
          verificado: Boolean(escolha.verificado),
        });
      } else if (escolha.degraded) {
        log.warn('Modelo primário indisponível', { primary, active: escolha.active, motivo: escolha.motivo });
      } else if (escolha.note) {
        log.info?.('Modelo escolhido com aviso', { active: escolha.active, motivo: escolha.motivo });
      }
      return value;
    } catch (error) {
      log.warn?.('Não foi possível listar modelos do gateway; seguindo com a configuração', { code: error?.code });
      const falha = escolherModelo({ models: [], primary, fallback, descobertaFalhou: true });
      const value = {
        active: primary,
        fallback,
        available: [],
        degraded: false,
        auto: false,
        verificado: false,
        motivo: falha.motivo,
        note: falha.note,
      };
      // Janela curta: freio de rajada, não cache de 5 minutos.
      cache = cacheDeFalha(value, agora());
      log.info?.('Descoberta de modelos falhou; nova tentativa liberada em instantes (não 5 minutos)', {
        code: error?.code,
        ttlMs: cache.ttlMs,
      });
      return value;
    }
  }

  /** Chamado quando um turno termina com erro: decide se o cache deve cair. */
  function notarErroDeTurno(code) {
    if (!ehErroDeAutorizacao(code)) return false;
    forcarReconsulta = true;
    log.info?.('Erro de autorização: catálogo será reconsultado no próximo turno', { code });
    return true;
  }

  function invalidate(motivo = 'manual') {
    const tinhaCatalogo = Boolean(cache.value && !cache.falhou);
    cache = { at: 0, value: null, falhou: false };
    forcarReconsulta = false;
    if (tinhaCatalogo) log.info?.('Catálogo de modelos invalidado', { motivo });
    return tinhaCatalogo;
  }

  return {
    resolve,
    notarErroDeTurno,
    invalidate,
    get estado() {
      return { ...cache, forcarReconsulta, consultas };
    },
  };
}
