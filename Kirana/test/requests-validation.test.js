/**
 * Fase 5 — validação de requisitos e upload.
 *
 * Nenhum teste aqui abre socket: `validateUpload` é função pura e o
 * `createFileStore` escreve em diretório temporário. Os bytes de exemplo são
 * montados à mão para provar a checagem de assinatura (magic bytes).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadRequirements,
  requirementsFor,
  validateRequestData,
  missingFieldsText,
} from '../src/requests/requirements.js';
import { validateUpload, createFileStore, FILE_LIMITS } from '../src/requests/files.js';

const SITE_DIR = path.join(import.meta.dirname, '..', 'sites', 'opportunity-ai');

/* ---------------------------------------------------------------- requisitos */

test('loadRequirements lê o catálogo e não inventa requisitos', () => {
  const catalog = loadRequirements({ dir: SITE_DIR });
  assert.ok(catalog);
  assert.equal(catalog.siteId, 'opportunity-ai');
  assert.ok(catalog.list().length >= 7, 'os 7 serviços do site devem estar cadastrados');

  const agentes = requirementsFor(catalog, 'agentes-ia');
  assert.equal(agentes.ok, true);
  assert.equal(agentes.requisitosPublicados.disponivel, false);
  assert.match(agentes.requisitosPublicados.motivo, /não publica|nao publica/i);
  assert.ok(agentes.aviso, 'a ferramenta precisa avisar que os campos não são exigência publicada');
  // Separação explícita: campo do formulário do site x campo operacional.
  assert.ok(agentes.camposDoFormulario.includes('email'));
  assert.ok(agentes.camposDeCaso.includes('endereco_site'));
  const operacional = agentes.campos.find((campo) => campo.nome === 'endereco_site');
  assert.equal(operacional.origem, 'operacional');
});

test('catálogo ausente não derruba a ferramenta: devolve null e a ferramenta explica', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-noreq-'));
  assert.equal(loadRequirements({ dir: empty }), null);
  const semCatalogo = requirementsFor(null, 'agentes-ia');
  assert.equal(semCatalogo.ok, false);
  assert.match(semCatalogo.erro, /indispon/i);
});

test('requirementsFor recusa serviço desconhecido sem chutar outro', () => {
  const catalog = loadRequirements({ dir: SITE_DIR });
  const desconhecido = requirementsFor(catalog, 'servico-que-nao-existe');
  assert.equal(desconhecido.ok, false);
  assert.ok(desconhecido.servicosComRequisitos.includes('agentes-ia'));
  assert.equal(requirementsFor(catalog, '').ok, false);
});

test('validação aponta válidos, ausentes, erros e o próximo campo', () => {
  const requirements = loadRequirements({ dir: SITE_DIR });

  const vazio = validateRequestData({ requirements, serviceId: 'agentes-ia', data: {} });
  assert.equal(vazio.ok, true);
  assert.equal(vazio.completo, false);
  assert.ok(vazio.ausentes.length > 0);
  assert.ok(vazio.proximoCampo, 'deve indicar o próximo campo a perguntar');
  assert.equal(vazio.erros.length, 0, 'campo vazio é ausente, não erro');
  assert.equal(vazio.proximaAcao, 'coletar_dados');

  // E-mail inválido é erro (não ausente) e pede correção.
  const ruim = validateRequestData({
    requirements,
    serviceId: 'agentes-ia',
    data: { nome: 'Ana', email: 'ana-arroba', interesse: 'Agentes de IA', mensagem: 'oi', consent: true },
  });
  assert.ok(ruim.erros.some((erro) => erro.campo === 'email'));
  assert.equal(ruim.completo, false);
  assert.equal(ruim.proximaAcao, 'corrigir_dados');
});

test('validação completa: dados íntegros pedem confirmação e nada fica faltando', () => {
  const requirements = loadRequirements({ dir: SITE_DIR });
  const spec = requirementsFor(requirements, 'agentes-ia');
  const data = {
    nome: 'Ana Souza',
    email: 'ana@exemplo.com',
    interesse: 'Agentes de IA',
    mensagem: 'Quero um agente no meu site para qualificar contatos.',
    consent: true,
    endereco_site: 'https://exemplo.com',
    funcao_do_agente: 'Responder dúvidas e encaminhar orçamentos',
  };
  // Todo campo obrigatório precisa estar coberto — senão o teste avisa qual falta.
  const faltando = spec.camposObrigatorios.filter((nome) => data[nome] === undefined);
  assert.deepEqual(faltando, []);

  const ok = validateRequestData({ requirements, serviceId: 'agentes-ia', data });
  assert.equal(ok.completo, true, `ausentes: ${ok.ausentes.map((item) => item.campo).join(', ')}`);
  assert.equal(ok.proximaAcao, 'pedir_confirmacao');
  assert.equal(ok.proximoCampo, null);
  assert.deepEqual(missingFieldsText(ok), []);
});

test('missingFieldsText devolve rótulos legíveis (para o pedido progressivo)', () => {
  const requirements = loadRequirements({ dir: SITE_DIR });
  const parcial = validateRequestData({ requirements, serviceId: 'agentes-ia', data: { nome: 'Ana' } });
  const texto = missingFieldsText(parcial);
  assert.ok(Array.isArray(texto) && texto.length > 0);
  assert.ok(texto.includes('E-mail'), 'usa o rótulo, não o nome técnico');
});

