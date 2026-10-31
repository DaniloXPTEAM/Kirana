import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway.js';
import { ResponsesClient } from '../src/responses.js';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = randomBytes(32).toString('base64url');
function sse(events) { const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''); return new Response(text, { status: 200, headers: { 'content-type':'text/event-stream' } }); }
function fakeFetch(events, received = []) {
  return async (url, init = {}) => {
    received.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (String(url) === 'https://api.openai.com/v1/models') return Response.json({ models:[{ slug:'gpt-test', display_name:'Test Model', visibility:'list' }, { slug:'hidden-model', display_name:'Hidden', visibility:'hidden' }] });
    if (String(url) === 'https://api.openai.com/v1/responses') return sse(events);
    throw new Error(`Unexpected URL: ${url}`);
  };
}
async function start(t, options = {}) {
  const auth = options.auth || { status: () => ({ authenticated:true, sharing:true, tokenStorage:'memory-only' }), accessToken: async () => 'mock-oauth-token', initialize: async () => {}, clear() {} };
  const responseClient = options.responseClient || new ResponsesClient({ auth, fetchImpl: options.fetchImpl || fakeFetch([{ type:'response.output_text.delta', delta:'hi' },{ type:'response.completed', response:{ usage:{input_tokens:3,output_tokens:1} } }]) });
  const stateDir = options.stateDir || await mkdtemp(join(tmpdir(), 'kirana-gateway-test-'));
  const app = createGateway({ apiKey:KEY, stateDir, port:0, authClient:auth, responseClient });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port; t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); if (!options.stateDir) await rm(stateDir, { recursive:true, force:true }); });
  return { base:`http://127.0.0.1:${port}`, app, auth };
}
const headers = { authorization:`Bearer ${KEY}` };

test('health is public and reports state without credentials', async (t) => {
  const { base } = await start(t); const r = await fetch(`${base}/health`); const data = await r.json();
  assert.equal(r.status,200); assert.equal(data.status,'ok'); assert.equal(data.authenticated,true); assert.equal(JSON.stringify(data).includes('mock-oauth-token'),false);
});

test('models and chat endpoints require gateway key, and model list uses only visible account models', async (t) => {
  const seen=[]; const { base } = await start(t,{ fetchImpl:fakeFetch([],seen) });
  assert.equal((await fetch(`${base}/v1/models`)).status,401);
  const r=await fetch(`${base}/v1/models`,{headers}); const body=await r.json();
  assert.deepEqual(body.data.map(x=>x.id),['gpt-test']); assert.equal(seen[0].init.headers.authorization,'Bearer mock-oauth-token');
});

test('chat completion streams compatible text chunks and enforces Responses flags/context mapping', async (t) => {
  const seen=[]; const upstream=fakeFetch([{type:'response.output_text.delta',delta:'Olá '},{type:'response.output_text.delta',delta:'mundo!'},{type:'response.completed',response:{usage:{input_tokens:8,output_tokens:3}}}],seen);
  const { base }=await start(t,{fetchImpl:upstream});
  const response=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({model:'gpt-test',stream:true,messages:[{role:'system',content:'Responda em pt-BR.'},{role:'user',content:'Oi'}]})});
  const text=await response.text(); assert.equal(response.status,200); assert.match(text,/Olá /); assert.match(text,/mundo!/); assert.match(text,/data: \[DONE\]/);
  const payload=seen.find(x=>x.url.endsWith('/responses')).body;
  assert.equal(payload.store,false); assert.equal(payload.stream,true); assert.equal(payload.instructions,'Responda em pt-BR.'); assert.deepEqual(payload.input,[{role:'user',content:'Oi'}]);
});

