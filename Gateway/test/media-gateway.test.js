import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/gateway.js';
import { ResponsesClient } from '../src/responses.js';

const KEY=randomBytes(32).toString('base64url');
const wait=(ms=10)=>new Promise((resolve)=>setTimeout(resolve,ms));
async function start(t,{mediaProviders}={}) {
  const stateDir=await mkdtemp(join(tmpdir(),'kirana-media-api-test-'));
  const auth={status:()=>({authenticated:true}),accessToken:async()=>'mock-token',initialize:async()=>{},clear(){}};
  const responses=new ResponsesClient({auth,fetchImpl:async()=>{throw new Error('No real provider request is allowed in this test.');}});
  const providers=mediaProviders||{
    refreshCapabilities:async()=>{},comfy:{configured:async()=>false,run:async()=>{throw new Error('not configured');}},
    whisper:{configured:async()=>false},piper:{configured:async()=>false},videoAnalysis:{configured:async()=>false},
  };
  const app=createGateway({apiKey:KEY,stateDir,port:0,authClient:auth,responseClient:responses,mediaProviders:providers});
  await new Promise((resolve)=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await new Promise((resolve)=>app.server.close(resolve));await app.jobs.close();app.files.close();await rm(stateDir,{recursive:true,force:true});});
  return {base,app};
}
const authHeaders={authorization:`Bearer ${KEY}`};

test('media endpoints fail closed when local engines/workflows are not configured',async(t)=>{
  const {base}=await start(t);
  const response=await fetch(`${base}/v1/images/generate`,{method:'POST',headers:{...authHeaders,'content-type':'application/json'},body:JSON.stringify({prompt:'A quiet seaside at dawn'})});
  assert.equal(response.status,503); assert.equal((await response.json()).error.code,'provider_not_configured');
  const status=await fetch(`${base}/v1/capabilities`,{headers:authHeaders}); const catalog=await status.json();
  for(const name of ['images.analyze','images.generate','images.edit','video.analyze','video.generate','audio.transcribe','audio.synthesize']) {
    const capability=catalog.data.find((item)=>item.name===name);
    assert.equal(capability.implemented,true); assert.equal(capability.available,false);
  }
});

test('image generation job stores real output file and stays unavailable when result is mock-only',async(t)=>{
  const providers={refreshCapabilities:async()=>{},comfy:{
    configured:async()=>true,
    run:async({onProgress})=>{onProgress(40,'mock_workflow');const output=await app.files.upload({filename:'sample.png',mimeType:'image/png',buffer:Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])});return {output_files:[output],provider:'comfyui-local',live:false};},
  },whisper:{configured:async()=>false},piper:{configured:async()=>false},videoAnalysis:{configured:async()=>false}};
  let app; const started=await start(t,{mediaProviders:providers}); app=started.app;
  const accepted=await fetch(`${started.base}/v1/images/generate`,{method:'POST',headers:{...authHeaders,'content-type':'application/json'},body:JSON.stringify({prompt:'Test output'})});
  assert.equal(accepted.status,202); const initial=await accepted.json(); assert.match(initial.poll_path,/^\/v1\/images\/jobs\//);
  let job;
  for(let i=0;i<100;i++){const response=await fetch(`${started.base}${initial.poll_path}`,{headers:authHeaders});job=await response.json();if(['succeeded','failed'].includes(job.status))break;await wait();}
  assert.equal(job.status,'succeeded'); assert.equal(job.live_verified,false); assert.equal(job.error_code,null);
  const download=await fetch(`${started.base}${job.output_files[0].download_path}`,{headers:authHeaders});
  assert.equal(download.status,200); assert.equal(download.headers.get('content-type'),'image/png');
  const catalog=await (await fetch(`${started.base}/v1/capabilities`,{headers:authHeaders})).json();
  assert.equal(catalog.data.find((item)=>item.name==='images.generate').available,false);
});

test('binary upload stores video bytes exactly and authenticates download',async(t)=>{
  const {base}=await start(t);
  const bytes=Buffer.from([0,1,2,3,4,255]);
  const upload=await fetch(`${base}/v1/files/upload?filename=clip.mp4`,{method:'POST',headers:{...authHeaders,'content-type':'video/mp4'},body:bytes});
  assert.equal(upload.status,400); // Invalid MP4 signature is rejected before storage.
  const valid=Buffer.alloc(16); valid.write('ftyp',4,'ascii'); valid.write('isom',8,'ascii');
  const accepted=await fetch(`${base}/v1/files/upload?filename=clip.mp4`,{method:'POST',headers:{...authHeaders,'content-type':'video/mp4'},body:valid});
  assert.equal(accepted.status,201); const metadata=await accepted.json();
  assert.equal((await fetch(`${base}${metadata.download_path}`,{headers:authHeaders})).status,200);
  assert.equal((await fetch(`${base}${metadata.download_path}`)).status,401);
});
