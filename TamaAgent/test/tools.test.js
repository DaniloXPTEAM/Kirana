import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadCatalog } from '../src/catalog/index.js';
import { createMemoryStore } from '../src/memory.js';
import { createInterestStore } from '../src/interests.js';
import { createToolRegistry } from '../src/tools/registry.js';
import { createToolDefinitions } from '../src/tools/definitions.js';
import { silentLogger } from './helpers.js';

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-tools-'));
  const catalog = loadCatalog({ logger: silentLogger });
  const memory = createMemoryStore({ dataDir, limits: {}, logger: silentLogger });
  const interests = createInterestStore({ dataDir, logger: silentLogger });
  const registry = createToolRegistry({
    tools: createToolDefinitions({ catalog, memory, interests, logger: silentLogger }),
    logger: silentLogger,
  });
  return { catalog, memory, interests, registry, ctx: { memory, catalog, logger: silentLogger } };
}

test('registro expõe schemas e separa leitura de escrita', () => {
  const { registry } = setup();
  const names = registry.list().map((t) => t.name);
  assert.ok(names.includes('consultar_servicos'));
  assert.ok(names.includes('registrar_interesse_comercial'));
  assert.deepEqual(
    registry.readTools().map((t) => t.name).sort(),
    ['consultar_memoria', 'consultar_produtos', 'consultar_servicos', 'consultar_status_projeto'],
  );
  assert.deepEqual(registry.writeTools().map((t) => t.name).sort(), ['apagar_memoria', 'registrar_interesse_comercial', 'salvar_memoria']);

  const schema = registry.openAISchemas({ kind: 'read' })[0];
  assert.equal(schema.type, 'function');
  assert.equal(typeof schema.function.parameters, 'object');
});

test('consultar_servicos encontra serviço por texto', async () => {
  const { registry, ctx } = setup();
  const result = await registry.runRead('consultar_servicos', { consulta: 'atendimento no whatsapp' }, ctx);
  assert.equal(result.ok, true);
  assert.ok(result.data.servicos.some((s) => s.id === 'atendimento'));
});

test('consultar_servicos por id inexistente não inventa dados', async () => {
  const { registry, ctx } = setup();
  const result = await registry.runRead('consultar_servicos', { servico_id: 'nao-existe' }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.data.encontrado, false);
});

test('consultar_produtos devolve estágio conforme site', async () => {
  const { registry, ctx } = setup();
  const result = await registry.runRead('consultar_produtos', { produto_id: 'opportunity-crm' }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.data.produto.estagio, 'Ativo');
});

test('consultar_status_projeto marca dados simulados', async () => {
  const { registry, ctx } = setup();
  const result = await registry.runRead('consultar_status_projeto', { projeto_id: 'PRJ-001' }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.data.dados_simulados, true);
  assert.equal(result.data.projeto.id, 'PRJ-001');

  const missingArgs = registry.validate('consultar_status_projeto', {});
  assert.equal(missingArgs.ok, false);
});

test('ferramenta de escrita não roda por runRead', async () => {
  const { registry, ctx } = setup();
  const result = await registry.runRead('registrar_interesse_comercial', {}, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'confirmation_required');
});

test('registrar_interesse_comercial valida e-mail e consentimento', async () => {
  const { registry, ctx, interests } = setup();
  const invalidEmail = await registry.runWrite(
    'registrar_interesse_comercial',
    { nome: 'Ana', canal_tipo: 'email', canal_valor: 'ana-arroba', interesse: 'WhatsApp', consentimento: true },
    ctx,
  );
  assert.equal(invalidEmail.ok, false);
  assert.equal(invalidEmail.error.code, 'invalid_args');

  const noConsent = await registry.runWrite(
    'registrar_interesse_comercial',
    { nome: 'Ana', canal_tipo: 'email', canal_valor: 'ana@exemplo.com', interesse: 'WhatsApp', consentimento: false },
    ctx,
  );
  assert.equal(noConsent.ok, false);
  assert.equal(interests.count(), 0);
});

test('registrar_interesse_comercial grava localmente e não alega envio', async () => {
  const { registry, ctx, interests } = setup();
  const result = await registry.runWrite(
    'registrar_interesse_comercial',
    {
      nome: 'Ana Demo',
      canal_tipo: 'email',
      canal_valor: 'ana@exemplo.com',
      interesse: 'Atendimento digital',
      consentimento: true,
    },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.registrado, true);
  assert.match(result.data.protocolo, /^INT-\d{4}-/);
  assert.equal(result.data.envio_externo, false);
  assert.equal(interests.count(), 1);
});

test('salvar_memoria grava com consentimento e apagar_memoria remove', async () => {
  const { registry, ctx, memory } = setup();
  const saved = await registry.runWrite('salvar_memoria', { chave: 'nome', valor: 'Ana' }, ctx);
  assert.equal(saved.ok, true);
  assert.equal(memory.list().length, 1);

  const listed = await registry.runRead('consultar_memoria', {}, ctx);
  assert.equal(listed.data.total, 1);

  const removed = await registry.runWrite('apagar_memoria', { id: saved.data.item.id }, ctx);
  assert.equal(removed.data.apagado, true);
  assert.equal(memory.list().length, 0);
});

test('argumentos inválidos do modelo viram erro estruturado', async () => {
  const { registry, ctx } = setup();
  const result = await registry.runRead('consultar_servicos', 'nao-e-json', ctx);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_args');
});

test('ferramenta desconhecida é recusada', async () => {
  const { registry, ctx } = setup();
  const result = await registry.runRead('executar_comando', { cmd: 'rm -rf /' }, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unknown_tool');
});
