-- Vorgangsnummer für Verträge nachtragen, bei denen sie nicht aus dem KV gelesen wurde („ohne Nummer“).
-- Quelle: die #-Nummer im Dateinamen des Kaufvertrags (deals.draft->>'fileName'). Das versiegelte PDF bleibt unverändert.
update public.deals d
   set contract_no = '#' || substring(d.draft->>'fileName' from '#\s?(\d{1,10})')
 where d.contract_no = 'ohne Nummer'
   and d.draft->>'fileName' ~ '#\s?\d';
