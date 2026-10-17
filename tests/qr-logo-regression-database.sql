-- Existing authorization, scan, analytics, lifecycle and grants are regression gates.
begin;
do $test$
declare
  own uuid := gen_random_uuid(); other_store uuid := gen_random_uuid(); item uuid := gen_random_uuid();
  event uuid := gen_random_uuid(); original jsonb; changed jsonb; history jsonb; analytics jsonb;
  signature text; role_name text; table_name text;
begin
  -- No existing pre-migration link, file attempt, or unrelated QR RPC is rewritten.
  assert not exists(select 1 from kotonoha.qr_links l
    join public.qr_logo_legacy_snapshot s on l.id=(s.row->>'id')::uuid
    where to_jsonb(l)-'logo_id' is distinct from s.row);
  assert not exists(select 1 from kotonoha.qr_files f
    join public.qr_logo_legacy_file_snapshot s on f.id=(s.row->>'id')::uuid
    where to_jsonb(f)-'logo_id' is distinct from s.row);
  assert (select logo_id is null from kotonoha.qr_links where id='00000000-0000-4000-8000-000000000073');
  assert (select logo_id is null from kotonoha.qr_files where id='00000000-0000-4000-8000-000000000074');
  assert not exists(select 1 from public.qr_logo_function_snapshot s
    where pg_get_functiondef(s.signature::regprocedure) is distinct from s.definition),
    'scan/history/unique analytics/lifecycle/account functions must be byte-identical';

  original := public.kotonoha_qr('create',own,item,
    '{"code":"logoScope001","title":"Scoped QR","targetUrl":"https://example.com/history","logoId":"line-ios"}');
  perform public.kotonoha_qr_scan_unique('logoScope001',event,'qr',null,'mobile','safari','local-test',repeat('b',64));
  -- Legacy and current scan calls remain event-idempotent across logo changes.
  perform public.kotonoha_qr_scan('logoScope001',event,'button');
  perform public.kotonoha_qr('scan',null,null,jsonb_build_object('code','logoScope001','eventId',event));
  history := public.kotonoha_qr_history(own,item);
  analytics := public.kotonoha_qr_analytics(own,item,7,'all');
  assert history->>'total'='1';
  assert analytics->>'periodUnique'='1' and analytics->>'periodTotal'='1';
  original := (select to_jsonb(l) from kotonoha.qr_links l where id=item);
  changed := public.kotonoha_qr('logo',own,item,'{"logoId":"instagram-white"}');
  assert changed-'logo_id'=original-'logo_id';
  assert public.kotonoha_qr_history(own,item)=history;
  assert public.kotonoha_qr_analytics(own,item,7,'all')=analytics;
  assert public.kotonoha_qr('history',own,item)->>'total'='1';
  assert public.kotonoha_qr('list',own)->'links'->0=changed;
  assert public.kotonoha_qr('list',other_store)->>'total'='0';
  begin
    perform public.kotonoha_qr('logo',other_store,item,'{"logoId":"line-android"}');
    raise exception 'FOREIGN_LOGO_WRITE_ALLOWED';
  exception when no_data_found then null; end;
  assert (select to_jsonb(l)=changed from kotonoha.qr_links l where id=item);
  changed := public.kotonoha_qr_lifecycle('trash',own,item);
  assert changed->>'logo_id'='instagram-white' and changed->>'active'='false';
  assert public.kotonoha_qr('list',own)->>'total'='0';
  assert public.kotonoha_qr('trash_list',own)->'links'->0=changed;
  assert public.kotonoha_qr('trash_list',other_store)->>'total'='0';
  begin
    perform public.kotonoha_qr('logo',own,item,'{"logoId":null}');
    raise exception 'TRASH_LOGO_WRITE_ALLOWED';
  exception when others then if sqlerrm<>'TRASHED' then raise; end if; end;
  changed := public.kotonoha_qr_lifecycle('restore',own,item);
  assert changed->>'logo_id'='instagram-white' and changed->>'active'='false';
  assert changed->'deleted_at'='null'::jsonb;
  assert public.kotonoha_qr('list',own)->'links'->0=changed;
  assert public.kotonoha_qr('trash_list',own)->>'total'='0';
  assert public.kotonoha_qr_history(own,item)=history;
  assert public.kotonoha_qr_analytics(own,item,7,'all')=analytics;
  assert (select count(*) from kotonoha.qr_access_logs where link_id=item)=1;

  foreach signature in array array[
    'public.kotonoha_qr(text,uuid,uuid,jsonb)', 'public.kotonoha_qr_file(text,uuid,uuid,jsonb)',
    'kotonoha.qr_logo_valid(jsonb)', 'public.kotonoha_qr_lifecycle(text,uuid,uuid,uuid)',
    'public.kotonoha_qr_scan_unique(text,uuid,text,text,text,text,text,text)',
    'public.kotonoha_qr_history(uuid,uuid,integer)', 'public.kotonoha_qr_analytics(uuid,uuid,integer,text)'
  ] loop
    assert has_function_privilege('service_role',signature,'execute'), signature||' must remain service-callable';
    foreach role_name in array array['anon','authenticated'] loop
      assert not has_function_privilege(role_name,signature,'execute'), role_name||' must not execute '||signature;
    end loop;
    assert not exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=signature::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'), 'PUBLIC execute is forbidden';
  end loop;
  foreach table_name in array array['kotonoha.qr_links','kotonoha.qr_files','kotonoha.qr_access_logs'] loop
    assert (select relrowsecurity from pg_class where oid=table_name::regclass), 'RLS remains enabled';
    foreach role_name in array array['anon','authenticated'] loop
      assert not has_table_privilege(role_name,table_name,'SELECT,INSERT,UPDATE,DELETE'), 'client roles cannot directly read/write QR tables';
    end loop;
  end loop;
end $test$;
rollback;
select 'PASS: legacy rows/RPC definitions, list/trash/restore, history/count/unique analytics and store isolation' as result;

-- Exercise real grants rather than only inspecting ACL metadata.
begin;
set local role service_role;
do $test$
declare own uuid := gen_random_uuid(); item uuid := gen_random_uuid(); data jsonb;
begin
  data := public.kotonoha_qr('create',own,item,
    '{"code":"logoGrant001","title":"Service-only","targetUrl":"https://example.com/","logoId":"line-ios"}');
  assert data->>'logo_id'='line-ios';
  assert public.kotonoha_qr('logo',own,item,'{"logoId":null}')->'logo_id'='null'::jsonb;
  assert kotonoha.qr_logo_valid('"line-ios"');
end $test$;
reset role;
set local role anon;
do $test$
begin
  begin
    perform public.kotonoha_qr('list',gen_random_uuid());
    raise exception 'ANON_RPC_ALLOWED';
  exception when insufficient_privilege then null; end;
  begin
    perform logo_id from kotonoha.qr_links;
    raise exception 'ANON_TABLE_ALLOWED';
  exception when insufficient_privilege then null; end;
end $test$;
reset role;
set local role authenticated;
do $test$
begin
  begin
    perform public.kotonoha_qr_file('init',gen_random_uuid(),gen_random_uuid(),'{}');
    raise exception 'AUTHENTICATED_RPC_ALLOWED';
  exception when insufficient_privilege then null; end;
  begin
    perform logo_id from kotonoha.qr_files;
    raise exception 'AUTHENTICATED_TABLE_ALLOWED';
  exception when insufficient_privilege then null; end;
end $test$;
reset role;
rollback;
select 'PASS: service-only grants executed under service_role/anon/authenticated' as result;
