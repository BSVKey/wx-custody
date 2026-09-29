// Independent verification. Every check returns { ok, reason }.
import { contentId } from "./canonical.mjs";
import { leafHash, buildTree, verifyProof } from "./merkle.mjs";
import { verifySig } from "./keys.mjs";
import { FILE_TYPE, WINDOW_TYPE, classify, sha256hex } from "./custody.mjs";

const fail = (reason) => ({ ok: false, reason });

export function verifySigned(rec, { pinnedPub } = {}) {
  if (!rec || typeof rec !== "object") return fail("not_a_record");
  if (contentId(rec) !== rec.claimId) return fail("content_mismatch");
  if (pinnedPub !== undefined && rec.signerPub !== pinnedPub) return fail("signer_not_pinned");
  if (!verifySig(rec.signerPub, rec.claimId, rec.sig)) return fail("signature_invalid");
  return { ok: true };
}

export function verifyFileReceipt(r, opts) {
  if (r?.type !== FILE_TYPE) return fail("wrong_type");
  const s = verifySigned(r, opts);
  if (!s.ok) return s;
  // The verdict must follow from the observations it summarizes.
  if (JSON.stringify(classify(r.observations)) !== JSON.stringify(r.verdict)) return fail("verdict_mismatch");
  return { ok: true };
}

// Do these bytes match what the receipt says a mirror served?
export function verifyBytes(bytes, r, mirror) {
  const o = r.observations.find((x) => x.mirror === mirror);
  if (!o || !o.present) return fail("mirror_not_in_receipt");
  return sha256hex(bytes) === o.sha256 ? { ok: true } : fail("bytes_differ");
}

export function verifyWindow(m, receipts, opts) {
  if (m?.type !== WINDOW_TYPE) return fail("wrong_type");
  const s = verifySigned(m, opts);
  if (!s.ok) return s;
  const byId = new Map(receipts.map((r) => [r.claimId, r]));
  const leaves = [];
  for (const e of m.receipts) {
    const r = byId.get(e.receiptId);
    if (!r) return fail(`missing_receipt:${e.key}`);
    const rv = verifyFileReceipt(r, opts);
    if (!rv.ok) return fail(`receipt_${e.index}_${rv.reason}`);
    if (r.verdict.status !== e.status) return fail(`status_mismatch:${e.key}`);
    leaves.push(leafHash(Buffer.from(e.receiptId.replace(/^0x/, ""), "hex")));
  }
  const root = leaves.length ? buildTree(leaves).root : null;
  return root === m.root ? { ok: true } : fail("root_mismatch");
}

export function verifyInclusion(receiptId, p, m) {
  const leaf = leafHash(Buffer.from(receiptId.replace(/^0x/, ""), "hex"));
  if (!verifyProof(leaf, p.branch, p.index, m.root)) return fail("proof_invalid");
  return m.receipts[p.index]?.receiptId === receiptId ? { ok: true } : fail("index_mismatch");
}
