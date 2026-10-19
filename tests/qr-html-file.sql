-- Rollback-only. Confirms HTML is persisted and SVG remains rejected.
begin;
do $test$
declare own uuid:=gen_random_uuid(); item uuid:=gen_random_uuid(); data jsonb;
begin
  data:=public.kotonoha_qr_file('init',own,item,jsonb_build_object(
    'title','html page','fileName','page.HTML','mime','text/html','size',120));
  assert data->>'mime'='text/html';
  assert data->>'path'=own::text||'/'||item::text||'/file.html';
  assert (select allowed_mime_types @> array['text/html']::text[]
    from storage.buckets where id='marugo-qr-files');
  begin
    perform public.kotonoha_qr_file('init',own,gen_random_uuid(),jsonb_build_object(
      'title','svg','fileName','logo.svg','mime','image/svg+xml','size',20));
    raise exception 'SVG_ALLOWED';
  exception when others then if sqlerrm<>'INVALID_FILE' then raise; end if; end;
  begin
    insert into kotonoha.qr_files(id,owner_id,title,file_name,mime,size,path)
      values(gen_random_uuid(),own,'bad','bad.txt','text/plain',1,own::text||'/bad.txt');
    raise exception 'PLAIN_TEXT_ALLOWED';
  exception when others then if sqlerrm not like '%qr_files_mime_check%' then raise; end if; end;
end $test$;
rollback;
