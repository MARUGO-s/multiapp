-- Additive dedicated RPC. Existing legacy/bot upload, store and attachment RPCs remain unchanged.
create function public.kotonoha_resumable_upload(p_operation text,p_owner uuid,p_id uuid,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m kotonoha.meetings%rowtype; result jsonb; part jsonb; actor uuid; saved_input jsonb; retry_input jsonb;
begin
 if p_owner is null then raise exception 'NOT_FOUND'; end if;
 if p_operation='context' then
  result:=public.kotonoha_auth('session',jsonb_build_object('tokenHash',p_payload->>'tokenHash'));
  if result->>'workspaceId' is distinct from p_owner::text then raise exception 'NOT_FOUND'; end if;
  select google_user_id into actor from kotonoha.sessions where token_hash=p_payload->>'tokenHash' and expires_at>now();
  if not found then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('ownerId',p_owner,'actorId',coalesce(actor::text,'shared'));
 end if;
 -- Same owner lock and order as the existing create/claim/complete paths, including first create.
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,1477));
 select * into m from kotonoha.meetings where id=p_id for update;
 if p_operation in ('create','lookup') then
  if p_id is null or jsonb_typeof(p_payload->'document'->'uploadIdentity') is distinct from 'object' or
    p_payload->'document'->'uploadIdentity'->>'ownerId' is distinct from p_owner::text or
    p_payload->'document'->'uploadIdentity'->>'uploadId' is distinct from p_id::text or
    coalesce(p_payload->'document'->'uploadIdentity'->>'planDigest','') !~ '^[a-f0-9]{64}$' or
    jsonb_typeof(p_payload->'document'->'uploadInput') is distinct from 'object' or
    p_payload->'document'->'uploadInput'->>'uploadId' is distinct from p_id::text then raise exception 'UPLOAD_CONFLICT'; end if;
  if found then
   if m.owner_id<>p_owner or m.deleted_at is not null then raise exception 'UPLOAD_CONFLICT'; end if;
   -- Location deletion redacts the frozen manifest, never its original identity.
   -- Compare every other input field and ordered source field exactly; the API's
   -- server-computed original planDigest still rejects location-only tampering.
   saved_input := m.document->'uploadInput';
   retry_input := p_payload->'document'->'uploadInput';
   if jsonb_typeof(saved_input->'sources')='array' then
    saved_input := jsonb_set(saved_input,'{sources}',(select coalesce(jsonb_agg(value-'startLocation' order by ordinality),'[]'::jsonb) from jsonb_array_elements(saved_input->'sources') with ordinality));
   end if;
   if jsonb_typeof(retry_input->'sources')='array' then
    retry_input := jsonb_set(retry_input,'{sources}',(select coalesce(jsonb_agg(value-'startLocation' order by ordinality),'[]'::jsonb) from jsonb_array_elements(retry_input->'sources') with ordinality));
   end if;
   if saved_input is distinct from retry_input or
      m.document->'uploadIdentity' is distinct from p_payload->'document'->'uploadIdentity' then raise exception 'UPLOAD_CONFLICT'; end if;
   return public.kotonoha_store('get',p_owner,p_id);
  end if;
  if p_operation='lookup' then return null; end if;
  begin
    return public.kotonoha_audio_upload('create',p_owner,p_id,p_payload);
  exception when unique_violation then raise exception 'UPLOAD_CONFLICT'; end;
 end if;
 if not found or m.owner_id<>p_owner or m.deleted_at is not null or m.document->'uploadIdentity' is null then raise exception 'NOT_FOUND'; end if;
 if p_operation='append' then
  if jsonb_typeof(p_payload->'index') is distinct from 'number' or (p_payload->>'index') !~ '^[0-9]+$' then raise exception 'UPLOAD_ORDER'; end if;
  part:=m.document->'uploadPlan'->(p_payload->>'index')::integer;
  if part is null or part->>'sha256' is null or part->>'sha256' is distinct from p_payload->'part'->>'sha256' or part->'size' is distinct from p_payload->'part'->'size' then raise exception 'UPLOAD_CONFLICT'; end if;
  part:=m.document->'audioParts'->(p_payload->>'index')::integer;
  if part is not null then
   if part->>'sha256' is null or part->>'sha256' is distinct from p_payload->'part'->>'sha256' or part->>'size' is distinct from p_payload->'part'->>'size' then raise exception 'UPLOAD_CONFLICT'; end if;
   return public.kotonoha_store('get',p_owner,p_id);
  end if;
  return public.kotonoha_audio_upload('append',p_owner,p_id,p_payload);
 elsif p_operation='attachment' then
  select f into part from jsonb_array_elements(m.document->'attachmentPlan') f where f->>'id'=p_payload->'attachment'->>'id';
  if part is null or part->>'sha256' is null or part->>'sha256' is distinct from p_payload->'attachment'->>'sha256' or
     part->'size' is distinct from p_payload->'attachment'->'size' or part->'name' is distinct from p_payload->'attachment'->'name' then raise exception 'UPLOAD_CONFLICT'; end if;
  select f into part from jsonb_array_elements(m.document->'attachments') f where f->>'id'=p_payload->'attachment'->>'id';
  if part is not null then
    if part->>'sha256' is distinct from p_payload->'attachment'->>'sha256' or part->'size' is distinct from p_payload->'attachment'->'size' then raise exception 'UPLOAD_CONFLICT'; end if;
    return public.kotonoha_store('get',p_owner,p_id);
  end if;
  -- Initial upload only: retries must never resurrect a removed attachment.
  if m.document->>'status'<>'uploading' or m.document->'uploadReceipt' is not null then raise exception 'UPLOAD_CONFLICT'; end if;
  return public.kotonoha_attachments('add',p_owner,p_id,p_payload);
 elsif p_operation='complete' then
  if m.document->'uploadReceipt' is not null then return public.kotonoha_store('get',p_owner,p_id); end if;
  if m.document->>'status'<>'uploading' then raise exception 'UPLOAD_INCOMPLETE'; end if;
  if exists(select 1 from jsonb_array_elements(m.document->'uploadPlan') with ordinality as planned(value,idx)
    left join lateral (select m.document->'audioParts'->(planned.idx::integer-1) as value) as saved on true
    where planned.value->>'sha256' is null or planned.value->'sha256' is distinct from saved.value->'sha256'
      or planned.value->'size' is distinct from saved.value->'size' or nullif(saved.value->>'audioPath','') is null) or
    exists(select 1 from jsonb_array_elements(m.document->'attachmentPlan') planned
      where not exists(select 1 from jsonb_array_elements(m.document->'attachments') saved
        where saved->'id'=planned->'id' and saved->'name'=planned->'name' and saved->'size'=planned->'size'
          and planned->>'sha256' is not null and saved->'sha256'=planned->'sha256' and nullif(saved->>'storagePath','') is not null)) then
    raise exception 'UPLOAD_INCOMPLETE';
  end if;
  result:=public.kotonoha_attachments('complete',p_owner,p_id,p_payload);
  update kotonoha.meetings set document=document || jsonb_build_object('uploadReceipt',
    m.document->'uploadIdentity' || jsonb_build_object('meetingId',p_id,'status','accepted')) where id=p_id;
  return public.kotonoha_store('get',p_owner,p_id);
 end if;
 raise exception 'UNKNOWN_OPERATION';
end $$;
revoke all on function public.kotonoha_resumable_upload(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.kotonoha_resumable_upload(text,uuid,uuid,jsonb) to service_role;
