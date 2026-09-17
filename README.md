# Copenhagen Public Transport — interactive map

Interactive, poster-grade map of the public transport network of **Copenhagen
and its omegn**: 84 Movia bus lines (1A–8A, 5C, the 150S–500S S-buses), the
Hovedstadens Letbane, the metro M1–M4 and all seven DSB S-tog lines in the
official line colors — 96 lines / 3 300 km drawn along the real street and
track geometry, weighted mean matching error 2.05 m (the rail shapes are
coarse multi-track centerlines; buses sit at ~0.5 m).

## Live

**https://agcghub.github.io/copenhagen-bus-map/** — GitHub Pages from `main:/docs`. Local build on port 8153 (`npm run serve`).

Everything comes from ONE feed — the NATIONAL Rejseplanen GTFS
(https://www.rejseplanen.info/labs/GTFS.zip, all of Denmark) — so the map's
scope is a precomputed allowlist (`pipeline/scope.mjs` → `data/scope.json`):

| mode | route_type | scope | graph |
|---|---|---|---|
| buses | 3 + 700 (S-buses) | ≥50% of stops within 20 km of Rådhuspladsen, no stop past 45 km | OSM roadways |
| letbane | 0 | Hovedstadens Letbane only (Odense/Aarhus have their own "L") | `railway=tram` + `light_rail` |
| metro | 1 | M1–M4, official colors (hand list — the feed ships none) | `railway=subway` |
| S-tog | 109 | all seven lines, official colors, metro treatment via `allMetro` | `railway=rail` |
| harbour buses | 4 | Movia's Havnebussen 991 and 992, dashed purple | water courses from `pipeline/harbour.mjs` |

Cut deliberately: regional rail and lokaltog (route_type 2), the two-stop
harbour shuttle 993, Metroselskabet's metrobus replacements and DSB togbusser
(they duplicate the rail line names). Line colors come from a hand list
(`CPH_COLORS`) sourced from the Wikipedia "Adjacent stations" modules for the
metro and S-train, because Rejseplanen ships no `route_color` at all.

## The harbour buses (14.09.2026)

991 and 992 ride Københavns Havn from Orientkaj to Teglholmen, and nothing
in the inputs draws that ride properly: the road graph ends at the quays,
Rejseplanen's shape is a coarse trace that cuts across piers, and OSM's
route=ferry ways are one mapper's polyline. So `pipeline/harbour.mjs` makes
the water itself the network:

1. **Water mask.** A 4 m grid over the stops plus 1.5 km. OSM water polygons
   and bays are scan-filled. Coastline ways are burnt in as barriers, and the
   areas between them are voted sea or land by the coastline convention (land
   on the left). A closing line across a harbour mouth, with water on both
   sides, dissolves. Pier outlines (`man_made=pier`) are cut back out: the base
   map draws them as quay, and they are the pontoons the boats call at. Eight
   known dry points (Rådhuspladsen, Kastellet, Refshaleøen…) must stay land, or
   nothing is written.
2. **Clearance.** An exact Euclidean distance transform gives every water cell
   its distance to the nearest shore.
3. **Berths.** A stop is drawn on land, never out in the basin: its berth is
   the nearest pier cell to the feed's pontoon coordinate, or a quay cell two
   cells (≈ 6 m) behind the edge, on a shore of the harbour itself (not a park
   pond). Nine of the eleven stops land on their pontoon within 3 m.
4. **Routing.** Each pair of consecutive stops is joined by A* through water at
   least 6 m from land, from the water point its berth sees. A step costs more
   the nearer it is to a quay, and three times more within 20 m of one, so the
   course keeps to mid-channel.
5. **Smoothing and docking.** The courses are chained through the calls into
   one line, Orientkaj … Teglholmen. A short Laplacian pass removes the grid
   staircase, then 4 000 steps of a bending (bi-Laplacian) flow round the
   curve, each call on a 35 m leash and no vertex nearer to land than 15 m.
   That water course is then docked: each call vertex is carried onto its
   berth and the course follows it over up to 90 m either side, weighted
   (1 − s/L)², with L shortened wherever the full stretch would cross a pier.
   1 500 more bending steps smooth it with the calls pinned. Within 14 m of a
   berth the course may cross the quay; past that it must gain 0.3 m of
   clearance per metre, up to 15 m. The turn at a call is 37–75°: a boat
   pulling in and out, not a V drawn at the last vertex.
6. **Proof.** Every course is sampled every metre against the mask, bar the
   14 m out of each berth. A land sample would replace the docked curve with
   the berth-to-berth simplification.
7. **Output.** One synthetic `route=ferry` way per stretch of a named basin
   (Sydhavnen, Inderhavnen, Yderhavnen, Orientbassinet) goes to
   `data/osm/copenhagen-ferry.json`, with the berth of every stop. The build's
   `ferry` mode puts each stop at its berth and matches the stop sequences on
   that graph like any other mode. A match that would leave the
   water (a raw stretch or a Viterbi break) is dropped rather than drawn. QA:
   `data/harbour-qa.geojson`, `node pipeline/harbour.mjs --png` for the mask.

The frontend draws the courses dashed purple (the usual ferry colour, deeper
than S-tog E's lavender) on a white casing, under the street casing so the
bridges pass over them. The calls are full discs, since water has no kerb
side, and the mode has its own toggle.

## Pipeline

`npm run download` fetches the Rejseplanen feed, computes the scope, and pulls OSM roadways and rails (Overpass,
bbox 55.38–56.02 N / 11.90–12.75 E) and MapLibre GL. `npm run build`
map-matches every line (HMM/Viterbi on the OSM graphs) and writes GeoJSON to
`data/out/`. `npm run serve` hosts the map at http://localhost:8153.

Data: Rejseplanen (Movia, Metroselskabet, DSB S-tog) ·
base map © OpenFreeMap / OpenMapTiles / OpenStreetMap contributors.
