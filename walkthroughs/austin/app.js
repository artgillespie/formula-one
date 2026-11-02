import { createScene, SECTOR_GLOW } from './scene.js';
import { lapChart, evolutionChart } from './charts.js';
import { OPENF1, fetchSessionSummary, fmtLap, fmtDuration } from './stats.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SECTOR_INK = ['var(--s1)', 'var(--s2)', 'var(--s3)'];
const LAP_KEYS = ['q2026', 'q2025', 'q2024'];
const yr = (k) => k.slice(1);

async function getJSON(url, optional = false) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } catch (e) {
    if (optional) return null;
    throw e;
  }
}

const [track, city, snapshot, research, photos, terrainBuf] = await Promise.all([
  getJSON('data/track.json'),
  getJSON('data/city.json'),
  getJSON('data/sessions.json'),
  getJSON('data/research.json', true),
  getJSON('data/photos.json', true),
  fetch('data/terrain.bin').then((r) => r.arrayBuffer()),
]);

const R = research || { circuit: {}, corners: [], timeline: [], records: {} };
const cornerInfo = new Map((R.corners || []).map((c) => [c.number, c]));
const cornerPhotos = photos?.corners || {};
const laps = LAP_KEYS.map((k) => ({ key: k, ...track.laps[k] }));
const lapColour = (k) => track.laps[k].driver.colour;
const lapLabel = (k) => `${yr(k)} ${track.laps[k].driver.code}`;

// ---------------------------------------------------------------- derived numbers (all measured from the data)
const N = track.line.length, STEP = track.step_m;
const zAt = (i) => track.line[((i % N) + N) % N][2];
const gradeAt = (i, half = 5) => (zAt(i + half) - zAt(i - half)) / (2 * half * STEP);
const T1 = track.corners.find((c) => c.number === 1);
const climb = (() => {
  // the run from the lowest point before Turn 1 up to the Turn 1 apex
  const iT1 = Math.round(T1.d / STEP);
  let iLow = 0;
  for (let i = -Math.round(900 / STEP); i <= iT1; i++) if (zAt(i) < zAt(iLow)) iLow = i;
  let maxG = 0, maxGi = 0;
  for (let i = iLow; i <= iT1; i++) { const g = gradeAt(i); if (g > maxG) (maxG = g), (maxGi = i); }
  return { rise: zAt(iT1) - zAt(iLow), run: (iT1 - iLow) * STEP, maxG, maxGd: maxGi * STEP };
})();
const zs = track.line.map((p) => p[2]);
const relief = Math.max(...zs) - Math.min(...zs);
const topSpeed = Object.fromEntries(LAP_KEYS.map((k) => [k, Math.max(...track.laps[k].rows.map((r) => r[2]))]));
$('#sub').textContent = `Austin, Texas · ${Math.round(relief)} m of climb on one lap, ${track.corners.length} corners, one hill`;

// ---------------------------------------------------------------- masthead facts
{
  const c = R.circuit;
  const last = (s) => s.split(' ').at(-1);
  const facts = [
    ['Length', `${(c.officialLength_km || 5.513).toFixed(3)} km`],
    ['Corners', track.corners.length],
    ['Laps', c.laps || 56],
    ['Climb to T1', `${Math.round(climb.rise)} m · ${Math.round(climb.maxG * 100)}%`],
    ['Race lap record', c.lapRecord ? `${c.lapRecord.time} · ${last(c.lapRecord.driver)} ${c.lapRecord.year}` : '—'],
    ['Fastest ever', c.allTimeFastestLap ? `${c.allTimeFastestLap.time} · ${last(c.allTimeFastestLap.driver)} ${c.allTimeFastestLap.year}` : '—'],
  ];
  $('#facts').innerHTML = facts.map(([k, v]) => `<li>${esc(k)}<b>${esc(v)}</b></li>`).join('');
}

// ---------------------------------------------------------------- 3D scene
// 2026 Straight Mode zones, parsed from research text ("… about 110 m after T11 … to T12 …")
const zones = (R.circuit?.overtakeModeZones?.straightModeZones || []).map((z) => {
  const after = z.location.match(/after T(\d+)/);
  const until = z.location.match(/to (?:the )?T(\d+)/);
  if (!after || !until) return null;
  const off = +(z.location.match(/about (\d+) m/)?.[1] || 0);
  const ca = track.corners.find((c) => c.number === +after[1]);
  const cb = track.corners.find((c) => c.number === +until[1]);
  return ca && cb ? { from: ca.d + off, to: cb.d - 140 } : null;
}).filter(Boolean);

