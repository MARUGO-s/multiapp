-- Random QR-only fixtures; no Auth/Storage/business rows. Always roll back.
begin;
do $test$
declare
  v_owner uuid := gen_random_uuid();
  v_id uuid := gen_random_uuid();
  v_code text := left(replace(gen_random_uuid()::text,'-',''),12);
  v_event uuid := gen_random_uuid();
  v_a text := repeat('a',64);
  v_b text := repeat('b',64);
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_data jsonb;
begin
  perform public.kotonoha_qr('create',v_owner,v_id,
    jsonb_build_object('code',v_code,'title','Unique transaction fixture','targetUrl','https://example.com/'));
  v_data := public.kotonoha_qr_analytics(v_owner,v_id,7,'all');
  assert (v_data->>'periodUnique')::int=0;
  assert jsonb_array_length(v_data->'daily')=7;
  perform public.kotonoha_qr_scan_unique(v_code,v_event,'qr',null,'mobile','safari',null,v_a);
  -- Lost response: changing payload on a retry must not create/overwrite a row.
  perform public.kotonoha_qr_scan_unique(v_code,v_event,'button',null,'desktop','chrome',null,v_b);
  assert (select visitor_hash=v_a and source='qr' from kotonoha.qr_access_logs where link_id=v_id and event_id=v_event);
  perform public.kotonoha_qr_scan_unique(v_code,gen_random_uuid(),'button',null,'mobile','safari',null,v_a);
  perform public.kotonoha_qr_scan_unique(v_code,gen_random_uuid(),'qr',null,'mobile','safari',null,v_b);
  perform public.kotonoha_qr_scan_unique(v_code,gen_random_uuid(),'qr',null,'bot','other',null,v_a);
  perform public.kotonoha_qr_scan(v_code,gen_random_uuid(),'link'); -- old client
  assert (select scan_count=5 from kotonoha.qr_links where id=v_id);
  insert into kotonoha.qr_access_logs(link_id,event_id,accessed_at,source,device,visitor_hash) values
    (v_id,gen_random_uuid(),((v_today-1)::timestamp at time zone 'Asia/Tokyo'),'qr','mobile',v_a),
    (v_id,gen_random_uuid(),((v_today-6)::timestamp at time zone 'Asia/Tokyo')-interval '1 second','qr','mobile',repeat('c',64));
  update kotonoha.qr_links set scan_count=7 where id=v_id;
  v_data := public.kotonoha_qr_analytics(v_owner,v_id,7,'all');
  assert (v_data->>'periodTotal')::int=6;
  assert (v_data->>'periodUnique')::int=2;
  assert (v_data->>'totalUnique')::int=3;
  assert (v_data->>'identifiedAccesses')::int=4;
  assert (v_data->>'unknownAccesses')::int=1;
  assert (v_data->>'botAccesses')::int=1;
  assert (v_data->'daily'->5->>'uniqueCount')::int=1;
  assert (v_data->'daily'->6->>'uniqueCount')::int=2;
  assert (v_data->'daily'->0->>'uniqueCount')::int=0;
  assert (select sum((d->>'uniqueCount')::int) from jsonb_array_elements(v_data->'daily') d)=3,
    'Daily uniques are not additive across days';
  v_data := public.kotonoha_qr_analytics(v_owner,v_id,7,'button');
  assert (v_data->>'periodUnique')::int=1 and (v_data->>'periodTotal')::int=1;
  v_data := public.kotonoha_qr_analytics(v_owner,v_id,90,'all');
  assert (v_data->>'periodUnique')::int=3;
  -- 12 hosts have the SAME visitor. Other-hosts bucket must deduplicate too.
  insert into kotonoha.qr_access_logs(link_id,event_id,source,device,visitor_hash,referrer_host)
    select v_id,gen_random_uuid(),'button','mobile',v_a,'host-'||n||'.example' from generate_series(1,12) n;
  update kotonoha.qr_links set scan_count=19 where id=v_id;
  v_data := public.kotonoha_qr_analytics(v_owner,v_id,7,'all');
  assert exists(select 1 from jsonb_array_elements(v_data->'referrers') d where d->>'key'='other_hosts' and (d->>'uniqueCount')::int=1);
  assert (v_data->>'periodUnique')::int=2;
  assert (select sum((d->>'count')::int) from jsonb_array_elements(v_data->'referrers') d)=18;
  begin
    perform public.kotonoha_qr_analytics(gen_random_uuid(),v_id,7,'all');
    raise exception 'OWNER_ISOLATION_FAILED';
  exception when no_data_found then null;
  end;
  begin
    perform public.kotonoha_qr_scan_unique(v_code,gen_random_uuid(),'qr',null,'mobile','safari',null,'not-a-hash');
    raise exception 'INVALID_HASH_ACCEPTED';
  exception when check_violation then null;
  end;
  update kotonoha.qr_links set active=false where id=v_id;
  begin
    perform public.kotonoha_qr_scan_unique(v_code,gen_random_uuid());
    raise exception 'INACTIVE_ACCEPTED';
  exception when others then if sqlerrm <> 'INACTIVE' then raise; end if; end;
  update kotonoha.qr_links set active=false,deleted_at=now() where id=v_id;
  begin
    perform public.kotonoha_qr_scan_unique(v_code,gen_random_uuid());
    raise exception 'TRASH_ACCEPTED';
  exception when others then if sqlerrm <> 'INACTIVE' then raise; end if; end;
  assert not has_function_privilege('anon','public.kotonoha_qr_scan_unique(text,uuid,text,text,text,text,text,text)','execute');
  assert not has_function_privilege('authenticated','public.kotonoha_qr_scan_unique(text,uuid,text,text,text,text,text,text)','execute');
  assert has_function_privilege('service_role','public.kotonoha_qr_scan_unique(text,uuid,text,text,text,text,text,text)','execute');
  assert not has_table_privilege('anon','kotonoha.qr_access_logs','select');
  assert not has_table_privilege('authenticated','kotonoha.qr_access_logs','select');
  assert not (v_data::text like '%'||v_a||'%'), 'Never expose visitor hashes in analytics';
end;
$test$;
rollback;
