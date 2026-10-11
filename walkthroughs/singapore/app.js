import { createScene, SECTOR_GLOW } from './scene.js';
import { speedTrace, evolutionChart } from './charts.js';
import { OPENF1, fetchSessionSummary, fmtLap, fmtDuration } from './stats.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SECTOR_INK = ['var(--s1)', 'var(--s2)', 'var(--s3)'];
const CHART_SERIES = ['#e8405f', '#2f8fd0'];

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

const [track, city, snapshot, research, photos] = await Promise.all([
  getJSON('data/track.json'),
  getJSON('data/city.json'),
  getJSON('data/sessions.json'),
  getJSON('data/research.json', true),
  getJSON('data/photos.json', true),
]);

const R = research || { circuit: {}, corners: [], timeline: [], records: {} };
const cornerInfo = new Map((R.corners || []).map((c) => [c.number, c]));
const cornerPhotos = photos?.corners || {};

// ---------------------------------------------------------------- masthead facts
{
  const c = R.circuit;
  const facts = [
    ['Length', `${(c.officialLength_km || 4.927).toFixed(3)} km`],
    ['Corners', track.corners.length],
    ['Laps', c.laps || 62],
    ['Direction', c.direction ? c.direction.replace('anticlockwise', 'Anti-clockwise') : 'Anti-clockwise'],
    ['Race lap record', c.lapRecord ? `${c.lapRecord.time} · ${c.lapRecord.driver.split(' ').at(-1)} ${c.lapRecord.year}` : '—'],
    ['Fastest ever', c.allTimeFastestLap ? `${c.allTimeFastestLap.time} · ${c.allTimeFastestLap.driver.split(' ').at(-1)} ${c.allTimeFastestLap.year}` : '—'],
  ];
  $('#facts').innerHTML = facts.map(([k, v]) => `<li>${esc(k)}<b>${esc(v)}</b></li>`).join('');
}

// ---------------------------------------------------------------- 3D scene
// 2026 Straight Mode zones, parsed from research text ("… after T9 to T10 …")
const zones = (R.circuit?.overtakeModeZones?.straightModeZones || []).map((z) => {
  const after = z.location.match(/after T(\d+)/);
  const until = z.location.match(/to (?:the )?T(\d+)/);
  if (!after || !until) return null;
  const off = +(z.location.match(/about (\d+) m/)?.[1] || 0);
  const ca = track.corners.find((c) => c.number === +after[1]);
  const cb = track.corners.find((c) => c.number === +until[1]);
  return ca && cb ? { from: ca.d + off, to: cb.d - 120 } : null;
}).filter(Boolean);

let scene = null;
try {
  scene = createScene($('#canvas'), { track, city, zones });
} catch (e) {
  console.error(e);
  $('#canvas').innerHTML = `<p style="padding:120px 24px;color:#aaa">3D view unavailable on this device (${esc(e.message)}). The rest of the walkthrough is below.</p>`;
}
requestAnimationFrame(() => setTimeout(() => $('#loader').classList.add('done'), 300));

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

