/**
 * Escolha do modelo diante do catálogo REAL anunciado pelo Gateway.
 *
 * Módulo separado de propósito: assim a regra é testável sem carregar o
 * runtime do agente (que depende de @langchain e @copilotkit).
 *
 * Histórico, porque isso explica cada campo:
 *  - v0.5.3: um primário fora do catálogo era mantido para sempre e a conversa
 *    falhava em TODO turno com model_not_found ("sobe, mas não conversa").
 *  - correção anterior: passou a escolher do catálogo por heurística de nome,
 *    mas apresentava a escolha como se fosse compatibilidade comprovada.
 *  - agora: catálogo e capacidade são coisas diferentes. Só afirmamos o que o
 *    catálogo declarou. Sem metadados, a escolha é uma HIPÓTESE identificada
 *    como tal (`verificado: false`) e o primeiro turno real é que confirma.
 *
 * Regras:
 *  1. nunca inventar slug;
 *  2. primário configurado e anunciado vence sempre;
 *  3. sem primário, fallback anunciado;
 *  4. se nenhum dos dois consta, escolhe do catálogo — preferindo candidatos com
 *     capacidade declarada compatível (chat/streaming/ferramentas);
 *  5. catálogo vazio, descoberta falha ou nenhum candidato: mantém o configurado
 *     e devolve `motivo` específico, para a tela dizer o que fazer.
 */

const NAO_E_CONVERSA = /(embed|embedding|whisper|tts|audio|speech|dall-?e|image|moderation|rerank|guard|transcribe|realtime)/i;

/**
 * Normaliza um item de catálogo para { id, capacidades }.
 * Aceita string ("gpt-x") ou objeto ({ id, capabilities|capabilities_list|
 * supported_parameters }). Metadados só contam quando são booleanos explícitos.
 */
export function normalizarModelo(item) {
  if (typeof item === 'string') return { id: item, capacidades: null };
  if (!item || typeof item !== 'object') return { id: '', capacidades: null };
  const id = typeof item.id === 'string' ? item.id : '';
  return { id, capacidades: lerCapacidades(item) };
}

function lerCapacidades(item) {
  const bruto = item.capabilities ?? item.capabilities_list ?? null;
  const params = Array.isArray(item.supported_parameters) ? item.supported_parameters : null;
  const cap = {};

  if (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) {
    for (const [chave, valor] of Object.entries(bruto)) {
      if (typeof valor === 'boolean') cap[chave.toLowerCase()] = valor;
    }
  }
  if (Array.isArray(bruto)) {
    for (const v of bruto) if (typeof v === 'string') cap[v.toLowerCase()] = true;
  }
  if (params) {
    const p = params.map((s) => String(s).toLowerCase());
    if (p.includes('tools') || p.includes('tool_choice')) cap.tools = true;
    if (p.includes('stream') || p.includes('stream_options')) cap.streaming = true;
  }
  return Object.keys(cap).length ? cap : null;
}

/** Só é "verificado" o que veio declarado pelo catálogo, não o que o nome sugere. */
function atendeCapacidades(capacidades, { requerFerramentas }) {
  if (!capacidades) return { ok: true, verificado: false };
  if (capacidades.chat === false) return { ok: false, verificado: true, motivo: 'chat:false' };
  if (requerFerramentas && capacidades.tools === false) return { ok: false, verificado: true, motivo: 'tools:false' };
  const declarouAlgo = 'chat' in capacidades || 'tools' in capacidades || 'streaming' in capacidades;
  return { ok: true, verificado: declarouAlgo && (!requerFerramentas || capacidades.tools === true) };
}

function nomePareceConversa(id) {
  return /gpt|chat|turbo|o[0-9]/i.test(id);
}

