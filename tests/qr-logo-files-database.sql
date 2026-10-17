-- The stored file selection belongs to the upload attempt, not mutable artwork.
begin;
do $test$
declare
  own uuid := gen_random_uuid(); item uuid := gen_random_uuid(); data jsonb; invalid jsonb;
  args jsonb := '{"title":"Frozen upload","fileName":"menu.pdf","mime":"application/pdf","size":100,"logoId":"instagram-gradient"}';
begin
  data := public.kotonoha_qr_file('init',own,item,args);
  assert data->>'logo_id'='instagram-gradient', 'file init must store frozen catalog selection';
  assert public.kotonoha_qr_file('init',own,item,args)=data, 'same attempt retries without mutation';
  begin
    perform public.kotonoha_qr_file('init',own,item,args||'{"logoId":"line-ios"}');
    raise exception 'CHANGED_FILE_LOGO_ALLOWED';
  exception when others then if sqlerrm<>'REQUEST_CONFLICT' then raise; end if; end;
  begin
    perform public.kotonoha_qr_file('init',own,item,args-'logoId');
    raise exception 'OMITTED_CHANGED_FILE_LOGO_ALLOWED';
  exception when others then if sqlerrm<>'REQUEST_CONFLICT' then raise; end if; end;
  for invalid in select value from jsonb_array_elements('["unknown", "", "../line-ios", 1, true, [], {}]'::jsonb) loop
    begin
      perform public.kotonoha_qr_file('init',own,gen_random_uuid(),args||jsonb_build_object('logoId',invalid));
      raise exception 'INVALID_FILE_LOGO_ALLOWED';
    exception when others then if sqlerrm<>'INVALID_LOGO' then raise; end if; end;
  end loop;
  item := gen_random_uuid();
  data := public.kotonoha_qr_file('init',own,item,args-'logoId');
  assert data->'logo_id'='null'::jsonb, 'legacy file init stores no logo';
  assert public.kotonoha_qr_file('init',own,item,args||'{"logoId":null}')=data, 'omission and null are the same legacy attempt';
end $test$;
rollback;
select 'PASS: frozen upload selection, exact retry equality, validated/legacy init' as result;

begin;
do $test$
declare
  own uuid := gen_random_uuid(); item uuid := gen_random_uuid(); data jsonb; original jsonb;
  args jsonb := '{"title":"Frozen completion","fileName":"menu.pdf","mime":"application/pdf","size":100,"logoId":"instagram-gradient"}';
  completion jsonb := '{"code":"logoFile0001","targetUrl":"https://marugo-s.github.io/multiapp/?file=logoFile0001","logoId":"line-ios"}';
begin
  perform public.kotonoha_qr_file('init',own,item,args);
  original := public.kotonoha_qr_file('complete',own,item,completion);
  assert original->>'logo_id'='instagram-gradient', 'completion copies the frozen file selection, not request logo';
  assert public.kotonoha_qr_file('get',own,item)->>'state'='ready';
  data := public.kotonoha_qr('logo',own,item,'{"logoId":"facebook-icons8-96"}');
  assert (select logo_id from kotonoha.qr_files where id=item)='instagram-gradient', 'editing artwork cannot mutate upload attempt';
  assert public.kotonoha_qr_file('complete',own,item,completion)=data, 'completion replay returns current edited link';
  assert public.kotonoha_qr_file('init',own,item,args)->'link'=data, 'original frozen attempt replays current link';
  begin
    perform public.kotonoha_qr_file('init',own,item,args||'{"logoId":"facebook-icons8-96"}');
    raise exception 'MUTABLE_LOGO_USED_FOR_ATTEMPT_EQUALITY';
  exception when others then if sqlerrm<>'REQUEST_CONFLICT' then raise; end if; end;
  data := public.kotonoha_qr('logo',own,item,'{"logoId":null}');
  assert public.kotonoha_qr_file('complete',own,item,'{}')=data, 'completion replay cannot restore removed logo';
  assert public.kotonoha_qr_file('init',own,item,args)->'link'=data, 'init replay cannot restore removed logo';
  assert data-'logo_id'=original-'logo_id', 'all link identity and history fields survive edits and retries';
