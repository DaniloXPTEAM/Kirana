/**
 * Regressão v0.5.1 — a interface dizia "ok" quando a ferramenta falhava.
 *
 * Sintoma relatado no Windows com o Gateway real:
 *
 *   `gateway.consultar_servicos · ok`   ← pílula
 *   "não consegui consultar o catálogo" ← resposta
 *
 * Causa: `addToolPill` imprimia `· ok` sempre que o evento não era `pending`,
 * independentemente de `ok === false`. O sucesso do TRANSPORTE (stream chegou ao
 * fim) era exibido como sucesso da FERRAMENTA.
 *
 * A lógica agora vive em `toolPillView` (módulo puro, sem DOM) para poder ser
 * testada diretamente.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolPillView } from '../public/stream-state.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('ferramenta bem-sucedida mostra "ok"', () => {
  const view = toolPillView({ name: 'consultar_servicos', title: 'Consultar serviços', ok: true });
  assert.equal(view.tone, 'ok');
  assert.match(view.label, /· ok$/);
  assert.doesNotMatch(view.label, /gateway\./);
});

test('ferramenta que falhou NÃO mostra ok — mostra o motivo', () => {
  const view = toolPillView({ name: 'consultar_servicos', title: 'Consultar serviços', ok: false, errorCode: 'unknown_tool' });
  assert.equal(view.tone, 'fail');
  assert.match(view.label, /ferramenta não encontrada/);
  assert.doesNotMatch(view.label, /· ok/, 'falha não pode ser rotulada como ok');
});

test('cada código de erro tem rótulo próprio (nada de "ok" genérico)', () => {
  const casos = {
    invalid_args: /argumentos inválidos/,
    timeout: /tempo esgotado/,
    write_not_allowed: /escrita bloqueada/,
    endpoint_nao_configurado: /sem destino configurado/,
  };
  for (const [errorCode, esperado] of Object.entries(casos)) {
    const view = toolPillView({ name: 'x', title: 'X', ok: false, errorCode });
    assert.equal(view.tone, 'fail', errorCode);
    assert.match(view.label, esperado, errorCode);
  }
  // Código desconhecido ainda não vira "ok".
  const desconhecido = toolPillView({ name: 'x', title: 'X', ok: false, errorCode: 'algo_novo' });
  assert.equal(desconhecido.tone, 'fail');
  assert.match(desconhecido.label, /falhou/);
});

test('confirmação pendente tem estado próprio (nem ok, nem falha)', () => {
  const view = toolPillView({ name: 'registrar_interesse_comercial', title: 'Registrar interesse', ok: false, pending: true, errorCode: 'confirmation_required' });
  assert.equal(view.tone, 'warn');
  assert.match(view.label, /aguardando/);
});

test('a interface usa o rótulo calculado e tem classe para falha', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  assert.match(appJs, /toolPillView/, 'app.js precisa usar a visão testada');
  assert.doesNotMatch(appJs, /text: pending \? `\$\{label\} · aguardando` : `\$\{label\} · ok`/, 'o texto fixo "· ok" não pode voltar');
  assert.match(css, /\.pill\.tool-fail/, 'precisa existir estilo de falha');
});
