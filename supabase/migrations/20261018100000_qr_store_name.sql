-- Shared per-QR caption. NULL resolves the selected STORE catalog label in the
-- shared renderer; empty string explicitly hides it. No backfill or row rewrite.
create function kotonoha.qr_store_name(p_logo jsonb,p_value jsonb) returns text
language plpgsql immutable set search_path='' as $function$
declare v text;
begin
  if p_value is null or p_value='null'::jsonb then return null; end if;
  if pg_catalog.jsonb_typeof(p_value)<>'string'
    or not kotonoha.qr_logo_valid(p_logo)
    or coalesce(p_logo #>> '{}','') not like 'store-%' then
    raise exception 'INVALID_STORE_NAME';
  end if;
  v := p_value #>> '{}';
  -- PostgreSQL JSONB rejects U+0000 itself; every other C0/C1 is checked here.
  -- Check the raw value before trimming, matching validateStoreName in JS.
  if v ~ U&'[\0001-\001f\007f-\009f\2028\2029]' then
    raise exception 'INVALID_STORE_NAME';
  end if;
  -- ECMAScript trim whitespace, excluding controls/newlines rejected above.
  v := pg_catalog.btrim(v,U&'\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\202f\205f\3000\feff');
  if pg_catalog.char_length(v)>80 then raise exception 'INVALID_STORE_NAME'; end if;
  return v;
end;
$function$;
revoke all on function kotonoha.qr_store_name(jsonb,jsonb) from public,anon,authenticated;
grant execute on function kotonoha.qr_store_name(jsonb,jsonb) to service_role;

alter table kotonoha.qr_links add column store_name text;
alter table kotonoha.qr_links add constraint qr_links_store_name_valid check (
  store_name is null or store_name=kotonoha.qr_store_name(to_jsonb(logo_id),to_jsonb(store_name))
);
alter table kotonoha.qr_files add column initial_store_name text;
alter table kotonoha.qr_files add constraint qr_files_initial_store_name_valid check (
  initial_store_name is null or initial_store_name=kotonoha.qr_store_name(to_jsonb(logo_id),to_jsonb(initial_store_name))
);
comment on column kotonoha.qr_links.store_name is
  'Shared STORE-only caption override: NULL=catalog label, empty=hidden; at most 80 Unicode code points, no C0/C1 or line separators.';
comment on column kotonoha.qr_files.initial_store_name is
  'Immutable upload-attempt caption; copied on first completion only. Later link edits and completion retries never change it.';

-- Preserve the latest QR management RPC, including legacy scans and row locks.
create or replace function public.kotonoha_qr(
  p_operation text, p_owner uuid default null, p_id uuid default null,
  p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_link kotonoha.qr_links%rowtype;
  v_page integer := greatest(0, least(100000, coalesce((p_payload->>'page')::integer, 0)));
  v_result jsonb;
  v_inserted integer;
  v_store_name text;
begin
  if p_operation = 'scan' then
    select * into v_link from kotonoha.qr_links where code = p_payload->>'code' for update;
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if v_link.deleted_at is not null or not v_link.active then raise exception 'INACTIVE' using errcode = 'P0001'; end if;
    insert into kotonoha.qr_access_logs(link_id, event_id, user_agent)
      values(v_link.id, (p_payload->>'eventId')::uuid, left(p_payload->>'userAgent',512))
      on conflict(link_id,event_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      update kotonoha.qr_links set scan_count = scan_count + 1, last_accessed_at = now() where id=v_link.id;
    end if;
    return jsonb_build_object('targetUrl',v_link.target_url);
  end if;
  if p_owner is null then raise exception 'OWNER_REQUIRED'; end if;
  if p_operation in ('list','trash_list') then
    select coalesce(jsonb_agg(to_jsonb(l) order by case when p_operation='trash_list' then l.deleted_at else l.created_at end desc,l.id),'[]'::jsonb) into v_result
      from (select * from kotonoha.qr_links where owner_id=p_owner and ((p_operation='list' and deleted_at is null) or (p_operation='trash_list' and deleted_at is not null)) order by case when p_operation='trash_list' then deleted_at else created_at end desc,id limit 50 offset v_page*50) l;
    return jsonb_build_object('links',v_result,'total',(select count(*) from kotonoha.qr_links where owner_id=p_owner and ((p_operation='list' and deleted_at is null) or (p_operation='trash_list' and deleted_at is not null))));
  elsif p_operation = 'create' then
    if not kotonoha.qr_logo_valid(p_payload->'logoId') then raise exception 'INVALID_LOGO'; end if;
    v_store_name := kotonoha.qr_store_name(p_payload->'logoId',p_payload->'storeName');
    insert into kotonoha.qr_links(id,owner_id,code,title,target_url,logo_id,store_name)
      values(p_id,p_owner,p_payload->>'code',p_payload->>'title',p_payload->>'targetUrl',p_payload->>'logoId',v_store_name)
      on conflict(id) do nothing;
    select * into v_link from kotonoha.qr_links where id=p_id and owner_id=p_owner;
    if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
    if v_link.title is distinct from p_payload->>'title' or v_link.target_url is distinct from p_payload->>'targetUrl' then
      raise exception 'REQUEST_CONFLICT';
    end if;
    if v_link.deleted_at is not null then raise exception 'TRASHED'; end if;
    return to_jsonb(v_link);
  end if;
  select * into v_link from kotonoha.qr_links where id=p_id and owner_id=p_owner for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if p_operation = 'history' then
    select coalesce(jsonb_agg(to_jsonb(e) order by e.accessed_at desc,e.id desc),'[]'::jsonb) into v_result
      from (select id,accessed_at,user_agent from kotonoha.qr_access_logs where link_id=p_id order by accessed_at desc,id desc limit 30 offset v_page*30) e;
    return jsonb_build_object('events',v_result,'total',v_link.scan_count);
  elsif p_operation = 'logo' then
    if v_link.deleted_at is not null then raise exception 'TRASHED'; end if;
    if pg_catalog.jsonb_typeof(p_payload) is distinct from 'object'
      or not coalesce(p_payload ? 'logoId',false) or not kotonoha.qr_logo_valid(p_payload->'logoId') then
      raise exception 'INVALID_LOGO';
    end if;
    v_store_name := case
      when p_payload ? 'storeName' then kotonoha.qr_store_name(p_payload->'logoId',p_payload->'storeName')
      when v_link.logo_id is not distinct from p_payload->>'logoId' then v_link.store_name
      else null end;
    update kotonoha.qr_links set logo_id=p_payload->>'logoId',store_name=v_store_name
      where id=p_id and owner_id=p_owner returning * into v_link;
    return to_jsonb(v_link);
  elsif p_operation = 'active' then
    if v_link.deleted_at is not null then raise exception 'TRASHED'; end if;
    update kotonoha.qr_links set active=(p_payload->>'active')::boolean where id=p_id and owner_id=p_owner returning * into v_link;
    return to_jsonb(v_link);
  end if;
  raise exception 'INVALID_OPERATION';
end;
$function$;
revoke all on function public.kotonoha_qr(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.kotonoha_qr(text,uuid,uuid,jsonb) to service_role;

-- Preserve storage quota, immutable attempt identity, ownership and parent/file lock order.
create or replace function public.kotonoha_qr_file(p_operation text,p_owner uuid default null,p_id uuid default null,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare f kotonoha.qr_files%rowtype; l kotonoha.qr_links%rowtype; ext text; v_store_name text;
begin
  if p_operation='public' then
    select q.* into l from kotonoha.qr_links q where q.code=p_payload->>'code';
    if not found then raise exception 'NOT_FOUND'; end if;
    if not l.active or l.deleted_at is not null then raise exception 'INACTIVE'; end if;
    select * into f from kotonoha.qr_files where link_id=l.id and state='ready';
    if not found then raise exception 'NOT_FOUND'; end if;
    return to_jsonb(f);
  end if;
  if p_owner is null then raise exception 'OWNER_REQUIRED'; end if;
  if p_id is null then raise exception 'ID_REQUIRED'; end if;
  -- A pending upload has no parent row to lock yet. Serialize first completion
  -- before the parent lookup, so a waiting completion rereads the committed link.
  -- Keep the existing parent-before-file lock order for all persisted parents.
  if p_operation='complete' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qr-file:'||p_id::text,621));
  end if;
  if p_operation='init' then
    if not kotonoha.qr_logo_valid(p_payload->'logoId') then raise exception 'INVALID_LOGO'; end if;
    v_store_name := kotonoha.qr_store_name(p_payload->'logoId',p_payload->'storeName');
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text,620));
    select * into f from kotonoha.qr_files where id=p_id and owner_id=p_owner for update;
    if found then
      if f.title is distinct from p_payload->>'title' or f.file_name is distinct from p_payload->>'fileName' or f.size is distinct from (p_payload->>'size')::bigint or f.mime is distinct from p_payload->>'mime' or f.logo_id is distinct from p_payload->>'logoId' or f.initial_store_name is distinct from v_store_name then raise exception 'REQUEST_CONFLICT'; end if;
      if f.state in ('deleting','removed') then raise exception 'FILE_DELETING'; end if;
      if f.link_id is not null then
        select * into l from kotonoha.qr_links where id=f.link_id and owner_id=p_owner;
        if l.deleted_at is not null then raise exception 'TRASHED'; end if;
        return jsonb_build_object('link',to_jsonb(l));
      end if;
      return to_jsonb(f);
    end if;
    if exists(select 1 from kotonoha.qr_links where id=p_id) or exists(select 1 from kotonoha.qr_files where id=p_id) then raise exception 'REQUEST_CONFLICT'; end if;
    -- Reserve the bucket maximum for incomplete uploads: a signed upload can
    -- contain up to 20MB even if the client claimed a smaller size.
    if coalesce((select sum(case when state='pending' then 20971520 else greatest(size,524288) end) from kotonoha.qr_files where owner_id=p_owner),0)+20971520 > 524288000 then raise exception 'FILE_QUOTA'; end if;
    ext := case p_payload->>'mime' when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' else null end;
    if ext is null then raise exception 'INVALID_FILE'; end if;
    insert into kotonoha.qr_files(id,owner_id,title,file_name,mime,size,path,logo_id,initial_store_name)
    values(p_id,p_owner,p_payload->>'title',p_payload->>'fileName',p_payload->>'mime',(p_payload->>'size')::bigint,p_owner::text||'/'||p_id::text||'/file.'||ext,p_payload->>'logoId',v_store_name) returning * into f;
    return to_jsonb(f);
  end if;
  -- The parent lock is acquired before the file lock, matching scan/lifecycle.
  select * into l from kotonoha.qr_links where id=p_id and owner_id=p_owner for update;
  select * into f from kotonoha.qr_files where id=p_id and owner_id=p_owner for update;
  if not found then return null; end if;
  if p_operation='get' then return to_jsonb(f); end if;
  if p_operation='complete' then
    if f.state in ('deleting','removed') then raise exception 'FILE_DELETING'; end if;
    if f.link_id is not null then
      if l.deleted_at is not null then raise exception 'TRASHED'; end if;
      return to_jsonb(l);
    end if;
    insert into kotonoha.qr_links(id,owner_id,code,title,target_url,logo_id,store_name)
      values(f.id,p_owner,p_payload->>'code',f.title,p_payload->>'targetUrl',f.logo_id,f.initial_store_name) returning * into l;
    update kotonoha.qr_files set link_id=l.id,state='ready' where id=f.id;
    return to_jsonb(l);
  elsif p_operation='begin_purge' then
    if p_payload->>'confirmId' is distinct from p_id::text then raise exception 'CONFIRM_REQUIRED'; end if;
    if f.link_id is not null and l.deleted_at is null then raise exception 'NOT_TRASHED'; end if;
    update kotonoha.qr_files set state=case when state='removed' then 'removed' else 'deleting' end where id=f.id returning * into f;
    return to_jsonb(f);
  elsif p_operation='removed' then
    if f.state not in ('deleting','removed') then raise exception 'FILE_CLEANUP_REQUIRED'; end if;
    update kotonoha.qr_files set state='removed' where id=f.id;
    if f.link_id is null then delete from kotonoha.qr_files where id=f.id; end if;
    return jsonb_build_object('removed',true);
  end if;
  raise exception 'INVALID_OPERATION';
end $$;
revoke all on function public.kotonoha_qr_file(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.kotonoha_qr_file(text,uuid,uuid,jsonb) to service_role;
