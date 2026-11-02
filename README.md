# Formula One projects

Static sites, served as a single Cloudflare Worker (static assets only). The repo root is the site root:

| Path | What |
|---|---|
| `/` | `index.html`: directory of projects |
| `/walkthroughs/singapore/` | Marina Bay Street Circuit 3D walkthrough |
| `/walkthroughs/austin/` | Circuit of the Americas 3D walkthrough on real terrain |
| `/lib/three-0.170.0/` | three.js r170 (MIT), vendored and shared by projects |
| `tools/` | Build scripts and raw data. Not published (see `.assetsignore`) |

## Run / deploy

```sh
npm run dev      # wrangler dev on http://localhost:8787
npm run deploy   # wrangler deploy (needs `npx wrangler login` once)
```

`npm run dev` keeps Wrangler's local state outside the repo (`--persist-to $TMPDIR/...`). The repo root is the watched asset directory, so state written inside it (`.wrangler/state/*.sqlite-wal`) would trigger an endless reload loop.

Pull requests get a Cloudflare preview build, so changes can be checked on a live URL before merging to `main`.

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

## Austin walkthrough

Same structure as Singapore, with a daylight scene on real terrain:

- `scene.js`: three.js scene. Terrain mesh from `data/terrain.bin`, draped with a ground texture painted at load time from OpenStreetMap features (the red/white/blue run-off, track surface, parking, water, roads). Preetham sky with the sun computed for race day (25 Oct 2026), shadows, the Observation Tower, low-poly F1 cars, ghost-lap playback and chase/onboard/TV/heli cameras.
- `charts.js`: speed trace, time delta against the 2026 pole lap, and elevation profile on one distance axis
- `data/track.json`: centreline with elevation, corners with apex speeds and gears for three pole laps (2024–2026), sector lines, telemetry
- `data/terrain.bin`: 391 × 391 grid of Uint16 centimetres above `track.datum_m`, 8 m spacing (origin and step in `track.terrain`). Built from AWS Terrain Tiles (USGS 3DEP), with the ground blended to the track surface within ~36 m of the centreline
- `data/city.json`: buildings, ground polygons, lines and landmarks from OpenStreetMap (ODbL)
- `data/sessions.json`, `data/research.json`, `data/photos.json` + `img/corners/`: as for Singapore

```sh
tools/austin/fetch-raw.sh          # OpenF1 / MultiViewer / OSM / terrain tiles into tools/austin/raw
node tools/austin/build-data.mjs   # writes walkthroughs/austin/data/{track,city,sessions}.json and terrain.bin
```

The build cross-checks the terrain against the cars' own z channel (r ≈ 0.94 along the lap).

## Licence

The code is MIT (see `LICENSE`). Bundled third-party material keeps its own licence:

- three.js: MIT (`lib/three-0.170.0/LICENSE`)
- OpenStreetMap-derived data (`data/city.json`, track alignment): ODbL, © OpenStreetMap contributors
- Terrain (`walkthroughs/austin/data/terrain.bin`): AWS Terrain Tiles, from USGS 3DEP (public domain)
- three.js `Sky` addon (`lib/three-0.170.0/addons/objects/Sky.js`): MIT
- Photos in `walkthroughs/*/img/`: their individual Wikimedia Commons licences, listed in `data/photos.json` and credited on the page
- Timing data from OpenF1, which is unofficial and not associated with Formula 1

## Deploys

Cloudflare Workers Builds (Cloudflare's GitHub integration) deploys the site. Every push to `main` goes to https://f1.artgillespie.workers.dev. Every branch with an open pull request gets a preview at `https://<branch>-f1.artgillespie.workers.dev`, posted on the PR by the Cloudflare bot. There is no GitHub Actions workflow and no repository secret to set. `npm run deploy` still works for a manual deploy from your machine.
