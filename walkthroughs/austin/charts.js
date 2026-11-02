// Small hand-rolled SVG charts (no chart library).
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const txt = (parent, attrs, s) => { const t = el('text', attrs, parent); t.textContent = s; return t; };

function bsearch(rows, col, v) {
  let lo = 0, hi = rows.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m][col] < v) lo = m; else hi = m; }
  return [lo, hi];
}
function interp(rows, col, v, out) {
  const [lo, hi] = bsearch(rows, col, v);
  const a = rows[lo], b = rows[hi];
  const f = b[col] === a[col] ? 0 : Math.min(1, Math.max(0, (v - a[col]) / (b[col] - a[col])));
  return a[out] + (b[out] - a[out]) * f;
}

/**
 * Three stacked panels sharing one distance axis and crosshair:
 *   speed trace (all laps) · time delta vs the first lap · elevation profile.
 * Rows: [t, d, speed, gear, throttle, brake]. onHover(distance|null) syncs the 3D cursor.
 */
export function lapChart(host, { series, sectors, corners, length, sectorColors, elevation, datum, onHover }) {
  host.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  host.appendChild(wrap);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  wrap.appendChild(tip);

  const SH = 290, DH = 120, EH = 96, GAP = 22;
  const M = { l: 48, r: 14, t: 30, b: 24 };
  const top = { s: M.t, d: M.t + SH + GAP, e: M.t + SH + GAP + DH + GAP };
  const H = top.e + EH + M.b;
  const svg = el('svg', { role: 'img', 'aria-label': 'Speed, time delta and elevation by distance for the pole laps' }, wrap);

  // time delta of each lap vs the reference lap, sampled every 10 m
  const ref = series[0];
  const deltas = series.slice(1).map((s) => {
    const pts = [];
    for (let d = 0; d <= length; d += 10) pts.push([d, interp(s.rows, 1, d, 0) - interp(ref.rows, 1, d, 0)]);
    return pts;
  });
  const dAbs = Math.max(0.5, ...deltas.flat().map((p) => Math.abs(p[1])));
  const dMax = Math.ceil(dAbs * 2) / 2;
  const eMin = Math.min(...elevation.map((p) => p[1])), eMax = Math.max(...elevation.map((p) => p[1]));

  let W = 0, xFn, cross, dots = [];
  function draw() {
    W = Math.max(320, wrap.clientWidth);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';
    const x = (d) => M.l + (d / length) * (W - M.l - M.r);
    xFn = x;
    const ys = (v) => top.s + (1 - v / 360) * SH;
    const yd = (v) => top.d + DH / 2 - (v / dMax) * (DH / 2 - 6);
    const ye = (v) => top.e + EH - 6 - ((v - eMin) / (eMax - eMin)) * (EH - 16);

    const bounds = [0, ...sectors, length];
    for (let s = 0; s < 3; s++) {
      el('rect', { x: x(bounds[s]), y: top.s, width: x(bounds[s + 1]) - x(bounds[s]), height: top.e + EH - top.s, fill: sectorColors[s], opacity: 0.06 }, svg);
      txt(svg, { x: x(bounds[s]) + 6, y: top.s + 14, class: 'chart-sector' }, `S${s + 1}`);
    }
    for (const c of corners) {
      el('line', { x1: x(c.d), x2: x(c.d), y1: top.s, y2: top.e + EH, class: 'chart-corner' }, svg);
      txt(svg, { x: x(c.d), y: top.s - 8, class: 'chart-corner-num', 'text-anchor': 'middle' }, c.number);
    }
    // --- speed
    for (let v = 0; v <= 300; v += 100) {
      el('line', { x1: M.l, x2: W - M.r, y1: ys(v), y2: ys(v), class: 'chart-grid' }, svg);
      txt(svg, { x: M.l - 8, y: ys(v) + 4, class: 'chart-axis', 'text-anchor': 'end' }, v);
    }
    txt(svg, { x: M.l - 8, y: top.s - 12, class: 'chart-axis', 'text-anchor': 'end' }, 'km/h');
    for (let k = series.length - 1; k >= 0; k--) {
      const s = series[k];
      const d = s.rows.map((r, i) => `${i ? 'L' : 'M'}${x(Math.max(0, Math.min(length, r[1]))).toFixed(1)},${ys(r[2]).toFixed(1)}`).join('');
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': k === 0 ? 2.2 : 1.5, 'stroke-linejoin': 'round', opacity: k === 0 ? 1 : 0.85 }, svg);
    }
    // --- delta
    txt(svg, { x: M.l, y: top.d - 6, class: 'chart-panel' }, `Time vs ${ref.label} · below the line = faster`);
    for (const v of [-dMax, 0, dMax]) {
      el('line', { x1: M.l, x2: W - M.r, y1: yd(v), y2: yd(v), class: v ? 'chart-grid' : 'chart-zero' }, svg);
      txt(svg, { x: M.l - 8, y: yd(v) + 4, class: 'chart-axis', 'text-anchor': 'end' }, `${v > 0 ? '+' : ''}${v.toFixed(1)}s`);
    }
    deltas.forEach((pts, i) => {
      const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p[0]).toFixed(1)},${yd(p[1]).toFixed(1)}`).join('');
      el('path', { d, fill: 'none', stroke: series[i + 1].color, 'stroke-width': 1.8, 'stroke-linejoin': 'round' }, svg);
    });
    // --- elevation
    txt(svg, { x: M.l, y: top.e - 6, class: 'chart-panel' }, 'Elevation');
    const area = `M${x(0)},${top.e + EH}` + elevation.map((p) => `L${x(p[0]).toFixed(1)},${ye(p[1]).toFixed(1)}`).join('') + `L${x(length)},${top.e + EH}Z`;
    const gid = `eg${Math.random().toString(36).slice(2, 7)}`;
    const defs = el('defs', {}, svg);
    const lg = el('linearGradient', { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
    el('stop', { offset: '0', 'stop-color': '#d9a86c', 'stop-opacity': 0.55 }, lg);
    el('stop', { offset: '1', 'stop-color': '#d9a86c', 'stop-opacity': 0.04 }, lg);
    el('path', { d: area, fill: `url(#${gid})` }, svg);
    el('path', { d: elevation.map((p, k) => `${k ? 'L' : 'M'}${x(p[0]).toFixed(1)},${ye(p[1]).toFixed(1)}`).join(''), fill: 'none', stroke: '#e6b77a', 'stroke-width': 1.6 }, svg);
    for (const v of [eMin, eMax]) txt(svg, { x: M.l - 8, y: ye(v) + 4, class: 'chart-axis', 'text-anchor': 'end' }, `${Math.round(v + datum)}m`);
    for (let d = 0; d <= length; d += 1000) txt(svg, { x: x(d), y: H - 6, class: 'chart-axis', 'text-anchor': 'middle' }, d === 0 ? '0 km' : `${d / 1000}`);

    cross = el('line', { y1: top.s, y2: top.e + EH, class: 'chart-cross', visibility: 'hidden' }, svg);
    dots = series.map((s) => el('circle', { r: 4.5, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' }, svg));
    const hit = el('rect', { x: M.l, y: 0, width: W - M.l - M.r, height: H, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const d = Math.max(0, Math.min(length, ((px - M.l) / (W - M.l - M.r)) * length));
      show(d);
      onHover?.(d);
    });
    hit.addEventListener('pointerleave', () => { hide(); onHover?.(null); });
    draw.ys = ys;
  }

  function show(d, fromOutside = false) {
    const px = xFn(d);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    const tRef = interp(ref.rows, 1, d, 0);
    const lines = series.map((s, i) => {
      const [lo, hi] = bsearch(s.rows, 1, d);
      const r = Math.abs(s.rows[lo][1] - d) < Math.abs(s.rows[hi][1] - d) ? s.rows[lo] : s.rows[hi];
      dots[i].setAttribute('cx', xFn(r[1])); dots[i].setAttribute('cy', draw.ys(r[2])); dots[i].setAttribute('visibility', 'visible');
      const dt = i ? interp(s.rows, 1, d, 0) - tRef : null;
      return `<div class="tip-row"><i style="background:${s.color}"></i><span>${s.label}</span><b>${Math.round(r[2])} km/h</b><em>G${r[3]}${r[5] ? ' · brake' : r[4] > 95 ? ' · full throttle' : ''}${dt != null ? ` · ${dt > 0 ? '+' : ''}${dt.toFixed(3)} s` : ''}</em></div>`;
    });
    const near = corners.reduce((a, c) => (Math.abs(c.d - d) < Math.abs(a.d - d) ? c : a));
    const z = interp(elevation, 0, d, 1);
    tip.innerHTML = `<div class="tip-head">${(d / 1000).toFixed(2)} km${Math.abs(near.d - d) < 70 ? ` · Turn ${near.number}` : ''} · ${Math.round(z + datum)} m</div>${lines.join('')}`;
    tip.hidden = false;
    const left = (px / W) * wrap.clientWidth;
    tip.style.left = `${Math.min(wrap.clientWidth - tip.offsetWidth - 4, Math.max(4, left + 14))}px`;
    tip.classList.toggle('passive', fromOutside);
  }
  function hide() {
    tip.hidden = true;
    cross?.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
  }

  draw();
  new ResizeObserver(() => { if (Math.abs(wrap.clientWidth - W) > 2) draw(); }).observe(wrap);
  return { show: (d) => (d == null ? hide() : show(d, true)) };
}

/** Dot plot: one row per year, quali vs race best lap. */
export function evolutionChart(host, rows, { colors, fmt }) {
  host.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  host.appendChild(wrap);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  wrap.appendChild(tip);
  const svg = el('svg', { role: 'img', 'aria-label': 'Pole time vs fastest race lap by year' }, wrap);
  const draw = () => {
    const W = Math.max(300, wrap.clientWidth), RH = 38, M = { l: 52, r: 24, t: 10, b: 30 };
    const H = M.t + rows.length * RH + M.b;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';
    const vals = rows.flatMap((r) => [r.quali, r.race]).filter(Boolean);
    const lo = Math.floor(Math.min(...vals) - 0.5), hi = Math.ceil(Math.max(...vals) + 0.5);
    const x = (v) => M.l + ((v - lo) / (hi - lo)) * (W - M.l - M.r);
    for (let v = lo; v <= hi; v++) {
      el('line', { x1: x(v), x2: x(v), y1: M.t, y2: H - M.b, class: 'chart-grid' }, svg);
      txt(svg, { x: x(v), y: H - 10, class: 'chart-axis', 'text-anchor': 'middle' }, fmt(v).replace(/\.000$/, ''));
    }
    rows.forEach((r, i) => {
      const cy = M.t + i * RH + RH / 2;
      txt(svg, { x: M.l - 10, y: cy + 4, class: 'chart-axis strong', 'text-anchor': 'end' }, r.year);
      if (r.quali && r.race) el('line', { x1: x(r.quali), x2: x(r.race), y1: cy, y2: cy, class: 'chart-link' }, svg);
      [['quali', 0], ['race', 1]].forEach(([k, ci]) => {
        if (!r[k]) return;
        const c = el('circle', { cx: x(r[k]), cy, r: 6, fill: colors[ci], stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
        const hit = el('circle', { cx: x(r[k]), cy, r: 14, fill: 'transparent' }, svg);
        hit.addEventListener('pointerenter', () => {
          tip.innerHTML = `<div class="tip-head">${r.year} · ${k === 'quali' ? 'Pole lap' : 'Fastest race lap'}</div><div class="tip-row"><i style="background:${colors[ci]}"></i><span>${r[k + 'Who'] || ''}</span><b>${fmt(r[k])}</b></div>`;
          tip.hidden = false;
          const rect = svg.getBoundingClientRect();
          tip.style.left = `${Math.min(wrap.clientWidth - 200, (x(r[k]) / W) * rect.width + 12)}px`;
          tip.style.top = `${(cy / H) * rect.height - 10}px`;
          c.setAttribute('r', 8);
        });
        hit.addEventListener('pointerleave', () => { tip.hidden = true; c.setAttribute('r', 6); });
      });
    });
  };
  draw();
  new ResizeObserver(draw).observe(wrap);
}
