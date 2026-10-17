-- Insert before the new migration to prove existing rows remain valid and intact.
select public.kotonoha_qr('create',
  '00000000-0000-4000-8000-000000000072',
  '00000000-0000-4000-8000-000000000073',
  '{"code":"legacyLogo01","title":"Legacy QR","targetUrl":"https://example.com/legacy"}');
select public.kotonoha_qr_file('init',
  '00000000-0000-4000-8000-000000000072',
  '00000000-0000-4000-8000-000000000074',
  '{"title":"Legacy upload","fileName":"menu.pdf","mime":"application/pdf","size":100}');
select public.kotonoha_qr_scan_unique('legacyLogo01',
  '00000000-0000-4000-8000-000000000075', 'qr', null, 'mobile', 'safari', 'local-fixture', repeat('a',64));
select public.kotonoha_qr_file('init',
  '00000000-0000-4000-8000-000000000072',
  '00000000-0000-4000-8000-000000000076',
  '{"title":"Legacy ready file","fileName":"ready.pdf","mime":"application/pdf","size":100}');
select public.kotonoha_qr_file('complete',
  '00000000-0000-4000-8000-000000000072',
  '00000000-0000-4000-8000-000000000076',
  '{"code":"legacyFile01","targetUrl":"https://marugo-s.github.io/multiapp/?file=legacyFile01"}');
create table public.qr_logo_legacy_snapshot as
  select to_jsonb(l) as row from kotonoha.qr_links l;
create table public.qr_logo_legacy_file_snapshot as
  select to_jsonb(f) as row from kotonoha.qr_files f;
create table public.qr_logo_function_snapshot as
  select oid::regprocedure::text as signature, pg_get_functiondef(oid) as definition
  from pg_proc where pronamespace='public'::regnamespace
  and proname in ('kotonoha_qr_scan','kotonoha_qr_scan_unique','kotonoha_qr_history',
    'kotonoha_qr_analytics','kotonoha_qr_lifecycle','marugo_qr_accounts','marugo_qr_shared');
