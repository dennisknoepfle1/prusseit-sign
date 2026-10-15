// Versiegelt das fertig unterschriebene PDF (PAdES, ETSI.CAdES.detached) mit dem Siegelzertifikat
// der Autowelt Prusseit GmbH und einem RFC-3161-Zeitstempel. Speichert es als sealed.pdf.
// Aufruf aus der App: POST { deal_id }, mit dem Login des Verkäufers (JWT).
import { createClient } from "@supabase/supabase-js";
import { makeSealCertificate, sealPdf } from "./seal.js";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const TSA = Deno.env.get("TSA_URL") ?? "http://timestamp.digicert.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");

async function sealKeys(admin: ReturnType<typeof createClient>) {
  const { data } = await admin.from("app_secrets").select("name,value").in("name", ["seal_cert_pem", "seal_key_pem"]);
  const k = Object.fromEntries((data ?? []).map((r: { name: string; value: string }) => [r.name, r.value]));
  if (k.seal_cert_pem && k.seal_key_pem) return { certPem: k.seal_cert_pem, keyPem: k.seal_key_pem };
  // Erstes Siegel: Zertifikat erzeugen, Schlüssel verlässt den Server nie
  const c = makeSealCertificate();
  const { error } = await admin.from("app_secrets").insert([{ name: "seal_cert_pem", value: c.certPem }, { name: "seal_key_pem", value: c.keyPem }]);
  if (error) { // parallel erzeugt? dann das gespeicherte nehmen
    const again = await admin.from("app_secrets").select("name,value").in("name", ["seal_cert_pem", "seal_key_pem"]);
    const a = Object.fromEntries((again.data ?? []).map((r: { name: string; value: string }) => [r.name, r.value]));
    return { certPem: a.seal_cert_pem, keyPem: a.seal_key_pem };
  }
  return c;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST erwartet" }, 405);
  try {
    const user = createClient(SB_URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const admin = createClient(SB_URL, SERVICE);
    const { deal_id, selftest } = await req.json();
    if (selftest === true) { // Funktionsprüfung ohne Daten: Muster-PDF mit Wegwerf-Zertifikat siegeln
      const { PDFDocument } = await import("pdf-lib");
      const d = await PDFDocument.create(); d.addPage();
      const t = await sealPdf(await d.save({ useObjectStreams: false }), { ...makeSealCertificate({ years: 1 }), tsaUrl: TSA }).catch(e => ({ error: String(e) }));
      return json("pdf" in t ? { ok: true, timestamped: t.timestamped, pdf_b64: btoa(String.fromCharCode(...t.pdf)) } : t);
    }
    if (!deal_id) return json({ error: "deal_id fehlt" }, 400);

    const { data: deal, error } = await user.from("deals").select("id,final_path,final_sha256,sealed_path,sealed_sha256,timestamped").eq("id", deal_id).single();
    if (error || !deal) return json({ error: "Vorgang nicht gefunden" }, 404);
    if (!deal.final_path) return json({ error: "Vertrag ist noch nicht abgeschlossen" }, 409);
    if (deal.sealed_path) return json({ ok: true, already: true, sealed_sha256: deal.sealed_sha256, timestamped: deal.timestamped });

    const dl = await admin.storage.from("contracts").download(deal.final_path);
    if (dl.error) throw dl.error;
    const finalBytes = new Uint8Array(await dl.data.arrayBuffer());
    if (hex(await crypto.subtle.digest("SHA-256", finalBytes)) !== deal.final_sha256) throw new Error("Finales PDF passt nicht zum gespeicherten Fingerabdruck");

    const keys = await sealKeys(admin);
    let res, tsaError = null;
    try { res = await sealPdf(finalBytes, { ...keys, tsaUrl: TSA }); }
    catch (e) { tsaError = String((e as Error).message ?? e); res = await sealPdf(finalBytes, { ...keys, tsaUrl: null }); }

    const sealedSha = hex(await crypto.subtle.digest("SHA-256", res.pdf));
    const path = deal.id + "/sealed.pdf";
    const up = await admin.storage.from("contracts").upload(path, new Blob([res.pdf], { type: "application/pdf" }), { contentType: "application/pdf", upsert: false });
    if (up.error) throw up.error;
    const u = await admin.from("deals").update({ sealed_path: path, sealed_sha256: sealedSha, sealed_at: new Date().toISOString(), timestamped: res.timestamped, status: "sealed" }).eq("id", deal.id);
    if (u.error) throw u.error;
    await user.from("audit_events").insert({ deal_id: deal.id, event: "sealed", details: { sealed_sha256: sealedSha, final_sha256: deal.final_sha256, timestamped: res.timestamped, tsa: res.timestamped ? TSA : null, tsa_error: tsaError } });
    return json({ ok: true, sealed_sha256: sealedSha, timestamped: res.timestamped, tsa_error: tsaError });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
