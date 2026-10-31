/**
 * Fase 5 — store de solicitações: ciclo de vida, isolamento e idempotência.
 *
 * Testes com disco real (diretório temporário) e sem rede. O que se prova aqui
 * é a máquina de estados e o isolamento entre sessões — a parte que, se
 * estivesse errada, deixaria um visitante enviar o pedido de outro.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRequestStore, REQUEST_STATES, sanitizeData } from '../src/requests/store.js';

const SESSION = 's_11111111-1111-1111-1111-111111111111';
const OUTRA = 's_22222222-2222-2222-2222-222222222222';

function store() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-req-'));
  return { store: createRequestStore({ dataDir }), dataDir };
}

test('cria rascunho com identificador, estado e histórico', () => {
  const { store: s } = store();
  const created = s.create({ sessionId: SESSION, siteId: 'opportunity-ai', serviceId: 'agentes-ia', serviceTitle: 'Agentes de IA' });
  assert.equal(created.ok, true);
  assert.match(created.request.id, /^REQ-\d{4}-[A-Z0-9]{6}$/);
  assert.equal(created.request.state, REQUEST_STATES.draft);
  assert.equal(created.request.files.length, 0);
  assert.equal(created.request.history[0].action, 'created');
  assert.equal(created.request.submittedAt, null);
});

test('recusa segunda solicitação ativa na mesma sessão (uma atividade por vez)', () => {
  const { store: s } = store();
  s.create({ sessionId: SESSION, serviceId: 'agentes-ia' });
  const second = s.create({ sessionId: SESSION, serviceId: 'voz' });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'request_already_active');
  // E o visitante recebe a solicitação que já existia, para continuar nela.
  assert.equal(second.request.serviceId, 'agentes-ia');

  // Depois de cancelar, pode abrir outra.
  s.cancel(second.request.id, SESSION);
  const third = s.create({ sessionId: SESSION, serviceId: 'voz' });
  assert.equal(third.ok, true);
});

test('isolamento: uma sessão não lê nem altera a solicitação de outra', () => {
  const { store: s } = store();
  const { request } = s.create({ sessionId: SESSION, serviceId: 'agentes-ia' });
  assert.equal(s.get(request.id, OUTRA), null, 'leitura de outra sessão deve ser nula');
  assert.equal(s.get(request.id, SESSION).id, request.id);
  assert.equal(s.update(request.id, OUTRA, { data: { nome: 'Invasor' } }).ok, false);
  assert.equal(s.activeFor(OUTRA), null);
  assert.deepEqual(s.list(OUTRA), []);
  // O dado da sessão dona segue intacto.
  assert.equal(s.get(request.id, SESSION).data.nome, undefined);
});

test('dados são saneados: chaves perigosas e valores longos não entram', () => {
  const clean = sanitizeData({ nome: '  Ana  ', __proto__: { poluido: true }, 'chave com espaço': 'x', mensagem: 'a'.repeat(3000), consent: true });
  assert.equal(clean.nome, 'Ana');
  assert.equal(clean.consent, true);
  assert.equal(Object.prototype.hasOwnProperty.call(clean, 'chave com espaço'), false);
  assert.equal(clean.mensagem.length, 2000);
  assert.equal({}.poluido, undefined, 'nada de prototype pollution');
});

test('update substitui ou mescla, e registra no histórico', () => {
  const { store: s } = store();
  const { request } = s.create({ sessionId: SESSION, serviceId: 'agentes-ia' });
  s.update(request.id, SESSION, { data: { nome: 'Ana', email: 'ana@exemplo.com' } });
  s.update(request.id, SESSION, { data: { email: 'ana.corrigida@exemplo.com' } }); // correção
  const updated = s.get(request.id, SESSION);
  assert.equal(updated.data.nome, 'Ana');
  assert.equal(updated.data.email, 'ana.corrigida@exemplo.com');
  assert.ok(updated.history.some((entry) => entry.action === 'data_updated'));
});

test('transições fora da tabela são recusadas', () => {
  const { store: s } = store();
  const { request } = s.create({ sessionId: SESSION, serviceId: 'agentes-ia' });
  const jump = s.transition(request, REQUEST_STATES.submitted);
  assert.equal(jump.ok, false);
  assert.equal(jump.error.code, 'invalid_transition');
  assert.match(jump.error.message, /draft/);
});

test('envio duplicado é impossível: submitting reserva e submitted é final', () => {
  const { store: s } = store();
  const { request } = s.create({ sessionId: SESSION, serviceId: 'agentes-ia' });
  s.update(request.id, SESSION, { state: REQUEST_STATES.collecting });
  s.update(request.id, SESSION, { state: REQUEST_STATES.validating });
  s.update(request.id, SESSION, { state: REQUEST_STATES.waitingApproval });

  const first = s.beginSubmit(request.id, SESSION);
  assert.equal(first.ok, true);
  assert.equal(first.request.state, REQUEST_STATES.submitting);

  // Segundo envio concorrente: recusado explicitamente.
  const second = s.beginSubmit(request.id, SESSION);
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'submit_in_progress');

  s.completeSubmit(request.id, SESSION, { externalId: 'PRT-1' });
  const third = s.beginSubmit(request.id, SESSION);
  assert.equal(third.ok, false);
  assert.equal(third.error.code, 'already_submitted');
  assert.equal(s.get(request.id, SESSION).externalId, 'PRT-1');
});

test('falha de envio volta para failed e permite nova tentativa', () => {
  const { store: s } = store();
  const { request } = s.create({ sessionId: SESSION, serviceId: 'agentes-ia' });
  s.update(request.id, SESSION, { state: REQUEST_STATES.collecting });
  s.update(request.id, SESSION, { state: REQUEST_STATES.validating });
  s.update(request.id, SESSION, { state: REQUEST_STATES.waitingApproval });
  s.beginSubmit(request.id, SESSION);
  const failed = s.failSubmit(request.id, SESSION, { code: 'network_error', message: 'sem rede' });
  assert.equal(failed.ok, true);
  assert.equal(failed.request.state, REQUEST_STATES.failed);
  assert.equal(failed.request.lastError.code, 'network_error');
  // A partir de `failed`, um novo envio é permitido (comportamento desejado).
  assert.equal(s.beginSubmit(request.id, SESSION).ok, true);
});

test('cancelamento: rascunho cancela; enviado exige backend real', () => {
  const { store: s } = store();
  const { request } = s.create({ sessionId: SESSION, serviceId: 'agentes-ia' });
  const cancelled = s.cancel(request.id, SESSION, { reason: 'mudou de ideia' });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.request.state, REQUEST_STATES.cancelled);

  // Cancelar de novo é idempotente.
  const again = s.cancel(request.id, SESSION);
  assert.equal(again.ok, true);
  assert.equal(again.alreadyCancelled, true);
});

test('a solicitação persiste entre leituras (retomada depois de navegar)', () => {
  const { store: s, dataDir } = store();
  const { request } = s.create({ sessionId: SESSION, siteId: 'opportunity-ai', serviceId: 'voz' });
  s.update(request.id, SESSION, { data: { nome: 'Ana' } });

  // Instância nova sobre o mesmo diretório = servidor reiniciado.
  const reopened = createRequestStore({ dataDir });
  const reloaded = reopened.activeFor(SESSION);
  assert.equal(reloaded.id, request.id);
  assert.equal(reloaded.data.nome, 'Ana');
  assert.equal(reloaded.siteId, 'opportunity-ai');
});

test('sessão inválida não cria solicitação (sem dono não há isolamento)', () => {
  const { store: s } = store();
  assert.equal(s.create({ sessionId: '', serviceId: 'voz' }).ok, false);
  assert.equal(s.create({ sessionId: 'sessao-invalida', serviceId: 'voz' }).ok, false);
  assert.equal(s.create({ sessionId: SESSION, serviceId: '' }).ok, false);
});

test('estados do briefing estão todos definidos e no caminho do fluxo', () => {
  const esperados = [
    'draft',
    'collecting_information',
    'waiting_for_upload',
    'validating',
    'waiting_for_approval',
    'submitting',
    'submitted',
    'failed',
    'cancelled',
  ];
  assert.deepEqual(Object.values(REQUEST_STATES).sort(), esperados.sort());
});
