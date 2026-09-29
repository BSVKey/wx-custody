// GOES file names carry their own timing:
//   OR_ABI-L2-RRQPEF-M6_G19_s20262720300203_e20262720309511_c20262720309567.nc
//   s = scan start, e = scan end, c = file created (YYYY DDD HH MM SS tenths)
export function parseStamp(stamp) {
  const m = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)$/.exec(stamp || "");
  if (!m) return null;
  const [, y, doy, hh, mm, ss, t] = m;
  const ms = Date.UTC(+y, 0, 1) + (+doy - 1) * 86400e3 + (+hh * 3600 + +mm * 60 + +ss) * 1000 + +t * 100;
  return new Date(ms).toISOString();
}

export function parseGoesName(key) {
  const name = String(key).split("/").pop();
  // Imager products carry a scan mode ("-M6"); space-weather products (SEIS, MAG, SUVI,
  // EXIS) do not, so the mode is optional.
  const m = /^OR_(.+?)(?:-M(\d+))?_G(\d+)_s(\d{14})_e(\d{14})_c(\d{14})\.nc$/.exec(name);
  if (!m) return null;
  return {
    name,
    product: m[1],
    mode: m[2] === undefined ? null : Number(m[2]),
    satellite: `GOES-${m[3]}`,
    scanStart: parseStamp(m[4]),
    scanEnd: parseStamp(m[5]),
    created: parseStamp(m[6]),
  };
}

// Hour prefixes (PRODUCT/YYYY/DDD/HH/) covering [since, until].
export function hourPrefixes(product, since, until) {
  const out = [];
  const t = new Date(since);
  t.setUTCMinutes(0, 0, 0);
  for (; t <= until; t.setUTCHours(t.getUTCHours() + 1)) {
    const y = t.getUTCFullYear();
    const doy = Math.floor((t - Date.UTC(y, 0, 1)) / 86400e3) + 1;
    out.push(`${product}/${y}/${String(doy).padStart(3, "0")}/${String(t.getUTCHours()).padStart(2, "0")}/`);
  }
  return out;
}
