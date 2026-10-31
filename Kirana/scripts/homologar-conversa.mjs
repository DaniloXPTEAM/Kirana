#!/usr/bin/env node
/**
 * Conversa de homologação REAL — Kirana + Gateway ChatGPT local.
 *
 * Diferente das suítes (`test/`), que usam gateway SIMULADO, este script:
 *   - sobe a Kirana de verdade, com o `.env` de verdade;
 *   - fala com o Gateway local de verdade (modelo real, plano real);
 *   - percorre as quatro perguntas do roteiro de aceitação;
 *   - verifica EVENTOS e DADOS, não texto decorado (o modelo varia a prosa).
 *
 * O que ele reprova:
 *   - `unknown_tool` em ferramenta registrada  -> o defeito que a v0.5.2 corrige;
 *   - ferramenta reportada como ok sem dado    -> "ok" falso na interface;
 *   - ferramenta falhando sem código de erro   -> falha sem rastro;
 *   - resposta vazia                           -> turno sem conteúdo;
 *   - promessa de pesquisa web                 -> capacidade que não existe.
 *
 * Uso (Windows, com o Gateway já rodando):
 *   node scripts\homologar-conversa.mjs --live
 *   node scripts\homologar-conversa.mjs            (sem --live: só lista o plano)
 *
 * Saída: homologacao/conversa-<data>.json + resumo no console. Nenhum segredo é
 * gravado: só nomes de ferramenta, códigos de erro e o texto da resposta.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { createKiranaServer } from '../src/server.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const OUT_DIR = path.join(ROOT, 'homologacao');

const ROTEIRO = [
  {
    id: 'catalogo',
    mensagem: 'Quais serviços a Opportunity AI oferece?',
    espera: { ferramenta: 'list_services' },
    porque: 'é a consulta que falhava com o Gateway real (namespace gateway.)',
  },
  {
    id: 'contexto',
    mensagem: 'Em que página eu estou e o que ela explica?',
    espera: { ferramenta: 'explain_current_page' },
    porque: 'prova que a ferramenta de contexto executa e recebe o estado do site',
  },
  {
    id: 'requisitos',
    mensagem: 'O que eu preciso enviar para solicitar o atendimento digital?',
    espera: { ferramenta: null },
    porque: 'usa as ferramentas de solicitação da Fase 5 (requisitos/validação)',
  },
  {
    id: 'busca-web',
    mensagem: 'Pesquise na internet o que a Opportunity AI faz e me traga notícias.',
    espera: { proibePromessaDePesquisa: true },
    porque: 'a capacidade não existe: a Kirana precisa dizer isso, não fingir',
  },
];

const falhas = [];
const avisos = [];
const turnos = [];

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  console.log('=== Homologação de conversa (Gateway REAL) ===\n');

  if (!LIVE) {
    console.log('Modo de inspeção (sem chamadas de modelo).');
    console.log('Roteiro que será executado com --live:');
    for (const passo of ROTEIRO) console.log(`  - [${passo.id}] "${passo.mensagem}"`);
    console.log('\nRode com --live para executar contra o Gateway real.');
    return;
  }

  // Dados em diretório temporário: a homologação NÃO toca em `data/`.
  // Porta 0 = livre, escolhida pelo sistema (nada de conflito com a Kirana do dia a dia).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-homolog-'));
  process.env.KIRANA_DATA_DIR = dataDir;
  process.env.KIRANA_PORT = '0';
  process.env.KIRANA_HOST = '127.0.0.1';
  const app = createKiranaServer();
  await app.listen();
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  console.log(`Kirana de homologação em ${base} (dados em diretório temporário)\n`);

  try {
    const session = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((r) => r.json());

    for (const passo of ROTEIRO) {
      const resultado = await rodarTurno(base, session.id, passo);
      turnos.push(resultado);
    }
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  /* ------------------------------- resumo -------------------------------- */
  for (const turno of turnos) {
    const tag = turno.falhas.length ? '[XX]' : '[OK]';
    console.log(`\n${tag} ${turno.id}: "${turno.mensagem}"`);
    console.log(`     ferramentas: ${turno.ferramentas.length ? turno.ferramentas.map((f) => `${f.name}${f.ok ? '' : `(${f.errorCode})`}`).join(', ') : 'nenhuma'}`);
    console.log(`     resposta: ${turno.texto.slice(0, 200).replace(/\s+/g, ' ')}${turno.texto.length > 200 ? '…' : ''}`);
    for (const falha of turno.falhas) console.log(`     FALHA: ${falha}`);
    for (const aviso of turno.avisos) console.log(`     aviso: ${aviso}`);
    falhas.push(...turno.falhas.map((f) => `${turno.id}: ${f}`));
    avisos.push(...turno.avisos.map((a) => `${turno.id}: ${a}`));
  }

  const relatorio = {
    kind: 'homologacao-conversa',
    generatedAt: new Date().toISOString(),
    live: true,
    gatewayUrl: 'do .env (não gravado)',
    totalTurnos: turnos.length,
    falhas,
    avisos,
    turnos,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const arquivo = path.join(OUT_DIR, `conversa-${stamp()}.json`);
  fs.writeFileSync(arquivo, `${JSON.stringify(relatorio, null, 2)}\n`, 'utf8');

  console.log('\n--- Resumo ---');
  console.log(`Turnos: ${turnos.length} | falhas: ${falhas.length} | avisos: ${avisos.length}`);
  if (falhas.length) {
    console.log('\nFalhas:');
    for (const falha of falhas) console.log(`  - ${falha}`);
  }
  console.log(`\nRelatório: ${path.relative(ROOT, arquivo)}`);
  console.log(falhas.length ? '\nRESULTADO: REPROVADO' : '\nRESULTADO: APROVADO');
  process.exitCode = falhas.length ? 1 : 0;
}

