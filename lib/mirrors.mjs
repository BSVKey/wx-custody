// Read-only access to the same NOAA GOES bucket on three independent clouds (NOAA Open
// Data Dissemination). No accounts or keys: all three are public. Each mirror lists an
// hour prefix and serves object bytes; we hash the bytes ourselves and treat the
// mirrors' own checksums only as claims to compare against.
const UA = "wx-custody/0.1 (read-only; custody receipts over NOAA open data)";

async function get(url, as = "text", tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === "bytes" ? Buffer.from(await res.arrayBuffer()) : as === "json" ? res.json() : res.text();
    } catch (e) {
      if (i >= tries) throw new Error(`GET ${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

const xmlAll = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
const xmlOne = (xml, tag) => (xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1];
const b64ToHex = (b) => (b ? Buffer.from(b, "base64").toString("hex") : null);

export function mirrorsFor(satellite = 19) {
  const bucket = `noaa-goes${satellite}`;
  return [
    {
      id: "aws",
      operator: "Amazon Web Services",
      objectUrl: (key) => `https://${bucket}.s3.amazonaws.com/${key}`,
      async list(prefix) {
        const out = [];
        let token = null;
        do {
          const q = new URLSearchParams({ "list-type": "2", prefix });
          if (token) q.set("continuation-token", token);
          const xml = await get(`https://${bucket}.s3.amazonaws.com/?${q}`);
          for (const c of xmlAll(xml, "Contents")) {
            out.push({ key: xmlOne(c, "Key"), size: Number(xmlOne(c, "Size")), lastModified: xmlOne(c, "LastModified"), md5: null });
          }
          token = xmlOne(xml, "IsTruncated") === "true" ? xmlOne(xml, "NextContinuationToken") : null;
        } while (token);
        return out;
      },
    },
    {
      id: "gcp",
      operator: "Google Cloud",
      objectUrl: (key) => `https://storage.googleapis.com/gcp-public-data-goes-${satellite}/${key}`,
      async list(prefix) {
        const out = [];
        let token = null;
        do {
          const q = new URLSearchParams({ prefix, fields: "nextPageToken,items(name,size,md5Hash,updated)" });
          if (token) q.set("pageToken", token);
          const j = await get(`https://storage.googleapis.com/storage/v1/b/gcp-public-data-goes-${satellite}/o?${q}`, "json");
          for (const it of j?.items || []) {
            out.push({ key: it.name, size: Number(it.size), lastModified: it.updated, md5: b64ToHex(it.md5Hash) });
          }
          token = j?.nextPageToken || null;
        } while (token);
        return out;
      },
    },
    {
      id: "azure",
      operator: "Microsoft Azure",
      objectUrl: (key) => `https://goeseuwest.blob.core.windows.net/${bucket}/${key}`,
      async list(prefix) {
        const out = [];
        let marker = "";
        do {
          const q = new URLSearchParams({ restype: "container", comp: "list", prefix });
          if (marker) q.set("marker", marker);
          const xml = await get(`https://goeseuwest.blob.core.windows.net/${bucket}?${q}`);
          for (const b of xmlAll(xml, "Blob")) {
            out.push({
              key: xmlOne(b, "Name"),
              size: Number(xmlOne(b, "Content-Length")),
              lastModified: new Date(xmlOne(b, "Last-Modified")).toISOString(),
              md5: b64ToHex(xmlOne(b, "Content-MD5")),
            });
          }
          marker = xmlOne(xml, "NextMarker") || "";
        } while (marker);
        return out;
      },
    },
  ];
}

export async function fetchObject(mirror, key) {
  return get(mirror.objectUrl(key), "bytes");
}
