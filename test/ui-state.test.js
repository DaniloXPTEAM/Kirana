/**
 * Regressão do bug "Kirana está escrevendo… eternamente".
 *
 * O sintoma tinha duas causas independentes:
 *   1. CSS: `.composer-status { display: flex }` vencia `[hidden]` do navegador,
 *      então `hidden = true` não escondia nada (coberto em test/ui-css.test.js);
 *   2. Estado: o compositor só voltava a ocioso se o stream terminasse do jeito
 *      esperado — um encerramento sem `done` deixava a UI travada.
 *
 * Estes testes exercitam a máquina de estados pura usada pela interface.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStreamState,
  applyEvent,
  finalize,
  composerView,
  isSuccessful,
  PHASES,
} from '../public/stream-state.js';

const run = (events) => events.reduce((state, event) => applyEvent(state, event), createStreamState());

test('estado inicial é ocioso e o compositor está escondido', () => {
  const view = composerView(createStreamState());
  assert.equal(view.busy, false);
  assert.equal(view.hidden, true);
  assert.equal(view.label, '');
});

test('conclusão normal: done leva a ocioso e esconde o indicador', () => {
  let state = run([
    { type: 'start', model: 'gpt-6-luna' },
    { type: 'delta', text: 'Olá' },
    { type: 'delta', text: '!' },
    { type: 'done', ttftMs: 1800, totalMs: 3200 },
  ]);
  const view = composerView(state);
  assert.equal(view.busy, false);
  assert.equal(view.hidden, true, 'indicador deve sumir assim que o done chega');
  assert.equal(state.phase, PHASES.IDLE);

  state = finalize(state, {});
  assert.equal(state.reason, 'completed');
  assert.equal(isSuccessful(state), true);
});

test('o indicador aparece durante a geração com o rótulo correto', () => {
  const apos = run([{ type: 'start' }]);
  assert.equal(composerView(apos).busy, true);
  assert.match(composerView(apos).label, /pensando/i);

  const escrevendo = run([{ type: 'start' }, { type: 'delta', text: 'x' }]);
  assert.match(composerView(escrevendo).label, /escrevendo/i);

  const ferramenta = run([{ type: 'delta', text: 'x' }, { type: 'tool_start', name: 'consultar_servicos', title: 'Consultar serviços' }]);
  assert.match(composerView(ferramenta).label, /consultando/i);
});

test('erro do backend encerra o estado (não fica travado)', () => {
  const state = finalize(run([{ type: 'start' }, { type: 'error', code: 'gateway_unreachable', message: 'x' }]), {});
  assert.equal(state.phase, PHASES.IDLE);
  assert.equal(composerView(state).hidden, true);
  assert.equal(state.reason, 'error');
  assert.equal(isSuccessful(state), false);
});

test('cancelamento pelo usuário encerra o estado', () => {
  const state = finalize(run([{ type: 'start' }, { type: 'delta', text: 'parcial' }]), { aborted: true });
  assert.equal(state.phase, PHASES.IDLE);
  assert.equal(composerView(state).hidden, true);
  assert.equal(state.reason, 'aborted');
});

test('cancelamento sinalizado pelo backend (done.aborted) encerra o estado', () => {
  const state = finalize(run([{ type: 'delta', text: 'x' }, { type: 'done', aborted: true }]), {});
  assert.equal(state.phase, PHASES.IDLE);
  assert.equal(state.aborted, true);
  assert.equal(state.reason, 'aborted');
});

test('encerramento inesperado (stream fecha sem done) volta a ocioso', () => {
  const state = finalize(run([{ type: 'start' }, { type: 'delta', text: 'resposta parcial' }]), {});
  assert.equal(state.phase, PHASES.IDLE, 'não pode permanecer em "escrevendo"');
  assert.equal(composerView(state).hidden, true);
  assert.equal(state.reason, 'unexpected-close');
});

test('falha de rede antes de qualquer evento também encerra', () => {
  const state = finalize(createStreamState(), { error: true, reason: 'failed' });
  assert.equal(state.phase, PHASES.IDLE);
  assert.equal(state.reason, 'failed');
});

test('finalize é idempotente', () => {
  const once = finalize(run([{ type: 'done' }]), {});
  const twice = finalize(once, {});
  assert.equal(twice.phase, PHASES.IDLE);
  assert.equal(twice.reason, once.reason);
});

test('eventos desconhecidos não prendem o estado', () => {
  const state = run([{ type: 'start' }, { type: 'qualquer_coisa' }]);
  assert.equal(state.phase, PHASES.WORKING); // ainda trabalhando
  const fechado = finalize(state, {});
  assert.equal(fechado.phase, PHASES.IDLE);
});

test('fluxo completo com ferramenta e confirmação termina ocioso', () => {
  const state = finalize(
    run([
      { type: 'start' },
      { type: 'tool_start', name: 'consultar_servicos', title: 'Consultar serviços' },
      { type: 'tool_result', name: 'consultar_servicos', ok: true },
      { type: 'delta', text: 'Encontrei…' },
      { type: 'done', ttftMs: 900, totalMs: 2100 },
    ]),
    {},
  );
  assert.equal(state.phase, PHASES.IDLE);
  assert.equal(state.reason, 'completed');
  assert.equal(state.sawTool, true);
  assert.equal(composerView(state).hidden, true);
});
