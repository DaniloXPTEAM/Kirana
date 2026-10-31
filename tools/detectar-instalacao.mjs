/**
 * detectar-instalacao.mjs — roda ANTES de o instalador gerar qualquer chave.
 *
 * Problema que resolve: uma pasta nova não tem Gateway/.env, então o instalador
 * gerava uma chave aleatória. Se já havia um Gateway ativo (com SIWC em memória)
 * iniciado por outra pasta, essa chave nova nunca seria aceita -> HTTP 401 em tudo.
 *
 * Regras:
 *   - Só adota uma chave que o Gateway ATIVO aceita (GET /auth/status = 200).
 *     Chave de outro projeto, ou de um Gateway parado, nunca passa nesse teste.
 *   - Nunca encerra processo, nunca escreve arquivo. Só lê e informa.
 *   - Nunca imprime valor de chave. A única exceção é a linha `CHAVE:<valor>`,
 *     consumida pelo instalador (variável em memória) e não exibida.
 *   - Gateway ativo + nenhuma chave aceita = CONFLITO: sai com 2 e o instalador
 *     NÃO gera chave nova (geraria uma incompatível).
 *
 * Saída: 0 = nada a fazer ou chave adotada (linha CHAVE:); 2 = conflito.
 * Uso:   node tools/detectar-instalacao.mjs [--url http://127.0.0.1:1455]
 *        KIRANA_PROCURAR_EM=<pasta;pasta> substitui as pastas varridas (testes).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (nome, padrao) => {
  const i = process.argv.indexOf(nome);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
};
const URL_GATEWAY = arg('--url', 'http://127.0.0.1:1455').replace(/\/+$/, '');
const CHAVE_MINIMA = 32;
const PROFUNDIDADE_MAX = 3;
const PASTAS_IGNORADAS = new Set(['node_modules', '.git', 'backups', 'data', 'run', '.local-state', 'docs']);

const fp = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const dizer = (t) => console.log(t);

function lerChave(caminho) {
  try {
    const t = readFileSync(caminho, 'utf8').replace(/^﻿/, '');
    const m = t.match(/^\s*GATEWAY_API_KEY\s*=\s*(.+?)\s*$/m);
    const v = m && m[1].replace(/^["']|["']$/g, '');
    return v && v.length >= CHAVE_MINIMA && v !== 'generate-with-npm-run-keygen' ? v : null;
  } catch {
    return null;
  }
}

async function http(caminho, chave) {
  try {
    const r = await fetch(`${URL_GATEWAY}${caminho}`, {
      headers: chave ? { Authorization: `Bearer ${chave}` } : {},
      signal: AbortSignal.timeout(4000),
    });
    return r.status;
  } catch {
    return null; // porta fechada ou sem resposta
  }
}

function ehGateway(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'kirana-chatgpt-gateway';
  } catch {
    return false;
  }
}

/** Acha pastas de Gateway (com .env) nas vizinhanças, exceto a desta distribuição. */
function acharCandidatos() {
  const bases = process.env.KIRANA_PROCURAR_EM
    ? process.env.KIRANA_PROCURAR_EM.split(delimiter).filter(Boolean)
    : [dirname(RAIZ), dirname(dirname(RAIZ))];
  const vistos = new Set();
  const achados = [];
  const minha = join(RAIZ, 'Gateway').toLowerCase();
  const varrer = (dir, nivel) => {
    const chave = resolve(dir).toLowerCase();
    if (vistos.has(chave) || nivel > PROFUNDIDADE_MAX) return;
    vistos.add(chave);
    if (chave !== minha && ehGateway(dir)) {
      const k = lerChave(join(dir, '.env'));
      if (k) achados.push({ dir, chave: k });
      return;
    }
    let filhos = [];
    try {
      filhos = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const f of filhos) {
      if (f.isDirectory() && !PASTAS_IGNORADAS.has(f.name)) varrer(join(dir, f.name), nivel + 1);
    }
  };
  for (const b of bases) if (existsSync(b)) varrer(b, 0);
  return achados;
}

const saude = await http('/health');
const minhaChave = lerChave(join(RAIZ, 'Gateway', '.env'));

if (minhaChave) {
  dizer(`  OK   Gateway/.env desta pasta ja tem chave (fp ${fp(minhaChave)}); sera preservada.`);
  if (saude === 200) {
    const s = await http('/auth/status', minhaChave);
    if (s === 200) dizer('  OK   O Gateway ativo na porta 1455 aceita essa chave.');
    else {
      dizer(`  !    O Gateway ativo (porta 1455) RECUSOU a chave desta pasta (HTTP ${s}).`);
      dizer('       Ele foi iniciado por outra instalacao. Nada foi alterado nem encerrado.');
      dizer('       Para usar a chave dele: rode MIGRAR-ENV.cmd ou apague GATEWAY_API_KEY de Gateway/.env e rode o instalador de novo.');
    }
  }
  process.exit(0);
}

if (saude !== 200) {
  dizer('  OK   Nenhum Gateway ativo na porta 1455: uma chave nova sera gerada.');
  const outras = acharCandidatos();
  if (outras.length) dizer(`  !    Ha ${outras.length} outra(s) instalacao(oes) de Gateway no disco. Para reaproveitar a chave de uma delas, use MIGRAR-ENV.cmd.`);
  process.exit(0);
}

dizer('  !    Ja existe um Gateway ativo na porta 1455 (pode estar com a sessao SIWC autenticada).');
const candidatos = acharCandidatos();
let aceita = null;
for (const c of candidatos) {
  const s = await http('/auth/status', c.chave);
  dizer(`       candidato fp ${fp(c.chave)} em ${c.dir}: HTTP ${s ?? 'sem resposta'}`);
  if (s === 200 && !aceita) aceita = c;
}
if (aceita) {
  dizer(`  OK   Reaproveitando a chave que o Gateway ativo aceita (fp ${fp(aceita.chave)}, de ${aceita.dir}).`);
  dizer('       Nenhuma chave nova sera gerada e o Gateway ativo nao sera tocado.');
  dizer(`CHAVE:${aceita.chave}`);
  process.exit(0);
}
dizer('  X    CONFLITO: existe um Gateway ativo e nenhuma chave encontrada nas pastas vizinhas e aceita por ele.');
dizer('       Gerar outra chave aqui produziria HTTP 401 permanente. O instalador parou antes de gravar qualquer chave.');
dizer('       Opcoes (nada disso e feito automaticamente):');
dizer('         1) copie GATEWAY_API_KEY do Gateway/.env da instalacao que esta rodando para este Gateway/.env e rode o instalador de novo; ou');
dizer('         2) feche o Gateway ativo SABENDO que a sessao SIWC (so em memoria) sera perdida e exigira novo login em /auth/start.');
process.exit(2);
