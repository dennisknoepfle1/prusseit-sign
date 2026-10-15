-- Server-Siegel (PAdES) mit Zeitstempel: eigenes PDF neben dem finalen, nur vom Server setzbar.
alter table public.deals add column sealed_path text, add column sealed_sha256 text, add column timestamped boolean;

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
  if old.final_sha256 is not null and (new.final_sha256 is distinct from old.final_sha256 or new.final_path is distinct from old.final_path) then
    raise exception 'Finales PDF ist bereits festgeschrieben';
  end if;
  if old.sealed_sha256 is not null and (new.sealed_sha256 is distinct from old.sealed_sha256 or new.sealed_path is distinct from old.sealed_path) then
    raise exception 'Versiegeltes PDF ist bereits festgeschrieben';
  end if;
  -- Siegel darf nur der Server setzen
  if (new.sealed_sha256 is distinct from old.sealed_sha256 or new.sealed_path is distinct from old.sealed_path or new.timestamped is distinct from old.timestamped)
     and coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres','service_role','supabase_admin') then
    raise exception 'Siegel kann nur vom Server gesetzt werden';
  end if;
  return new;
end $$;
revoke execute on function public.guard_deal() from public, anon, authenticated;
