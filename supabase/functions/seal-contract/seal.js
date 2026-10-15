// PAdES-Siegel (ETSI.CAdES.detached) mit optionalem RFC-3161-Zeitstempel.
// Baut die CMS-Signatur selbst mit node-forge, damit signing-certificate-v2 und der Zeitstempel drin sind.
// Läuft in Node (Tests) und in Deno (Edge Function) mit denselben Imports.
import forge from "node-forge";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { PDFDocument } from "pdf-lib";
import signpdfMod from "@signpdf/signpdf";
import { Signer, SUBFILTER_ETSI_CADES_DETACHED } from "@signpdf/utils";

const signpdf = signpdfMod.default ?? signpdfMod;
const { asn1, pki, md, util } = forge;
const A = asn1.Class.UNIVERSAL, T = asn1.Type;
const seq = (v) => asn1.create(A, T.SEQUENCE, true, v);
const set = (v) => asn1.create(A, T.SET, true, v);
const oid = (o) => asn1.create(A, T.OID, false, asn1.oidToDer(o).getBytes());
const octets = (b) => asn1.create(A, T.OCTETSTRING, false, b);
const int = (bytes) => asn1.create(A, T.INTEGER, false, bytes);
const nul = () => asn1.create(A, T.NULL, false, "");
const algSha256 = () => seq([oid(pki.oids.sha256), nul()]);
const der = (o) => asn1.toDer(o).getBytes();
const toBytes = (buf) => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return s; };
const sha256 = (bytes) => { const h = md.sha256.create(); h.update(bytes); return h.digest().getBytes(); };

/** Selbst ausgestelltes Siegelzertifikat (einmalig erzeugen, PEMs in app_secrets ablegen). */
export function makeSealCertificate({ years = 10 } = {}) {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + util.bytesToHex(forge.random.getBytesSync(15));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + years * 365.25 * 864e5);
  const attrs = [
    { name: "commonName", value: "Prusseit Sign Siegel" },
    { name: "organizationName", value: "Autowelt Prusseit GmbH" },
    { name: "localityName", value: "Horb am Neckar" },
    { name: "countryName", value: "DE" },
  ];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, md.sha256.create());
  return { certPem: pki.certificateToPem(cert), keyPem: pki.privateKeyToPem(keys.privateKey) };
}

async function timestampToken(signatureBytes, tsaUrl) {
  const nonce = forge.random.getBytesSync(8);
  const req = seq([
    int(String.fromCharCode(1)),
    seq([algSha256(), octets(sha256(signatureBytes))]),
    int(String.fromCharCode(0) + nonce),
    asn1.create(A, T.BOOLEAN, false, String.fromCharCode(0xff)),
  ]);
  const body = util.binary.raw.decode(der(req));
  const r = await fetch(tsaUrl, { method: "POST", headers: { "Content-Type": "application/timestamp-query" }, body });
  if (!r.ok) throw new Error("Zeitstempeldienst antwortet " + r.status);
  const resp = asn1.fromDer(toBytes(await r.arrayBuffer()));
  const status = resp.value[0].value[0].value.charCodeAt(0);
  if (status > 1) throw new Error("Zeitstempel abgelehnt (Status " + status + ")");
  return resp.value[1]; // TimeStampToken (ContentInfo)
}

class SealSigner extends Signer {
  constructor(certPem, keyPem, tsaUrl) { super(); this.cert = pki.certificateFromPem(certPem); this.key = pki.privateKeyFromPem(keyPem); this.tsaUrl = tsaUrl; this.tsa = null; }
  async sign(pdfBuffer, signingTime = new Date()) {
    const certAsn1 = pki.certificateToAsn1(this.cert);
    const signed = set([
      seq([oid(pki.oids.contentType), set([oid(pki.oids.data)])]),
      seq([oid(pki.oids.signingTime), set([asn1.create(A, T.UTCTIME, false, asn1.dateToUtcTime(signingTime))])]),
      seq([oid(pki.oids.messageDigest), set([octets(sha256(toBytes(pdfBuffer)))])]),
      // ESS signing-certificate-v2 (Pflicht für PAdES-B)
      seq([oid("1.2.840.113549.1.9.16.2.47"), set([seq([seq([seq([octets(sha256(der(certAsn1)))])])])])]),
    ]);
    const h = md.sha256.create(); h.update(der(signed));
    const signature = this.key.sign(h);
    const signerInfo = [
      int(String.fromCharCode(1)),
      seq([pki.distinguishedNameToAsn1(this.cert.issuer), int(util.hexToBytes(this.cert.serialNumber))]),
      algSha256(),
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, signed.value),
      seq([oid(pki.oids.rsaEncryption), nul()]),
      octets(signature),
    ];
    if (this.tsaUrl) {
      const token = await timestampToken(signature, this.tsaUrl);
      this.tsa = true;
      signerInfo.push(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 1, true, [
        seq([oid("1.2.840.113549.1.9.16.2.14"), set([token])]),
      ]));
    }
    const signedData = seq([
      int(String.fromCharCode(1)),
      set([algSha256()]),
      seq([oid(pki.oids.data)]),
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [certAsn1]),
      set([seq(signerInfo)]),
    ]);
    const contentInfo = seq([oid(pki.oids.signedData), asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [signedData])]);
    return Uint8Array.from(der(contentInfo), (c) => c.charCodeAt(0));
  }
}

/**
 * Versiegelt ein PDF: Signaturfeld per pdf-lib einfügen, neu speichern, CMS-Signatur einsetzen.
 * (placeholder-plain beschädigt PDFs mit vorhandenem AcroForm, daher pdf-lib.)
 */
export async function sealPdf(pdfBytes, { certPem, keyPem, tsaUrl = null, reason, location, name, contactInfo } = {}) {
  const { Buffer } = await import("node:buffer");
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  pdflibAddPlaceholder({
    pdfDoc: doc,
    pdfPage: doc.getPage(doc.getPageCount() - 1),
    reason: reason ?? "Elektronisch unterzeichnet mit Prusseit Sign",
    contactInfo: contactInfo ?? "willkommen@autowelt-prusseit.de",
    name: name ?? "Autowelt Prusseit GmbH",
    location: location ?? "Horb am Neckar",
    signatureLength: 16384,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    appName: "Prusseit-Sign",
  });
  const withPh = Buffer.from(await doc.save({ useObjectStreams: false }));
  const signer = new SealSigner(certPem, keyPem, tsaUrl);
  const out = await signpdf.sign(withPh, signer);
  return { pdf: new Uint8Array(out), timestamped: !!signer.tsa };
}
