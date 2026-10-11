// Builds walkthroughs/singapore/data/{track,city,sessions}.json from raw downloads in ./raw
// (see fetch-raw.sh). Run: node tools/singapore/build-data.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeSession } from '../../walkthroughs/singapore/stats.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(here, 'raw');
const OUT = path.join(here, '../../walkthroughs/singapore/data');
const raw = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
const r1 = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------- OSM helpers
const nodes = new Map();
const ways = new Map();
const rels = new Map();
function ingest(elements) {
  for (const e of elements) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way') ways.set(e.id, e);
    else if (e.type === 'relation') rels.set(e.id, e);
  }
}
for (const f of fs.readdirSync(path.join(RAW, 'osm'))) ingest(raw(`osm/${f}`).elements);
for (const r of [421263, 9542146, 9569901]) ingest(raw(`rel_${r}.json`).elements);

const circuitRel = rels.get(421263);
const circuitWays = circuitRel.members.filter((m) => m.type === 'way' && m.role !== 'pitlane').map((m) => ways.get(m.ref)).filter(Boolean);
const circuitNodes = circuitWays.flatMap((w) => w.nodes.map((n) => nodes.get(n)).filter(Boolean));
const lat0 = circuitNodes.reduce((a, n) => a + n.lat, 0) / circuitNodes.length;
const lon0 = circuitNodes.reduce((a, n) => a + n.lon, 0) / circuitNodes.length;
const KX = Math.cos((lat0 * Math.PI) / 180) * 111320;
const KY = 110574;
const ll = (n) => [(n.lon - lon0) * KX, (n.lat - lat0) * KY];
const wayPts = (w) => w.nodes.map((id) => nodes.get(id)).filter(Boolean).map(ll);

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
const osmTrackNamed = circuitWays.map((w) => ({ name: w.tags?.name, pts: densify([wayPts(w)], 4) }));
const grid = new Map();
const G = 25;
for (const p of osmTrack) {
  const k = `${Math.floor(p[0] / G)},${Math.floor(p[1] / G)}`;
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(p);
}
function nearestOsm(x, y) {
  let best = null;
  let bd = Infinity;
  const gx = Math.floor(x / G);
  const gy = Math.floor(y / G);
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

// similarity transform: q = s*R(th)*(mirror? (x,-y)) + t
function apply(T, [x, y]) {
  const yy = T.m ? -y : y;
  const c = Math.cos(T.th);
  const s = Math.sin(T.th);
  return [T.s * (c * x - s * yy) + T.tx, T.s * (s * x + c * yy) + T.ty];
}
function fit(src, dst, m) {
  // 2D Umeyama
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
  const th = Math.atan2(b, a);
  const s = Math.hypot(a, b) / vs;
  const c = Math.cos(th), sn = Math.sin(th);
  return { s, th, m, tx: dx - s * (c * sx - sn * sy), ty: dy - s * (sn * sx + c * sy) };
}
function icp(T0) {
  let T = T0;
  let err = 0;
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
    const th = (deg * Math.PI) / 180;
    const s = 0.1;
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
// close loop & resample every 3 m
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

// telemetry samples for a pole lap
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
      // interpolate position at t
      let k = locT.findIndex((l) => l.t >= t);
      if (k <= 0) k = Math.max(1, k === -1 ? locT.length - 1 : 1);
      const a = locT[k - 1], b = locT[k];
      const f = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t || 1)));
      return { t, x: a.p[0] + (b.p[0] - a.p[0]) * f, y: a.p[1] + (b.p[1] - a.p[1]) * f, z: a.z + (b.z - a.z) * f, speed: c.speed, gear: c.n_gear, throttle: c.throttle, brake: c.brake };
    })
    .filter((s) => s.t >= -0.5 && s.t <= lap.lap_duration + 0.5);
  return { lap, samples, locT };
}
const tel26 = lapTelemetry(11384, 3, '2026q');
const tel25 = lapTelemetry(9892, 63, '2025q');

