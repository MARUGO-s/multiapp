-- All fixtures, including test Auth users, are rolled back. No existing user is changed.
begin;
do $test$
declare
  owner_uid uuid:=gen_random_uuid(); member_uid uuid:=gen_random_uuid(); stranger_uid uuid:=gen_random_uuid();
  workspace uuid; r jsonb; proof text:=encode(extensions.gen_random_bytes(32),'hex');
  google_token text:=encode(extensions.gen_random_bytes(32),'hex');
begin
  assert not has_function_privilege('anon','public.kotonoha_google_auth(text,uuid,uuid,jsonb)','execute');
  assert not has_function_privilege('authenticated','public.kotonoha_google_auth(text,uuid,uuid,jsonb)','execute');
  assert not has_function_privilege('service_role','kotonoha.kotonoha_auth(text,jsonb)','execute');
  assert not has_table_privilege('authenticated','kotonoha.google_members','select');
  select workspace_id into workspace from kotonoha.access_config where singleton;
  insert into auth.users(id,email,email_confirmed_at) values
    (owner_uid,owner_uid::text||'@example.invalid',now()),
    (member_uid,member_uid::text||'@example.invalid',now()),
    (stranger_uid,stranger_uid::text||'@example.invalid',now());
  insert into auth.identities(user_id,provider,provider_id,identity_data) values
    (owner_uid,'google',owner_uid::text,jsonb_build_object('sub',owner_uid::text)),
    (member_uid,'google',member_uid::text,jsonb_build_object('sub',member_uid::text));
  assert (public.kotonoha_google_auth('context',stranger_uid))->>'error'='GOOGLE_REQUIRED';
  assert (public.kotonoha_google_auth('request',member_uid))->>'error'='LEGACY_REQUIRED';
  insert into kotonoha.sessions(token_hash,expires_at) values(proof,now()+interval '1 hour');
  r:=public.kotonoha_google_auth('request',member_uid,null,jsonb_build_object('legacyHash',proof,'status','active','role','admin'));
  assert r->'member'->>'status'='pending'; assert r->'member'->>'role'='member';
  assert (public.kotonoha_google_auth('login',member_uid,null,jsonb_build_object('tokenHash',google_token)))->>'error'='APPROVAL_REQUIRED';
  assert (public.kotonoha_google_auth('members',member_uid))->>'error'='ADMIN_REQUIRED';
  -- Test-only out-of-band owner setup. Production setup needs explicit owner designation.
  insert into kotonoha.google_members(user_id,workspace_id,status,role) values(owner_uid,workspace,'active','admin');
  assert (public.kotonoha_google_auth('update',member_uid,member_uid,'{"action":"approve"}'))->>'error'='ADMIN_REQUIRED';
  assert (public.kotonoha_google_auth('update',owner_uid,member_uid,'{"action":"grant_admin"}'))->>'error'='INVALID_ACTION';
  assert (public.kotonoha_google_auth('update',owner_uid,owner_uid,'{"action":"suspend"}'))->>'error'='ADMIN_PROTECTED';
  perform public.kotonoha_google_auth('update',owner_uid,member_uid,'{"action":"approve"}');
  perform public.kotonoha_google_auth('login',member_uid,null,jsonb_build_object('tokenHash',google_token));
  r:=public.kotonoha_auth('session',jsonb_build_object('tokenHash',google_token));
  assert r->>'workspaceId'=workspace::text;
  assert exists(select 1 from kotonoha.sessions where token_hash=google_token and google_user_id=member_uid);
  -- A Google bridge cannot be used as the old-password proof.
  assert (public.kotonoha_google_auth('request',owner_uid,null,jsonb_build_object('legacyHash',google_token)))->>'error'='LEGACY_REQUIRED';
  -- Direct suspension also fails the session guard, before session deletion.
  update kotonoha.google_members set status='suspended' where user_id=member_uid;
  assert (public.kotonoha_auth('session',jsonb_build_object('tokenHash',google_token)))->>'error'='INVALID_TOKEN';
  assert (public.kotonoha_google_auth('request',member_uid,null,jsonb_build_object('legacyHash',proof)))->'member'->>'status'='suspended';
  perform public.kotonoha_google_auth('update',owner_uid,member_uid,'{"action":"approve"}');
  perform public.kotonoha_google_auth('update',owner_uid,member_uid,'{"action":"suspend"}');
  assert not exists(select 1 from kotonoha.sessions where token_hash=google_token);
  assert (public.kotonoha_auth('session',jsonb_build_object('tokenHash',proof)))->>'workspaceId'=workspace::text;
end;
$test$;
rollback;
select 'Google approval, legacy proof, immediate revocation and service-only permissions passed; fixtures rolled back' as result;
