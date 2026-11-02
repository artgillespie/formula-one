// Builds walkthroughs/austin/data/{track,city,sessions}.json and terrain.bin from raw downloads in ./raw
// (see fetch-raw.sh). Run: node tools/austin/build-data.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { summarizeSession } from '../../walkthroughs/austin/stats.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(here, 'raw');
const OUT = path.join(here, '../../walkthroughs/austin/data');
const raw = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- OSM
const nodes = new Map();
const ways = new Map();
const rels = new Map();
for (const f of fs.readdirSync(path.join(RAW, 'osm'))) {
  for (const e of raw(`osm/${f}`).elements) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way') ways.set(e.id, e);
    else if (e.type === 'relation') rels.set(e.id, e);
  }
}
const CIRCUIT_REL = 6537729;
const PIT_WAY = 514836373;
const circuitRel = rels.get(CIRCUIT_REL);
const circuitWays = circuitRel.members.filter((m) => m.type === 'way' && m.role !== 'pit_lane').map((m) => ways.get(m.ref)).filter(Boolean);
const circuitNodes = circuitWays.flatMap((w) => w.nodes.map((n) => nodes.get(n)).filter(Boolean));
const lat0 = circuitNodes.reduce((a, n) => a + n.lat, 0) / circuitNodes.length;
const lon0 = circuitNodes.reduce((a, n) => a + n.lon, 0) / circuitNodes.length;
const KX = Math.cos((lat0 * Math.PI) / 180) * 111320;
const KY = 110574;
const ll = (n) => [(n.lon - lon0) * KX, (n.lat - lat0) * KY];
const toLL = (x, y) => [lat0 + y / KY, lon0 + x / KX];
const wayPts = (w) => w.nodes.map((id) => nodes.get(id)).filter(Boolean).map(ll);

// ---------------------------------------------------------------- DEM (AWS Terrain Tiles, terrarium PNG, z15)
function decodePNG(buf) {
  // Minimal decoder: 8-bit RGB/RGBA, non-interlaced (which is what terrarium tiles are).
  let p = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12]) throw new Error('unsupported PNG'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : (() => { throw new Error(`colour type ${ct}`); })();
  const inf = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = inf[y * (stride + 1)];
    const src = inf.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, bpp, px: out };
}
const Z = 15;
const tiles = new Map();
for (const f of fs.readdirSync(path.join(RAW, 'dem'))) {
  const [, x, y] = f.replace('.png', '').split('_').map(Number);
  tiles.set(`${x},${y}`, decodePNG(fs.readFileSync(path.join(RAW, 'dem', f))));
}
function demPixel(gx, gy) {
  const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
  const t = tiles.get(`${tx},${ty}`);
  if (!t) return NaN;
  const i = ((gy - ty * 256) * 256 + (gx - tx * 256)) * t.bpp;
  return t.px[i] * 256 + t.px[i + 1] + t.px[i + 2] / 256 - 32768;
}
function demAt(lat, lon) {
  const n = 2 ** Z;
  const fx = ((lon + 180) / 360) * n * 256 - 0.5;
  const r = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * 256 - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
  const a = demPixel(x0, y0), b = demPixel(x0 + 1, y0), c = demPixel(x0, y0 + 1), d = demPixel(x0 + 1, y0 + 1);
  return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
}
const demXY = (x, y) => demAt(...toLL(x, y));

// ---------------------------------------------------------------- ICP: F1 coords -> local metres
function densify(lines, step) {
  const out = [];
  for (const pts of lines) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    out.push(pts.at(-1));
  }
  return out;
}
const osmTrack = densify(circuitWays.map(wayPts), 2);
const grid = new Map();
const G = 25;
for (const p of osmTrack) {
  const k = `${Math.floor(p[0] / G)},${Math.floor(p[1] / G)}`;
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(p);
}
function nearestOsm(x, y) {
  let best = null, bd = Infinity;
  const gx = Math.floor(x / G), gy = Math.floor(y / G);
  for (let r = 0; r < 6 && (best === null || r < 2); r++) {
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        for (const p of grid.get(`${gx + i},${gy + j}`) || []) {
          const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
          if (d < bd) (bd = d), (best = p);
        }
      }
  }
  if (!best) for (const p of osmTrack) { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) (bd = d), (best = p); }
  return [best, Math.sqrt(bd)];
}