// rotate centreline so index 0 is the timing line (car position at lap start)
const startPos = (() => {
  const s = tel26.samples;
  const k = s.findIndex((x) => x.t >= 0);
  return [s[k].x, s[k].y];
})();
// ensure centreline runs in race direction: compare with telemetry ordering
{
  const idx = (p) => centre.reduce((bi, q, i) => ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < (centre[bi][0] - p[0]) ** 2 + (centre[bi][1] - p[1]) ** 2 ? i : bi), 0);
  const s = tel26.samples;
  const i0 = idx([s[5].x, s[5].y]);
  const i1 = idx([s[12].x, s[12].y]);
  const fwd = (i1 - i0 + centre.length) % centre.length;
  if (fwd > centre.length / 2) centre.reverse();
  const k = idx(startPos);
  centre = [...centre.slice(k), ...centre.slice(0, k)];
}
const { out: line, L: trackLen } = resample(centre, 3, true);
console.log('track length (m):', trackLen.toFixed(1), 'points:', line.length);

function project(x, y, hint) {
  // nearest index on resampled line, optionally searching near a hint index
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

// elevation from both laps' location z (units match x/y)
const zSum = new Float64Array(line.length), zCnt = new Float64Array(line.length);
for (const tel of [tel26, tel25])
  for (const l of tel.locT) {
    const i = project(l.p[0], l.p[1]);
    for (let k = -3; k <= 3; k++) {
      const j = (i + k + line.length) % line.length;
      zSum[j] += l.z * T.s;
      zCnt[j] += 1;
    }
  }
let elev = Array.from(line, (_, i) => (zCnt[i] ? zSum[i] / zCnt[i] : NaN));
// fill gaps + smooth
for (let pass = 0; pass < 3; pass++)
  elev = elev.map((v, i) => {
    if (!Number.isNaN(v)) return v;
    for (let k = 1; k < 50; k++) {
      const a = elev[(i - k + elev.length) % elev.length], b = elev[(i + k) % elev.length];
      if (!Number.isNaN(a) || !Number.isNaN(b)) return Number.isNaN(a) ? b : Number.isNaN(b) ? a : (a + b) / 2;
    }
    return 0;
  });
for (let pass = 0; pass < 4; pass++) elev = elev.map((_, i) => { let s = 0; for (let k = -6; k <= 6; k++) s += elev[(i + k + elev.length) % elev.length]; return s / 13; });
const zMin = Math.min(...elev);
elev = elev.map((v) => v - zMin);
console.log('elevation range (m):', Math.max(...elev).toFixed(1));

// telemetry traces vs distance
function trace(tel) {
  let hint = null;
  const out = [];
  for (const s of tel.samples) {
    const i = project(s.x, s.y, hint);
    hint = i;
    let d = i * 3;
    if (s.t < 2 && d > trackLen / 2) d -= trackLen;
    if (s.t > tel.lap.lap_duration - 5 && d < trackLen / 2) d += trackLen;
    out.push({ t: s.t, d, speed: s.speed, gear: s.gear, throttle: s.throttle, brake: s.brake });
  }
  // enforce monotone distance
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
const tr26 = trace(tel26);
const tr25 = trace(tel25);

// ---------------------------------------------------------------- corners
function nearestStreet(x, y) {
  let bn = null, bd = Infinity;
  for (const w of osmTrackNamed) for (const p of w.pts) { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd && w.name) (bd = d), (bn = w.name); }
  return bn;
}
function cornerStats(tr, d0, lo = d0 - 90, hi = d0 + 90, prevD = d0 - 350, nextD = d0 + 300) {
  const win = tr.samples.filter((s) => s.d > Math.max(lo, d0 - 90) && s.d < Math.min(hi, d0 + 90));
  if (!win.length) return null;
  const min = win.reduce((a, b) => (b.speed < a.speed ? b : a));
  const before = tr.samples.filter((s) => s.d > Math.max(d0 - 350, prevD) && s.d < min.d);
  const entry = before.length ? before.reduce((a, b) => (b.speed > a.speed ? b : a)) : min;
  const after = tr.samples.filter((s) => s.d > min.d && s.d < Math.min(d0 + 300, nextD));
  const exit = after.length ? after.reduce((a, b) => (b.speed > a.speed ? b : a)) : min;
  return { minSpeed: min.speed, gear: min.gear, entrySpeed: entry.speed, exitSpeed: exit.speed, braking: before.some((s) => s.brake > 0) };
}
const cornerD = mv.corners.map((c) => project(...apply(T, [c.trackPosition.x, c.trackPosition.y])) * 3);
const corners = mv.corners.map((c, ci) => {
  const lo = ci > 0 ? (cornerD[ci - 1] + cornerD[ci]) / 2 : -Infinity;
  const hi = ci < cornerD.length - 1 ? (cornerD[ci] + cornerD[ci + 1]) / 2 : Infinity;
  const [x, y] = apply(T, [c.trackPosition.x, c.trackPosition.y]);
  const i = project(x, y);
  const d = i * 3;
  // turn direction from heading change across the corner
  const h = (k) => { const a = line[(i + k - 5 + line.length) % line.length], b = line[(i + k + 5) % line.length]; return Math.atan2(b[1] - a[1], b[0] - a[0]); };
  let dh = h(12) - h(-12);
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  return {
    number: c.number,
    x: r1(line[i][0]), y: r1(line[i][1]), d: r1(d),
    dir: dh > 0 ? 'left' : 'right',
    headingChange: Math.round((dh * 180) / Math.PI),
    street: nearestStreet(x, y),
    pole2026: cornerStats(tr26, d, lo, hi, cornerD[ci - 1] ?? -Infinity, cornerD[ci + 1] ?? Infinity),
    pole2025: cornerStats(tr25, d, lo, hi, cornerD[ci - 1] ?? -Infinity, cornerD[ci + 1] ?? Infinity),
  };
});

const sectorOf = (d) => (d < tr26.sectorEnds[0] ? 1 : d < tr26.sectorEnds[1] ? 2 : 3);
corners.forEach((c) => (c.sector = sectorOf(c.d)));

const packTrace = (tr, who) => ({
  driver: who,
  lapTime: tr.lapTime,
  sectorTimes: tr.sectorTimes,
  sectorEnds: tr.sectorEnds,
  // columns: t, d, speed, gear, throttle, brake
  cols: ['t', 'd', 'speed', 'gear', 'throttle', 'brake'],
  rows: tr.samples.map((s) => [Math.round(s.t * 1000) / 1000, r1(s.d), s.speed, s.gear, s.throttle, s.brake ? 1 : 0]),
});

const track = {
  generated: new Date().toISOString(),
  origin: { lat: lat0, lon: lon0 },
  icp: { scale: T.s, rotationDeg: (T.th * 180) / Math.PI, mirror: T.m, medianErr_m: best.err },
  length_m: r1(trackLen),
  step_m: 3,
  line: line.map((p, i) => [r1(p[0]), r1(p[1]), r1(elev[i])]),
  pit: (() => { const w = ways.get(100484287); return w ? wayPts(w).map((p) => [r1(p[0]), r1(p[1])]) : []; })(),
  sectors: tr26.sectorEnds,
  corners,
  laps: {
    q2026: packTrace(tr26, { code: 'VER', name: 'Max Verstappen', team: 'Red Bull Racing', session: '2026 Qualifying (pole)' }),
    q2025: packTrace(tr25, { code: 'RUS', name: 'George Russell', team: 'Mercedes', session: '2025 Qualifying (pole)' }),
  },
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'track.json'), JSON.stringify(track));
console.table(corners.map((c) => ({ n: c.number, dir: c.dir, dh: c.headingChange, d: c.d, s: c.sector, street: c.street, min26: c.pole2026?.minSpeed, g26: c.pole2026?.gear, min25: c.pole2025?.minSpeed, g25: c.pole2025?.gear })));