/* -------------------------------------------------------------------- upload */

function pdfBytes(extra = 0) {
  return Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(extra, 0x20)]);
}

function pngBytes() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}

test('upload válido é aceito e devolve metadados sem executar nada', () => {
  const result = validateUpload({ filename: 'briefing.pdf', contentType: 'application/pdf', buffer: pdfBytes(200) });
  assert.equal(result.ok, true);
  assert.equal(result.meta.ext, 'pdf');
  assert.equal(result.meta.name, 'briefing.pdf');
  assert.equal(result.meta.contentType, 'application/pdf');
  assert.ok(result.meta.size > 0);
});

test('upload inválido: extensão bloqueada, tipo não aceito, assinatura, MIME, tamanho e vazio', () => {
  const svg = validateUpload({ filename: 'logo.svg', contentType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  assert.equal(svg.ok, false, 'svg é recusado (pode carregar script)');
  assert.equal(svg.code, 'blocked_type');

  const exe = validateUpload({ filename: 'malware.exe', contentType: 'application/octet-stream', buffer: Buffer.from('MZ') });
  assert.equal(exe.code, 'blocked_type');

  const gif = validateUpload({ filename: 'anim.gif', contentType: 'image/gif', buffer: Buffer.from('GIF89a') });
  assert.equal(gif.code, 'type_not_allowed');

  // .pdf com bytes de outra coisa: a assinatura não confere.
  const falso = validateUpload({ filename: 'nota.pdf', contentType: 'application/pdf', buffer: Buffer.from('MZ nao e pdf') });
  assert.equal(falso.ok, false);
  assert.equal(falso.code, 'content_mismatch');

  // MIME declarado não bate com a extensão.
  const mime = validateUpload({ filename: 'foto.png', contentType: 'application/pdf', buffer: pngBytes() });
  assert.equal(mime.ok, false);
  assert.equal(mime.code, 'content_type_mismatch');

  const grande = validateUpload({ filename: 'grande.pdf', contentType: 'application/pdf', buffer: pdfBytes(FILE_LIMITS.maxBytes) });
  assert.equal(grande.code, 'file_too_large');

  const vazio = validateUpload({ filename: 'vazio.pdf', contentType: 'application/pdf', buffer: Buffer.alloc(0) });
  assert.equal(vazio.code, 'empty_file');

  const semExtensao = validateUpload({ filename: 'arquivo', contentType: 'application/pdf', buffer: pdfBytes() });
  assert.equal(semExtensao.code, 'missing_extension');

  const muitos = validateUpload({ filename: 'a.pdf', contentType: 'application/pdf', buffer: pdfBytes(), currentCount: 5 });
  assert.equal(muitos.code, 'too_many_files');
});

function fakeRequest(id = 'REQ-2026-ABC123') {
  return { id, files: [] };
}

test('fileStore grava na pasta da solicitação, com permissão restrita do dono', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-files-'));
  const store = createFileStore({ dataDir, retentionDays: 30 });
  const request = fakeRequest();
  const saved = store.save(request, { filename: 'briefing.pdf', contentType: 'application/pdf', buffer: pdfBytes(64) });
  assert.equal(saved.ok, true);
  assert.match(saved.file.id, /^f_[a-f0-9]{12}$/);
  assert.ok(saved.path.includes('REQ-2026-ABC123'), 'fica isolado por solicitação');

  const stat = fs.statSync(saved.path);
  assert.equal(stat.mode & 0o777, 0o600, 'arquivo do visitante só pode ser lido pelo dono');

  const resolved = store.resolve(request.id, saved.file);
  assert.equal(resolved, saved.path);
  assert.equal(store.remove(request.id, saved.file), true);
  assert.equal(store.resolve(request.id, saved.file), null);
});

test('fileStore contém path traversal e expira pela retenção', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-files2-'));
  const store = createFileStore({ dataDir, retentionDays: 0 });
  const request = fakeRequest('REQ-2026-XYZ789');
  const saved = store.save(request, { filename: 'a.pdf', contentType: 'application/pdf', buffer: pdfBytes() });
  assert.equal(saved.ok, true);

  // Ids forjados nunca saem da raiz de uploads.
  assert.equal(store.resolve('../../etc', saved.file), null);
  assert.equal(store.resolve('REQ-2026-XYZ789', { id: '../../etc/passwd', ext: 'pdf' }), null);
  assert.equal(store.resolve('REQ-2026-XYZ789', { id: 'x', ext: '../..' }), null);

  // Retenção zero: o arquivo nasce vencido e a purga o apaga.
  request.files = [saved.file];
  assert.ok(store.purgeExpired([request]) >= 1);
  assert.equal(store.resolve(request.id, saved.file), null);
});

test('removeAll apaga o diretório da solicitação (cancelamento)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirana-files3-'));
  const store = createFileStore({ dataDir });
  const request = fakeRequest('REQ-2026-DEL000');
  const saved = store.save(request, { filename: 'a.pdf', contentType: 'application/pdf', buffer: pdfBytes() });
  assert.equal(store.removeAll(request.id), true);
  assert.equal(fs.existsSync(path.dirname(saved.path)), false);
});
