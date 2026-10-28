-- Disposable real PG only; service-role RPCs against the latest actual chain.
set role service_role;
do $$
declare o uuid := '50000000-0000-4000-8000-000000000001'; i uuid; d jsonb; a jsonb; b jsonb; frozen jsonb; patch jsonb; phase integer; identity jsonb; receipt jsonb; run text;
begin
 for phase in 0..1 loop
  i := gen_random_uuid(); run := 'privacy-' || phase;
  frozen := jsonb_build_object('uploadId',i,'metadata',jsonb_build_object('title','privacy fixture','date','2026-10-28'),
    'sources',jsonb_build_array(jsonb_build_object('name','fixture.wav','size',3,'startLocation',jsonb_build_object('latitude',1.234567,'longitude',2.345678,'accuracy',8,'capturedAt','2026-10-28T01:02:03.000Z'))),
    'parts',jsonb_build_array(jsonb_build_object('name','recording-1-1.wav','size',3,'sourceIndex',0,'partNumber',1,'duration',1,'sha256',repeat('b',64))),'transcript','','attachments','[]'::jsonb);
  identity := jsonb_build_object('uploadId',i,'ownerId',o,'planDigest',repeat('a',64));
  d := jsonb_build_object('id',i,'isDemo',false,'status','uploading','uploadInput',frozen,'uploadIdentity',identity,
    'sources',frozen->'sources','recordingLocations',jsonb_build_array((frozen->'sources'->0->'startLocation') || '{"sourceIndex":0}'::jsonb),
    'audioParts','[]'::jsonb,'uploadPlan',frozen->'parts','attachments','[]'::jsonb,'attachmentPlan','[]'::jsonb);
  a := public.kotonoha_resumable_upload('create',o,i,jsonb_build_object('document',d));
  b := public.kotonoha_resumable_upload('lookup',o,i,jsonb_build_object('document',d));
  if a<>b then raise exception 'pre-deletion replay mutated'; end if;
  patch := jsonb_build_object('recordingLocations','[]'::jsonb,'sources',jsonb_build_array((frozen->'sources'->0)-'startLocation'),
    'uploadInput',jsonb_set(frozen,'{sources}',jsonb_build_array((frozen->'sources'->0)-'startLocation')));
  if phase=0 then
    a := public.kotonoha_store('patch',o,i,patch);
    if a->'document'->'uploadInput'->'sources'->0 ? 'startLocation' then raise exception 'frozen coordinate not erased'; end if;
    -- Original payload still contains coordinates; no conflict and no writeback.
    b := public.kotonoha_resumable_upload('lookup',o,i,jsonb_build_object('document',d));
    if a<>b then raise exception 'lookup restored raw coordinates'; end if;
    b := public.kotonoha_resumable_upload('create',o,i,jsonb_build_object('document',d));
    if a<>b then raise exception 'create retry restored raw coordinates'; end if;
  end if;
  a := public.kotonoha_resumable_upload('append',o,i,jsonb_build_object('index',0,'part',(frozen->'parts'->0)||'{"audioPath":"synthetic.wav"}'::jsonb));
  b := public.kotonoha_resumable_upload('append',o,i,jsonb_build_object('index',0,'part',(frozen->'parts'->0)||'{"audioPath":"duplicate.wav"}'::jsonb));
  if a<>b then raise exception 'append duplicated'; end if;
  a := public.kotonoha_resumable_upload('complete',o,i,jsonb_build_object('runId',run));
  receipt := a->'document'->'uploadReceipt';
  if receipt <> identity || jsonb_build_object('meetingId',i,'status','accepted') then raise exception 'receipt changed'; end if;
  -- Existing BUSY protection remains: delete after the accepted job finishes.
  perform public.kotonoha_store('job_update',o,i,jsonb_build_object('runId',run,'patch',jsonb_build_object('status','done','transcript','synthetic transcript')));
  a := public.kotonoha_store('patch',o,i,patch);
  a := public.kotonoha_store('get',o,i);
  b := public.kotonoha_resumable_upload('create',o,i,jsonb_build_object('document',d));
  if a<>b then raise exception 'accepted init replay mutated'; end if;
  b := public.kotonoha_resumable_upload('lookup',o,i,jsonb_build_object('document',d));
  if a<>b then raise exception 'accepted lookup replay mutated'; end if;
  b := public.kotonoha_resumable_upload('append',o,i,jsonb_build_object('index',0,'part',(frozen->'parts'->0)||'{"audioPath":"late.wav"}'::jsonb));
  if a<>b then raise exception 'accepted part replay mutated'; end if;
  b := public.kotonoha_resumable_upload('complete',o,i,'{"runId":"must-not-start"}');
  if a<>b then raise exception 'accepted complete re-claimed AI'; end if;
  -- Defense-in-depth: even a trusted caller reusing the old digest cannot change non-location input.
  begin
    perform public.kotonoha_resumable_upload('lookup',o,i,jsonb_build_object('document',jsonb_set(d,'{uploadInput,metadata,title}','"tampered"')));
    raise exception 'tampered manifest accepted';
  exception when raise_exception then if sqlerrm<>'UPLOAD_CONFLICT' then raise; end if; end;
  begin
    perform public.kotonoha_resumable_upload('create',o,i,jsonb_build_object('document',jsonb_set(d,'{uploadIdentity,planDigest}',to_jsonb(repeat('c',64)))));
    raise exception 'different digest accepted';
  exception when raise_exception then if sqlerrm<>'UPLOAD_CONFLICT' then raise; end if; end;
  -- Explicit regeneration: existing claim/job-update RPCs keep privacy and receipt.
  b := public.kotonoha_store('claim',o,i,jsonb_build_object('runId','regenerated','status','analyzing'));
  b := public.kotonoha_store('job_update',o,i,'{"runId":"regenerated","patch":{"status":"done","markdown":"synthetic regenerated"}}');
  if b->'document'->'uploadIdentity'<>identity or b->'document'->'uploadReceipt'<>receipt then raise exception 'regeneration changed receipt'; end if;
  if (b->'document')::text ~ 'startLocation|latitude|longitude|accuracy|capturedAt|1[.]234567|2[.]345678' then raise exception 'raw coordinates persisted'; end if;
  a := public.kotonoha_resumable_upload('create',o,i,jsonb_build_object('document',d));
  if a<>b then raise exception 'post regeneration retry changed document'; end if;
 end loop;
end $$;
reset role;
select 'PASS privacy: before/after accepted, location-free persisted JSON, original init/lookup/part/complete replay, tamper rejection, regeneration';