end $test$;
rollback;
select 'PASS: frozen completion, current-logo replay after edit/removal and immutable attempt equality' as result;

begin;
do $test$
declare
  own uuid := '00000000-0000-4000-8000-000000000072'; other_store uuid := gen_random_uuid();
  item uuid := '00000000-0000-4000-8000-000000000074'; data jsonb; history jsonb;
  args jsonb := '{"title":"Legacy upload","fileName":"menu.pdf","mime":"application/pdf","size":100}';
begin
  data := public.kotonoha_qr_file('complete',own,item,
    '{"code":"legacyDone01","targetUrl":"https://marugo-s.github.io/multiapp/?file=legacyDone01"}');
  assert data->'logo_id'='null'::jsonb, 'pre-migration pending file completes without a logo';
  perform public.kotonoha_qr_scan_unique('legacyDone01',gen_random_uuid());
  history := public.kotonoha_qr_history(own,item);
  data := public.kotonoha_qr('logo',own,item,'{"logoId":"line-android"}');
  assert public.kotonoha_qr_file('init',own,item,args)->'link'=data, 'old clients replay frozen null after a later artwork edit';
  assert public.kotonoha_qr_file('complete',own,item,'{}')=data;
  assert public.kotonoha_qr_file('get',own,item)->'logo_id'='null'::jsonb;
  assert public.kotonoha_qr_file('get',other_store,item) is null;
  assert public.kotonoha_qr_file('complete',other_store,item,'{}') is null;
  begin
    perform public.kotonoha_qr_file('init',other_store,item,args);
    raise exception 'FOREIGN_FILE_INIT_ALLOWED';
  exception when others then if sqlerrm<>'REQUEST_CONFLICT' then raise; end if; end;
  perform public.kotonoha_qr_lifecycle('trash',own,item);
  assert exists(select 1 from jsonb_array_elements(public.kotonoha_qr('trash_list',own)->'links') r where r->>'id'=item::text and r->>'logo_id'='line-android');
  assert not exists(select 1 from jsonb_array_elements(public.kotonoha_qr('list',own)->'links') r where r->>'id'=item::text);
  assert public.kotonoha_qr('trash_list',other_store)->>'total'='0';
  begin
    perform public.kotonoha_qr_file('complete',own,item,'{}');
    raise exception 'TRASHED_COMPLETION_REPLAY_ALLOWED';
  exception when others then if sqlerrm<>'TRASHED' then raise; end if; end;
  begin
    perform public.kotonoha_qr_file('init',own,item,args);
    raise exception 'TRASHED_INIT_REPLAY_ALLOWED';
  exception when others then if sqlerrm<>'TRASHED' then raise; end if; end;
  data := public.kotonoha_qr_lifecycle('restore',own,item);
  assert data->>'active'='false' and data->>'logo_id'='line-android';
  assert public.kotonoha_qr_file('complete',own,item,'{}')=data;
  assert public.kotonoha_qr_history(own,item)=history;
  assert data->>'scan_count'='1' and data->>'code'='legacyDone01';
  -- A ready file published by the old code remains replayable after migration.
  item := '00000000-0000-4000-8000-000000000076';
  data := public.kotonoha_qr_file('complete',own,item,'{}');
  assert data->'logo_id'='null'::jsonb and data->>'code'='legacyFile01';
  data := public.kotonoha_qr('logo',own,item,'{"logoId":"instagram-black"}');
  assert public.kotonoha_qr_file('complete',own,item,'{}')=data;
  assert public.kotonoha_qr_file('init',own,item,
    '{"title":"Legacy ready file","fileName":"ready.pdf","mime":"application/pdf","size":100}')->'link'=data;
end $test$;
rollback;
select 'PASS: pre-migration pending/ready files, legacy retries after edits, store isolation and file trash/restore history' as result;