// ---------------------------------------------------------------- city
const R = 1900;
const inRange = (pts) => pts.some(([x, y]) => Math.hypot(x, y) < R);
const num = (v) => { const f = parseFloat(String(v || '').replace(',', '.')); return Number.isFinite(f) ? f : null; };
function heightOf(t) {
  const h = num(t.height) ?? (num(t['building:levels']) != null ? num(t['building:levels']) * 3.6 + 2 : null);
  const minH = num(t.min_height) ?? (num(t['building:min_level']) != null ? num(t['building:min_level']) * 3.6 : 0);
  return { h, minH };
}
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
const polyPack = (pts) => pts.flatMap(([x, y]) => [Math.round(x * 2) / 2, Math.round(y * 2) / 2]);
function area(pts) { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a / 2); }

const buildings = [];
const named = [];
const partWays = [];
const outlineWays = [];
for (const w of ways.values()) {
  const t = w.tags || {};
  if (!(t.building || t['building:part']) || w.nodes[0] !== w.nodes.at(-1)) continue;
  if (t.building === 'roof' && !t.height) continue;
  const pts = wayPts(w).slice(0, -1);
  if (pts.length < 3 || !inRange(pts)) continue;
  (t['building:part'] ? partWays : outlineWays).push({ w, t, pts });
}
for (const r of rels.values()) {
  const t = r.tags || {};
  if (!(t.building || t['building:part']) || t.type !== 'multipolygon') continue;
  const outers = r.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => ways.get(m.ref)).filter(Boolean);
  for (const pts of joinRings(outers)) {
    const p = pts.slice(0, -1);
    if (p.length >= 3 && inRange(p)) (t['building:part'] ? partWays : outlineWays).push({ w: r, t, pts: p });
  }
}
function pip([x, y], poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    if (poly[i][1] > y !== poly[j][1] > y && x < ((poly[j][0] - poly[i][0]) * (y - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
  return c;
}
const centroid = (pts) => pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
const partCentroids = partWays.map((p) => centroid(p.pts));
for (const o of outlineWays) {
  const { h, minH } = heightOf(o.t);
  const a = area(o.pts);
  const hasParts = partCentroids.some((c) => Math.abs(c[0] - o.pts[0][0]) < 400 && pip(c, o.pts));
  if (hasParts && o.t.building !== 'yes' && false) continue;
  if (hasParts) continue;
  const hh = h ?? Math.min(40, 9 + Math.sqrt(a) * 0.25);
  if (hh <= 0.5) continue;
  buildings.push([Math.round(hh * 2) / 2, Math.round(minH * 2) / 2, ...polyPack(o.pts)]);
  if (o.t.name && (h ?? 0) > 0) named.push({ name: o.t.name, h: hh, c: centroid(o.pts).map(r1), a: Math.round(a) });
}
for (const p of partWays) {
  const { h, minH } = heightOf(p.t);
  const hh = h ?? 12;
  if (hh - minH <= 0.3) continue;
  buildings.push([Math.round(hh * 2) / 2, Math.round(minH * 2) / 2, ...polyPack(p.pts)]);
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
      if (op.length < 3) continue;
      polys.push({ outer: polyPack(op), holes: holes.filter((h) => pip(h[0], op)).map(polyPack) });
    }
  }
  return polys;
}
const water = areaFeatures((t) => t.natural === 'water' || t.waterway === 'riverbank' || t.water === 'river' || t.water === 'reservoir' || t.natural === 'bay');
const green = areaFeatures((t) => ['park', 'garden', 'pitch', 'nature_reserve'].includes(t.leisure) || ['grass', 'recreation_ground', 'village_green'].includes(t.landuse) || t.natural === 'wood');

const ROAD_W = { motorway: 18, trunk: 16, primary: 14, secondary: 11, tertiary: 9, residential: 7, unclassified: 7, service: 5, motorway_link: 8, trunk_link: 8, primary_link: 8 };
const roads = [];
for (const w of ways.values()) {
  const t = w.tags || {};
  const width = ROAD_W[t.highway];
  if (!width || t.tunnel === 'yes' || t.layer < 0) continue;
  const pts = wayPts(w);
  if (pts.length < 2 || !inRange(pts)) continue;
  roads.push([width, ...polyPack(pts)]);
}

// labelled landmarks (from OSM names, nodes or ways)
const WANT = [
  ['Singapore Flyer', /^Singapore Flyer$/],
  ['Marina Bay Sands', /^Marina Bay Sands Hotel$|^Marina Bay Sands$/],
  ['Esplanade', /^Esplanade.*Theatres on the Bay|^Esplanade$/],
  ['The Fullerton Hotel', /^The Fullerton Hotel/],
  ['Anderson Bridge', /^Anderson Bridge$/],
  ['The Padang', /^(The )?Padang$/],
  ['National Gallery', /^National Gallery Singapore$/],
  ['Victoria Theatre', /^Victoria Theatre/],
  ['Raffles Hotel', /^Raffles Hotel$/],
  ['Merlion', /^Merlion$/],
  ['ArtScience Museum', /^ArtScience Museum$/],
  ['War Memorial', /^Civilian War Memorial$/],
  ['Esplanade Bridge', /^Esplanade Bridge$/],
  ['Cavenagh Bridge', /^Cavenagh Bridge$/],
  ['Suntec City', /^Suntec City$/],
  ['St Andrew’s Cathedral', /^St\.? Andrew'?s Cathedral$/],
  ['Helix Bridge', /^The Helix Bridge$|^Helix Bridge$/],
];
const landmarks = [];
for (const [label, re] of WANT) {
  let hit = null;
  for (const n of nodes.values()) if (n.tags?.name && re.test(n.tags.name)) { hit = ll(n); break; }
  if (!hit) for (const w of ways.values()) if (w.tags?.name && re.test(w.tags.name)) { const pts = wayPts(w); hit = centroid(pts.length > 1 && w.nodes[0] === w.nodes.at(-1) ? pts.slice(0, -1) : pts); break; }
  if (!hit) for (const r of rels.values()) if (r.tags?.name && re.test(r.tags.name)) { const pts = r.members.filter((m) => m.type === 'way').flatMap((m) => (ways.get(m.ref) ? wayPts(ways.get(m.ref)) : [])); if (pts.length) hit = centroid(pts); break; }
  if (hit) landmarks.push({ label, x: r1(hit[0]), y: r1(hit[1]) });
  else console.warn('landmark not found:', label);
}

fs.writeFileSync(path.join(OUT, 'city.json'), JSON.stringify({ radius: R, buildings, water, green, roads, landmarks }));
console.log('city:', { buildings: buildings.length, water: water.length, green: green.length, roads: roads.length, landmarks: landmarks.length });
console.log('tallest named:', named.sort((a, b) => b.h - a.h).slice(0, 12).map((n) => `${n.name} ${n.h}m`).join(', '));

// ---------------------------------------------------------------- sessions snapshot
const sessions = raw('sessions.json').filter((s) => /Qualifying|Race|Sprint/.test(s.session_name) && fs.existsSync(path.join(RAW, `laps_${s.session_key}.json`)));
const summaries = sessions
  .map((s) => summarizeSession(s, raw(`laps_${s.session_key}.json`), raw(`drv_${s.session_key}.json`), fs.existsSync(path.join(RAW, `res_${s.session_key}.json`)) ? raw(`res_${s.session_key}.json`) : []))
  .filter(Boolean)
  .sort((a, b) => b.date.localeCompare(a.date));
fs.writeFileSync(path.join(OUT, 'sessions.json'), JSON.stringify({ generated: new Date().toISOString(), source: 'OpenF1 (api.openf1.org)', sessions: summaries }, null, 1));
console.log('sessions:', summaries.map((s) => `${s.year} ${s.name} ${s.fastest.time}`).join(' | '));
for (const f of ['track.json', 'city.json', 'sessions.json']) console.log(f, (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0), 'KB');
