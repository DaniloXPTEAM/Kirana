/**
 * Testes HTTP das rotas de voz (/api/voice/status e /api/voice/tts).
 *
 * O worker Python é substituído por um processo falso (`spawnImpl`), então
 * estes testes rodam sem rede e sem `edge-tts` instalado — eles provam o
 * contrato do servidor (auth, origem, sessão, limites, streaming, abort), não
 * a voz da Microsoft. A síntese real tem teste próprio, fora da suíte.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { startFakeGateway, startKirana } from './helpers.js';
import { createVoiceService, THALITA_VOICE, VoiceError } from '../src/voice/tts.js';

/** Processo falso: registra o texto recebido e devolve MP3 de mentira. */
function fakeWorker({ bytes = 'audio-mpeg-fake', failStatus = null, onAbort = null } = {}) {
  const created = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    const received = { text: null, killed: false };
    child.stdout = Readable.from([Buffer.from(bytes)]);
    child.stdout.on('end', () => setTimeout(() => child.emit('close', 0), 1));
    child.stderr = new EventEmitter();
    child.stdin = {
      end(payload) {
        if (payload) {
          try {
            received.text = JSON.parse(payload).text;
          } catch {
            received.text = payload;
          }
        }
        setTimeout(() => child.emit('close', failStatus === 'exit_error' ? 2 : 0), 1);
      },
    };
    child.kill = () => {
      received.killed = true;
      onAbort?.(received);
      child.emit('close', 143);
    };
    created.push({ command, args, received });
    return child;
  };
  return { spawnImpl, created };
}

const service = (options) => createVoiceService({ pythonCommand: 'python3', ...options });

async function newSession(base, headers = {}) {
  const response = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: '{}',
  });
  return response.json();
}

async function withServer(voice, run, { env = {} } = {}) {
  const gateway = await startFakeGateway({ script: () => ({ text: 'ok' }) });
  const kirana = await startKirana({ gatewayUrl: gateway.url, env, overrides: { voice } });
  try {
    await run(kirana);
  } finally {
    await kirana.close();
    await gateway.close();
  }
}

test('GET /api/voice/status informa o motor sem chamar a rede', async () => {
  const { spawnImpl } = fakeWorker({ bytes: JSON.stringify([{ shortName: THALITA_VOICE, gender: 'Female', locale: 'pt-BR' }]) });
  await withServer(service({ spawnImpl }), async (kirana) => {
    const response = await fetch(`${kirana.base}/api/voice/status`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.available, true);
    assert.equal(body.voice, THALITA_VOICE);
    assert.equal(body.streaming, true);
    assert.equal(body.mime, 'audio/mpeg');
    assert.equal(body.maxChars, 3000);
  });
});

test('status reporta indisponível quando o provedor falha (sem derrubar a Kirana)', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = Readable.from([]);
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => {};
    setTimeout(() => child.emit('close', 2), 1);
    return child;
  };
  await withServer(service({ spawnImpl }), async (kirana) => {
    const body = await (await fetch(`${kirana.base}/api/voice/status`)).json();
    assert.equal(body.available, false);
    assert.equal(body.provider, 'edge-tts');
    assert.match(body.note, /fora do ar|não está no catálogo/i);
  });
});

test('POST /api/voice/tts devolve MP3 em stream com os cabeçalhos certos', async () => {
  const { spawnImpl, created } = fakeWorker({ bytes: 'ID3-fake-mp3-bytes' });
  await withServer(service({ spawnImpl }), async (kirana) => {
    const session = await newSession(kirana.base);
    const response = await fetch(`${kirana.base}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, text: 'Olá, sou a Kirana.' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('x-kirana-voice'), THALITA_VOICE);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.toString('utf8'), 'ID3-fake-mp3-bytes');
    assert.equal(created[0].received.text, 'Olá, sou a Kirana.');
  });
});

test('o texto falado é limpo (emoji, markdown, URL) antes do motor', async () => {
  const { spawnImpl, created } = fakeWorker();
  await withServer(service({ spawnImpl }), async (kirana) => {
    const session = await newSession(kirana.base);
    await fetch(`${kirana.base}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, text: '**Pronto!** 👋 Veja https://opportunity.ia.br' }),
    }).then((r) => r.arrayBuffer());
    const sent = created[0].received.text;
    assert.equal(sent.includes('*'), false);
    assert.equal(sent.includes('http'), false);
    assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(sent), false);
    assert.match(sent, /Pronto!/);
  });
});

