-- Run ONLY on ycsqfajidusuibqljjwr after gourmet 025 + directory linking migration.
-- The actual accounts and their permissions never change.
begin;
do $$
declare actor uuid := gen_random_uuid(); target uuid := gen_random_uuid();
  store_a uuid := gen_random_uuid(); store_b uuid := gen_random_uuid();
  row_data record; sns_before jsonb; sns_after jsonb;
begin
  select jsonb_agg(to_jsonb(e) order by key) into sns_before from marugo_directory.entries e where app_id='sns';
  insert into auth.users(id,email,email_confirmed_at,created_at,updated_at)
    values(actor,'gourmet-link-'||actor||'@example.invalid',now(),now(),now()),
      (target,'gourmet-link-'||target||'@example.invalid',now(),now(),now());
  insert into public.gourmet_admin_users(user_id) values(actor);
  insert into public.stores(id,user_id,name) values(store_a,actor,'Directory test A'),(store_b,actor,'Directory test B');
  select * into row_data from marugo_directory.entries where app_id='gourmet' and user_id=target::text;
  if not found or row_data.status<>'pending' or row_data.affiliation<>'閲覧不可（承認待ち）' then raise exception 'pending not linked'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform public.gourmet_set_access(target,'approved',array[store_a]);
  select * into row_data from marugo_directory.entries where app_id='gourmet' and user_id=target::text;
  if row_data.status<>'active' or row_data.role<>'一般ユーザー（閲覧専用）' or row_data.affiliation<>'Directory test A' then raise exception 'approved stores not linked'; end if;
  perform public.gourmet_set_access(target,'approved',array[store_b]);
  select * into row_data from marugo_directory.entries where app_id='gourmet' and user_id=target::text;
  if row_data.affiliation<>'Directory test B' then raise exception 'store replacement not linked'; end if;
  perform public.gourmet_set_admin(target,true);
  select * into row_data from marugo_directory.entries where app_id='gourmet' and user_id=target::text;
  if row_data.status<>'active' or row_data.role<>'管理者' or row_data.affiliation not like '全店舗：%' then raise exception 'admin not linked'; end if;
  perform public.gourmet_set_admin(target,false);
  perform public.gourmet_set_access(target,'revoked');
  select * into row_data from marugo_directory.entries where app_id='gourmet' and user_id=target::text;
  if row_data.status<>'suspended' or row_data.affiliation<>'閲覧不可（停止中）' then raise exception 'stop not linked'; end if;
  perform public.gourmet_delete_user(target,'gourmet-link-'||target||'@example.invalid');
  if exists(select 1 from marugo_directory.entries where user_id=target::text) then raise exception 'deleted user remains'; end if;
  -- Auth's existing profile trigger creates fixture SNS profiles; exclude only those fixtures.
  select jsonb_agg(to_jsonb(e) order by key) into sns_after from marugo_directory.entries e
    where app_id='sns' and user_id not in(actor::text,target::text);
  if sns_before is distinct from sns_after then raise exception 'SNS changed'; end if;
  if has_schema_privilege('authenticated','marugo_directory','usage')
    or has_function_privilege('authenticated','public.marugo_directory_page(uuid,text,text,text,integer)','execute') then raise exception 'directory access widened'; end if;
  if exists(select key from marugo_directory.entries group by key having count(*)>1) then raise exception 'duplicate directory key'; end if;
end $$;
rollback;
select 'PASS: gourmet role/access/stores/deletion linked live; SNS and central authorization unchanged; fixtures rolled back' as result;