const mv = raw('mv_2026.json');
const mvPts = mv.x.map((x, i) => [x, mv.y[i]]);
function apply(T, [x, y]) {
  const yy = T.m ? -y : y;
  const c = Math.cos(T.th), s = Math.sin(T.th);
  return [T.s * (c * x - s * yy) + T.tx, T.s * (s * x + c * yy) + T.ty];
}
function fit(src, dst, m) {
  const n = src.length;
  const S = src.map(([x, y]) => [x, m ? -y : y]);
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) (sx += S[i][0]), (sy += S[i][1]), (dx += dst[i][0]), (dy += dst[i][1]);
  (sx /= n), (sy /= n), (dx /= n), (dy /= n);
  let a = 0, b = 0, vs = 0;
  for (let i = 0; i < n; i++) {
    const px = S[i][0] - sx, py = S[i][1] - sy, qx = dst[i][0] - dx, qy = dst[i][1] - dy;
    a += px * qx + py * qy;
    b += px * qy - py * qx;
    vs += px * px + py * py;
  }
  const th = Math.atan2(b, a), s = Math.hypot(a, b) / vs;
  const c = Math.cos(th), sn = Math.sin(th);
  return { s, th, m, tx: dx - s * (c * sx - sn * sy), ty: dy - s * (sn * sx + c * sy) };
}
function icp(T0) {
  let T = T0, err = 0;
  for (let it = 0; it < 60; it++) {
    const moved = mvPts.map((p) => apply(T, p));
    const pairs = moved.map((p) => nearestOsm(p[0], p[1]));
    const ds = pairs.map((p) => p[1]).sort((a, b) => a - b);
    const thr = Math.max(8, ds[Math.floor(ds.length * 0.8)]);
    const src = [], dst = [];
    pairs.forEach(([q, d], i) => { if (d <= thr) src.push(mvPts[i]), dst.push(q); });
    T = fit(src, dst, T.m);
    err = ds[Math.floor(ds.length / 2)];
  }
  return { T, err };
}
const mvC = mvPts.reduce((a, p) => [a[0] + p[0] / mvPts.length, a[1] + p[1] / mvPts.length], [0, 0]);
const osC = osmTrack.reduce((a, p) => [a[0] + p[0] / osmTrack.length, a[1] + p[1] / osmTrack.length], [0, 0]);
let best = null;
for (const m of [false, true])
  for (let deg = 0; deg < 360; deg += 15) {
    const th = (deg * Math.PI) / 180, s = 0.1;
    const c = Math.cos(th), sn = Math.sin(th);
    const my = m ? -mvC[1] : mvC[1];
    const T0 = { s, th, m, tx: osC[0] - s * (c * mvC[0] - sn * my), ty: osC[1] - s * (sn * mvC[0] + c * my) };
    const r = icp(T0);
    if (!best || r.err < best.err) best = r;
  }
const T = best.T;
console.log('ICP', { scale: T.s, deg: (T.th * 180) / Math.PI, mirror: T.m, medianErr_m: best.err });

// ---------------------------------------------------------------- centreline
let centre = mvPts.map((p) => apply(T, p));
function resample(pts, step, closed) {
  const P = closed ? [...pts, pts[0]] : pts;
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const L = cum.at(-1);
  const out = [];
  let j = 0;
  for (let d = 0; d < L - step / 2; d += step) {
    while (cum[j + 1] < d) j++;
    const f = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
    out.push([P[j][0] + (P[j + 1][0] - P[j][0]) * f, P[j][1] + (P[j + 1][1] - P[j][1]) * f]);
  }
  return { out, L };
}

