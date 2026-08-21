#!/usr/bin/env bash
# Downloads input data: Rejseplanen GTFS (national), OSM networks (Overpass),
# MapLibre GL. Everything is cached — re-running only fetches what is missing.
#
# The Rejseplanen aggregate covers ALL of Denmark, so the map's scope is
# computed by pipeline/scope.mjs into data/scope.json: Movia buses of the
# city + omegn (with the 150S…600S S-buses, route_type 700), the Hovedstadens
# Letbane, the metro M1–M4 and all seven DSB S-tog lines. Modes are separated
# by route_type at build time.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/gtfs data/osm web/vendor

# A downloaded extract is only accepted if it PARSES and carries a plausible
# number of elements. `grep -q '"elements"'` — the guard this family used
# everywhere — passes on a truncated response too: Brașov's roads arrived as a
# 65 kB fragment that still contained the string, was taken for complete, and
# silently skipped the city (16.08.2026).
# The minimum differs by extract: a road network runs to tens of thousands of
# ways, a city rail network to a few hundred, so the caller passes its own floor
# rather than sharing one.
# A rejected file is deleted rather than left behind — the `[ ! -f … ]` gates
# below only ask whether the file exists, so a fragment on disk would be taken
# for a finished download on the next run.
ok_json () { # $1=file  $2=minimum element count
  python3 - "$1" "$2" <<'PYEOF' 2>/dev/null
import json, sys
try:
    sys.exit(0 if len(json.load(open(sys.argv[1])).get("elements", [])) >= int(sys.argv[2]) else 1)
except Exception:
    sys.exit(1)
PYEOF
}

# 1) GTFS — the regional bundle (stable URL, refreshed in place by TPBI)
if [ ! -f data/gtfs/routes.txt ]; then
  echo "== Rejseplanen GTFS (Denmark) =="
  curl -fL --retry 3 --max-time 900 -o data/dk_gtfs.zip \
    "https://www.rejseplanen.info/labs/GTFS.zip"
  unzip -o data/dk_gtfs.zip -d data/gtfs \
    agency.txt routes.txt trips.txt stop_times.txt stops.txt shapes.txt calendar.txt calendar_dates.txt
fi

# 1b) scope: which of the ~1400 national lines belong on a COPENHAGEN map
if [ ! -f data/scope.json ]; then
  node pipeline/scope.mjs
fi

# 2) OSM — roadways over the scope extent (the S-tog reaches Hillerød,
#    Frederikssund and Køge; buses stay within the 35 km cap)
if [ ! -f data/osm/copenhagen.json ]; then
  echo "== Overpass (roads) =="
  Q='[out:json][timeout:900];way(55.38,11.90,56.02,12.75)["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|construction|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"];out geom;'
  ok=0
  for EP in "https://overpass-api.de/api/interpreter" \
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter" \
            "https://overpass.kumi.systems/api/interpreter"; do
    echo "-- $EP"
    if curl -fsS --max-time 900 -o data/osm/copenhagen.json --data-urlencode "data=$Q" "$EP" \
       && ok_json "data/osm/copenhagen.json" 2000; then
      ok=1; break
    fi
  done
  [ "$ok" = 1 ] || { rm -f data/osm/copenhagen.json; echo "Overpass: all mirrors failed" >&2; exit 1; }
fi

# 2b) OSM — rails for the letbane/metro/S-tog modes: tram + light_rail for
#     the Ring 3 letbane, railway=subway tunnels, and mainline rail for the
#     S-tog. Same bbox as the roads.
if [ ! -f data/osm/copenhagen-rail.json ]; then
  echo "== Overpass (rails) =="
  QT='[out:json][timeout:600];way(55.38,11.90,56.02,12.75)["railway"~"^(subway|tram|light_rail|rail)$"];out geom;'
  ok=0
  for EP in "https://overpass-api.de/api/interpreter" \
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter" \
            "https://overpass.kumi.systems/api/interpreter"; do
    echo "-- $EP"
    if curl -fsS --max-time 300 -o data/osm/copenhagen-rail.json --data-urlencode "data=$QT" "$EP" \
       && ok_json "data/osm/copenhagen-rail.json" 40; then
      ok=1; break
    fi
  done
  [ "$ok" = 1 ] || { rm -f data/osm/copenhagen-rail.json; echo "Overpass (rails): all mirrors failed" >&2; exit 1; }
fi

# 3) MapLibre GL (vendored, no CDN at runtime)
if [ ! -f web/vendor/maplibre-gl.js ]; then
  echo "== MapLibre GL =="
  curl -fL --retry 3 -o web/vendor/maplibre-gl.js  https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js
  curl -fL --retry 3 -o web/vendor/maplibre-gl.css https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.css
fi

echo "OK — data ready:"
du -sh data/bucharest-region.zip data/osm/copenhagen.json data/osm/copenhagen-rail.json 2>/dev/null || true
