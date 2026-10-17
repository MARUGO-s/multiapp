-- Expand only the existing immutable validator. Keep QR rows, columns, RPCs,
-- upload retry identity, Storage, history and all existing privileges unchanged.
create or replace function kotonoha.qr_logo_valid(p_value jsonb) returns boolean
language sql immutable set search_path = '' as $function$
  select p_value is null or p_value = 'null'::jsonb or (
    pg_catalog.jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') = any(array[
      'instagram-black','instagram-gradient','instagram-white','line-android','line-ios',
      'line-icons8-100','line-icons8-50','instagram-icons8-100','instagram-icons8-50',
      'x-icons8-100','x-icons8-50','facebook-icons8-100','facebook-icons8-48','facebook-icons8-50','facebook-icons8-96',
      'store-marugo-d','store-marugo-es','store-371bar','store-blu-nero','store-briccola',
      'store-cava','store-claudia2','store-donaiya','store-erics','store-koruri',
      'store-marugo-1','store-marugo-2','store-marugo-grande','store-marugo-marunouchi',
      'store-marugo-otto','store-marugo-shinbashi','store-marugo-yotsuya','store-mitan',
      'store-pelota','store-sobaju','store-violet','store-x-c','store-yakiniku'
    ]::text[])
  );
$function$;
revoke all on function kotonoha.qr_logo_valid(jsonb) from public,anon,authenticated;
grant execute on function kotonoha.qr_logo_valid(jsonb) to service_role;
