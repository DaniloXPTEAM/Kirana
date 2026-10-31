import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createVoiceClientServer } from '../examples/voice-client/server.mjs';
import { createBrowserAudioAdapters } from '../examples/voice-client/providers.js';
import { sanitizeTextForSpeech, THALITA_VOICE } from '../examples/voice-client/edge-tts-adapter.js';
import { playWithTtsFallback } from '../examples/voice-client/tts-routing.js';

const gatewayApiKey='test-gateway-key-that-is-not-a-real-secret';
async function withServer(t,options={}) {
  const client=createVoiceClientServer({gatewayApiKey,port:0,...options});
  const address=await client.listen();
  const base=`http://127.0.0.1:${address.port}`;
  t.after(()=>client.close());
  return {base,address};
}

test('voice client serves CSP-compatible external code and keeps Gateway key out of the browser',async(t)=>{
  const {base}=await withServer(t,{fetchImpl:async()=>{throw new Error('Unexpected upstream request');}});
  const response=await fetch(`${base}/`);
  const html=await response.text();
  assert.equal(response.status,200);
  const csp=response.headers.get('content-security-policy');
  assert.match(csp,/script-src 'self'/);
  assert.doesNotMatch(csp,/script-src[^;]*unsafe-inline/);
  assert.match(csp,/frame-ancestors 'none'/);
  assert.match(csp,/media-src 'self' blob:/);
  assert.match(html,/<script\s+type="module"\s+src="\.\/app\.js"><\/script>/);
  const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  assert.equal(scripts.length,1);
  for(const [,attributes,body] of scripts){assert.match(attributes,/\bsrc=/i);assert.equal(body.trim(),'');}
  const app=await fetch(`${base}/app.js`);
  assert.equal(app.status,200);
  assert.match(app.headers.get('content-type'),/javascript/);
  const appSource=await app.text();
  assert.match(appSource,/SpeechRecognition/);
  assert.match(appSource,/createEdgeTtsAdapter/);
  assert.match(appSource,/reportBtn/);
  assert.match(appSource,/kirana-voice-e2e-report\/v2/);
  assert.match(appSource,/requestMicrophonePermission/);
  for(const id of ['listenBtn','interruptBtn','reconnectBtn','reportBtn','clearBtn'])assert.match(appSource,new RegExp(`\\$\\('${id}'\\)\\.addEventListener`));
  assert.match(appSource,/fetch\('\/api\/health'/);
  assert.match(appSource,/fetch\('\/api\/session'/);
  assert.match(appSource,/fetch\('\/api\/models'/);
  assert.match(appSource,/fillVoices\(\);\s*loadModels\(\);\s*loadTtsCatalog\(\);/);
  assert.doesNotMatch(html,new RegExp(gatewayApiKey));
  assert.doesNotMatch(appSource,new RegExp(gatewayApiKey));
  const edgeAdapter=await fetch(`${base}/edge-tts-adapter.js`);
  assert.equal(edgeAdapter.status,200);
  assert.match(edgeAdapter.headers.get('content-type'),/javascript/);
  assert.match(await edgeAdapter.text(),/sanitizeTextForSpeech/);
  const routing=await fetch(`${base}/tts-routing.js`);
  assert.equal(routing.status,200);
  assert.match(routing.headers.get('content-type'),/javascript/);
  assert.match(await routing.text(),/playWithTtsFallback/);
  assert.equal((await fetch(`${base}/not-found`)).status,404);
});

test('voice client proxies only model catalog and streaming text requests with server-side Gateway authorization',async(t)=>{
  const seen=[];
  const fetchImpl=async(url,init={})=>{
    seen.push({url:String(url),headers:init.headers,body:init.body});
    if(String(url).endsWith('/v1/models'))return Response.json({object:'list',data:[{id:'text-model'}]});
    if(String(url).endsWith('/v1/chat/completions'))return new Response('data: {"choices":[{"delta":{"content":"Olá."}}]}\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
    throw new Error('Unexpected upstream route');
  };
  const {base,address}=await withServer(t,{fetchImpl});
  const origin=`http://127.0.0.1:${address.port}`;
  const models=await fetch(`${base}/api/models`,{headers:{origin}});
  assert.deepEqual((await models.json()).data,[{id:'text-model'}]);
  const body={model:'text-model',messages:[{role:'user',content:'Olá'}],stream:true};
  const chat=await fetch(`${base}/api/chat/completions`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(chat.headers.get('content-type'),'text/event-stream');
  assert.match(await chat.text(),/Olá/);
  assert.equal(seen.length,2);
  for(const row of seen){assert.equal(row.headers.authorization,`Bearer ${gatewayApiKey}`);assert.equal(new URL(row.url).hostname,'127.0.0.1');}
  assert.equal(seen[1].body,JSON.stringify(body));
});

test('voice client rejects foreign origins, unexpected body fields, and direct cross-host upstreams',async(t)=>{
  const {base,address}=await withServer(t);
  const blocked=await fetch(`${base}/api/models`,{headers:{origin:'https://evil.example'}});
  assert.equal(blocked.status,403);
  const bad=await fetch(`${base}/api/chat/completions`,{method:'POST',headers:{origin:`http://127.0.0.1:${address.port}`,'content-type':'application/json'},body:JSON.stringify({model:'m',messages:[],stream:true,tools:[]})});
  assert.equal(bad.status,400);
  assert.throws(()=>createVoiceClientServer({gatewayApiKey,gatewayUrl:'https://api.openai.com'}),/loopback/);
});

test('voice client exposes health and authenticated SIWC metadata only through local proxy',async(t)=>{
  const seen=[];
  const fetchImpl=async(url,init={})=>{
    seen.push({url:String(url),headers:init.headers});
    if(String(url).endsWith('/health'))return Response.json({status:'ok',authenticated:true});
    if(String(url).endsWith('/auth/status'))return Response.json({authenticated:true,sharing:true,grantedScopes:['chatgpt.tokens.use.direct'],tokenStorage:'memory-only'});
    throw new Error('Unexpected upstream route');
  };
  const {base,address}=await withServer(t,{fetchImpl});
  const origin=`http://127.0.0.1:${address.port}`;
  const health=await fetch(`${base}/api/health`,{headers:{origin}});
  const session=await fetch(`${base}/api/session`,{headers:{origin}});
  assert.equal((await health.json()).status,'ok');
  const sessionBody=await session.json();
  assert.equal(sessionBody.authenticated,true);
  assert.deepEqual(sessionBody.grantedScopes,['chatgpt.tokens.use.direct']);
  assert.equal(JSON.stringify(sessionBody).includes(gatewayApiKey),false);
  assert.equal(seen[0].headers.authorization,undefined);
  assert.equal(seen[1].headers.authorization,`Bearer ${gatewayApiKey}`);
  const providers=await fetch(`${base}/providers.js`,{headers:{origin}});
  assert.match(await providers.text(),/createBrowserAudioAdapters/);
});

test('voice client rejects cross-origin access to health and session proxies',async(t)=>{
  const {base}=await withServer(t);
  for(const route of ['/api/health','/api/session']){
    const response=await fetch(`${base}${route}`,{headers:{origin:'https://evil.example'}});
    assert.equal(response.status,403);
  }
});

test('browser audio adapters request and stop a microphone probe and configure pt-BR recognition',async()=>{
  const tracks=[{readyState:'live',stopped:false,stop(){this.stopped=true;}}];
  class Recognition { }
  const fakeWindow={SpeechRecognition:Recognition,navigator:{mediaDevices:{async getUserMedia(options){assert.deepEqual(options,{audio:true});return {getAudioTracks:()=>tracks,getTracks:()=>tracks};}}}};
  const adapters=createBrowserAudioAdapters(fakeWindow);
  assert.equal(adapters.stt.supported(),true);
  assert.deepEqual(await adapters.stt.requestMicrophonePermission(),{captured:true});
  assert.equal(tracks[0].stopped,true);
  const recognition=adapters.stt.createRecognition('pt-BR');
  assert.equal(recognition.lang,'pt-BR');
  assert.equal(recognition.continuous,false);
  assert.equal(recognition.interimResults,true);
  assert.equal(recognition.maxAlternatives,1);
});

test('speech sanitizer removes emoji/Markdown noise but preserves Portuguese accents and punctuation',()=>{
  const input='## Olá, *Kirana*! 😀\nVeja [este link](https://example.test) — ação, coração!';
  const result=sanitizeTextForSpeech(input);
  assert.equal(result,'Olá, Kirana! Veja este link — ação, coração!');
  assert.equal(sanitizeTextForSpeech('🎙️✨'), '');
});

test('Edge TTS voice catalog and MP3 stream remain same-origin, validated, and do not alter the SIWC route',async(t)=>{
  const voices=[
    {shortName:THALITA_VOICE,locale:'pt-BR',gender:'Female',friendlyName:'Microsoft ThalitaMultilingual Online (Natural)'},
    {shortName:'pt-BR-FranciscaNeural',locale:'pt-BR',gender:'Female',friendlyName:'Microsoft Francisca Online (Natural)'},
  ];
  let received=null;
  const edgeTtsRunner={
    async listVoices(){return voices;},
    startStream(text,voice){
      received={text,voice};
      const child=new EventEmitter();
      child.stdout=new PassThrough(); child.stderr=new PassThrough();
      child.kill=()=>{};
      setImmediate(()=>{child.stdout.write(Buffer.from([0x49,0x44,0x33,1]));child.stdout.end();child.emit('close',0);});
      return child;
    },
  };
  const {base,address}=await withServer(t,{edgeTtsRunner,fetchImpl:async(url)=>{
    if(String(url).endsWith('/v1/models'))return Response.json({data:[{id:'text-model'}]});
    if(String(url).endsWith('/v1/chat/completions'))return new Response('data: {"choices":[{"delta":{"content":"Resposta intacta."}}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    throw new Error('Unexpected Gateway route');
  }});
  const origin=`http://127.0.0.1:${address.port}`;
  const catalogueResponse=await fetch(`${base}/api/tts/voices`,{headers:{origin}});
  const catalogue=await catalogueResponse.json();
  assert.equal(catalogue.available,true);
  assert.equal(catalogue.requiredVoice,THALITA_VOICE);
  const tts=await fetch(`${base}/api/tts/stream`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({voice:THALITA_VOICE,text:'Olá 😀, **mundo**!'})});
  assert.equal(tts.status,200);
  assert.match(tts.headers.get('content-type'),/audio\/mpeg/);
  assert.equal(tts.headers.get('x-tts-voice'),THALITA_VOICE);
  assert.deepEqual([...new Uint8Array(await tts.arrayBuffer())],[0x49,0x44,0x33,1]);
  assert.deepEqual(received,{text:'Olá, mundo!',voice:THALITA_VOICE});
  const modelResponse=await fetch(`${base}/api/models`,{headers:{origin}});
  assert.equal((await modelResponse.json()).data[0].id,'text-model');
  const invalid=await fetch(`${base}/api/tts/stream`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({voice:'pt-BR-FranciscaNeural',text:'x'})});
  assert.equal(invalid.status,400);
});

test('aborting the browser TTS stream kills its local Python worker',async(t)=>{
  let killCount=0;
  let killedResolve;
  const killed=new Promise(resolve=>{killedResolve=resolve;});
  let startedResolve;
  const started=new Promise(resolve=>{startedResolve=resolve;});
  const edgeTtsRunner={
    async listVoices(){return [{shortName:THALITA_VOICE}];},
    startStream(){
      const child=new EventEmitter();
      child.stdout=new PassThrough(); child.stderr=new PassThrough();
      child.kill=()=>{killCount++;killedResolve();setImmediate(()=>child.emit('close',null));};
      startedResolve();
      return child;
    },
  };
  const {base,address}=await withServer(t,{edgeTtsRunner});
  const controller=new AbortController();
  const request=fetch(`${base}/api/tts/stream`,{method:'POST',headers:{origin:`http://127.0.0.1:${address.port}`,'content-type':'application/json'},body:JSON.stringify({voice:THALITA_VOICE,text:'Interromper geração de voz.'}),signal:controller.signal});
  await started;
  controller.abort();
  await assert.rejects(request,{name:'AbortError'});
  await Promise.race([killed,new Promise(resolve=>setTimeout(resolve,500))]);
  assert.ok(killCount>=1);
});

test('Thalita failure selects Francisca fallback; interruption never starts late fallback audio',async()=>{
  let failed=null;
  let fallbackCalls=0;
  const output=await playWithTtsFallback({
    usePrimary:true,
    primary:async()=>{throw new Error('Edge service unavailable');},
    fallback:async()=>{fallbackCalls++;return 'Francisca';},
    onPrimaryFailure:error=>{failed=error.message;},
  });
  assert.equal(output,'Francisca');
  assert.equal(failed,'Edge service unavailable');
  assert.equal(fallbackCalls,1);
  fallbackCalls=0;
  await assert.rejects(playWithTtsFallback({
    usePrimary:true,
    primary:async()=>{throw Object.assign(new Error('cancel'),{name:'AbortError'});},
    fallback:async()=>{fallbackCalls++;},
  }),{name:'AbortError'});
  assert.equal(fallbackCalls,0);
});
