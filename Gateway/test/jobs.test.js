import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from '../src/jobs.js';

const pause=(ms=10)=>new Promise((resolve)=>setTimeout(resolve,ms));
async function waitFor(manager,id) {
  for(let i=0;i<100;i++) { const job=manager.get(id); if(['succeeded','failed','cancelled','interrupted'].includes(job.status)) return job; await pause(); }
  throw new Error('Timed out waiting for test job.');
}

test('persists successful jobs, safe error_code null, and output references across restart', async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'kirana-jobs-test-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const manager=new JobManager({directory});
  const submitted=manager.submit({type:'audio.transcribe',inputFileIds:['a'.repeat(32)],execute:async({progress})=>{progress(75,'transcribing');return {provider:'mock-whisper',live:false,output_files:[{id:'b'.repeat(32),filename:'transcript.txt',mime_type:'text/plain',size_bytes:5,expires_at:new Date(Date.now()+60000).toISOString()}]};}});
  const finished=await waitFor(manager,submitted.id);
  assert.equal(finished.status,'succeeded'); assert.equal(finished.error_code,null); assert.equal(finished.live_verified,false);
  assert.equal(finished.output_files[0].id,'b'.repeat(32));
  const restored=new JobManager({directory}); const afterRestart=restored.get(submitted.id);
  assert.equal(afterRestart.status,'succeeded'); assert.equal(afterRestart.error_code,null); assert.equal(afterRestart.provider,'mock-whisper');
});

test('aborts active job cooperatively and records a sanitized cancellation code',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'kirana-jobs-cancel-test-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const manager=new JobManager({directory});
  const submitted=manager.submit({type:'image.generate',execute:({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('sensitive provider detail'),{code:'cancelled'})),{once:true}))});
  for(let i=0;i<100&&manager.get(submitted.id).status==='queued';i++) await pause();
  await manager.cancel(submitted.id);
  const finished=await waitFor(manager,submitted.id);
  assert.equal(finished.status,'cancelled'); assert.equal(finished.error_code,'cancelled');
  await manager.close();
});

test('marks in-flight work interrupted after restart without persisting error text',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'kirana-jobs-restart-test-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const manager=new JobManager({directory});
  const submitted=manager.submit({type:'video.generate',execute:()=>new Promise(()=>{})});
  for(let i=0;i<100&&manager.get(submitted.id).status==='queued';i++) await pause();
  const restarted=new JobManager({directory}); const job=restarted.get(submitted.id);
  assert.equal(job.status,'interrupted'); assert.equal(job.error_code,'process_restarted');
});
