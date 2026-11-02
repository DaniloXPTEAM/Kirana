/**
 * Fase 5 — ferramentas operacionais: o fluxo de 13 passos, ponta a ponta.
 *
 * Cada teste aqui executa handlers reais contra o `site.json` e o
 * `requirements.json` reais do site, com store e disco temporários. Só o
 * backend externo é mockado (e sempre por injeção explícita no teste) — nunca
 * há mock escondido dentro do código de produção.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSiteKit } from '../src/copilot/site-kit.js';
import { createSiteContext } from '../src/site/context.js';
import { createRequestTools } from '../src/site/request-tools.js';
import { createRequestStore, REQUEST_STATES } from '../src/requests/store.js';
import { loadRequirements } from '../src/requests/requirements.js';
import { createFileStore } from '../src/requests/files.js';

const SITES_DIR = path.join(process.cwd(), 'sites');
const SITE = 'opportunity-ai';
const SESSION = 's_33333333-3333-3333-3333-333333333333';
const siteContext = createSiteContext({ siteKit: createSiteKit({ sitesDir: SITES_DIR }), sitesDir: SITES_DIR });

function bench({ endpoint = null, fetchImpl = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-tools-'));
  const store = createRequestStore({ dataDir });
  const files = createFileStore({ dataDir });
  const requirements = loadRequirements({ dir: path.join(SITES_DIR, SITE) });
  const config = { requests: { endpoint } };
  const { tools, shape, submitEndpoint, uploadPolicy } = createRequestTools({
    siteContext,
    requests: { store, requirements },
    files,
    defaultSiteId: SITE,
    config,
  });
  const find = (name) => {
    const entry = tools.find((item) => item.name === name);
    assert.ok(entry, `ferramenta ${name} deve existir`);
    return entry;
  };
  const call = (name, args = {}, ctx = {}) =>
    find(name).handler(args, { siteId: SITE, sessionId: SESSION, siteState: {}, ...ctx });
  return { store, files, requirements, tools, find, call, shape, submitEndpoint, uploadPolicy, dataDir };
}

const dadosCompletos = {
  nome: 'Ana Souza',
  email: 'ana@exemplo.com',
  interesse: 'Agentes de IA',
  mensagem: 'Quero um agente no meu site para qualificar contatos.',
  consent: true,
  endereco_site: 'https://exemplo.com',
  funcao_do_agente: 'Responder dúvidas e encaminhar orçamentos',
};

/* ------------------------------------------------- 1. registro das 8 novas */

test('as 8 ferramentas operacionais têm schema, permissão declarada e handler', () => {
  const { tools } = bench();
  assert.equal(tools.length, 8);
  const nomes = tools.map((entry) => entry.name).sort();
  assert.deepEqual(nomes, [
    'cancel_service_request',
    'fill_site_form',
    'get_request_status',
    'get_service_requirements',
    'request_file_upload',
    'start_service_request',
    'submit_service_request',
    'validate_service_request',
  ]);
  for (const entry of tools) {
    assert.match(entry.name, /^[a-z][a-z0-9_]+$/);
    assert.ok(entry.title?.length > 3, `${entry.name}: título`);
    assert.ok(entry.description?.length > 30, `${entry.name}: descrição`);
    assert.equal(entry.parameters.type, 'object');
    assert.equal(entry.parameters.additionalProperties, false, `${entry.name}: schema fechado`);
    assert.equal(typeof entry.handler, 'function');
    assert.ok(['read', 'write'].includes(entry.kind), `${entry.name}: kind`);
    if (entry.kind === 'write') {
      assert.equal(entry.requiresConfirmation, true, `${entry.name}: escrita exige HITL`);
      assert.equal(typeof entry.summarize, 'function', `${entry.name}: resumo para o HITL`);
      assert.equal(typeof entry.description, 'string');
    }
  }
  // Só as duas que tiram o pedido do controle do visitante são de escrita.
  assert.deepEqual(tools.filter((entry) => entry.kind === 'write').map((entry) => entry.name).sort(), [
    'cancel_service_request',
    'submit_service_request',
  ]);
});

/* ------------------------------------------------ 2. requisitos do serviço */

test('get_service_requirements: diz que o site não publica requisitos', () => {
  const { call } = bench();
  const result = call('get_service_requirements', { serviceId: 'agentes de ia' });
  assert.equal(result.ok, true);
  assert.equal(result.serviceId, 'agentes-ia');
  assert.equal(result.requisitosPublicados.disponivel, false);
  assert.ok(result.aviso.length > 20);
  assert.ok(result.campos.length > 0);
  assert.equal(result.upload.enabled, true);

  const inexistente = call('get_service_requirements', { serviceId: 'coisas-que-nao-existem' });
  assert.equal(inexistente.ok, false);
});

