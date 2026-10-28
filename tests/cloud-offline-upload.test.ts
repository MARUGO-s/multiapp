import assert from 'node:assert/strict';
import { encryptApiKey } from '../supabase/functions/_shared/key-crypto.mjs';
import { uploadDigest } from '../supabase/functions/_shared/upload.mjs';
import { createDemo } from '../supabase/functions/_shared/demo.mjs';
import { minutesBundle } from './fixtures/minutes-bundle.mjs';
Deno.env.set('SUPABASE_URL','https://offline-fixture.invalid');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','fixture');
const secret=btoa('a'.repeat(32)); Deno.env.set('KOTONOHA_KEY_ENCRYPTION_SECRET',secret);
const owner='00000000-0000-4000-8000-000000000001';
const id='00000000-0000-4000-8000-000000000002';
const fid='00000000-0000-4000-8000-000000000003';
const encryptedKey=await encryptApiKey('fixture-no-provider-key',owner,secret);
const calls:any[]=[];
let record:any, mode='', auth=true, keys=true;
const row=()=>({document:structuredClone(record),audioPath:null,responseId:null,leaseUntil:null});
const error=(message:string)=>Response.json({message,code:'P0001'},{status:400});
globalThis.fetch=async (input,init:any)=>{
 const url=String(input); let b:any={}; if(typeof init?.body==='string') b=JSON.parse(init.body);
 calls.push({url,b,method:init?.method});
 if(url.endsWith('/kotonoha_auth'))return Response.json(auth?{workspaceId:owner,expiresAt:'2099-01-01'}:{error:'INVALID_TOKEN'});
 if(url.endsWith('/kotonoha_settings'))return Response.json({model:'gpt-6-luna',encryptedKey:keys?encryptedKey:null,transcriptionModel:'gpt-transcribe'});
 if(url.endsWith('/kotonoha_store')&&b.p_operation==='get')return Response.json(row());
 if(url.endsWith('/kotonoha_resumable_upload')){
  if(b.p_operation==='context')return Response.json({ownerId:owner,actorId:'shared'});
  if(b.p_operation==='lookup')return Response.json(mode==='exists'?row():null);
  if(b.p_operation==='create'){record=b.p_payload.document; return Response.json(row());}
  if(['append','attachment'].includes(b.p_operation)){
   if(mode==='reject')return error('UPLOAD_CONFLICT');
   const part=b.p_payload.part || b.p_payload.attachment;
   if(mode!=='race'){
    if(b.p_operation==='append')record.audioParts.push(part);
    else record.attachments.push(part);
   }
   if(mode==='lost')return error('connection failed');
   return Response.json(row());
  }
  if(b.p_operation==='complete'){
   record.status='error'; record.uploadReceipt={...record.uploadIdentity,meetingId:id,status:'accepted'};
   return Response.json(row());
  }
 }
 if(url.endsWith('/kotonoha_attachments')&&b.p_operation==='add'){record.attachments.push(b.p_payload.attachment);return Response.json(row());}
 if(url.includes('/storage/v1/object/'))return Response.json({Key:'fixture'});
 throw new Error('forbidden external call '+url);
};
const {handler}=await import('../supabase/functions/kotonoha-api/handler.ts');
const req=(route:string,body?:any,method=body?'POST':'GET')=>new Request('https://fixture.invalid/functions/v1/kotonoha-api'+route,{method,headers:{Origin:'http://127.0.0.1:5188',Authorization:'Bearer ktn_'+'a'.repeat(64),...(!(body instanceof FormData)?{'content-type':body instanceof Uint8Array?'application/octet-stream':'application/json'}:{})},body:body===undefined?undefined:body instanceof Uint8Array?new Uint8Array(body).buffer:body instanceof FormData?body:JSON.stringify(body)});
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),b=>b.toString(16).padStart(2,'0')).join('');
const audio=new Uint8Array([1,2,3]);
const plan={name:'recording-1-1.wav',size:3,sourceIndex:0,partNumber:1,duration:1,sha256:await digest(audio)};
const ap={id:fid,name:'a.txt',size:3,sha256:await digest(new TextEncoder().encode('abc'))};
function setup(){
 calls.length=0;mode='';auth=true;keys=true;
 record={id,status:'uploading',isDemo:false,sources:[{name:'test.wav',size:3}],audioParts:[],uploadPlan:[plan],attachmentPlan:[ap],attachments:[],uploadInput:{private:'frozen'},uploadIdentity:{uploadId:id,ownerId:owner,planDigest:'a'.repeat(64)}};
}
const form=(text='abc')=>{const f=new FormData();f.set('id',fid);f.set('attachment',new File([text],'a.txt'));return f;};
const removals=()=>calls.filter(c=>c.url.includes('/storage/v1/object/')&&c.method==='DELETE');
Deno.test('context is authenticated read-only capability discovery; fixed init identity/input hidden',async()=>{
 setup();
 const context=await handler(req('/uploads/context')); assert.equal(context.status,200,await context.clone().text()); const ctx=await context.json(); assert.equal(ctx.ownerId,owner); assert.equal(ctx.capabilities.resumableUpload,1);
 assert.deepEqual(calls.map(c=>c.url.split('/').pop()),['kotonoha_auth','kotonoha_resumable_upload']);
 calls.length=0;const wrongMethod=await handler(req('/uploads/context',{})); assert.equal(wrongMethod.status,405); assert.equal(calls.length,1);
 calls.length=0;auth=false;assert.equal((await handler(req('/uploads/context'))).status,401);assert.equal(calls.length,1);auth=true;
 const input={uploadId:id,metadata:{title:'fixture',date:'2026-10-28',participants:'',template:'standard'},sources:[],parts:[],transcript:'fixture',attachments:[]};
 const r=await handler(req('/uploads',input)); assert.equal(r.status,201,await r.clone().text()); const doc=await r.json(); assert.equal(doc.id,id); assert.equal(doc.uploadIdentity.ownerId,owner); assert.equal(doc.uploadInput,undefined);
 const forwarded=calls.find(c=>c.b.p_operation==='create'); assert.equal(forwarded.b.p_id,id); assert.equal(forwarded.b.p_payload.document.uploadInput.uploadId,id);
 assert.equal(doc.uploadIdentity.planDigest,await uploadDigest(input));
 calls.length=0;mode='exists';keys=false;
 const replay=await handler(req('/uploads',input));assert.equal(replay.status,201,await replay.clone().text());assert.equal(calls.filter(c=>c.b.p_operation==='create').length,0);
});
Deno.test('cloud parts hash-check, replay without storage, retain fileName, clean known rollback/race loser only',async()=>{
 setup();let r=await handler(req(`/meetings/${id}/parts?index=0`,audio));assert.equal(r.status,200,await r.clone().text());assert.equal(record.audioParts[0].fileName,'test.wav（1）');
 calls.length=0;r=await handler(req(`/meetings/${id}/parts?index=0`,audio));assert.equal(r.status,200);assert.equal(calls.filter(c=>c.url.includes('/storage/')).length,0);
 assert.equal((await handler(req(`/meetings/${id}/parts?index=0`,new Uint8Array([3,2,1])))).status,409);
 setup();mode='reject';r=await handler(req(`/meetings/${id}/parts?index=0`,audio));assert.equal(r.status,409);assert.equal(removals().length,1);
 setup();mode='lost';r=await handler(req(`/meetings/${id}/parts?index=0`,audio));assert.equal(r.status,503);assert.equal(removals().length,0);assert.equal(record.audioParts.length,1);
 calls.length=0;mode='';r=await handler(req(`/meetings/${id}/parts?index=0`,audio));assert.equal(r.status,200);assert.equal(calls.filter(c=>c.url.includes('/storage/')).length,0);
 setup();mode='race';record.audioParts=[{...plan,audioPath:'winner'}];
 // The initial read intentionally races: it sees no part, append returns the winner.
 const snapshot=record.audioParts;record.audioParts=[];
 const originalFetch=globalThis.fetch;globalThis.fetch=async(i,n)=>{if(String(i).endsWith('/kotonoha_resumable_upload'))record.audioParts=snapshot;return originalFetch(i,n);};
 try {r=await handler(req(`/meetings/${id}/parts?index=0`,audio));assert.equal(r.status,200);assert.equal(removals().length,1);assert.equal(record.audioParts[0].audioPath,'winner');} finally {globalThis.fetch=originalFetch;}
});
Deno.test('cloud attachment lost response replay is hash-qualified and uses new locked additive RPC',async()=>{
 setup();record.uploadPlan=[];record.audioParts=[];
 let r=await handler(req(`/meetings/${id}/attachments`,form()));assert.equal(r.status,201,await r.clone().text());assert.equal(record.attachments[0].sha256,ap.sha256);
 assert.ok(calls.some(c=>c.url.endsWith('/kotonoha_resumable_upload')&&c.b.p_operation==='attachment'));
 calls.length=0;r=await handler(req(`/meetings/${id}/attachments`,form()));assert.equal(r.status,200,await r.clone().text());assert.equal(calls.filter(c=>c.url.includes('/storage/')).length,0);
 r=await handler(req(`/meetings/${id}/attachments`,form('xyz')));assert.equal(r.status,409);
 setup();mode='lost';r=await handler(req(`/meetings/${id}/attachments`,form()));assert.equal(r.status,503);assert.equal(removals().length,0);
 mode='';calls.length=0;r=await handler(req(`/meetings/${id}/attachments`,form()));assert.equal(r.status,200);assert.equal(calls.filter(c=>c.url.includes('/storage/')).length,0);
 setup();mode='reject';r=await handler(req(`/meetings/${id}/attachments`,form()));assert.equal(r.status,409);assert.equal(removals().length,1);
 setup();mode='race';const winner={...ap,storagePath:'winner'};
 const originalFetch=globalThis.fetch;globalThis.fetch=async(i,n)=>{if(String(i).endsWith('/kotonoha_resumable_upload'))record.attachments=[winner];return originalFetch(i,n);};
 try {r=await handler(req(`/meetings/${id}/attachments`,form()));assert.equal(r.status,201);assert.equal(removals().length,1);assert.equal(record.attachments[0].storagePath,'winner');} finally {globalThis.fetch=originalFetch;}
 record.status='done';record.uploadReceipt={...record.uploadIdentity,meetingId:id,status:'accepted'};record.attachments=[];calls.length=0;
 r=await handler(req(`/meetings/${id}/attachments`,form()));assert.equal(r.status,409);assert.equal(calls.filter(c=>c.url.includes('/storage/')).length,0);
});
Deno.test('accepted complete retry and GET receipt need no AI key or job restart and hide frozen input',async()=>{
 setup();record.status='done';record.sources=[];record.uploadReceipt={...record.uploadIdentity,meetingId:id,status:'accepted'};keys=false;
 const r=await handler(req(`/meetings/${id}/complete`,{}));assert.equal(r.status,202,await r.clone().text());assert.equal((await r.json()).uploadReceipt.status,'accepted');
 assert.equal(calls.filter(c=>c.b.p_operation==='complete'||c.b.p_operation==='next').length,0);
 const get=await handler(req(`/meetings/${id}`));assert.equal(get.status,200);const data=await get.json();assert.deepEqual(data.uploadReceipt,record.uploadReceipt);assert.equal(data.uploadInput,undefined);
});

