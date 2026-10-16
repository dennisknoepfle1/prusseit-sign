// Versendet den fertig unterschriebenen Vertrag per Mail (Resend) an den Kunden (keine interne Kopie, das PDF liegt im Archiv)
// und schickt eine Push-Nachricht „Fahrzeug verkauft“ an alle Admins.
// Aufruf aus der App: POST { deal_id }, mit dem Login des Verkäufers (JWT).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY");
const FROM_ADDR = Deno.env.get("MAIL_FROM") ?? "vertrag@prusseit-sign.de";
const APP_URL = Deno.env.get("APP_URL") ?? "https://dennisknoepfle1.github.io/prusseit-sign/";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

function shell(inner: string) {
  return `<!doctype html><html><body style="margin:0;background:#f4f3f3;font-family:Arial,Helvetica,sans-serif;color:#18151a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden">
<tr><td style="background:#0e0c0d;padding:16px 24px;font-size:20px;font-weight:bold;letter-spacing:.04em;color:#fff">AUTOWELT-<span style="color:#e3001b">PRUSSEIT</span></td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.5">${inner}</td></tr>
<tr><td style="padding:14px 24px;background:#f4f3f3;font-size:12px;color:#6a6265">Autowelt Prusseit GmbH · Rauher Grund 26 · 72160 Horb am Neckar · autowelt-prusseit.de</td></tr>
</table></td></tr></table></body></html>`;
}

async function sendMail(payload: Record<string, unknown>) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend ${r.status}: ${body?.message ?? JSON.stringify(body)}`);
  return body.id as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST erwartet" }, 405);
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const user = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } } });
    const admin = createClient(SB_URL, SERVICE);
    const { deal_id, resend } = await req.json();
    if (!deal_id) return json({ error: "deal_id fehlt" }, 400);

    // Zugriff mit den Rechten des Aufrufers prüfen (RLS)
    const { data: deal, error } = await user.from("deals")
      .select("id,contract_no,vehicle,customer_name,customer_email,status,final_path,final_sha256,sealed_path,sealed_sha256,timestamped,signed_at,seller_id")
      .eq("id", deal_id).single();
    if (error || !deal) return json({ error: "Vorgang nicht gefunden" }, 404);
    if (!deal.final_path) return json({ error: "Vertrag ist noch nicht abgeschlossen" }, 409);
    if (deal.status === "sent" && !resend) return json({ ok: true, already: true });

    const { data: seller } = await admin.from("profiles").select("email,full_name,phone").eq("id", deal.seller_id).single();
    const { data: admins } = await admin.from("profiles").select("id,email").eq("role", "admin");
    const sellerName = seller?.full_name || seller?.email || "Ihr Verkäufer";
    const nr = deal.contract_no || "";
    const fileName = `Kaufvertrag_${(nr || deal.customer_name).replace(/[^\w.-]+/g, "_")}.pdf`;

    const results: Record<string, unknown> = {};
    if (!RESEND) {
      results.mail = "nicht eingerichtet (RESEND_API_KEY fehlt)";
    } else {
      const dl = await admin.storage.from("contracts").download(deal.sealed_path ?? deal.final_path);
      if (dl.error) throw dl.error;
      const pdf = b64(new Uint8Array(await dl.data.arrayBuffer()));
      const attachments = [{ filename: fileName, content: pdf }];
      const from = `${sellerName.replace(/[<>"]/g, "")} · Autowelt Prusseit <${FROM_ADDR}>`;

      if (deal.customer_email) {
        results.customer = await sendMail({
          from, to: [deal.customer_email], reply_to: seller?.email ? [seller.email] : undefined,
          subject: `Ihr Kaufvertrag ${nr} – Autowelt Prusseit`.replace("  ", " "),
          html: shell(`<p>Guten Tag ${esc(deal.customer_name)},</p>
<p>anbei erhalten Sie Ihren unterschriebenen Kaufvertrag${nr ? " " + esc(nr) : ""} als PDF. Die letzten Seiten enthalten das Prüfprotokoll der elektronischen Unterzeichnung.</p>
<p>Bei Fragen antworten Sie einfach auf diese E-Mail, sie geht direkt an ${esc(sellerName)}.</p>
<p>Vielen Dank für Ihr Vertrauen.</p>
<p>Mit freundlichen Grüßen<br>${esc(sellerName)}<br>Autowelt Prusseit GmbH</p>`),
          text: `Guten Tag ${deal.customer_name},\n\nanbei erhalten Sie Ihren unterschriebenen Kaufvertrag ${nr} als PDF. Die letzten Seiten enthalten das Prüfprotokoll der elektronischen Unterzeichnung.\n\nBei Fragen antworten Sie einfach auf diese E-Mail.\n\nMit freundlichen Grüßen\n${sellerName}\nAutowelt Prusseit GmbH`,
          attachments,
        });
      }
      if (results.customer) {
        await user.from("deals").update({ status: "sent" }).eq("id", deal.id);
        await user.from("audit_events").insert({ deal_id: deal.id, event: "mailed", details: { customer: deal.customer_email, ids: results } });
      }
    }

    // Push an Admins
    try {
      const { data: keys } = await admin.from("app_secrets").select("name,value").in("name", ["vapid_public", "vapid_private"]);
      const k = Object.fromEntries((keys ?? []).map(r => [r.name, r.value]));
      if (k.vapid_public && k.vapid_private && !resend) {
        webpush.setVapidDetails("mailto:vertrag@prusseit-sign.de", k.vapid_public, k.vapid_private);
        const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,keys").in("user_id", (admins ?? []).map(a => a.id));
        const payload = JSON.stringify({ title: "Fahrzeug verkauft", body: `${deal.vehicle || nr || "Vertrag"} · ${deal.customer_name} · ${sellerName}`, url: APP_URL });
        let sent = 0;
        for (const s of subs ?? []) {
          try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload); sent++; }
          catch (e) { if ((e as { statusCode?: number }).statusCode === 410 || (e as { statusCode?: number }).statusCode === 404) await admin.from("push_subscriptions").delete().eq("id", s.id); }
        }
        results.push = sent;
      }
    } catch (e) { results.push_error = String(e); }

    return json({ ok: true, results });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
