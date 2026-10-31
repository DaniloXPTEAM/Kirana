import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/gateway.js';
import { ResponsesClient } from '../src/responses.js';

const KEY = randomBytes(32).toString('base64url');
const headers = { authorization:`Bearer ${KEY}`, 'content-type':'application/json' };
async function start(t) {
  const stateDir = await mkdtemp(join(tmpdir(),'kirana-file-api-test-'));
  const auth = { status:()=>({authenticated:true}), accessToken:async()=>'mock-token', initialize:async()=>{}, clear(){} };
  const responseClient = new ResponsesClient({auth,fetchImpl:async()=>{throw new Error('Unexpected upstream request in file tests');}});
  const app = createGateway({apiKey:KEY,stateDir,port:0,authClient:auth,responseClient});
  await new Promise((resolve)=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await new Promise((resolve)=>app.server.close(resolve));await rm(stateDir,{recursive:true,force:true});});
  return base;
}

test('capabilities are authenticated and mark unconfigured modalities unavailable', async(t)=>{
  const base=await start(t);
  assert.equal((await fetch(`${base}/v1/capabilities`)).status,401);
  const response=await fetch(`${base}/v1/capabilities`,{headers:{authorization:`Bearer ${KEY}`}});
  const result=await response.json();
  assert.equal(response.status,200);
  assert.equal(result.data.find((x)=>x.name==='text.chat').ready,true);
  assert.equal(result.data.find((x)=>x.name==='files.create').available,true);
  assert.equal(result.data.find((x)=>x.name==='images.generate').available,false);
  assert.equal(result.data.find((x)=>x.name==='images.generate').ready,false);
  assert.deepEqual(result.files.formats.map((x)=>x.format),['txt','md','json','csv','pdf','docx','xlsx']);
  assert.ok(result.files.upload_mime_types.includes('image/png'));
  assert.ok(result.files.upload_mime_types.includes('video/mp4'));
});

test('creates a file, downloads exact bytes with safe headers, and allows deletion', async(t)=>{
  const base=await start(t);
  const created=await fetch(`${base}/v1/files`,{method:'POST',headers,body:JSON.stringify({format:'txt',filename:'nota.txt',content:'Olá Kirana'})});
  const metadata=await created.json();
  assert.equal(created.status,201);
  assert.equal(metadata.filename,'nota.txt');
  assert.equal(metadata.mime_type,'text/plain; charset=utf-8');
  assert.match(metadata.download_path,/^\/v1\/files\/[A-Za-z0-9_-]{32}$/);
  const download=await fetch(`${base}${metadata.download_path}`,{headers:{authorization:`Bearer ${KEY}`}});
  assert.equal(download.status,200);
  assert.equal(await download.text(),'Olá Kirana');
  assert.match(download.headers.get('content-disposition'),/attachment/);
  assert.equal(download.headers.get('x-content-type-options'),'nosniff');
  const deleted=await fetch(`${base}${metadata.download_path}`,{method:'DELETE',headers:{authorization:`Bearer ${KEY}`}});
  assert.equal(deleted.status,200);
  assert.equal((await fetch(`${base}${metadata.download_path}`,{headers:{authorization:`Bearer ${KEY}`}})).status,404);
});

test('uploads only validated, allowlisted files and rejects traversal or MIME spoofing', async(t)=>{
  const base=await start(t);
  const uploaded=await fetch(`${base}/v1/files/upload`,{method:'POST',headers,body:JSON.stringify({filename:'upload.txt',mime_type:'text/plain',content_base64:Buffer.from('from client').toString('base64')})});
  assert.equal(uploaded.status,201);
  const result=await uploaded.json();
  const download=await fetch(`${base}${result.download_path}`,{headers:{authorization:`Bearer ${KEY}`}});
  assert.equal(await download.text(),'from client');
  const invalid=await fetch(`${base}/v1/files/upload`,{method:'POST',headers,body:JSON.stringify({filename:'../bad.txt',mime_type:'text/plain',content_base64:Buffer.from('no').toString('base64')})});
  assert.equal(invalid.status,400);
  const spoofed=await fetch(`${base}/v1/files/upload`,{method:'POST',headers,body:JSON.stringify({filename:'no.pdf',mime_type:'application/pdf',content_base64:Buffer.from('not a pdf').toString('base64')})});
  assert.equal(spoofed.status,400);
});
