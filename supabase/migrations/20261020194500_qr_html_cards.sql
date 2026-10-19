create or replace function public.kotonoha_qr_html_cards()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'name', f.file_name) order by l.code), '[]'::jsonb)
  from kotonoha.qr_links l
  join kotonoha.qr_files f on f.link_id = l.id and f.state = 'ready' and f.mime = 'text/html'
  where l.active and l.deleted_at is null;
$$;

create or replace function public.kotonoha_qr_file_kinds(p_owner uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'mime', f.mime)), '[]'::jsonb)
  from kotonoha.qr_links l
  join kotonoha.qr_files f on f.link_id = l.id and f.state = 'ready'
  where l.owner_id = p_owner and l.deleted_at is null;
$$;

revoke all on function public.kotonoha_qr_html_cards() from public, anon, authenticated;
grant execute on function public.kotonoha_qr_html_cards() to service_role;
revoke all on function public.kotonoha_qr_file_kinds(uuid) from public, anon, authenticated;
grant execute on function public.kotonoha_qr_file_kinds(uuid) to service_role;
