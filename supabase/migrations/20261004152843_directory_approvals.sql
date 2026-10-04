-- Targeted approval bridge; existing app data and authentication rules stay in place.
create table marugo_directory.change_audit (
 id bigint generated always as identity primary key,
 actor_id uuid not null, request_id uuid not null, request_hash text not null,
 target_key text not null, action text not null check(action in ('approve','suspend')),
 reason text not null check(length(reason) between 1 and 500),
 before_data jsonb not null, after_data jsonb not null,
 created_at timestamptz not null default now(), unique(actor_id,request_id)
);
alter table marugo_directory.change_audit enable row level security;
revoke all on marugo_directory.change_audit from public,anon,authenticated;
create index on marugo_directory.change_audit(actor_id,created_at);
alter table marugo_directory.admins add column can_manage_access boolean not null default false;
create function public.marugo_directory_manage_authorized(p_actor uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select public.marugo_directory_authorized(p_actor) and
 exists(select 1 from marugo_directory.admins where user_id=p_actor and enabled and can_manage_access);
$$;
revoke all on function public.marugo_directory_manage_authorized(uuid) from public,anon,authenticated;
grant execute on function public.marugo_directory_manage_authorized(uuid) to service_role;
create function marugo_directory.access_control(p_actor uuid,p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare app text:=split_part(p_key,':',1); target uuid; snapshot jsonb; actions jsonb:='[]'; blocked text:='';
 member_role text; member_status text; eligible boolean; proper_scope boolean;
begin
 if app not in ('kotonoha','qr') then return null; end if;
 begin target:=split_part(p_key,':',2)::uuid; exception when invalid_text_representation then return null; end;
 if p_key<>app||':'||target::text then return null; end if;
 if app='kotonoha' then
  select to_jsonb(m)||jsonb_build_object('eligible',u.email_confirmed_at is not null and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now()) and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google'),
   'proper_scope',exists(select 1 from kotonoha.access_config c where c.singleton and c.workspace_id=m.workspace_id))
   into snapshot from kotonoha.google_members m join auth.users u on u.id=m.user_id where m.user_id=target;
 else
  select to_jsonb(m)||jsonb_build_object('eligible',u.email_confirmed_at is not null and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now()),
   'proper_scope',exists(select 1 from kotonoha.qr_stores s where s.id=m.store_id and s.active and not s.legacy))
   into snapshot from kotonoha.qr_members m join auth.users u on u.id=m.user_id where m.user_id=target;
 end if;
 if snapshot is null then return null; end if;
 member_role:=snapshot->>'role'; member_status:=snapshot->>'status';
 eligible:=(snapshot->>'eligible')::boolean; proper_scope:=(snapshot->>'proper_scope')::boolean;
 if target=p_actor or member_role='admin' or exists(select 1 from marugo_directory.admins where user_id=target and enabled) then
  blocked:='管理者・操作本人は、この画面から変更できません。';
 else
  if member_status in ('pending','suspended') and eligible and proper_scope then actions:=actions||'"approve"'::jsonb; end if;
  if member_status in ('active','pending') then actions:=actions||'"suspend"'::jsonb; end if;
  if not eligible then blocked:='メール確認・Google連携・アカウント状態を確認してください。'; end if;
  if not proper_scope then blocked:='所属店舗またはチームを既存アプリで確認してください。'; end if;
 end if;
 return jsonb_build_object('version',md5(snapshot::text),'actions',actions,'reason',blocked,
 'status',member_status,'scope',case app when 'kotonoha' then 'Google連携だけ。共通IDの利用は停止しません。' else 'この店舗のQR管理権限だけを変更します。公開QRは削除しません。' end,
 'snapshot',snapshot);
