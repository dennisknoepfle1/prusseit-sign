-- Bewertungsmail absichern: review_skip dürfen nur Admins ändern (Schalter „nicht senden“ im Archiv),
-- Versandstand (review_sent_at, review_mail_*) nur der Server. Verkäufer dürfen ihre Vorgänge sonst weiter ändern.
create or replace function public.guard_review() returns trigger
language plpgsql set search_path = public as $$
declare server boolean := coalesce(auth.role(), '') = 'service_role' or current_user in ('postgres','service_role','supabase_admin');
begin
  if server then return new; end if;
  if new.review_skip is distinct from old.review_skip and not public.is_admin() then
    raise exception 'Bewertungsmail können nur Admins abschalten';
  end if;
  if new.review_sent_at is distinct from old.review_sent_at or new.review_mail_id is distinct from old.review_mail_id
     or new.review_mail_to is distinct from old.review_mail_to or new.review_mail_status is distinct from old.review_mail_status then
    raise exception 'Versandstand der Bewertungsmail setzt nur der Server';
  end if;
  return new;
end $$;
revoke execute on function public.guard_review() from public, anon, authenticated;
drop trigger if exists guard_review on public.deals;
create trigger guard_review before update on public.deals
  for each row execute function public.guard_review();
