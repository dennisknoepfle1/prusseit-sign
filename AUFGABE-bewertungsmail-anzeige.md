# Aufgabe: Bewertungsmail im Archiv anzeigen

Stand 26.11.2026. Der Server-Teil läuft schon, es fehlt nur die Anzeige in der App (`index.html`).

## Was es schon gibt

Zehn Tage nach der Unterschrift bekommt jeder Kunde automatisch eine Bewertungsmail mit dem 25-€-Aral-Tankgutschein-Bonus.

- **Edge Function** `supabase/functions/send-review-request/`: verschickt die Mails über Resend. Sie wird täglich um 09:07 UTC per pg_cron aufgerufen.
- **Migration** `supabase/migrations/0012_review_request.sql`: neue Spalten an `deals` und Tabelle `review_config` (Wartezeit, Bewertungslinks, Antwortadresse).
- **`mail-events`**: führt über den Resend-Webhook auch den Zustellstatus der Bewertungsmail nach (`review_mail_status`).
- Jede verschickte Bewertungsmail steht im Prüfprotokoll (`audit_events`, Event `review_requested`).
- Vorgänge, die vor dem 26.11.2026 angelegt wurden, haben `review_skip = true` und bekommen keine Mail.

Neue Spalten an `deals`:

| Spalte | Bedeutung |
|---|---|
| `review_skip` | `true`: dieser Vorgang bekommt keine Bewertungsmail |
| `review_sent_at` | wann die Mail rausging (null: noch nicht) |
| `review_mail_to` | an welche Adresse |
| `review_mail_id` | Resend-ID |
| `review_mail_status` | `sending`, `sent`, `delivered`, `delayed`, `bounced`, `complained`, `failed` |

## Was gebaut werden soll

1. **Archiv** (`showArchive()` / `renderArchive()`):
   - Die Spalten `review_sent_at, review_mail_to, review_mail_status, review_skip` in die `select` aufnehmen.
   - Unter der Zeile `mailLine(r)` eine zweite kleine Zeile im selben Stil (`small.mailst`) ausgeben:
     - verschickt und zugestellt: „⭐ Bewertung angefragt am TT.MM.JJJJ · zugestellt“
     - verschickt, noch nicht zugestellt: „⭐ Bewertung angefragt am TT.MM.JJJJ“
     - `bounced` / `failed` / `complained`: rot (Klasse `bad`), „⭐ Bewertungsmail nicht zugestellt: Adresse“
     - noch nicht fällig: „⭐ Bewertungsmail geht am TT.MM.JJJJ raus“ (Datum = `signed_at` + `review_config.delay_days`)
     - `review_skip`: keine Zeile anzeigen
     - storniert: keine Zeile anzeigen
2. Optional, nur für Admins: ein Schalter „Bewertungsmail nicht senden“ pro Vorgang. Er setzt `review_skip = true`, zum Beispiel bei Händlern oder Reklamationsfällen. Dafür muss die RLS für das Update von `review_skip` geprüft werden.
3. Optional, nur für Admins: in den Einstellungen die Wartezeit (`review_config.delay_days`) und An/Aus (`review_config.enabled`) bearbeitbar machen.

## Hinweise

- Kundentexte der Bewertungsmail sind bewusst in Du-Form. Das ist abgestimmt mit Dennis, auch die Bitte um eine 5-Sterne-Bewertung im Namen des Verkäufers.
- Testversand ohne Kundenkontakt: `send-review-request` mit `{ "test_to": "adresse", "deal_id": "…" }` als Admin aufrufen. Die Mail geht dann nur an `test_to`, und am Vorgang ändert sich nichts.
- **Offen:** Die erste Testmail an dennis.knoepfle@prusseit-group.de landete im Junk-Ordner. Vor dem ersten echten Versand sollte die Zustellung an private Adressen (Gmail, GMX, web.de) geprüft werden. Bei Bedarf den Absender (`MAIL_FROM`) auf eine eigene, bei Resend verifizierte Domain umstellen.

## Umgesetzt (26.11.2026)

- Archiv: Zeile „⭐ …“ unter dem Mailstatus wie oben beschrieben. Zusätzlich rot „konnte nicht verschickt werden, nächster Versuch morgen“, wenn der Versand an Resend scheiterte (der Server versucht es am nächsten Tag erneut). Ist das Fälligkeitsdatum schon vorbei, steht „geht beim nächsten Versand raus“.
- Admins: „nicht senden“ bzw. „wieder einschalten“ direkt in der Zeile, mit Eintrag im Prüfprotokoll (`review_skipped` / `review_unskipped`).
- Dashboard: Kasten „Bewertungsmail an Kunden“ mit An/Aus, Wartezeit in Tagen und „Testmail an mich senden“.
- Migration `0013_review_guard.sql`: `review_skip` dürfen nur Admins ändern, den Versandstand nur der Server.
