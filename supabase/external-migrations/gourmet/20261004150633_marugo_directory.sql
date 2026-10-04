-- Additive, read-only directory. Never run against another project implicitly.
create schema if not exists marugo_directory;
revoke all on schema marugo_directory from public, anon, authenticated;
create table marugo_directory.read_audit (
 id bigint generated always as identity primary key,
 actor_id uuid not null,
 action text not null check (action in ('users')),
 app_filter text not null,
 returned_count integer not null check(returned_count between 0 and 100),
 created_at timestamptz not null default now()
);
alter table marugo_directory.read_audit enable row level security;
revoke all on marugo_directory.read_audit from public, anon, authenticated;
create index on marugo_directory.read_audit(actor_id,created_at);
create view marugo_directory.memberships with(security_invoker=true) as
select 'gourmet'::text as app_id,s.user_id::text as user_id,''::text as name,'registered'::text as status,
'店舗データ所有者'::text as role,string_agg(distinct s.name,' / ' order by s.name) as affiliation,min(s.created_at) as created_at
from public.stores s group by s.user_id
union all
select 'sns',p.user_id::text,'','registered',
case when exists(select 1 from public.social_admin_users a where a.user_id=p.user_id) then 'SNS管理者'
else coalesce((select string_agg(distinct m.role,', ') from public.social_workspace_members m where m.user_id=p.user_id),'未所属') end,
coalesce(s.name,''),p.created_at
from public.social_user_profiles p left join public.social_stores s on s.id=p.store_id
union all
select 'sns',m.user_id::text,'','registered',string_agg(distinct m.role,', '),
string_agg(distinct w.name,' / '),min(m.created_at)
from public.social_workspace_members m join public.social_workspaces w on w.id=m.workspace_id
where not exists(select 1 from public.social_user_profiles p where p.user_id=m.user_id) group by m.user_id;
create view marugo_directory.external_entries with(security_invoker=true) as
select ''::text as key,''::text as app_id,''::text as user_id,null::text as email,''::text as name,
''::text as status,''::text as role,''::text as affiliation,now() as created_at,null::timestamptz as last_sign_in_at,
false as email_verified,''::text as provider,''::text as identity_kind where false;
create view marugo_directory.entries with (security_invoker=true) as
select coalesce(m.app_id,'unassigned') || ':' || u.id::text as key,
 coalesce(m.app_id,'unassigned') as app_id, u.id::text as user_id,
 u.email, coalesce(m.name,'') as name,
 case when u.banned_until > now() then 'suspended' else coalesce(m.status,'unlinked') end as status,
 coalesce(m.role,'') as role, coalesce(m.affiliation,'') as affiliation,
 coalesce(m.created_at,u.created_at) as created_at, u.last_sign_in_at,
 u.email_confirmed_at is not null as email_verified,
 coalesce((select string_agg(distinct i.provider,', ' order by i.provider) from auth.identities i where i.user_id=u.id),'') as provider,
 'supabase'::text as identity_kind
from auth.users u left join marugo_directory.memberships m on m.user_id=u.id::text
where u.deleted_at is null
union all select * from marugo_directory.external_entries;
revoke all on all tables in schema marugo_directory from public,anon,authenticated;
create function public.marugo_directory_page(p_actor uuid,p_app text default '',p_search text default '',p_status text default '',p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; row_count integer; total_count integer;
begin
 if p_actor is null or p_offset is null or p_offset<0 or p_offset>50000 or
 p_app is null or length(p_app)>40 or p_search is null or length(p_search)>160 or
 p_status is null or length(p_status)>30 then raise exception 'INVALID_INPUT'; end if;
 if (select count(*) from marugo_directory.read_audit where actor_id=p_actor and created_at>now()-interval '1 minute')>=120 then
 raise exception 'RATE_LIMIT'; end if;
 -- Fixed column allowlist; never serialize auth.users or credential tables wholesale.
 with filtered as (
 select * from marugo_directory.entries e where
 (p_app='' or e.app_id=p_app) and (p_status='' or e.status=p_status) and
 (p_search='' or position(lower(p_search) in lower(coalesce(e.email,'')||' '||e.name||' '||e.affiliation||' '||e.user_id))>0)
 ), page as (select * from filtered order by app_id,key limit 100 offset p_offset)
 select coalesce((select jsonb_agg(to_jsonb(p) order by p.app_id,p.key) from page p),'[]'::jsonb),
 (select count(*) from page),(select count(*) from filtered) into result,row_count,total_count;
 insert into marugo_directory.read_audit(actor_id,action,app_filter,returned_count)
 values(p_actor,'users',p_app,row_count);
 return jsonb_build_object('rows',result,'total',total_count,'nextOffset',
 case when p_offset+row_count<total_count and row_count>0 then p_offset+row_count else null end,'asOf',now());
end $$;
revoke all on function public.marugo_directory_page(uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.marugo_directory_page(uuid,text,text,text,integer) to service_role;