let scene = null;
try {
  scene = await createScene($('#canvas'), { track, city, terrainBuf, zones });
} catch (e) {
  console.error(e);
  $('#canvas').innerHTML = `<p style="padding:120px 24px;color:#aaa">3D view unavailable on this device (${esc(e.message)}). The rest of the walkthrough is below.</p>`;
}
requestAnimationFrame(() => setTimeout(() => $('#loader').classList.add('done'), 350));
if (location.hash === '#debug') window.__scene = scene;

// ---------------------------------------------------------------- corner strip
const strip = $('#strip');
{
  let lastSector = 0;
  for (const c of track.corners) {
    if (c.sector !== lastSector) {
      const s = document.createElement('span');
      s.className = 'sep';
      s.style.setProperty('--c', SECTOR_GLOW[c.sector - 1]);
      s.textContent = `S${c.sector}`;
      strip.appendChild(s);
      lastSector = c.sector;
    }
    const b = document.createElement('button');
    b.textContent = c.number;
    b.dataset.sector = c.sector;
    b.dataset.n = c.number;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', 'false');
    const info = cornerInfo.get(c.number);
    b.title = `Turn ${c.number}${info?.name ? ` · ${info.name}` : ''}`;
    b.addEventListener('click', () => selectCorner(c.number));
    strip.appendChild(b);
  }
}

// ---------------------------------------------------------------- corner panel
const panel = $('#panel');
let current = null;
let view = 'orbit';
const NC = track.corners.length;

function speedTile(k, st) {
  if (!st) return '';
  return `<div class="tile" style="--c:${lapColour(k)}"><span>Apex · ${yr(k)}</span><b>${st.minSpeed}</b><em>km/h · G${st.gear} · ${esc(track.laps[k].driver.code)}</em></div>`;
}
function closePanel() {
  panel.hidden = true;
  $('#stage').classList.remove('focused');
  current = null;
  strip.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', 'false'));
}

