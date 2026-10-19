-- Allow HTML publication without changing quota, ownership, locks or existing file types.
update storage.buckets
  set allowed_mime_types = array['application/pdf','image/jpeg','image/png','text/html']
  where id = 'marugo-qr-files';
do $$
declare cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'kotonoha' and rel.relname = 'qr_files' and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%application/pdf%';
  if cname is null then raise exception 'MIME_CHECK_MISSING'; end if;
  execute format('alter table kotonoha.qr_files drop constraint %I', cname);
end $$;
alter table kotonoha.qr_files add constraint qr_files_mime_check
  check (mime in ('application/pdf','image/jpeg','image/png','text/html'));

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
    ext := case p_payload->>'mime' when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'text/html' then 'html' else null end;
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
