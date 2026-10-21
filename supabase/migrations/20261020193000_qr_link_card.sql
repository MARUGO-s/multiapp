create or replace function public.kotonoha_qr_card(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l kotonoha.qr_links%rowtype;
  v_name text;
begin
  if p_code is null or p_code !~ '^[A-Za-z0-9_-]{12}$' then
    raise exception 'NOT_FOUND';
  end if;
  select * into l from kotonoha.qr_links q where q.code = p_code;
  if not found or not l.active or l.deleted_at is not null then
    raise exception 'NOT_FOUND';
  end if;
  select f.file_name into v_name
  from kotonoha.qr_files f
  where f.link_id = l.id and f.state = 'ready'
  order by f.created_at desc
  limit 1;
  if v_name is null or length(btrim(v_name)) = 0 then
    v_name := l.title;
  end if;
  if v_name is null or length(btrim(v_name)) = 0 then
    v_name := '公開リンク';
  end if;
  return jsonb_build_object('name', left(v_name, 180));
end;
$$;

revoke all on function public.kotonoha_qr_card(text) from public, anon, authenticated;
grant execute on function public.kotonoha_qr_card(text) to service_role;
