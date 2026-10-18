-- Runtime validation/privileges on disposable PostgreSQL, never a remote DB.
begin;
set local role service_role;
do $validation$
declare own uuid:=gen_random_uuid(); item uuid:=gen_random_uuid(); upload uuid:=gen_random_uuid(); bad jsonb; payload jsonb; control integer; caption text; operation text; logo jsonb;
begin
 perform public.kotonoha_qr('create',own,item,'{"code":"captionVal01","title":"Validation","targetUrl":"https://example.com/","logoId":"store-marugo-d","storeName":"keep"}');
 perform public.kotonoha_qr_file('init',own,upload,'{"title":"File","fileName":"menu.pdf","mime":"application/pdf","size":100,"logoId":"store-marugo-d","storeName":"keep"}');
 -- Exercise every JSON type, full controls set (not just newline), length limits,
 -- and all write RPCs rather than relying only on the helper implementation.
 for bad in select value from jsonb_array_elements('[true,false,0,1,{},[],["storeName"]]')
 union all select to_jsonb(repeat('😀',81)) union all select to_jsonb(repeat('a',81))
 union all select to_jsonb('x'||chr(n)) from generate_series(1,31) n
 union all select to_jsonb(chr(n)||'x') from generate_series(127,159) n
 union all select to_jsonb('x'||chr(n)||'y') from unnest(array[8232,8233]) n loop
  payload:=jsonb_build_object('code','captionVal02','title','Validation','targetUrl','https://example.com/','fileName','menu.pdf','mime','application/pdf','size',100,'logoId','store-marugo-d','storeName',bad);
  foreach operation in array array['create','logo','init'] loop
   begin
    if operation='init' then perform public.kotonoha_qr_file(operation,own,gen_random_uuid(),payload);
    else perform public.kotonoha_qr(operation,own,case when operation='logo' then item else gen_random_uuid() end,payload); end if;
    raise exception 'invalid caption accepted: % %',operation,bad;
   exception when others then if sqlerrm<>'INVALID_STORE_NAME' then raise; end if; end;
  end loop;
 end loop;
 -- U+0000 is rejected by PostgreSQL JSON parsing, before any function can run.
 begin perform '"\u0000"'::jsonb; raise exception 'NUL accepted'; exception when untranslatable_character then null; end;
 begin perform '"\ud800"'::jsonb; raise exception 'lone surrogate accepted'; exception when invalid_text_representation then null; end;
 foreach logo in array array['null'::jsonb,'"instagram-black"'::jsonb,'"store-forged"'::jsonb,'true'::jsonb,'[]'::jsonb,'{}'::jsonb] loop
  foreach caption in array array['','name'] loop
   begin perform kotonoha.qr_store_name(logo,to_jsonb(caption)); raise exception 'non-STORE caption accepted';
   exception when others then if sqlerrm<>'INVALID_STORE_NAME' then raise; end if; end;
  end loop;
 end loop;
 assert kotonoha.qr_store_name('"store-marugo-d"',to_jsonb(repeat('😀',80)))=repeat('😀',80);
 assert kotonoha.qr_store_name('"store-marugo-d"',to_jsonb(repeat(' ',100)))='';
 foreach control in array array[32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8239,8287,12288,65279] loop
  assert kotonoha.qr_store_name('"store-marugo-d"',to_jsonb(chr(control)||'name'||chr(control)))='name', 'JS trim equivalence';
 end loop;
 assert kotonoha.qr_store_name('"store-marugo-d"',to_jsonb(chr(8203)))=chr(8203), 'zero-width space is not JS trim whitespace';
 -- Array/scalar membership cannot masquerade as a PATCH object.
 for bad in select value from jsonb_array_elements('["logoId",["logoId","storeName"],null,true,{}, {"storeName":"name"}]') loop
  begin perform public.kotonoha_qr('logo',own,item,bad); raise exception 'non-object or missing logoId accepted';
  exception when others then if sqlerrm<>'INVALID_LOGO' then raise; end if; end;
 end loop;
 -- Direct writes are owner-only (service_role itself cannot UPDATE tables).
 -- Test CHECK enforcement as the disposable DB owner without widening grants.
 execute 'reset role';
 -- Direct table writes cannot bypass normalized, STORE-only validation.
 foreach caption in array array[repeat('😀',81),'x'||chr(1),'x'||chr(159),'x'||chr(8232)] loop
  begin update kotonoha.qr_links set store_name=caption where id=item; raise exception 'bad direct link write';
  exception when others then if sqlerrm<>'INVALID_STORE_NAME' then raise; end if; end;
  begin update kotonoha.qr_files set initial_store_name=caption where id=upload; raise exception 'bad direct file write';
  exception when others then if sqlerrm<>'INVALID_STORE_NAME' then raise; end if; end;
 end loop;
 begin update kotonoha.qr_links set store_name=' padded ' where id=item; raise exception 'unnormalized direct write'; exception when check_violation then null; end;
 begin update kotonoha.qr_links set logo_id=null where id=item; raise exception 'caption with no logo'; exception when others then if sqlerrm<>'INVALID_STORE_NAME' then raise; end if; end;
 assert (select store_name='keep' from kotonoha.qr_links where id=item);
 assert (select initial_store_name='keep' from kotonoha.qr_files where id=upload);
end $validation$;
reset role;
do $acl$
declare role_name text; signature text;
begin
 foreach signature in array array['kotonoha.qr_store_name(jsonb,jsonb)','public.kotonoha_qr(text,uuid,uuid,jsonb)','public.kotonoha_qr_file(text,uuid,uuid,jsonb)'] loop
 assert has_function_privilege('service_role',signature,'execute');
 foreach role_name in array array['anon','authenticated'] loop
 assert not has_function_privilege(role_name,signature,'execute');
 end loop;
 end loop;
 assert (select provolatile='i' and not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='kotonoha.qr_store_name(jsonb,jsonb)'::regprocedure);
 foreach role_name in array array['anon','authenticated'] loop
 execute format('set local role %I',role_name);
 begin perform kotonoha.qr_store_name('"store-marugo-d"','"name"'); raise exception 'client helper access'; exception when insufficient_privilege then null; end;
 begin perform public.kotonoha_qr('create',gen_random_uuid(),gen_random_uuid(),'{}'); raise exception 'client QR access'; exception when insufficient_privilege then null; end;
 begin perform public.kotonoha_qr_file('init',gen_random_uuid(),gen_random_uuid(),'{}'); raise exception 'client file access'; exception when insufficient_privilege then null; end;
 begin perform store_name from kotonoha.qr_links; raise exception 'client column read'; exception when insufficient_privilege then null; end;
 execute 'reset role';
 end loop;
end $acl$;
rollback;
select 'PASS: all JSON types, all C0/C1/line separators, codepoint length, JS trim, direct CHECKs and real role privileges';
