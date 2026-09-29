#!/usr/bin/env node
// Witness a NOAA GOES product across the AWS, Google Cloud and Azure mirrors.
//
//   node bin/run.mjs                                  ABI-L2-RRQPEF (rainfall rate), GOES-19, last 6 h
//   node bin/run.mjs --product ABI-L2-DSIC --hours 3  derived stability indices
//
// Output: out/<runId>/ { receipts/, window.json, proofs.json, REPORT.md, DATA-NOTICE.md }
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { genKeypair, exportKeypair, importKeypair } from "../lib/keys.mjs";
import { mirrorsFor, fetchObject } from "../lib/mirrors.mjs";
import { parseGoesName, hourPrefixes } from "../lib/goes.mjs";
import { buildFileReceipt, buildWindowManifest, sha256hex, md5hex, DATA_SOURCE } from "../lib/custody.mjs";
import { verifyFileReceipt, verifyWindow, verifyInclusion } from "../lib/verify.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function args(argv) {
  const a = { product: "ABI-L2-RRQPEF", satellite: 19, hours: 6, concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--product") a.product = v, i++;
    else if (k === "--satellite") a.satellite = Number(v), i++;
    else if (k === "--hours") a.hours = Number(v), i++;
    else if (k === "--concurrency") a.concurrency = Number(v), i++;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

async function loadKey() {
  const path = join(ROOT, ".keys", "custody.json");
  try {
    return importKeypair(JSON.parse(await readFile(path, "utf8")));
  } catch {
    const kp = genKeypair();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(exportKeypair(kp), null, 2));
    console.log(`created custody key ${path} (keep private; publish only the public key)`);
    return kp;
  }
}

const write = (p, o) => writeFile(p, JSON.stringify(o, null, 2) + "\n");

async function witnessFile(key, mirrors, listings) {
  return Promise.all(
    mirrors.map(async (m) => {
      const listed = listings.get(m.id).get(key);
      const base = { mirror: m.id, operator: m.operator, url: m.objectUrl(key) };
      // Not listed may just mean the listing is stale; ask for the object directly.
      const bytes = await fetchObject(m, key).catch(() => null);
      if (!bytes) return { ...base, present: false };
      return {
        ...base,
        present: true,
        size: bytes.length,
        sha256: sha256hex(bytes),
        md5Actual: md5hex(bytes),
        md5Claimed: listed?.md5 ?? null,
        lastModified: listed?.lastModified ?? null,
      };
    }),
  );
}

