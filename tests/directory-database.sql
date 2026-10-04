begin;
do $$ declare r jsonb; first_page jsonb; second_page jsonb; n integer;
begin
r:=public.marugo_directory_page('00000000-0000-4000-8000-000000000001','','','',0);
first_page:=r;
if jsonb_array_length(r->'rows')>100 then raise exception 'PAGE_TOO_BIG'; end if;
select count(*) into n from jsonb_array_elements(r->'rows') x where
exists(select 1 from jsonb_object_keys(x) k where k not in ('key','app_id','user_id','email','name','status','role','affiliation','created_at','last_sign_in_at','email_verified','provider','identity_kind'));
if n>0 then raise exception 'UNEXPECTED_COLUMN'; end if;
r:=public.marugo_directory_page('00000000-0000-4000-8000-000000000001','','nonexistent-directory-test-unique','',0);
if (r->>'total')::int<>0 then raise exception 'SEARCH_NOT_APPLIED'; end if;
second_page:=public.marugo_directory_page('00000000-0000-4000-8000-000000000001','','','',100);
if exists(select 1 from jsonb_array_elements(first_page->'rows') a cross join jsonb_array_elements(second_page->'rows') b where a->>'key'=b->>'key') then raise exception 'PAGE_OVERLAP'; end if;
if has_function_privilege('anon','public.marugo_directory_page(uuid,text,text,text,integer)','execute') or has_function_privilege('authenticated','public.marugo_directory_page(uuid,text,text,text,integer)','execute') then raise exception 'RPC_EXPOSED'; end if;
if has_schema_privilege('anon','marugo_directory','usage') or has_schema_privilege('authenticated','marugo_directory','usage') then raise exception 'SCHEMA_EXPOSED'; end if;
if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='marugo_directory' and c.relkind='r' and not c.relrowsecurity) then raise exception 'MISSING_RLS'; end if;
if exists(select key from marugo_directory.entries group by key having count(*)>1) then raise exception 'DUPLICATE_KEY'; end if;
end $$;
rollback;
select 'passed: columns, pagination, search, unique keys, RPC/schema privileges, RLS; audit rolled back' as verification;
