#!/usr/bin/env node
/**
 * diagnosticar-modelos.mjs — mostra o catálogo REAL de modelos e o estado da
 * autorização do Gateway local, sem nunca imprimir a chave.
 *
 * Por que existe: a mensagem do erro `model_not_available` citava uma ferramenta
 * que não estava no pacote. Aqui está a ferramenta de verdade.
 *
 * Como a chave é usada:
 *  - lida de Gateway/.env (`GATEWAY_API_KEY`) direto do disco, na memória;
 *  - enviada como Bearer para 127.0.0.1 (loopback);
 *  - NUNCA impressa, nem mascarada por partes, nem em log de erro.
 *
 * Uso:
 *   node tools\diagnosticar-modelos.mjs
 *   node tools\diagnosticar-modelos.mjs --json
 *
 * Saída explicada (não é só um dump):
 *   - se o Gateway está no ar;
 *   - se a conta está autorizada (SIWC) nesta sessão;
 *   - quais modelos existem e quais declaram capacidade;
 *   - qual modelo a Kirana escolheria hoje e POR QUE (mesma função da conversa);
 *   - o que fazer quando a lista vem vazia.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escolherModelo, normalizarModelo } from '../Kirana/src/model-choice.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const GW = join(RAIZ, 'Gateway');
const KR = join(RAIZ, 'Kirana');
const URL_GATEWAY = process.env.KIRANA_GATEWAY_URL || 'http://127.0.0.1:1455';
const EMITIR_JSON = process.argv.includes('--json');

const cor = {
  ok: (s) => `  OK   ${s}`,
  aviso: (s) => `  !    ${s}`,
  erro: (s) => `  X    ${s}`,
  titulo: (s) => `\n=== ${s} ===`,
};

function lerEnv(caminho) {
  const mapa = {};
  if (!existsSync(caminho)) return mapa;
  for (const linha of readFileSync(caminho, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(linha) || !linha.includes('=')) continue;
    const i = linha.indexOf('=');
    mapa[linha.slice(0, i).trim()] = linha.slice(i + 1).trim();
  }
  return mapa;
}

async function pegar(caminho, chave) {
  const cabecalhos = chave ? { authorization: `Bearer ${chave}` } : {};
  const controle = new AbortController();
  const t = setTimeout(() => controle.abort(), 8000);
  try {
    const r = await fetch(`${URL_GATEWAY}${caminho}`, { headers: cabecalhos, signal: controle.signal });
    const corpo = await r.json().catch(() => null);
    return { status: r.status, corpo };
  } catch (erro) {
    return { status: 0, erro: erro?.name === 'AbortError' ? 'tempo esgotado' : 'sem conexão' };
  } finally {
    clearTimeout(t);
  }
}

const envGateway = lerEnv(join(GW, '.env'));
const envKirana = lerEnv(join(KR, '.env'));
const chaveGateway = envGateway.GATEWAY_API_KEY || '';
const chaveKirana = envKirana.KIRANA_GATEWAY_API_KEY || '';

const relatorio = {
  gatewayUrl: URL_GATEWAY,
  chaveLocal: { presente: Boolean(chaveGateway), igualNasDuasPastas: Boolean(chaveGateway) && chaveGateway === chaveKirana },
  online: false,
  autorizado: null,
  modelos: [],
  escolha: null,
  diagnosticos: [],
};

function diag(nivel, texto) {
  relatorio.diagnosticos.push({ nivel, texto });
  if (!EMITIR_JSON) (nivel === 'erro' ? console.log(cor.erro(texto)) : nivel === 'aviso' ? console.log(cor.aviso(texto)) : console.log(cor.ok(texto)));
}

if (!EMITIR_JSON) {
  console.log('\n  Diagnóstico de modelos — Kirana + Gateway local');
  console.log(`  raiz: ${RAIZ}\n`);
  console.log(cor.titulo('1. Chave local (Bearer entre Kirana e Gateway)'));
}

if (!chaveGateway) {
  diag('erro', 'Gateway/.env sem GATEWAY_API_KEY. Rode INSTALAR-WINDOWS.cmd: ele gera e alinha nos dois arquivos.');
} else {
  diag('ok', `GATEWAY_API_KEY presente (${chaveGateway.length} caracteres — valor não exibido).`);
  if (chaveKirana === chaveGateway) diag('ok', 'Kirana/.env tem a mesma chave do Gateway.');
  else diag('erro', 'Kirana/.env tem chave DIFERENTE do Gateway (isso dá 401). Rode INSTALAR-WINDOWS.cmd para alinhar.');
}

if (!EMITIR_JSON) console.log(cor.titulo('2. Gateway no ar'));

const saude = await pegar('/health', null);
if (saude.status === 200 && saude.corpo) {
  relatorio.online = true;
  relatorio.autorizado = Boolean(saude.corpo.authenticated);
  diag('ok', `Gateway v${saude.corpo.version ?? '?'} respondendo em ${URL_GATEWAY}.`);
  if (saude.corpo.authenticated) diag('ok', 'Conta autorizada nesta sessão (SIWC ativo).');
  else diag('aviso', 'Sem autorização da conta nesta sessão. Abra http://127.0.0.1:1455/auth/start (a autorização vive na memória do Gateway).');
} else {
  diag('erro', `Gateway não respondeu em ${URL_GATEWAY} (${saude.erro || `HTTP ${saude.status}`}). Rode INICIAR-TUDO.cmd.`);
}

let catalogo = [];
if (relatorio.online) {
  if (!EMITIR_JSON) console.log(cor.titulo('3. Catálogo de modelos'));
  const resposta = await pegar('/v1/models', chaveGateway);
  if (resposta.status === 200) {
    const lista = Array.isArray(resposta.corpo?.data) ? resposta.corpo.data : [];
    catalogo = lista;
    relatorio.modelos = lista.map((item) => {
      const n = normalizarModelo(item);
      return { id: n.id, capacidades: n.capacidades };
    });
    if (!lista.length) diag('aviso', 'O Gateway respondeu uma lista VAZIA. Quase sempre é falta de autorização da conta — autorize e tente de novo.');
    else {
      diag('ok', `${lista.length} modelo(s) anunciado(s).`);
      for (const m of relatorio.modelos) {
        const cap = m.capacidades ? Object.entries(m.capacidades).map(([k, v]) => `${k}:${v}`).join(' ') : 'capacidades não declaradas';
        if (!EMITIR_JSON) console.log(`         - ${m.id}   (${cap})`);
      }
      if (relatorio.modelos.every((m) => !m.capacidades)) {
        diag('aviso', 'O catálogo desta versão do Gateway não declara capacidades (chat/streaming/ferramentas). A escolha automática é hipótese: o primeiro turno real confirma.');
      }
    }
  } else if (resposta.status === 401) {
    // 401 tem DUAS causas opostas e a mensagem tem de ser diferente:
    //  - invalid_api_key          -> chave LOCAL (Gateway x Kirana) errada;
    //  - authentication_required  -> falta autorizar a CONTA (SIWC).
    // Dizer "alinhe as chaves" quando o problema é a conta manda a pessoa
    // consertar o que não está quebrado.
    const codigo = resposta.corpo?.error?.code || '';
    if (codigo === 'invalid_api_key') {
      diag('erro', 'O Gateway recusou a CHAVE LOCAL (invalid_api_key). Gateway\\.env e Kirana\\.env precisam ter o mesmo valor: rode INSTALAR-WINDOWS.cmd.');
    } else if (/authentication_required|sign_in_required|auth|sharing/i.test(codigo)) {
      diag('aviso', 'A conta não está autorizada nesta sessão (é isso que impede listar modelos). Abra http://127.0.0.1:1455/auth/start, autorize, e rode este diagnóstico de novo. A chave local está correta.');
    } else {
      diag('erro', `GET /v1/models respondeu 401${codigo ? ` (${codigo})` : ''}. Veja run\\gateway.log.`);
    }
  } else if (resposta.status === 0) {
    diag('erro', `Sem conexão com o Gateway (${resposta.erro}).`);
  } else {
    diag('erro', `GET /v1/models respondeu HTTP ${resposta.status}${resposta.corpo?.error?.code ? ` (${resposta.corpo.error.code})` : ''}.`);
  }
}

if (!EMITIR_JSON) console.log(cor.titulo('4. O que a Kirana escolheria agora'));

const primario = envKirana.KIRANA_PRIMARY_MODEL || '(não definido)';
const fallback = envKirana.KIRANA_FALLBACK_MODEL || '(não definido)';
const escolha = escolherModelo({ models: catalogo, primary: primario, fallback, requerFerramentas: true });
relatorio.escolha = escolha;

if (!EMITIR_JSON) {
  console.log(`         configurado: primary=${primario}  fallback=${fallback}`);
  console.log(`         escolhido  : ${escolha.active || '(nenhum)'}`);
  console.log(`         motivo     : ${escolha.motivo}  (auto=${escolha.auto} degradado=${escolha.degraded} verificado=${escolha.verificado})`);
  if (escolha.note) console.log(`         aviso      : ${escolha.note}`);
  console.log(cor.titulo('5. Resumo'));
}

const problemas = relatorio.diagnosticos.filter((d) => d.nivel === 'erro');
if (problemas.length) {
  if (!EMITIR_JSON) {
    console.log('  Há problema(s) que impedem conversar:');
    for (const p of problemas) console.log(`   - ${p.texto}`);
    console.log('\n  Ordem sugerida: 1) INSTALAR-WINDOWS.cmd  2) INICIAR-TUDO.cmd  3) autorizar em /auth/start');
  }
} else if (!EMITIR_JSON) {
  console.log(`  Catálogo com ${relatorio.modelos.length} modelo(s); a Kirana usaria "${escolha.active}".`);
  console.log('  Nada aqui prova que o modelo aceita ferramentas: isso só o primeiro turno real confirma.');
}

if (EMITIR_JSON) console.log(JSON.stringify(relatorio, null, 2));
else console.log('');

process.exit(problemas.length ? 1 : 0);
