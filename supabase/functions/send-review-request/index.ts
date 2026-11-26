// Bewertungsaufforderung mit 25 € Aral-Tankgutschein (gegen Screenshot-Nachweis an willkommen@).
// Geht X Tage nach Vertragsunterschrift (review_config.delay_days) an den Kunden, einmal pro Vorgang.
//  * Täglicher Aufruf per pg_cron: POST mit Header x-cron-secret (app_secrets.cron_secret) → verschickt alle fälligen Mails.
//  * Testversand: POST { test_to, deal_id? } mit Admin-Login oder x-cron-secret → schickt die Mail nur an test_to, ändert nichts am Vorgang.
// Versand über Resend wie send-contract. Ergebnis steht am Vorgang (deals.review_*) und im Prüfprotokoll (audit_events: review_requested).
// Deploy: verify_jwt = false (die Funktion prüft selbst: Cron-Geheimnis oder Admin-Login).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY");
const FROM_ADDR = Deno.env.get("MAIL_FROM") ?? "vertrag@prusseit-sign.de";
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const first = (n?: string | null) => String(n ?? "").trim().split(/\s+/)[0] || "";

type Cfg = { enabled: boolean; delay_days: number; google_url: string; trustpilot_url: string; reply_to: string };
type Deal = { id: string; seller_id: string; customer_name: string; customer_email: string | null; vehicle: string | null; contract_no: string | null };

function shell(inner: string) {
  return `<!doctype html><html><body style="margin:0;background:#f4f3f3;font-family:Arial,Helvetica,sans-serif;color:#18151a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden">
<tr><td style="background:#0e0c0d;padding:18px 24px"><img src="https://dennisknoepfle1.github.io/prusseit-sign/logo-mail.png" width="210" height="60" alt="Autowelt Prusseit" style="display:block;border:0;width:210px;height:auto"></td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.55">${inner}</td></tr>
<tr><td style="padding:14px 24px;background:#f4f3f3;font-size:12px;color:#6a6265">Autowelt Prusseit GmbH · Rauher Grund 26 · 72160 Horb am Neckar · autowelt-prusseit.de</td></tr>
</table></td></tr></table></body></html>`;
}

