-- Disposable PostgreSQL only. The harness runs setup BEFORE the store migration,
-- then runs the other branch AFTER it; all behavioral fixtures are rolled back.
\if :{?qr_store_logo_before}
create table public.qr_store_logo_ids (id text primary key, ordinal integer unique not null);
insert into public.qr_store_logo_ids values
  ('store-marugo-d',1),('store-marugo-es',2),('store-371bar',3),
  ('store-blu-nero',4),('store-briccola',5),('store-cava',6),
  ('store-claudia2',7),('store-donaiya',8),('store-erics',9),
  ('store-koruri',10),('store-marugo-1',11),('store-marugo-2',12),
  ('store-marugo-grande',13),('store-marugo-marunouchi',14),
  ('store-marugo-otto',15),('store-marugo-shinbashi',16),
  ('store-marugo-yotsuya',17),('store-mitan',18),('store-pelota',19),
  ('store-sobaju',20),('store-violet',21),('store-x-c',22),('store-yakiniku',23);
grant select on public.qr_store_logo_ids to service_role;

-- Unrelated local stand-ins make Storage policy/table and other-app preservation
-- a non-vacuous catalog/data assertion, without loading platform configuration.
create table storage.objects (id uuid primary key, bucket_id text not null, name text not null);
alter table storage.objects enable row level security;
create policy unrelated_storage_read on storage.objects for select to authenticated
  using (bucket_id='unrelated-app');
grant select on storage.objects to authenticated;
insert into storage.objects values(gen_random_uuid(),'unrelated-app','keep.pdf');
create table public.unrelated_app_fixture (id integer primary key, value jsonb not null);
insert into public.unrelated_app_fixture values(1,'{"unchanged":"other app"}');

-- Preserve genuinely pre-extension SNS selections (links and pending/ready files)
-- in addition to the pre-logo legacy rows installed by the existing harness.
do $setup$
declare
  own uuid := gen_random_uuid(); item uuid; upload uuid; candidate text; n integer := 0;
begin
  foreach candidate in array array[
    'instagram-black','instagram-gradient','instagram-white','line-android','line-ios',
    'line-icons8-100','line-icons8-50','instagram-icons8-100','instagram-icons8-50',
    'x-icons8-100','x-icons8-50','facebook-icons8-100','facebook-icons8-48','facebook-icons8-50','facebook-icons8-96'
  ] loop
    n := n+1; item := gen_random_uuid(); upload := gen_random_uuid();
    perform public.kotonoha_qr('create',own,item,jsonb_build_object(
      'code',substr(md5(item::text),1,12),'title','Existing SNS '||candidate,
      'targetUrl','https://example.com/old?logo='||candidate,'logoId',candidate));
    perform public.kotonoha_qr_scan_unique(substr(md5(item::text),1,12),gen_random_uuid(),
      'qr',null,'mobile','safari','local-store-fixture',repeat('e',64));
    perform public.kotonoha_qr_file('init',own,upload,jsonb_build_object(
      'title','Existing SNS file '||candidate,'fileName','old.pdf',
      'mime','application/pdf','size',100,'logoId',candidate));
    if n%2=0 then
      perform public.kotonoha_qr_file('complete',own,upload,jsonb_build_object(
        'code',substr(md5(upload::text),1,12),
        'targetUrl','https://example.com/old-file?logo='||candidate));
    end if;
  end loop;
  insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
    select '00000000-0000-4000-8000-000000000081','store-logo-member@example.invalid',now(),
      jsonb_build_object('marugo_qr_store_id',id)
    from kotonoha.qr_stores where name='マルゴ四谷';
  update kotonoha.qr_members set status='active'
    where user_id='00000000-0000-4000-8000-000000000081';
  insert into kotonoha.sessions(token_hash,expires_at) values(repeat('d',64),now()+interval '1 hour');
end $setup$;