function lapTelemetry(sessionKey, driver, tag) {
  const laps = raw(`laps_${sessionKey}.json`).filter((l) => l.driver_number === driver && l.lap_duration);
  const lap = laps.reduce((a, b) => (b.lap_duration < a.lap_duration ? b : a));
  const t0 = Date.parse(lap.date_start);
  const car = raw(`car_${tag}.json`);
  const loc = raw(`loc_${tag}.json`);
  const locT = loc.map((l) => ({ t: (Date.parse(l.date) - t0) / 1000, p: apply(T, [l.x, l.y]), z: l.z }));
  const samples = car
    .map((c) => {
      const t = (Date.parse(c.date) - t0) / 1000;
      let k = locT.findIndex((l) => l.t >= t);
      if (k <= 0) k = Math.max(1, k === -1 ? locT.length - 1 : 1);
      const a = locT[k - 1], b = locT[k];
      const f = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t || 1)));
      return { t, x: a.p[0] + (b.p[0] - a.p[0]) * f, y: a.p[1] + (b.p[1] - a.p[1]) * f, speed: c.speed, gear: c.n_gear, throttle: c.throttle, brake: c.brake, drs: c.drs };
    })
    .filter((s) => s.t >= -0.5 && s.t <= lap.lap_duration + 0.5);
  return { lap, samples, locT };
}
const LAPS = [
  { key: 'q2026', session: 11392, driver: 12, tag: '2026q', who: { code: 'ANT', name: 'Kimi Antonelli', team: 'Mercedes', colour: '#00D7B6', session: '2026 Qualifying (pole)' } },
  { key: 'q2025', session: 9884, driver: 1, tag: '2025q', who: { code: 'VER', name: 'Max Verstappen', team: 'Red Bull Racing', colour: '#4781D7', session: '2025 Qualifying (pole)' } },
  { key: 'q2024', session: 9608, driver: 4, tag: '2024q', who: { code: 'NOR', name: 'Lando Norris', team: 'McLaren', colour: '#F47600', session: '2024 Qualifying (pole)' } },
];
for (const l of LAPS) l.tel = lapTelemetry(l.session, l.driver, l.tag);
const tel0 = LAPS[0].tel;

const startPos = (() => { const s = tel0.samples; const k = s.findIndex((x) => x.t >= 0); return [s[k].x, s[k].y]; })();
{
  const idx = (p) => centre.reduce((bi, q, i) => ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < (centre[bi][0] - p[0]) ** 2 + (centre[bi][1] - p[1]) ** 2 ? i : bi), 0);
  const s = tel0.samples;
  const i0 = idx([s[5].x, s[5].y]);
  const i1 = idx([s[12].x, s[12].y]);
  const fwd = (i1 - i0 + centre.length) % centre.length;
  if (fwd > centre.length / 2) centre.reverse();
  const k = idx(startPos);
  centre = [...centre.slice(k), ...centre.slice(0, k)];
}
const STEP = 3;
const { out: line, L: trackLen } = resample(centre, STEP, true);
console.log('track length (m):', trackLen.toFixed(1), 'points:', line.length);

function project(x, y, hint) {
  let bi = 0, bd = Infinity;
  const n = line.length;
  const range = hint == null ? [0, n] : [hint - 60, hint + 120];
  for (let i = range[0]; i < range[1]; i++) {
    const q = line[((i % n) + n) % n];
    const d = (q[0] - x) ** 2 + (q[1] - y) ** 2;
    if (d < bd) (bd = d), (bi = ((i % n) + n) % n);
  }
  return bi;
}

// ---------------------------------------------------------------- elevation: bare-earth DEM along the centreline
let elevAbs = line.map(([x, y]) => demXY(x, y));
if (elevAbs.some((v) => Number.isNaN(v))) throw new Error('DEM does not cover the track');
for (let pass = 0; pass < 3; pass++) elevAbs = elevAbs.map((_, i) => { let s = 0; for (let k = -4; k <= 4; k++) s += elevAbs[(i + k + elevAbs.length) % elevAbs.length]; return s / 9; });
// cross-check against the cars' own z channel (OpenF1 location z, scaled like x/y)
{
  const zs = new Float64Array(line.length), zc = new Float64Array(line.length);
  for (const l of tel0.locT) { const i = project(l.p[0], l.p[1]); zs[i] += l.z * T.s; zc[i]++; }
  const pairs = [];
  for (let i = 0; i < line.length; i++) if (zc[i]) pairs.push([elevAbs[i], zs[i] / zc[i]]);
  const ma = pairs.reduce((a, p) => a + p[0], 0) / pairs.length, mb = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
  let cov = 0, va = 0, vb = 0;
  for (const [a, b] of pairs) (cov += (a - ma) * (b - mb)), (va += (a - ma) ** 2), (vb += (b - mb) ** 2);
  console.log('DEM vs telemetry z: r =', (cov / Math.sqrt(va * vb)).toFixed(3), ' slope =', (cov / va).toFixed(3));
}

