-- Gerätetyp je Push-Anmeldung: „Vertrag bereit“ geht nur an Tablets (iPad), nicht an den PC
set lock_timeout = '5s';
alter table public.push_subscriptions add column if not exists device text check (device in ('tablet','pc'));