-- Snapshot catalog rows, not SQL text guesses. Only the validator's implementation
-- may change; its OID, signature, language, volatility, config, owner and ACL may not.
-- Ignore test-only public fixtures; compare every app/Auth/Storage relation/column,
-- constraint, index, trigger, policy, schema ACL and all other function definitions.
create view public.qr_store_logo_catalog_state as
select 'function'::text as kind,p.oid::regprocedure::text as identity,
  jsonb_build_object('metadata',case when p.oid='kotonoha.qr_logo_valid(jsonb)'::regprocedure
    then to_jsonb(p)-'prosrc'-'prosqlbody' else to_jsonb(p) end,
    'definition',case when p.oid='kotonoha.qr_logo_valid(jsonb)'::regprocedure
    then null else pg_get_functiondef(p.oid) end) as state
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','kotonoha','auth','storage')
union all
select 'relation',c.oid::regclass::text,to_jsonb(c)
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname in ('public','kotonoha','auth','storage') and c.relname not like 'qr_store_logo_%'
union all
select 'column',a.attrelid::regclass::text||':'||a.attnum,to_jsonb(a)
from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname in ('public','kotonoha','auth','storage') and c.relname not like 'qr_store_logo_%'
union all
select 'constraint',c.oid::text,to_jsonb(c)||jsonb_build_object('definition',pg_get_constraintdef(c.oid))
from pg_constraint c join pg_namespace n on n.oid=c.connamespace
where n.nspname in ('public','kotonoha','auth','storage')
  and c.conname not like 'qr_store_logo_%'
union all
select 'index',i.indexrelid::regclass::text,to_jsonb(i)||jsonb_build_object('definition',pg_get_indexdef(i.indexrelid))
from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname in ('public','kotonoha','auth','storage') and c.relname not like 'qr_store_logo_%'
union all
select 'trigger',t.oid::text,to_jsonb(t)||jsonb_build_object('definition',pg_get_triggerdef(t.oid))
from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname in ('public','kotonoha','auth','storage')
union all
select 'policy',p.oid::text,to_jsonb(p)
from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname in ('public','kotonoha','auth','storage')
union all
select 'schema',n.nspname,to_jsonb(n) from pg_namespace n
where n.nspname in ('public','kotonoha','auth','storage')
union all
select 'default_acl',a.oid::text,to_jsonb(a) from pg_default_acl a
union all
select 'role_membership',m.oid::text,to_jsonb(m) from pg_auth_members m;
create table public.qr_store_logo_catalog_snapshot as select * from public.qr_store_logo_catalog_state;
create table public.qr_store_logo_validator_snapshot as
  select pg_get_functiondef('kotonoha.qr_logo_valid(jsonb)'::regprocedure) as definition;
create table public.qr_store_logo_rows_snapshot (table_name regclass primary key, rows jsonb not null);
do $snapshot$
declare target regclass;
begin
  for target in select c.oid::regclass from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','kotonoha','auth','storage') and c.relkind in ('r','p')
      and c.relname not like 'qr_store_logo_%'
  loop
    execute format('insert into public.qr_store_logo_rows_snapshot select %L::regclass, '
      ||'coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from %s t',target,target);
  end loop;
end $snapshot$;
select 'STORE_CATALOG_BEFORE '||jsonb_object_agg(kind,digest order by kind)::text
from (select kind,md5(string_agg(identity||state::text,'' order by identity)) as digest
  from public.qr_store_logo_catalog_state group by kind) s;
select 'VALIDATOR_IMPLEMENTATION_BEFORE '||md5(definition) from public.qr_store_logo_validator_snapshot;
select 'PASS: seeded all 15 existing SNS IDs and legacy/pending/ready/history fixtures before extension';
\else

