-- Archiv und Dashboard brauchen vom Zwischenstand nur „bereit“ und „gespeichert am“.
-- Der volle Zwischenstand (mit allen Unterschriften) ist bei 150 Vorgängen schon 58 MB groß; ihn für die Liste
-- auszulesen führte zu „statement timeout“. Gespeicherte Spalten machen die Abfrage wieder schnell (< 1 ms).
set lock_timeout = '5s';
alter table public.deals add column if not exists draft_ready boolean generated always as ((draft->>'ready')::boolean) stored;
alter table public.deals add column if not exists draft_saved_at text generated always as (draft->>'saved_at') stored;
