# Copenhagen Public Transport — interactive map

Interactive, poster-grade map of the public transport network of **Copenhagen
and its omegn**: 84 Movia bus lines (1A–8A, 5C, the 150S–500S S-buses), the
Hovedstadens Letbane, the metro M1–M4 and all seven DSB S-tog lines in the
official line colors — 96 lines / 3 300 km drawn along the real street and
track geometry, weighted mean matching error 2.05 m (the rail shapes are
coarse multi-track centerlines; buses sit at ~0.5 m).

## Live

**https://miqell24.github.io/copenhagen-bus-map/** — GitHub Pages from `main:/docs`. Local build on port 8153 (`npm run serve`).

Everything comes from ONE feed — the NATIONAL Rejseplanen GTFS
(https://www.rejseplanen.info/labs/GTFS.zip, all of Denmark) — so the map's
scope is a precomputed allowlist (`pipeline/scope.mjs` → `data/scope.json`):

| mode | route_type | scope | graph |
|---|---|---|---|
| buses | 3 + 700 (S-buses) | ≥50% of stops within 20 km of Rådhuspladsen, no stop past 45 km | OSM roadways |
| letbane | 0 | Hovedstadens Letbane only (Odense/Aarhus have their own "L") | `railway=tram` + `light_rail` |
| metro | 1 | M1–M4, official colors (hand list — the feed ships none) | `railway=subway` |
| S-tog | 109 | all seven lines, official colors, metro treatment via `allMetro` | `railway=rail` |

Cut deliberately: regional rail and lokaltog (route_type 2), the 991–993
harbour buses (4), Metroselskabet's metrobus replacements and DSB togbusser
(they duplicate the rail line names). Line colors come from a hand list
(`CPH_COLORS`) sourced from the Wikipedia "Adjacent stations" modules for the
metro and S-train, because Rejseplanen ships no `route_color` at all.

## Pipeline

`npm run download` fetches the Rejseplanen feed, computes the scope, and pulls OSM roadways and rails (Overpass,
bbox 55.38–56.02 N / 11.90–12.75 E) and MapLibre GL. `npm run build`
map-matches every line (HMM/Viterbi on the OSM graphs) and writes GeoJSON to
`data/out/`. `npm run serve` hosts the map at http://localhost:8153.

Data: Rejseplanen (Movia, Metroselskabet, DSB S-tog) ·
base map © OpenFreeMap / OpenMapTiles / OpenStreetMap contributors.
