-- Auszuführende Arbeiten: Was haben Verkäufer im Kaufvertrag zugesagt, und ist das normal oder zu viel?
-- Die App liest den Abschnitt „Auszuführende Arbeiten:“ beim Anlegen des Vorgangs aus dem PDF und meldet die Punkte
-- über set_deal_works(). Die Bewertung passiert hier in der Datenbank nach den Regeln in work_rules, damit
-- Verkäufer sie weder sehen noch verändern können. Auffällige Verträge landen mit review = 'offen' in der Prüfliste.
set lock_timeout = '5s';

-- ---------- Regeln ----------
create table if not exists public.work_rules (
  id uuid primary key default gen_random_uuid(),
  pattern text not null,                 -- regulärer Ausdruck, Groß-/Kleinschreibung egal
  verdict text not null check (verdict in ('ok','zu_viel')),
  label text not null,                   -- kurzer Name, z. B. „Neue Reifen“
  reason text not null,                  -- Begründung, die in der Prüfliste steht
  cost int check (cost >= 0),            -- geschätzte interne Kosten in € (Werkstattstunde intern 42 €, Teile zum EK)
  builtin boolean not null default false,-- Grundregel; eigene Regeln (builtin = false) haben Vorrang
  sort int not null default 100,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.work_rules add column if not exists cost int check (cost >= 0);
alter table public.work_rules enable row level security;
drop policy if exists work_rules_admin on public.work_rules;
create policy work_rules_admin on public.work_rules for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Ungültige Ausdrücke gar nicht erst speichern (sonst scheitert jede Bewertung)
create or replace function public.check_work_rule() returns trigger language plpgsql set search_path = public as $$
begin
  new.pattern := trim(new.pattern);
  if new.pattern = '' then raise exception 'Stichwort fehlt'; end if;
  begin perform '' ~* new.pattern; exception when others then raise exception 'Ungültiges Stichwort: %', new.pattern; end;
  return new;
end $$;
drop trigger if exists check_work_rule on public.work_rules;
create trigger check_work_rule before insert or update on public.work_rules for each row execute function public.check_work_rule();

create table if not exists public.work_config (
  id boolean primary key default true check (id),
  max_items int not null default 6 check (max_items between 1 and 40), -- mehr Punkte als das: Prüfung
  unknown_review boolean not null default true,                       -- unbekannte Arbeiten: Prüfung
  max_cost int not null default 450 check (max_cost >= 0)              -- geschätzte interne Kosten darüber: Prüfung
);
alter table public.work_config add column if not exists max_cost int not null default 450 check (max_cost >= 0);
insert into public.work_config default values on conflict do nothing;
alter table public.work_config enable row level security;
drop policy if exists work_config_admin on public.work_config;
create policy work_config_admin on public.work_config for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Ergebnis je Vorgang ----------
create table if not exists public.deal_works (
  deal_id uuid primary key references public.deals(id) on delete cascade,
  found boolean not null default true,   -- Abschnitt im Vertrag gefunden
  items text[] not null default '{}',
  rated jsonb not null default '[]',     -- [{t: Text, v: ok|zu_viel|unklar, label, why}]
  flagged boolean not null default false,
  est_cost int not null default 0,       -- Summe der geschätzten internen Kosten
  flag_reasons text[] not null default '{}',
  review text check (review in ('offen','ok','beanstandet')),
  review_note text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.deal_works add column if not exists est_cost int not null default 0;
create index if not exists deal_works_review_idx on public.deal_works(review) where review is not null;
alter table public.deal_works enable row level security;
drop policy if exists deal_works_admin_read on public.deal_works;
create policy deal_works_admin_read on public.deal_works for select to authenticated using (public.is_admin());
-- Schreiben nur über die Funktionen unten

-- Ein Punkt: eigene Regeln zuerst, dann „zu viel“, dann „normal“. Treffen mehrere Regeln derselben Stufe,
-- werden ihre Begründungen zusammengefasst. Was keine Regel kennt, ist „unklar“.
create or replace function public.rate_work_item(p text) returns jsonb
language sql stable security definer set search_path = public as $$
  with m as (select r.* from public.work_rules r where lower(p) ~* r.pattern),
  top as (select builtin, verdict from m order by builtin, (verdict = 'zu_viel') desc limit 1)
  select coalesce(
    (select jsonb_build_object('t', p, 'v', top.verdict,
              'label', string_agg(m.label, ' + ' order by m.sort, m.created_at),
              'why', string_agg(m.reason, ' ' order by m.sort, m.created_at),
              'cost', sum(m.cost))
       from m join top using (builtin, verdict) group by top.verdict),
    jsonb_build_object('t', p, 'v', 'unklar', 'label', 'Unbekannt', 'cost', null, 'why', 'Kenne ich noch nicht. Bitte einmal ansehen und als normal oder zu viel merken, dann wird das künftig automatisch erkannt.'));
$$;
revoke execute on function public.rate_work_item(text) from public, anon;

-- Ergebnis berechnen und speichern. Prüfstatus: neu auffällig -> 'offen'; bereits geprüft und Punkte unverändert -> bleibt.
create or replace function public.store_deal_works(p_deal uuid, p_items text[], p_found boolean) returns public.deal_works
language plpgsql security definer set search_path = public as $$
declare
  cfg public.work_config; rated jsonb; n_bad int; n_unk int; n int; why text[] := '{}'; flag boolean; total int;
  old public.deal_works; res public.deal_works;
begin
  select * into cfg from public.work_config limit 1;
  p_items := coalesce(p_items, '{}');
  select coalesce(jsonb_agg(public.rate_work_item(t) order by o), '[]') into rated
    from unnest(p_items) with ordinality as x(t, o);
  n := coalesce(array_length(p_items, 1), 0);
  select count(*) filter (where e->>'v' = 'zu_viel'), count(*) filter (where e->>'v' = 'unklar'), coalesce(sum((e->>'cost')::int), 0) into n_bad, n_unk, total
    from jsonb_array_elements(rated) e;
  if n_bad > 0 then why := why || (n_bad || '× zu viel: ' || (select string_agg(distinct e->>'label', ', ') from jsonb_array_elements(rated) e where e->>'v' = 'zu_viel')); end if;
  if n_unk > 0 and coalesce(cfg.unknown_review, true) then why := why || (n_unk || '× unbekannte Arbeit'); end if;
  if n > coalesce(cfg.max_items, 6) then why := why || (n || ' Zusagen, mehr als ' || coalesce(cfg.max_items, 6) || ' sind ungewöhnlich'); end if;
  if total > coalesce(cfg.max_cost, 450) then why := why || ('geschätzt ' || total || ' € interne Kosten, mehr als ' || coalesce(cfg.max_cost, 450) || ' €'); end if;
  flag := coalesce(array_length(why, 1), 0) > 0;

  select * into old from public.deal_works where deal_id = p_deal for update;
  insert into public.deal_works as d (deal_id, found, items, rated, flagged, est_cost, flag_reasons, review, updated_at)
  values (p_deal, p_found, p_items, rated, flag, total, why, case when flag then 'offen' end, now())
  on conflict (deal_id) do update set
    found = excluded.found, items = excluded.items, rated = excluded.rated, flagged = excluded.flagged, est_cost = excluded.est_cost,
    flag_reasons = excluded.flag_reasons, updated_at = now(),
    -- nicht mehr auffällig: offene Prüfung entfällt, eine erledigte bleibt vermerkt
    review = case when not excluded.flagged then nullif(d.review, 'offen')
                  when d.items is distinct from excluded.items or d.review is null then 'offen'
                  else d.review end,
    review_note = case when d.items is not distinct from excluded.items then d.review_note end,
    reviewed_by = case when d.items is not distinct from excluded.items then d.reviewed_by end,
    reviewed_at = case when d.items is not distinct from excluded.items then d.reviewed_at end
  returning * into res;
  return res;
end $$;
revoke execute on function public.store_deal_works(uuid, text[], boolean) from public, anon, authenticated;

-- Aufruf aus der App: Verkäufer melden die Punkte genau einmal beim Anlegen (das Original-PDF ändert sich danach nicht mehr).
-- Admins dürfen jederzeit (z. B. beim Auswerten älterer Verträge). p_items = null: Abschnitt nicht gefunden.
create or replace function public.set_deal_works(p_deal uuid, p_items text[]) returns json
language plpgsql security definer set search_path = public as $$
declare d public.deals; r public.deal_works; adm boolean := public.is_admin();
begin
  select * into d from public.deals where id = p_deal;
  if not found or not (d.seller_id = auth.uid() or adm) then raise exception 'Kein Zugriff auf diesen Vorgang'; end if;
  if not adm and exists (select 1 from public.deal_works where deal_id = p_deal) then return json_build_object('ok', true, 'kept', true); end if;
  r := public.store_deal_works(p_deal,
         (select coalesce(array_agg(left(trim(t), 500) order by o), '{}') from unnest(p_items) with ordinality as x(t, o) where trim(t) <> '' and o <= 40),
         p_items is not null);
  if adm then return json_build_object('ok', true, 'flagged', r.flagged, 'reasons', r.flag_reasons, 'review', r.review); end if;
  return json_build_object('ok', true);  -- Verkäufer bekommen die Bewertung nicht zu sehen
end $$;
revoke execute on function public.set_deal_works(uuid, text[]) from public, anon;
grant execute on function public.set_deal_works(uuid, text[]) to authenticated;

-- Nach Regeländerungen alles neu bewerten (nur Admins)
create or replace function public.rerate_works() returns json
language plpgsql security definer set search_path = public as $$
declare w record; n int := 0;
begin
  if not public.is_admin() then raise exception 'Nur für Admins'; end if;
  for w in select d.deal_id, d.items, d.found as was_found from public.deal_works d loop
    perform public.store_deal_works(w.deal_id, w.items, w.was_found); n := n + 1;
  end loop;
  return json_build_object('ok', true, 'count', n, 'open', (select count(*) from public.deal_works where review = 'offen'));
end $$;
revoke execute on function public.rerate_works() from public, anon;
grant execute on function public.rerate_works() to authenticated;

-- Prüfung abschließen: 'ok' = passt so, 'beanstandet' = mit dem Verkäufer geklärt / zu viel, 'offen' = wieder öffnen
create or replace function public.review_works(p_deal uuid, p_review text, p_note text default null) returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Nur für Admins'; end if;
  if p_review not in ('offen','ok','beanstandet') then raise exception 'Unbekannter Status'; end if;
  update public.deal_works set review = p_review, review_note = nullif(trim(coalesce(p_note, '')), ''),
         reviewed_by = case when p_review = 'offen' then null else auth.uid() end,
         reviewed_at = case when p_review = 'offen' then null else now() end
   where deal_id = p_deal;
  return json_build_object('ok', found);
end $$;
revoke execute on function public.review_works(uuid, text, text) from public, anon;
grant execute on function public.review_works(uuid, text, text) to authenticated;

-- ---------- Grundregeln (Vorschlag, im Dashboard änderbar) ----------
-- Kosten = geschätzte interne Kosten nach dem internen Auftrag IA202611031327 (Werkstattstunde 42 €, 122-Punkte-Check
-- 21 €, Öl- und Filterwechsel rund 105 €, HU/AU 132,77 €, Aufbereitung 90 €); alles andere marktübliche interne Kosten.
insert into public.work_rules (verdict, label, pattern, reason, cost, builtin, sort)
select v, l, p, r, c, true, s from (values
  -- zu viel
  ('zu_viel', 'Geschenk', 'kostenlos|gratis|geschenk|gutschein|umsonst|ohne berechnung|auf (unsere|eigene) kosten|voll ?(ge)?tank|tankf(ü|ue)llung|tank voll|inkl\.? ?(\S+ )?(reifen|r(ä|ae)der|zulassung|(ü|ue)berf(ü|ue)hrung)',
     'Geschenk an den Kunden: geht direkt von der Marge ab (z. B. Tankfüllung etwa 80 €).', 80, 11),
  ('zu_viel', 'Garantie/Kulanz', 'garantie|gew(ä|ae)hrleistung|kulanz',
     'Garantie- oder Kulanzzusagen gehören nicht in die Arbeiten. Sie binden das Haus über Jahre, intern schnell 300 € und mehr.', 300, 12),
  ('zu_viel', 'Dellen', 'delle|beule|ausbeul|smart.?repair|spot.?repair|(^|[^a-z])pdr([^a-z]|$)',
     'Dellen entfernen (Ausbeulen ohne Lackieren) kostet intern etwa 100 bis 150 € pro Stelle, und das Ergebnis lässt sich schlecht zusagen.', 120, 20),
  ('zu_viel', 'Lackierung', 'lackier|nachlack|lackschad|lackstift|lackreparatur|lack ausbessern',
     'Lackierarbeiten kosten intern etwa 250 € pro Teil.', 250, 21),
  ('zu_viel', 'Kratzer', 'kratzer|schramme|scheuerstelle',
     'Kratzer entfernen heißt 1 bis 2 Stunden polieren (intern etwa 80 €) oder lackieren. Ergebnis offen.', 80, 22),
  ('zu_viel', 'Felgen/Räder', 'felge|bordstein|kompletträder|komplettr(ä|ae)der|radsatz|(neue?n?|zus(ä|ae)tzlich\S*|zweite?n?) (\S+ )?((winter|sommer|allwetter|ganzjahres)?r(ä|ae)der)',
     'Felgen aufbereiten kostet intern etwa 70 € pro Felge, ein zusätzlicher Radsatz deutlich mehr.', 150, 23),
  ('zu_viel', 'Neue Reifen', '(neue?n?|neu) (\S+ )?(reifen|sommerreifen|winterreifen|allwetterreifen|ganzjahresreifen)|reifen (neu|erneuer|ersetz|tausch)',
     'Neue Reifen kosten intern etwa 300 € pro Satz inklusive Montage.', 320, 24),
  ('zu_viel', 'Bremsen erneuern', 'bremsscheibe|bremsbel(ä|ae)g|bremskl(ö|oe)tz|bremssattel|bremsen (neu|erneuer|ersetz|tausch|wechsel|mach)|(neue|erneuer\S*) bremsen',
     'Bremsscheiben und -beläge kosten intern etwa 160 € pro Achse (Teile plus 1 Stunde).', 160, 25),
  ('zu_viel', 'Große Reparatur', 'zahnriemen|steuerkette|kupplung|getriebe|turbo|motor(schaden|instand|tausch|(ü|ue)berhol)|zylinderkopf|injektor|einspritz|partikelfilter|(^|[^a-z])dpf([^a-z]|$)|agr.?ventil|katalysator|auspuff|abgasanlage|anlasser|lichtmaschine|wasserpumpe|kompressor',
     'Größere Reparatur an Motor, Antrieb oder Abgasanlage, intern meist 400 bis 1.000 €.', 600, 26),
  ('zu_viel', 'Fahrwerk', 'sto(ß|ss)d(ä|ae)mpfer|fahrwerk|querlenker|koppelstange|traggelenk|spurstange|radlager|domlager|achsvermessung|spur einstellen|lenkung',
     'Arbeiten am Fahrwerk kosten intern meist 100 bis 300 €.', 200, 27),
  ('zu_viel', 'Scheibe', '(front|wind|windschutz|heck)scheibe|steinschlag|scheibe (neu|tausch|erneuer|ersetz)',
     'Scheibentausch kostet intern etwa 350 €, eine Steinschlagreparatur etwa 60 €.', 350, 28),
  ('zu_viel', 'Nachrüstung', 'nachr(ü|ue)st|anh(ä|ae)ngerkupplung|(^|[^a-z])ahk([^a-z]|$)|standheizung|einbau|folier|t(ö|oe)nung|t(ö|oe)nen|dachtr(ä|ae)ger|codier|chiptuning|leistungssteigerung',
     'Nachrüstung oder Umbau: Material plus Arbeitszeit, intern oft 300 bis 600 €.', 400, 29),
  ('zu_viel', 'Zweitschlüssel', '(zweit|ersatz|2\.?) ?-?schl(ü|ue)ssel|schl(ü|ue)ssel (nachmach|anlern|neu)',
     'Ein Zweitschlüssel kostet intern je nach Fahrzeug 150 bis 400 €.', 250, 30),
  ('zu_viel', 'Neue Batterie', '(neue|erneuer\S*) (\S+ )?batterie|batterie (neu|erneuer|tausch|ersetz|wechsel)',
     'Eine neue Batterie kostet intern etwa 120 €.', 120, 31),
  ('zu_viel', 'Reparatur offen', 'reparier|reparatur|instand ?setz|beheben|beseitig|warnleuchte|kontrollleuchte|defekt|undicht|ger(ä|ae)usch',
     'Reparatur ohne genauen Umfang: Ursache und Kosten sind beim Verkauf oft noch unbekannt.', 150, 32),
  ('zu_viel', 'Offene Zusage', 'bestm(ö|oe)glich|so gut wie m(ö|oe)glich|nach m(ö|oe)glichkeit|ggf|gegebenenfalls|falls (n(ö|oe)tig|erforderlich)|wenn (n(ö|oe)tig|erforderlich)|bei bedarf|nach bedarf|nach wunsch|alle (m(ä|ae)ngel|sch(ä|ae)den|kratzer|dellen)|s(ä|ae)mtliche',
     'Zusage ohne klare Grenze: Der Kunde kann später mehr verlangen, als gemeint war.', null, 45),
  -- normal (Kosten wie im internen Auftrag)
  ('ok', 'Fahrzeugcheck', 'punkte.?check|fahrzeugcheck|gebrauchtwagen.?check|durchsicht|sicherheitscheck',
     'Gehört zur normalen Fahrzeugvorbereitung (intern 0,5 Std., 21 €).', 21, 50),
  ('ok', 'Öl und Filter', '(ö|oe)l|filter',
     'Normale Wartung: Öl- und Filterwechsel intern etwa 105 € (0,5 Std., Ölfilter, 5 l Öl).', 105, 51),
  ('ok', 'Wartung', 'inspektion|service|wartung|z(ü|ue)ndkerze|bremsfl(ü|ue)ssigkeit|scheckheft|klima ?(service|wartung|desinfektion)|klimaanlage (bef(ü|ue)llen|desinfizieren)',
     'Normale Wartung, planbar und im Rahmen (intern etwa 100 bis 150 €).', 120, 52),
  ('ok', 'HU/AU', '(^|[^a-z])(hu|au)([^a-z]|$)|t(ü|ue)v|hauptuntersuchung|abgasuntersuchung',
     'HU/AU neu ist bei Gebrauchten üblich (intern 132,77 €).', 133, 53),
  ('ok', 'Reinigung', 'reinigung|aufbereit|w(ä|ae)sche|waschen|politur|polieren|innenraum|geruch|ozon|pflege|versiegelung',
     'Reinigung und Aufbereitung gehören zur Übergabe (intern 90 €).', 90, 54),
  ('ok', 'Räder umstecken', 'r(ä|ae)der (\S+ )?(montier|umsteck|wechsel|aufzieh|einlager|in den kofferraum|mitgeben)|r(ä|ae)derwechsel|reifenwechsel|reifen (\S+ )?(montier|umsteck|aufzieh)|(sommer|winter|allwetter|ganzjahres)?(r(ä|ae)der|reifen) (\S+ )?(in den kofferraum|mitgeben|einlagern)',
     'Vorhandene Räder montieren oder mitgeben ist Standard (intern etwa 0,5 Std., 21 €).', 21, 55),
  ('ok', 'Zulassung', 'zulassung|zulassen|anmeld|abmeld|kennzeichen|(ü|ue)berf(ü|ue)hrung',
     'Zulassung wird ohnehin als eigener Posten berechnet.', 0, 56),
  ('ok', 'Kleinigkeit', 'fu(ß|ss)matte|wischer|wischbl(ä|ae)tt|leuchtmittel|gl(ü|ue)hbirne|birne|lampe|scheinwerfer einstell|scheibenwasser|frostschutz|k(ü|ue)hlwasser|adblue|warndreieck|verbandskasten|warnweste|bordmappe|bedienungsanleitung|reifendruck',
     'Kleinigkeit, intern meist unter 20 €.', 15, 57),
  ('ok', 'Nur prüfen', 'pr(ü|ue)f|kontroll|auslesen|fehlerspeicher|testen|probefahrt',
     'Nur prüfen, ohne Zusage einer Reparatur (intern etwa 21 €).', 21, 58)
) as x(v, l, p, r, c, s)
where not exists (select 1 from public.work_rules where builtin);
