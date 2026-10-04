-- Additive, kotonoha only. No recipe/QR tables, Auth users or meeting owners change.
create table kotonoha.google_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  status text not null default 'pending' check (status in ('pending','active','suspended')),
  role text not null default 'member' check (role in ('member','admin')),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null
);
alter table kotonoha.google_members enable row level security;
revoke all on kotonoha.google_members from public, anon, authenticated;
alter table kotonoha.sessions add column google_user_id uuid references auth.users(id) on delete cascade;

-- Keep the verified legacy password/rate-limit implementation unchanged and private.
alter function public.kotonoha_auth(text,jsonb) set schema kotonoha;
revoke all on function kotonoha.kotonoha_auth(text,jsonb) from public, anon, authenticated, service_role;
create function public.kotonoha_auth(p_operation text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_user uuid;
begin
  if p_operation = 'session' then
    select google_user_id into v_user from kotonoha.sessions where token_hash = p_payload->>'tokenHash';
    if v_user is not null and not exists (
      select 1 from kotonoha.google_members m join kotonoha.access_config c on c.workspace_id=m.workspace_id
      join auth.users u on u.id=m.user_id
      where c.singleton and m.user_id=v_user and m.status='active'
      and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until <= now())
      and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google')
    ) then return '{"error":"INVALID_TOKEN"}'::jsonb; end if;
  end if;
  return kotonoha.kotonoha_auth(p_operation,p_payload);
end;
$function$;
revoke all on function public.kotonoha_auth(text,jsonb) from public, anon, authenticated;
grant execute on function public.kotonoha_auth(text,jsonb) to service_role;

create function public.kotonoha_google_auth(p_operation text, p_actor uuid, p_target uuid default null, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_workspace uuid;
  v_member kotonoha.google_members%rowtype;
  v_target kotonoha.google_members%rowtype;
  v_proof jsonb;
  v_expiry timestamptz;
  v_token text := p_payload->>'tokenHash';
begin
  select workspace_id into strict v_workspace from kotonoha.access_config where singleton;
  if not exists(select 1 from auth.users u where u.id=p_actor and u.email_confirmed_at is not null
    and (u.banned_until is null or u.banned_until<=now())
    and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google')) then
    return '{"error":"GOOGLE_REQUIRED"}'::jsonb;
  end if;
  -- Serializes requests, approvals and suspension against Google session issuance.
  perform pg_advisory_xact_lock(hashtextextended('kotonoha-google-members',1478));
  select * into v_member from kotonoha.google_members where user_id=p_actor and workspace_id=v_workspace;
  if p_operation='context' then
    return jsonb_build_object('member',case when v_member.user_id is null then null else to_jsonb(v_member) end);
  elsif p_operation='request' then
    -- Proof MUST be a real legacy session, never a Google bridge session or QR JWT.
    v_proof := public.kotonoha_auth('session',jsonb_build_object('tokenHash',p_payload->>'legacyHash'));
    if v_proof->>'workspaceId' is distinct from v_workspace::text or not exists (
      select 1 from kotonoha.sessions where token_hash=p_payload->>'legacyHash' and google_user_id is null
    ) then return '{"error":"LEGACY_REQUIRED"}'::jsonb; end if;
    insert into kotonoha.google_members(user_id,workspace_id) values(p_actor,v_workspace)
      on conflict(user_id) do nothing;
    -- Repeated requests never unsuspend, self-approve or grant admin.
    select * into v_member from kotonoha.google_members where user_id=p_actor;
    return jsonb_build_object('member',to_jsonb(v_member));
  elsif p_operation='login' then
    if v_member.status is distinct from 'active' then return '{"error":"APPROVAL_REQUIRED"}'::jsonb; end if;
    if v_token is null or v_token !~ '^[0-9a-f]{64}$' then return '{"error":"INVALID_TOKEN"}'::jsonb; end if;
    delete from kotonoha.sessions where expires_at <= now();
    v_expiry := now()+interval '1 hour';
    insert into kotonoha.sessions(token_hash,expires_at,google_user_id) values(v_token,v_expiry,p_actor);
    return jsonb_build_object('expiresAt',v_expiry);
  end if;
  if v_member.status is distinct from 'active' or v_member.role is distinct from 'admin' then
    return '{"error":"ADMIN_REQUIRED"}'::jsonb;
  end if;
  if p_operation='members' then
    return jsonb_build_object('members',coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('email',u.email) order by m.requested_at)
      from kotonoha.google_members m join auth.users u on u.id=m.user_id where m.workspace_id=v_workspace),'[]'::jsonb));
  elsif p_operation='update' then
    select * into v_target from kotonoha.google_members where user_id=p_target and workspace_id=v_workspace for update;
    if not found then return '{"error":"MEMBER_NOT_FOUND"}'::jsonb; end if;
    if p_target=p_actor or v_target.role='admin' then return '{"error":"ADMIN_PROTECTED"}'::jsonb; end if;
    if p_payload->>'action' not in ('approve','suspend') or p_payload->>'action' is null then
      return '{"error":"INVALID_ACTION"}'::jsonb;
    end if;
    update kotonoha.google_members set status=case p_payload->>'action' when 'approve' then 'active' else 'suspended' end,
      reviewed_at=now(),reviewed_by=p_actor where user_id=p_target;
    if p_payload->>'action'='suspend' then delete from kotonoha.sessions where google_user_id=p_target; end if;
    return '{"ok":true}'::jsonb;
  end if;
  return '{"error":"INVALID_ACTION"}'::jsonb;
end;
$function$;
revoke all on function public.kotonoha_google_auth(text,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.kotonoha_google_auth(text,uuid,uuid,jsonb) to service_role;
-- Initial administrator: owner-designated, verified Google UID only. No email auto-grant,
-- first-login bootstrap, or public API for granting admin. See docs/google-auth.md.
