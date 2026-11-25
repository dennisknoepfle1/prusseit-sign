-- CarVertical und Carfax sind Pflicht. Notfreigabe: Ein Admin erlaubt einem Verkäufer EINEN Vertrag ohne
-- (vollständige oder passende) Berichte. Verkäufer sehen die Tabelle nicht, sie lösen die Freigabe nur über
-- use_report_waiver() ein, und auch nur, wenn ihnen tatsächlich ein Bericht fehlt.
set lock_timeout = '5s';

create table if not exists public.report_waivers (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles(id) on delete cascade,
  contract_no text,                                   -- optional: nur für diese Vorgangsnummer
  reason text not null check (length(trim(reason)) > 0),
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  revoked_at timestamptz,
  used_at timestamptz,
  used_contract_no text,
  used_missing text[]
);
create index if not exists report_waivers_seller_idx on public.report_waivers(seller_id, created_at desc);
alter table public.report_waivers enable row level security;

drop policy if exists report_waivers_admin_read on public.report_waivers;
create policy report_waivers_admin_read on public.report_waivers for select to authenticated using (public.is_admin());
drop policy if exists report_waivers_admin_insert on public.report_waivers;
create policy report_waivers_admin_insert on public.report_waivers for insert to authenticated
  with check (public.is_admin() and created_by = auth.uid() and used_at is null and revoked_at is null);
drop policy if exists report_waivers_admin_update on public.report_waivers;
create policy report_waivers_admin_update on public.report_waivers for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Freigabe einlösen: nimmt die älteste gültige Freigabe des angemeldeten Nutzers (passende Vorgangsnummer zuerst)
create or replace function public.use_report_waiver(p_contract_no text, p_missing text[])
returns json language plpgsql security definer set search_path = public as $$
declare w public.report_waivers; nr text := nullif(regexp_replace(lower(coalesce(p_contract_no,'')), '[^a-z0-9]', '', 'g'), '');
begin
  if auth.uid() is null or coalesce(array_length(p_missing, 1), 0) = 0 then return json_build_object('ok', false); end if;
  select * into w from public.report_waivers
   where seller_id = auth.uid() and used_at is null and revoked_at is null and expires_at > now()
     and (contract_no is null or regexp_replace(lower(contract_no), '[^a-z0-9]', '', 'g') = nr)
   order by (contract_no is null), created_at
   limit 1 for update skip locked;
  if not found then return json_build_object('ok', false); end if;
  update public.report_waivers set used_at = now(), used_contract_no = p_contract_no, used_missing = p_missing where id = w.id;
  return json_build_object('ok', true, 'id', w.id, 'reason', w.reason,
    'by', (select coalesce(full_name, email) from public.profiles where id = w.created_by));
end $$;
revoke execute on function public.use_report_waiver(text, text[]) from public, anon;
grant execute on function public.use_report_waiver(text, text[]) to authenticated;
