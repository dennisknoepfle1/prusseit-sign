-- Auslieferungsportal: Auslieferungsdienst und Verkäufer liefern Fahrzeuge im Haus aus (Zugang „Auslieferung“ je Konto).
-- Ergebnis je Auslieferung: ausgefülltes CarGarantie-Übergabezertifikat + eigene Auslieferungscheckliste (PDF),
-- abgelegt unter contracts/<deal>/auslieferung/<delivery>-*.pdf. Unterschriften entstehen im Portal, nicht auf Papier.

-- ---------- Zugänge: pro Konto „Sign“ und/oder „Auslieferung“ ----------
-- Dennis schaltet pro Person frei: nur Sign, nur Auslieferung oder beides. Admins haben immer beides.
alter table public.profiles add column if not exists can_sign boolean not null default true;
alter table public.profiles add column if not exists can_deliver boolean not null default false;

-- Nur Admins (oder der Server) ändern Zugänge, auch nicht am eigenen Profil.
create or replace function public.guard_profile_access() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.can_sign is distinct from old.can_sign or new.can_deliver is distinct from old.can_deliver)
     and not public.is_admin() and current_user not in ('postgres','service_role','supabase_admin') then
    raise exception 'Zugänge ändern nur Admins';
  end if;
  return new;
end $$;
revoke execute on function public.guard_profile_access() from public, anon, authenticated;
drop trigger if exists guard_profile_access on public.profiles;
create trigger guard_profile_access before update on public.profiles
  for each row execute function public.guard_profile_access();

-- Freigaben vorab per E-Mail (auch ohne Firmenadresse, z. B. Auslieferungsdienst). Nur Admins pflegen die Liste.
create table if not exists public.access_invites (
  email text primary key check (email = lower(email) and email like '%@%'),
  full_name text,
  can_sign boolean not null default false,
  can_deliver boolean not null default true,
  added_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.access_invites enable row level security;
drop policy if exists access_invites_admin on public.access_invites;
create policy access_invites_admin on public.access_invites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Registrierung: Firmenadresse wie bisher, zusätzlich freigegebene Adressen.
create or replace function public.check_signup_domain() returns trigger
language plpgsql security definer set search_path = public as $$
declare mail text := lower(new.email);
begin
  if not (mail like '%@autowelt-prusseit.de' or mail = 'dennis.knoepfle@prusseit-group.de'
          or exists (select 1 from public.access_invites i where i.email = mail and (i.can_sign or i.can_deliver))) then
    raise exception 'Registrierung nur mit einer @autowelt-prusseit.de-Adresse möglich';
  end if;
  return new;
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare mail text := lower(new.email); inv public.access_invites;
begin
  select * into inv from public.access_invites where email = mail;
  insert into public.profiles (id, email, full_name, role, can_sign, can_deliver)
  values (new.id, mail, coalesce(new.raw_user_meta_data->>'full_name', inv.full_name),
          case when mail = 'dennis.knoepfle@prusseit-group.de' then 'admin' else 'seller' end,
          coalesce(inv.can_sign, mail like '%@autowelt-prusseit.de' or mail = 'dennis.knoepfle@prusseit-group.de'),
          coalesce(inv.can_deliver, mail = 'dennis.knoepfle@prusseit-group.de'));
  return new;
end $$;

create or replace function public.can_sign() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and (p.role = 'admin' or p.can_sign));
$$;
create or replace function public.can_deliver() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and (p.role = 'admin' or p.can_deliver));
$$;
revoke execute on function public.can_sign(), public.can_deliver() from public, anon;
grant execute on function public.can_sign(), public.can_deliver() to authenticated;

-- Neue Verträge nur mit Sign-Zugang.
drop policy if exists deals_insert on public.deals;
create policy deals_insert on public.deals for insert to authenticated
  with check (seller_id = auth.uid() and public.can_sign());

