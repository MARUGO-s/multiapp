-- Test-only records; everything including audit/session changes is rolled back.
begin;
do $test$
declare
 admin_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); protected_id uuid:=gen_random_uuid();
 workspace uuid; store uuid:=gen_random_uuid(); req uuid:=gen_random_uuid(); version text;
 r jsonb; c jsonb; key text; token_hash text:=encode(extensions.gen_random_bytes(32),'hex');
 legacy_token text:=encode(extensions.gen_random_bytes(32),'hex');
begin
 assert not has_function_privilege('anon','public.marugo_directory_change(uuid,uuid,text,text,text,text)','execute');
 assert not has_function_privilege('authenticated','public.marugo_directory_change(uuid,uuid,text,text,text,text)','execute');
 assert not has_function_privilege('authenticated','public.marugo_directory_history(uuid,integer)','execute');
 assert not has_function_privilege('service_role','marugo_directory.access_control(uuid,text)','execute');
 select workspace_id into workspace from kotonoha.access_config where singleton;
 insert into auth.users(id,email,email_confirmed_at) values
  (admin_id,admin_id::text||'@example.invalid',now()), (member_id,member_id::text||'@example.invalid',now()), (protected_id,protected_id::text||'@example.invalid',now());
 insert into auth.identities(user_id,provider,provider_id,identity_data)
 select id,'google',id::text,jsonb_build_object('sub',id::text) from auth.users where id in (admin_id,member_id,protected_id);
 insert into marugo_directory.admins(user_id,enabled,can_manage_access) values(admin_id,true,true);
 insert into kotonoha.google_members(user_id,workspace_id,status,role) values(member_id,workspace,'pending','member'),(protected_id,workspace,'active','admin');
 insert into kotonoha.qr_stores(id,name,active,legacy) values(store,'Directory test',true,false);
 insert into kotonoha.qr_members(user_id,store_id,status,role) values(member_id,store,'pending','member'),(protected_id,null,'active','admin');
 key:='kotonoha:'||member_id::text;
 c:=marugo_directory.access_control(admin_id,key); version:=c->>'version';
 assert c->'actions' ? 'approve';
 begin
  perform public.marugo_directory_change(member_id,req,key,'approve',version,'test');
  raise exception 'UNAUTHORIZED_WRITE';
 exception when others then if sqlerrm<>'ADMIN_REQUIRED' then raise; end if; end;
 begin
  perform public.marugo_directory_change(admin_id,req,key,'approve',repeat('0',32),'test');
  raise exception 'STALE_ALLOWED';
 exception when others then if sqlerrm<>'STALE_STATE' then raise; end if; end;
 r:=public.marugo_directory_change(admin_id,req,key,'approve',version,'test');
 assert r->>'status'='active';
 assert (select status='pending' from kotonoha.qr_members where user_id=member_id);
 assert (public.marugo_directory_change(admin_id,req,key,'approve',version,'test'))->>'replayed'='true';
 assert (select count(*)=1 from marugo_directory.change_audit where actor_id=admin_id);
 begin
  perform public.marugo_directory_change(admin_id,req,key,'suspend',version,'test');
  raise exception 'REPLAY_CONFLICT_ALLOWED';
 exception when others then if sqlerrm<>'REQUEST_CONFLICT' then raise; end if; end;
 -- Revoke must also remove a real Google bridge session, but leave shared-ID sessions.
 perform public.kotonoha_google_auth('login',member_id,null,jsonb_build_object('tokenHash',token_hash));
 insert into kotonoha.sessions(token_hash,expires_at) values(legacy_token,now()+interval '1 hour');
 assert exists(select 1 from kotonoha.sessions where google_user_id=member_id);
 c:=marugo_directory.access_control(admin_id,key);
 r:=public.marugo_directory_change(admin_id,gen_random_uuid(),key,'suspend',c->>'version','test revoke');
 assert r->>'status'='suspended';
 assert not exists(select 1 from kotonoha.sessions where google_user_id=member_id);
 assert exists(select 1 from kotonoha.sessions where kotonoha.sessions.token_hash=legacy_token);
 assert (public.kotonoha_google_auth('login',member_id,null,jsonb_build_object('tokenHash',token_hash)))->>'error'='APPROVAL_REQUIRED';
 -- Native QR access checks must reject after revocation too.
 key:='qr:'||member_id::text;
 c:=marugo_directory.access_control(admin_id,key);
 r:=public.marugo_directory_change(admin_id,gen_random_uuid(),key,'approve',c->>'version','test QR');
 assert r->>'status'='active';
 assert (public.marugo_qr_accounts('scope',member_id,store))->>'workspaceId'=store::text;
 assert (select status='suspended' from kotonoha.google_members where user_id=member_id);
 c:=marugo_directory.access_control(admin_id,key);
 r:=public.marugo_directory_change(admin_id,gen_random_uuid(),key,'suspend',c->>'version','test QR revoke');
 assert r->>'status'='suspended';
 begin
  perform public.marugo_qr_accounts('scope',member_id,store);
  raise exception 'SUSPENDED_QR_ACCESS_ALLOWED';
 exception when others then if sqlerrm<>'ACCOUNT_PENDING_OR_SUSPENDED' then raise; end if; end;
 assert (select count(*)=2 from kotonoha.qr_account_audit where actor_id=admin_id);
 -- Protected roles cannot be changed through this bridge.
 key:='qr:'||protected_id::text;
 c:=marugo_directory.access_control(admin_id,key);
 assert c->'actions'='[]'::jsonb;
 begin
  perform public.marugo_directory_change(admin_id,gen_random_uuid(),key,'suspend',c->>'version','test');
  raise exception 'ADMIN_TARGET_ALLOWED';
 exception when others then if sqlerrm<>'ACTION_FORBIDDEN' then raise; end if; end;
 assert marugo_directory.access_control(admin_id,'qr:'||member_id::text||':extra') is null;
 update auth.users set email_confirmed_at=null where id=member_id;
 assert not (marugo_directory.access_control(admin_id,'qr:'||member_id::text)->'actions' ? 'approve');
 update auth.users set email_confirmed_at=now() where id=member_id;
 update kotonoha.qr_stores set active=false where id=store;
 assert not (marugo_directory.access_control(admin_id,'qr:'||member_id::text)->'actions' ? 'approve');
 r:=public.marugo_directory_history(admin_id);
 assert jsonb_array_length(r->'rows')>=4;
 assert not exists(select 1 from jsonb_array_elements(r->'rows') x where x ? 'before_data' or x ? 'after_data');
 r:=public.marugo_directory_page(admin_id,'qr',member_id::text,'',0);
 assert not exists(select 1 from jsonb_array_elements(r->'rows') x where x->'control' ? 'snapshot');
 update marugo_directory.admins set can_manage_access=false where user_id=admin_id;
 begin
  perform public.marugo_directory_change(admin_id,req,'kotonoha:'||member_id::text,'approve',version,'test');
  raise exception 'REVOKED_ADMIN_REPLAY';
 exception when others then if sqlerrm<>'ADMIN_REQUIRED' then raise; end if; end;
end $test$;
rollback;
select 'passed: approval, immediate session revocation, cross-app isolation, audit, idempotency, stale-state rejection, admin protections, service-only grants; fixtures rolled back' as verification;
