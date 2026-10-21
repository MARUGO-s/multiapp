-- Local disposable DB only. Seed/snapshot immediately before additive migration.
\if :{?qr_store_name_before}
-- Existing STORE records must be preserved too, not only old SNS/no-logo rows.
do $seed$
declare candidate record; own uuid; item uuid; upload uuid;
begin
 for candidate in select * from public.qr_store_logo_ids loop
  own:=gen_random_uuid(); item:=gen_random_uuid(); upload:=gen_random_uuid();
  perform public.kotonoha_qr('create',own,item,jsonb_build_object('code',substr(md5(item::text),1,12),'title','Legacy STORE '||candidate.id,'targetUrl','https://example.com/legacy-store','logoId',candidate.id));
  perform public.kotonoha_qr_scan_unique(substr(md5(item::text),1,12),gen_random_uuid());
  perform public.kotonoha_qr_file('init',own,upload,jsonb_build_object('title','Legacy STORE file','fileName','menu.pdf','mime','application/pdf','size',100,'logoId',candidate.id));
  if candidate.ordinal%2=0 then
   perform public.kotonoha_qr_file('complete',own,upload,jsonb_build_object('code',substr(md5(upload::text),1,12),'targetUrl','https://example.com/legacy-store-file'));
  end if;
 end loop;
end $seed$;
create table public.qr_store_name_function_snapshot as
 select p.oid, p.oid::regprocedure::text as signature, pg_get_functiondef(p.oid) as definition, p.proacl
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','kotonoha','auth','storage')
 and p.oid not in ('public.kotonoha_qr(text,uuid,uuid,jsonb)'::regprocedure,'public.kotonoha_qr_file(text,uuid,uuid,jsonb)'::regprocedure);
create table public.qr_store_name_rows_snapshot(table_name regclass primary key, rows jsonb);
do $$ declare t regclass; begin
 for t in select c.oid::regclass from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname in ('kotonoha','auth','storage') and c.relkind='r' loop
 execute format('insert into public.qr_store_name_rows_snapshot select %L::regclass, coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),''[]'') from %s r',t,t);
 end loop;
end $$;
\else
-- Fail descriptively against the old chain, before any reference to the new column.
do $$ begin
 assert exists(select 1 from information_schema.columns where table_schema='kotonoha' and table_name='qr_links' and column_name='store_name'), 'shared store_name column is required';
 assert exists(select 1 from information_schema.columns where table_schema='kotonoha' and table_name='qr_files' and column_name='initial_store_name'), 'immutable initial_store_name column is required';
end $$;
do $$ declare saved record; actual jsonb; subtract text[]; begin
 for saved in select * from public.qr_store_name_function_snapshot loop
 assert pg_get_functiondef(saved.oid)=saved.definition, 'unrelated function changed: '||saved.signature;
 assert (select proacl is not distinct from saved.proacl from pg_proc where oid=saved.oid), 'unrelated function ACL changed';
 end loop;
 for saved in select * from public.qr_store_name_rows_snapshot loop
 subtract := case saved.table_name::text when 'kotonoha.qr_links' then array['store_name'] when 'kotonoha.qr_files' then array['initial_store_name'] else array[]::text[] end;
 execute format('select coalesce(jsonb_agg(to_jsonb(r)-%L::text[] order by (to_jsonb(r)-%L::text[])::text),''[]'') from %s r',subtract,subtract,saved.table_name) into actual;
 assert actual=saved.rows, 'migration rewrote legacy rows: '||saved.table_name;
 end loop;
 assert not exists(select 1 from kotonoha.qr_links where store_name is not null);
 assert not exists(select 1 from kotonoha.qr_files where initial_store_name is not null);
end $$;
select 'PASS: legacy fields/history/auth/storage and all unrelated function definitions/ACLs unchanged';

