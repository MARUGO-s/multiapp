-- Additive: hour-of-day (Japan time) counts for the selected period and source.
-- Every existing response field and its calculation is unchanged.
create or replace function public.kotonoha_qr_analytics(
  p_owner uuid, p_id uuid, p_days integer default 30, p_source text default 'all'
) returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  v_link kotonoha.qr_links%rowtype;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_start date;
  v_result jsonb;
begin
  if p_owner is null then raise exception 'OWNER_REQUIRED'; end if;
  if p_days is null or p_days not in (7,30,90) then raise exception 'INVALID_DAYS'; end if;
  if p_source is null or p_source not in ('all','qr','button','link','unknown') then raise exception 'INVALID_SOURCE'; end if;
  select * into v_link from kotonoha.qr_links where id=p_id and owner_id=p_owner;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  v_start := v_today - (p_days - 1);
  with events as materialized (
    select (a.accessed_at at time zone 'Asia/Tokyo')::date as day,
      extract(hour from a.accessed_at at time zone 'Asia/Tokyo')::int as hour,
      a.source,a.device,a.browser,coalesce(a.referrer_host,'unknown') as referrer,
      case when a.device <> 'bot' then a.visitor_hash end as visitor,
      a.device='bot' as bot
    from kotonoha.qr_access_logs a
    where a.link_id=p_id
      and a.accessed_at >= (v_start::timestamp at time zone 'Asia/Tokyo')
      and a.accessed_at < ((v_today + 1)::timestamp at time zone 'Asia/Tokyo')
      and (p_source='all' or a.source=p_source)
  ), counts as (
    select day,count(*) as accesses,count(distinct visitor) as uniques,
      count(*) filter (where visitor is null and not bot) as unknowns,
      count(*) filter (where bot) as bots from events group by day
  ), daily as (
    select v_start+s.offset_days as day,coalesce(c.accesses,0) as accesses,
      coalesce(c.uniques,0) as uniques,coalesce(c.unknowns,0) as unknowns,coalesce(c.bots,0) as bots
    from generate_series(0,p_days-1) as s(offset_days)
    left join counts c on c.day=v_start+s.offset_days
  ), hourly as (
    select h.hour,count(e.hour) as accesses,count(distinct e.visitor) as uniques
    from generate_series(0,23) as h(hour)
    left join events e on e.hour=h.hour
    group by h.hour
  ), sources as (
    select source as key,count(*) as count,count(distinct visitor) as "uniqueCount" from events group by source
  ), devices as (
    select device as key,count(*) as count,count(distinct visitor) as "uniqueCount" from events group by device
  ), browsers as (
    select browser as key,count(*) as count,count(distinct visitor) as "uniqueCount" from events group by browser
  ), hosts_ranked as (
    select referrer,row_number() over (order by count(*) desc,referrer) as position from events group by referrer
  ), hosts as (
    -- Deduplicate visitors AFTER merging hosts 11+, not by summing per-host uniques.
    select case when r.position<=10 then e.referrer else 'other_hosts' end as key,
      count(*) as count,count(distinct e.visitor) as "uniqueCount"
    from events e join hosts_ranked r on r.referrer=e.referrer group by 1
  )
  select jsonb_build_object('linkId',p_id,'days',p_days,'source',p_source,
    'startDate',v_start,'endDate',v_today,
    'daily',(select jsonb_agg(jsonb_build_object('date',day,'count',accesses,
      'uniqueCount',uniques,'unknownCount',unknowns,'botCount',bots) order by day) from daily),
    'hourly',(select jsonb_agg(jsonb_build_object('hour',hour,'count',accesses,'uniqueCount',uniques) order by hour) from hourly),
    'periodTotal',(select count(*) from events),
    'periodUnique',(select count(distinct visitor) from events),
    'identifiedAccesses',(select count(*) from events where visitor is not null),
    'unknownAccesses',(select count(*) from events where visitor is null and not bot),
    'botAccesses',(select count(*) from events where bot),
    'total',case when p_source='all' then v_link.scan_count else
      (select count(*) from kotonoha.qr_access_logs a where a.link_id=p_id and a.source=p_source) end,
    'totalUnique',(select count(distinct visitor_hash) from kotonoha.qr_access_logs a
      where a.link_id=p_id and a.device <> 'bot' and (p_source='all' or a.source=p_source)),
    'generatedAt',now(),
    'sources',coalesce((select jsonb_agg(to_jsonb(s) order by count desc,key) from sources s),'[]'::jsonb),
    'devices',coalesce((select jsonb_agg(to_jsonb(d) order by count desc,key) from devices d),'[]'::jsonb),
    'browsers',coalesce((select jsonb_agg(to_jsonb(b) order by count desc,key) from browsers b),'[]'::jsonb),
    'referrers',coalesce((select jsonb_agg(to_jsonb(h) order by count desc,key) from hosts h),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;
revoke all on function public.kotonoha_qr_analytics(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.kotonoha_qr_analytics(uuid,uuid,integer,text) to service_role;