export function escolherModelo({ models = [], primary = '', fallback = '', requerFerramentas = false, descobertaFalhou = false } = {}) {
  const lista = (Array.isArray(models) ? models : []).map(normalizarModelo).filter((m) => m.id);
  const ids = lista.map((m) => m.id);

  if (descobertaFalhou) {
    return {
      active: primary,
      degraded: false,
      auto: false,
      verificado: false,
      motivo: 'descoberta_falhou',
      note: 'Não consegui listar os modelos do Gateway; mantendo o configurado. Rode `node tools\\diagnosticar-modelos.mjs` para ver o motivo real.',
    };
  }

  if (!ids.length) {
    return {
      active: primary,
      degraded: false,
      auto: false,
      verificado: false,
      motivo: 'catalogo_vazio',
      note: 'O Gateway não anunciou nenhum modelo — normalmente é falta de autorização da conta. Autorize em http://127.0.0.1:1455/auth/start e rode `node tools\\diagnosticar-modelos.mjs`.',
    };
  }

  const porId = new Map(lista.map((m) => [m.id, m]));

  if (primary && porId.has(primary)) {
    const checagem = atendeCapacidades(porId.get(primary).capacidades, { requerFerramentas });
    if (checagem.ok) {
      return {
        active: primary,
        degraded: false,
        auto: false,
        verificado: checagem.verificado,
        motivo: 'primario_anunciado',
        note: checagem.verificado ? null : 'Modelo primário anunciado no catálogo; capacidade de conversa será confirmada na primeira resposta.',
      };
    }
  }

  if (fallback && porId.has(fallback)) {
    const checagem = atendeCapacidades(porId.get(fallback).capacidades, { requerFerramentas });
    if (checagem.ok) {
      return {
        active: fallback,
        degraded: true,
        auto: false,
        verificado: checagem.verificado,
        motivo: 'fallback_anunciado',
        note: `O primário "${primary}" não pode ser usado (${primary && porId.has(primary) ? 'capacidade declarada incompatível' : 'não está no catálogo'}); usando o fallback "${fallback}".`,
      };
    }
  }

  // Nenhum dos configurados serve: procurar no catálogo.
  const candidatos = lista
    .filter((m) => !NAO_E_CONVERSA.test(m.id))
    .filter((m) => atendeCapacidades(m.capacidades, { requerFerramentas }).ok)
    .sort((a, b) => {
      // declarados compatíveis primeiro; depois nome de conversa; depois ordem estável
      const da = a.capacidades ? 1 : 0;
      const db = b.capacidades ? 1 : 0;
      if (da !== db) return db - da;
      const na = nomePareceConversa(a.id) ? 1 : 0;
      const nb = nomePareceConversa(b.id) ? 1 : 0;
      if (na !== nb) return nb - na;
      return a.id.localeCompare(b.id);
    });

  if (candidatos.length) {
    const escolhido = candidatos[0];
    const verificado = Boolean(escolhido.capacidades && (escolhido.capacidades.chat === true || (!requerFerramentas && escolhido.capacidades.streaming === true)));
    return {
      active: escolhido.id,
      degraded: true,
      auto: true,
      verificado,
      motivo: 'escolhido_do_catalogo',
      note: verificado
        ? `Nem "${primary}" nem "${fallback}" servem; escolhido "${escolhido.id}", que declara capacidade compatível no catálogo.`
        : `Nem "${primary}" nem "${fallback}" estão no catálogo; escolhido "${escolhido.id}" por estar na lista anunciada. O catálogo não declara capacidades: compatibilidade será confirmada na primeira resposta.`,
    };
  }

  return {
    active: primary,
    degraded: true,
    auto: false,
    verificado: false,
    motivo: 'sem_candidato',
    note: `Nenhum modelo anunciado atende ao que este turno precisa${requerFerramentas ? ' (ferramentas)' : ''}; mantendo "${primary}". Rode \`node tools\\diagnosticar-modelos.mjs\` para ver o catálogo.`,
  };
}

/** Mantido para compatibilidade: primeiro id que parece conversa, ordem estável. */
export function primeiroModeloDeConversa(lista) {
  const uteis = [...lista].filter((id) => typeof id === 'string' && !NAO_E_CONVERSA.test(id)).sort((a, b) => a.localeCompare(b));
  return uteis.find((id) => nomePareceConversa(id)) || uteis[0] || '';
}
