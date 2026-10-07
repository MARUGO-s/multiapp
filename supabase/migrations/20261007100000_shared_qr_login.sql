-- Temporary showcase access: the existing shared portal login can open QR.
-- Keep this behind a database switch so production can disable it later.
alter table kotonoha.access_config
  add column if not exists qr_shared_login_enabled boolean not null default false;

update kotonoha.access_config
set qr_shared_login_enabled = true
where singleton;

create or replace function public.marugo_qr_shared(
  p_operation text,
  p_workspace uuid,
  p_store uuid default null
) returns jsonb
language plpgsql security definer set search_path=''
as $function$
declare
  v_config kotonoha.access_config%rowtype;
  v_store kotonoha.qr_stores%rowtype;
  v_rows jsonb;
begin
  select * into strict v_config from kotonoha.access_config where singleton;
  if not v_config.qr_shared_login_enabled
     or p_workspace is distinct from v_config.workspace_id then
    raise exception 'SHARED_QR_FORBIDDEN' using errcode='42501';
  end if;

  if p_operation = 'context' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',s.id,'name',s.name,'legacy',s.legacy
    ) order by s.name),'[]'::jsonb)
      into v_rows from kotonoha.qr_stores s where s.active and not s.legacy;
    return jsonb_build_object(
      'member', jsonb_build_object(
        'user_id',p_workspace,'store_id',null,'status','active',
        'role','admin','store_name',null
      ),
      'stores',v_rows,'email','共通ID'
    );
  end if;

  if p_operation = 'scope' then
    select * into v_store from kotonoha.qr_stores
      where id=p_store and active and not legacy;
    if not found then
      raise exception 'STORE_FORBIDDEN' using errcode='42501';
    end if;
    return jsonb_build_object(
      'workspaceId',v_store.id,'storeName',v_store.name
    );
  end if;

  raise exception 'INVALID_OPERATION';
end;
$function$;

revoke all on function public.marugo_qr_shared(text,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.marugo_qr_shared(text,uuid,uuid)
  to service_role;