for (const phase of ['before acceptance','after acceptance']) Deno.test(`cloud privacy: erase frozen locations ${phase}; original retry and explicit regeneration`,async()=>{
 setup();record=null;
 const point={latitude:1.234567,longitude:2.345678,accuracy:8,capturedAt:'2026-10-28T01:02:03.000Z'};
 const input={uploadId:crypto.randomUUID(),metadata:{title:'privacy fixture',date:'2026-10-28',participants:'',template:'standard'},sources:[{name:'test.wav',size:3,startLocation:point}],parts:[plan],transcript:'',attachments:[]};
 const route=`/meetings/${input.uploadId}`,jobs:Promise<unknown>[]=[];
 const priorFetch=globalThis.fetch,priorEdge=(globalThis as any).EdgeRuntime;
 let transcribes=0,summaries=0,claims=0,completions=0,release!:()=>void;
 const held=new Promise<void>(r=>release=r);
 (globalThis as any).EdgeRuntime={waitUntil:(p:Promise<unknown>)=>jobs.push(p)};
 const snapshot=()=>Response.json({document:structuredClone(record),audioPath:null,responseId:null,leaseUntil:'2099-01-01T00:00:00Z'});
 globalThis.fetch=async(i,n:any)=>{
  const url=String(i),b=typeof n?.body==='string'?JSON.parse(n.body):{};
  if(url.endsWith('/kotonoha_resumable_upload')&&b.p_operation==='lookup')return record ? JSON.stringify(b.p_payload.document.uploadIdentity)===JSON.stringify(record.uploadIdentity)?snapshot():error('UPLOAD_CONFLICT') : Response.json(null);
  if(url.endsWith('/kotonoha_store')){
   if(b.p_operation==='get')return snapshot();
   if(b.p_operation==='list')return Response.json([await snapshot().json()]);
   if(b.p_operation==='patch'){Object.assign(record,b.p_payload);return snapshot();}
   if(b.p_operation==='claim'){claims++;Object.assign(record,b.p_payload);return snapshot();}
   if(b.p_operation==='job_update'){assert.equal(b.p_payload.runId,record.runId);Object.assign(record,b.p_payload.patch);return snapshot();}
  }
  if(url.endsWith('/kotonoha_resumable_upload')&&b.p_operation==='complete'){
   completions++;Object.assign(record,{status:'transcribing',runId:b.p_payload.runId,partReady:true,uploadReceipt:{...record.uploadIdentity,meetingId:input.uploadId,status:'accepted'}});return snapshot();
  }
  if(url.endsWith('/kotonoha_audio_upload')&&b.p_operation==='next'){
   if(!record.partReady)return Response.json(null);
   claims++;Object.assign(record,{runId:b.p_payload.runId,partReady:false});return snapshot();
  }
  if(url.includes('/storage/v1/object/')&&n?.method==='GET')return new Response(audio);
  if(url==='https://api.openai.com/v1/audio/transcriptions'){transcribes++;await held;return Response.json({id:'synthetic-transcript',text:'synthetic transcript'});}
  if(url==='https://api.openai.com/v1/responses'){
   summaries++;assert.doesNotMatch(JSON.stringify(b.input),/startLocation|recordingLocations|1\.234567|2\.345678/);
   return Response.json({id:`synthetic-summary-${summaries}`,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(minutesBundle((createDemo() as any).minutes))}]}]});
  }
  if(url.endsWith('/kotonoha_usage'))return Response.json({recorded:true});
  return priorFetch(i,n);
 };
 const clean=()=>assert.doesNotMatch(JSON.stringify(record),/startLocation|latitude|longitude|accuracy|capturedAt|1\.234567|2\.345678/,'saved cloud fixture JSON contains raw location');
 const remove=async()=>{const r=await handler(req(route,{recordingLocations:null},'PATCH'));assert.equal(r.status,200,await r.clone().text());clean();};
 const drain=async()=>{while(jobs.length)await Promise.all(jobs.splice(0));};
 try{
  assert.equal((await handler(req('/uploads',input))).status,201);
  assert.ok(record.uploadInput.sources[0].startLocation);
  const identity=structuredClone(record.uploadIdentity);
  if(phase==='before acceptance')await remove();
  assert.equal((await handler(req('/uploads',input))).status,201);
  for(const tampered of [{...input,metadata:{...input.metadata,title:'tampered'}},{...input,sources:[{...input.sources[0],startLocation:{...point,latitude:4}}]}])assert.equal((await handler(req('/uploads',tampered))).status,409);
  assert.equal((await handler(req(route+'/parts?index=0',audio))).status,200);
  assert.equal((await handler(req(route+'/complete',{}))).status,202);
  for(let n=0;n<2;n++){
   assert.equal((await handler(req('/uploads',input))).status,201);
   assert.equal((await handler(req(route+'/parts?index=0',audio))).status,200);
   assert.equal((await handler(req(route+'/complete',{}))).status,202);
  }
  release();await drain();
  assert.equal(transcribes,1);assert.equal(completions,1);assert.equal(claims,1);
  assert.equal((await handler(req('/meetings'))).status,200);await drain();
  assert.equal(record.status,'done');assert.equal(summaries,1);
  if(phase==='after acceptance')await remove();
  await remove();
  const receipt=structuredClone(record.uploadReceipt);
  for(let n=0;n<2;n++){
   assert.equal((await handler(req('/uploads',input))).status,201);
   assert.equal((await handler(req(route+'/parts?index=0',audio))).status,200);
   assert.equal((await handler(req(route+'/complete',{}))).status,202);clean();
  }
  assert.equal(transcribes,1);assert.equal(summaries,1);assert.equal(completions,1);assert.equal(claims,2);
  const regenerate=await handler(req(route+'/retry',{}));assert.equal(regenerate.status,202,await regenerate.clone().text());await drain();
  clean();assert.equal(record.status,'done');assert.equal(transcribes,1);assert.equal(summaries,2);assert.equal(claims,3);
  assert.deepEqual(record.uploadIdentity,identity);assert.deepEqual(record.uploadReceipt,receipt);
 }finally{release();await drain();globalThis.fetch=priorFetch;(globalThis as any).EdgeRuntime=priorEdge;}
});