// telemetry traces vs distance
function trace(tel) {
  let hint = null;
  const out = [];
  for (const s of tel.samples) {
    const i = project(s.x, s.y, hint);
    hint = i;
    let d = i * STEP;
    if (s.t < 2 && d > trackLen / 2) d -= trackLen;
    if (s.t > tel.lap.lap_duration - 5 && d < trackLen / 2) d += trackLen;
    out.push({ t: s.t, d, speed: s.speed, gear: s.gear, throttle: s.throttle, brake: s.brake, drs: s.drs });
  }
  for (let i = 1; i < out.length; i++) if (out[i].d < out[i - 1].d) out[i].d = out[i - 1].d;
  const dAt = (t) => {
    const k = out.findIndex((o) => o.t >= t);
    if (k <= 0) return out[Math.max(0, k)].d;
    const a = out[k - 1], b = out[k];
    return a.d + ((b.d - a.d) * (t - a.t)) / (b.t - a.t);
  };
  const l = tel.lap;
  return {
    lapTime: l.lap_duration,
    sectorTimes: [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3],
    sectorEnds: [dAt(l.duration_sector_1), dAt(l.duration_sector_1 + l.duration_sector_2)].map(r1),
    samples: out,
  };
}
for (const l of LAPS) l.tr = trace(l.tel);
const tr0 = LAPS[0].tr;
// Sector lines: average the three laps' split positions (they agree within a few metres)
const sectorEnds = [0, 1].map((k) => r1(LAPS.reduce((a, l) => a + l.tr.sectorEnds[k], 0) / LAPS.length));
console.log('sector ends per lap:', LAPS.map((l) => l.tr.sectorEnds.join('/')).join('  '), '→', sectorEnds);

// ---------------------------------------------------------------- corners
function cornerStats(tr, d0, lo, hi, prevD, nextD) {
  const win = tr.samples.filter((s) => s.d > Math.max(lo, d0 - 90) && s.d < Math.min(hi, d0 + 90));
  if (!win.length) return null;
  const min = win.reduce((a, b) => (b.speed < a.speed ? b : a));
  const before = tr.samples.filter((s) => s.d > Math.max(d0 - 350, prevD) && s.d < min.d);
  const entry = before.length ? before.reduce((a, b) => (b.speed > a.speed ? b : a)) : min;
  const after = tr.samples.filter((s) => s.d > min.d && s.d < Math.min(d0 + 300, nextD));
  const exit = after.length ? after.reduce((a, b) => (b.speed > a.speed ? b : a)) : min;
  return { minSpeed: min.speed, gear: min.gear, entrySpeed: entry.speed, exitSpeed: exit.speed, braking: before.some((s) => s.brake > 0) };
}
const cornerD = mv.corners.map((c) => project(...apply(T, [c.trackPosition.x, c.trackPosition.y])) * STEP);
const corners = mv.corners.map((c, ci) => {
  const lo = ci > 0 ? (cornerD[ci - 1] + cornerD[ci]) / 2 : -Infinity;
  const hi = ci < cornerD.length - 1 ? (cornerD[ci] + cornerD[ci + 1]) / 2 : Infinity;
  const i = cornerD[ci] / STEP;
  const d = cornerD[ci];
  const h = (k) => { const a = line[(i + k - 5 + line.length) % line.length], b = line[(i + k + 5) % line.length]; return Math.atan2(b[1] - a[1], b[0] - a[0]); };
  let dh = h(12) - h(-12);
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  const stats = Object.fromEntries(LAPS.map((l) => [l.key, cornerStats(l.tr, d, lo, hi, cornerD[ci - 1] ?? -Infinity, cornerD[ci + 1] ?? Infinity)]));
  return {
    number: c.number,
    x: r1(line[i][0]), y: r1(line[i][1]), d: r1(d),
    elev: r1(elevAbs[i]),
    dir: dh > 0 ? 'left' : 'right',
    headingChange: Math.round((dh * 180) / Math.PI),
    stats,
  };
});
const sectorOf = (d) => (d < sectorEnds[0] ? 1 : d < sectorEnds[1] ? 2 : 3);
corners.forEach((c) => (c.sector = sectorOf(c.d)));

