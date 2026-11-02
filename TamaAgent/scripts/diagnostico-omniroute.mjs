#!/usr/bin/env node
/**
 * Diagnóstico do TamaAgent contra o OmniRoute (ou qualquer provedor OpenAI-compatível).
 *
 * Lê o .env (TAMAAGENT_* ou KIRANA_*), confere o catálogo e faz UMA chamada curta
 * de conversa. Nunca imprime a chave (só "definida, N caracteres").
 * Código de saída: 0 tudo certo · 1 falha · 3 bloqueado (sem chave ou sem provedor).
 *
 * Uso:  node scripts/diagnostico-omniroute.mjs [--catalogo]
 *   --catalogo  só lista os modelos (não gasta nenhuma chamada de conversa).
 */
import { loadConfig, loadEnvFile } from '../src/config.js';

const soCatalogo = process.argv.includes('--catalogo');
const linhas = [];
let falhou = false;
let bloqueado = false;
const ok = (id, msg) => { linhas.push(`PASS      ${id}  ${msg}`); console.log(linhas.at(-1)); };
const falha = (id, msg) => { falhou = true; linhas.push(`FAIL      ${id}  ${msg}`); console.log(linhas.at(-1)); };
const bloqueia = (id, msg) => { bloqueado = true; linhas.push(`BLOQUEADO ${id}  ${msg}`); console.log(linhas.at(-1)); };

loadEnvFile();
const config = loadConfig(process.env);
const base = config.gateway.url;
const chave = config.gateway.apiKey;

console.log(`TamaAgent ${config.version} — diagnóstico do provedor`);
console.log(`Provedor: ${base}`);

if (!chave) {
  bloqueia('0.1', 'sem chave: defina TAMAAGENT_GATEWAY_API_KEY no .env (rode CONFIGURAR-TAMAAGENT.cmd)');
  process.exit(3);
}
ok('0.1', `chave definida (${chave.length} caracteres; o valor não é mostrado)`);

const headers = { Authorization: `Bearer ${chave}`, Accept: 'application/json' };

async function pegar(caminho, init = {}, ms = 15000) {
  try {
    return await fetch(`${base}${caminho}`, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (erro) {
    return { erro: erro?.cause?.code || erro?.name || String(erro) };
  }
}

const catalogo = await pegar('/v1/models', { headers });
if (catalogo.erro) {
  bloqueia('1.1', `não consegui falar com ${base} (${catalogo.erro}). O OmniRoute está ligado? Porta 20128?`);
  process.exit(3);
}
if (catalogo.status === 401 || catalogo.status === 403) {
  falha('1.1', `o provedor recusou a chave (HTTP ${catalogo.status}). Confira a chave no painel do OmniRoute.`);
  process.exit(1);
}
if (!catalogo.ok) {
  falha('1.1', `catálogo respondeu HTTP ${catalogo.status}`);
  process.exit(1);
}
const corpo = await catalogo.json().catch(() => null);
const lista = Array.isArray(corpo?.data) ? corpo.data.map((m) => m?.id).filter(Boolean) : [];
if (!lista.length) {
  falha('1.1', 'catálogo vazio: configure pelo menos um provedor/modelo no painel do OmniRoute');
  process.exit(1);
}
ok('1.1', `catálogo real: ${lista.length} modelo(s). Primeiros: ${lista.slice(0, 8).join(', ')}`);

if (soCatalogo) process.exit(0);

const modelo = config.models.primary && lista.includes(config.models.primary)
  ? config.models.primary
  : (lista.includes('auto') ? 'auto' : lista[0]);
ok('1.2', `modelo que será usado neste teste: ${modelo}${config.models.primary && modelo !== config.models.primary ? ` (o configurado "${config.models.primary}" não está no catálogo)` : ''}`);

const t0 = Date.now();
const resposta = await pegar('/v1/chat/completions', {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: modelo, stream: false, messages: [{ role: 'user', content: 'Responda apenas com a palavra: ok' }] }),
}, 60000);
if (resposta.erro) {
  falha('2.1', `chamada de conversa falhou (${resposta.erro})`);
} else if (!resposta.ok) {
  const txt = (await resposta.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
  falha('2.1', `conversa respondeu HTTP ${resposta.status}: ${txt}`);
} else {
  const j = await resposta.json().catch(() => null);
  const texto = String(j?.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (texto) ok('2.1', `conversa real em ${Date.now() - t0} ms; modelo "${j?.model ?? modelo}"; resposta: "${texto}"`);
  else falha('2.1', 'a conversa respondeu 200, mas sem texto');
}

console.log(falhou ? '\nRESULTADO: FALHOU' : bloqueado ? '\nRESULTADO: BLOQUEADO' : '\nRESULTADO: PASSOU');
process.exit(falhou ? 1 : bloqueado ? 3 : 0);
