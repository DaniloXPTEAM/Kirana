import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityRegistry } from '../src/capabilities.js';
import { createFilePayload, TemporaryFileStore } from '../src/files.js';

function hasZipMagic(buffer) { return buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])); }

test('capability catalog exposes only implemented text and local-file functions', () => {
  const catalog = new CapabilityRegistry().list();
  assert.equal(catalog.find((x) => x.name === 'text.chat').available, true);
  assert.equal(catalog.find((x) => x.name === 'files.create').available, true);
  assert.equal(catalog.find((x) => x.name === 'files.upload').available, true);
  for (const name of ['images.analyze','images.generate','images.edit','video.analyze','video.generate','audio.transcribe','audio.synthesize']) {
    const entry = catalog.find((x) => x.name === name);
    assert.equal(entry.available, false, `${name} must not be advertised as active without an adapter`);
    assert.equal(entry.provider, null);
  }
  const preferenceOnly = new CapabilityRegistry({configuredProviders:{'images.analyze':'future-engine'}}).get('images.analyze');
  assert.equal(preferenceOnly.configured_provider,'siwc-responses');
  assert.equal(preferenceOnly.provider_preference,'future-engine');
  assert.equal(preferenceOnly.available,false);
});

test('creates all seven requested formats with correct filename, MIME, and file signature', () => {
  const examples = [
    [{format:'txt',content:'Olá'}, 'text/plain; charset=utf-8', Buffer.from('Olá')],
    [{format:'md',content:'# Kirana'}, 'text/markdown; charset=utf-8', Buffer.from('# Kirana')],
    [{format:'json',data:{ok:true}}, 'application/json; charset=utf-8', Buffer.from('{\n  "ok"')],
    [{format:'csv',rows:[['name','value'],['A','1']]}, 'text/csv; charset=utf-8', Buffer.from('"name","value"')],
    [{format:'pdf',content:'Olá em português'}, 'application/pdf', Buffer.from('%PDF-1.4')],
    [{format:'docx',content:'Olá Word'}, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from([0x50,0x4b,0x03,0x04])],
    [{format:'xlsx',rows:[['nome','valor'],['A',1]]}, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from([0x50,0x4b,0x03,0x04])],
  ];
  for (const [request, mime, signature] of examples) {
    const result = createFilePayload(request);
    assert.equal(result.mimeType, mime);
    assert.ok(result.buffer.subarray(0, signature.length).equals(signature), `${request.format} signature`);
    assert.equal(result.filename, `document.${request.format}`);
    assert.ok(result.buffer.length > 0);
  }
});

test('rejects malformed content, unsupported format, traversal names, and invalid spreadsheet values', () => {
  assert.throws(() => createFilePayload({format:'json',content:'{bad'}), {code:'invalid_json_content'});
  assert.throws(() => createFilePayload({format:'png',content:'no'}), {code:'unsupported_file_format'});
  assert.throws(() => createFilePayload({format:'txt',filename:'../x.txt',content:'x'}), {code:'invalid_filename'});
  assert.throws(() => createFilePayload({format:'xlsx',rows:[['=SUM(A1:A2)'],[{}]]}), {code:'invalid_cell'});
  assert.throws(() => createFilePayload({format:'xlsx',filename:'wrong.csv',rows:[]}), {code:'filename_extension_mismatch'});
});

test('CSV output quotes cells and neutralizes formula-leading text', () => {
  const {buffer} = createFilePayload({format:'csv',rows:[['Name','Value'],['A, "B"','=1+1']]});
  assert.equal(buffer.toString('utf8'), '"Name","Value"\r\n"A, ""B""","\'=1+1"\r\n');
});

test('temporary store creates, retrieves, deletes, and expires files under an opaque id', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kirana-files-test-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  let now = Date.now();
  const store = new TemporaryFileStore({directory:join(directory,'files'),maxFileBytes:1024,maxTotalBytes:2048,maxFiles:2,ttlSeconds:60,now:()=>now});
  const metadata = await store.create({format:'txt',filename:'hello.txt',content:'temporary'});
  assert.match(metadata.id,/^[A-Za-z0-9_-]{32}$/);
  assert.equal(metadata.size_bytes,9);
  const found = await store.get(metadata.id);
  assert.equal(found.buffer.toString(),'temporary');
  assert.equal(await readFile(join(directory,'files',metadata.id),'utf8'),'temporary');
  assert.equal(await store.delete(metadata.id),true);
  assert.equal(await store.get(metadata.id),null);
  const expiring = await store.create({format:'md',content:'expire'});
  now += 61_000;
  assert.equal(await store.get(expiring.id),null);
});

test('temporary storage quotas are enforced even for concurrent file creation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kirana-quota-test-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const store = new TemporaryFileStore({directory:join(directory,'files'),maxFileBytes:10,maxTotalBytes:10,maxFiles:1});
  const results = await Promise.allSettled([
    store.create({format:'txt',content:'12345678'}),
    store.create({format:'txt',content:'abcdefgh'}),
  ]);
  assert.equal(results.filter((x)=>x.status==='fulfilled').length,1);
  assert.equal(results.filter((x)=>x.status==='rejected' && x.reason.code==='temporary_storage_limit').length,1);
});

test('upload validates known MIME, filename extension, text encoding, and binary signatures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kirana-upload-test-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const store = new TemporaryFileStore({directory:join(directory,'files')});
  await assert.rejects(store.upload({filename:'x.pdf',mimeType:'application/pdf',buffer:Buffer.from('not pdf')}), {code:'file_signature_mismatch'});
  await assert.rejects(store.upload({filename:'x.png',mimeType:'image/png',buffer:Buffer.from([1,2])}), {code:'file_signature_mismatch'});
  await assert.rejects(store.upload({filename:'x.csv',mimeType:'text/csv',buffer:Buffer.from([0xff,0xfe])}), {code:'invalid_text_encoding'});
  await assert.rejects(store.upload({filename:'x.txt',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4')}), {code:'filename_extension_mismatch'});
  const metadata = await store.upload({filename:'memo.txt',mimeType:'text/plain',buffer:Buffer.from('upload')});
  assert.equal((await store.get(metadata.id)).buffer.toString(),'upload');
});

test('stores allowlisted media uploads by signature without claiming analysis capability', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kirana-media-upload-test-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const store = new TemporaryFileStore({directory:join(directory,'files')});
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]);
  const metadata = await store.upload({filename:'image.png',mimeType:'image/png',buffer:png});
  assert.equal(metadata.format,'png');
  assert.deepEqual((await store.get(metadata.id)).buffer,png);
  assert.throws(() => createFilePayload({format:'png',content:'not implemented'}), {code:'unsupported_file_format'});
});