const packTrace = (l) => ({
  driver: l.who,
  lapTime: l.tr.lapTime,
  sectorTimes: l.tr.sectorTimes,
  sectorEnds: l.tr.sectorEnds,
  cols: ['t', 'd', 'speed', 'gear', 'throttle', 'brake'],
  rows: l.tr.samples.map((s) => [Math.round(s.t * 1000) / 1000, r1(s.d), s.speed, s.gear, s.throttle, s.brake ? 1 : 0]),
});

// ---------------------------------------------------------------- terrain grid
// Square grid of bare-earth heights (metres above H0) with the track corridor blended in,
// so the ribbon never fights the ground.
const TER_STEP = 8;
const xs = line.map((p) => p[0]), ys = line.map((p) => p[1]);
const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
const HALF = 1560;
const TN = Math.round((2 * HALF) / TER_STEP) + 1;
const tx0 = Math.round(cx - HALF), ty0 = Math.round(cy - HALF);
const hgrid = new Float64Array(TN * TN);
for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) hgrid[j * TN + i] = demXY(tx0 + i * TER_STEP, ty0 + j * TER_STEP);
if (hgrid.some((v) => Number.isNaN(v))) throw new Error('DEM does not cover the terrain grid');
// centreline spatial index
const cgrid = new Map();
const CG = 40;
line.forEach((p, i) => { const k = `${Math.floor(p[0] / CG)},${Math.floor(p[1] / CG)}`; if (!cgrid.has(k)) cgrid.set(k, []); cgrid.get(k).push(i); });
function nearestLine(x, y) {
  let bi = -1, bd = Infinity;
  const gx = Math.floor(x / CG), gy = Math.floor(y / CG);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const i of cgrid.get(`${gx + a},${gy + b}`) || []) { const d = (line[i][0] - x) ** 2 + (line[i][1] - y) ** 2; if (d < bd) (bd = d), (bi = i); }
  return [bi, Math.sqrt(bd)];
}
const TRACK_HALF = 7.5;
for (let j = 0; j < TN; j++)
  for (let i = 0; i < TN; i++) {
    const [k, d] = nearestLine(tx0 + i * TER_STEP, ty0 + j * TER_STEP);
    if (k < 0 || d > 36) continue;
    const target = elevAbs[k] - 0.35;
    const f = d <= TRACK_HALF + 5 ? 1 : 1 - ((d - TRACK_HALF - 5) / (36 - TRACK_HALF - 5)) ** 2 * (3 - 2 * ((d - TRACK_HALF - 5) / (36 - TRACK_HALF - 5)));
    const g = hgrid[j * TN + i];
    hgrid[j * TN + i] = g + (target - g) * Math.max(0, Math.min(1, d <= TRACK_HALF + 5 ? 1 : f));
  }
const H0 = Math.floor(hgrid.reduce((a, v) => Math.min(a, v), Infinity));
const terr = new Uint16Array(TN * TN);
for (let k = 0; k < terr.length; k++) terr[k] = Math.round((hgrid[k] - H0) * 100);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'terrain.bin'), Buffer.from(terr.buffer));
console.log('terrain:', TN, 'x', TN, 'step', TER_STEP, 'm, H0', H0, 'm, relief', (hgrid.reduce((a, v) => Math.max(a, v), -Infinity) - H0).toFixed(1), 'm');

const elev = elevAbs.map((v) => v - H0);
console.log('track elevation: min', Math.min(...elevAbs).toFixed(1), 'max', Math.max(...elevAbs).toFixed(1), 'm ASL');

