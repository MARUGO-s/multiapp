-- Hour-of-day analytics in Japan time. All fixtures roll back.
begin;
do $test$
declare
  v_owner uuid := gen_random_uuid();
  v_id uuid := gen_random_uuid();
  v_code text := left(replace(gen_random_uuid()::text,'-',''),12);
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_data jsonb;
begin
  perform public.kotonoha_qr('create',v_owner,v_id,
    jsonb_build_object('code',v_code,'title','Hourly fixture','targetUrl','https://example.com/'));
  v_data := public.kotonoha_qr_analytics(v_owner,v_id,7,'all');
  assert jsonb_array_length(v_data->'hourly')=24, 'hourly has 24 slots';
  assert (select bool_and((h->>'count')::int=0) from jsonb_array_elements(v_data->'hourly') h), 'empty hours are zero';
  assert (select array_agg((h->>'hour')::int order by ord)
          from jsonb_array_elements(v_data->'hourly') with ordinality t(h,ord)) = array(select generate_series(0,23)),
    'hours are 0..23 in order';

  -- 09:15 JST today: two QR scans and one button click.
  insert into kotonoha.qr_access_logs(link_id,event_id,accessed_at,source,visitor_hash)
    values (v_id,gen_random_uuid(),((v_today + time '09:15')::timestamp at time zone 'Asia/Tokyo'),'qr',repeat('a',64)),
           (v_id,gen_random_uuid(),((v_today + time '09:59:59')::timestamp at time zone 'Asia/Tokyo'),'qr',repeat('a',64)),
           (v_id,gen_random_uuid(),((v_today + time '09:00')::timestamp at time zone 'Asia/Tokyo'),'button',null);
  -- 00:30 JST today is 15:30 UTC the previous day; it must count as hour 0.
  insert into kotonoha.qr_access_logs(link_id,event_id,accessed_at,source)
    values (v_id,gen_random_uuid(),((v_today + time '00:30')::timestamp at time zone 'Asia/Tokyo'),'qr');
  -- 23:30 JST six days ago is still inside a 7-day window.
  insert into kotonoha.qr_access_logs(link_id,event_id,accessed_at,source)
    values (v_id,gen_random_uuid(),(((v_today-6) + time '23:30')::timestamp at time zone 'Asia/Tokyo'),'link');
  -- 09:30 JST seven days ago is outside the 7-day window.
  insert into kotonoha.qr_access_logs(link_id,event_id,accessed_at,source)
    values (v_id,gen_random_uuid(),(((v_today-7) + time '09:30')::timestamp at time zone 'Asia/Tokyo'),'qr');

  v_data := public.kotonoha_qr_analytics(v_owner,v_id,7,'all');
  assert (v_data->'hourly'->9->>'count')::int=3, 'hour 9 counts all three';
  assert (v_data->'hourly'->9->>'uniqueCount')::int=1, 'hour 9 unique uses the visitor hash';
  assert (v_data->'hourly'->0->>'count')::int=1, 'JST midnight hour';
  assert (v_data->'hourly'->23->>'count')::int=1, 'late hour inside window';
  assert (v_data->'hourly'->15->>'count')::int=0, 'UTC hour is not used';
  assert (select sum((h->>'count')::int) from jsonb_array_elements(v_data->'hourly') h)
         = (v_data->>'periodTotal')::int, 'hourly sums to the period total';

  v_data := public.kotonoha_qr_analytics(v_owner,v_id,7,'button');
  assert (v_data->'hourly'->9->>'count')::int=1, 'source filter applies';
  assert (select sum((h->>'count')::int) from jsonb_array_elements(v_data->'hourly') h)=1;

  v_data := public.kotonoha_qr_analytics(v_owner,v_id,30,'all');
  assert (v_data->'hourly'->9->>'count')::int=4, 'longer window includes the older 09:30';
  -- Existing response fields are unchanged.
  assert jsonb_array_length(v_data->'daily')=30;
  assert (v_data->>'periodTotal')::int=6;
end
$test$;
rollback;
