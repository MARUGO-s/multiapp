-- Run against the verified target only. All changes are rolled back.
begin;
do $test$
declare
  v_hash text := encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex');
  v_ip text := encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex');
  v_store uuid;
  v_user uuid;
  v_result jsonb;
begin
  assert not has_function_privilege('anon',
    'public.marugo_qr_shared(text,text,uuid,uuid,jsonb)','execute');
  assert not has_function_privilege('authenticated',
    'public.marugo_qr_shared(text,text,uuid,uuid,jsonb)','execute');
  assert has_function_privilege('service_role',
    'public.marugo_qr_shared(text,text,uuid,uuid,jsonb)','execute');

  update kotonoha.access_config set qr_shared_login_enabled=true,
    login_id='shared-qr-transaction-test',
    password_hash=extensions.crypt('test-only-never-published',extensions.gen_salt('bf',4));
  delete from kotonoha.login_attempts where key='global';
  v_result := public.kotonoha_auth('login',jsonb_build_object(
    'loginId','shared-qr-transaction-test','password','test-only-never-published',
    'tokenHash',v_hash,'ipHash',v_ip));
  assert v_result->>'workspaceId' is not null, 'existing password login creates shared session';
  v_result := public.marugo_qr_shared('context',v_hash);
  assert v_result->>'accessMode'='shared';
  assert v_result->'member'->>'role'='admin';
  assert jsonb_array_length(v_result->'stores')=(select count(*) from kotonoha.qr_stores where active);
  for v_store in select id from kotonoha.qr_stores where active loop
    assert public.marugo_qr_shared('scope',v_hash,v_store)->>'workspaceId'=v_store::text;
  end loop;
  assert public.marugo_qr_shared('members',v_hash)->'members' is not null;
  begin
    perform public.marugo_qr_shared('scope',v_hash,gen_random_uuid());
    raise exception 'unknown store was allowed';
  exception when others then
    if sqlerrm<>'STORE_FORBIDDEN' then raise; end if;
  end;
  begin
    perform public.marugo_qr_shared('update_member',v_hash,null,gen_random_uuid(),'{"action":"approve"}');
    raise exception 'unknown account was allowed';
  exception when others then
    if sqlerrm<>'MEMBER_NOT_FOUND' then raise; end if;
  end;

  update kotonoha.access_config set qr_shared_login_enabled=false;
  begin
    perform public.marugo_qr_shared('context',v_hash);
    raise exception 'disabled switch was ignored';
  exception when others then
    if sqlerrm<>'SHARED_QR_FORBIDDEN' then raise; end if;
  end;
  update kotonoha.access_config set qr_shared_login_enabled=true;
  update kotonoha.sessions set expires_at=now()-interval '1 second' where token_hash=v_hash;
  begin
    perform public.marugo_qr_shared('context',v_hash);
    raise exception 'expired session was allowed';
  exception when others then
    if sqlerrm<>'INVALID_SESSION' then raise; end if;
  end;
  update kotonoha.sessions set expires_at=now()+interval '1 minute' where token_hash=v_hash;
  select id into v_user from auth.users where deleted_at is null limit 1;
  assert v_user is not null;
  update kotonoha.sessions set google_user_id=v_user where token_hash=v_hash;
  begin
    perform public.marugo_qr_shared('context',v_hash);
    raise exception 'Google bridge acquired shared QR privileges';
  exception when others then
    if sqlerrm<>'INVALID_SESSION' then raise; end if;
  end;
  update kotonoha.sessions set google_user_id=null where token_hash=v_hash;
  perform public.kotonoha_auth('logout',jsonb_build_object('tokenHash',v_hash));
  begin
    perform public.marugo_qr_shared('context',v_hash);
    raise exception 'revoked session was allowed';
  exception when others then
    if sqlerrm<>'INVALID_SESSION' then raise; end if;
  end;
end;
$test$;
rollback;
select 'PASS: existing password login, all store scopes, admin context, switch, expiry, Google exclusion, revocation and RPC permissions; all changes rolled back' as result;
