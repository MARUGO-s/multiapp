import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { minutesMarkdownPatch } from '../supabase/functions/_shared/domain.mjs';
import { UploadSchema, uploadDigest, uploadDocument } from '../supabase/functions/_shared/upload.mjs';

const point = {latitude:1.234567,longitude:2.345678,accuracy:8,capturedAt:'2026-10-28T01:02:03.000Z'};
const rawLocation = /startLocation|latitude|longitude|accuracy|capturedAt|1\.234567|2\.345678/;
const bytes = new Uint8Array([1,2,3]);
function inputFor(id=randomUUID()) {
  return {uploadId:id,metadata:{title:'synthetic privacy regression',date:'2026-10-28'},sources:[{name:'fixture.wav',size:3,startLocation:point}],parts:[{name:'recording-1-1.wav',size:3,sourceIndex:0,partNumber:1,duration:1,sha256:createHash('sha256').update(bytes).digest('hex')}],attachments:[]};
}
test('location deletion erases the frozen input too, without changing immutable identity or other manifest fields', async () => {
  const input = UploadSchema.parse(inputFor());
  const original = structuredClone(input);
  const doc = uploadDocument(input,input.uploadId,'gpt-6-luna');
  doc.uploadIdentity={uploadId:input.uploadId,ownerId:'fixture',planDigest:await uploadDigest(input)};
  const next = {...doc,...minutesMarkdownPatch(doc,{recordingLocations:null})};
  assert.doesNotMatch(JSON.stringify(next),rawLocation,'all current saved copies must erase raw location');
  assert.deepEqual(next.uploadIdentity,doc.uploadIdentity);
  assert.deepEqual(next.uploadInput,{...input,sources:[{name:'fixture.wav',size:3}]});
  assert.deepEqual(input,original,'do not mutate the original request or client retry plan');
  assert.deepEqual(minutesMarkdownPatch(next,{recordingLocations:null}),minutesMarkdownPatch(doc,{recordingLocations:null}));
});
for (const phase of ['before acceptance','after acceptance']) {
  test(`real local HTTP: privacy deletion ${phase}, original retries, tamper rejection and regeneration`, async t => {
    const dir = await mkdtemp(path.join(tmpdir(),'kotonoha-privacy-http-'));
    let release;const held=new Promise(r=>release=r);let transcribes=0,summaries=0;
    const instance=await createApp({dataDir:dir,apiKey:'synthetic-fixture-only',aiFactory:()=>({
      async transcribe(){transcribes++;await held;return {transcript:'synthetic transcript'};},
      async summarize(){summaries++;return {summary:'synthetic minutes',topics:[],decisions:[],actions:[],openQuestions:[]};},
    })});
    const server=instance.app.listen(0,'127.0.0.1');await once(server,'listening');
    t.after(async()=>{release();await instance.waitForJobs();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
    const base=`http://127.0.0.1:${server.address().port}/api`,input=inputFor(),route=`/meetings/${input.uploadId}`;
    const request=(p,b,method='POST')=>fetch(base+p,{method,headers:{'X-Kotonoha':'1','Content-Type':b instanceof Uint8Array?'application/octet-stream':'application/json'},body:b instanceof Uint8Array?b:JSON.stringify(b)});
    const disk=async()=>await readFile(path.join(dir,'meetings',`${input.uploadId}.json`),'utf8');
    const clean=async()=>{assert.doesNotMatch(await disk(),rawLocation,'no raw coordinates in saved JSON');assert.doesNotMatch(JSON.stringify(instance.store.get(input.uploadId)),rawLocation,'no raw coordinates in memory');};
    const deleted=async()=>{assert.equal((await request(route,{recordingLocations:null},'PATCH')).status,200);await clean();};
    assert.equal((await request('/uploads',input)).status,201);
    const identity=instance.store.get(input.uploadId).uploadIdentity;
    assert.match(await disk(),/startLocation/,'the regression must exercise a stored coordinate copy');
    assert.equal((await request('/uploads',input)).status,200);
    if(phase==='before acceptance')await deleted();
    for(const mutation of [ {...input,metadata:{...input.metadata,title:'tampered'}}, {...input,sources:[{...input.sources[0],startLocation:{...point,latitude:4}}]} ])assert.equal((await request('/uploads',mutation)).status,409);
    assert.equal((await request('/uploads',input)).status,200);
    assert.equal((await request(route+'/parts?index=0',bytes)).status,200);
    assert.equal((await request(route+'/parts?index=0',bytes)).status,200);
    assert.equal((await request(route+'/complete',{})).status,202);
    const receipt=instance.store.get(input.uploadId).uploadReceipt;
    assert.deepEqual(receipt,{...identity,meetingId:input.uploadId,status:'accepted'});
    for(let n=0;n<2;n++){
      assert.equal((await request('/uploads',input)).status,200);
      assert.equal((await request(route+'/parts?index=0',bytes)).status,200);
      assert.equal((await request(route+'/complete',{})).status,202);
    }
    assert.equal(transcribes,1,'replays while AI is held never start a second job');
    release();await instance.waitForJobs();
    if(phase==='after acceptance')await deleted();
    await deleted();
    for(let n=0;n<2;n++){
      const replay=await request('/uploads',input);assert.equal(replay.status,200);
      const publicDoc=await replay.json();assert.deepEqual(publicDoc.recordingLocations,[]);assert.equal(publicDoc.uploadInput,undefined);
      assert.equal((await request(route+'/parts?index=0',bytes)).status,200);
      assert.equal((await request(route+'/complete',{})).status,202);await clean();
    }
    assert.equal((await request('/uploads',{...input,sources:[{...input.sources[0],startLocation:{...point,longitude:5}}]})).status,409);
    assert.equal(summaries,1,'complete/init retries do not regenerate');
    assert.equal((await request(route+'/retry',{})).status,202);await instance.waitForJobs();await clean();
    assert.equal(transcribes,1);assert.equal(summaries,2,'only explicit regeneration starts one additional summary');
    assert.deepEqual(instance.store.get(input.uploadId).uploadIdentity,identity);
    assert.deepEqual(instance.store.get(input.uploadId).uploadReceipt,receipt);
    assert.equal(instance.store.list().length,1);
  });
}
