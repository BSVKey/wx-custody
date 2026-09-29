import test from "node:test";
import assert from "node:assert/strict";
import { genKeypair } from "../lib/keys.mjs";
import { parseGoesName, parseStamp, hourPrefixes } from "../lib/goes.mjs";
import { classify, buildFileReceipt, buildWindowManifest, cadenceGaps, sha256hex, md5hex } from "../lib/custody.mjs";
import { verifyFileReceipt, verifyWindow, verifyInclusion, verifyBytes } from "../lib/verify.mjs";

const kp = genKeypair();
const at = "2026-09-29T05:00:00.000Z";
const KEY = (mm) => `ABI-L2-RRQPEF/2026/272/03/OR_ABI-L2-RRQPEF-M6_G19_s2026272030${mm}203_e2026272030${mm}511_c2026272030${mm}567.nc`;

function ob(mirror, bytes, { md5Claimed, lag = 60 } = {}) {
  if (!bytes) return { mirror, operator: mirror, url: `u/${mirror}`, present: false };
  return { mirror, operator: mirror, url: `u/${mirror}`, present: true, size: bytes.length, sha256: sha256hex(bytes),
    md5Actual: md5hex(bytes), md5Claimed: md5Claimed === undefined ? md5hex(bytes) : md5Claimed, lastModified: new Date(Date.parse("2026-09-29T03:00:51.100Z") + lag * 1000).toISOString() };
}
const B = Buffer.from("rainfall-rate-file");

test("GOES file names parse to real timestamps", () => {
  assert.equal(parseStamp("20262720300203"), "2026-09-29T03:00:20.300Z");
  const m = parseGoesName(KEY("0"));
  assert.equal(m.product, "ABI-L2-RRQPEF");
  assert.equal(m.satellite, "GOES-19");
  assert.equal(m.mode, 6);
  assert.equal(parseGoesName("not-a-goes-file.txt"), null);
  assert.deepEqual(hourPrefixes("P", new Date("2026-09-29T02:30:00Z"), new Date("2026-09-29T04:10:00Z")), ["P/2026/272/02/", "P/2026/272/03/", "P/2026/272/04/"]);
});

test("verdicts: all agree, partial, single source, discrepancy, missing, and checksum-claim failure", () => {
  assert.equal(classify([ob("aws", B), ob("gcp", B), ob("azure", B)]).status, "corroborated_all");
  assert.deepEqual(classify([ob("aws", B), ob("gcp", B), ob("azure", null)]).missingOn, ["azure"]);
  assert.equal(classify([ob("aws", B), ob("gcp", B), ob("azure", null)]).status, "corroborated_partial");
  assert.equal(classify([ob("aws", B), ob("gcp", null), ob("azure", null)]).status, "single_source");
  assert.equal(classify([ob("aws", B), ob("gcp", Buffer.from("altered")), ob("azure", B)]).status, "DISCREPANCY");
  assert.equal(classify([ob("aws", null), ob("gcp", null), ob("azure", null)]).status, "missing_everywhere");
  assert.deepEqual(classify([ob("aws", B), ob("gcp", B, { md5Claimed: "00ff" }), ob("azure", B)]).claimFailures, ["gcp"]);
});

test("file receipts verify, record publish lag, and catch a doctored verdict or bytes", () => {
  const r = buildFileReceipt({ key: KEY("0"), meta: parseGoesName(KEY("0")), obs: [ob("aws", B, { lag: 42 }), ob("gcp", B), ob("azure", B)], kp, witnessedAt: at });
  assert.deepEqual(verifyFileReceipt(r, { pinnedPub: kp.pub }), { ok: true });
  assert.equal(r.observations[0].publishLagSec, 42);
  assert.equal(verifyBytes(B, r, "gcp").ok, true);
  assert.equal(verifyBytes(Buffer.from("x"), r, "gcp").reason, "bytes_differ");
  const t = structuredClone(r);
  t.verdict.status = "corroborated_all";
  t.observations[1].sha256 = "00";
  assert.equal(verifyFileReceipt(t).reason, "content_mismatch");
});

test("cadence gaps: a missing 10-minute slot is found and counted", () => {
  const starts = ["03:00", "03:10", "03:20", "03:50", "04:00"].map((t) => `2026-09-29T${t}:20.300Z`);
  const g = cadenceGaps(starts);
  assert.equal(g.cadenceSec, 600);
  assert.deepEqual(g.gaps, [{ after: "2026-09-29T03:20:20.300Z", before: "2026-09-29T03:50:20.300Z", missingSlots: 2 }]);
});

test("window manifest: root over receipts, inclusion proofs, per-mirror stats, tamper detection", () => {
  const rs = ["0", "1", "2"].map((mm, i) =>
    buildFileReceipt({ key: KEY(mm), meta: parseGoesName(KEY(mm)),
      obs: [ob("aws", B), ob("gcp", i === 2 ? Buffer.from("different") : B), ob("azure", i === 1 ? null : B)], kp, witnessedAt: at }));
  const { manifest, proofs } = buildWindowManifest({ product: "ABI-L2-RRQPEF", satellite: "GOES-19", window: { since: at, until: at },
    receipts: rs, mirrors: ["aws", "gcp", "azure"], kp, witnessedAt: at });
  assert.deepEqual(verifyWindow(manifest, rs, { pinnedPub: kp.pub }), { ok: true });
  for (const p of proofs) assert.deepEqual(verifyInclusion(p.receiptId, p, manifest), { ok: true });
  assert.deepEqual(manifest.summary, { corroboratedAll: 1, corroboratedPartial: 1, singleSource: 0, discrepancies: 1 });
  assert.equal(manifest.perMirror.find((m) => m.mirror === "azure").filesMissing, 1);
  assert.equal(manifest.discrepancies.length, 1);
  assert.match(verifyWindow(manifest, rs.slice(0, 2), {}).reason, /^missing_receipt/);
  assert.equal(verifyInclusion(proofs[0].receiptId, { ...proofs[0], index: 1 }, manifest).ok, false);
});

test("every record carries the public-domain source and non-affiliation notice", () => {
  const r = buildFileReceipt({ key: KEY("0"), meta: parseGoesName(KEY("0")), obs: [ob("aws", B)], kp, witnessedAt: at });
  assert.match(r.source.license, /public domain/);
  assert.match(r.source.notice, /Not affiliated with or endorsed by NOAA/);
});