-- Run this first: no behavior test may obscure a migration rewriting old rows.
do $unchanged$
declare saved record; actual jsonb;
begin
  assert (select count(*) from public.qr_store_logo_ids)=23;
  assert not exists(
    (select * from public.qr_store_logo_catalog_snapshot except select * from public.qr_store_logo_catalog_state)
    union all
    (select * from public.qr_store_logo_catalog_state except select * from public.qr_store_logo_catalog_snapshot)
  ), 'migration changed RPC definitions, ACLs, columns, RLS, policies, triggers or other catalog metadata';
  for saved in select * from public.qr_store_logo_rows_snapshot loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from %s t',saved.table_name) into actual;
    assert actual=saved.rows, 'migration rewrote existing fields/rows in '||saved.table_name;
  end loop;
  assert (select provolatile='i' and not prosecdef and proconfig=array['search_path=""']
    from pg_proc where oid='kotonoha.qr_logo_valid(jsonb)'::regprocedure), 'validator contract must remain immutable/invoker/empty search_path';
end $unchanged$;
select 'STORE_CATALOG_AFTER '||jsonb_object_agg(kind,digest order by kind)::text
from (select kind,md5(string_agg(identity||state::text,'' order by identity)) as digest
  from public.qr_store_logo_catalog_state group by kind) s;
select 'VALIDATOR_IMPLEMENTATION_AFTER '||md5(pg_get_functiondef('kotonoha.qr_logo_valid(jsonb)'::regprocedure));
select 'PASS: real before/after catalog and all existing data fields are identical outside validator implementation';

-- Exercise actual service-role RPC calls for every exact source ID, rather than
-- granting a test helper the authority or directly inserting the desired result.
begin;
set local role service_role;
do $all_stores$
declare
  own uuid; shared_own uuid; other_store uuid := gen_random_uuid(); candidate text;
  next_logo text; item uuid; upload uuid; event uuid; total integer := 0;
  args jsonb; file_args jsonb; completion jsonb; original jsonb; changed jsonb;
  frozen jsonb; ready jsonb; history jsonb; analytics jsonb; listing jsonb;