test('maps function tools into documented namespace and returns function call deltas', async (t) => {
  const seen=[]; const upstream=fakeFetch([
    {type:'response.output_item.added',output_index:0,item:{type:'function_call',id:'fc1',call_id:'call_1',name:'consultar_status_projeto',namespace:'gateway',arguments:''}},
    {type:'response.function_call_arguments.delta',output_index:0,delta:'{"status":"ok"}'},
    {type:'response.output_item.done',output_index:0,item:{type:'function_call',id:'fc1',call_id:'call_1',name:'consultar_status_projeto',namespace:'gateway',arguments:'{"status":"ok"}'}},
    {type:'response.completed',response:{usage:{input_tokens:10,output_tokens:2}}}
  ],seen);
  const {base}=await start(t,{fetchImpl:upstream});
  const body={model:'gpt-test',stream:true,messages:[{role:'user',content:'Consulte o status'}],tools:[{type:'function',function:{name:'consultar_status_projeto',description:'Retorna status simulado.',parameters:{type:'object',properties:{},required:[],additionalProperties:false}}}]};
  const response=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)}); const text=await response.text();
  const payload=seen.find(x=>x.url.endsWith('/responses')).body;
  assert.equal(payload.tools[0].type,'namespace'); assert.equal(payload.tools[0].name,'gateway'); assert.equal(payload.tools[0].tools[0].name,'consultar_status_projeto');
  assert.match(text,/"tool_calls"/); assert.match(text,/gateway.consultar_status_projeto/); assert.match(text,/\[DONE\]/);
});

test('round-trips caller-executed function call and tool output into Responses history', async (t) => {
  const seen=[]; let responseCount=0;
  const upstream=async (url,init={})=>{
    seen.push({url:String(url),body:init.body?JSON.parse(init.body):null});
    if(String(url).endsWith('/models')) return Response.json({models:[{slug:'gpt-test',visibility:'list'}]});
    responseCount++;
    if(responseCount===1) return sse([{type:'response.output_item.added',output_index:0,item:{type:'function_call',call_id:'call_7',name:'consultar_status_projeto',namespace:'gateway',arguments:'{}'}},{type:'response.output_item.done',output_index:0,item:{type:'function_call',call_id:'call_7',name:'consultar_status_projeto',namespace:'gateway',arguments:'{}'}},{type:'response.completed',response:{}}]);
    return sse([{type:'response.output_text.delta',delta:'Projeto OK.'},{type:'response.completed',response:{}}]);
  };
  const {base}=await start(t,{fetchImpl:upstream});
  const original=[{role:'user',content:'Consulte projeto.'}];
  const first=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({model:'gpt-test',stream:false,messages:original,tools:[{type:'function',function:{name:'consultar_status_projeto',parameters:{type:'object',properties:{}}}}]})});
  const firstJson=await first.json(); const call=firstJson.choices[0].message.tool_calls[0];
  const second=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({model:'gpt-test',stream:false,messages:[...original,{role:'assistant',content:null,tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:'status simulado: OK'}]})});
  const secondJson=await second.json(); assert.equal(secondJson.choices[0].message.content,'Projeto OK.');
  const payload=seen.filter(x=>x.url.endsWith('/responses'))[1].body;
  assert.deepEqual(payload.input.slice(-2),[{type:'function_call',call_id:'call_7',name:'consultar_status_projeto',arguments:'{}',namespace:'gateway'},{type:'function_call_output',call_id:'call_7',output:'status simulado: OK'}]);
});

test('non-streaming Chat Completions response is assembled while upstream still streams', async (t) => {
  const seen=[]; const upstream=fakeFetch([{type:'response.output_text.delta',delta:'done'},{type:'response.completed',response:{usage:{input_tokens:2,output_tokens:1}}}],seen);
  const {base}=await start(t,{fetchImpl:upstream});
  const response=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({model:'gpt-test',stream:false,messages:[{role:'user',content:'Hi'}]})});
  const body=await response.json(); assert.equal(body.choices[0].message.content,'done'); assert.equal(body.choices[0].finish_reason,'stop'); assert.equal(seen.find(x=>x.url.endsWith('/responses')).body.stream,true);
});

test('rejects unknown models, unsupported params and malformed JSON without upstream inference', async (t) => {
  const seen=[]; const {base}=await start(t,{fetchImpl:fakeFetch([],seen)});
  let r=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({model:'unavailable',messages:[{role:'user',content:'x'}]})}); assert.equal(r.status,400);
  r=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({model:'gpt-test',messages:[{role:'user',content:'x'}],temperature:0})}); assert.equal(r.status,400);
  r=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{bad'}); assert.equal(r.status,400);
  assert.equal(seen.filter(x=>x.url.endsWith('/responses')).length,0);
});

test('rejects non-loopback bind and weak gateway key', () => {
  assert.throws(()=>createGateway({apiKey:'short'}),/at least 32/);
  assert.throws(()=>createGateway({apiKey:KEY,host:'0.0.0.0'}),/non-loopback/);
});
