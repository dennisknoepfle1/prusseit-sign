// Schickt nach der Auslieferung beide Dokumente (CarGarantie-Übergabezertifikat + Auslieferungscheckliste) per Mail
// an die Person, die ausgeliefert hat. Der Kunde bekommt nichts (Entscheidung Dennis, 2026-11-28).
// POST { delivery_id }               → echte Auslieferung, Dateien kommen aus dem Storage
// POST { test:true, cert, list, ... } → Testfahrzeug: PDFs als Base64 aus dem Portal, Mail nur an den Aufrufer selbst
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY");
const FROM = "Prusseit Auslieferung <noreply@prusseit-sign.de>";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");

function shell(inner: string) {
  return `<!doctype html><html><body style="margin:0;background:#f4f3f3;font-family:Arial,Helvetica,sans-serif;color:#18151a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden">
<tr><td style="background:#0e0c0d;padding:18px 24px"><img src="https://dennisknoepfle1.github.io/prusseit-sign/logo-mail.png" width="210" height="60" alt="Autowelt Prusseit" style="display:block;border:0;width:210px;height:auto"></td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.5">${inner}</td></tr>
<tr><td style="padding:14px 24px;background:#f4f3f3;font-size:12px;color:#6a6265">Autowelt Prusseit GmbH · Rauher Grund 26 · 72160 Horb am Neckar · autowelt-prusseit.de</td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST erwartet" }, 405);
  try {
    const admin = createClient(SB_URL, SERVICE);
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return json({ error: "Nicht angemeldet" }, 401);
    const { data: me } = await admin.from("profiles").select("id,email,full_name,role,can_deliver").eq("id", u.user.id).single();
    if (!me || !(me.role === "admin" || me.can_deliver)) return json({ error: "Kein Zugang zur Auslieferung" }, 403);
    if (!RESEND) return json({ error: "Mailversand nicht eingerichtet" }, 500);

    const body = await req.json();
    let to = me.email, nr = "", kunde = "", fahrzeug = "", certB64 = "", listB64 = "", deal: string | null = null, test = false;

    if (body.test) {
      test = true;
      certB64 = String(body.cert ?? ""); listB64 = String(body.list ?? "");
      if (!certB64 || !listB64 || certB64.length + listB64.length > 12_000_000) return json({ error: "Dokumente fehlen" }, 400);
      nr = String(body.vorgang ?? "TEST"); kunde = String(body.kunde ?? "Testkunde"); fahrzeug = String(body.fahrzeug ?? "");
    } else {
      const { data: v } = await admin.from("deliveries").select("id,deal_id,created_by,status,cert_path,list_path,data").eq("id", body.delivery_id).single();
      if (!v || v.status !== "done" || !v.cert_path || !v.list_path) return json({ error: "Auslieferung nicht abgeschlossen" }, 409);
      if (v.created_by !== me.id && me.role !== "admin") return json({ error: "Keine Berechtigung" }, 403);
      const { data: by } = await admin.from("profiles").select("email").eq("id", v.created_by).single();
      to = by?.email ?? me.email;
      const [c, l] = await Promise.all([v.cert_path, v.list_path].map(p => admin.storage.from("contracts").download(p)));
      if (c.error || l.error) throw c.error ?? l.error;
      certB64 = b64(new Uint8Array(await c.data!.arrayBuffer())); listB64 = b64(new Uint8Array(await l.data!.arrayBuffer()));
      const d = v.data ?? {};
      nr = d.vorgang ?? ""; kunde = d.kunde?.name ?? ""; fahrzeug = [d.fz?.hersteller, d.fz?.modell].filter(Boolean).join(" ");
      deal = v.deal_id;
    }

    const tag = safe(nr || kunde || "Auslieferung");
    const subject = (test ? "TEST · " : "") + `Auslieferung ${nr} · ${kunde}${fahrzeug ? " · " + fahrzeug : ""}`.trim();
    const html = shell(`<p style="margin:0 0 12px">Hallo ${esc(me.full_name?.split(" ")[0] || "")},</p>
<p style="margin:0 0 12px">${test ? "<b>Das ist eine Testauslieferung.</b> " : ""}anbei die Unterlagen zur Auslieferung <b>${esc(nr)}</b> an <b>${esc(kunde)}</b>${fahrzeug ? " (" + esc(fahrzeug) + ")" : ""}:</p>
<ul style="margin:0 0 12px;padding-left:20px"><li>CarGarantie-Übergabezertifikat</li><li>Auslieferungscheckliste</li></ul>
<p style="margin:0;color:#6a6265;font-size:13px">Beide Dokumente liegen zusätzlich in Prusseit Sign beim Vorgang.</p>`);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, html,
        attachments: [{ filename: `Uebergabezertifikat_${tag}.pdf`, content: certB64 }, { filename: `Auslieferungscheckliste_${tag}.pdf`, content: listB64 }] }),
    });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend ${r.status}: ${res?.message ?? JSON.stringify(res)}`);
    if (deal) await admin.from("audit_events").insert({ deal_id: deal, event: "delivery_mailed", details: { delivery: body.delivery_id, to, mail_id: res.id } });
    return json({ ok: true, to, id: res.id });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
