#!/usr/bin/env node
// Verify a run from disk.   node bin/verify.mjs --run out/<runId> --pub <key> [--refetch]
// --refetch downloads every file again from every mirror and compares hashes.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { mirrorsFor, fetchObject } from "../lib/mirrors.mjs";
import { sha256hex } from "../lib/custody.mjs";
import { verifyFileReceipt, verifyWindow, verifyInclusion } from "../lib/verify.mjs";

const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--refetch") a.refetch = true;
  else if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
}
if (!a.run) {
  console.log("usage: node bin/verify.mjs --run out/<runId> [--pub KEY] [--refetch]");
  process.exit(0);
}
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
let pinnedPub = a.pub;
if (!pinnedPub) {
  pinnedPub = (await readJson(join(a.run, "custody-pubkey.json"))).signerPub;
  console.log("note: no --pub given; pinning the key in the run folder (internal consistency only)");
}
const opts = { pinnedPub };
const receipts = await Promise.all((await readdir(join(a.run, "receipts"))).map((f) => readJson(join(a.run, "receipts", f))));
const win = await readJson(join(a.run, "window.json"));
const proofs = await readJson(join(a.run, "proofs.json"));

let fails = 0;
const check = (label, r) => { if (!r.ok) { fails++; console.log(`  FAIL ${label}: ${r.reason}`); } };
for (const r of receipts) check(`receipt ${r.key}`, verifyFileReceipt(r, opts));
check("window manifest", verifyWindow(win, receipts, opts));
for (const p of proofs) check(`inclusion ${p.index}`, verifyInclusion(p.receiptId, p, win));
console.log(`records: ${receipts.length} file receipts, window root ${win.root}`);

if (a.refetch) {
  const mirrors = new Map(mirrorsFor(Number(String(win.satellite).replace("GOES-", ""))).map((m) => [m.id, m]));
  let n = 0, changed = 0, gone = 0;
  for (const r of receipts) {
    for (const o of r.observations.filter((x) => x.present)) {
      n++;
      const bytes = await fetchObject(mirrors.get(o.mirror), r.key).catch(() => null);
      if (!bytes) { gone++; continue; }
      if (sha256hex(bytes) !== o.sha256) { changed++; console.log(`  CHANGED ${o.mirror} ${r.key}`); }
    }
  }
  console.log(`refetch: ${n} mirror copies re-downloaded, ${changed} changed, ${gone} unreachable`);
  fails += changed;
}
console.log(fails === 0 ? "VERIFY: PASS" : `VERIFY: FAIL (${fails})`);
if (fails) process.exitCode = 1;
