const base = process.env.GATEWAY_URL || 'http://127.0.0.1:1455';
const key = process.env.GATEWAY_API_KEY; const model = process.argv[2];
if (process.argv[3] !== '--confirm-plan-usage') throw new Error('This sends up to 20 real ChatGPT-plan requests. Re-run with --confirm-plan-usage only after intentionally approving the usage.');
if (!key || !model) throw new Error('Set GATEWAY_API_KEY and pass a model slug from /v1/models.');
const results=[];
for (const scenario of ['simple','context']) {
  let messages = scenario === 'simple' ? [{role:'user',content:'Responda apenas: benchmark simples OK.'}] : [{role:'user',content:'Guarde esta palavra de teste: CACTUS-731.'}];
  const n=Number(process.env.BENCHMARK_COUNT || 10);
  for(let i=0;i<n;i++) {
    if(scenario==='context' && i>0) messages=[...messages,{role:'user',content:'Qual palavra de teste eu pedi para guardar? Responda só com a palavra.'}];
    const started=performance.now(); let headersMs=null; let firstUseful=null; let success=false; let error=null; let text='';
    try {
      const r=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,stream:true,messages})});
      headersMs=performance.now()-started;
      if(!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      let buffer='';
      for await(const bytes of r.body) {
        buffer+=new TextDecoder().decode(bytes,{stream:true});
        let at; while((at=buffer.indexOf('\n\n'))>=0) {
          const block=buffer.slice(0,at); buffer=buffer.slice(at+2);
          for(const line of block.split(/\r?\n/)) if(line.startsWith('data: ')) {
            const raw=line.slice(6); if(raw==='[DONE]'){success=true;continue;}
            try { const evt=JSON.parse(raw); const delta=evt.choices?.[0]?.delta?.content; if(typeof delta==='string'&&delta){firstUseful??=performance.now()-started;text+=delta;} if(evt.error) error=evt.error.code||'stream_error'; } catch {}
          }
        }
      }
      if(!success) error ||= 'stream_without_DONE';
      if(scenario==='context' && i===0) messages=[...messages,{role:'assistant',content:text}];
      if(scenario==='context' && i>0 && !text.includes('CACTUS-731')) error ||= 'context_mismatch';
    } catch(e) { error=e.message; }
    results.push({timestamp:new Date().toISOString(),scenario,index:i+1,model,headers_ms:headersMs===null?null:+headersMs.toFixed(1),ttfu_ms:firstUseful===null?null:+firstUseful.toFixed(1),total_ms:+(performance.now()-started).toFixed(1),success:success&&!error,error,text:text.slice(0,200)});
  }
}
function stats(values){const s=[...values].sort((a,b)=>a-b);return {n:s.length,mean_ms:+(s.reduce((a,b)=>a+b,0)/s.length).toFixed(1),median_ms:+(s[Math.floor((s.length-1)/2)]).toFixed(1),p95_ms:+(s[Math.ceil(.95*s.length)-1]).toFixed(1)};}
const summary={model,firstUseful:{simple:stats(results.filter(r=>r.scenario==='simple'&&r.ttfu_ms!==null).map(r=>r.ttfu_ms)),context:stats(results.filter(r=>r.scenario==='context'&&r.ttfu_ms!==null).map(r=>r.ttfu_ms))},total:{simple:stats(results.filter(r=>r.scenario==='simple').map(r=>r.total_ms)),context:stats(results.filter(r=>r.scenario==='context').map(r=>r.total_ms))},success_rate:results.filter(r=>r.success).length/results.length,results};
console.log(JSON.stringify(summary,null,2));