const track = {
  generated: new Date().toISOString(),
  origin: { lat: lat0, lon: lon0 },
  icp: { scale: T.s, rotationDeg: (T.th * 180) / Math.PI, mirror: T.m, medianErr_m: best.err },
  length_m: r1(trackLen),
  step_m: STEP,
  // x, y (local metres), z (metres above terrain datum H0)
  line: line.map((p, i) => [r1(p[0]), r1(p[1]), r2(elev[i])]),
  datum_m: H0,
  terrain: { file: 'terrain.bin', n: TN, step: TER_STEP, x0: tx0, y0: ty0, scale: 0.01, source: 'AWS Terrain Tiles (USGS 3DEP), zoom 15' },
  pit: (() => { const w = ways.get(PIT_WAY); return w ? wayPts(w).map((p) => [r1(p[0]), r1(p[1]), r2(demXY(p[0], p[1]) - H0)]) : []; })(),
  sectors: sectorEnds,
  corners,
  laps: Object.fromEntries(LAPS.map((l) => [l.key, packTrace(l)])),
};
fs.writeFileSync(path.join(OUT, 'track.json'), JSON.stringify(track));
console.table(corners.map((c) => ({ n: c.number, dir: c.dir, dh: c.headingChange, d: c.d, s: c.sector, elev: c.elev, ...Object.fromEntries(LAPS.map((l) => [l.key, c.stats[l.key] ? `${c.stats[l.key].minSpeed}/${c.stats[l.key].gear}` : '-'])) })));

