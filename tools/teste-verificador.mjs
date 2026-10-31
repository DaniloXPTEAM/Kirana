/**
 * TESTES DO VERIFICADOR — protege contra a regressão que gerou a REV4.1.
 *
 * O defeito original: o verificador enviava `max_tokens`, o Gateway respondia
 * `400 unsupported_parameter` e o teste morria antes de chegar ao modelo — o que
 * parecia "modelo ruim", mas era o teste fora do contrato.
 *
 * Aqui há três camadas de proteção:
 *   A. estática  — o código do verificador não pode conter `max_tokens` em corpo
 *   B. unitária  — `montarCorpo()` só produz campos aceitos, em todos os modos
 *   C. integrada — o dublê de contrato ESTRITO rejeita campo extra; se o
 *                  verificador voltar a mandar algo fora, a bateria falha
 *
 * Uso:  node tools/teste-verificador.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  CAMPOS_ACEITOS, montarCorpo, camposInvalidos, garantirContrato, LIMITES_DO_GATEWAY, LIMITES_DO_VERIFICADOR,
} from './contrato-chat.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (rel) => readFileSync(join(RAIZ, rel), 'utf8');

/* ─────────────── A. estática: `max_tokens` não pode voltar ─────────────── */
test('A1 · o verificador não envia max_tokens em nenhum corpo', () => {
  // Pode CITAR max_tokens em comentário/documentação (é preciso explicar por que
  // não é enviado). O que não pode existir é o campo em um corpo de requisição.
  for (const arquivo of ['tools/validar-modelos-reais.mjs']) {
    const fonte = ler(arquivo);
    assert.equal(/max_tokens\s*:/.test(fonte), false, `${arquivo} monta corpo com max_tokens`);
    assert.equal(/["']max_tokens["']/.test(fonte), false, `${arquivo} usa a string max_tokens como campo`);
  }
});

test('A2 · o contrato documenta que max_tokens é rejeitado (e não enviado)', () => {
  const fonte = ler('tools/contrato-chat.mjs');
  assert.match(fonte, /max_tokens.*REJEITADOS|REJEITADOS.*max_tokens/s,
    'o contrato precisa registrar que max_tokens é rejeitado pelo Gateway');
});

test('A3 · o .cmd não promete limite de 16 tokens', () => {
  const fonte = ler('VALIDAR-MODELOS-REAIS.cmd');
  assert.doesNotMatch(fonte, /max_tokens\s*=\s*16/i, 'ainda anuncia max_tokens=16');
  assert.doesNotMatch(fonte, /16\s*tokens/i, 'ainda anuncia limite de 16 tokens');
  assert.match(fonte, /nao existe limite de tokens|não existe limite de tokens/i,
    'o .cmd deve dizer que NÃO existe limite de tokens configurável');
});

test('A4 · nenhuma ferramenta monta corpo com campo fora do contrato', () => {
  assert.ok(CAMPOS_ACEITOS.includes('stream_options'));
  for (const arquivo of ['tools/validar-modelos-reais.mjs', 'tools/duble-gateway-autorizado.mjs']) {
    const fonte = ler(arquivo);
    for (const proibido of ['temperature', 'top_p', 'max_completion_tokens', 'max_output_tokens', 'presence_penalty']) {
      assert.equal(new RegExp(`\\b${proibido}\\s*:`).test(fonte), false, `${arquivo} monta corpo com ${proibido}`);
    }
  }
});

/* ─────────────── B. unitária: montagem dos corpos ───────────────────────── */
test('B1 · inferência sem streaming usa só campos aceitos', () => {
  const corpo = montarCorpo({ modelo: 'm1', prompt: 'oi', stream: false });
  assert.deepEqual(camposInvalidos(corpo), []);
  assert.deepEqual(Object.keys(corpo).sort(), ['messages', 'model', 'stream']);
  assert.equal(corpo.stream, false);
});

test('B2 · streaming usa só campos aceitos e pede usage por stream_options', () => {
  const corpo = montarCorpo({ modelo: 'm1', prompt: 'oi', stream: true, comUso: true });
  assert.deepEqual(camposInvalidos(corpo), []);
  assert.deepEqual(Object.keys(corpo).sort(), ['messages', 'model', 'stream', 'stream_options']);
  assert.deepEqual(corpo.stream_options, { include_usage: true });
});

test('B3 · cancelamento usa o mesmo contrato (sem campo extra)', () => {
  const corpo = montarCorpo({ modelo: 'm1', prompt: 'oi', stream: true });
  assert.deepEqual(camposInvalidos(corpo), []);
  assert.equal(corpo.stream_options, undefined);
});

test('B4 · garantirContrato bloqueia campo extra em vez de enviar', () => {
  assert.throws(() => garantirContrato({ model: 'm', messages: [], stream: false, max_tokens: 16 }),
    /fora do contrato.*max_tokens/s);
});

test('B5 · limites efetivos são declarados e separados', () => {
  for (const chave of ['tempoPorRequisicao', 'tamanhoDaResposta', 'mensagensPorRequisicao', 'chamadasPorMinuto', 'tokensDeSaida', 'custo']) {
    assert.equal(typeof LIMITES_DO_GATEWAY[chave], 'string', `limite ${chave} ausente`);
  }
  assert.match(LIMITES_DO_GATEWAY.tokensDeSaida, /NÃO existe/);
  assert.equal(LIMITES_DO_VERIFICADOR.chamadasDeGeracaoNoFluxoPadrao, 2);
  assert.equal(LIMITES_DO_VERIFICADOR.chamadaExtraComCancelamento, 1);
});

/* ─────────────── C. integrada: dublê de contrato estrito ────────────────── */
const PORTA = 1461;
let duble;

test('C1 · verificador contra dublê estrito: 2 chamadas, sem falha', async () => {
  duble = spawn(process.execPath, [join(RAIZ, 'tools', 'duble-gateway-autorizado.mjs'), String(PORTA)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${PORTA}/health`)).ok) break; } catch { /* subindo */ }
    await sleep(100);
  }

  const saida = execFileSync(process.execPath, [
    join(RAIZ, 'tools', 'validar-modelos-reais.mjs'), '--simulado', '--base', `http://127.0.0.1:${PORTA}`,
  ], { encoding: 'utf8' });

  assert.match(saida, /chamadas de geração nesta execução: 2/, 'o fluxo padrão deve fazer exatamente 2 chamadas de geração');
  assert.match(saida, /Veredito do modelo: APROVADO/, 'com dublê estrito, o veredito deve ser APROVADO');
  assert.doesNotMatch(saida, /unsupported_parameter/, 'nenhum campo fora do contrato pode ter sido enviado');
  assert.match(saida, /· 0 FALHA ·/, 'nenhuma falha real esperada');
});

test('C2 · --com-cancelamento acrescenta exatamente 1 chamada (3 no total)', async () => {
  const saida = execFileSync(process.execPath, [
    join(RAIZ, 'tools', 'validar-modelos-reais.mjs'), '--simulado', '--base', `http://127.0.0.1:${PORTA}`, '--com-cancelamento',
  ], { encoding: 'utf8' });
  assert.match(saida, /chamadas de geração nesta execução: 3/);
  assert.match(saida, /PASS\s+4\.1\s+cancelamento não derruba o Gateway/);
  duble.kill('SIGTERM');
});

test('C3 · --catalogo não gasta chamada de geração', () => {
  duble = spawn(process.execPath, [join(RAIZ, 'tools', 'duble-gateway-autorizado.mjs'), String(PORTA)], { stdio: 'ignore' });
  return sleep(600).then(() => {
    const saida = execFileSync(process.execPath, [
      join(RAIZ, 'tools', 'validar-modelos-reais.mjs'), '--simulado', '--base', `http://127.0.0.1:${PORTA}`, '--catalogo',
    ], { encoding: 'utf8' });
    assert.match(saida, /chamadas de geração nesta execução: 0/);
    duble.kill('SIGTERM');
  });
});

/* ─────────────── D. classificação de falhas ─────────────────────────────── */
test('D1 · 400 unsupported_parameter NÃO reprova o modelo', () => {
  const fonte = ler('tools/validar-modelos-reais.mjs');
  assert.match(fonte, /unsupported_parameter[^\n]*INCOMPATIBILIDADE_DO_VERIFICADOR/,
    'a classificação precisa mapear unsupported_parameter para INCOMPATIBILIDADE_DO_VERIFICADOR');
  assert.match(fonte, /INCOMPATIBILIDADE_DO_VERIFICADOR/);
  assert.match(fonte, /BLOQUEADO_AUTENTICACAO/);
  assert.match(fonte, /BLOQUEADO_CUSTO/);
  assert.match(fonte, /INCONCLUSIVO_IDENTIDADE/);
});

test('D2 · identidade só é aprovada com identityVerified=true', () => {
  const fonte = ler('tools/validar-modelos-reais.mjs');
  assert.match(fonte, /identityVerified !== true\) return 'INCONCLUSIVO_IDENTIDADE'/);
});
