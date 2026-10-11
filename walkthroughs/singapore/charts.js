// Small hand-rolled SVG charts (no chart library).
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

/**
 * Speed-vs-distance trace for one or more laps, with sector bands, corner ticks,
 * a gear strip and a crosshair tooltip. onHover(distance|null) syncs the 3D cursor.
 */
export function speedTrace(host, { series, sectors, corners, length, sectorColors, onHover }) {
  host.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  host.appendChild(wrap);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  wrap.appendChild(tip);

  let W = 0;
  const H = 300, GH = 46, M = { l: 44, r: 14, t: 30, b: 26 };
  const svg = el('svg', { role: 'img', 'aria-label': 'Speed trace by distance for pole laps' }, wrap);

  function draw() {
    W = Math.max(320, wrap.clientWidth);
    svg.setAttribute('viewBox', `0 0 ${W} ${H + GH}`);
    svg.innerHTML = '';
    const x = (d) => M.l + (d / length) * (W - M.l - M.r);
    const y = (v) => M.t + (1 - v / 340) * (H - M.t - M.b);

    // sector bands
    const bounds = [0, ...sectors, length];
    for (let s = 0; s < 3; s++) {
      el('rect', { x: x(bounds[s]), y: M.t, width: x(bounds[s + 1]) - x(bounds[s]), height: H - M.t - M.b, fill: sectorColors[s], opacity: 0.07 }, svg);
      const t = el('text', { x: x(bounds[s]) + 6, y: M.t + 14, class: 'chart-sector' }, svg);
      t.textContent = `S${s + 1}`;
    }
    // grid
    for (let v = 0; v <= 300; v += 100) {
      el('line', { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: 'chart-grid' }, svg);
      const t = el('text', { x: M.l - 8, y: y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' }, svg);
      t.textContent = v;
    }
    const unit = el('text', { x: M.l - 8, y: M.t - 12, class: 'chart-axis', 'text-anchor': 'end' }, svg);
    unit.textContent = 'km/h';
    // distance ticks
    for (let d = 0; d <= length; d += 1000) {
      const t = el('text', { x: x(d), y: H - 6, class: 'chart-axis', 'text-anchor': 'middle' }, svg);
      t.textContent = d === 0 ? '0 km' : `${d / 1000}`;
    }
    // corner ticks
    for (const c of corners) {
      el('line', { x1: x(c.d), x2: x(c.d), y1: M.t, y2: H - M.b, class: 'chart-corner' }, svg);
      const t = el('text', { x: x(c.d), y: M.t - 8, class: 'chart-corner-num', 'text-anchor': 'middle' }, svg);
      t.textContent = c.number;
    }
    // series
    for (const s of series) {
      const dpath = s.rows.map((r, i) => `${i ? 'L' : 'M'}${x(Math.max(0, Math.min(length, r[1]))).toFixed(1)},${y(r[2]).toFixed(1)}`).join('');
      el('path', { d: dpath, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    }
    // gear strip (first series)
    const gy0 = H + 4;
    const gTitle = el('text', { x: M.l - 8, y: gy0 + GH / 2 + 4, class: 'chart-axis', 'text-anchor': 'end' }, svg);
    gTitle.textContent = 'gear';
    const g = series[0];
    for (let i = 0; i < g.rows.length - 1; i++) {
      const r = g.rows[i], n = g.rows[i + 1];
      const gear = r[3];
      el('rect', { x: x(Math.max(0, r[1])), y: gy0 + (GH - 8) * (1 - gear / 8), width: Math.max(0.5, x(n[1]) - x(r[1])), height: Math.max(2, ((GH - 8) * gear) / 8), fill: g.color, opacity: 0.2 + gear * 0.09 }, svg);
    }
    cross = el('line', { y1: M.t, y2: H + GH, class: 'chart-cross', visibility: 'hidden' }, svg);
    dots = series.map((s) => el('circle', { r: 4.5, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' }, svg));
    // hit layer
    const hit = el('rect', { x: M.l, y: 0, width: W - M.l - M.r, height: H + GH, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const d = Math.max(0, Math.min(length, ((px - M.l) / (W - M.l - M.r)) * length));
      show(d);
      onHover?.(d);
    });
    hit.addEventListener('pointerleave', () => { hide(); onHover?.(null); });
    xFn = x; yFn = y;
  }
  let cross, dots, xFn, yFn;

  function nearest(rows, d) {
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m][1] < d) lo = m; else hi = m; }
    return Math.abs(rows[lo][1] - d) < Math.abs(rows[hi][1] - d) ? rows[lo] : rows[hi];
  }
  function show(d, fromOutside = false) {
    const px = xFn(d);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    const lines = series.map((s, i) => {
      const r = nearest(s.rows, d);
      dots[i].setAttribute('cx', xFn(r[1])); dots[i].setAttribute('cy', yFn(r[2])); dots[i].setAttribute('visibility', 'visible');
      return `<div class="tip-row"><i style="background:${s.color}"></i><span>${s.label}</span><b>${Math.round(r[2])} km/h</b><em>G${r[3]}${r[5] ? ' · brake' : r[4] > 95 ? ' · full' : ''}</em></div>`;
    });
    const near = corners.reduce((a, c) => (Math.abs(c.d - d) < Math.abs(a.d - d) ? c : a));
    tip.innerHTML = `<div class="tip-head">${(d / 1000).toFixed(2)} km${Math.abs(near.d - d) < 70 ? ` · Turn ${near.number}` : ''}</div>${lines.join('')}`;
    tip.hidden = false;
    const left = (px / W) * wrap.clientWidth;
    tip.style.left = `${Math.min(wrap.clientWidth - tip.offsetWidth - 4, Math.max(4, left + 14))}px`;
    tip.classList.toggle('passive', fromOutside);
  }
  function hide() {
    tip.hidden = true;
    cross?.setAttribute('visibility', 'hidden');
    dots?.forEach((d) => d.setAttribute('visibility', 'hidden'));
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
      const t = el('text', { x: x(v), y: H - 10, class: 'chart-axis', 'text-anchor': 'middle' }, svg);
      t.textContent = fmt(v).replace(/\.000$/, '');
    }
    rows.forEach((r, i) => {
      const cy = M.t + i * RH + RH / 2;
      const t = el('text', { x: M.l - 10, y: cy + 4, class: 'chart-axis strong', 'text-anchor': 'end' }, svg);
      t.textContent = r.year;
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
