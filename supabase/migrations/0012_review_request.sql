-- Bewertungsaufforderung (25 € Aral-Tankgutschein gegen Screenshot-Nachweis) X Tage nach Vertragsunterschrift.
-- Versand: Edge Function send-review-request, täglich per pg_cron (siehe unten).
alter table public.deals
  add column if not exists review_skip boolean not null default false,
  add column if not exists review_sent_at timestamptz,
  add column if not exists review_mail_id text,
  add column if not exists review_mail_to text,
  add column if not exists review_mail_status text
    check (review_mail_status in ('sending','sent','delivered','delayed','bounced','complained','failed'));

-- Bestehende Vorgänge (vor dem Start am 26.11.2026 angelegt) bekommen keine Bewertungsmail
update public.deals set review_skip = true where created_at < now();

create index if not exists deals_review_due_idx on public.deals (signed_at)
  where review_sent_at is null and review_skip = false;

-- Einstellungen (eine Zeile)
create table if not exists public.review_config (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  delay_days integer not null default 10 check (delay_days between 0 and 90),
  google_url text not null,
  trustpilot_url text not null,
  reply_to text not null default 'willkommen@autowelt-prusseit.de'
);
alter table public.review_config enable row level security;
create policy review_config_read on public.review_config for select to authenticated using (true);
create policy review_config_admin on public.review_config for update to authenticated using (public.is_admin()) with check (public.is_admin());

insert into public.review_config (google_url, trustpilot_url) values (
  'https://www.google.com/search?hl=de-DE&gl=de&q=Autowelt+Prusseit+GmbH+%7C+Gebrauchtwagen,+Rauher+Grund+26,+72160+Horb+am+Neckar&ludocid=494310568447505835&lsig=AB86z5VAP8tUDq4kPUvM_Uow2P2L&source=g.page.m.dd._&laa=lu-desktop-reviews-dialog-review-solicitation#lrd=0x4797522f576303d1:0x6dc24d7d108f5ab,3',
  'https://de.trustpilot.com/evaluate/autowelt-prusseit.de'
) on conflict (id) do nothing;

-- Geheimnis für den täglichen Aufruf
insert into public.app_secrets (name, value)
values ('cron_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

create extension if not exists pg_cron;

-- Täglich 09:07 UTC (10:07 Winterzeit / 11:07 Sommerzeit)
select cron.schedule('send-review-requests', '7 9 * * *', $$
  select net.http_post(
    url := 'https://shhtnbarfnhuizhnqpac.supabase.co/functions/v1/send-review-request',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from public.app_secrets where name='cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);
