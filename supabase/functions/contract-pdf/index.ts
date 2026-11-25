// Persönlicher Download-Link für den Kunden (QR-Code auf dem iPad oder Link in der Mail), ohne Login.
// GET ?t=<token>  →  Weiterleitung auf das versiegelte PDF (5 Minuten gültige Storage-URL).
// Jeder Abruf wird im Prüfprotokoll festgehalten („downloaded“), der erste per QR-Code auch am Vorgang (downloaded_at).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const text = (msg: string, status: number) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return text("Nicht erlaubt", 405);
  try {
    const token = new URL(req.url).searchParams.get("t") ?? "";
    if (token.length < 30) return text("Dieser Link ist unvollständig. Bitte öffnen Sie ihn noch einmal aus der E-Mail oder scannen Sie den QR-Code erneut.", 400);
    const { data: link } = await admin.from("pdf_links").select("id,deal_id,channel,expires_at,downloads,first_download_at").eq("token_hash", await sha256(token)).maybeSingle();
    if (!link) return text("Dieser Link ist ungültig. Bitte wenden Sie sich an Ihren Verkäufer bei der Autowelt Prusseit.", 404);
    if (new Date(link.expires_at) < new Date()) return text("Dieser Link ist abgelaufen. Ihr Verkäufer bei der Autowelt Prusseit schickt Ihnen den Vertrag gern noch einmal zu.", 410);
    const { data: deal } = await admin.from("deals").select("id,contract_no,customer_name,final_path,sealed_path,downloaded_at").eq("id", link.deal_id).single();
    const path = deal?.sealed_path ?? deal?.final_path;
    if (!deal || !path) return text("Der Vertrag ist noch nicht fertig. Bitte versuchen Sie es in einer Minute noch einmal.", 409);

    const fileName = `Kaufvertrag_${(deal.contract_no || deal.customer_name).replace(/[^\w.-]+/g, "_")}.pdf`;
    const { data: url, error } = await admin.storage.from("contracts").createSignedUrl(path, 300, { download: fileName });
    if (error || !url) throw error ?? new Error("Keine URL");

    if (req.method === "GET") {
      const now = new Date().toISOString();
      const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
      const ua = req.headers.get("user-agent") ?? null;
      await admin.from("pdf_links").update({ downloads: link.downloads + 1, first_download_at: link.first_download_at ?? now, last_download_at: now }).eq("id", link.id);
      // Mail-Links rufen Virenscanner mancher Postfächer selbst auf; als „vom Kunden geladen“ zählt deshalb nur der QR-Code.
      if (!deal.downloaded_at && link.channel === "qr") await admin.from("deals").update({ downloaded_at: now }).eq("id", deal.id);
      await admin.from("audit_events").insert({ deal_id: deal.id, event: "downloaded", details: { channel: link.channel, link: link.id, file: deal.sealed_path ? "sealed" : "final", ip, ua } });
    }
    return new Response(null, { status: 302, headers: { Location: url.signedUrl, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (e) {
    console.error(e);
    return text("Der Vertrag kann gerade nicht geladen werden. Bitte versuchen Sie es gleich noch einmal.", 500);
  }
});
