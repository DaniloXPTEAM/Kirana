/**
 * Human-in-the-Loop do envio de contato.
 *
 * A regra que estes testes protegem: uma autorização vale para UMA operação,
 * com EXATAMENTE os dados que o usuário viu. Reutilizar, trocar dados ou
 * deixar expirar exige nova confirmação.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDemoContact } from '../src/demo-contact.js';
import { createInterestStore } from '../src/interests.js';
import { silentLogger } from './helpers.js';

function make() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-hitl-'));
  let clock = 1_700_000_000_000;
  const interests = createInterestStore({ dataDir, logger: silentLogger });
  const contact = createDemoContact({ interests, logger: silentLogger, now: () => clock });
  return {
    contact,
    interests,
    advance(ms) {
      clock += ms;
    },
    now: () => clock,
  };
}

const VALUES = {
  nome: 'Ana Demo',
  email: 'ana.demo@exemplo.com',
  whatsapp: '(85) 99999-0000',
  empresa: 'Empresa Demo',
  interesse: 'Atendimento digital e WhatsApp',
  mensagem: 'Quero conhecer as soluções de IA para atendimento.',
};

test('prepare valida e NÃO grava nada', () => {
  const { contact, interests } = make();
  const prepared = contact.prepare({ values: VALUES });

  assert.equal(prepared.ok, true);
  assert.match(prepared.token, /^ct_[a-f0-9]{32}$/);
  assert.equal(prepared.confirmationRequired, true);
  assert.equal(interests.count(), 0, 'preparar não pode gravar');
});

test('prepare recusa dados incompletos ou e-mail inválido', () => {
  const { contact } = make();
  const missing = contact.prepare({ values: { nome: 'Ana' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'invalid_values');
  assert.ok(missing.errors.some((e) => e.path === 'email'));

  const badEmail = contact.prepare({ values: { ...VALUES, email: 'nao-e-email' } });
  assert.equal(badEmail.ok, false);
});

test('submit com autorização válida grava e devolve protocolo real', () => {
  const { contact, interests } = make();
  const { token } = contact.prepare({ values: VALUES });
  const result = contact.submit({ token, values: VALUES });

  assert.equal(result.ok, true);
  assert.match(result.protocolo, /^INT-\d{4}-[A-Z0-9]+$/);
  assert.equal(interests.count(), 1);
});

test('AUTORIZAÇÃO É DE USO ÚNICO: reapresentar o token falha', () => {
  const { contact, interests } = make();
  const { token } = contact.prepare({ values: VALUES });

  assert.equal(contact.submit({ token, values: VALUES }).ok, true);
  const second = contact.submit({ token, values: VALUES });

  assert.equal(second.ok, false);
  assert.equal(second.error, 'authorization_required');
  assert.equal(interests.count(), 1, 'não pode gravar duas vezes');
});

test('trocar os dados depois da confirmação invalida a autorização', () => {
  const { contact, interests } = make();
  const { token } = contact.prepare({ values: VALUES });

  const changed = contact.submit({ token, values: { ...VALUES, mensagem: 'outra mensagem' } });
  assert.equal(changed.ok, false);
  assert.equal(changed.error, 'authorization_mismatch');
  assert.equal(interests.count(), 0);

  // E o token não pode ser reaproveitado depois da tentativa inválida.
  assert.equal(contact.submit({ token, values: VALUES }).ok, false);
});

test('autorização expira e exige nova confirmação', () => {
  const { contact, interests, advance } = make();
  const { token, expiresAt } = contact.prepare({ values: VALUES });

  advance(11 * 60_000);
  const result = contact.submit({ token, values: VALUES });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'authorization_required');
  assert.equal(interests.count(), 0);
  assert.ok(expiresAt > 0);
});

test('cancelar = simplesmente não enviar (nada é gravado)', () => {
  const { contact, interests } = make();
  contact.prepare({ values: VALUES });
  assert.equal(interests.count(), 0);
});

test('token inventado não grava nada', () => {
  const { contact, interests } = make();
  assert.equal(contact.submit({ token: 'ct_inventado', values: VALUES }).ok, false);
  assert.equal(contact.submit({ token: null, values: VALUES }).ok, false);
  assert.equal(interests.count(), 0);
});

test('endpoints HTTP de prepare/submit respeitam o uso único', async () => {
  const { startFakeGateway, startKirana } = await import('./helpers.js');
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url });

  try {
    const prepared = await fetch(`${kirana.base}/api/demo/contact/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: VALUES }),
    });
    assert.equal(prepared.status, 200);
    const { token } = await prepared.json();
    assert.ok(token);

    const first = await fetch(`${kirana.base}/api/demo/contact/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, values: VALUES }),
    });
    assert.equal(first.status, 201);
    const body = await first.json();
    assert.match(body.protocolo, /^INT-/);

    const replay = await fetch(`${kirana.base}/api/demo/contact/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, values: VALUES }),
    });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error, 'authorization_required');
  } finally {
    await kirana.close();
    await gateway.close();
  }
});
