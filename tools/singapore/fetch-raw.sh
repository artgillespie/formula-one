#!/usr/bin/env bash
# Re-download the raw inputs for build-data.mjs into tools/singapore/raw/.
# Sources: OpenF1 (laps, telemetry, results), MultiViewer circuit API (track outline),
# OpenStreetMap API (buildings, water, circuit relation). Be polite: these are free services.
set -euo pipefail
cd "$(dirname "$0")/raw"
UA="F1WalkthroughBuilder/1.0"
OF=https://api.openf1.org/v1

curl -sf -A "$UA" https://api.multiviewer.app/api/v1/circuits/61/2026 -o mv_2026.json
curl -sf "$OF/sessions?circuit_short_name=Singapore" -o sessions.json

# Qualifying / race / sprint sessions on the 2023+ layout
for k in 9161 9165 9602 9606 9892 9896 11379 11383 11384 11388; do
  for ep in laps drivers session_result; do
    f=$([ $ep = laps ] && echo laps || ([ $ep = drivers ] && echo drv || echo res))_$k.json
    curl -sf "$OF/$ep?session_key=$k" -o "$f"; sleep 0.4
  done
done

# Pole-lap telemetry (car_data + location) — windows match each pole lap's date_start + lap time
curl -sf "$OF/car_data?session_key=11384&driver_number=3&date>=2026-10-10T14:19:01&date<=2026-10-10T14:20:35" -o car_2026q.json
curl -sf "$OF/location?session_key=11384&driver_number=3&date>=2026-10-10T14:19:01&date<=2026-10-10T14:20:35" -o loc_2026q.json
curl -sf "$OF/car_data?session_key=9892&driver_number=63&date>=2025-10-04T14:05:37&date<=2025-10-04T14:07:09" -o car_2025q.json
curl -sf "$OF/location?session_key=9892&driver_number=63&date>=2025-10-04T14:05:37&date<=2025-10-04T14:07:09" -o loc_2025q.json

# OpenStreetMap: circuit relation, Marina Reservoir, Singapore River, and 9 map tiles of the city
for r in 421263 9542146 9569901; do
  curl -sf -A "$UA" "https://api.openstreetmap.org/api/0.6/relation/$r/full.json" -o rel_$r.json; sleep 1
done
mkdir -p osm
for lon in 103.840 103.850 103.860; do for lat in 1.276 1.286 1.296; do
  l2=$(python3 -c "print(round($lon+0.01,3))"); a2=$(python3 -c "print(round($lat+0.0095,4))")
  curl -sf -A "$UA" "https://api.openstreetmap.org/api/0.6/map.json?bbox=$lon,$lat,$l2,$a2" -o osm/t_${lon}_${lat}.json; sleep 2
done; done
echo "done — now run: node tools/singapore/build-data.mjs"