// ---------------------------------------------------------------- city / ground features
const R = HALF + 40;
const inRange = (pts) => pts.some(([x, y]) => Math.abs(x - cx) < R && Math.abs(y - cy) < R);
const num = (v) => { const f = parseFloat(String(v || '').replace(',', '.')); return Number.isFinite(f) ? f : null; };
const polyPack = (pts) => pts.flatMap(([x, y]) => [Math.round(x * 2) / 2, Math.round(y * 2) / 2]);
function area(pts) { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a / 2); }
const centroid = (pts) => pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
function joinRings(memberWays) {
  const segs = memberWays.map((w) => w.nodes.slice()).filter((s) => s.length > 1);
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let guard = 0;
    while (ring[0] !== ring.at(-1) && guard++ < 5000) {
      const end = ring.at(-1);
      const k = segs.findIndex((s) => s[0] === end || s.at(-1) === end);
      if (k < 0) break;
      const s = segs.splice(k, 1)[0];
      ring = ring.concat(s[0] === end ? s.slice(1) : s.slice().reverse().slice(1));
    }
    if (ring[0] === ring.at(-1)) rings.push(ring);
  }
  return rings.map((r) => r.map((id) => nodes.get(id)).filter(Boolean).map(ll));
}
function pip([x, y], poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    if (poly[i][1] > y !== poly[j][1] > y && x < ((poly[j][0] - poly[i][0]) * (y - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
  return c;
}
function areaFeatures(test) {
  const polys = [];
  for (const w of ways.values()) {
    if (!test(w.tags || {}) || w.nodes[0] !== w.nodes.at(-1)) continue;
    const pts = wayPts(w).slice(0, -1);
    if (pts.length >= 3 && inRange(pts)) polys.push({ outer: polyPack(pts), holes: [] });
  }
  for (const r of rels.values()) {
    if (!test(r.tags || {}) || r.tags.type !== 'multipolygon') continue;
    const mw = (role) => r.members.filter((m) => m.type === 'way' && (role === 'inner' ? m.role === 'inner' : m.role !== 'inner')).map((m) => ways.get(m.ref)).filter(Boolean);
    const holes = joinRings(mw('inner')).map((p) => p.slice(0, -1));
    for (const o of joinRings(mw('outer'))) {
      const op = o.slice(0, -1);
      if (op.length < 3 || !inRange(op)) continue;
      polys.push({ outer: polyPack(op), holes: holes.filter((h) => pip(h[0], op)).map(polyPack) });
    }
  }
  return polys;
}
const isRunoff = (t) => t.motorsport === 'run-off';
const ground = {
  grass: areaFeatures((t) => ['grass', 'meadow', 'village_green', 'recreation_ground'].includes(t.landuse) || (t.surface === 'grass' && !isRunoff(t)) || ['pitch', 'park', 'garden'].includes(t.leisure)),
  scrub: areaFeatures((t) => ['scrub', 'wood'].includes(t.natural) || t.landuse === 'forest'),
  water: areaFeatures((t) => t.natural === 'water' || t.leisure === 'swimming_pool'),
  parking: areaFeatures((t) => t.amenity === 'parking' && !t.building),
  plaza: areaFeatures((t) => (t.highway === 'pedestrian' && t.area !== 'no') || (t.area === 'yes' && t.highway === 'footway')),
  gravel: areaFeatures((t) => (t.surface === 'gravel' || t.surface === 'fine_gravel') && !t.highway && !t.landuse),
  runoffRed: areaFeatures((t) => isRunoff(t) && t['surface:colour'] === 'red'),
  runoffBlue: areaFeatures((t) => isRunoff(t) && t['surface:colour'] === 'blue'),
  runoffWhite: areaFeatures((t) => isRunoff(t) && t['surface:colour'] === 'white'),
  runoff: areaFeatures((t) => isRunoff(t) && !t['surface:colour'] && t.surface !== 'grass' && t.surface !== 'gravel'),
  runoffGravel: areaFeatures((t) => isRunoff(t) && t.surface === 'gravel'),
  runoffGrass: areaFeatures((t) => isRunoff(t) && t.surface === 'grass'),
  raceway: areaFeatures((t) => t['area:highway'] === 'raceway'),
  kerb: areaFeatures((t) => t.motorsport === 'kerb'),
  bleachers: areaFeatures((t) => t.leisure === 'bleachers'),
};
const ROAD_W = { motorway: 22, motorway_link: 8, trunk: 16, primary: 14, secondary: 11, tertiary: 9, residential: 7, unclassified: 7, service: 5, footway: 2.2, path: 1.8, cycleway: 2.5, track: 3.5, raceway: 0 };
const lines = { roads: [], paths: [], barriers: [], markings: [] };
for (const w of ways.values()) {
  const t = w.tags || {};
  const pts = wayPts(w);
  if (pts.length < 2 || !inRange(pts)) continue;
  if (t.highway && ROAD_W[t.highway] && t.area !== 'yes' && t.tunnel !== 'yes') (t.highway === 'footway' || t.highway === 'path' || t.highway === 'cycleway' ? lines.paths : lines.roads).push([ROAD_W[t.highway], ...polyPack(pts)]);
  else if (t.highway === 'raceway' && !circuitRel.members.some((m) => m.ref === w.id)) lines.roads.push([6, ...polyPack(pts)]); // other circuit layouts / karting
  else if (['guard_rail', 'wall', 'fence', 'retaining_wall'].includes(t.barrier)) lines.barriers.push([t.barrier === 'fence' ? 0 : 1, ...polyPack(pts)]);
  else if (t.motorsport === 'marking' && w.nodes[0] !== w.nodes.at(-1)) lines.markings.push(polyPack(pts));
}

// buildings
const TOWER_WAY = 847781224;
const buildings = [];
for (const w of ways.values()) {
  const t = w.tags || {};
  if (!t.building || w.nodes[0] !== w.nodes.at(-1) || w.id === TOWER_WAY) continue;
  if (t.building === 'roof' && !t.height) continue;
  const pts = wayPts(w).slice(0, -1);
  if (pts.length < 3 || !inRange(pts)) continue;
  const a = area(pts);
  const c = centroid(pts);
  const nearCircuit = Math.hypot(c[0] - cx, c[1] - cy) < 1000;
  let h = num(t.height) ?? (num(t['building:levels']) != null ? num(t['building:levels']) * 3.6 + 1 : null);
  let kind = 'b';
  if (t.building === 'grandstand') { h ??= Math.min(22, 8 + Math.sqrt(a) * 0.18); kind = 'g'; }
  else if (t.name === 'Pit Garages') h ??= 14;
  else if (t.building === 'static_caravan') h ??= 3.6;
  else h ??= nearCircuit ? Math.max(5, Math.min(16, 4 + Math.sqrt(a) * 0.15)) : 4.5;
  const base = Math.min(...pts.map(([x, y]) => demXY(x, y))) - H0;
  buildings.push([kind, r1(h), r1(base), ...polyPack(pts)]);
}

// landmarks (labelled in 3D)
const towerNode = [...nodes.values()].find((n) => n.tags?.['tower:type'] === 'observation');
const findWay = (re) => [...ways.values()].find((w) => w.tags?.name && re.test(w.tags.name));
const findRel = (re) => [...rels.values()].find((r) => r.tags?.name && re.test(r.tags.name));
const wayC = (w) => centroid(wayPts(w).slice(0, -1));
const relC = (r) => centroid(r.members.filter((m) => m.type === 'way' && m.role !== 'inner').flatMap((m) => (ways.get(m.ref) ? wayPts(ways.get(m.ref)) : [])));
const landmarks = [];
const addLm = (label, xy, h = 30, kind = 'site') => xy && landmarks.push({ label, x: r1(xy[0]), y: r1(xy[1]), z: r1(demXY(xy[0], xy[1]) - H0 + h), kind });
if (towerNode) addLm('Observation Tower', ll(towerNode), 95, 'tower');
const gp = findRel(/^Grand Plaza$/); if (gp) addLm('Grand Plaza', relC(gp), 18);
const amp = findWay(/^Germania Insurance Amphitheater$/); if (amp) addLm('Germania Amphitheater', wayC(amp), 30);
const pits = findWay(/^Pit Garages$/); if (pits) addLm('Pit building & paddock', wayC(pits), 34);
// the Main Grandstand sits opposite the pits on the start/finish straight: largest grandstand near the line start
{
  const gs = [...ways.values()].filter((w) => w.tags?.building === 'grandstand' && w.nodes[0] === w.nodes.at(-1)).map((w) => ({ w, c: wayC(w), a: area(wayPts(w).slice(0, -1)) }));
  const nearStart = gs.filter((g) => Math.hypot(g.c[0] - line[0][0], g.c[1] - line[0][1]) < 400).sort((a, b) => b.a - a.a)[0];
  if (nearStart) addLm('Main Grandstand', nearStart.c, 34);
}
// distant Austin skyline: Texas State Capitol direction, label placed at the edge of the terrain
{
  const cap = [(-97.7404 - lon0) * KX, (30.2747 - lat0) * KY];
  const dist = Math.hypot(...cap);
  const dir = [cap[0] / dist, cap[1] / dist];
  landmarks.push({ label: `Downtown Austin · ${Math.round(dist / 1000)} km`, x: r1(cx + dir[0] * 1900), y: r1(cy + dir[1] * 1900), z: 60, kind: 'far', dir: dir.map((v) => Math.round(v * 1000) / 1000), dist_m: Math.round(dist) });
}
for (const l of landmarks) console.log('landmark', l.label, l.x, l.y, l.z);

const city = { bounds: { x0: tx0, y0: ty0, size: 2 * HALF }, buildings, ground, lines, landmarks, tower: towerNode ? { x: r1(ll(towerNode)[0]), y: r1(ll(towerNode)[1]), z: r1(demXY(...ll(towerNode)) - H0), h: num(towerNode.tags.height) || 76.5 } : null };
fs.writeFileSync(path.join(OUT, 'city.json'), JSON.stringify(city));
console.log('city:', { buildings: buildings.length, ...Object.fromEntries(Object.entries(ground).map(([k, v]) => [k, v.length])), ...Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, v.length])) });

// ---------------------------------------------------------------- sessions snapshot
const sessions = raw('sessions.json').filter((s) => /Qualifying|Race|Sprint/.test(s.session_name) && fs.existsSync(path.join(RAW, `laps_${s.session_key}.json`)));
const summaries = sessions
  .map((s) => summarizeSession(s, raw(`laps_${s.session_key}.json`), raw(`drv_${s.session_key}.json`), fs.existsSync(path.join(RAW, `res_${s.session_key}.json`)) ? raw(`res_${s.session_key}.json`) : []))
  .filter(Boolean)
  .sort((a, b) => b.date.localeCompare(a.date));
fs.writeFileSync(path.join(OUT, 'sessions.json'), JSON.stringify({ generated: new Date().toISOString(), source: 'OpenF1 (api.openf1.org)', sessions: summaries }, null, 1));
console.log('sessions:', summaries.map((s) => `${s.year} ${s.name} ${s.fastest.time}`).join(' | '));
for (const f of ['track.json', 'city.json', 'sessions.json', 'terrain.bin']) console.log(f, (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0), 'KB');