begin
  assert current_user='service_role';
  own := (public.marugo_qr_accounts('scope','00000000-0000-4000-8000-000000000081')->>'workspaceId')::uuid;
  shared_own := (public.marugo_qr_shared('scope',repeat('d',64),own)->>'workspaceId')::uuid;
  assert shared_own=own, 'native and shared sessions must resolve the same existing store';
  begin
    perform public.marugo_qr_accounts('scope','00000000-0000-4000-8000-000000000081',other_store);
    raise exception 'FOREIGN_STORE_SCOPE_ALLOWED';
  exception when others then if sqlerrm<>'STORE_FORBIDDEN' then raise; end if; end;
  begin
    perform public.marugo_qr_shared('scope',repeat('d',64),other_store);
    raise exception 'INVALID_SHARED_STORE_ALLOWED';
  exception when others then if sqlerrm<>'STORE_FORBIDDEN' then raise; end if; end;
  for candidate in select id from public.qr_store_logo_ids order by ordinal loop
    assert kotonoha.qr_logo_valid(to_jsonb(candidate)), 'store catalog ID rejected: '||candidate;
    total := total+1; item := gen_random_uuid(); upload := gen_random_uuid(); event := gen_random_uuid();
    select id into strict next_logo from public.qr_store_logo_ids where ordinal=total%23+1;
    args := jsonb_build_object('code',substr(md5(item::text),1,12),'title','店舗 QR '||candidate,
      'targetUrl','https://example.com/store?logo='||candidate,'logoId',candidate);
    original := public.kotonoha_qr('create',own,item,args);
    assert original->>'logo_id'=candidate and original->>'id'=item::text and original->>'owner_id'=own::text;
    assert public.kotonoha_qr('create',own,item,args||'{"code":"retryCode001"}')=original, 'URL replay changed original fields';
    perform public.kotonoha_qr_scan_unique(args->>'code',event,'qr',null,'mobile','safari','local-store-test',repeat('a',64));
    perform public.kotonoha_qr_scan(args->>'code',event,'button');
    history := public.kotonoha_qr_history(own,item);
    analytics := public.kotonoha_qr_analytics(own,item,7,'all');
    assert history->>'total'='1' and analytics->>'periodTotal'='1' and analytics->>'periodUnique'='1';
    original := public.kotonoha_qr('create',own,item,args);
    changed := public.kotonoha_qr('logo',shared_own,item,jsonb_build_object('logoId',next_logo));
    assert changed->>'logo_id'=next_logo and changed-'logo_id'=original-'logo_id', 'shared logo edit changed other link fields';
    listing := public.kotonoha_qr('list',own);
    assert exists(select 1 from jsonb_array_elements(listing->'links') l where l=changed), 'native reader cannot see shared edit';
    assert public.kotonoha_qr('create',own,item,args)=changed, 'URL replay restored initial logo';
    changed := public.kotonoha_qr('logo',shared_own,item,'{"logoId":null}');
    assert changed->'logo_id'='null'::jsonb and changed-'logo_id'=original-'logo_id';
    assert public.kotonoha_qr('create',own,item,args)=changed, 'URL replay restored removed logo';
    assert public.kotonoha_qr('create',own,item,args-'logoId')=changed, 'legacy replay restored removed logo';
    assert public.kotonoha_qr_history(own,item)=history and public.kotonoha_qr_analytics(own,item,7,'all')=analytics;
    begin
      perform public.kotonoha_qr('logo',other_store,item,jsonb_build_object('logoId',candidate));
      raise exception 'FOREIGN_OWNER_PATCH_ALLOWED';
    exception when no_data_found then null; end;
    begin
      perform public.kotonoha_qr('create',other_store,item,args);
      raise exception 'FOREIGN_OWNER_CREATE_REPLAY_ALLOWED';
    exception when no_data_found then null; end;
    begin
      perform public.kotonoha_qr('logo',null,item,jsonb_build_object('logoId',candidate));
      raise exception 'NULL_OWNER_ALLOWED';
    exception when others then if sqlerrm<>'OWNER_REQUIRED' then raise; end if; end;
    assert public.kotonoha_qr('create',own,item,args)=changed;

    file_args := jsonb_build_object('title','店舗 file '||candidate,'fileName','menu.pdf',
      'mime','application/pdf','size',100,'logoId',candidate);
    frozen := public.kotonoha_qr_file('init',own,upload,file_args);
    assert frozen->>'logo_id'=candidate and frozen->>'id'=upload::text and frozen->>'owner_id'=own::text;
    assert public.kotonoha_qr_file('init',own,upload,file_args)=frozen;
    begin
      perform public.kotonoha_qr_file('init',own,upload,file_args||jsonb_build_object('logoId',next_logo));
      raise exception 'CHANGED_FROZEN_LOGO_ALLOWED';
    exception when others then if sqlerrm<>'REQUEST_CONFLICT' then raise; end if; end;
    begin
      perform public.kotonoha_qr_file('init',own,upload,file_args-'logoId');
      raise exception 'OMITTED_FROZEN_LOGO_ALLOWED';
    exception when others then if sqlerrm<>'REQUEST_CONFLICT' then raise; end if; end;
    completion := jsonb_build_object('code',substr(md5(upload::text),1,12),
      'targetUrl','https://example.com/file?logo='||candidate,'logoId','unknownLogo');
    original := public.kotonoha_qr_file('complete',own,upload,completion);
    assert original->>'logo_id'=candidate, 'first completion must copy frozen logo, not mutable completion input';
    ready := public.kotonoha_qr_file('get',own,upload);
    assert ready->>'state'='ready' and ready->>'link_id'=upload::text;
    assert ready-'state'-'link_id'=frozen-'state'-'link_id', 'completion changed frozen attempt fields';
    assert public.kotonoha_qr_file('complete',own,upload,'{}')=original;
    perform public.kotonoha_qr_scan_unique(completion->>'code',gen_random_uuid());
    history := public.kotonoha_qr_history(own,upload);
    analytics := public.kotonoha_qr_analytics(own,upload,7,'all');
    original := public.kotonoha_qr_file('complete',own,upload,'{}');
    changed := public.kotonoha_qr('logo',shared_own,upload,jsonb_build_object('logoId',next_logo));
    assert changed->>'logo_id'=next_logo and changed-'logo_id'=original-'logo_id';
    assert public.kotonoha_qr_file('complete',own,upload,completion)=changed;
    assert public.kotonoha_qr_file('init',own,upload,file_args)->'link'=changed;
    changed := public.kotonoha_qr('logo',shared_own,upload,'{"logoId":null}');
    assert changed->'logo_id'='null'::jsonb and changed-'logo_id'=original-'logo_id';
    assert public.kotonoha_qr_file('complete',own,upload,'{}')=changed, 'file completion replay restored removed logo';
    assert public.kotonoha_qr_file('init',own,upload,file_args)->'link'=changed, 'file init replay restored removed logo';
    assert public.kotonoha_qr_file('get',own,upload)=ready, 'artwork edits changed frozen file fields';
    assert public.kotonoha_qr_history(own,upload)=history and public.kotonoha_qr_analytics(own,upload,7,'all')=analytics;
    assert public.kotonoha_qr_file('get',other_store,upload) is null;
    assert public.kotonoha_qr_file('complete',other_store,upload,'{}') is null;
    begin
      perform public.kotonoha_qr_file('init',other_store,upload,file_args);
      raise exception 'FOREIGN_OWNER_FILE_REPLAY_ALLOWED';
    exception when others then if sqlerrm<>'REQUEST_CONFLICT' then raise; end if; end;
    assert public.kotonoha_qr_file('get',own,upload)=ready;
  end loop;
  assert total=23, 'all exact store IDs must be exercised';