/* ------------------------------------------------ 3. rascunho e retomada */

test('start_service_request cria rascunho local e retoma em vez de duplicar', () => {
  const { call, store } = bench();
  const created = call('start_service_request', { serviceId: 'agentes-ia' });
  assert.equal(created.ok, true);
  assert.equal(created.enviado, false);
  assert.equal(created.retomada, false);
  assert.match(created.solicitacao.id, /^REQ-\d{4}-/);
  assert.equal(created.solicitacao.estado, REQUEST_STATES.draft);

  const again = call('start_service_request', { serviceId: 'voz' });
  assert.equal(again.ok, true);
  assert.equal(again.retomada, true, 'uma atividade por vez: retoma a existente');
  assert.equal(again.solicitacao.id, created.solicitacao.id);
  assert.equal(store.list(SESSION).length, 1);
});

test('start_service_request recusa sessão ausente (sem dono não há isolamento)', () => {
  const { call } = bench();
  const result = call('start_service_request', { serviceId: 'agentes-ia' }, { sessionId: null });
  assert.equal(result.ok, false);
  assert.match(result.erro, /sess/i);
});

/* --------------------------------------- 4/5. coleta progressiva e correção */

test('coleta progressiva: validação guia o próximo campo e aceita correção', () => {
  const { call, store } = bench();
  const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia' });
  store.update(solicitacao.id, SESSION, { data: { nome: 'Ana' } });

  const parcial = call('validate_service_request', {});
  assert.equal(parcial.completo, false);
  assert.ok(parcial.camposAusentes.length > 0);
  assert.ok(parcial.proximoCampo);
  assert.ok(parcial.faltando.includes('E-mail'));

  // E-mail errado → erro, com instrução de correção.
  store.update(solicitacao.id, SESSION, { data: { email: 'ana-arroba' } });
  const comErro = call('validate_service_request', {});
  assert.equal(comErro.proximaAcao, 'corrigir_dados');
  assert.ok(comErro.erros.some((erro) => erro.campo === 'email'));

  // Correção: o campo volta a válido e a lista de ausentes diminui.
  store.update(solicitacao.id, SESSION, { data: { email: 'ana@exemplo.com' } });
  const corrigido = call('validate_service_request', {});
  assert.equal(corrigido.camposValidos.includes('email'), true);
  assert.ok(corrigido.camposAusentes.length < parcial.camposAusentes.length);

  // Completo → pede confirmação e o estado acompanha.
  store.update(solicitacao.id, SESSION, { data: dadosCompletos });
  const completo = call('validate_service_request', {});
  assert.equal(completo.completo, true);
  assert.equal(completo.proximaAcao, 'pedir_confirmacao');
  assert.equal(store.get(solicitacao.id, SESSION).state, REQUEST_STATES.waitingApproval);
});

/* -------------------------------------------------- 6/7. upload de arquivo */

test('request_file_upload pede o arquivo com a política real do site', () => {
  const { call } = bench();
  const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia' });
  const result = call('request_file_upload', { motivo: 'Briefing do projeto' });
  assert.equal(result.ok, true);
  assert.equal(result.requestId, solicitacao.id);
  assert.equal(result.siteAction.type, 'request_upload');
  assert.match(result.siteAction.accept, /\.pdf/);
  assert.equal(result.siteAction.maxMb, 5);
  assert.equal(result.siteAction.maxFiles, 5);
  assert.equal(result.siteAction.requestId, solicitacao.id);
});

test('upload inválido é registrado como recusa e não entra na solicitação', () => {
  const { call, store, files } = bench();
  const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia' });
  const request = store.get(solicitacao.id, SESSION);

  const recusado = files.save(request, { filename: 'script.sh', contentType: 'text/plain', buffer: Buffer.from('#!/bin/sh') });
  assert.equal(recusado.ok, false);
  assert.equal(store.get(solicitacao.id, SESSION).files.length, 0);

  const aceito = files.save(request, { filename: 'briefing.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nconteudo') });
  assert.equal(aceito.ok, true);
  assert.equal(store.addFile(solicitacao.id, SESSION, aceito.file).ok, true);
  const final = store.get(solicitacao.id, SESSION);
  assert.equal(final.state, REQUEST_STATES.waitingUpload, 'receber arquivo move a tarefa para waiting_for_upload');
  assert.equal(final.files.length, 1);
  assert.ok(final.files[0].expiresAt, 'todo arquivo tem data de expiração');
});

/* ------------------------------------------------ 8. isolamento de sessões */

