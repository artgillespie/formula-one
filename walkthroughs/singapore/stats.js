// Session statistics computed from raw OpenF1 data.
// Shared by the browser (live refresh) and tools/singapore/build-data.mjs (snapshot).

export const OPENF1 = 'https://api.openf1.org/v1';

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

export function sessionKind(name) {
  return /qualifying|shootout/i.test(name) ? 'quali' : /race|sprint/i.test(name) ? 'race' : 'practice';
}

/**
 * @param session  OpenF1 session object
 * @param laps     OpenF1 /laps rows for the session
 * @param drivers  OpenF1 /drivers rows for the session
 * @param results  OpenF1 /session_result rows for the session
 */
export function summarizeSession(session, laps, drivers, results) {
  const kind = sessionKind(session.session_name);
  const drv = new Map(drivers.map((d) => [d.driver_number, d]));
  const who = (n) => {
    const d = drv.get(n) || {};
    return {
      number: n,
      code: d.name_acronym || String(n),
      name: d.full_name ? titleCase(d.full_name) : `#${n}`,
      team: d.team_name || '',
      colour: d.team_colour ? `#${d.team_colour}` : '#888888',
    };
  };

  const timed = laps.filter((l) => l.lap_duration && l.lap_duration > 60);
  if (!timed.length) return null;

  const fastestLap = timed.reduce((a, b) => (b.lap_duration < a.lap_duration ? b : a));

  // Representative laps: race = green-flag, non-pit laps; quali = each driver's best lap.
  let rep;
  if (kind === 'race') {
    const cut = fastestLap.lap_duration * 1.07;
    rep = timed.filter((l) => l.lap_number > 1 && !l.is_pit_out_lap && l.lap_duration <= cut);
  } else {
    const best = new Map();
    for (const l of timed) {
      const b = best.get(l.driver_number);
      if (!b || l.lap_duration < b.lap_duration) best.set(l.driver_number, l);
    }
    rep = [...best.values()].sort((a, b) => a.lap_duration - b.lap_duration).slice(0, 10);
  }

  const sectors = [1, 2, 3].map((s) => {
    const key = `duration_sector_${s}`;
    const valid = timed.filter((l) => l[key] && l[key] > 5);
    if (!valid.length) return null;
    const b = valid.reduce((x, y) => (y[key] < x[key] ? y : x));
    const reps = rep.map((l) => l[key]).filter((v) => v && v > 5);
    return {
      best: round3(b[key]),
      driver: who(b.driver_number),
      avg: round3(kind === 'race' ? median(reps) : mean(reps)),
    };
  });

  const speedTrap = timed.filter((l) => l.st_speed).reduce((a, b) => (!a || b.st_speed > a.st_speed ? b : a), null);

  const classified = [...results]
    .filter((r) => r.position != null)
    .sort((a, b) => a.position - b.position)
    .slice(0, 10)
    .map((r) => {
      const time = Array.isArray(r.duration) ? r.duration.filter(Boolean).at(-1) : r.duration;
      const gap = Array.isArray(r.gap_to_leader) ? r.gap_to_leader.at(-1) : r.gap_to_leader;
      return { pos: r.position, ...who(r.driver_number), time: round3(time), gap, laps: r.number_of_laps };
    });

  const repTimes = rep.map((l) => l.lap_duration);
  return {
    key: session.session_key,
    meeting: session.meeting_key,
    year: session.year,
    name: session.session_name,
    kind,
    date: session.date_start,
    fastest: { time: round3(fastestLap.lap_duration), lap: fastestLap.lap_number, driver: who(fastestLap.driver_number) },
    sectors,
    ideal: sectors.every(Boolean) ? round3(sectors.reduce((a, s) => a + s.best, 0)) : null,
    avgLap: round3(kind === 'race' ? median(repTimes) : mean(repTimes)),
    avgLapNote: kind === 'race' ? 'median green-flag lap' : 'mean of top-10 best',
    topSpeed: speedTrap ? { kph: speedTrap.st_speed, driver: who(speedTrap.driver_number) } : null,
    results: classified,
  };
}

function titleCase(name) {
  return name
    .split(' ')
    .map((w) => (w === w.toUpperCase() && w.length > 1 ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ');
}

export function fmtLap(t) {
  if (t == null) return '—';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
}

export function fmtDuration(t) {
  if (t == null) return '—';
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

/** Fetch + summarise a session live from OpenF1. */
export async function fetchSessionSummary(session, fetchJson) {
  const q = `session_key=${session.session_key}`;
  const [laps, drivers, results] = await Promise.all([
    fetchJson(`${OPENF1}/laps?${q}`),
    fetchJson(`${OPENF1}/drivers?${q}`),
    fetchJson(`${OPENF1}/session_result?${q}`).catch(() => []),
  ]);
  return summarizeSession(session, laps, drivers, results);
}
