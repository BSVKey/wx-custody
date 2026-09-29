// Custody records for NOAA open data served by independent cloud mirrors. Pure, no network.
//
//   file receipt     one data file: what each mirror served (size, SHA-256 we computed,
//                    the mirror's own MD5 claim and whether it held up), when each mirror
//                    published it, and whether the mirrors agree byte for byte
//   window manifest  one product over a time window: every file receipt, cadence gaps
//                    (scan slots nobody published), per-mirror absences, disagreements,
//                    publication-lag statistics, and a Merkle root over the receipts
//
// The root is the value to anchor. A receipt proves what the mirrors served when we
// looked; agreement across three independently operated clouds is what makes it credible.
import { createHash } from "node:crypto";
import { contentId } from "./canonical.mjs";
import { leafHash, buildTree, proof } from "./merkle.mjs";
import { signClaim } from "./keys.mjs";

export const FILE_TYPE = "wx.file-receipt/1";
export const WINDOW_TYPE = "wx.window-manifest/1";

export const DATA_SOURCE = Object.freeze({
  program: "NOAA Open Data Dissemination (NODD)",
  license: "US Government work, public domain (17 U.S.C. 105)",
  notice: "Not affiliated with or endorsed by NOAA. Records attest what public mirrors served, not ground truth.",
});

export function signRecord(obj, kp) {
  const claimId = contentId(obj);
  return { ...obj, claimId, sig: signClaim(kp.priv, claimId), signerPub: kp.pub };
}

export const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
export const md5hex = (b) => createHash("md5").update(b).digest("hex");
const ms = (iso) => new Date(iso).getTime();

// Classify one file from what each mirror served. obs: [{ mirror, present, sha256, ... }]
export function classify(obs) {
  const present = obs.filter((o) => o.present);
  const hashes = [...new Set(present.map((o) => o.sha256))];
  const missingOn = obs.filter((o) => !o.present).map((o) => o.mirror);
  let status;
  if (present.length === 0) status = "missing_everywhere";
  else if (hashes.length > 1) status = "DISCREPANCY";
  else if (missingOn.length === 0) status = "corroborated_all";
  else if (present.length >= 2) status = "corroborated_partial";
  else status = "single_source";
  const claimFailures = present.filter((o) => o.md5Claimed && o.md5Claimed !== o.md5Actual).map((o) => o.mirror);
  return { status, mirrorsPresent: present.length, distinctContents: hashes.length, missingOn, claimFailures };
}

export function buildFileReceipt({ key, meta, obs, kp, witnessedAt }) {
  const observations = obs.map((o) => ({
    mirror: o.mirror,
    operator: o.operator,
    url: o.url,
    present: o.present,
    size: o.present ? o.size : null,
    sha256: o.present ? o.sha256 : null,
    md5Claimed: o.present ? o.md5Claimed ?? null : null,
    md5Actual: o.present ? o.md5Actual : null,
    lastModified: o.present ? o.lastModified : null,
    publishLagSec: o.present && meta?.scanEnd ? Math.round((ms(o.lastModified) - ms(meta.scanEnd)) / 1000) : null,
  }));
  return signRecord(
    {
      type: FILE_TYPE,
      source: DATA_SOURCE,
      key,
      product: meta?.product ?? null,
      satellite: meta?.satellite ?? null,
      scanStart: meta?.scanStart ?? null,
      scanEnd: meta?.scanEnd ?? null,
      created: meta?.created ?? null,
      observations,
      verdict: classify(observations),
      witnessedAt,
    },
    kp,
  );
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Scan slots nobody published: gaps in the scan-start sequence longer than 1.5x the
// product's own median cadence.
export function cadenceGaps(scanStarts) {
  const t = [...new Set(scanStarts)].map(ms).sort((a, b) => a - b);
  if (t.length < 3) return { cadenceSec: null, gaps: [] };
  const cadence = median(t.slice(1).map((x, i) => x - t[i]));
  const gaps = [];
  for (let i = 1; i < t.length; i++) {
    const d = t[i] - t[i - 1];
    if (d > cadence * 1.5) {
      gaps.push({ after: new Date(t[i - 1]).toISOString(), before: new Date(t[i]).toISOString(), missingSlots: Math.round(d / cadence) - 1 });
    }
  }
  return { cadenceSec: Math.round(cadence / 1000), gaps };
}

export function buildWindowManifest({ product, satellite, window, receipts, mirrors, kp, witnessedAt }) {
  const sorted = [...receipts].sort((a, b) => (a.scanStart || a.key).localeCompare(b.scanStart || b.key));
  const leaves = sorted.map((r) => leafHash(Buffer.from(r.claimId.replace(/^0x/, ""), "hex")));
  const tree = leaves.length ? buildTree(leaves) : null;
  const count = (s) => sorted.filter((r) => r.verdict.status === s).length;
  const perMirror = mirrors.map((m) => {
    const lags = sorted.flatMap((r) => r.observations.filter((o) => o.mirror === m && o.present).map((o) => o.publishLagSec));
    return {
      mirror: m,
      filesServed: lags.length,
      filesMissing: sorted.filter((r) => r.verdict.missingOn.includes(m)).length,
      checksumClaimFailures: sorted.filter((r) => r.verdict.claimFailures.includes(m)).length,
      publishLagSecMedian: median(lags),
      publishLagSecMax: lags.length ? Math.max(...lags) : null,
    };
  });
  const cad = cadenceGaps(sorted.map((r) => r.scanStart).filter(Boolean));
  const manifest = signRecord(
    {
      type: WINDOW_TYPE,
      source: DATA_SOURCE,
      product,
      satellite,
      window,
      files: sorted.length,
      summary: {
        corroboratedAll: count("corroborated_all"),
        corroboratedPartial: count("corroborated_partial"),
        singleSource: count("single_source"),
        discrepancies: count("DISCREPANCY"),
      },
      cadenceSec: cad.cadenceSec,
      gaps: cad.gaps,
      perMirror,
      discrepancies: sorted.filter((r) => r.verdict.status === "DISCREPANCY").map((r) => ({ key: r.key, receiptId: r.claimId })),
      receipts: sorted.map((r, i) => ({ index: i, key: r.key, scanStart: r.scanStart, receiptId: r.claimId, status: r.verdict.status })),
      root: tree ? tree.root : null,
      witnessedAt,
    },
    kp,
  );
  const proofs = tree ? sorted.map((r, i) => ({ receiptId: r.claimId, index: i, branch: proof(tree, i) })) : [];
  return { manifest, proofs };
}