test('isolamento: outra sessão não vê nem altera a solicitação', () => {
  const { call, store } = bench();
  const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia' });
  call('start_service_request', { serviceId: 'voz' }, { sessionId: 's_44444444-4444-4444-4444-444444444444' });

  const alheia = call('get_request_status', { requestId: solicitacao.id }, { sessionId: 's_44444444-4444-4444-4444-444444444444' });
  assert.equal(alheia.encontrada, false, 'não revela a solicitação de outra sessão');

  const cancelar = call('cancel_service_request', { requestId: solicitacao.id }, { sessionId: 's_44444444-4444-4444-4444-444444444444' });
  assert.equal(cancelar.ok, false);
  assert.equal(store.get(solicitacao.id, SESSION).state, REQUEST_STATES.draft);
});

/* ------------------------------------------------- 9. preencher formulário */

test('fill_site_form devolve ação registrada com seletores do site e nunca envia', () => {
  const { call, store } = bench();
  const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia', dados: dadosCompletos });
  const result = call('fill_site_form', { form: 'contato' });
  assert.equal(result.ok, true);
  assert.equal(result.enviado, false);
  assert.equal(result.siteAction.type, 'fill_form');
  assert.equal(result.siteAction.form, 'contato');
  const nomes = result.siteAction.fields.map((field) => field.field);
  assert.ok(nomes.includes('nome') && nomes.includes('email'));
  for (const field of result.siteAction.fields) {
    assert.match(field.selector, /^[#.\[]/, 'seletor declarado pelo site, não inventado pelo modelo');
  }
  // Preencher não aprova: com dados completos a tarefa vai para validação.
  assert.equal(store.get(solicitacao.id, SESSION).state, REQUEST_STATES.validating);
  // E a validação é quem leva a aguardar aprovação.
  call('validate_service_request', {});
  assert.equal(store.get(solicitacao.id, SESSION).state, REQUEST_STATES.waitingApproval);

  const inexistente = call('fill_site_form', { form: 'nao-existe' });
  assert.equal(inexistente.ok, false);
  assert.ok(inexistente.formularios.includes('contato'));
});

/* --------------------------------------------- 10/11. HITL e envio único */

test('submit_service_request sem endpoint: não envia e mantém rascunho', async () => {
  const { call, store } = bench();
  const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia', dados: dadosCompletos });
  call('validate_service_request', {});

  const envio = await call('submit_service_request', { requestId: solicitacao.id });
  assert.equal(envio.ok, false);
  assert.equal(envio.enviado, false);
  assert.equal(envio.motivo, 'endpoint_nao_configurado');
  assert.match(envio.erro, /rascunho/i);
  assert.equal(store.get(solicitacao.id, SESSION).state, REQUEST_STATES.waitingApproval);
});

test('submit recusa dados incompletos mesmo com chamada direta (servidor valida)', async () => {
  const { call } = bench();
  const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia', dados: { nome: 'Ana' } });
  const envio = await call('submit_service_request', { requestId: solicitacao.id });
  assert.equal(envio.ok, false);
  assert.equal(envio.enviado, false);
  assert.ok(envio.camposAusentes.length > 0);
});

test('submit recusa envio em estado não aprovado (defesa contra atalho)', async () => {
  const { call, store } = bench();
  const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia', dados: dadosCompletos });
  assert.equal(store.get(solicitacao.id, SESSION).state, REQUEST_STATES.collecting);
  const envio = await call('submit_service_request', { requestId: solicitacao.id });
  assert.equal(envio.ok, false);
  assert.match(envio.erro, /aprova/i);
});

test('com endpoint mockado: envia uma vez, ignora a segunda e registra protocolo', async () => {
  let chamadas = 0;
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () => {
    chamadas += 1;
    return { ok: true, status: 200, json: async () => ({ protocolo: 'OPP-2026-0001' }) };
  };
  try {
    const { call, store } = bench({ endpoint: 'https://exemplo.invalid/requests' });
    const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia', dados: dadosCompletos });
    call('validate_service_request', {});
    const envio = await call('submit_service_request', { requestId: solicitacao.id });
    assert.equal(envio.enviado, true);
    assert.equal(envio.protocolo, 'OPP-2026-0001');
    assert.equal(envio.estado, REQUEST_STATES.submitted);

    const segundo = await call('submit_service_request', { requestId: solicitacao.id });
    assert.equal(segundo.enviado, false);
    assert.equal(chamadas, 1, 'envio duplicado não pode chegar ao backend');
    assert.equal(store.get(solicitacao.id, SESSION).externalId, 'OPP-2026-0001');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('falha do backend: estado failed, nada de sucesso inventado, reenvio possível', async () => {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new Error('sem rede'), { name: 'TypeError' });
  };
  try {
    const { call, store } = bench({ endpoint: 'https://exemplo.invalid/requests' });
    const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia', dados: dadosCompletos });
    call('validate_service_request', {});
    const envio = await call('submit_service_request', { requestId: solicitacao.id });
    assert.equal(envio.ok, false);
    assert.equal(envio.enviado, false);
    assert.match(envio.erro, /não foi possível|nao foi possivel|network_error/i);
    const request = store.get(solicitacao.id, SESSION);
    assert.equal(request.state, REQUEST_STATES.failed);
    assert.equal(request.submittedAt, null);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('HTTP 500 do backend também é falha declarada, não envio', async () => {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    const { call, store } = bench({ endpoint: 'https://exemplo.invalid/requests' });
    const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia', dados: dadosCompletos });
    call('validate_service_request', {});
    const envio = await call('submit_service_request', { requestId: solicitacao.id });
    assert.equal(envio.enviado, false);
    assert.match(envio.erro, /500/);
    assert.equal(store.get(solicitacao.id, SESSION).state, REQUEST_STATES.failed);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

/* ------------------------------------------------- 12/13. status e cancelar */

test('get_request_status devolve estado real e não inventa andamento', () => {
  const vazio = bench();
  const semSolicitacao = vazio.call('get_request_status', {});
  assert.equal(semSolicitacao.encontrada, false);

  const { call } = bench();
  call('start_service_request', { serviceId: 'voz', dados: { nome: 'Ana' } });
  const status = call('get_request_status', {});
  assert.equal(status.encontrada, true);
  assert.equal(status.solicitacao.estado, REQUEST_STATES.collecting);
  assert.equal(status.envioDisponivel, false);
  assert.match(status.observacao, /não há acompanhamento|nao ha acompanhamento/i);
  assert.ok(status.faltando.length > 0);
  assert.ok(status.historico.length >= 1);
});

test('cancel_service_request descarta rascunho e arquivos', () => {
  const { call, store, files } = bench();
  const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia', dados: dadosCompletos });
  const request = store.get(solicitacao.id, SESSION);
  const saved = files.save(request, { filename: 'a.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nx') });
  store.update(solicitacao.id, SESSION, { files: [saved.file] });

  const cancelado = call('cancel_service_request', { motivo: 'mudou de ideia' });
  assert.equal(cancelado.cancelada, true);
  assert.equal(cancelado.estado, REQUEST_STATES.cancelled);
  assert.equal(files.resolve(solicitacao.id, saved.file), null, 'arquivo do visitante é apagado');

  // Depois de cancelar, a sessão fica livre para outra solicitação.
  const novo = call('start_service_request', { serviceId: 'voz' });
  assert.equal(novo.ok, true);
  assert.notEqual(novo.solicitacao.id, solicitacao.id);
});

/* -------------------------------- 14. navegação não perde o contexto */

test('a solicitação sobrevive à navegação entre páginas (contexto na sessão)', () => {
  const { call, store } = bench();
  const { solicitacao } = call('start_service_request', { serviceId: 'agentes-ia', dados: { nome: 'Ana' } }, { siteState: { path: '/contato' } });
  // Visitante navega para outra página: o siteId/sessão são os mesmos.
  store.update(solicitacao.id, SESSION, { data: { email: 'ana@exemplo.com' } });
  const depois = call('get_request_status', {}, { siteState: { path: '/solucoes/agentes-ia' } });
  assert.equal(depois.solicitacao.id, solicitacao.id);
  assert.equal(depois.solicitacao.dados.email, 'ana@exemplo.com');
  assert.ok(depois.historico.length >= 2);
});

/* ---------------------------- 15. nenhuma credencial na saída das tools */

test('nenhuma ferramenta devolve token, caminho de disco ou segredo', () => {
  const { call } = bench({ endpoint: 'https://exemplo.invalid/requests' });
  call('start_service_request', { serviceId: 'agentes-ia', dados: dadosCompletos });
  for (const name of ['get_service_requirements', 'validate_service_request', 'get_request_status', 'fill_site_form']) {
    const args = name === 'get_service_requirements' ? { serviceId: 'agentes-ia' } : name === 'fill_site_form' ? { form: 'contato' } : {};
    const output = JSON.stringify(call(name, args));
    assert.equal(/Bearer|api[_-]?key|token"|KIRANA_GATEWAY|senha/i.test(output), false, `${name} vazou segredo`);
    assert.equal(output.includes('/home/'), false, `${name} vazou caminho de disco`);
    assert.equal(output.includes(SESSION), false, `${name} vazou id de sessão`);
  }
});
