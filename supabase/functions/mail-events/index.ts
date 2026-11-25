// Zustellstatus der Kundenmail.
//  * Resend-Webhook (POST, ohne Login): { type, data: { email_id } }. Dem Inhalt wird nicht vertraut,
//    der Status wird mit der Mail-ID direkt bei Resend nachgefragt. Bei Abweisung Push an Verkäufer und Admins.
//  * Aus der App (POST, mit Login): { deal_id } oder { all: true } fragt den Status bei Resend neu ab.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY");
const APP_URL = Deno.env.get("APP_URL") ?? "https://dennisknoepfle1.github.io/prusseit-sign/";
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Resend „last_event“ → unser Status
const MAP: Record<string, string> = {
  sent: "sent", queued: "sent", scheduled: "sent",
  delivered: "delivered", opened: "delivered", clicked: "delivered",
  delivery_delayed: "delayed", bounced: "bounced", complained: "complained", failed: "failed", canceled: "failed",
};
const BAD = new Set(["bounced", "failed"]);

async function pushTo(userIds: string[], title: string, body: string, url: string) {
  const { data: keys } = await admin.from("app_secrets").select("name,value").in("name", ["vapid_public", "vapid_private"]);
  const k = Object.fromEntries((keys ?? []).map(r => [r.name, r.value]));
  if (!k.vapid_public || !k.vapid_private || !userIds.length) return 0;
  webpush.setVapidDetails("mailto:vertrag@prusseit-sign.de", k.vapid_public, k.vapid_private);
  const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,keys").in("user_id", userIds);
  let sent = 0;
  for (const s of subs ?? []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ title, body, url, kind: "mail", tag: "mail" })); sent++; }
    catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 410 || c === 404) await admin.from("push_subscriptions").delete().eq("id", s.id); }
  }
  return sent;
}

type Deal = { id: string; seller_id: string; customer_name: string; vehicle: string | null; contract_no: string | null; mail_id: string | null; mail_to: string | null; mail_status: string | null };
const COLS = "id,seller_id,customer_name,vehicle,contract_no,mail_id,mail_to,mail_status";

async function refresh(deal: Deal) {
  if (!deal.mail_id || !RESEND) return deal.mail_status;
  const r = await fetch(`https://api.resend.com/emails/${encodeURIComponent(deal.mail_id)}`, { headers: { Authorization: `Bearer ${RESEND}` } });
  if (!r.ok) throw new Error(`Resend ${r.status}`);
  const m = await r.json();
  const status = MAP[m.last_event as string] ?? deal.mail_status ?? "sent";
  if (status === deal.mail_status) return status;
  await admin.from("deals").update({ mail_status: status, mail_status_at: new Date().toISOString() }).eq("id", deal.id).eq("mail_id", deal.mail_id);
  await admin.from("audit_events").insert({ deal_id: deal.id, event: "mail_" + status, details: { mail_id: deal.mail_id, to: deal.mail_to, resend_event: m.last_event } });
  if (BAD.has(status) || status === "complained") {
    const { data: admins } = await admin.from("profiles").select("id").eq("role", "admin");
    const ids = [...new Set([deal.seller_id, ...(admins ?? []).map(a => a.id)])];
    const title = BAD.has(status) ? "Vertrag nicht zugestellt" : "Vertragsmail als Spam markiert";
    await pushTo(ids, title, `${deal.customer_name} · ${deal.mail_to ?? ""}. Bitte Adresse prüfen und im Archiv erneut senden.`, APP_URL + "?archiv=1");
  }
  return status;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST erwartet" }, 405);
  try {
    const body = await req.json().catch(() => ({}));

    // Webhook von Resend
    if (typeof body?.type === "string" && body?.data?.email_id) {
      const { data: deal } = await admin.from("deals").select(COLS).eq("mail_id", String(body.data.email_id)).maybeSingle();
      if (!deal) return json({ ok: true, ignored: true }); // z. B. Unterschriftslink oder ältere Mail
      return json({ ok: true, status: await refresh(deal as Deal) });
    }

    // Aus der App
    const user = createClient(SB_URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: u } = await user.auth.getUser();
    if (!u?.user) return json({ error: "Nicht angemeldet" }, 401);
    if (body.all) {
      // Offene Zustellungen nachprüfen (falls ein Webhook verloren ging), mit den Rechten des Aufrufers: Admins alle, Verkäufer ihre eigenen
      const { data: deals } = await user.from("deals").select(COLS).not("mail_id", "is", null)
        .in("mail_status", ["sent", "delayed"]).lt("mail_status_at", new Date(Date.now() - 10 * 60000).toISOString()).order("created_at", { ascending: false }).limit(150);
      const out: Record<string, number> = {};
      for (const d of deals ?? []) {
        try { const s = await refresh(d as Deal) ?? "?"; out[s] = (out[s] ?? 0) + 1; } catch { out.error = (out.error ?? 0) + 1; }
        await new Promise(r => setTimeout(r, 550)); // Resend erlaubt 2 Anfragen pro Sekunde
      }
      return json({ ok: true, checked: deals?.length ?? 0, out });
    }
    const { data: deal, error } = await user.from("deals").select(COLS).eq("id", body.deal_id).single();
    if (error || !deal) return json({ error: "Vorgang nicht gefunden" }, 404);
    return json({ ok: true, status: await refresh(deal as Deal) });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