end $$;
revoke all on function marugo_directory.access_control(uuid,text) from public,anon,authenticated,service_role;
-- Decorate the existing safe directory rows without expanding its column allowlist.
alter function public.marugo_directory_page(uuid,text,text,text,integer) set schema marugo_directory;
revoke all on function marugo_directory.marugo_directory_page(uuid,text,text,text,integer) from public,anon,authenticated,service_role;
create function public.marugo_directory_page(p_actor uuid,p_app text default '',p_search text default '',p_status text default '',p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; rows jsonb;
begin
 result:=marugo_directory.marugo_directory_page(p_actor,p_app,p_search,p_status,p_offset);
 select coalesce(jsonb_agg(r||jsonb_build_object('control',marugo_directory.access_control(p_actor,r->>'key')-'snapshot') order by ord),'[]') into rows
 from jsonb_array_elements(result->'rows') with ordinality x(r,ord);
 return jsonb_set(result,'{rows}',rows);
end $$;
revoke all on function public.marugo_directory_page(uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.marugo_directory_page(uuid,text,text,text,integer) to service_role;

create function public.marugo_directory_history(p_actor uuid,p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;
begin
 if p_actor is null or p_offset is null or p_offset<0 or p_offset>50000 then raise exception 'INVALID_INPUT'; end if;
 if not public.marugo_directory_authorized(p_actor) then raise exception 'ADMIN_REQUIRED'; end if;
 select coalesce(jsonb_agg(to_jsonb(a) order by a.id desc),'[]') into rows from
 (select id,actor_id,target_key,action,reason,created_at,before_data->>'status' as before_status,after_data->>'status' as after_status
 from marugo_directory.change_audit order by id desc limit 50 offset p_offset) a;
 return jsonb_build_object('rows',rows,'nextOffset',case when jsonb_array_length(rows)=50 then p_offset+50 else null end);
end $$;
revoke all on function public.marugo_directory_history(uuid,integer) from public,anon,authenticated;
grant execute on function public.marugo_directory_history(uuid,integer) to service_role;
create function public.marugo_directory_change(p_actor uuid,p_request uuid,p_key text,p_action text,p_version text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare before_control jsonb; after_control jsonb; previous marugo_directory.change_audit%rowtype;
 request_hash text; app text:=split_part(p_key,':',1); target uuid;
begin
 if p_actor is null or p_request is null or p_key is null or length(p_key)>100 or
 p_action is null or p_action not in ('approve','suspend') or p_version is null or p_version!~'^[0-9a-f]{32}$' or
 p_reason is null or length(btrim(p_reason)) not between 1 and 500 then raise exception 'INVALID_INPUT'; end if;
 if not public.marugo_directory_manage_authorized(p_actor) then raise exception 'ADMIN_REQUIRED'; end if;
 request_hash:=md5(jsonb_build_array(p_key,p_action,p_version,btrim(p_reason))::text);
 perform pg_advisory_xact_lock(hashtextextended('directory-request:'||p_actor::text||':'||p_request::text,9021));
 select * into previous from marugo_directory.change_audit where actor_id=p_actor and request_id=p_request;
 if found then
  if previous.request_hash<>request_hash then raise exception 'REQUEST_CONFLICT'; end if;
  return jsonb_build_object('ok',true,'replayed',true,'key',previous.target_key,'status',previous.after_data->>'status','requestId',p_request);
 end if;
 if (select count(*) from marugo_directory.change_audit where actor_id=p_actor and created_at>now()-interval '1 minute')>=60 then raise exception 'RATE_LIMIT'; end if;

 if not public.marugo_directory_manage_authorized(p_actor) then raise exception 'ADMIN_REQUIRED'; end if;
 if app not in ('kotonoha','qr') then raise exception 'UNSUPPORTED_APP'; end if;
 begin target:=split_part(p_key,':',2)::uuid; exception when invalid_text_representation then raise exception 'INVALID_INPUT'; end;
 if p_key<>app||':'||target::text then raise exception 'INVALID_INPUT'; end if;
 if app='kotonoha' then
  perform pg_advisory_xact_lock(hashtextextended('kotonoha-google-members',1478));
  perform 1 from kotonoha.google_members where user_id=target for update;
 else
  perform pg_advisory_xact_lock(hashtextextended('marugo-qr-admin',76191));
  perform 1 from kotonoha.qr_members where user_id=target for update;
 end if;
 before_control:=marugo_directory.access_control(p_actor,p_key);
 if before_control is null then raise exception 'MEMBER_NOT_FOUND'; end if;
 if before_control->>'version'<>p_version then raise exception 'STALE_STATE'; end if;
 if not (before_control->'actions' ? p_action) then raise exception 'ACTION_FORBIDDEN'; end if;
 if not public.marugo_directory_manage_authorized(p_actor) then raise exception 'ADMIN_REQUIRED'; end if;
 if app='kotonoha' then
  update kotonoha.google_members set status=case when p_action='approve' then 'active' else 'suspended' end,
   reviewed_at=clock_timestamp(),reviewed_by=p_actor where user_id=target;
  if p_action='suspend' then delete from kotonoha.sessions where google_user_id=target; end if;
 else
  update kotonoha.qr_members set status=case when p_action='approve' then 'active' else 'suspended' end,
   updated_at=clock_timestamp() where user_id=target;
  insert into kotonoha.qr_account_audit(actor_id,target_id,action,before_data,after_data)
   select p_actor,target,'directory_'||p_action,before_control->'snapshot',to_jsonb(m) from kotonoha.qr_members m where user_id=target;
 end if;

 after_control:=marugo_directory.access_control(p_actor,p_key);
 insert into marugo_directory.change_audit(actor_id,request_id,request_hash,target_key,action,reason,before_data,after_data)
 values(p_actor,p_request,request_hash,p_key,p_action,btrim(p_reason),before_control-'snapshot',after_control-'snapshot');
 return jsonb_build_object('ok',true,'key',p_key,'status',after_control->>'status','requestId',p_request);
end $$;
revoke all on function public.marugo_directory_change(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.marugo_directory_change(uuid,uuid,text,text,text,text) to service_role;
