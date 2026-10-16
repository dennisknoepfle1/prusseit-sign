// Unterschrift per Link: der Kunde unterschreibt auf dem eigenen Gerät, ohne Login.
//  create  (Verkäufer, mit Login): Link erzeugen und per Mail an den Kunden schicken
//  load    (Kunde, mit Token):     Vertrag und Felder laden
//  submit  (Kunde, mit Token):     Unterschriften abgeben; der Verkäufer schließt danach im Archiv ab
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
const admin = createClient(SB_URL, SERVICE);

function shell(inner: string) {
  return `<!doctype html><html><body style="margin:0;background:#f4f3f3;font-family:Arial,Helvetica,sans-serif;color:#18151a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden">
<tr><td style="background:#0e0c0d;padding:18px 24px"><img src="https://dennisknoepfle1.github.io/prusseit-sign/logo-mail.png" width="210" height="60" alt="Autowelt Prusseit" style="display:block;border:0;width:210px;height:auto"></td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.5">${inner}</td></tr>
<tr><td style="padding:14px 24px;background:#f4f3f3;font-size:12px;color:#6a6265">Autowelt Prusseit GmbH · Rauher Grund 26 · 72160 Horb am Neckar · autowelt-prusseit.de</td></tr>
</table></td></tr></table></body></html>`;
}

async function request(token: unknown) {
  if (typeof token !== "string" || token.length < 30) return null;
  const { data } = await admin.from("sign_requests").select("*").eq("token_hash", await sha256(token)).maybeSingle();
  return data;
}
const audit = (deal_id: string, event: string, details: Record<string, unknown>) =>
  admin.from("audit_events").insert({ deal_id, event, details });

