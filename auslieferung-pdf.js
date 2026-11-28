/* Auslieferungsportal: Dokumente bauen (läuft im Browser mit pdf-lib, für Tests auch in Node).
   - buildCert: CarGarantie-Übergabezertifikat (Original-Vorlage) mit Daten, Kreuzen und Unterschriften füllen
   - buildList: eigene Auslieferungscheckliste im Autowelt-Prusseit-Design
   Unterschriften kommen als PNG aus dem Portal, nie vom Papier. */
(function (root) {
  "use strict";
  const H = 842; // A4-Höhe in pt, Vorlage ist 595 × 842
  const W1252 = s => String(s ?? "").replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”„•…€]/g, "?");

  /* Prüfergebnis rechts: Zeile (Oberkante des Kästchens) und ob „ja“ der gute Zustand ist */
  const PRUEF = [
    ["kupplung", 207.4, true, "Kupplung, Schaltung bzw. Automatik ohne Beanstandung"],
    ["geraeusche", 218.5, false, "Ungewöhnliche Geräusche aufgefallen"],
    ["bremsfl", 240.8, true, "Bremsflüssigkeitsstand i. O."],
    ["kuehlfl", 251.9, true, "Kühlflüssigkeitsstand i. O., Frostschutz bis mind. -25 °C"],
    ["motoroel", 263.1, true, "Motoröl-Stand i. O."],
    ["sitze", 285.4, true, "Sitze nur leichte altersbedingte Abnutzung"],
    ["verkleidung", 296.5, true, "Verkleidungen, Teppich, Himmel dem Alter entsprechend"],
    ["heizung", 307.6, true, "Heizungs- und Lüftungssystem einwandfrei"],
    ["schiebedach", 318.8, true, "Schiebedach funktioniert einwandfrei"],
    ["klima", 329.9, true, "Klimaanlage funktioniert einwandfrei"],
    ["fenster", 341.0, true, "Fensterheber funktionieren einwandfrei"],
    ["sitzverst", 352.2, true, "Sitzverstellungen funktionieren einwandfrei"],
    ["geruch", 363.3, true, "Frei von unangenehmen Gerüchen"],
    ["sonderausst", 385.6, true, "Sonderausstattung/Zubehör funktionstüchtig"],
    ["zv", 407.8, true, "Zentralverriegelung bzw. Schließanlage einwandfrei"],
    ["wischer", 419.0, true, "Scheibenwischer einwandfrei"],
    ["spiegel", 430.1, true, "Rück- und Außenspiegel einwandfrei"],
    ["licht", 441.2, true, "Beleuchtung und Blinker funktionsfähig"],
    ["tueren", 452.4, true, "Türen und Motorhaube mechanisch einwandfrei"],
    ["scheiben", 463.5, true, "Scheiben rundum einwandfrei"],
    ["karosserie", 474.6, false, "Beschädigungen an der Karosserie"],
    ["unfall", 485.8, false, "Sichtbare Unfallschäden festgestellt"],
    ["lack", 496.9, true, "Dem Fahrzeugalter entsprechender Lack"],
    ["oel", 508.0, false, "Sichtbare Ölverluste"],
    ["reifen", 530.3, true, "Reifenprofil mindestens 3 mm"],
    ["felgen", 541.4, true, "Felgen ohne sichtbare Schäden"],
    ["bremse", 563.7, true, "Bremswirkung in Ordnung"],
  ];
  const JA_X = 522.6, NEIN_X = 542.4;

  /* Auslieferungscheckliste: Punkte in Gruppen; na = darf „entfällt“ sein */
  const LIST = [
    ["Unterlagen", [
      ["kaufunterlagen", "Kaufunterlagen erhalten (Kaufvertrag, ggf. Kreditvertrag, vorvertragliche Informationen)"],
      ["garantie", "Garantieunterlagen aller Anbieter erhalten und erklärt"],
      ["papiere", "Fahrzeugpapiere erhalten"],
      ["kopieschein", "Kopie des Fahrzeugscheins mit aktueller Zulassung abgelegt"],
      ["brief", "Brief im Original vom Kunden erhalten, Haltereintrag korrekt"],
      ["ausgangscheck", "Ausgangscheck erhalten, gelesen und zur Kenntnis genommen"],
      ["agb", "AGB erhalten und akzeptiert"],
    ]],
    ["Fahrzeug", [
      ["sauber", "Fahrzeug auf Sauberkeit geprüft"],
      ["tank", "Tankleuchte aus"],
      ["raeder", "Räder im Fahrzeug", true],
      ["qr", "QR-Code entfernt"],
      ["preis", "Preisschilder aus dem Fahrzeug entfernt"],
      ["anhaenger", "Schlüsselanhänger entfernt"],
    ]],
    ["Übergabe", [
      ["schluessel", "Schlüssel übergeben"],
      ["funktion", "Funktionen des Fahrzeugs erklärt"],
      ["zustand", "Fahrzeug in ordnungsgemäßem Zustand übergeben"],
      ["deutsch", "Kunde verfügt über ausreichende Deutschkenntnisse"],
      ["bild", "Übergabefoto gemacht", true],
    ]],
  ];
  const PAY = [["ueberweisung", "Überweisung"], ["finanzierung", "Finanzierung"]];
  const ZUL = [["online", "Online über uns zugelassen"], ["brief", "Kunde hat selbst zugelassen (Brief)"]];
  /* Punkt „brief“ gibt es nur, wenn der Kunde den Brief mitbringt */
  const itemsFor = d => LIST.map(([g, its]) => [g, its.filter(([k]) => k !== "brief" || d.zulassung === "brief")]);

  const fmtDate = d => new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" }).format(d);
  const fmtTime = d => new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }).format(d);

  const BEM_DEFAULT = "Allgemeine Gebrauchsspuren, dem Alter und der Laufleistung entsprechend.";
  function fitText(font, s, size, max) {
    s = W1252(s);
    while (size > 5.5 && font.widthOfTextAtSize(s, size) > max) size -= 0.25;
    if (font.widthOfTextAtSize(s, size) > max) { while (s.length > 1 && font.widthOfTextAtSize(s + "…", size) > max) s = s.slice(0, -1); s += "…"; }
    return { s, size };
  }

  /* ---------- CarGarantie-Übergabezertifikat ---------- */
  async function buildCert(PDFLib, tplBytes, d, sig) {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.load(tplBytes);
    const pg = doc.getPage(0);
    const f = await doc.embedFont(StandardFonts.Helvetica);
    const ink = rgb(0.05, 0.12, 0.42); // Kugelschreiber-Blau, hebt sich vom Formular ab
    const txt = (s, x, top, max = 160, size = 9) => {
      if (s == null || s === "") return;
      const t = fitText(f, s, size, max);
      pg.drawText(t.s, { x, y: H - top - 7.6, size: t.size, font: f, color: ink });
    };
    const cross = (x0, top) => {
      const a = 0.6, s = 4.6;
      const o = { thickness: 1.1, color: ink };
      pg.drawLine({ start: { x: x0 - a, y: H - top + a }, end: { x: x0 + s + a, y: H - top - s - a }, ...o });
      pg.drawLine({ start: { x: x0 - a, y: H - top - s - a }, end: { x: x0 + s + a, y: H - top + a }, ...o });
    };
    const fz = d.fz || {}, kd = d.kunde || {};

    // Interne Vermerke: immer privat genutzt, Kunde kauft privat, Probefahrt ja
    txt(d.datum, 345, 100.6, 100);
    cross(154.1, 117.0); cross(154.1, 132.7);
    if (d.probefahrt !== false) cross(154.1, 148.3); else cross(174.3, 148.3);
    txt(d.verkaeufer, 352, 131.9, 205);
    txt(d.auslieferer, 380, 147.6, 180);

    // Kunde
    txt(kd.name, 130, 194.8, 170);
    txt(kd.strasse, 130, 241.8, 170);
    txt(kd.ort, 130, 257.4, 170);
    txt(kd.tel, 130, 273.1, 170);

    // Fahrzeug
    txt([fz.hersteller, fz.modell].filter(Boolean).join(" "), 130, 329.5, 170);
    txt(fz.fin, 130, 345.2, 170);
    txt(fz.ccm, 80, 360.9, 68);
    txt(fz.kw, 182, 360.9, 118);
    txt(fz.baujahr, 90, 376.5, 58);
    txt(fz.ez, 210, 376.5, 90);
    txt(fz.farbe, 130, 423.5, 170);
    txt(d.kmAus || fz.km, 130, 454.9, 170);
    if (fz.unfallfrei === true) cross(154.1, 486.9); else if (fz.unfallfrei === false) cross(173.9, 486.9);
    txt(fz.hu, 250, 533.2, 50);
    txt(fz.vorbesitzer, 180, 580.2, 120);
    txt(d.sonstiges, 60, 713.5, 240);

    // Prüfergebnis: alles in Ordnung, Abweichungen aus dem Portal
    const pr = d.pruef || {};
    for (const [k, top, good] of PRUEF) {
      const ok = pr[k] !== false; // Standard: in Ordnung
      const ja = ok ? good : !good;
      cross(ja ? JA_X : NEIN_X, top);
    }
    // Sonstige Bemerkungen: zwei Linien, Standardtext (Dennis 2026-11-28)
    {
      // Zeile 1 rechts neben dem Label, Zeile 2 über die volle Breite
      const slots = [[401, 702.5, 143], [318, 717.5, 228]], size = 8.5;
      const words = W1252(d.bemerkungen ?? BEM_DEFAULT).split(/\s+/).filter(Boolean), lines = [""];
      for (const w of words) { const i = lines.length - 1, t = (lines[i] + " " + w).trim();
        if (i === slots.length - 1 || f.widthOfTextAtSize(t, size) <= slots[i][2] || !lines[i]) lines[i] = t; else lines.push(w); }
      lines.forEach((l, i) => { const [x, top, max] = slots[i], t = fitText(f, l, size, max); pg.drawText(t.s, { x, y: H - top, size: t.size, font: f, color: ink }); });
    }

    // Übergabe
    txt([d.ort, d.datum].filter(Boolean).join(", "), 160, 789.4, 140);
    await drawSig(doc, pg, sig?.ausl, 140, H - 816, 160, 22);
    await drawSig(doc, pg, sig?.kunde, 385, H - 816, 160, 22);
    const note = "Elektronisch unterschrieben" + (sig?.at ? " am " + d.datum + ", " + fmtTime(new Date(sig.at)) + " Uhr" : "") + " · Prusseit Sign · Vorgang " + (d.vorgang || "");
    pg.drawText(W1252(note), { x: 56.6, y: H - 828, size: 5.5, font: f, color: rgb(0.45, 0.45, 0.5) });
    return doc.save();
  }

  async function drawSig(doc, pg, s, x, y, maxW, maxH) {
    if (!s?.png) return;
    const img = await doc.embedPng(s.png);
    const sc = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * sc, h = img.height * sc;
    pg.drawImage(img, { x: x + (maxW - w) / 2, y, width: w, height: h });
  }

  /* ---------- Eigene Auslieferungscheckliste ---------- */
  async function buildList(PDFLib, logoPng, d, sig) {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    doc.setTitle("Auslieferungscheckliste " + (d.vorgang || ""));
    doc.setAuthor("Autowelt Prusseit GmbH");
    doc.setCreator("Prusseit Sign");
    const pg = doc.addPage([595.28, 841.89]);
    const R = await doc.embedFont(StandardFonts.Helvetica), B = await doc.embedFont(StandardFonts.HelveticaBold);
    const red = rgb(0.89, 0, 0.106), ink = rgb(0.086, 0.075, 0.1), mut = rgb(0.42, 0.38, 0.4), line = rgb(0.86, 0.83, 0.84), soft = rgb(0.975, 0.97, 0.965), okc = rgb(0.118, 0.478, 0.298);
    const L = 48, Rt = 547.28, top = 841.89;
    const t = (s, x, y, o = {}) => { const font = o.b ? B : R, size = o.size || 9; const v = o.max ? fitText(font, s, size, o.max) : { s: W1252(s), size };
      const xx = o.right ? x - font.widthOfTextAtSize(v.s, v.size) : x; pg.drawText(v.s, { x: xx, y, size: v.size, font, color: o.c || ink }); };
    const hl = (y, c = line, th = 0.6, x0 = L, x1 = Rt) => pg.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness: th, color: c });
    const fz = d.fz || {}, kd = d.kunde || {};

    // Kopf
    const logo = await doc.embedPng(logoPng);
    pg.drawImage(logo, { x: L, y: top - 86, width: 140, height: 40 });
    t("AUSLIEFERUNG", Rt, top - 58, { b: true, size: 8, c: red, right: true });
    t("Auslieferungscheckliste", Rt, top - 78, { b: true, size: 19, right: true });
    t("Vorgang " + (d.vorgang || "–") + "  ·  " + (d.datum || "") + (d.uhrzeit ? ", " + d.uhrzeit + " Uhr" : ""), Rt, top - 92, { size: 9, c: mut, right: true });
    pg.drawRectangle({ x: L, y: top - 106, width: Rt - L, height: 2.2, color: red });

    // Fahrzeug und Käufer
    let y = top - 128;
    const box = (x, w, title, rows) => {
      t(title.toUpperCase(), x, y, { b: true, size: 7.5, c: mut });
      let yy = y - 16;
      for (const [k, v] of rows) { t(k, x, yy, { size: 8, c: mut }); t(v || "–", x + 78, yy, { size: 9.5, b: k === "Fahrzeug" || k === "Name", max: w - 82 }); yy -= 15; }
      return yy;
    };
    const mid = L + (Rt - L) / 2 + 8;
    const y1 = box(L, mid - L - 16, "Fahrzeug", [
      ["Fahrzeug", [fz.hersteller, fz.modell].filter(Boolean).join(" ")], ["FIN", fz.fin], ["Zulassung", [(ZUL.find(([k]) => k === d.zulassung) || [, ""])[1], (d.scanInfo || []).join(", ")].filter(Boolean).join(" · ")],
      ["Erstzulassung", fz.ez], ["km bei Auslief.", d.kmAus ? d.kmAus + " km" : ""]]);
    const y2 = box(mid, Rt - mid, "Käufer", [
      ["Name", kd.name], ["Anschrift", [kd.strasse, kd.ort].filter(Boolean).join(", ")], ["Telefon", kd.tel],
      ["Verkäufer", d.verkaeufer], ["Ausgeliefert von", d.auslieferer]]);
    y = Math.min(y1, y2) - 4; hl(y);

    // Zahlung
    y -= 18; t("ZAHLUNG", L, y, { b: true, size: 7.5, c: mut });
    y -= 16;
    const z = d.zahlung || {};
    t("Zahlungsweise lt. Kaufvertrag", L, y, { size: 8, c: mut }); t(z.weise || "–", L + 130, y, { size: 9.5, b: true, max: 140 });
    t("Gesamtbetrag", mid, y, { size: 8, c: mut }); t(z.gesamt || "–", mid + 78, y, { size: 9.5, b: true });
    y -= 17;
    let px = L;
    for (const [k, lab] of [...PAY, ["inzahlung", "mit Inzahlungnahme"]]) { const on = k === "inzahlung" ? !!z.inzahlung : z.art === k;
      tick(px, y - 1.5, on); t(lab, px + 15, y, { size: 9 }); px += R.widthOfTextAtSize(lab, 9) + 32; }
    y -= 17;
    if (z.art === "finanzierung") {
      const keine = z.anzahlungOk === "keine";
      tick(L, y - 1.5, z.anzahlungOk === true, keine);
      t(keine ? "Keine Anzahlung vereinbart" : "Anzahlung eingegangen" + (z.anzahlung ? " (" + z.anzahlung + ")" : ""), L + 15, y, { size: 9, b: true });
    } else { tick(L, y - 1.5, !!z.geldeingang); t("Zahlungseingang geprüft", L + 15, y, { size: 9, b: true }); }
    y -= 12; hl(y);

    function tick(x, yb, on, na) {
      pg.drawRectangle({ x, y: yb, width: 10, height: 10, borderColor: on ? okc : rgb(0.6, 0.57, 0.58), borderWidth: 0.9, color: on ? rgb(0.9, 0.96, 0.92) : undefined });
      if (on) { pg.drawLine({ start: { x: x + 2.2, y: yb + 5.2 }, end: { x: x + 4.3, y: yb + 2.6 }, thickness: 1.5, color: okc });
        pg.drawLine({ start: { x: x + 4.3, y: yb + 2.6 }, end: { x: x + 8.2, y: yb + 8 }, thickness: 1.5, color: okc }); }
      if (na) pg.drawLine({ start: { x: x + 2.5, y: yb + 5 }, end: { x: x + 7.5, y: yb + 5 }, thickness: 1.2, color: mut });
    }

    // Checkliste in zwei Spalten
    y -= 18;
    const ck = d.checks || {}, LST = itemsFor(d);
    const colW = (Rt - L - 24) / 2;
    const cols = [[LST[0]], [LST[1], LST[2]]];
    let yEnd = y;
    cols.forEach((groups, ci) => {
      let yy = y; const x = L + ci * (colW + 24);
      for (const [g, items] of groups) {
        t(g.toUpperCase(), x, yy, { b: true, size: 7.5, c: mut }); yy -= 6;
        for (const [k, lab] of items) {
          const v = ck[k];
          const lines = wrap(R, lab + (k === "schluessel" && d.schluessel ? " (" + d.schluessel + " Stück)" : ""), 9, colW - 66);
          const hgt = 6 + lines.length * 11;
          yy -= hgt;
          pg.drawRectangle({ x, y: yy, width: colW, height: hgt - 2, color: soft });
          tick(x + 6, yy + (hgt - 2) / 2 - 5, v === "ok", v === "na");
          lines.forEach((s, i) => t(s, x + 22, yy + hgt - 13 - i * 11, { size: 9 }));
          t(v === "ok" ? "erledigt" : v === "na" ? "entfällt" : "offen", x + colW - 6, yy + (hgt - 2) / 2 - 3, { size: 7.5, b: true, c: v === "ok" ? okc : v === "na" ? mut : red, right: true });
          yy -= 3;
        }
        yy -= 12;
      }
      yEnd = Math.min(yEnd, yy);
    });
    y = yEnd + 4;
    if (d.notiz) { y -= 4; t("Notiz", L, y, { size: 8, c: mut }); wrap(R, d.notiz, 9, Rt - L - 60).slice(0, 3).forEach((s, i) => t(s, L + 60, y - i * 11, { size: 9 })); y -= 36; }

    // Bestätigung und Unterschriften
    hl(y);
    y -= 16;
    const conf = "Mit seiner Unterschrift bestätigt der Käufer, das oben genannte Fahrzeug mit den aufgeführten Unterlagen und Schlüsseln in ordnungsgemäßem Zustand erhalten zu haben. Die Funktionen des Fahrzeugs wurden ihm erklärt.";
    wrap(R, conf, 8.5, Rt - L).forEach(s => { t(s, L, y, { size: 8.5, c: mut }); y -= 11; });
    y -= 4;
    t("Ort, Datum", L, y, { size: 8, c: mut }); t([d.ort, d.datum].filter(Boolean).join(", ") + (d.uhrzeit ? ", " + d.uhrzeit + " Uhr" : ""), L + 60, y, { size: 9.5 });
    y -= 52;
    const sw = (Rt - L - 30) / 2;
    for (const [i, who, s, name] of [[0, "Unterschrift Käufer", sig?.kunde, kd.name], [1, "Unterschrift Auslieferer", sig?.ausl, d.auslieferer]]) {
      const x = L + i * (sw + 30);
      await drawSig(doc, pg, s, x, y + 3, sw, 40);
      hl(y, ink, 0.7, x, x + sw);
      t(who, x, y - 11, { size: 8, c: mut });
      t(name || "", x + sw, y - 11, { size: 8, b: true, right: true, max: sw - 110 });
      if (s?.at) t("unterschrieben " + fmtDate(new Date(s.at)) + ", " + fmtTime(new Date(s.at)) + " Uhr", x, y - 21, { size: 7, c: mut });
    }

    // Fuß
    hl(56, line);
    t("Autowelt Prusseit GmbH · Rauher Grund 26 · 72160 Horb am Neckar · 07451 5569-900 · autowelt-prusseit.de", L, 44, { size: 7, c: mut });
    t("Erstellt mit Prusseit Sign · " + (d.vorgang || ""), Rt, 44, { size: 7, c: mut, right: true });
    return doc.save();
  }

  function wrap(font, s, size, max) {
    const out = []; let cur = "";
    for (const w of W1252(s).split(/\s+/)) { const n = cur ? cur + " " + w : w; if (font.widthOfTextAtSize(n, size) > max && cur) { out.push(cur); cur = w; } else cur = n; }
    if (cur) out.push(cur); return out;
  }

  root.APDF = { PRUEF, LIST, PAY, ZUL, itemsFor, buildCert, buildList, fmtDate, fmtTime };
  if (typeof module !== "undefined") module.exports = root.APDF;
})(typeof window !== "undefined" ? window : globalThis);
