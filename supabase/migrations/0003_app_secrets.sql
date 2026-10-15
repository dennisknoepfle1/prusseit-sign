-- Serverseitige Schlüssel (nur Service-Role, keine Policies => für App-Nutzer unsichtbar).
-- Werte (VAPID-Schlüssel für Push) werden direkt in der DB gesetzt, nicht im Repo.
create table public.app_secrets (name text primary key, value text not null);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;
