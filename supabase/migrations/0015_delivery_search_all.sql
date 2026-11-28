-- Auslieferung: alle jemals unterschriebenen Verträge in der Suche (vorher nur die 40 neuesten).
create or replace function public.delivery_search(q text) returns table (
  id uuid, contract_no text, vehicle text, customer_name text, signed_at timestamptz,
  seller_name text, original_path text, delivery_id uuid, delivery_status text, delivery_by text, delivered_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare t text := '%' || coalesce(trim(q), '') || '%';
begin
  if not public.can_deliver() then raise exception 'Kein Zugang zum Auslieferungsportal'; end if;
  return query
    select d.id, d.contract_no, d.vehicle, d.customer_name, d.signed_at,
           coalesce(p.full_name, p.email), d.original_path,
           x.id, x.status, coalesce(xp.full_name, xp.email), x.done_at
    from public.deals d
    left join public.profiles p on p.id = d.seller_id
    left join lateral (select * from public.deliveries v where v.deal_id = d.id and v.status <> 'cancelled'
                       order by (v.status = 'done') desc, v.created_at desc limit 1) x on true
    left join public.profiles xp on xp.id = x.created_by
    where d.final_path is not null and d.status <> 'cancelled'
      and (coalesce(trim(q), '') = '' or d.customer_name ilike t or d.contract_no ilike t or d.vehicle ilike t
           or replace(d.contract_no, '#', '') = replace(trim(q), '#', ''))
    order by d.signed_at desc nulls last
    limit 2000;
end $$;
revoke execute on function public.delivery_search(text) from public, anon;
grant execute on function public.delivery_search(text) to authenticated;
