/**
 * Kit por site: permissões e ISOLAMENTO entre clientes.
 *
 * Um site nunca pode executar ferramenta que pertença a outro, nem herdar
 * sessão de outro site, mesmo com o mesmo threadId.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSiteKit, DEFAULT_SITE_ID, normalizeSite } from '../src/copilot/site-kit.js';
import { silentLogger } from './helpers.js';

function makeSites() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-sites-'));

  const write = (id, payload) => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'site.json'), JSON.stringify(payload), 'utf8');
  };

  write('site-a', {
    id: 'site-a',
    name: 'Cliente A',
    allowedOrigins: ['http://cliente-a.example'],
    tools: [
      { name: 'navigateToPage', description: 'navega', parameters: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'] } },
      { name: 'submitContactRequest', description: 'envia', parameters: { type: 'object', properties: {} }, requiresConfirmation: true },
    ],
  });

  write('site-b', {
    id: 'site-b',
    name: 'Cliente B',
    tools: [{ name: 'abrirOrcamento', description: 'orçamento', parameters: { type: 'object', properties: {} }, requiresConfirmation: true }],
  });

  return { dir, write };
}

const declared = [{ name: 'navigateToPage' }, { name: 'submitContactRequest' }, { name: 'abrirOrcamento' }];

test('carrega os sites do diretório e resolve pelo id', () => {
  const { dir } = makeSites();
  const kit = createSiteKit({ sitesDir: dir, logger: silentLogger });

  assert.equal(kit.list().length, 2);
  assert.equal(kit.get('site-a').name, 'Cliente A');
  assert.equal(kit.get('inexistente')?.id, kit.list()[0].id); // cai no padrão, nunca em null inesperado
});

test('site só recebe as ferramentas que declarou E são permitidas nele', () => {
  const { dir } = makeSites();
  const kit = createSiteKit({ sitesDir: dir, logger: silentLogger });

  const toolsA = kit.buildExternalTools('site-a', declared).map((t) => t.name);
  assert.deepEqual(toolsA.sort(), ['navigateToPage', 'submitContactRequest']);

  const toolsB = kit.buildExternalTools('site-b', declared).map((t) => t.name);
  assert.deepEqual(toolsB, ['abrirOrcamento']);
});

test('ISOLAMENTO: site A não executa ferramenta do site B e vice-versa', () => {
  const { dir } = makeSites();
  const kit = createSiteKit({ sitesDir: dir, logger: silentLogger });

  const toolsA = kit.buildExternalTools('site-a', [{ name: 'abrirOrcamento' }]);
  assert.equal(toolsA.length, 0, 'site-a não pode receber abrirOrcamento');

  const toolsB = kit.buildExternalTools('site-b', [{ name: 'submitContactRequest' }]);
  assert.equal(toolsB.length, 0, 'site-b não pode receber submitContactRequest');
});

test('ISOLAMENTO: mesmo threadId gera sessões diferentes por site', () => {
  const { dir } = makeSites();
  const kit = createSiteKit({ sitesDir: dir, logger: silentLogger });

  const sessionA = kit.sessionIdFor('site-a', 'thread-1');
  const sessionB = kit.sessionIdFor('site-b', 'thread-1');

  assert.notEqual(sessionA, sessionB);
  assert.match(sessionA, /^s_[a-f0-9]{40}$/);
  assert.equal(sessionA, kit.sessionIdFor('site-a', 'thread-1')); // determinístico
});

test('ferramenta marcada como sensível mantém requiresConfirmation', () => {
  const { dir } = makeSites();
  const kit = createSiteKit({ sitesDir: dir, logger: silentLogger });
  const tool = kit.buildExternalTools('site-a', ['submitContactRequest'])[0];

  assert.equal(tool.requiresConfirmation, true);
  assert.equal(tool.validate('{}').ok, true);
});

test('origem: bloqueia host não autorizado apenas quando o site declara origens', () => {
  const { dir } = makeSites();
  const kit = createSiteKit({ sitesDir: dir, logger: silentLogger });

  assert.equal(kit.originAllowed('site-a', 'http://cliente-a.example'), true);
  assert.equal(kit.originAllowed('site-a', 'http://outro.example'), false);
  assert.equal(kit.originAllowed('site-b', 'http://qualquer.example'), true); // sem lista = aberto
});

test('normalizeSite rejeita configurações inválidas', () => {
  assert.equal(normalizeSite(null), null);
  assert.equal(normalizeSite({ id: 'Com Espaço' }), null);
  assert.ok(normalizeSite({ id: 'ok-site' }));
});

test('config inválida em um site não derruba os demais', () => {
  const { dir, write } = makeSites();
  fs.mkdirSync(path.join(dir, 'quebrado'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'quebrado', 'site.json'), '{ isso não é json', 'utf8');
  write('site-c', { id: 'site-c', tools: [] });

  const kit = createSiteKit({ sitesDir: dir, logger: silentLogger });
  assert.ok(kit.get('site-a'));
  assert.ok(kit.get('site-c'));
});

test('catálogo real do projeto é válido e tem o site de demonstração', () => {
  const kit = createSiteKit({ sitesDir: path.join(process.cwd(), 'sites'), logger: silentLogger });
  const demo = kit.get(DEFAULT_SITE_ID);
  assert.ok(demo, 'site de demonstração precisa existir');
  assert.ok(demo.tools.some((t) => t.name === 'navigateToPage'));
  assert.ok(demo.tools.some((t) => t.name === 'submitContactRequest' && t.requiresConfirmation));
  assert.deepEqual(demo.stateKeys.sort(), ['formStep', 'lastAction', 'page', 'section', 'service']);
});
