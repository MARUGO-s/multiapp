-- Rollback-only feature fixtures. Run through qr-logo-local-postgres.py only.
begin;
do $test$
declare
  own uuid := gen_random_uuid(); item uuid := gen_random_uuid(); data jsonb;
  args jsonb := '{"code":"logoCreate01","title":"Catalog poster","targetUrl":"https://example.com/","logoId":"instagram-black"}';
begin
  data := public.kotonoha_qr('create',own,item,args);
  assert data->>'logo_id' = 'instagram-black', 'URL creation must persist selected logo_id';
  assert (select logo_id from kotonoha.qr_links where id=item) = 'instagram-black';
end $test$;
rollback;
select 'PASS: URL creation persists selected catalog logo' as result;

begin;
do $test$
declare
  own uuid := gen_random_uuid(); item uuid := gen_random_uuid();
  original jsonb; changed jsonb; args jsonb;
begin
  args := '{"code":"logoUpdate01","title":"Poster","targetUrl":"https://example.com/","logoId":"instagram-black"}';
  original := public.kotonoha_qr('create',own,item,args);
  changed := public.kotonoha_qr('logo',own,item,'{"logoId":"line-ios"}');
  assert changed->>'logo_id' = 'line-ios', 'same-store logo update persists';
  assert changed - 'logo_id' = original - 'logo_id', 'logo update changes no identity/routing/history fields';
  changed := public.kotonoha_qr('create',own,item,args || '{"code":"different001"}');
  assert changed->>'logo_id' = 'line-ios', 'URL creation replay returns CURRENT edited logo';
  assert changed->>'code' = 'logoUpdate01', 'URL creation replay preserves original tracking code';
  changed := public.kotonoha_qr('logo',own,item,'{"logoId":null}');
  assert changed->'logo_id' = 'null'::jsonb, 'explicit null removes logo';
  assert public.kotonoha_qr('create',own,item,args)->'logo_id' = 'null'::jsonb, 'URL replay cannot restore removed logo';
end $test$;
rollback;
select 'PASS: row-scoped edit/removal and URL replay preserve current logo and identity' as result;

begin;
do $test$
declare
  own uuid := gen_random_uuid(); item uuid := gen_random_uuid();
  data jsonb; invalid jsonb; candidate text;
  args jsonb := '{"code":"logoValid001","title":"Validation","targetUrl":"https://example.com/"}';
  allowed text[] := array[
    'instagram-black','instagram-gradient','instagram-white','line-android','line-ios',
    'line-icons8-100','line-icons8-50','instagram-icons8-100','instagram-icons8-50',
    'x-icons8-100','x-icons8-50','facebook-icons8-100','facebook-icons8-48','facebook-icons8-50','facebook-icons8-96'
  ];
begin
  assert exists(select 1 from information_schema.columns where table_schema='kotonoha' and table_name='qr_files' and column_name='logo_id' and is_nullable='YES'), 'staged files require nullable catalog logo_id';
  assert (select count(*) from pg_constraint where conname in ('qr_links_logo_catalog','qr_files_logo_catalog') and contype='c')=2, 'both tables require catalog CHECK constraints';
  data := public.kotonoha_qr('create',own,item,args);
  assert data->'logo_id'='null'::jsonb, 'omitted logo stays legacy null';
  foreach candidate in array allowed loop
    data := public.kotonoha_qr('logo',own,item,jsonb_build_object('logoId',candidate));
    assert data->>'logo_id'=candidate, 'every agreed catalog ID must be accepted';
    update kotonoha.qr_files set logo_id=candidate where id='00000000-0000-4000-8000-000000000074';
  end loop;
  for invalid in select value from jsonb_array_elements('["", "unknown", "LINE-IOS", "line-ios ", "../line-ios", "https://example.com/logo.png", "data:image/png;base64,a", 1, true, [], {}]'::jsonb) loop
    begin
      perform public.kotonoha_qr('logo',own,item,jsonb_build_object('logoId',invalid));
      raise exception 'INVALID_PATCH_ALLOWED';
    exception when others then if sqlerrm<>'INVALID_LOGO' then raise; end if; end;
    begin
      perform public.kotonoha_qr('create',own,gen_random_uuid(),args||jsonb_build_object('logoId',invalid));
      raise exception 'INVALID_CREATE_ALLOWED';
    exception when others then if sqlerrm<>'INVALID_LOGO' then raise; end if; end;
    if jsonb_typeof(invalid)='string' then
      begin
        update kotonoha.qr_links set logo_id=invalid#>>'{}' where id=item;
        raise exception 'INVALID_LINK_COLUMN_ALLOWED';
      exception when check_violation then null; end;
      begin
        update kotonoha.qr_files set logo_id=invalid#>>'{}' where id='00000000-0000-4000-8000-000000000074';
        raise exception 'INVALID_FILE_COLUMN_ALLOWED';
      exception when check_violation then null; end;
    end if;
  end loop;
  begin
    perform public.kotonoha_qr('logo',own,item,'{}');
    raise exception 'MISSING_PATCH_ALLOWED';
  exception when others then if sqlerrm<>'INVALID_LOGO' then raise; end if; end;
  for invalid in select value from jsonb_array_elements('["logoId", ["logoId"], null]'::jsonb) loop
    begin
      perform public.kotonoha_qr('logo',own,item,invalid);
      raise exception 'NON_OBJECT_PATCH_ALLOWED';
    exception when others then if sqlerrm<>'INVALID_LOGO' then raise; end if; end;
  end loop;
  assert public.kotonoha_qr('logo',own,item,'{"logoId":null}')->'logo_id'='null'::jsonb;
end $test$;
rollback;
select 'PASS: exact catalog checks, null compatibility and strict SQL payload validation' as result;