test('não altera o histórico da sessão ao gerar voz', async () => {
  const { spawnImpl } = fakeWorker();
  await withServer(service({ spawnImpl }), async (kirana) => {
    const session = await newSession(kirana.base);
    const before = await (await fetch(`${kirana.base}/api/session?sessionId=${session.id}`)).json();
    await fetch(`${kirana.base}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, text: 'Uma frase qualquer.' }),
    }).then((r) => r.arrayBuffer());
    const after = await (await fetch(`${kirana.base}/api/session?sessionId=${session.id}`)).json();
    assert.deepEqual(after.session?.messages ?? after.messages ?? [], before.session?.messages ?? before.messages ?? []);
  });
});

test('TTS exige sessão existente (isolamento por conversa)', async () => {
  const { spawnImpl, created } = fakeWorker();
  await withServer(service({ spawnImpl }), async (kirana) => {
    const response = await fetch(`${kirana.base}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's_inexistente', text: 'oi' }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'session_not_found');
    assert.equal(created.length, 0, 'nenhum processo de voz deve ser criado');
  });
});

test('texto sem conteúdo falável é recusado com 400', async () => {
  const { spawnImpl, created } = fakeWorker();
  await withServer(service({ spawnImpl }), async (kirana) => {
    const session = await newSession(kirana.base);
    const response = await fetch(`${kirana.base}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, text: '😊 *** ---' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'voice_empty_text');
    assert.equal(created.length, 0);
  });
});

test('texto acima do limite é recusado com 413 (proteção de custo/abuso)', async () => {
  const { spawnImpl, created } = fakeWorker();
  await withServer(service({ spawnImpl }), async (kirana) => {
    const session = await newSession(kirana.base);
    const response = await fetch(`${kirana.base}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, text: `palavra ${'a'.repeat(5000)}` }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'voice_text_too_long');
    assert.equal(created.length, 0);
  });
});

test('com KIRANA_ACCESS_TOKEN, voz exige token como o resto da API', async () => {
  const { spawnImpl } = fakeWorker();
  await withServer(
    service({ spawnImpl }),
    async (kirana) => {
      const unauthorized = await fetch(`${kirana.base}/api/voice/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's_x', text: 'oi' }),
      });
      assert.equal(unauthorized.status, 401);
      assert.equal((await fetch(`${kirana.base}/api/voice/status`)).status, 401);

      const ok = await fetch(`${kirana.base}/api/voice/status`, { headers: { Authorization: 'Bearer segredo-local' } });
      assert.equal(ok.status, 200);
    },
    { env: { KIRANA_ACCESS_TOKEN: 'segredo-local' } },
  );
});

test('origem diferente é recusada (mesma proteção do /api/chat)', async () => {
  const { spawnImpl } = fakeWorker();
  await withServer(service({ spawnImpl }), async (kirana) => {
    const session = await newSession(kirana.base);
    const response = await fetch(`${kirana.base}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://site-malicioso.example' },
      body: JSON.stringify({ sessionId: session.id, text: 'oi' }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'forbidden_origin');
  });
});

test('cliente desiste no meio: o processo de voz é encerrado (barge-in do servidor)', async () => {
  let killed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    // áudio "infinito": nunca termina sozinho
    child.stdout = new Readable({ read() {} });
    child.stdin = { end() {} };
    child.kill = () => {
      killed = true;
    };
    return child;
  };
  await withServer(service({ spawnImpl }), async (kirana) => {
    const session = await newSession(kirana.base);
    const controller = new AbortController();
    const request = fetch(`${kirana.base}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, text: 'Uma resposta longa para falar.' }),
      signal: controller.signal,
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 120));
    controller.abort();
    await request;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(killed, true, 'o worker precisa ser morto quando o navegador desiste');
  });
});

test('serviço desligado por configuração informa e recusa sem quebrar', async () => {
  const disabled = service({ provider: 'disabled' });
  const status = await disabled.status();
  assert.equal(status.available, false);
  assert.equal(status.provider, 'disabled');
  assert.throws(() => disabled.synthesizeStream('oi'), (error) => error instanceof VoiceError && error.code === 'voice_disabled');
});

test('abortar antes de começar não cria processo', async () => {
  const { spawnImpl, created } = fakeWorker();
  const voice = service({ spawnImpl });
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => voice.synthesizeStream('texto válido aqui', { signal: controller.signal }),
    (error) => error.code === 'voice_aborted',
  );
  assert.equal(created.length, 0);
});
