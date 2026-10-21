-- Temporary showcase access: the existing shared portal login can open QR.
-- Keep this behind a database switch so production can disable it later.
alter table kotonoha.access_config
  add column if not exists qr_shared_login_enabled boolean not null default false;

update kotonoha.access_config
set qr_shared_login_enabled = true
where singleton;

create or replace function public.marugo_qr_shared(
  p_operation text,
  p_token_hash text,
  p_store uuid default null,
  p_target uuid default null,
  p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path=''
as $function$
declare
  v_config kotonoha.access_config%rowtype;
  v_store kotonoha.qr_stores%rowtype;
  v_before kotonoha.qr_members%rowtype;
  v_after kotonoha.qr_members%rowtype;
  v_expiry timestamptz;
  v_rows jsonb;
  v_action text := p_payload->>'action';
  v_page integer := greatest(0,least(100000,coalesce((p_payload->>'page')::integer,0)));
begin
  select * into strict v_config from kotonoha.access_config where singleton for share;
  if not v_config.qr_shared_login_enabled then
    raise exception 'SHARED_QR_FORBIDDEN' using errcode='42501';
  end if;
  -- Check the actual password session on every request, including revocation.
  -- A Google bridge session grants no shared QR privileges.
  select expires_at into v_expiry from kotonoha.sessions
    where token_hash=p_token_hash and expires_at>now() and google_user_id is null
    for share;
  if not found then raise exception 'INVALID_SESSION' using errcode='42501'; end if;

  if p_operation in ('context','register') then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',s.id,'name',s.name,'legacy',s.legacy
    ) order by s.legacy,s.name),'[]'::jsonb)
      into v_rows from kotonoha.qr_stores s where s.active;
    return jsonb_build_object(
      'member', jsonb_build_object(
        'user_id',v_config.workspace_id,'store_id',null,'status','active',
        'role','admin','store_name',null
      ),
      'stores',v_rows,'email','共通ID','accessMode','shared'
    );
  end if;

  if p_operation = 'scope' then
    select * into v_store from kotonoha.qr_stores
      where id=p_store and active;
    if not found then
      raise exception 'STORE_FORBIDDEN' using errcode='42501';
    end if;
    return jsonb_build_object(
      'workspaceId',v_store.id,'storeName',v_store.name
    );
  end if;

  if p_operation='members' then
    select coalesce(jsonb_agg(row_to_json(r) order by r.created_at desc,r.user_id),'[]'::jsonb)
      into v_rows from (
        select m.*,u.email,u.email_confirmed_at is not null as email_verified,s.name as store_name
        from kotonoha.qr_members m join auth.users u on u.id=m.user_id
        left join kotonoha.qr_stores s on s.id=m.store_id
        where p_store is null or m.store_id=p_store
        order by m.created_at desc,m.user_id limit 50 offset v_page*50
      ) r;
    return jsonb_build_object('members',v_rows,'total',(
      select count(*) from kotonoha.qr_members where p_store is null or store_id=p_store
    ));
  end if;

  if p_operation='update_member' then
    -- Use the same lock and last-admin safeguards as native account management.
    perform pg_advisory_xact_lock(hashtextextended('marugo-qr-admin',76191));
    select * into v_before from kotonoha.qr_members where user_id=p_target for update;
    if not found then raise exception 'MEMBER_NOT_FOUND'; end if;
    if v_action is null or v_action not in (
      'approve','suspend','grant_admin','revoke_admin','assign_store'
    ) then raise exception 'INVALID_ACTION'; end if;
    if v_action in ('approve','grant_admin') and not exists(
      select 1 from auth.users where id=p_target and email_confirmed_at is not null
      and deleted_at is null and (banned_until is null or banned_until<=now())
    ) then raise exception 'UNVERIFIED'; end if;
    if v_action='grant_admin' and v_before.status<>'active' then
      raise exception 'APPROVE_FIRST';
    end if;
    if v_action in ('suspend','revoke_admin') and v_before.role='admin'
      and v_before.status='active' and (
        select count(*) from kotonoha.qr_members m join auth.users u on u.id=m.user_id
        where m.role='admin' and m.status='active' and u.deleted_at is null
        and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until<=now())
      )<=1 then raise exception 'LAST_ADMIN'; end if;
    if v_action='assign_store' then
      if not exists(select 1 from kotonoha.qr_stores where id=p_store and active and not legacy)
        then raise exception 'INVALID_STORE'; end if;
      update kotonoha.qr_members set store_id=p_store,updated_at=now() where user_id=p_target;
    elsif v_action='revoke_admin' then
      if v_before.store_id is null then raise exception 'STORE_REQUIRED'; end if;
      update kotonoha.qr_members set role='member',updated_at=now() where user_id=p_target;
    elsif v_action='grant_admin' then
      update kotonoha.qr_members set role='admin',updated_at=now() where user_id=p_target;
    else
      update kotonoha.qr_members set status=case v_action when 'approve' then 'active'
        else 'suspended' end,updated_at=now() where user_id=p_target;
    end if;
    select * into v_after from kotonoha.qr_members where user_id=p_target;
    insert into kotonoha.qr_account_audit(actor_id,target_id,action,before_data,after_data)
      values(v_config.workspace_id,p_target,'shared_'||v_action,to_jsonb(v_before),to_jsonb(v_after));
    return to_jsonb(v_after);
  end if;

  raise exception 'INVALID_OPERATION';
end;
$function$;

revoke all on function public.marugo_qr_shared(text,text,uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.marugo_qr_shared(text,text,uuid,uuid,jsonb)
  to service_role;