end $all_stores$;
reset role;
rollback;
select 'PASS: service_role all 23 URL/file create, shared edit/removal, exact retries, immutable fields/history and store/owner rejection';

begin;
do $validation$
declare
  own uuid := gen_random_uuid(); item uuid := gen_random_uuid(); upload uuid := gen_random_uuid();
  candidate text; invalid jsonb; data jsonb; frozen jsonb;
  args jsonb := '{"code":"storeNull001","title":"Legacy null","targetUrl":"https://example.com/null"}';
  file_args jsonb := '{"title":"Legacy file","fileName":"menu.pdf","mime":"application/pdf","size":100}';
begin
  assert kotonoha.qr_logo_valid(null::jsonb) and kotonoha.qr_logo_valid('null'::jsonb);
  foreach candidate in array array[
    'instagram-black','instagram-gradient','instagram-white','line-android','line-ios',
    'line-icons8-100','line-icons8-50','instagram-icons8-100','instagram-icons8-50',
    'x-icons8-100','x-icons8-50','facebook-icons8-100','facebook-icons8-48','facebook-icons8-50','facebook-icons8-96'
  ] loop
    assert kotonoha.qr_logo_valid(to_jsonb(candidate)), 'existing SNS ID rejected: '||candidate;
  end loop;
  data := public.kotonoha_qr('create',own,item,args);
  assert data->'logo_id'='null'::jsonb;
  assert public.kotonoha_qr('create',own,item,args||'{"logoId":null}')=data;
  frozen := public.kotonoha_qr_file('init',own,upload,file_args);
  assert frozen->'logo_id'='null'::jsonb;
  assert public.kotonoha_qr_file('init',own,upload,file_args||'{"logoId":null}')=frozen;
  for invalid in select value from jsonb_array_elements(
    '["unknownLogo","","STORE-MARUGO-D","store-marugo-d ","../store-marugo-d","https://example.com/logo.png",1,true,[],{},["logoId"]]'::jsonb)
  loop
    assert kotonoha.qr_logo_valid(invalid) is false, 'invalid validator value accepted: '||invalid;
    begin
      perform public.kotonoha_qr('create',own,gen_random_uuid(),args||jsonb_build_object('logoId',invalid));
      raise exception 'INVALID_CREATE_ALLOWED';
    exception when others then if sqlerrm<>'INVALID_LOGO' then raise; end if; end;
    begin
      perform public.kotonoha_qr('logo',own,item,jsonb_build_object('logoId',invalid));
      raise exception 'INVALID_PATCH_ALLOWED';
    exception when others then if sqlerrm<>'INVALID_LOGO' then raise; end if; end;
    begin
      perform public.kotonoha_qr_file('init',own,gen_random_uuid(),file_args||jsonb_build_object('logoId',invalid));
      raise exception 'INVALID_FILE_INIT_ALLOWED';
    exception when others then if sqlerrm<>'INVALID_LOGO' then raise; end if; end;
    if jsonb_typeof(invalid)='string' then
      begin
        update kotonoha.qr_links set logo_id=invalid#>>'{}' where id=item;
        raise exception 'INVALID_LINK_CHECK_ALLOWED';
      exception when check_violation then null; end;
      begin
        update kotonoha.qr_files set logo_id=invalid#>>'{}' where id=upload;
        raise exception 'INVALID_FILE_CHECK_ALLOWED';
      exception when check_violation then null; end;
    end if;
  end loop;
  for invalid in select value from jsonb_array_elements('[{},null,"logoId",["logoId"]]'::jsonb) loop
    begin
      perform public.kotonoha_qr('logo',own,item,invalid);
      raise exception 'NON_OBJECT_OR_MISSING_PATCH_ALLOWED';
    exception when others then if sqlerrm<>'INVALID_LOGO' then raise; end if; end;
  end loop;
  assert public.kotonoha_qr('create',own,item,args)=data, 'rejected requests changed link fields';
  assert public.kotonoha_qr_file('get',own,upload)=frozen, 'rejected requests changed file fields';
  assert public.kotonoha_qr('logo',own,item,'{"logoId":null}')=data;