async function pushTo(userIds: string[], title: string, body: string) {
  const { data: keys } = await admin.from("app_secrets").select("name,value").in("name", ["vapid_public", "vapid_private"]);
  const k = Object.fromEntries((keys ?? []).map(r => [r.name, r.value]));
  if (!k.vapid_public || !k.vapid_private || !userIds.length) return 0;
  webpush.setVapidDetails("mailto:vertrag@prusseit-sign.de", k.vapid_public, k.vapid_private);
  const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,keys").in("user_id", userIds);
  let sent = 0;
  for (const s of subs ?? []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ title, body, url: APP_URL })); sent++; }
    catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 410 || c === 404) await admin.from("push_subscriptions").delete().eq("id", s.id); }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST erwartet" }, 405);
  try {
    const body = await req.json();
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
    const ua = req.headers.get("user-agent") ?? null;

    if (body.action === "create") {
      const user = createClient(SB_URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
      const { data: u } = await user.auth.getUser();
      if (!u?.user) return json({ error: "Nicht angemeldet" }, 401);
      const { data: deal, error } = await user.from("deals").select("id,contract_no,customer_name,status,locked_at,final_path,seller_id").eq("id", body.deal_id).single();
      if (error || !deal) return json({ error: "Vorgang nicht gefunden" }, 404);
      if (deal.final_path) return json({ error: "Vorgang ist bereits abgeschlossen" }, 409);
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Bitte eine gültige E-Mail-Adresse des Kunden angeben." }, 400);
      const p = body.payload;
      if (!p || !Array.isArray(p.fields) || !p.fields.some((f: { role: string; kind?: string }) => f.role === "kd" && (!f.kind || f.kind === "sig")))
        return json({ error: "Keine Unterschriftsfelder für den Kunden" }, 400);
      if (!RESEND) return json({ error: "Mailversand ist nicht eingerichtet" }, 500);
      if (JSON.stringify(p).length > 4_000_000) return json({ error: "Daten zu groß" }, 413);

      await admin.from("sign_requests").update({ status: "cancelled" }).eq("deal_id", deal.id).eq("status", "pending");
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const token = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const { data: sr, error: e2 } = await admin.from("sign_requests").insert({ deal_id: deal.id, token_hash: await sha256(token), customer_email: email, payload: p, created_by: u.user.id }).select("id,expires_at").single();
      if (e2) throw e2;
      const { data: seller } = await admin.from("profiles").select("email,full_name").eq("id", deal.seller_id).single();
      const sellerName = seller?.full_name || seller?.email || "Ihr Verkäufer";
      const link = APP_URL + "?sign=" + token;
      const until = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeZone: "Europe/Berlin" }).format(new Date(sr.expires_at));
      const nr = deal.contract_no || "";
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${sellerName.replace(/[<>"]/g, "")} · Autowelt Prusseit <${FROM_ADDR}>`, to: [email], reply_to: seller?.email ? [seller.email] : undefined,
          subject: `Ihr Kaufvertrag ${nr} zur Unterschrift – Autowelt Prusseit`.replace("  ", " "),
          html: shell(`<p>Guten Tag ${esc(deal.customer_name)},</p>
<p>${esc(sellerName)} hat Ihren Kaufvertrag${nr ? " " + esc(nr) : ""} vorbereitet. Bitte prüfen Sie den Vertrag und unterschreiben Sie ihn direkt auf Ihrem Smartphone, Tablet oder Computer.</p>
<p style="padding:8px 0"><a href="${link}" style="background:#e3001b;color:#fff;text-decoration:none;font-weight:bold;padding:13px 24px;border-radius:8px;display:inline-block">Vertrag ansehen und unterschreiben</a></p>
<p style="font-size:13px;color:#6a6265">Der Link ist persönlich und bis zum ${until} gültig. Bitte leiten Sie diese E-Mail nicht weiter. Nach der Unterschrift erhalten Sie den fertigen Vertrag als PDF per E-Mail.</p>
<p>Mit freundlichen Grüßen<br>${esc(sellerName)}<br>Autowelt Prusseit GmbH</p>`),
          text: `Guten Tag ${deal.customer_name},\n\n${sellerName} hat Ihren Kaufvertrag ${nr} vorbereitet. Bitte prüfen und unterschreiben Sie ihn hier:\n${link}\n\nDer Link ist persönlich und bis zum ${until} gültig.\n\nMit freundlichen Grüßen\n${sellerName}\nAutowelt Prusseit GmbH`,
        }),
      });
      const rb = await r.json().catch(() => ({}));
      if (!r.ok) { await admin.from("sign_requests").delete().eq("id", sr.id); throw new Error(`Resend ${r.status}: ${rb?.message ?? ""}`); }
      await user.from("deals").update({ status: "remote", customer_email: email }).eq("id", deal.id);
      await user.from("audit_events").insert({ deal_id: deal.id, event: "remote_requested", details: { email, request: sr.id, expires_at: sr.expires_at, mail_id: rb.id, ua } });
      return json({ ok: true, expires_at: sr.expires_at });
    }

    const sr = await request(body.token);
    if (!sr || sr.status === "cancelled") return json({ error: "Dieser Link ist nicht mehr gültig. Bitte wenden Sie sich an Ihren Verkäufer." }, 404);
    if (sr.status === "signed") return json({ done: true });
    if (new Date(sr.expires_at) < new Date()) return json({ error: "Dieser Link ist abgelaufen. Bitte wenden Sie sich an Ihren Verkäufer." }, 410);
    const { data: deal } = await admin.from("deals").select("id,contract_no,customer_name,vehicle,original_path,original_sha256,seller_id,final_path").eq("id", sr.deal_id).single();
    if (!deal || deal.final_path) return json({ done: true });

    if (body.action === "load") {
      const { data: url, error } = await admin.storage.from("contracts").createSignedUrl(deal.original_path, 3600);
      if (error) throw error;
      if (!sr.opened_at) {
        await admin.from("sign_requests").update({ opened_at: new Date().toISOString() }).eq("id", sr.id);
        await audit(deal.id, "remote_opened", { ip, ua });
      }
      return json({ ok: true, payload: sr.payload, pdf_url: url.signedUrl, original_sha256: deal.original_sha256 });
    }

    if (body.action === "submit") {
      const kd = (sr.payload.fields as { id: string; role: string; kind?: string }[]).filter(f => f.role === "kd" && (!f.kind || f.kind === "sig"));
      const sigs = body.sigs ?? {};
      const out: Record<string, unknown> = {};
      const now = new Date().toISOString();
      for (const f of kd) {
        const s = sigs[f.id];
        if (!s || typeof s.url !== "string" || !s.url.startsWith("data:image/png;base64,") || s.url.length > 800_000) return json({ error: "Es fehlt noch eine Unterschrift." }, 400);
        if (!Array.isArray(s.raw) || !s.raw.length) return json({ error: "Unterschrift ist leer." }, 400);
        const printed = String(s.printed ?? "").trim().toLocaleUpperCase("de-DE");
        if (printed.length < 3) return json({ error: "Bitte Ihren Namen in Druckbuchstaben eintragen." }, 400);
        const pts = (s.raw as { t: number; p: number; k: string }[][]).flat();
        out[f.id] = {
          url: s.url, printed, signedAt: typeof s.signedAt === "string" ? s.signedAt : now, receivedAt: now,
          strokes: s.raw.length, points: pts.length, durationMs: pts.length ? pts[pts.length - 1].t - pts[0].t : 0,
          pressure: pts.some(p => p.p !== 0.5 && p.p !== 0), input: pts.some(p => p.k === "p") ? "Stift" : pts.some(p => p.k === "t") ? "Finger" : "Maus",
          bioHash: await sha256(JSON.stringify(s.raw)), consent: !!s.consent, ua, ip, email: sr.customer_email,
        };
      }
      const { data: upd } = await admin.from("sign_requests").update({ status: "signed", result: out, signed_at: now, signed_ip: ip, signed_ua: ua }).eq("id", sr.id).eq("status", "pending").select("id");
      if (!upd?.length) return json({ done: true });
      for (const f of kd) {
        const s = out[f.id] as { bioHash: string; printed: string; consent: boolean; strokes: number; points: number; input: string; signedAt: string };
        await admin.from("signatures").insert({ deal_id: deal.id, field_id: f.id, signer_role: "customer", signer_name: deal.customer_name, biometric_hash: s.bioHash, user_agent: ua });
        await audit(deal.id, "signed", { field: f.id, role: "kd", name: deal.customer_name, printed: s.printed, bio_sha256: s.bioHash, strokes: s.strokes, points: s.points, input: s.input, consent: s.consent, signed_at_client: s.signedAt, remote: true, ip, ua });
      }
      await admin.from("deals").update({ status: "remote_signed" }).eq("id", deal.id);
      await audit(deal.id, "remote_signed", { request: sr.id, email: sr.customer_email, ip, ua });
      let push = 0;
      try { push = await pushTo([deal.seller_id], "Kunde hat unterschrieben", `${deal.customer_name} · ${deal.vehicle || deal.contract_no || "Vertrag"} · jetzt im Archiv abschließen`); } catch (e) { console.error(e); }
      return json({ ok: true, push });
    }
    return json({ error: "Unbekannte Aktion" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
