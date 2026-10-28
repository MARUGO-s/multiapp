-- Authenticated context is read-only and cannot relabel another workspace.
insert into kotonoha.sessions(token_hash,expires_at) values(repeat('a',64),now()+interval '1 hour');
insert into auth.users(id,email_confirmed_at) values('40000000-0000-4000-8000-000000000001',now());
insert into auth.identities(user_id,provider) values('40000000-0000-4000-8000-000000000001','google');
insert into kotonoha.google_members(user_id,workspace_id,status) select '40000000-0000-4000-8000-000000000001',workspace_id,'active' from kotonoha.access_config;
insert into kotonoha.sessions(token_hash,expires_at,google_user_id) values(repeat('b',64),now()+interval '1 hour','40000000-0000-4000-8000-000000000001');
begin read only;
set role service_role;
do $$ declare o uuid; a jsonb; begin
 o:=(public.kotonoha_auth('session',jsonb_build_object('tokenHash',repeat('a',64)))->>'workspaceId')::uuid;
 a:=public.kotonoha_resumable_upload('context',o,null,jsonb_build_object('tokenHash',repeat('a',64)));
 if a->>'ownerId'<>o::text or a->>'actorId'<>'shared' then raise exception 'context mismatch'; end if;
 a:=public.kotonoha_resumable_upload('context',o,null,jsonb_build_object('tokenHash',repeat('b',64)));
 if a->>'actorId'<>'40000000-0000-4000-8000-000000000001' then raise exception 'google actor mismatch'; end if;
 begin perform public.kotonoha_resumable_upload('context',gen_random_uuid(),null,jsonb_build_object('tokenHash',repeat('a',64))); raise exception 'context owner spoof accepted';
 exception when raise_exception then if sqlerrm<>'NOT_FOUND' then raise; end if; end;
end $$;
reset role;
commit;
update kotonoha.google_members set status='suspended' where user_id='40000000-0000-4000-8000-000000000001';
set role service_role;
do $$ declare o uuid; begin
 o:=(public.kotonoha_auth('session',jsonb_build_object('tokenHash',repeat('a',64)))->>'workspaceId')::uuid;
 begin perform public.kotonoha_resumable_upload('context',o,null,jsonb_build_object('tokenHash',repeat('b',64)));raise exception 'suspended actor accepted';
 exception when raise_exception then if sqlerrm<>'NOT_FOUND' then raise; end if; end;
end $$;
reset role;

set role service_role;
do $$
declare o uuid:='30000000-0000-4000-8000-000000000001'; i uuid:='30000000-0000-4000-8000-000000000002'; f uuid:='30000000-0000-4000-8000-000000000003'; d jsonb; a jsonb; b jsonb; plan jsonb;
begin
 plan:=jsonb_build_array(jsonb_build_object('id',f,'name','a.txt','size',3,'sha256',repeat('b',64)));
 d:=jsonb_build_object('id',i,'status','uploading','isDemo',false,'sources','[]'::jsonb,'transcript','fixture','uploadPlan','[]'::jsonb,'audioParts','[]'::jsonb,'attachmentPlan',plan,'attachments','[]'::jsonb,
   'uploadInput',jsonb_build_object('uploadId',i,'metadata',jsonb_build_object('title','fixture'),'sources','[]'::jsonb,'parts','[]'::jsonb,'transcript','fixture','attachments',plan),
   'uploadIdentity',jsonb_build_object('uploadId',i,'ownerId',o,'planDigest',repeat('a',64)));
 begin perform public.kotonoha_resumable_upload('create',o,i,jsonb_build_object('document',jsonb_set(d,'{uploadIdentity,ownerId}',to_jsonb(i)))); raise exception 'spoofed identity accepted';
 exception when raise_exception then if sqlerrm<>'UPLOAD_CONFLICT' then raise; end if; end;
 a:=public.kotonoha_resumable_upload('create',o,i,jsonb_build_object('document',d));
 begin perform public.kotonoha_resumable_upload('complete',o,i,'{"runId":"premature"}'); raise exception 'incomplete accepted';
 exception when raise_exception then if sqlerrm<>'UPLOAD_INCOMPLETE' then raise; end if; end;
 a:=public.kotonoha_resumable_upload('attachment',o,i,jsonb_build_object('attachment',plan->0 || '{"storagePath":"fixture"}'));
 b:=public.kotonoha_resumable_upload('attachment',o,i,jsonb_build_object('attachment',plan->0 || '{"storagePath":"race-loser"}'));
 if a<>b then raise exception 'attachment retry changed data'; end if;
 begin perform public.kotonoha_resumable_upload('attachment',o,i,jsonb_build_object('attachment',(plan->0)||jsonb_build_object('sha256',repeat('c',64),'storagePath','bad'))); raise exception 'changed attachment accepted';
 exception when raise_exception then if sqlerrm<>'UPLOAD_CONFLICT' then raise; end if; end;
 a:=public.kotonoha_resumable_upload('complete',o,i,'{"runId":"first"}');
 b:=public.kotonoha_resumable_upload('complete',o,i,'{"runId":"second"}');
 if a<>b or a->'document'->'uploadReceipt' <> jsonb_build_object('uploadId',i,'ownerId',o,'planDigest',repeat('a',64),'meetingId',i,'status','accepted') then raise exception 'receipt contract'; end if;
end $$;
reset role;
