import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesClient } from '../src/responses.js';

const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
function stream(events){return new Response(events.map((event)=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{status:200,headers:{'content-type':'text/event-stream'}});}
function clientFor(received){
  const auth={accessToken:async()=>'fabricated-test-token'};
  return new ResponsesClient({auth,fetchImpl:async(url,init={})=>{
    received.push({url:String(url),body:init.body?JSON.parse(init.body):null});
    if(String(url).endsWith('/v1/models'))return Response.json({models:[{slug:'vision-test',display_name:'Vision test',visibility:'list'}]});
    if(String(url).endsWith('/v1/responses'))return stream([{type:'response.output_text.delta',delta:'A small red boat.'},{type:'response.completed',response:{usage:{input_tokens:7,output_tokens:5}}}]);
    throw new Error('Unexpected URL');
  }});
}

test('image analysis maps validated PNG bytes to the public Responses multimodal input contract',async()=>{
  const seen=[]; const client=clientFor(seen);
  const result=await client.analyzeImages({model:'vision-test',prompt:'Describe the image.',images:[{mimeType:'image/png',buffer:png}]});
  assert.equal(result.text,'A small red boat.'); assert.equal(result.live,true);
  const request=seen.find((item)=>item.url.endsWith('/v1/responses'));
  assert.equal(request.body.store,false); assert.equal(request.body.stream,true); assert.equal(request.body.model,'vision-test');
  assert.deepEqual(request.body.input[0].content[0],{type:'input_text',text:'Describe the image.'});
  assert.deepEqual(request.body.input[0].content[1],{type:'input_image',image_url:`data:image/png;base64,${png.toString('base64')}`,detail:'auto'});
});

test('rejects wrong MIME/signature before sending any upstream inference request',async()=>{
  const seen=[]; const client=clientFor(seen);
  await assert.rejects(()=>client.analyzeImages({model:'vision-test',prompt:'Describe.',images:[{mimeType:'image/png',buffer:Buffer.from('not png')}]}),{code:'invalid_image_request'});
  assert.equal(seen.length,0);
});
