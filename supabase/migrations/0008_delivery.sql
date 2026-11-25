-- Zustellung des fertigen Vertrags absichern:
--  * Zustellstatus der Kundenmail (Resend-Webhook) direkt am Vorgang
--  * persönliche Download-Links (QR-Code auf dem iPad, Link in der Mail) mit Download-Protokoll
set lock_timeout = '5s';

alter table public.deals add column if not exists mail_id text;          -- Resend-ID der zuletzt verschickten Kundenmail
alter table public.deals add column if not exists mail_to text;          -- Adresse, an die sie ging
alter table public.deals add column if not exists mail_status text
  check (mail_status in ('sent','delivered','delayed','bounced','complained','failed'));
alter table public.deals add column if not exists mail_status_at timestamptz;
alter table public.deals add column if not exists downloaded_at timestamptz; -- erster Download durch den Kunden
create index if not exists deals_mail_id_idx on public.deals(mail_id);

create table if not exists public.pdf_links (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  token_hash text not null unique,            -- SHA-256 des Tokens, das Token selbst wird nicht gespeichert
  channel text not null check (channel in ('qr','mail')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  downloads int not null default 0,
  first_download_at timestamptz,
  last_download_at timestamptz
);
create index if not exists pdf_links_deal_idx on public.pdf_links(deal_id);
alter table public.pdf_links enable row level security;
drop policy if exists pdf_links_read on public.pdf_links;
create policy pdf_links_read on public.pdf_links for select to authenticated using (
  exists (select 1 from public.deals d where d.id = pdf_links.deal_id and (d.seller_id = auth.uid() or public.is_admin())));
drop policy if exists pdf_links_insert on public.pdf_links;
create policy pdf_links_insert on public.pdf_links for insert to authenticated with check (
  channel = 'qr' and downloads = 0 and first_download_at is null
  and exists (select 1 from public.deals d where d.id = pdf_links.deal_id and d.final_path is not null and (d.seller_id = auth.uid() or public.is_admin())));

-- Bisher verschickte Mails nachtragen (Resend-ID steht im Prüfprotokoll)
update public.deals d set mail_id = e.mail_id, mail_to = e.mail_to, mail_status = 'sent', mail_status_at = e.at
from (
  select distinct on (deal_id) deal_id, details->'ids'->>'customer' as mail_id, details->>'customer' as mail_to, at
  from public.audit_events where event = 'mailed' and details->'ids'->>'customer' is not null
  order by deal_id, id desc
) e
where d.id = e.deal_id and d.mail_id is null;