async function main() {
  const a = args(process.argv.slice(2));
  const kp = await loadKey();
  const until = new Date();
  const since = new Date(until.getTime() - a.hours * 3600e3);
  const mirrors = mirrorsFor(a.satellite);
  console.log(`${a.product} GOES-${a.satellite}  ${since.toISOString()} .. ${until.toISOString()}  mirrors: ${mirrors.map((m) => m.id).join(", ")}`);

  const prefixes = hourPrefixes(a.product, since, until);
  const listings = new Map();
  for (const m of mirrors) {
    const map = new Map();
    for (const p of prefixes) for (const o of await m.list(p)) map.set(o.key, o);
    listings.set(m.id, map);
    console.log(`  ${m.id.padEnd(6)} lists ${map.size} files`);
  }
  const keys = [...new Set([...listings.values()].flatMap((mp) => [...mp.keys()]))]
    .filter((k) => {
      const meta = parseGoesName(k);
      return meta && new Date(meta.scanStart) >= since && new Date(meta.scanStart) <= until;
    })
    .sort();
  console.log(`  ${keys.length} files in window; downloading from every mirror and hashing`);

  const runId = until.toISOString().replace(/[:.]/g, "-");
  const outDir = join(ROOT, "out", runId);
  await mkdir(join(outDir, "receipts"), { recursive: true });

  const receipts = new Array(keys.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < keys.length) {
      const i = next++;
      const key = keys[i];
      const obs = await witnessFile(key, mirrors, listings);
      const r = buildFileReceipt({ key, meta: parseGoesName(key), obs, kp, witnessedAt: new Date().toISOString() });
      receipts[i] = r;
      await write(join(outDir, "receipts", `${r.scanStart.replace(/[:.]/g, "-")}.json`), r);
      if (++done % 6 === 0 || done === keys.length) process.stdout.write(`  ${done}/${keys.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(a.concurrency, keys.length) }, worker));

  const { manifest, proofs } = buildWindowManifest({
    product: a.product,
    satellite: `GOES-${a.satellite}`,
    window: { since: since.toISOString(), until: until.toISOString() },
    receipts,
    mirrors: mirrors.map((m) => m.id),
    kp,
    witnessedAt: new Date().toISOString(),
  });
  await write(join(outDir, "window.json"), manifest);
  await write(join(outDir, "proofs.json"), proofs);
  await write(join(outDir, "custody-pubkey.json"), { signerPub: kp.pub });

  const pin = { pinnedPub: kp.pub };
  let bad = receipts.filter((r) => !verifyFileReceipt(r, pin).ok).length;
  if (!verifyWindow(manifest, receipts, pin).ok) bad++;
  bad += proofs.filter((p) => !verifyInclusion(p.receiptId, p, manifest).ok).length;

  await writeFile(join(outDir, "REPORT.md"), report(manifest, runId, bad));
  await writeFile(join(outDir, "DATA-NOTICE.md"), `# Data notice\n\nSource: ${DATA_SOURCE.program}, served by public mirrors on AWS, Google Cloud and Microsoft Azure.\nLicense: ${DATA_SOURCE.license}.\n\n${DATA_SOURCE.notice}\n`);

  const s = manifest.summary;
  console.log(`\nfiles ${manifest.files}: all 3 mirrors agree ${s.corroboratedAll}, partial ${s.corroboratedPartial}, single source ${s.singleSource}, DISCREPANCIES ${s.discrepancies}`);
  console.log(`cadence ${manifest.cadenceSec}s, gaps ${manifest.gaps.length}`);
  for (const pm of manifest.perMirror) {
    console.log(`  ${pm.mirror.padEnd(6)} served ${pm.filesServed}, missing ${pm.filesMissing}, checksum-claim failures ${pm.checksumClaimFailures}, publish lag median ${pm.publishLagSecMedian}s max ${pm.publishLagSecMax}s`);
  }
  console.log(`window root ${manifest.root}`);
  console.log(`self-check: ${bad === 0 ? "PASS" : `FAIL (${bad})`}`);
  console.log(`written: ${outDir}`);
  if (bad) process.exitCode = 1;
}

function report(m, runId, bad) {
  const s = m.summary;
  const rows = m.perMirror
    .map((p) => `| ${p.mirror} | ${p.filesServed} | ${p.filesMissing} | ${p.checksumClaimFailures} | ${p.publishLagSecMedian ?? "n/a"} | ${p.publishLagSecMax ?? "n/a"} |`)
    .join("\n");
  const gaps = m.gaps.length ? m.gaps.map((g) => `- ${g.missingSlots} slot(s) missing between ${g.after} and ${g.before}`).join("\n") : "- none";
  return `# Weather data custody run ${runId}

${m.product}, ${m.satellite}. Window ${m.window.since} to ${m.window.until}.

| Files | All 3 mirrors agree | Partial | Single source | Discrepancies |
|---|---|---|---|---|
| ${m.files} | ${s.corroboratedAll} | ${s.corroboratedPartial} | ${s.singleSource} | ${s.discrepancies} |

| Mirror | Served | Missing | Checksum-claim failures | Publish lag median (s) | Max (s) |
|---|---|---|---|---|---|
${rows}

Product cadence: ${m.cadenceSec ?? "n/a"} s. Missing scan slots:
${gaps}

Window root: \`${m.root}\`
Self-check: ${bad === 0 ? "PASS" : `FAIL (${bad})`}

Each file was downloaded from every mirror and hashed (SHA-256) by the witness; the
mirrors' own MD5 values are recorded only as claims and checked. Publish lag is the
mirror's last-modified time minus the scan end time in the file name.

${DATA_SOURCE.notice} Data: ${DATA_SOURCE.license}.
`;
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
