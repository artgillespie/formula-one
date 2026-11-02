#!/usr/bin/env bash
# Re-download the raw inputs for build-data.mjs into tools/austin/raw/.
# Sources: OpenF1 (laps, telemetry, results), MultiViewer circuit API (track outline),
# OpenStreetMap API (buildings, roads, water, circuit ways). Be polite: these are free services.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw/osm
cd raw
UA="F1WalkthroughBuilder/1.0"
OF=https://api.openf1.org/v1

curl -sf -A "$UA" https://api.multiviewer.app/api/v1/circuits/9/2026 -o mv_2026.json
curl -sf "$OF/sessions?circuit_short_name=Austin" -o sessions.json

# Qualifying / race / sprint sessions 2023+ (OpenF1 coverage starts in 2023)
for k in 9207 9294 9212 9213 9612 9616 9608 9617 9879 9883 9884 9888 11392 11396; do
  curl -sf "$OF/laps?session_key=$k" -o "laps_$k.json"; sleep 0.4
  curl -sf "$OF/drivers?session_key=$k" -o "drv_$k.json"; sleep 0.4
  curl -sf "$OF/session_result?session_key=$k" -o "res_$k.json"; sleep 0.4
done

# Pole-lap telemetry (car_data + location). Windows match each pole lap's date_start + lap time.
tel() { # tag session driver from to
  curl -sf "$OF/car_data?session_key=$2&driver_number=$3&date>=$4&date<=$5" -o "car_$1.json"; sleep 0.5
  curl -sf "$OF/location?session_key=$2&driver_number=$3&date>=$4&date<=$5" -o "loc_$1.json"; sleep 0.5
}
if [ -f ../pole-windows.txt ]; then
  while read -r tag sk drv from to; do tel "$tag" "$sk" "$drv" "$from" "$to"; done < ../pole-windows.txt
fi

# OpenStreetMap: 0.01° tiles covering the circuit and its surroundings
for lon in -97.660 -97.650 -97.640 -97.630; do for lat in 30.120 30.130 30.140; do
  l2=$(python3 -c "print(round($lon+0.01,3))"); a2=$(python3 -c "print(round($lat+0.01,3))")
  curl -sf -A "$UA" "https://api.openstreetmap.org/api/0.6/map.json?bbox=$lon,$lat,$l2,$a2" -o "osm/t_${lon}_${lat}.json" || echo "osm tile failed $lon $lat"; sleep 2
done; done
# Terrain: AWS Terrain Tiles (Terrarium encoding, USGS 3DEP in the US), zoom 15
mkdir -p dem
for x in 7494 7495 7496 7497 7498; do for y in 13502 13503 13504 13505 13506 13507; do
  [ -s "dem/15_${x}_${y}.png" ] || curl -sf "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/$x/$y.png" -o "dem/15_${x}_${y}.png"
done; done
echo "done — now run: node tools/austin/build-data.mjs"
