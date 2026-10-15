-- Prusseit Sign: Grundschema
-- Verkäufer (@autowelt-prusseit.de) sehen ihre eigenen Vorgänge, Admins alle.
-- Prüfprotokoll ist nur anhängbar (kein Update/Delete), jeder Eintrag verkettet per SHA-256 mit dem vorherigen.

create extension if not exists pgcrypto with schema extensions;

-- ---------- Profile ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  phone text,
  role text not null default 'seller' check (role in ('seller','admin')),
  created_at timestamptz not null default now()
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- Registrierung nur mit Firmenadresse; Admin-Konto fest hinterlegt.
create or replace function public.check_signup_domain() returns trigger
language plpgsql security definer set search_path = public as $$
declare mail text := lower(new.email);
begin
  if not (mail like '%@autowelt-prusseit.de' or mail = 'dennis.knoepfle@prusseit-group.de') then
    raise exception 'Registrierung nur mit einer @autowelt-prusseit.de-Adresse möglich';
  end if;
  return new;
end $$;

create trigger check_signup_domain
  before insert on auth.users
  for each row execute function public.check_signup_domain();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare mail text := lower(new.email);
begin
  insert into public.profiles (id, email, full_name, role)
  values (new.id, mail, new.raw_user_meta_data->>'full_name',
          case when mail = 'dennis.knoepfle@prusseit-group.de' then 'admin' else 'seller' end);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Vorgänge ----------
create table public.deals (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles(id) default auth.uid(),
  contract_no text,
  vehicle text,
  customer_name text not null,
  customer_email text,
  status text not null default 'draft'
    check (status in ('draft','signing','signed','sealed','sent','cancelled')),
  fields jsonb not null default '[]',          -- Unterschrifts- und Textfelder (Seite, Position, Rolle, Wert)
  original_path text,                          -- Storage: contracts/<deal>/original.pdf
  original_sha256 text,
  final_path text,
  final_sha256 text,
  page_count int,
  locked_at timestamptz,                       -- ab erster Unterschrift unveränderlich
  signed_at timestamptz,
  sealed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index deals_seller_idx on public.deals(seller_id, created_at desc);

-- Gesperrte Vorgänge: Original, Hash und Felder dürfen sich nicht mehr ändern.
create or replace function public.guard_deal() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if old.locked_at is not null and (
       new.original_sha256 is distinct from old.original_sha256
    or new.original_path   is distinct from old.original_path
    or new.fields          is distinct from old.fields
    or new.locked_at       is distinct from old.locked_at) then
    raise exception 'Vorgang ist gesperrt';
  end if;
  if old.final_sha256 is not null and new.final_sha256 is distinct from old.final_sha256 then
    raise exception 'Finales PDF ist bereits festgeschrieben';
  end if;
  return new;
end $$;
create trigger guard_deal before update on public.deals
  for each row execute function public.guard_deal();

-- ---------- Unterschriften ----------
create table public.signatures (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete restrict,
  field_id text not null,
  signer_role text not null check (signer_role in ('customer','seller')),
  signer_name text not null,
  biometric_hash text not null,                -- SHA-256 der Schreibdynamik
  raw_path text,                               -- verschlüsselte Rohdaten im Storage, nicht im PDF
  signed_at timestamptz not null default now(),
  user_agent text,
  unique (deal_id, field_id)
);

-- ---------- Prüfprotokoll (append-only, Hash-Kette) ----------
create table public.audit_events (
  id bigint generated always as identity primary key,
  deal_id uuid not null references public.deals(id) on delete restrict,
  at timestamptz not null default now(),
  actor uuid default auth.uid(),
  event text not null,
  details jsonb not null default '{}',
  prev_hash text,
  hash text not null default ''
);
create index audit_deal_idx on public.audit_events(deal_id, id);

create or replace function public.chain_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.at := now();
  new.actor := auth.uid();
  select hash into new.prev_hash from public.audit_events
    where deal_id = new.deal_id order by id desc limit 1;
  new.hash := encode(extensions.digest(
    coalesce(new.prev_hash,'') || new.deal_id::text || new.at::text ||
    coalesce(new.actor::text,'') || new.event || new.details::text, 'sha256'), 'hex');
  return new;
end $$;
create trigger chain_audit before insert on public.audit_events
  for each row execute function public.chain_audit();

-- ---------- Push-Abos (Verkaufsmeldungen an Admins) ----------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  endpoint text not null unique,
  keys jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.deals enable row level security;
alter table public.signatures enable row level security;
alter table public.audit_events enable row level security;
alter table public.push_subscriptions enable row level security;

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));

create policy deals_read on public.deals for select to authenticated
  using (seller_id = auth.uid() or public.is_admin());
create policy deals_insert on public.deals for insert to authenticated
  with check (seller_id = auth.uid());
create policy deals_update on public.deals for update to authenticated
  using (seller_id = auth.uid() or public.is_admin())
  with check (seller_id = auth.uid() or public.is_admin());

create policy signatures_read on public.signatures for select to authenticated
  using (exists (select 1 from public.deals d where d.id = deal_id and (d.seller_id = auth.uid() or public.is_admin())));
create policy signatures_insert on public.signatures for insert to authenticated
  with check (exists (select 1 from public.deals d where d.id = deal_id and d.seller_id = auth.uid()));

create policy audit_read on public.audit_events for select to authenticated
  using (exists (select 1 from public.deals d where d.id = deal_id and (d.seller_id = auth.uid() or public.is_admin())));
create policy audit_insert on public.audit_events for insert to authenticated
  with check (exists (select 1 from public.deals d where d.id = deal_id and (d.seller_id = auth.uid() or public.is_admin())));

create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- Storage: privater Bucket für Verträge ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contracts', 'contracts', false, 52428800, array['application/pdf','application/octet-stream'])
on conflict (id) do nothing;

-- Pfad: <deal_id>/<datei>; Zugriff nur für Verkäufer des Vorgangs oder Admin. Kein Überschreiben/Löschen.
create policy contracts_read on storage.objects for select to authenticated
  using (bucket_id = 'contracts' and exists (
    select 1 from public.deals d where d.id::text = (storage.foldername(name))[1]
      and (d.seller_id = auth.uid() or public.is_admin())));
create policy contracts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'contracts' and exists (
    select 1 from public.deals d where d.id::text = (storage.foldername(name))[1]
      and d.seller_id = auth.uid()));