-- Admin: Zugang eines Kontos setzen
create or replace function public.set_access(p_user uuid, p_sign boolean, p_deliver boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Nur für Admins'; end if;
  update public.profiles set can_sign = p_sign, can_deliver = p_deliver where id = p_user and role <> 'admin';
end $$;
revoke execute on function public.set_access(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_access(uuid, boolean, boolean) to authenticated;

-- ---------- Auslieferungen ----------
create table if not exists public.deliveries (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete restrict,
  created_by uuid not null default auth.uid() references public.profiles(id),
  status text not null default 'open' check (status in ('open','done','cancelled')),
  data jsonb not null default '{}',          -- Eingaben im Portal (Haken, km-Stand, Namen, Zeitpunkte der Unterschriften)
  cert_path text, cert_sha256 text,           -- CarGarantie-Übergabezertifikat
  list_path text, list_sha256 text,           -- Auslieferungscheckliste
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists deliveries_deal_idx on public.deliveries(deal_id, created_at desc);
create unique index if not exists deliveries_one_done on public.deliveries(deal_id) where status = 'done';
alter table public.deliveries enable row level security;

create or replace function public.guard_delivery() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if old.status = 'done' then raise exception 'Auslieferung ist abgeschlossen'; end if;
  if new.deal_id is distinct from old.deal_id or new.created_by is distinct from old.created_by then
    raise exception 'Vorgang und Auslieferer sind fest';
  end if;
  return new;
end $$;
drop trigger if exists guard_delivery on public.deliveries;
create trigger guard_delivery before update on public.deliveries
  for each row execute function public.guard_delivery();

drop policy if exists deliveries_read on public.deliveries;
create policy deliveries_read on public.deliveries for select to authenticated using (
  created_by = auth.uid() or public.is_admin()
  or exists (select 1 from public.deals d where d.id = deliveries.deal_id and d.seller_id = auth.uid()));
drop policy if exists deliveries_insert on public.deliveries;
create policy deliveries_insert on public.deliveries for insert to authenticated with check (
  created_by = auth.uid() and status = 'open' and public.can_deliver()
  and exists (select 1 from public.deals d where d.id = deliveries.deal_id and d.final_path is not null and d.status <> 'cancelled'));
drop policy if exists deliveries_update on public.deliveries;
create policy deliveries_update on public.deliveries for update to authenticated
  using ((created_by = auth.uid() and public.can_deliver()) or public.is_admin())
  with check ((created_by = auth.uid() and public.can_deliver()) or public.is_admin());

-- Suche im Archiv für das Portal: nur unterschriebene Verträge, nur die nötigen Angaben.
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
    limit 40;
end $$;
revoke execute on function public.delivery_search(text) from public, anon;
grant execute on function public.delivery_search(text) to authenticated;

-- Abschluss: Dokumente festschreiben und ins Prüfprotokoll des Vorgangs.
create or replace function public.finish_delivery(p_id uuid, p_data jsonb, p_cert_path text, p_cert_sha text, p_list_path text, p_list_sha text)
returns void language plpgsql security definer set search_path = public as $$
declare v public.deliveries;
begin
  select * into v from public.deliveries where id = p_id for update;
  if v.id is null or (v.created_by <> auth.uid() and not public.is_admin()) or not public.can_deliver() then raise exception 'Keine Berechtigung'; end if;
  if v.status = 'done' then return; end if;  -- Wiederholung aus dem Ausgangskorb
  if p_cert_path not like v.deal_id::text || '/auslieferung/%' or p_list_path not like v.deal_id::text || '/auslieferung/%' then raise exception 'Falscher Ablageort'; end if;
  update public.deliveries set status = 'done', data = p_data, cert_path = p_cert_path, cert_sha256 = p_cert_sha,
    list_path = p_list_path, list_sha256 = p_list_sha, done_at = now() where id = p_id;
  insert into public.audit_events (deal_id, event, details)
    values (v.deal_id, 'delivered', jsonb_build_object('delivery', p_id, 'cert_sha256', p_cert_sha, 'list_sha256', p_list_sha,
            'km', p_data->>'km', 'by', (select coalesce(full_name, email) from public.profiles where id = auth.uid())));
end $$;
revoke execute on function public.finish_delivery(uuid, jsonb, text, text, text, text) from public, anon;
grant execute on function public.finish_delivery(uuid, jsonb, text, text, text, text) to authenticated;

-- ---------- Storage ----------
-- Lesen: Kaufvertrag (für die Fahrzeug- und Kundendaten) bei unterschriebenen Vorgängen, eigene Auslieferungsdokumente.
drop policy if exists contracts_delivery_read on storage.objects;
create policy contracts_delivery_read on storage.objects for select to authenticated using (
  bucket_id = 'contracts' and public.can_deliver() and (
    (storage.filename(name) = 'original.pdf' and exists (select 1 from public.deals d
       where d.id::text = (storage.foldername(name))[1] and d.final_path is not null and d.status <> 'cancelled'))
    or ((storage.foldername(name))[2] = 'auslieferung' and exists (select 1 from public.deliveries v
       where v.deal_id::text = (storage.foldername(name))[1] and starts_with(storage.filename(name), v.id::text)
         and (v.created_by = auth.uid() or public.is_admin()
              or exists (select 1 from public.deals d where d.id = v.deal_id and d.seller_id = auth.uid()))))));
-- Schreiben: nur in den Ordner der eigenen, offenen Auslieferung.
drop policy if exists contracts_delivery_insert on storage.objects;
create policy contracts_delivery_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'contracts' and public.can_deliver() and (storage.foldername(name))[2] = 'auslieferung'
  and exists (select 1 from public.deliveries v where v.deal_id::text = (storage.foldername(name))[1]
     and starts_with(storage.filename(name), v.id::text) and v.status = 'open' and v.created_by = auth.uid()));
