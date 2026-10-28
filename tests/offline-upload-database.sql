-- Local-only contract of the additive resumable RPC (run with scripts/test-offline-postgres.py).
set role service_role;
do $$
declare o uuid := '00000000-0000-4000-8000-000000000001';
 i uuid := '00000000-0000-4000-8000-000000000002'; d jsonb; a jsonb; b jsonb;
begin
 d := jsonb_build_object('id',i,'isDemo',false,'status','uploading','uploadInput',jsonb_build_object('uploadId',i,'metadata',jsonb_build_object('title','fixture')),
 'uploadIdentity',jsonb_build_object('uploadId',i,'ownerId',o,'planDigest',repeat('a',64)),
 'audioParts','[]'::jsonb,'sources',jsonb_build_array(jsonb_build_object('name','test.wav','size',3,'startLocation',jsonb_build_object('latitude',35,'longitude',139))), 'uploadPlan',jsonb_build_array(jsonb_build_object('size',3,'sha256',repeat('b',64))), 'attachmentPlan','[]'::jsonb,'attachments','[]'::jsonb);
 a:=public.kotonoha_resumable_upload('create',o,i,jsonb_build_object('document',d));
 b:=public.kotonoha_resumable_upload('create',o,i,jsonb_build_object('document',d || '{"createdAt":"different"}'::jsonb));
 if a->'document' <> b->'document' then raise exception 'replay changed document'; end if;
 begin
  perform public.kotonoha_resumable_upload('create',o,i,jsonb_build_object('document',jsonb_set(d,'{uploadInput,metadata,title}','"changed"')));
  raise exception 'conflict accepted';
 exception when raise_exception then if sqlerrm <> 'UPLOAD_CONFLICT' then raise; end if; end;
 begin
  perform public.kotonoha_resumable_upload('append',o,i,jsonb_build_object('index',0,'part',jsonb_build_object('size',3,'sha256',repeat('c',64),'audioPath','wrong')));
  raise exception 'mismatched plan hash accepted';
 exception when raise_exception then if sqlerrm <> 'UPLOAD_CONFLICT' then raise; end if; end;
 begin
  -- A legacy/service bug must not turn matching array lengths into an acceptance receipt.
  perform public.kotonoha_audio_upload('append',o,i,jsonb_build_object('index',0,'part',jsonb_build_object('size',3,'sha256',repeat('c',64),'audioPath','wrong')));
  perform public.kotonoha_resumable_upload('complete',o,i,'{"runId":"tampered"}');
  raise exception 'corrupt full-audio accepted';
 exception when raise_exception then if sqlerrm <> 'UPLOAD_INCOMPLETE' then raise; end if; end;
 a:=public.kotonoha_resumable_upload('append',o,i,jsonb_build_object('index',0,'part',jsonb_build_object('size',3,'sha256',repeat('b',64),'audioPath','fixture')));
 b:=public.kotonoha_resumable_upload('append',o,i,jsonb_build_object('index',0,'part',jsonb_build_object('size',3,'sha256',repeat('b',64),'audioPath','another')));
 if a<>b then raise exception 'part duplicated'; end if;
 a:=public.kotonoha_resumable_upload('complete',o,i,jsonb_build_object('runId','fixture'));
 b:=public.kotonoha_resumable_upload('complete',o,i,jsonb_build_object('runId','different'));
 if a<>b or a->'document'->'uploadReceipt'->>'status'<>'accepted' then raise exception 'receipt not stable'; end if;
 perform public.kotonoha_store('job_update',o,i,'{"runId":"fixture","patch":{"status":"done"}}');
 perform public.kotonoha_store('patch',o,i,jsonb_build_object('sources',jsonb_build_array(jsonb_build_object('name','test.wav','size',3))));
 a:=public.kotonoha_store('get',o,i);
 b:=public.kotonoha_resumable_upload('create',o,i,jsonb_build_object('document',d));
 if a<>b or b->'document'->'sources'->0 ? 'startLocation' then raise exception 'retry restored removed location'; end if;
 b:=public.kotonoha_resumable_upload('lookup',o,i,jsonb_build_object('document',d));
 if a<>b then raise exception 'lookup mutated record'; end if;
 b:=public.kotonoha_resumable_upload('complete',o,i,'{"runId":"retry-after-edit"}');
 if a<>b then raise exception 'complete restored frozen input'; end if;
 begin perform public.kotonoha_resumable_upload('complete',gen_random_uuid(),i); raise exception 'cross-owner complete accepted';
 exception when raise_exception then if sqlerrm<>'NOT_FOUND' then raise; end if; end;
 perform public.kotonoha_store('delete',o,i);
 begin perform public.kotonoha_resumable_upload('create',o,i,jsonb_build_object('document',d)); raise exception 'deleted upload restored';
 exception when raise_exception then if sqlerrm<>'UPLOAD_CONFLICT' then raise; end if; end;
 if has_function_privilege('anon','public.kotonoha_resumable_upload(text,uuid,uuid,jsonb)','execute') or
 has_function_privilege('authenticated','public.kotonoha_resumable_upload(text,uuid,uuid,jsonb)','execute') then raise exception 'public grants'; end if;
end $$;
reset role;