function build(deal: Deal, seller: string, cfg: Cfg) {
  const kunde = first(deal.customer_name) || deal.customer_name;
  const v = esc(seller);
  const btn = (href: string, label: string) =>
    `<a href="${esc(href)}" style="display:inline-block;background:#E3001B;color:#fff;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:6px;margin:4px 6px 4px 0">${label}</a>`;
  const html = shell(`<p>Hallo ${esc(kunde)},</p>
<p>jetzt ist es offiziell: Dein neues Auto gehört dir! 🚗🎉 Danke, dass du dich für die Autowelt Prusseit entschieden hast${seller ? `, und danke, dass ${v} dich begleiten durfte` : ""}.</p>
<p>Und weil die erste Tankfüllung am meisten Spaß macht, legen wir noch was drauf:</p>
<p style="margin:20px 0;padding:16px;border:2px solid #E3001B;border-radius:8px;text-align:center;font-size:20px;font-weight:bold">⛽ DEIN 25 € ARAL-TANKGUTSCHEIN</p>
<p><b>So einfach geht's:</b></p>
<p><b>1.</b> Erzähl anderen, wie dein Autokauf bei uns war:</p>
<p>${btn(cfg.google_url, "⭐ Bei Google bewerten")}${btn(cfg.trustpilot_url, "⭐ Bei Trustpilot bewerten")}</p>
<p style="font-size:14px;color:#4a4346">⭐ mobile.de: Dafür bekommst du eine eigene Einladung per Mail.</p>
<p><b>2.</b> Mach von jeder Bewertung einen Screenshot.<br><b>3.</b> Schick die Screenshots an <a href="mailto:${esc(cfg.reply_to)}" style="color:#E3001B">${esc(cfg.reply_to)}</a> – oder antworte einfach auf diese Mail.</p>
<p>Sobald deine Nachweise bei uns sind, schicken wir dir deinen 25 € Aral-Gutschein per E-Mail.</p>
${seller ? `<p style="background:#f4f3f3;border-radius:8px;padding:14px">💬 <b>Eine Bitte von ${v}:</b> Ich würde mich riesig über deine <b>5-Sterne-Bewertung</b> auf Google, Trustpilot und mobile.de freuen. Erwähne dabei gern meinen Namen, damit ich weiß, dass sie von dir kommt. Danke dir! 🙏</p>` : ""}
<p>Allzeit gute Fahrt!<br>Dein Team der Autowelt Prusseit</p>`);
  const text = `Hallo ${kunde},\n\njetzt ist es offiziell: Dein neues Auto gehört dir! Danke, dass du dich für die Autowelt Prusseit entschieden hast${seller ? `, und danke, dass ${seller} dich begleiten durfte` : ""}.\n\nUnd weil die erste Tankfüllung am meisten Spaß macht, legen wir noch was drauf:\n\nDEIN 25 € ARAL-TANKGUTSCHEIN\n\nSo einfach geht's:\n1. Erzähl anderen, wie dein Autokauf bei uns war:\nGoogle: ${cfg.google_url}\nTrustpilot: ${cfg.trustpilot_url}\nmobile.de: Dafür bekommst du eine eigene Einladung per Mail.\n2. Mach von jeder Bewertung einen Screenshot.\n3. Schick die Screenshots an ${cfg.reply_to} – oder antworte einfach auf diese Mail.\n\nSobald deine Nachweise bei uns sind, schicken wir dir deinen 25 € Aral-Gutschein per E-Mail.\n${seller ? `\nEine Bitte von ${seller}: Ich würde mich riesig über deine 5-Sterne-Bewertung auf Google, Trustpilot und mobile.de freuen. Erwähne dabei gern meinen Namen, damit ich weiß, dass sie von dir kommt. Danke dir!\n` : ""}\nAllzeit gute Fahrt!\nDein Team der Autowelt Prusseit`;
  const subject = `Glückwunsch zu deinem neuen Auto, ${kunde}! Dein 25 € Tank-Bonus wartet ⛽`;
  return { html, text, subject };
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

async function sellerName(id: string) {
  const { data } = await admin.from("profiles").select("full_name").eq("id", id).maybeSingle();
  return first(data?.full_name);
}

async function sendOne(deal: Deal, cfg: Cfg, to: string) {
  const seller = await sellerName(deal.seller_id);
  const m = build(deal, seller, cfg);
  return sendMail({
    from: `${seller ? seller + " · " : ""}Autowelt Prusseit <${FROM_ADDR}>`,
    to: [to], reply_to: [cfg.reply_to],
    subject: m.subject, html: m.html, text: m.text,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST erwartet" }, 405);
  try {
    if (!RESEND) return json({ error: "RESEND_API_KEY fehlt" }, 500);
    const body = await req.json().catch(() => ({}));
    const { data: cfg } = await admin.from("review_config").select("*").single();
    if (!cfg) return json({ error: "review_config fehlt" }, 500);
    const { data: sec } = await admin.from("app_secrets").select("value").eq("name", "cron_secret").single();
    const cronOk = !!sec?.value && req.headers.get("x-cron-secret") === sec.value;

    // Testversand (Admin-Login oder Cron-Geheimnis)
    if (body.test_to) {
      let sellerId: string | null = body.seller_id ?? null;
      if (!cronOk) {
        const user = createClient(SB_URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
        const { data: u } = await user.auth.getUser();
        if (!u?.user) return json({ error: "Nicht angemeldet" }, 401);
        const { data: p } = await admin.from("profiles").select("role").eq("id", u.user.id).single();
        if (p?.role !== "admin") return json({ error: "Nur für Admins" }, 403);
        sellerId = sellerId ?? u.user.id;
      }
      let deal: Deal = { id: "test", seller_id: sellerId ?? "", customer_name: body.customer_name ?? "Max Mustermann", customer_email: null, vehicle: null, contract_no: null };
      if (body.deal_id) {
        const { data } = await admin.from("deals").select("id,seller_id,customer_name,customer_email,vehicle,contract_no").eq("id", body.deal_id).single();
        if (data) deal = data as Deal;
      }
      const id = await sendOne(deal, cfg as Cfg, String(body.test_to));
      return json({ ok: true, test: true, id });
    }

    // Täglicher Lauf
    if (!cronOk) return json({ error: "Nicht erlaubt" }, 401);
    if (!cfg.enabled) return json({ ok: true, disabled: true });

    const due = new Date(Date.now() - cfg.delay_days * 86400000).toISOString();
    const { data: deals, error } = await admin.from("deals")
      .select("id,seller_id,customer_name,customer_email,vehicle,contract_no")
      .in("status", ["signed", "sealed", "sent"]).eq("review_skip", false).is("review_sent_at", null)
      .not("customer_email", "is", null).not("signed_at", "is", null).lte("signed_at", due)
      .order("signed_at").limit(40);
    if (error) throw error;

    const out = { sent: 0, failed: 0 };
    for (const d of (deals ?? []) as Deal[]) {
      // Vorgang zuerst für uns reservieren, damit nie doppelt verschickt wird
      const { data: claimed } = await admin.from("deals").update({ review_sent_at: new Date().toISOString(), review_mail_status: "sending", review_mail_to: d.customer_email })
        .eq("id", d.id).is("review_sent_at", null).select("id");
      if (!claimed?.length) continue;
      try {
        const id = await sendOne(d, cfg as Cfg, d.customer_email!);
        await admin.from("deals").update({ review_mail_id: id, review_mail_status: "sent" }).eq("id", d.id);
        await admin.from("audit_events").insert({ deal_id: d.id, event: "review_requested", details: { to: d.customer_email, mail_id: id, delay_days: cfg.delay_days } });
        out.sent++;
      } catch (e) {
        console.error(d.id, e);
        // freigeben, damit es beim nächsten Lauf erneut versucht wird
        await admin.from("deals").update({ review_sent_at: null, review_mail_status: "failed" }).eq("id", d.id);
        out.failed++;
      }
      await new Promise(r => setTimeout(r, 600)); // Resend: max. 2 Anfragen pro Sekunde
    }
    return json({ ok: true, due: deals?.length ?? 0, ...out });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