end $validation$;
rollback;
select 'PASS: SNS15, omitted/null compatibility, unknown/empty/number/array/object rejection in RPCs and table CHECKs';

-- Switch actual execution roles, and require permission errors (not business-rule
-- errors) for every privileged route. No credentials or real Supabase are used.
begin;
do $denied$
declare role_name text; statement text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    execute format('set local role %I',role_name);
    assert current_user=role_name;
    foreach statement in array array[
      'select kotonoha.qr_logo_valid(''"store-marugo-d"''::jsonb)',
      'select public.kotonoha_qr(''create'',gen_random_uuid(),gen_random_uuid(),''{}'')',
      'select public.kotonoha_qr(''logo'',gen_random_uuid(),gen_random_uuid(),''{"logoId":null}'')',
      'select public.kotonoha_qr_file(''init'',gen_random_uuid(),gen_random_uuid(),''{}'')',
      'select public.kotonoha_qr_file(''complete'',gen_random_uuid(),gen_random_uuid(),''{}'')',
      'select public.marugo_qr_accounts(''scope'',gen_random_uuid())',
      'select public.marugo_qr_shared(''scope'',repeat(''d'',64),gen_random_uuid())',
      'select * from kotonoha.qr_links',
      'select * from kotonoha.qr_files',
      'select * from kotonoha.qr_access_logs',
      'update kotonoha.qr_links set logo_id=null',
      'update kotonoha.qr_files set logo_id=null'
    ] loop
      begin
        execute statement;
        raise exception 'CLIENT_ROLE_OPERATION_ALLOWED: % %',role_name,statement;
      exception when insufficient_privilege then null; end;
    end loop;
    reset role;
  end loop;
end $denied$;
rollback;
select 'PASS: anon/authenticated real-role execute and direct table access denied';
\endif