function selectCorner(n, { fly = true } = {}) {
  const c = track.corners.find((x) => x.number === n);
  if (!c) return;
  current = n;
  if (scene?.isPlaying()) stopLap();
  strip.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(+b.dataset.n === n)));
  strip.querySelector(`[data-n="${n}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  if (fly) scene?.focusCorner(n, view);

  const info = cornerInfo.get(n) || {};
  const s = c.stats;
  const pics = cornerPhotos[n] || [];
  const dirArrow = c.dir === 'left' ? '↰ Left' : '↱ Right';
  const i = Math.round(c.d / STEP);
  const g = gradeAt(i, 8);
  const gTxt = Math.abs(g) < 0.01 ? 'level' : `${g > 0 ? '▲' : '▼'} ${Math.abs(g * 100).toFixed(1)}%`;
  panel.innerHTML = `
    <div class="cp-top">
      <div class="cp-num"><small>TURN</small>${n}</div>
      <button class="cp-close" aria-label="Close">×</button>
    </div>
    ${info.name ? `<p class="cp-name">${esc(info.name)}</p>` : ''}
    <p class="cp-street">${esc(info.location || '')}</p>
    <div class="chips">
      <span class="tag s${c.sector}">SECTOR ${c.sector}</span>
      <span class="tag">${dirArrow} · ${Math.abs(c.headingChange)}°</span>
      <span class="tag">${(c.d / 1000).toFixed(2)} km into lap</span>
      <span class="tag">${Math.round(c.elev)} m · ${gTxt}</span>
      ${s.q2026?.braking ? '<span class="tag">BRAKING</span>' : '<span class="tag">FLAT / LIFT</span>'}
    </div>
    <div class="tiles">
      ${LAP_KEYS.map((k) => speedTile(k, s[k])).join('')}
    </div>
    ${s.q2026 ? `<p class="cp-flow">2026 pole lap: <b>${s.q2026.entrySpeed}</b> km/h in → <b>${s.q2026.minSpeed}</b> at the apex → <b>${s.q2026.exitSpeed}</b> out</p>` : ''}
    ${info.type ? `<p class="cp-desc"><span class="cp-type">${esc(info.type)}.</span> ${esc(info.description || '')}</p>` : ''}
    ${info.landmarks?.length ? `<p class="cp-land"><b>What the driver sees:</b> ${info.landmarks.map(esc).join(' · ')}</p>` : ''}
    <div class="cp-actions">
      <button class="btn chip ${view === 'driver' ? 'on' : ''}" data-view="driver">👁 Driver's-eye approach</button>
      <button class="btn chip ${view === 'orbit' ? 'on' : ''}" data-view="orbit">⤢ Overhead</button>
      <button class="btn chip" data-nav="-1">‹ Prev</button>
      <button class="btn chip" data-nav="1">Next ›</button>
    </div>
    <div class="gallery">
      ${pics.length
        ? pics.map((p, k) => `<button class="${k === 0 ? 'first' : ''}" data-i="${k}" data-cap="${esc(p.landmark || '')}"><img src="${esc(p.file)}" alt="${esc(p.caption || p.landmark || '')}" loading="lazy" /></button>`).join('')
        : '<p class="no-photo">No freely licensed photo of this corner found yet.</p>'}
    </div>`;
  panel.hidden = false;
  panel.scrollTop = 0;
  $('#stage').classList.add('focused');
  panel.querySelector('.cp-close').onclick = () => { closePanel(); scene?.overview(); };
  panel.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => { view = b.dataset.view; selectCorner(n); }));
  panel.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => selectCorner(((n - 1 + +b.dataset.nav + NC) % NC) + 1)));
  panel.querySelectorAll('.gallery button').forEach((b) => (b.onclick = () => openLightbox(pics, +b.dataset.i)));
}
scene?.onCornerClick((n) => selectCorner(n));

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || $('#lightbox').open) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const d = e.key === 'ArrowRight' ? 1 : -1;
    selectCorner(current ? ((current - 1 + d + NC) % NC) + 1 : 1);
  } else if (e.key === 'Escape') {
    closePanel();
    stopLap();
    scene?.overview();
  }
});

// ---------------------------------------------------------------- lightbox
const lb = $('#lightbox');
let lbPics = [], lbI = 0;
function renderLb() {
  const p = lbPics[lbI];
  lb.querySelector('img').src = p.file;
  lb.querySelector('img').alt = p.caption || '';
  lb.querySelector('figcaption').innerHTML = `${esc(p.caption || '')}<small>📷 ${esc(p.author || 'Unknown')} · <a href="${esc(p.licenseUrl || '#')}" target="_blank" rel="noopener">${esc(p.license || '')}</a> · <a href="${esc(p.sourceUrl || '#')}" target="_blank" rel="noopener">source</a></small>`;
  lb.querySelectorAll('.lb-nav').forEach((b) => (b.hidden = lbPics.length < 2));
}
function openLightbox(pics, i) { lbPics = pics; lbI = i; renderLb(); lb.showModal(); }
lb.querySelector('.lb-close').onclick = () => lb.close();
lb.querySelector('.prev').onclick = () => { lbI = (lbI - 1 + lbPics.length) % lbPics.length; renderLb(); };
lb.querySelector('.next').onclick = () => { lbI = (lbI + 1) % lbPics.length; renderLb(); };
lb.addEventListener('click', (e) => { if (e.target === lb || e.target.tagName === 'FIGURE') lb.close(); });
lb.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') lb.querySelector('.next').click(); if (e.key === 'ArrowLeft') lb.querySelector('.prev').click(); });

// ---------------------------------------------------------------- dock controls
$('#lapSel').innerHTML = LAP_KEYS.map((k) => `<option value="${k}">${yr(k)} · ${esc(track.laps[k].driver.name.split(' ').at(-1))} ${fmtLap(track.laps[k].lapTime)}</option>`).join('');
const ghostOptions = () => {
  const main = $('#lapSel').value;
  const prev = $('#ghostSel').value;
  $('#ghostSel').innerHTML = `<option value="">No ghost</option>` + LAP_KEYS.filter((k) => k !== main).map((k) => `<option value="${k}">vs ${yr(k)} ${esc(track.laps[k].driver.code)} (ghost)</option>`).join('');
  $('#ghostSel').value = prev && prev !== main ? prev : LAP_KEYS.find((k) => k !== main);
};
ghostOptions();

$('#btnOverview').onclick = () => { stopLap(); closePanel(); scene?.overview(); };
const hud = $('#hud');
let cam = 'chase';
function startLap() {
  const key = $('#lapSel').value;
  const ghost = $('#ghostSel').value || null;
  panel.hidden = true;
  $('#stage').classList.add('focused');
  scene?.playLap(key, { cam, rate: +$('#rateSel').value, ghost });
  $('#btnPlay').textContent = '■ Stop';
  $('#stage').classList.add('playing');
  $('#camSeg').hidden = false;
  hud.hidden = false;
  $('#hudWho').textContent = track.laps[key].driver.session;
  $('#hudGapBox').hidden = !ghost;
  if (ghost) {
    $('#hudGapWho').textContent = `vs ${track.laps[ghost].driver.code} ${yr(ghost)}`;
    $('#hudGapWho').style.color = lapColour(ghost);
  }
}
function stopLap() {
  scene?.stopLap();
  $('#btnPlay').textContent = '▶ Ride the pole lap';
  $('#stage').classList.remove('playing');
  $('#camSeg').hidden = true;
  hud.hidden = true;
  if (panel.hidden) $('#stage').classList.remove('focused');
}
$('#btnPlay').onclick = () => (scene?.isPlaying() ? (stopLap(), scene.overview()) : startLap());
$('#lapSel').onchange = () => { ghostOptions(); if (scene?.isPlaying()) startLap(); };
$('#ghostSel').onchange = () => { if (scene?.isPlaying()) startLap(); };
$('#rateSel').onchange = (e) => scene?.setRate(+e.target.value);
$('#camSeg').querySelectorAll('[data-cam]').forEach((b) => (b.onclick = () => {
  cam = b.dataset.cam;
  $('#camSeg').querySelectorAll('[data-cam]').forEach((x) => x.classList.toggle('on', x === b));
  scene?.setCam(cam);
}));
const LEGENDS = {
  speed: '<span>70</span><i class="spd"></i><span>340 km/h · 2026 pole</span>',
  grade: '<span>▼ 8% downhill</span><i class="grd"></i><span>8% uphill ▲</span>',
};
document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
  scene?.setMode(b.dataset.mode);
  const lg = LEGENDS[b.dataset.mode];
  $('#lineLegend').hidden = !lg;
  if (lg) $('#lineLegend').innerHTML = lg;
}));
const fmtClock = (h) => { const hh = Math.floor(h), mm = Math.round((h - hh) * 60) % 60; const H = ((hh + 11) % 12) + 1; return `${H}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'pm' : 'am'}`; };
$('#sunRange').oninput = (e) => {
  const h = +e.target.value;
  scene?.setTimeOfDay(h);
  $('#sunOut').textContent = Math.abs(h - 15) < 0.03 ? '3:00 pm · lights out' : fmtClock(h);
};
$('#sunOut').textContent = '3:00 pm · lights out';
$('#layBuildings').onchange = (e) => scene?.setLayer('buildings', e.target.checked);
$('#layLabels').onchange = (e) => scene?.setLayer('labels', e.target.checked);
$('#layLine').onchange = (e) => scene?.setLayer('line', e.target.checked);
$('#layZones').onchange = (e) => scene?.setLayer('zones', e.target.checked);
$('#zoneLink')?.addEventListener('click', (e) => { e.preventDefault(); $('#layZones').checked = true; scene?.setLayer('zones', true); stopLap(); closePanel(); scene?.overview(); $('#stage').scrollIntoView({ behavior: 'smooth' }); });

let traceChart = null;
scene?.onTick((s) => {
  $('#hudSpeed').textContent = Math.round(s.speed);
  $('#hudGear').textContent = s.gear || 'N';
  $('#hudThr').style.width = `${Math.max(0, Math.min(100, s.throttle))}%`;
  $('#hudBrk').style.width = s.brake ? '100%' : '0%';
  const t = Math.max(0, Math.min(s.lapTime, s.t));
  $('#hudClock').textContent = `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`;
  $('#hudAlt').textContent = `${Math.round(s.alt)} m`;
  $('#hudGrade').textContent = Math.abs(s.grade) < 0.01 ? '' : `${s.grade > 0 ? '▲' : '▼'}${Math.abs(s.grade * 100).toFixed(0)}%`;
  const sc = $('#hudSector');
  sc.textContent = `SECTOR ${s.sector}`;
  sc.style.color = SECTOR_GLOW[s.sector - 1];
  if (s.gap != null) {
    const g = $('#hudGap');
    g.textContent = `${s.gap > 0 ? '+' : s.gap < 0 ? '−' : ''}${Math.abs(s.gap).toFixed(3)}`;
    g.className = s.gap > 0.0005 ? 'slower' : s.gap < -0.0005 ? 'faster' : '';
  }
  traceChart?.show(Math.max(0, Math.min(track.length_m, s.d)));
});

if (scene) new IntersectionObserver(([e]) => (e.isIntersecting ? scene.resume() : scene.pause())).observe($('#stage'));

// ---------------------------------------------------------------- telemetry section
{
  const [a, b] = [track.laps.q2026, track.laps.q2025];
  const lowGear = track.corners.filter((c) => c.stats.q2026?.gear === 1).map((c) => `T${c.number}`);
  const secD = a.sectorTimes.map((v, i) => v - b.sectorTimes[i]);
  const worst = secD.indexOf(Math.max(...secD));
  const cards = [
    ['Top speed', `${topSpeed.q2026} km/h`, `2026 pole lap, on the back straight. The 2025 pole lap peaked at ${topSpeed.q2025} km/h. Straight Mode flattens both wings on the straights.`],
    ['The climb to Turn 1', `${Math.round(climb.rise)} m in ${Math.round(climb.run)} m`, `Measured from USGS ground elevation under the centreline. Steepest stretch: ${Math.round(climb.maxG * 100)}% over 30 m; the figure usually quoted is 11%. The lap's lowest and highest points are ${Math.round(relief)} m apart.`],
    ['2026 vs 2025 pole', `+${(a.lapTime - b.lapTime).toFixed(3)} s`, `${['Sector 1', 'Sector 2', 'Sector 3'][worst]} cost the most: +${secD[worst].toFixed(3)} s. By sector: ${secD.map((v) => `${v > 0 ? '+' : ''}${v.toFixed(3)}`).join(' / ')}.`],
    ['First gear is back', lowGear.length ? lowGear.join(' · ') : '—', `The 2026 pole lap drops to first gear at ${lowGear.length} hairpins. The 2025 and 2024 pole laps never went below third here.`],
  ];
  $('#insights').innerHTML = cards.map(([k, v, p]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b><p>${esc(p)}</p></div>`).join('');

  const series = laps.map((l) => ({ rows: l.rows, color: l.driver.colour, label: lapLabel(l.key) }));
  $('#traceLegend').innerHTML = laps.map((l) => `<span><i style="background:${l.driver.colour}"></i>${esc(l.driver.name)} · ${esc(l.driver.session)} · ${fmtLap(l.lapTime)}</span>`).join('');
  const elevation = [];
  for (let i = 0; i < N; i += 2) elevation.push([i * STEP, zAt(i)]);
  elevation.push([track.length_m, zAt(0)]);
  traceChart = lapChart($('#trace'), {
    series, sectors: track.sectors, corners: track.corners, length: track.length_m,
    sectorColors: ['#e8405f', '#2f8fd0', '#b08a1e'], elevation, datum: track.datum_m,
    onHover: (d) => scene?.setCursor(d),
  });

  const sectorsR = R.sectors || [];
  const cornersIn = (s) => track.corners.filter((c) => c.sector === s).map((c) => c.number);
  $('#sectorCards').innerHTML = [1, 2, 3].map((s) => {
    const cs = cornersIn(s);
    const ch = sectorsR.find((x) => x.n === s)?.character || '';
    const best = Math.min(...laps.map((l) => l.sectorTimes[s - 1]));
    return `<div class="sector-card" style="--c:${SECTOR_INK[s - 1]}">
      <h3>Sector ${s} <small style="color:var(--ink-3);font-weight:400">· Turns ${cs[0]}–${cs.at(-1)}</small></h3>
      <div class="times">${laps.map((l) => `<span>${yr(l.key)} <b class="${l.sectorTimes[s - 1] === best ? 'best' : ''}">${l.sectorTimes[s - 1].toFixed(3)}</b></span>`).join('')}</div>
      <p>${esc(ch)}</p></div>`;
  }).join('');

  const cell = (st, k) => `<td class="num">${st?.[k] ?? '—'}</td>`;
  const rows = track.corners.map((c) => {
    const info = cornerInfo.get(c.number) || {};
    const s = c.stats;
    return `<tr data-n="${c.number}">
      <td><span class="sbar" style="--c:${SECTOR_INK[c.sector - 1]}"></span><b>T${c.number}</b></td>
      <td>${esc(info.name || '—')}</td>
      <td>${c.dir === 'left' ? 'L' : 'R'}</td>
      <td class="num">${Math.round(c.elev)}</td>
      ${LAP_KEYS.map((k) => `${cell(s[k], 'gear')}${cell(s[k], 'minSpeed')}`).join('')}
      <td class="num">${s.q2026?.entrySpeed ?? '—'} → ${s.q2026?.exitSpeed ?? '—'}</td>
      <td>${esc(info.type || '')}</td></tr>`;
  }).join('');
  $('#cornerTable').innerHTML = `<thead><tr><th>Turn</th><th>Name</th><th>Dir</th><th class="num">Alt m</th>${LAP_KEYS.map((k) => `<th class="num">Gear '${yr(k).slice(2)}</th><th class="num">Apex '${yr(k).slice(2)}</th>`).join('')}<th class="num">In → out '26</th><th>Type</th></tr></thead><tbody>${rows}</tbody>`;
  $('#cornerTable').querySelectorAll('tbody tr').forEach((tr) => (tr.onclick = () => { $('#stage').scrollIntoView({ behavior: 'smooth' }); selectCorner(+tr.dataset.n); }));
}

// ---------------------------------------------------------------- times section
let sessions = snapshot.sessions.slice();
let activeYear = null;

function sessionCard(s, live) {
  const isQ = s.kind === 'quali';
  const winner = s.results[0];
  const sec = s.sectors.map((x, i) => x ? `<tr><td><span class="sbar" style="--c:${SECTOR_INK[i]}"></span>S${i + 1}</td><td class="num">${x.best.toFixed(3)}</td><td>${esc(x.driver.code)}</td><td class="num">${x.avg?.toFixed(3) ?? '—'}</td></tr>` : '').join('');
  const res = s.results.map((r) => `<tr><td class="num">${r.pos}</td><td><span class="team-dot" style="background:${esc(r.colour)}"></span> ${esc(r.name)}</td><td>${esc(r.team)}</td><td class="num">${r.pos === 1 ? (isQ ? fmtLap(r.time) : fmtDuration(r.time)) : r.gap == null ? '' : typeof r.gap === 'number' ? `+${r.gap.toFixed(3)}` : esc(r.gap)}</td></tr>`).join('');
  return `<article class="session ${isQ ? 'quali' : 'race'}">
    <h3><span>${s.year} ${esc(s.name)}</span>${live ? '<span class="badge">● live update</span>' : ''}</h3>
    <div class="hero-time">${fmtLap(s.fastest.time)}</div>
    <div class="hero-who"><span class="team-dot" style="background:${esc(s.fastest.driver.colour)}"></span>${isQ ? 'Fastest lap' : 'Fastest race lap'} · ${esc(s.fastest.driver.name)} · ${esc(s.fastest.driver.team)}${isQ ? '' : ` · lap ${s.fastest.lap}`}</div>
    <dl class="kv">
      ${!isQ && winner ? `<dt>Winner</dt><dd>${esc(winner.name)} <small>${fmtDuration(winner.time)}</small></dd>` : ''}
      ${isQ && winner ? `<dt>Pole</dt><dd>${esc(winner.name)} <small>${fmtLap(winner.time)}</small></dd>` : ''}
      <dt>Ideal lap <small>(best sectors)</small></dt><dd>${fmtLap(s.ideal)}</dd>
      <dt>Average lap <small>(${esc(s.avgLapNote)})</small></dt><dd>${fmtLap(s.avgLap)}</dd>
      ${s.topSpeed ? `<dt>Speed trap</dt><dd>${s.topSpeed.kph} km/h <small>${esc(s.topSpeed.driver.code)}</small></dd>` : ''}
    </dl>
    <table><thead><tr><th>Sector</th><th class="num">Best</th><th>By</th><th class="num">${isQ ? 'Avg top-10' : 'Median'}</th></tr></thead><tbody>${sec}</tbody></table>
    ${res ? `<details><summary>Top 10 classification</summary><table><tbody>${res}</tbody></table></details>` : ''}
  </article>`;
}

const liveKeys = new Set();
function renderTimes() {
  const years = [...new Set(sessions.map((s) => s.year))].sort((a, b) => b - a);
  if (!activeYear || !years.includes(activeYear)) activeYear = years[0];
  $('#yearTabs').innerHTML = years.map((y) => `<button role="tab" aria-selected="${y === activeYear}" data-y="${y}">${y}</button>`).join('');
  $('#yearTabs').querySelectorAll('button').forEach((b) => (b.onclick = () => { activeYear = +b.dataset.y; renderTimes(); }));
  const order = ['Qualifying', 'Race', 'Sprint Qualifying', 'Sprint Shootout', 'Sprint'];
  const list = sessions.filter((s) => s.year === activeYear).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  $('#sessionGrid').innerHTML = list.map((s) => sessionCard(s, liveKeys.has(s.key))).join('');

  const evoRows = years.slice().reverse().map((y) => {
    const q = sessions.find((s) => s.year === y && s.name === 'Qualifying');
    const r = sessions.find((s) => s.year === y && s.name === 'Race');
    return { year: y, quali: q?.fastest.time, race: r?.fastest.time, qualiWho: q?.fastest.driver.name, raceWho: r?.fastest.driver.name };
  });
  $('#evoLegend').innerHTML = `<span><i class="dot" style="background:var(--quali)"></i>Pole lap</span><span><i class="dot" style="background:var(--race)"></i>Fastest race lap</span>`;
  evolutionChart($('#evo'), evoRows, { colors: ['#2f8fd0', '#b08a1e'], fmt: fmtLap });
}
renderTimes();

// ---------------------------------------------------------------- live refresh from OpenF1
const live = $('#live');
const setLive = (state, text) => { live.className = `live ${state}`; live.querySelector('.txt').textContent = text; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url);
    if (r.status === 429) { await sleep(1200 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }
  throw new Error('rate limited');
}

async function refreshLive() {
  try {
    const all = await fetchJson(`${OPENF1}/sessions?circuit_short_name=Austin`);
    const now = Date.now();
    const relevant = all.filter((s) => /Qualifying|Race|Sprint|Shootout/.test(s.session_name) && s.year >= 2023);
    const started = relevant.filter((s) => Date.parse(s.date_start) <= now);
    const inProgress = started.filter((s) => Date.parse(s.date_end) + 30 * 60e3 > now);
    const known = new Set(sessions.map((s) => s.key));
    const todo = started.filter((s) => !known.has(s.session_key) || inProgress.includes(s));
    let added = 0;
    for (const s of todo) {
      const sum = await fetchSessionSummary(s, fetchJson).catch(() => null);
      await sleep(400);
      if (!sum) continue;
      sessions = sessions.filter((x) => x.key !== sum.key).concat(sum);
      liveKeys.add(sum.key);
      added++;
    }
    if (added) { activeYear = null; renderTimes(); }

    const latest = started.sort((a, b) => b.date_start.localeCompare(a.date_start))[0];
    const next = relevant.filter((s) => Date.parse(s.date_start) > now).sort((a, b) => a.date_start.localeCompare(b.date_start))[0];
    let wx = '';
    if (latest) {
      const w = await fetchJson(`${OPENF1}/weather?session_key=${latest.session_key}`).catch(() => []);
      const last = w.at(-1);
      if (last) wx = ` · ${latest.year} ${latest.session_name}: air ${last.air_temperature}°C, track ${last.track_temperature}°C, humidity ${Math.round(last.humidity)}%${last.rainfall ? ', rain' : ''}`;
    }
    if (inProgress.length) {
      setLive('on', `${inProgress[0].session_name} in progress, refreshing every 60 s${wx}`);
      setTimeout(refreshLive, 60e3);
    } else {
      const nx = next ? ` · Next: ${next.year} ${next.session_name}, ${new Date(next.date_start).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : '';
      setLive('ok', `OpenF1 live${added ? `, ${added} new session${added > 1 ? 's' : ''}` : ''}${wx}${nx}`);
    }
  } catch (e) {
    setLive('', `Offline snapshot (${new Date(snapshot.generated).toLocaleDateString()})`);
  }
}
refreshLive();

// ---------------------------------------------------------------- 2026 aero zones
{
  const om = R.circuit?.overtakeModeZones;
  if (om) {
    $('#aeroLede').textContent = om.summary || '';
    $('#zones').innerHTML = (om.straightModeZones || []).map((z) => `<li>${esc(z.location)}</li>`).join('') +
      (om.overtakeMode ? `<li class="om">Detection: ${esc(om.overtakeMode.detectionPoint)}. Activation: ${esc(om.overtakeMode.activationPoint)}. ${esc(om.overtakeMode.rule)}</li>` : '') +
      (om.uncertain ? `<li class="note">Zone end points are inferred; the FIA's zone map was not available to us. Zones normally run to the next braking point.</li>` : '');
  } else $('#aero').hidden = true;
}

// ---------------------------------------------------------------- timeline & records
{
  const tl = R.timeline || [];
  const tags = ['all', ...new Set(tl.map((t) => t.tag))];
  let tag = 'all';
  const draw = () => {
    $('#tagTabs').innerHTML = tags.map((t) => `<button aria-selected="${t === tag}" data-t="${t}">${t === 'all' ? 'Everything' : t[0].toUpperCase() + t.slice(1)}</button>`).join('');
    $('#tagTabs').querySelectorAll('button').forEach((b) => (b.onclick = () => { tag = b.dataset.t; draw(); }));
    let lastY = null;
    $('#timeline').innerHTML = tl.filter((t) => tag === 'all' || t.tag === tag).map((t) => {
      const first = t.year !== lastY;
      lastY = t.year;
      const when = t.date && /\d{4}-\d{2}-\d{2}/.test(t.date) ? new Date(`${t.date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : t.year;
      return `<li class="${first ? 'y-first' : ''}"><span class="when">${esc(when)}</span><span class="ttag">${esc(t.tag)}</span><h4>${esc(t.title)}</h4><p>${esc(t.text)}${t.uncertain ? ' <span class="unc">(details uncertain)</span>' : ''}</p></li>`;
    }).join('');
  };
  draw();
  const rec = R.records || {};
  const cards = [];
  if (rec.mostWins_driver) cards.push(['Most wins at COTA', `${rec.mostWins_driver.driver} · ${rec.mostWins_driver.wins}`, `${(rec.mostWins_driver.years || []).join(', ')}. ${rec.mostWins_driver.runnerUp ? `Next: ${rec.mostWins_driver.runnerUp}.` : ''}`]);
  if (rec.mostPoles) cards.push(['Most poles', `${(rec.mostPoles.drivers || []).join(' & ')} · ${rec.mostPoles.poles}`, rec.mostPoles.detail || '']);
  if (rec.mostWins_team) cards.push(['Most team wins', `${(rec.mostWins_team.teams || []).join(' & ')} · ${rec.mostWins_team.wins}`, rec.mostWins_team.detail || '']);
  const wy = rec.winnersByYear || {};
  const lastYear = Object.keys(wy).sort().at(-1);
  if (lastYear) cards.push([`${lastYear} winner`, wy[lastYear].replace(/ \(.*\)/, ''), `${wy[lastYear].match(/\((.*)\)/)?.[1] || ''}. Pole: ${laps[0].driver.name}, ${fmtLap(laps[0].lapTime)}.`]);
  $('#records').innerHTML = cards.map(([k, v, p]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b><p>${esc(p)}</p></div>`).join('');
}

// ---------------------------------------------------------------- credits
{
  const all = Object.values(cornerPhotos).flat();
  const seen = new Map();
  for (const p of all) if (!seen.has(p.file)) seen.set(p.file, p);
  if (seen.size) {
    $('#photoCredits').innerHTML = `Photographs (rehosted under their licences):<ul class="photo-credit-list">${[...seen.values()].map((p) => `<li><a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">${esc(p.landmark || p.caption || p.file)}</a> by ${esc(p.author || 'unknown')}, <a href="${esc(p.licenseUrl || '#')}" target="_blank" rel="noopener">${esc(p.license || '')}</a></li>`).join('')}</ul>`;
  } else $('#photoCredits').remove();
  const src = [...new Set([...(R.circuit?.sources || []), ...(R.timelineSources || []), ...(R.records?.sources || [])])];
  if (src.length) $('#researchSources').innerHTML = `Research sources: ${src.slice(0, 18).map((u) => { try { return `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(new URL(u).hostname.replace('www.', ''))}</a>`; } catch { return ''; } }).join(', ')}`;
  $('#finePrint').textContent += ` The circuit's elevation change is usually quoted as 41 m (133 ft). The bare-earth ground under our centreline varies by ${Math.round(relief)} m.`;
}
