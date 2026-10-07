-- Additive and QR-only. Existing accesses remain explicitly unidentified.
alter table kotonoha.qr_access_logs
  add column visitor_hash text check (visitor_hash ~ '^[0-9a-f]{64}$');
comment on column kotonoha.qr_access_logs.visitor_hash is
  'SHA-256 of high-entropy browser ID scoped to QR code; null for legacy/unavailable/bot. Never an IP or Auth ID.';
create index qr_access_logs_link_visitor_idx
  on kotonoha.qr_access_logs(link_id, visitor_hash) where visitor_hash is not null;

-- A separate entry point keeps old deployed redirect/API versions working.
create function public.kotonoha_qr_scan_unique(
  p_code text, p_event uuid, p_source text default 'unknown',
  p_referrer_host text default null, p_device text default 'unknown',
  p_browser text default 'unknown', p_user_agent text default null,
  p_visitor_hash text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_link kotonoha.qr_links%rowtype;
  v_inserted integer;
begin
  select * into v_link from kotonoha.qr_links where code=p_code for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  if not v_link.active or v_link.deleted_at is not null then
    raise exception 'INACTIVE' using errcode='P0001';
  end if;
  insert into kotonoha.qr_access_logs(link_id,event_id,source,referrer_host,device,browser,user_agent,visitor_hash)
    values(v_link.id,p_event,p_source,p_referrer_host,p_device,p_browser,left(p_user_agent,512),
      case when p_device='bot' then null else p_visitor_hash end)
    on conflict(link_id,event_id) do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted=1 then
    update kotonoha.qr_links set scan_count=scan_count+1,last_accessed_at=now() where id=v_link.id;
  end if;
  return jsonb_build_object('targetUrl',v_link.target_url);
end;
$function$;
revoke all on function public.kotonoha_qr_scan_unique(text,uuid,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.kotonoha_qr_scan_unique(text,uuid,text,text,text,text,text,text) to service_role;

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