function speedTile(label, st, who) {
  if (!st) return '';
  return `<div class="tile"><span>${label}</span><b>${st.minSpeed}</b><em>km/h · G${st.gear} · ${esc(who)}</em></div>`;
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
  const p26 = c.pole2026, p25 = c.pole2025;
  const pics = cornerPhotos[n] || [];
  const dirArrow = c.dir === 'left' ? '↰ Left' : '↱ Right';
  panel.innerHTML = `
    <div class="cp-top">
      <div class="cp-num"><small>TURN</small>${n}</div>
      <button class="cp-close" aria-label="Close">×</button>
    </div>
    ${info.name ? `<p class="cp-name">${esc(info.name)}</p>` : ''}
    <p class="cp-street">${esc(info.street || c.street || '')}</p>
    <div class="chips">
      <span class="tag s${c.sector}">SECTOR ${c.sector}</span>
      <span class="tag">${dirArrow} · ${Math.abs(c.headingChange)}°</span>
      <span class="tag">${(c.d / 1000).toFixed(2)} km into lap</span>
      ${p26?.braking ? '<span class="tag">BRAKING</span>' : '<span class="tag">FLAT / LIFT</span>'}
    </div>
    <div class="tiles">
      ${speedTile('Apex · 2026 pole', p26, 'VER')}
      ${speedTile('Apex · 2025 pole', p25, 'RUS')}
      ${p26 ? `<div class="tile"><span>Entry → exit</span><b>${p26.entrySpeed}</b><em>→ ${p26.exitSpeed} km/h</em></div>` : ''}
    </div>
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
        ? pics.map((p, i) => `<button class="${i === 0 ? 'first' : ''}" data-i="${i}" data-cap="${esc(p.landmark || '')}"><img src="${esc(p.file)}" alt="${esc(p.caption || p.landmark || '')}" loading="lazy" /></button>`).join('')
        : '<p class="no-photo">No freely-licensed photo found for this corner yet.</p>'}
    </div>`;
  panel.hidden = false;
  panel.scrollTop = 0;
  $('#stage').classList.add('focused');
  panel.querySelector('.cp-close').onclick = () => { panel.hidden = true; $('#stage').classList.remove('focused'); current = null; strip.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', 'false')); scene?.overview(); };
  panel.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => { view = b.dataset.view; selectCorner(n); }));
  panel.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => selectCorner(((n - 1 + +b.dataset.nav + track.corners.length) % track.corners.length) + 1)));
  panel.querySelectorAll('.gallery button').forEach((b) => (b.onclick = () => openLightbox(pics, +b.dataset.i)));
}
scene?.onCornerClick((n) => selectCorner(n));

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || $('#lightbox').open) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const d = e.key === 'ArrowRight' ? 1 : -1;
    selectCorner(current ? ((current - 1 + d + 19) % 19) + 1 : 1);
  } else if (e.key === 'Escape') {
    panel.hidden = true;
    $('#stage').classList.remove('focused');
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
$('#btnOverview').onclick = () => { stopLap(); panel.hidden = true; $('#stage').classList.remove('focused'); current = null; strip.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', 'false')); scene?.overview(); };
const hud = $('#hud');
let cam = 'chase';
function startLap() {
  const key = $('#lapSel').value;
  panel.hidden = true;
  $('#stage').classList.add('focused');
  scene?.playLap(key, { cam, rate: +$('#rateSel').value });
  $('#btnPlay').textContent = '■ Stop';
  $('#camSeg').hidden = false;
  hud.hidden = false;
  $('#hudWho').textContent = track.laps[key].driver.session;
}
function stopLap() {
  scene?.stopLap();
  $('#btnPlay').textContent = '▶ Ride the pole lap';
  $('#camSeg').hidden = true;
  hud.hidden = true;
  if (panel.hidden) $('#stage').classList.remove('focused');
}
$('#btnPlay').onclick = () => (scene?.isPlaying() ? (stopLap(), scene.overview()) : startLap());
$('#lapSel').onchange = () => { if (scene?.isPlaying()) startLap(); };
$('#rateSel').onchange = (e) => scene?.setRate(+e.target.value);
$('#camSeg').querySelectorAll('[data-cam]').forEach((b) => (b.onclick = () => {
  cam = b.dataset.cam;
  $('#camSeg').querySelectorAll('[data-cam]').forEach((x) => x.classList.toggle('on', x === b));
  scene?.setCam(cam);
}));
document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
  scene?.setMode(b.dataset.mode);
  $('#speedLegend').hidden = b.dataset.mode !== 'speed';
}));
$('#layBuildings').onchange = (e) => scene?.setLayer('buildings', e.target.checked);
$('#layLabels').onchange = (e) => scene?.setLayer('labels', e.target.checked);
$('#layBloom').onchange = (e) => scene?.setLayer('bloom', e.target.checked);
$('#layZones').onchange = (e) => scene?.setLayer('zones', e.target.checked);
$('#zoneLink')?.addEventListener('click', (e) => { e.preventDefault(); $('#layZones').checked = true; scene?.setLayer('zones', true); scene?.overview(); $('#stage').scrollIntoView({ behavior: 'smooth' }); });

let traceChart = null;
scene?.onTick((s) => {
  $('#hudSpeed').textContent = Math.round(s.speed);
  $('#hudGear').textContent = s.gear || 'N';
  $('#hudThr').style.width = `${Math.max(0, Math.min(100, s.throttle))}%`;
  $('#hudBrk').style.width = s.brake ? '100%' : '0%';
  $('#hudClock').textContent = `${Math.floor(s.t / 60)}:${(s.t % 60).toFixed(3).padStart(6, '0')}`;
  const sc = $('#hudSector');
  sc.textContent = `SECTOR ${s.sector}`;
  sc.style.color = SECTOR_GLOW[s.sector - 1];
  traceChart?.show(s.d);
});

// pause rendering when the map is scrolled off-screen
if (scene) new IntersectionObserver(([e]) => (e.isIntersecting ? scene.resume() : scene.pause())).observe($('#stage'));