begin;
set local role service_role;
do $test$
declare own uuid := gen_random_uuid(); item uuid := gen_random_uuid(); data jsonb; original jsonb; args jsonb; candidate text; n integer:=0;
begin
 args := jsonb_build_object('code','captionUrl01','title','Keep title','targetUrl','https://example.com/keep?x=1','logoId','store-marugo-d','storeName','　 Custom 😀  ');
 data := public.kotonoha_qr('create',own,item,args);
 assert data->>'store_name'='Custom 😀', 'create must trim and persist custom caption';
 original:=data;
 data:=public.kotonoha_qr('logo',own,item,'{"logoId":"store-marugo-d"}');
 assert data=original, 'old same-logo save preserves caption';
 data:=public.kotonoha_qr('logo',own,item,'{"logoId":"store-marugo-d","storeName":""}');
 assert data->>'store_name'='', 'explicit empty hides';
 assert data-array['logo_id','store_name']=original-array['logo_id','store_name'], 'identity/title/url/counters unchanged';
 assert public.kotonoha_qr('create',own,item,args)=data, 'create retry returns current caption, never resets edited value';
 data:=public.kotonoha_qr('logo',own,item,'{"logoId":"store-marugo-d","storeName":null}');
 assert data->'store_name'='null', 'explicit null restores default';
 perform public.kotonoha_qr('logo',own,item,'{"logoId":"store-marugo-d","storeName":"custom"}');
 data:=public.kotonoha_qr('logo',own,item,'{"logoId":"store-mitan"}');
 assert data->'store_name'='null', 'old changed-logo save resets caption';
 perform public.kotonoha_qr('logo',own,item,'{"logoId":"store-mitan","storeName":"custom"}');
 data:=public.kotonoha_qr('logo',own,item,'{"logoId":"instagram-black"}');
 assert data->'store_name'='null', 'switch to SNS clears caption';
 data:=public.kotonoha_qr('logo',own,item,'{"logoId":null,"storeName":null}');
 assert data->'store_name'='null';
 -- All catalog IDs stay writable; only the 23 STORE IDs admit non-null captions.
 for candidate in select id from public.qr_store_logo_ids union all select unnest(array[
 'instagram-black','instagram-gradient','instagram-white','line-android','line-ios','line-icons8-100','line-icons8-50','instagram-icons8-100','instagram-icons8-50','x-icons8-100','x-icons8-50','facebook-icons8-100','facebook-icons8-48','facebook-icons8-50','facebook-icons8-96']) loop
 n:=n+1;
 data:=public.kotonoha_qr('logo',own,item,jsonb_build_object('logoId',candidate,'storeName',case when candidate like 'store-%' then '店 '||candidate else null end));
 assert data->>'logo_id'=candidate;
 assert data->>'store_name' is not distinct from case when candidate like 'store-%' then '店 '||candidate else null end;
 end loop;
 assert n=38, 'all 38 IDs must be exercised';
 assert public.kotonoha_qr('list',own)->'links' @> jsonb_build_array(data), 'shared list reads saved caption';
 begin perform public.kotonoha_qr('logo',gen_random_uuid(),item,'{"logoId":null}'); raise exception 'foreign owner accepted'; exception when sqlstate 'P0002' then null; end;
 perform public.kotonoha_qr_lifecycle('trash',own,item);
 begin perform public.kotonoha_qr('logo',own,item,'{"logoId":null}'); raise exception 'trashed accepted'; exception when others then if sqlerrm<>'TRASHED' then raise; end if; end;
 perform public.kotonoha_qr_lifecycle('restore',own,item);
end $test$;
select 'PASS: shared custom/default/hidden, old-client omission, current-row replay and all 38 IDs';
rollback;

begin;
set local role service_role;
do $files$
declare candidate text; own uuid; item uuid; args jsonb; data jsonb; original jsonb; frozen jsonb; n integer:=0;
begin
 for candidate in select id from public.qr_store_logo_ids loop
 own:=gen_random_uuid(); item:=gen_random_uuid(); n:=n+1;
 args:=jsonb_build_object('title','Frozen file','fileName','menu.pdf','size',100,'mime','application/pdf','logoId',candidate,'storeName','　 Original 😀 ');
 frozen:=public.kotonoha_qr_file('init',own,item,args);
 assert frozen->>'initial_store_name'='Original 😀', 'init must freeze normalized caption';
 assert public.kotonoha_qr_file('init',own,item,args)=frozen, 'same init retry must be stable';
 begin
 perform public.kotonoha_qr_file('init',own,item,args||'{"storeName":"Changed"}');
 raise exception 'changed init accepted';
 exception when others then if sqlerrm<>'REQUEST_CONFLICT' then raise; end if; end;
 data:=public.kotonoha_qr_file('complete',own,item,jsonb_build_object('code',substr(md5(item::text),1,12),'targetUrl','https://example.com/file','storeName','Forged completion caption','logoId','instagram-black'));
 assert data->>'store_name'='Original 😀' and data->>'logo_id'=candidate, 'complete copies frozen init, never request metadata';
 original:=data;
 data:=public.kotonoha_qr('logo',own,item,jsonb_build_object('logoId',candidate,'storeName',''));
 assert data->>'store_name'='';
 assert public.kotonoha_qr_file('complete',own,item,'{}')=data, 'completion retry preserves hidden caption';
 assert public.kotonoha_qr_file('init',own,item,args)->'link'=data, 'init retry returns edited current link';
 data:=public.kotonoha_qr('logo',own,item,'{"logoId":"store-mitan","storeName":"Later name"}');
 assert public.kotonoha_qr_file('complete',own,item,'{}')=data;
 assert public.kotonoha_qr_file('init',own,item,args)->'link'=data;
 assert data-array['logo_id','store_name']=original-array['logo_id','store_name'];
 assert (public.kotonoha_qr_file('get',own,item)-array['state','link_id'])=(frozen-array['state','link_id']), 'later edits/retries never alter frozen metadata';
 end loop;
 assert n=23;
 -- Pre-feature pending uploads remain valid and complete with a NULL override.
 data:=public.kotonoha_qr_file('complete','00000000-0000-4000-8000-000000000072','00000000-0000-4000-8000-000000000074','{"code":"legacyCap001","targetUrl":"https://example.com/legacy"}');
 assert data->'store_name'='null';
end $files$;
select 'PASS: all 23 file snapshots, immutable init conflict, frozen completion/current-row replay and legacy pending';
rollback;
\endif