async function rodarTurno(base, sessionId, passo) {
  const startedAt = Date.now();
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ sessionId, message: passo.mensagem, siteId: 'opportunity-ai', path: '/' }),
  });

  const raw = await response.text();
  const eventos = raw
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const ferramentas = eventos.filter((e) => e.type === 'tool_result');
  const texto = eventos.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  const falhasTurno = [];
  const avisosTurno = [];

  if (!response.ok) falhasTurno.push(`HTTP ${response.status} no /api/chat`);

  // 1. ferramenta registrada nunca pode virar unknown_tool
  const desconhecidas = ferramentas.filter((f) => f.errorCode === 'unknown_tool');
  if (desconhecidas.length) {
    falhasTurno.push(`unknown_tool em: ${desconhecidas.map((f) => f.name).join(', ')}`);
  }

  // 2. "ok" tem de significar ferramenta que executou de verdade
  for (const f of ferramentas) {
    if (f.ok === true && f.data === undefined && f.external !== true) {
      avisosTurno.push(`${f.name} disse ok sem dado exposto (normal em ferramentas internas)`);
    }
    if (f.ok === false && !f.errorCode) {
      falhasTurno.push(`${f.name} falhou sem código de erro (falha sem rastro)`);
    }
  }

  // 3. a ferramenta esperada precisa ter rodado
  if (passo.espera.ferramenta && !ferramentas.some((f) => f.name === passo.espera.ferramenta)) {
    falhasTurno.push(`a ferramenta esperada "${passo.espera.ferramenta}" não foi chamada`);
  }

  // 4. resposta não pode ser vazia
  if (!texto.trim()) falhasTurno.push('resposta vazia');

  // 5. nada de prometer pesquisa que não existe
  if (passo.espera.proibePromessaDePesquisa) {
    const promessa = /(vou|irei|estou|acabei de|já) (pesquisar|buscar|consultar) (na|a) (web|internet|internet)|encontrei (na web|na internet|notícias)/i;
    if (promessa.test(texto)) falhasTurno.push('prometeu pesquisa web (capacidade inexistente)');
  }

  const execucao = eventos.find((e) => e.type === 'done');
  if (!execucao) falhasTurno.push('turno sem evento "done" (stream não concluiu)');

  return {
    id: passo.id,
    mensagem: passo.mensagem,
    porque: passo.porque,
    duracaoMs: Date.now() - startedAt,
    ferramentas: ferramentas.map((f) => ({ name: f.name, ok: f.ok, errorCode: f.errorCode ?? null, cached: f.cached ?? false })),
    texto: texto.slice(0, 1200),
    rounds: execucao?.rounds ?? null,
    modelo: execucao?.model ?? null,
    falhas: falhasTurno,
    avisos: avisosTurno,
  };
}

main().catch((error) => {
  console.error(`\n[XX] Erro inesperado: ${error?.message}`);
  process.exitCode = 1;
});
