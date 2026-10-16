-- Entwürfe, Unterschrift per Link, Admin darf Dateien eines Vorgangs ablegen
alter table public.deals drop constraint deals_status_check;
alter table public.deals add constraint deals_status_check check (status = any (array['draft','signing','remote','remote_signed','signed','sealed','sent','cancelled']));
alter table public.deals add column if not exists draft jsonb;

create table public.sign_requests (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  token_hash text not null unique,
  customer_email text not null,
  payload jsonb not null,
  result jsonb,
  status text not null default 'pending' check (status in ('pending','signed','cancelled')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  opened_at timestamptz,
  signed_at timestamptz,
  signed_ip text,
  signed_ua text
);
create index on public.sign_requests(deal_id);
alter table public.sign_requests enable row level security;
create policy sign_requests_read on public.sign_requests for select using (
  exists (select 1 from public.deals d where d.id = sign_requests.deal_id and (d.seller_id = auth.uid() or public.is_admin())));
create policy sign_requests_cancel on public.sign_requests for update using (
  exists (select 1 from public.deals d where d.id = sign_requests.deal_id and (d.seller_id = auth.uid() or public.is_admin())))
  with check (status = 'cancelled');

alter policy contracts_insert on storage.objects with check (
  bucket_id = 'contracts' and exists (select 1 from public.deals d where d.id::text = (storage.foldername(objects.name))[1] and (d.seller_id = auth.uid() or public.is_admin())));
