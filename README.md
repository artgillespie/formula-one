# Formula One projects

Static sites, served as a single Cloudflare Worker (static assets only). The repo root is the site root:

| Path | What |
|---|---|
| `/` | `index.html`: directory of projects |
| `/walkthroughs/singapore/` | Marina Bay Street Circuit 3D walkthrough |
| `/lib/three-0.170.0/` | three.js r170 (MIT), vendored and shared by projects |
| `tools/` | Build scripts and raw data. Not published (see `.assetsignore`) |

## Run / deploy

```sh
npm run dev      # wrangler dev on http://localhost:8787
npm run deploy   # wrangler deploy (needs `npx wrangler login` once)
```

`npm run dev` keeps Wrangler's local state outside the repo (`--persist-to $TMPDIR/...`). The repo root is the watched asset directory, so state written inside it (`.wrangler/state/*.sqlite-wal`) would trigger an endless reload loop.

No build step is needed to serve the site. Any static server works: `python3 -m http.server`.

## Singapore walkthrough

- `index.html`, `styles.css`, `app.js`: page, UI and live-data refresh
- `scene.js`: three.js night scene with OSM buildings and water, the track ribbon, kerbs, sector gates, the Flyer, bloom and lap playback
- `charts.js`: hand-rolled SVG speed trace and lap-time dot plot
- `stats.js`: session statistics from raw OpenF1 rows, shared by the browser and the build script
- `data/track.json`: centreline (local metres, origin in `origin`), corners with pole-lap apex speeds and gears, sector lines, telemetry traces
- `data/city.json`: buildings, water, parks, roads and landmark labels from OpenStreetMap (ODbL)
- `data/sessions.json`: snapshot of quali/race/sprint summaries from 2023 onward. The page refreshes these live from OpenF1 on load and polls every 60 s while a Singapore session is running.
- `data/research.json`: corner names, descriptions, the 2026 aero zones, the timeline and records. Hand-researched; entries marked `uncertain` are flagged on the page.
- `data/photos.json` + `img/corners/`: Wikimedia Commons photos (CC BY / BY-SA / CC0 / PD), credited on the page

Rebuilding the data:

```sh
tools/singapore/fetch-raw.sh          # re-download OpenF1 / MultiViewer / OSM inputs into tools/singapore/raw
node tools/singapore/build-data.mjs   # writes walkthroughs/singapore/data/{track,city,sessions}.json
```

The F1 track coordinates are aligned to OpenStreetMap with ICP (Iterative Closest Point), fitting scale, rotation and translation against the circuit relation. The median residual is about 3 m.

## Licence

The code is MIT (see `LICENSE`). Bundled third-party material keeps its own licence:

- three.js: MIT (`lib/three-0.170.0/LICENSE`)
- OpenStreetMap-derived data (`data/city.json`, track alignment): ODbL, © OpenStreetMap contributors
- Photos in `walkthroughs/singapore/img/`: their individual Wikimedia Commons licences, listed in `data/photos.json` and credited on the page
- Timing data from OpenF1, which is unofficial and not associated with Formula 1

## Deploys

Every push to `main` deploys to https://f1.artgillespie.workers.dev through `.github/workflows/deploy.yml`. It needs two repository secrets: `CLOUDFLARE_API_TOKEN` (a token with the "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID`.