// ---------------------------------------------------------------- telemetry section
{
  const laps = [track.laps.q2026, track.laps.q2025];
  const series = laps.map((l, i) => ({ rows: l.rows, color: CHART_SERIES[i], label: `${l.driver.session.slice(0, 4)} ${l.driver.code}` }));
  $('#traceLegend').innerHTML = laps.map((l, i) => `<span><i style="background:${CHART_SERIES[i]}"></i>${esc(l.driver.name)} · ${esc(l.driver.session)} · ${fmtLap(l.lapTime)}</span>`).join('');
  traceChart = speedTrace($('#trace'), {
    series, sectors: track.sectors, corners: track.corners, length: track.length_m,
    sectorColors: ['#e8405f', '#2f8fd0', '#b08a1e'],
    onHover: (d) => scene?.setCursor(d),
  });

  const sectorsR = R.sectors || [];
  const cornersIn = (s) => track.corners.filter((c) => c.sector === s).map((c) => c.number);
  $('#sectorCards').innerHTML = [1, 2, 3].map((s) => {
    const cs = cornersIn(s);
    const ch = sectorsR.find((x) => x.n === s)?.character || '';
    return `<div class="sector-card" style="--c:${SECTOR_INK[s - 1]}">
      <h3>Sector ${s} <small style="color:var(--ink-3);font-weight:400">· Turns ${cs[0]}–${cs.at(-1)}</small></h3>
      <div class="times"><span>2026 pole <b>${laps[0].sectorTimes[s - 1].toFixed(3)}</b></span><span>2025 pole <b>${laps[1].sectorTimes[s - 1].toFixed(3)}</b></span></div>
      <p>${esc(ch)}</p></div>`;
  }).join('');

  const rows = track.corners.map((c) => {
    const info = cornerInfo.get(c.number) || {};
    const a = c.pole2026 || {}, b = c.pole2025 || {};
    return `<tr data-n="${c.number}">
      <td><span class="sbar" style="--c:${SECTOR_INK[c.sector - 1]}"></span><b>T${c.number}</b></td>
      <td>${esc(info.name || '—')}</td>
      <td>${c.dir === 'left' ? 'L' : 'R'}</td>
      <td class="num">${a.gear ?? '—'}</td><td class="num">${a.minSpeed ?? '—'}</td>
      <td class="num">${b.gear ?? '—'}</td><td class="num">${b.minSpeed ?? '—'}</td>
      <td class="num">${a.entrySpeed ?? '—'} → ${a.exitSpeed ?? '—'}</td>
      <td>${esc(info.street || c.street || '')}</td></tr>`;
  }).join('');
  $('#cornerTable').innerHTML = `<thead><tr><th>Turn</th><th>Name</th><th>Dir</th><th class="num">Gear '26</th><th class="num">Apex km/h '26</th><th class="num">Gear '25</th><th class="num">Apex km/h '25</th><th class="num">Entry → exit '26</th><th>Street</th></tr></thead><tbody>${rows}</tbody>`;
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
    const all = await fetchJson(`${OPENF1}/sessions?circuit_short_name=Singapore`);
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
    $('#round').textContent = latest?.year ?? '—';
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
      (om.overtakeMode ? `<li class="om">Detection: ${esc(om.overtakeMode.detectionPoint)}. Activation: ${esc(om.overtakeMode.activationPoint)}. ${esc(om.overtakeMode.rule)}</li>` : '');
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
  if (rec.mostWins_driver) cards.push(['Most wins', `${rec.mostWins_driver.driver} · ${rec.mostWins_driver.wins}`, (rec.mostWins_driver.years || []).join(', ')]);
  if (rec.mostPoles) cards.push(['Most poles', `${(rec.mostPoles.drivers || []).join(' & ')} · ${rec.mostPoles.poles}`, rec.mostPoles.detail || '']);
  if (rec.mostWins_team) cards.push(['Most team wins', `${(rec.mostWins_team.teams || []).join(' & ')} · ${rec.mostWins_team.wins}`, rec.mostWins_team.detail || '']);
  if (rec.safetyCarStats) cards.push(['Safety Cars', 'Every race 2008–2023', rec.safetyCarStats.summary || '']);
  $('#records').innerHTML = cards.map(([k, v, p]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b><p>${esc(p)}</p></div>`).join('');
}

// ---------------------------------------------------------------- credits
{
  const all = Object.values(cornerPhotos).flat();
  const seen = new Map();
  for (const p of all) if (!seen.has(p.file)) seen.set(p.file, p);
  if (seen.size) {
    $('#photoCredits').innerHTML = `Photographs (rehosted under their licences):<ul class="photo-credit-list">${[...seen.values()].map((p) => `<li><a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">${esc(p.landmark || p.caption || p.file)}</a> by ${esc(p.author || 'unknown')}, <a href="${esc(p.licenseUrl || '#')}" target="_blank" rel="noopener">${esc(p.license || '')}</a></li>`).join('')}</ul>`;
  }
  const src = [...new Set([...(R.circuit?.sources || []), ...(R.timelineSources || [])])];
  if (src.length) $('#researchSources').innerHTML = `Research sources: ${src.slice(0, 14).map((u) => { try { return `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(new URL(u).hostname.replace('www.', ''))}</a>`; } catch { return ''; } }).join(', ')}`;
}
