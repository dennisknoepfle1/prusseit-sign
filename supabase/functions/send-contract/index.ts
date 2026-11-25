// Versendet den fertig unterschriebenen Vertrag per Mail (Resend) an den Kunden (keine interne Kopie, das PDF liegt im Archiv)
// und schickt eine Push-Nachricht „Fahrzeug verkauft“ an alle Admins.
// Aufruf aus der App: POST { deal_id, resend? }, mit dem Login des Verkäufers (JWT).
// Die Mail enthält das PDF als Anhang und zusätzlich einen persönlichen Download-Link (30 Tage, jeder Abruf wird protokolliert).
// Nur wenn das PDF für Mailserver zu groß wäre, geht allein der Link raus. Mail-ID und Zustellstatus stehen am Vorgang (deals.mail_*).
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
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const token = () => { const b = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
// Ab dieser Größe nur noch Link: als Anhang wird das PDF rund ein Drittel größer, viele Postfächer nehmen höchstens 20 MB an
const MAX_ATTACH = 14 * 1024 * 1024;
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

function shell(inner: string) {
  return `<!doctype html><html><body style="margin:0;background:#f4f3f3;font-family:Arial,Helvetica,sans-serif;color:#18151a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden">
<tr><td style="background:#0e0c0d;padding:18px 24px"><img src="https://dennisknoepfle1.github.io/prusseit-sign/logo-mail.png" width="210" height="60" alt="Autowelt Prusseit" style="display:block;border:0;width:210px;height:auto"></td></tr>
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
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      const attach = bytes.length <= MAX_ATTACH;
      const from = `${sellerName.replace(/[<>"]/g, "")} · Autowelt Prusseit <${FROM_ADDR}>`;

      if (deal.customer_email) {
        // Persönlicher Download-Link als zweiter Weg zum PDF
        const t = token();
        const { data: link, error: le } = await admin.from("pdf_links").insert({ deal_id: deal.id, token_hash: await sha256(t), channel: "mail", created_by: deal.seller_id }).select("expires_at").single();
        if (le) throw le;
        const url = `${SB_URL}/functions/v1/contract-pdf?t=${t}`;
        const until = new Date(link.expires_at).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
        const intro = attach
          ? `anbei erhalten Sie Ihren unterschriebenen Kaufvertrag${nr ? " " + esc(nr) : ""} als PDF. Die letzten Seiten enthalten das Prüfprotokoll der elektronischen Unterzeichnung.`
          : `Ihr unterschriebener Kaufvertrag${nr ? " " + esc(nr) : ""} ist zu groß für einen E-Mail-Anhang. Sie können ihn über den folgenden Link als PDF herunterladen und speichern. Die letzten Seiten enthalten das Prüfprotokoll der elektronischen Unterzeichnung.`;
        const btn = `<p style="margin:22px 0"><a href="${url}" style="display:inline-block;background:#E3001B;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:6px">Vertrag als PDF herunterladen</a></p>
<p style="font-size:13px;color:#6a6265">${attach ? "Falls sich der Anhang nicht öffnen lässt: " : ""}Der Link ist bis zum ${until} gültig. Bitte speichern Sie das PDF bei sich.</p>`;
        results.customer = await sendMail({
          from, to: [deal.customer_email], reply_to: seller?.email ? [seller.email] : undefined,
          subject: `Ihr Kaufvertrag ${nr} – Autowelt Prusseit`.replace("  ", " "),
          html: shell(`<p>Guten Tag ${esc(deal.customer_name)},</p>
<p>${intro}</p>
${btn}
<p>Vielen Dank für Ihr Vertrauen.</p>
<p>Mit freundlichen Grüßen<br>${esc(sellerName)}<br>Autowelt Prusseit GmbH</p>`),
          text: `Guten Tag ${deal.customer_name},\n\n${intro.replace(/&[a-z]+;/g, "")}\n\nVertrag als PDF herunterladen (gültig bis ${until}):\n${url}\n\nMit freundlichen Grüßen\n${sellerName}\nAutowelt Prusseit GmbH`,
          attachments: attach ? [{ filename: fileName, content: b64(bytes) }] : undefined,
        });
      }
      if (results.customer) {
        await user.from("deals").update({ status: "sent", mail_id: results.customer, mail_to: deal.customer_email, mail_status: "sent", mail_status_at: new Date().toISOString() }).eq("id", deal.id);
        await user.from("audit_events").insert({ deal_id: deal.id, event: "mailed", details: { customer: deal.customer_email, ids: results, attached: attach, bytes: bytes.length, resend: !!resend } });
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
