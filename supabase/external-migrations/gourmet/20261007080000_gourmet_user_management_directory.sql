-- Target ONLY ycsqfajidusuibqljjwr. Requires gourmet migration 025.
-- Dynamic view: no copied access state, no extra authorization or mutation endpoint.
create or replace view marugo_directory.memberships with(security_invoker=true) as
select 'gourmet'::text as app_id,u.id::text as user_id,''::text as name,
  case when a.user_id is not null then 'active'
    when v.status='revoked' then 'suspended'
    when v.status='approved' and exists(select 1 from public.gourmet_store_access g where g.user_id=u.id) then 'active'
    else 'pending' end::text as status,
  case when a.user_id is not null then '管理者' else '一般ユーザー（閲覧専用）' end::text as role,
  case when a.user_id is not null then '全店舗：' || coalesce((select string_agg(s.name,' / ' order by s.sort_order,s.name) from public.stores s),'店舗未登録')
    when v.status='approved' then coalesce((select string_agg(s.name,' / ' order by s.sort_order,s.name)
      from public.gourmet_store_access g join public.stores s on s.id=g.store_id where g.user_id=u.id),'閲覧店舗未設定')
    when v.status='revoked' then '閲覧不可（停止中）' else '閲覧不可（承認待ち）' end::text as affiliation,
  u.created_at
from auth.users u left join public.gourmet_admin_users a on a.user_id=u.id
left join public.gourmet_user_access v on v.user_id=u.id
where u.deleted_at is null
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
revoke all on marugo_directory.memberships from public,anon,authenticated;
