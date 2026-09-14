// The harbour buses' WATER (14.09.2026). Movia's 991/992 ride Københavns Havn
// from Orientkaj to Teglholmen, and nothing in the inputs draws that ride: the
// road graph ends at the quays, the Rejseplanen shape is a coarse trace and
// OSM's route=ferry ways are one mapper's polyline. So the water itself is
// made the network. The harbour becomes a 4 m occupancy grid (OSM water
// polygons + the coastline, piers cut back out), every water cell learns its
// clearance from the nearest shore (exact distance transform), and each pair
// of consecutive stops is joined by a course routed through that grid — pulled
// toward mid-channel, simplified, relaxed into one smooth curve, then docked:
// every stop stands ON LAND (its pontoon or the quay), and the course bends in
// to it. The final polyline is sampled every metre against the mask, so "never
// on land except into a berth" is checked, not hoped. The courses are written
// as synthetic route=ferry ways
// (data/osm/copenhagen-ferry.json) named after the basin they cross, and the
// ordinary machinery — graph → HMM → runs → labels, stops, badges, street
// names — draws the ferry mode like any other.
//
// Usage: node pipeline/harbour.mjs [--lines 991,992] [--cell 4]
// Reads data/gtfs, data/scope.json (ferry), data/osm/copenhagen-water.json;
// writes data/osm/copenhagen-ferry.json (ways + the berth of every stop, which
// build.mjs draws the stop discs on) and data/harbour-qa.geojson.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iterCsv, readCsv } from './lib/csv.mjs';
import { makeProj, resample } from './lib/geo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GD = join(ROOT, 'data/gtfs');
const WATER_FILE = join(ROOT, 'data/osm/copenhagen-water.json');
const OUT_FILE = join(ROOT, 'data/osm/copenhagen-ferry.json');
const QA_FILE = join(ROOT, 'data/harbour-qa.geojson');

const ARGS = process.argv.slice(2);
const argOf = (k, d) => { const i = ARGS.indexOf(k); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d; };
const CELL = Number(argOf('--cell', 4));   // m — grid cell; the harbour is 100–400 m wide, quays matter to ~5 m
const MARGIN = 1500;                        // m — grid around the stops; a course may leave the stops' box (Kronløbet)
const CLEAR_MIN = 6;                        // m — the hard floor: no course is ever routed nearer to land
const CLEAR_MID = 20;                       // m — the corridor a boat keeps whenever the channel allows it…
const CORR_PEN = 3;                         // …a step inside it costs three times over (the quays are the exception)
const K_MID = 25;                           // m — mid-channel pull: a step costs len × (1 + K_MID / clearance)
const CLEAR_SNAP = 6;                       // m — the water point a stop's course starts from
const SNAP_MAX = 85;                        // m — how far that point may be from the berth
const CLEAR_SMOOTH = 15;                    // m — the relaxation may cut a corner down to this clearance, never further
const BERTH_DEPTH = 2;                      // cells — a stop's berth sits this deep in the quay (≈ 6 m past the edge)
const BERTH_MAX = 90;                       // m — how far the berth may be from the feed's pontoon coordinate
const LAND_OK = 14;                         // m — only this close to its berth may a course be over land
const APPROACH = 0.3;                       // past LAND_OK a course must gain this much clearance per metre from the berth
const STOP_DRIFT = 35;                      // m — the water course: how far a call may slide off its water point onto the curve
const DOCK_MAX = 90;                        // m — the stretch either side of a call that bends in to its berth
const DOCK_ITER = 1500;                     // bending steps once the calls are pinned to their berths
const BEND_ITER = 4000, BEND_RATE = 0.05;   // bending flow: steps and rate (explicit scheme, stable below 1/16)
const SMOOTH_STEP = 8;                      // m — vertex spacing of the relaxed course
const SMOOTH_ITER = 120;                    // curvature flow steps at 8 m spacing
const DP_TOL = 6;                           // m — Douglas–Peucker tolerance on the grid path
const BASIN_MIN = 150;                      // m — a shorter stretch of another basin's name is a boundary wobble

const t0 = Date.now();
const log = (m) => console.log(`[harbour ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// ---------- 1) the ferry lines and their stop sequences ----------
const SCOPE = existsSync(join(ROOT, 'data/scope.json')) ? JSON.parse(readFileSync(join(ROOT, 'data/scope.json'), 'utf8')) : {};
const wantLines = argOf('--lines', '').split(',').filter(Boolean);
const routeToLine = new Map();
for (const r of await readCsv(join(GD, 'routes.txt'))) {
  if (r.route_type !== '4') continue;
  const sn = (r.route_short_name || '').trim();
  const inScope = wantLines.length ? wantLines.includes(sn) : (SCOPE.ferry || []).includes(r.route_id);
  if (inScope) routeToLine.set(r.route_id, sn);
}
if (!routeToLine.size) { console.error('no ferry routes in scope — run pipeline/scope.mjs or pass --lines'); process.exit(1); }
const tripLine = new Map();
for await (const t of iterCsv(join(GD, 'trips.txt'))) {
  const L = routeToLine.get(t.route_id);
  if (L) tripLine.set(t.trip_id, L);
}
const tripStops = new Map();
for await (const st of iterCsv(join(GD, 'stop_times.txt'))) {
  if (!tripLine.has(st.trip_id)) continue;
  let arr = tripStops.get(st.trip_id);
  if (!arr) tripStops.set(st.trip_id, (arr = []));
  arr.push([Number(st.stop_sequence), st.stop_id]);
}
// every distinct stop pattern of every line, and the unordered pairs of
// consecutive stops across all of them — one course per pair, both directions
// and every short-turn variant ride the same water
const patterns = new Map(); // "line|a>b>c" → { line, seq }
const pairs = new Map();    // "a|b" (sorted) → [a, b]
const stopIds = new Set();
for (const [tid, arr] of tripStops) {
  const seq = arr.sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  const L = tripLine.get(tid);
  patterns.set(L + '|' + seq.join('>'), { line: L, seq });
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i], b = seq[i + 1];
    if (a === b) continue;
    const k = a < b ? a + '|' + b : b + '|' + a;
    if (!pairs.has(k)) pairs.set(k, a < b ? [a, b] : [b, a]);
  }
  for (const s of seq) stopIds.add(s);
}
const stops = new Map();
for await (const s of iterCsv(join(GD, 'stops.txt'))) {
  if (stopIds.has(s.stop_id)) stops.set(s.stop_id, { name: (s.stop_name || '').trim(), lat: Number(s.stop_lat), lon: Number(s.stop_lon) });
}
log(`${routeToLine.size} ferry lines (${[...new Set(routeToLine.values())].join(', ')}), ${patterns.size} stop patterns, ${stops.size} stops, ${pairs.size} stop pairs to route`);

// ---------- 2) the grid ----------
let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
for (const s of stops.values()) {
  if (s.lat < latMin) latMin = s.lat; if (s.lat > latMax) latMax = s.lat;
  if (s.lon < lonMin) lonMin = s.lon; if (s.lon > lonMax) lonMax = s.lon;
}
const proj = makeProj((latMin + latMax) / 2, (lonMin + lonMax) / 2);
const [xa, ya] = proj.toXY(latMin, lonMin), [xb, yb] = proj.toXY(latMax, lonMax);
const X0 = xa - MARGIN, Y0 = ya - MARGIN;
const W = Math.ceil((xb - xa + 2 * MARGIN) / CELL), H = Math.ceil((yb - ya + 2 * MARGIN) / CELL);
const N = W * H;
const colOf = (x) => Math.floor((x - X0) / CELL), rowOf = (y) => Math.floor((y - Y0) / CELL);
const cxOf = (c) => X0 + (c + 0.5) * CELL, cyOf = (r) => Y0 + (r + 0.5) * CELL;
const inGrid = (c, r) => c >= 0 && r >= 0 && c < W && r < H;
log(`grid ${W} × ${H} cells of ${CELL} m (${(N / 1e6).toFixed(1)} M)`);

// ---------- 3) the water mask ----------
const osm = JSON.parse(readFileSync(WATER_FILE, 'utf8'));
const water = new Uint8Array(N);     // 1 = water
const barrier = new Uint8Array(N);   // 1 = a coastline runs through the cell
const eqPt = (a, b) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
let unclosed = 0;
// closed rings of a water feature: a closed way is one ring; a multipolygon's
// member ways are chained end to end (outer and inner alike — the even-odd
// fill below lets an inner ring cut its island back out)
function ringsOf(el) {
  if (el.type === 'way') {
    const g = el.geometry;
    return g && g.length >= 4 && eqPt(g[0], g[g.length - 1]) ? [g] : [];
  }
  const pieces = (el.members || []).filter((m) => m.type === 'way' && m.geometry && m.geometry.length >= 2).map((m) => m.geometry.slice());
  const rings = [];
  while (pieces.length) {
    const ring = pieces.pop();
    for (let guard = 0; guard < 5000 && !eqPt(ring[0], ring[ring.length - 1]); guard++) {
      const end = ring[ring.length - 1];
      let idx = -1, rev = false;
      for (let i = 0; i < pieces.length; i++) {
        if (eqPt(pieces[i][0], end)) { idx = i; break; }
        if (eqPt(pieces[i][pieces[i].length - 1], end)) { idx = i; rev = true; break; }
      }
      if (idx < 0) break;
      const p = pieces.splice(idx, 1)[0];
      if (rev) p.reverse();
      for (let k = 1; k < p.length; k++) ring.push(p[k]);
    }
    if (ring.length >= 4 && eqPt(ring[0], ring[ring.length - 1])) rings.push(ring);
    else unclosed++;
  }
  return rings;
}
const toXY = (g) => g.map((p) => proj.toXY(p.lat, p.lon));
// even-odd scanline fill of a feature's rings into `water` (cell centres)
function fillRings(rings, v = 1, into = water) {
  let yLo = Infinity, yHi = -Infinity;
  for (const r of rings) for (const [, y] of r) { if (y < yLo) yLo = y; if (y > yHi) yHi = y; }
  const r0 = Math.max(0, rowOf(yLo)), r1 = Math.min(H - 1, rowOf(yHi));
  for (let r = r0; r <= r1; r++) {
    const yc = cyOf(r);
    const xs = [];
    for (const ring of rings) for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
      if ((ay <= yc) === (by <= yc)) continue;
      xs.push(ax + (yc - ay) / (by - ay) * (bx - ax));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - X0) / CELL - 0.5)), c1 = Math.min(W - 1, Math.floor((xs[k + 1] - X0) / CELL - 0.5));
      for (let c = c0; c <= c1; c++) into[r * W + c] = v;
    }
  }
}
const isWaterFeature = (t) => t && (t.natural === 'water' || t.natural === 'bay' || t.waterway === 'riverbank' || t.waterway === 'dock');
const basins = []; // named water polygons, for the street-name layer
let polyCount = 0;
for (const el of osm.elements) {
  if (!isWaterFeature(el.tags)) continue;
  const rings = ringsOf(el).map(toXY);
  if (!rings.length) continue;
  polyCount++;
  fillRings(rings);
  if (el.tags.name) {
    let area = 0, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const ring of rings) {
      let a = 0;
      for (let i = 0; i + 1 < ring.length; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      area = Math.max(area, Math.abs(a) / 2);
      for (const [x, y] of ring) { if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y; }
    }
    basins.push({ name: el.tags.name, rings, area, bbox: [bx0, by0, bx1, by1] });
  }
}
let polyCells = 0;
for (let i = 0; i < N; i++) polyCells += water[i];
log(`water polygons: ${polyCount} (${basins.length} named${unclosed ? `, ${unclosed} unclosed rings skipped` : ''}) → ${(polyCells * CELL * CELL / 1e6).toFixed(2)} km² of water`);

// The COASTLINE closes the picture where OSM maps the sea by its shore alone:
// every coastline way is burnt into the grid as a barrier (an 8-connected
// line, which a 4-connected flood cannot cross), the cells between barriers
// are grouped into components, and each component is voted water or land by
// the coastline's own convention — land on the LEFT of the way, water on the
// RIGHT — from a seed a few cells off every segment on either side. A
// majority decides, so one mapper's reversed way cannot flip a basin.
const seedsW = [], seedsL = [];
let coastSegs = 0;
function burn(c0, r0, c1, r1) {
  const dc = Math.abs(c1 - c0), dr = -Math.abs(r1 - r0);
  const sc = c0 < c1 ? 1 : -1, sr = r0 < r1 ? 1 : -1;
  let err = dc + dr, c = c0, r = r0;
  for (;;) {
    if (inGrid(c, r)) barrier[r * W + c] = 1;
    if (c === c1 && r === r1) break;
    const e2 = 2 * err;
    if (e2 >= dr) { err += dr; c += sc; }
    if (e2 <= dc) { err += dc; r += sr; }
  }
}
for (const el of osm.elements) {
  if (el.type !== 'way' || el.tags?.natural !== 'coastline' || !el.geometry) continue;
  const g = toXY(el.geometry);
  for (let i = 0; i + 1 < g.length; i++) {
    const [ax, ay] = g[i], [bx, by] = g[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (!len) continue;
    coastSegs++;
    burn(colOf(ax), rowOf(ay), colOf(bx), rowOf(by));
    const nx = (by - ay) / len, ny = -(bx - ax) / len; // right-hand normal (x east, y north)
    const mx = (ax + bx) / 2, my = (ay + by) / 2, off = 2.5 * CELL;
    const cw = colOf(mx + nx * off), rw = rowOf(my + ny * off);
    const cl = colOf(mx - nx * off), rl = rowOf(my - ny * off);
    if (inGrid(cw, rw) && !barrier[rw * W + cw]) seedsW.push(rw * W + cw);
    if (inGrid(cl, rl) && !barrier[rl * W + cl]) seedsL.push(rl * W + cl);
  }
}
const comp = new Int32Array(N).fill(-1);
const queue = new Int32Array(N);
let nComp = 0;
for (let s = 0; s < N; s++) {
  if (barrier[s] || comp[s] >= 0) continue;
  const id = nComp++;
  let qh = 0, qt = 0;
  queue[qt++] = s; comp[s] = id;
  while (qh < qt) {
    const i = queue[qh++];
    const c = i % W, r = (i - c) / W;
    if (c > 0 && !barrier[i - 1] && comp[i - 1] < 0) { comp[i - 1] = id; queue[qt++] = i - 1; }
    if (c < W - 1 && !barrier[i + 1] && comp[i + 1] < 0) { comp[i + 1] = id; queue[qt++] = i + 1; }
    if (r > 0 && !barrier[i - W] && comp[i - W] < 0) { comp[i - W] = id; queue[qt++] = i - W; }
    if (r < H - 1 && !barrier[i + W] && comp[i + W] < 0) { comp[i + W] = id; queue[qt++] = i + W; }
  }
}
const votesW = new Int32Array(nComp), votesL = new Int32Array(nComp);
for (const i of seedsW) if (comp[i] >= 0) votesW[comp[i]]++;
for (const i of seedsL) if (comp[i] >= 0) votesL[comp[i]]++;
let seaComps = 0, seaCells = 0;
const compWater = new Uint8Array(nComp);
for (let k = 0; k < nComp; k++) if (votesW[k] > votesL[k]) { compWater[k] = 1; seaComps++; }
for (let i = 0; i < N; i++) if (!water[i] && comp[i] >= 0 && compWater[comp[i]]) { water[i] = 1; seaCells++; }
log(`coastline: ${coastSegs} segments, ${nComp} components, ${seaComps} voted water (+${(seaCells * CELL * CELL / 1e6).toFixed(2)} km² of sea)`);
// A coastline is a shore — except where OSM closes the sea across a harbour
// mouth and maps the basin behind it as a water polygon (Inderhavnen): that
// closing line has water on BOTH sides and must not stand as a 4 m wall in the
// middle of the channel. A barrier cell with water on two opposite sides
// dissolves; a shore keeps its land on one side and stays.
let dissolved = 0;
for (let pass = 0; pass < 3; pass++) {
  const open = [];
  for (let i = 0; i < N; i++) {
    if (!barrier[i] || water[i]) continue;
    const c = i % W, r = (i - c) / W;
    if (c < 1 || r < 1 || c > W - 2 || r > H - 2) continue;
    const w = (j) => water[j] === 1;
    if ((w(i - W) && w(i + W)) || (w(i - 1) && w(i + 1)) || (w(i - W - 1) && w(i + W + 1)) || (w(i - W + 1) && w(i + W - 1))) open.push(i);
  }
  for (const i of open) water[i] = 1;
  dissolved += open.length;
  if (!open.length) break;
}
// PIERS are land too. OSM maps a pier area over the water polygon, not as a
// hole in it, and the base map draws it as quay — a course across the piers
// under Knippelsbro reads as a boat over a jetty. Closed pier outlines only: a
// linear pier is a gangway a few metres wide, and the harbour bus berths at it.
const pier = new Uint8Array(N);
let pierCount = 0;
for (const el of osm.elements) {
  if (el.tags?.man_made !== 'pier') continue;
  const rings = ringsOf(el).map(toXY);
  if (!rings.length) continue;
  fillRings(rings, 1, pier);
  pierCount++;
}
for (let i = 0; i < N; i++) if (pier[i]) water[i] = 0;
log(`piers: ${pierCount} closed outlines cut out of the water`);
// shores are land, and so is everything past the grid's edge
for (let i = 0; i < N; i++) if (barrier[i] && !water[i]) water[i] = 0;
for (let c = 0; c < W; c++) { water[c] = 0; water[(H - 1) * W + c] = 0; }
for (let r = 0; r < H; r++) { water[r * W] = 0; water[r * W + W - 1] = 0; }
let waterCells = 0;
for (let i = 0; i < N; i++) waterCells += water[i];
log(`mask: ${(waterCells * CELL * CELL / 1e6).toFixed(2)} km² of water, ${dissolved} harbour-mouth barrier cells dissolved`);

// A coastline with a hole in it (a way missing from the extract) lets the
// component vote flood a whole district as sea. Known dry points must be dry,
// or the harbour is not drawn at all — an old courses file stays in place.
const LAND_PROBES = [
  ['Rådhuspladsen', 55.6761, 12.5683], ['Christianshavns Torv', 55.6727, 12.5915],
  ['Kastellet', 55.6905, 12.5950], ['Refshaleøen', 55.6935, 12.6130],
  ['Nordhavn, Århusgade', 55.7060, 12.5890], ['Amagerbro', 55.6630, 12.6030],
  ['Islands Brygge', 55.6640, 12.5770], ['Sydhavn, Sluseholmen', 55.6440, 12.5460],
];
const wet = LAND_PROBES.filter(([, la, lo]) => {
  const [x, y] = proj.toXY(la, lo), c = colOf(x), r = rowOf(y);
  return inGrid(c, r) && water[r * W + c];
});
if (wet.length) {
  console.error(`harbour: the water mask floods known land (${wet.map((p) => p[0]).join(', ')}) — a coastline way is missing from ${WATER_FILE}; nothing written`);
  process.exit(1);
}

// ---------- 4) clearance: exact Euclidean distance to the nearest land cell ----------
// Felzenszwalb–Huttenlocher, one 1-D pass per column then per row.
const clear = new Float32Array(N);
{
  const INF = 1e20;
  const f = new Float64Array(Math.max(W, H)), d = new Float64Array(Math.max(W, H));
  const v = new Int32Array(Math.max(W, H)), z = new Float64Array(Math.max(W, H) + 1);
  const dt1d = (n) => {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  const g = new Float64Array(N);
  for (let c = 0; c < W; c++) {
    for (let r = 0; r < H; r++) f[r] = water[r * W + c] ? INF : 0;
    dt1d(H);
    for (let r = 0; r < H; r++) g[r * W + c] = d[r];
  }
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) f[c] = g[r * W + c];
    dt1d(W);
    for (let c = 0; c < W; c++) clear[r * W + c] = water[r * W + c] ? Math.sqrt(d[c]) * CELL : 0;
  }
}
const clearAt = (x, y) => { const c = colOf(x), r = rowOf(y); return inGrid(c, r) ? clear[r * W + c] : 0; };
log('clearance field computed');

// ---------- 5) a course per stop pair ----------
// A stop is drawn ON LAND: the feed's pontoon coordinate lies as often in the
// water as on the quay, and a disc floating mid-basin reads as a boat, not a
// call. So each stop gets a BERTH — the point BERTH_DEPTH cells inside the quay
// edge nearest to the pontoon, on a quay that borders the harbour water the
// courses ride (not a park pond) — and every course starts and ends exactly
// there. build.mjs puts the stop disc on the berth. Out of the berth the course
// runs to the nearest water cell with a little clearance, and from there
// through the grid.
// the harbour water: every water cell 4-connected to a cell deep enough to route
const harbourWater = new Uint8Array(N);
{
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (water[i] && clear[i] >= CLEAR_MIN * 4 && !harbourWater[i]) {
    harbourWater[i] = 1; queue[qt++] = i;
    while (qh < qt) {
      const j = queue[qh++], c = j % W;
      for (const k of [c > 0 ? j - 1 : -1, c < W - 1 ? j + 1 : -1, j - W, j + W]) {
        if (k < 0 || k >= N || !water[k] || harbourWater[k]) continue;
        harbourWater[k] = 1; queue[qt++] = k;
      }
    }
    qh = qt = 0;
  }
}
function berth(x, y) {
  const c0 = colOf(x), r0 = rowOf(y), R = Math.ceil(BERTH_MAX / CELL);
  let best = null;
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
    const c = c0 + dc, r = r0 + dr;
    if (c < BERTH_DEPTH + 1 || r < BERTH_DEPTH + 1 || c > W - BERTH_DEPTH - 2 || r > H - BERTH_DEPTH - 2) continue;
    const i = r * W + c;
    if (water[i]) continue;
    const d = Math.hypot(cxOf(c) - x, cyOf(r) - y);
    if (d > BERTH_MAX || (best && d >= best.d)) continue;
    // exactly D cells from harbour water: none nearer, some at that ring. A
    // PIER is the pontoon itself — a few metres wide, so any cell of it will do
    const D = pier[i] ? 1 : BERTH_DEPTH;
    let near = false, ring = false;
    for (let er = -D; er <= D && !near; er++) for (let ec = -D; ec <= D; ec++) {
      if (!harbourWater[(r + er) * W + c + ec]) continue;
      const m = Math.max(Math.abs(er), Math.abs(ec));
      if (m < D) { near = true; break; }
      ring = true;
    }
    if (near || !ring) continue;
    best = { i, d, x: cxOf(c), y: cyOf(r) };
  }
  return best;
}
// the water point out of a berth: the nearest cell with CLEAR_SNAP m of water
// around it that the berth SEES — the straight run out of the quay may cross
// land only within LAND_OK, never a pier farther out
function snap(x, y) {
  const c0 = colOf(x), r0 = rowOf(y), R = Math.ceil(SNAP_MAX / CELL);
  const sees = (tx, ty) => {
    const L = Math.hypot(tx - x, ty - y), k = Math.ceil(L);
    for (let s = 1; s < k; s++) if (L * s / k > LAND_OK && clearAt(x + (tx - x) * s / k, y + (ty - y) * s / k) <= 0) return false;
    return true;
  };
  let best = null;
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
    const c = c0 + dc, r = r0 + dr;
    if (!inGrid(c, r)) continue;
    const i = r * W + c;
    if (!water[i] || clear[i] < CLEAR_SNAP) continue;
    const d = Math.hypot(cxOf(c) - x, cyOf(r) - y);
    if (d <= SNAP_MAX && (!best || d < best.d) && sees(cxOf(c), cyOf(r))) best = { i, d };
  }
  return best;
}
// A* on the 8-connected grid, water cells with clearance ≥ CLEAR_MIN only;
// a step costs its length × (1 + K_MID / clearance), tripled inside the
// CLEAR_MID corridor along the shore — the cheapest course runs mid-channel,
// and comes near a quay only where the channel leaves no choice, or to berth.
const gCost = new Float64Array(N), stamp = new Int32Array(N), came = new Int32Array(N), closed = new Uint8Array(N);
let gen = 0;
const heapK = [], heapV = [];
const hPush = (k, v) => {
  heapK.push(k); heapV.push(v);
  let i = heapK.length - 1;
  while (i > 0) { const p = (i - 1) >> 1; if (heapK[p] <= heapK[i]) break; [heapK[p], heapK[i]] = [heapK[i], heapK[p]]; [heapV[p], heapV[i]] = [heapV[i], heapV[p]]; i = p; }
};
const hPop = () => {
  const k = heapK[0], v = heapV[0];
  const lk = heapK.pop(), lv = heapV.pop();
  if (heapK.length) {
    heapK[0] = lk; heapV[0] = lv;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < heapK.length && heapK[l] < heapK[m]) m = l;
      if (r < heapK.length && heapK[r] < heapK[m]) m = r;
      if (m === i) break;
      [heapK[m], heapK[i]] = [heapK[i], heapK[m]]; [heapV[m], heapV[i]] = [heapV[i], heapV[m]];
      i = m;
    }
  }
  return [k, v];
};
const NB = [[1, 0, CELL], [-1, 0, CELL], [0, 1, CELL], [0, -1, CELL], [1, 1, CELL * Math.SQRT2], [1, -1, CELL * Math.SQRT2], [-1, 1, CELL * Math.SQRT2], [-1, -1, CELL * Math.SQRT2]];
function astar(start, goal) {
  gen++;
  heapK.length = 0; heapV.length = 0;
  const gc = goal % W, gr = (goal - gc) / W;
  const h = (i) => { const c = i % W, r = (i - c) / W; return Math.hypot((c - gc) * CELL, (r - gr) * CELL); };
  stamp[start] = gen; gCost[start] = 0; came[start] = -1; closed[start] = 0;
  hPush(h(start), start);
  let expanded = 0;
  while (heapK.length) {
    const [, i] = hPop();
    if (stamp[i] === gen && closed[i]) continue;
    closed[i] = 1;
    expanded++;
    if (i === goal) {
      const path = [];
      for (let j = i; j >= 0; j = came[j]) path.push([cxOf(j % W), cyOf((j - j % W) / W)]);
      return { path: path.reverse(), expanded };
    }
    const c = i % W, r = (i - c) / W;
    for (const [dc, dr, len] of NB) {
      const nc = c + dc, nr = r + dr;
      if (!inGrid(nc, nr)) continue;
      const j = nr * W + nc;
      if (!water[j] || clear[j] < CLEAR_MIN) continue;
      if (stamp[j] === gen && closed[j]) continue;
      const ng = gCost[i] + len * (1 + K_MID / clear[j]) * (clear[j] < CLEAR_MID ? CORR_PEN : 1);
      if (stamp[j] !== gen || ng < gCost[j]) {
        stamp[j] = gen; gCost[j] = ng; came[j] = i; closed[j] = 0;
        hPush(ng + h(j), j);
      }
    }
  }
  return null;
}
// every point of the straight a→b lies in water with at least `minClear` m to spare
const segmentClear = (a, b, minClear) => {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(L / (CELL / 2)));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    if (clearAt(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])) < minClear) return false;
  }
  return true;
};
const distToSeg = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};
// Douglas–Peucker that also refuses a chord leaving the water: a vertex is
// dropped only when the straightened stretch stays ≥ CLEAR_SNAP m from land
function simplify(pts) {
  const out = [pts[0]];
  const rec = (i, j) => {
    let bi = -1, bd = -1;
    for (let k = i + 1; k < j; k++) { const d = distToSeg(pts[k], pts[i], pts[j]); if (d > bd) { bd = d; bi = k; } }
    if (bi >= 0 && (bd > DP_TOL || !segmentClear(pts[i], pts[j], CLEAR_SNAP))) { rec(i, bi); rec(bi, j); }
    else out.push(pts[j]);
  };
  rec(0, pts.length - 1);
  return out;
}
// Elastic band over a whole CHAIN of courses: every interior vertex moves
// halfway toward the midpoint of its neighbours, SMOOTH_ITER times, the chain's
// ends fixed — a discrete curvature flow that rounds the grid corners into a
// boat's course. The stops INSIDE the chain are not corners: their vertices
// flow too, held on a leash of STOP_DRIFT m around their water point, so a
// line runs through a call as one curve instead of breaking into a V at every
// pontoon. A move is refused when it would bring the vertex nearer to land than
// CLEAR_SMOOTH, or nearer than it already is where the channel is tighter than
// that; the audit below re-checks the finished curve every metre.
// The leash is a CONE, not a single pinned vertex: a lone pin concentrates the
// whole turn in that one vertex and the curve kinks there again (Islands
// Brygge Syd), so the neighbours within LEASH_K vertices are held too, each on
// a leash growing by LEASH_SLOPE m per metre away from the call.
//
// Two flows. First a short LAPLACIAN pass (SMOOTH_ITER steps) irons out the
// grid staircase. Then a long BENDING flow (bi-Laplacian, BEND_ITER steps)
// penalises curvature instead of length. A Laplacian flow always leaves a
// corner wherever a vertex is held, which is exactly the V the calls
// showed (44–58° off straight measured on 14.09). Under bending the curve
// threads the leash disc of a call and bends before and after it.
// Stage one, the WATER COURSE: the calls are not pinned yet. Every stop vertex
// flows too, on a STOP_DRIFT leash around its water point, and the chain's two
// ends slide toward the straight continuation of the curve — one curve that
// never breaks into a V at a pontoon (4–14° off straight measured on 14.09).
function relaxLeash(P, pins) {
  const anchor = new Map(pins.map((i) => [i, P[i].slice()]));
  const n = P.length;
  const tryMove = (Q, i, tx, ty) => {
    const an = anchor.get(i);
    if (an) {
      const dx = tx - an[0], dy = ty - an[1], d = Math.hypot(dx, dy);
      if (d > STOP_DRIFT) { tx = an[0] + dx / d * STOP_DRIFT; ty = an[1] + dy / d * STOP_DRIFT; }
    }
    if (clearAt(tx, ty) >= Math.min(CLEAR_SMOOTH, clearAt(P[i][0], P[i][1]))) Q[i] = [tx, ty];
  };
  for (let it = 0; it < SMOOTH_ITER; it++) {
    const Q = P.slice();
    for (let i = 1; i + 1 < n; i++) {
      tryMove(Q, i, P[i][0] + 0.5 * ((P[i - 1][0] + P[i + 1][0]) / 2 - P[i][0]),
        P[i][1] + 0.5 * ((P[i - 1][1] + P[i + 1][1]) / 2 - P[i][1]));
    }
    P = Q;
  }
  for (let it = 0; it < BEND_ITER; it++) {
    const Q = P.slice();
    for (let i = 1; i + 1 < n; i++) {
      let tx, ty;
      if (i >= 2 && i + 2 < n) {
        const fx = P[i - 2][0] - 4 * P[i - 1][0] + 6 * P[i][0] - 4 * P[i + 1][0] + P[i + 2][0];
        const fy = P[i - 2][1] - 4 * P[i - 1][1] + 6 * P[i][1] - 4 * P[i + 1][1] + P[i + 2][1];
        tx = P[i][0] - BEND_RATE * fx; ty = P[i][1] - BEND_RATE * fy;
      } else {
        tx = P[i][0] + 0.25 * (P[i - 1][0] + P[i + 1][0] - 2 * P[i][0]);
        ty = P[i][1] + 0.25 * (P[i - 1][1] + P[i + 1][1] - 2 * P[i][1]);
      }
      tryMove(Q, i, tx, ty);
    }
    for (const [e, a, b] of [[0, 1, 2], [n - 1, n - 2, n - 3]]) {
      if (n < 3) break;
      tryMove(Q, e, P[e][0] + 0.2 * (2 * P[a][0] - P[b][0] - P[e][0]), P[e][1] + 0.2 * (2 * P[a][1] - P[b][1] - P[e][1]));
    }
    for (let i = 1; i + 1 < n; i++) {
      const mx = (Q[i - 1][0] + Q[i + 1][0]) / 2, my = (Q[i - 1][1] + Q[i + 1][1]) / 2;
      const ex = Q[i + 1][0] - Q[i - 1][0], ey = Q[i + 1][1] - Q[i - 1][1], el = Math.hypot(ex, ey) || 1;
      const sp = ((mx - Q[i][0]) * ex + (my - Q[i][1]) * ey) / el;
      const tx = Q[i][0] + 0.3 * sp * ex / el, ty = Q[i][1] + 0.3 * sp * ey / el;
      if (clearAt(tx, ty) >= Math.min(CLEAR_SMOOTH, clearAt(Q[i][0], Q[i][1]))) Q[i] = [tx, ty];
    }
    P = Q;
  }
  return P;
}
// Stage two, DOCKING: each call's vertex is carried onto its berth, and the
// course on either side follows it with a weight falling off as (1 - s/L)^2 —
// the boat turns in over the last L metres, not in the last vertex. The
// longest L that keeps the stretch off land (past LAND_OK from the berth) wins:
// DOCK_MAX where the quay is open, shorter into a notch; never more than
// 45 % of the way to the neighbouring call.
function dock(S, pins, berthXY) {
  let out = S.map((p) => p.slice());
  const n = S.length;
  const landAround = (Pts, lo, hi, bx, by) => {
    let m = 0;
    for (let i = Math.max(1, lo); i <= Math.min(n - 1, hi); i++) {
      const a = Pts[i - 1], b = Pts[i], k = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
      for (let t = 0; t < k; t++) {
        const x = a[0] + (b[0] - a[0]) * t / k, y = a[1] + (b[1] - a[1]) * t / k;
        if (Math.hypot(x - bx, y - by) > LAND_OK && clearAt(x, y) <= 0) m++;
      }
    }
    return m;
  };
  pins.forEach((pi, k) => {
    const [bx, by] = berthXY[k];
    const dx = bx - out[pi][0], dy = by - out[pi][1];
    const room = (j) => (j < 0 || j >= pins.length ? Infinity : Math.abs(pins[j] - pi) * SMOOTH_STEP * 0.45);
    let best = null;
    for (let L = Math.min(DOCK_MAX, room(k - 1), room(k + 1)); L >= SMOOTH_STEP * 2; L -= SMOOTH_STEP) {
      const reach = Math.floor(L / SMOOTH_STEP);
      const T = out.map((p) => p.slice());
      for (let o = -reach; o <= reach; o++) {
        const i = pi + o;
        if (i < 0 || i >= n) continue;
        const u = Math.abs(o) * SMOOTH_STEP / L, w = (1 - u) * (1 - u);
        T[i][0] += dx * w; T[i][1] += dy * w;
      }
      const m = landAround(T, pi - reach, pi + reach + 1, bx, by);
      if (!best || m < best.m) best = { T, m };
      if (!m) break;
    }
    out = best.T;
  });
  return out;
}
// Stage three: the docked course bent smooth again, the calls PINNED to their
// berths.
function relaxChain(P, pins, iters = BEND_ITER) {
  const fixed = new Set(pins);
  const berths = pins.map((i) => P[i].slice());
  const n = P.length;
  // the clearance a point must keep: none within LAND_OK of a berth (the course
  // leaves the quay there), then a straight ramp up to CLEAR_SMOOTH — a boat
  // pulls away from its pontoon at an angle, not along the quay
  const need = (x, y) => {
    let d = Infinity;
    for (const b of berths) { const e = Math.hypot(x - b[0], y - b[1]); if (e < d) d = e; }
    return d <= LAND_OK ? -1 : Math.min(CLEAR_SMOOTH, (d - LAND_OK) * APPROACH);
  };
  const ok = (x, y, ox, oy) => {
    const nd = need(x, y);
    if (nd < 0) return true;
    const c = clearAt(x, y), oc = clearAt(ox, oy);
    // a vertex left on land by the docking may go anywhere — its edges are
    // what keeps it from wandering (edgesOk below)
    if (oc <= 0 && need(ox, oy) >= 0) return true;
    return c > 0 && c >= Math.min(nd, oc);
  };
  // …and so must the two edges out of it: a vertex in the water can still
  // draw an edge across the corner of a pier
  // (counted, not refused outright: an edge the grid path left over a corner
  // may still be walked off it, one metre less of land at a time)
  const dry = (a, b) => {
    const k = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
    let n = 0;
    for (let s = 1; s < k; s++) {
      const x = a[0] + (b[0] - a[0]) * s / k, y = a[1] + (b[1] - a[1]) * s / k;
      if (clearAt(x, y) <= 0 && need(x, y) >= 0) n++;
    }
    return n;
  };
  const edgesOk = (A, o, t, B) => dry(A, t) + dry(t, B) <= dry(A, o) + dry(o, B);
  const tryMove = (Q, i, tx, ty) => {
    if (fixed.has(i) || !ok(tx, ty, P[i][0], P[i][1])) return;
    const t = [tx, ty];
    // against Q: the neighbour behind has already moved this step
    if (!edgesOk(Q[i - 1], P[i], t, Q[i + 1])) return;
    Q[i] = t;
  };
  for (let it = 0; it < SMOOTH_ITER; it++) {
    const Q = P.slice();
    for (let i = 1; i + 1 < n; i++) {
      tryMove(Q, i, P[i][0] + 0.5 * ((P[i - 1][0] + P[i + 1][0]) / 2 - P[i][0]),
        P[i][1] + 0.5 * ((P[i - 1][1] + P[i + 1][1]) / 2 - P[i][1]));
    }
    P = Q;
  }
  for (let it = 0; it < iters; it++) {
    const Q = P.slice();
    for (let i = 1; i + 1 < n; i++) {
      let tx, ty;
      if (i >= 2 && i + 2 < n) {
        // fourth difference = discrete bending force
        const fx = P[i - 2][0] - 4 * P[i - 1][0] + 6 * P[i][0] - 4 * P[i + 1][0] + P[i + 2][0];
        const fy = P[i - 2][1] - 4 * P[i - 1][1] + 6 * P[i][1] - 4 * P[i + 1][1] + P[i + 2][1];
        tx = P[i][0] - BEND_RATE * fx; ty = P[i][1] - BEND_RATE * fy;
      } else {
        // next to a fixed chain end: plain Laplacian
        tx = P[i][0] + 0.25 * ((P[i - 1][0] + P[i + 1][0]) / 2 - P[i][0]) * 2;
        ty = P[i][1] + 0.25 * ((P[i - 1][1] + P[i + 1][1]) / 2 - P[i][1]) * 2;
      }
      tryMove(Q, i, tx, ty);
    }
    // a little Laplacian keeps the vertices evenly spaced along the curve
    for (let i = 1; i + 1 < n; i++) {
      if (fixed.has(i)) continue;
      const mx = (Q[i - 1][0] + Q[i + 1][0]) / 2, my = (Q[i - 1][1] + Q[i + 1][1]) / 2;
      const ex = Q[i + 1][0] - Q[i - 1][0], ey = Q[i + 1][1] - Q[i - 1][1], el = Math.hypot(ex, ey) || 1;
      // tangential component only: spacing, not shape
      const s = ((mx - Q[i][0]) * ex + (my - Q[i][1]) * ey) / el;
      const tx = Q[i][0] + 0.3 * s * ex / el, ty = Q[i][1] + 0.3 * s * ey / el;
      if (ok(tx, ty, Q[i][0], Q[i][1]) && edgesOk(Q[i - 1], Q[i], [tx, ty], Q[i + 1])) Q[i] = [tx, ty];
    }
    P = Q;
  }
  return P;
}
// the proof: the finished course, sampled every metre, is water everywhere but
// the LAND_OK metres out of each of its two berths
function audit(pts) {
  let minC = Infinity, minCInner = Infinity, minAt = null, land = 0, len = 0;
  const A = pts[0], B = pts[pts.length - 1];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  len = cum[cum.length - 1];
  for (let i = 1; i < pts.length; i++) {
    const L = cum[i] - cum[i - 1], n = Math.max(1, Math.ceil(L));
    for (let k = 0; k <= n; k++) {
      const t = k / n, x = pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), y = pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1]);
      const c = clearAt(x, y), at = cum[i - 1] + t * L;
      if (Math.min(Math.hypot(x - A[0], y - A[1]), Math.hypot(x - B[0], y - B[1])) <= LAND_OK + 0.5) continue;
      if (c <= 0 && !land++) minAt = [x, y];
      if (c < minC) minC = c;
      if (!land && at > 60 && at < len - 60 && c < minCInner) { minCInner = c; minAt = [x, y]; }
    }
  }
  return { minC, minCInner, minAt, land, len };
}

const snapOf = new Map(); // stop id → { i, x, y, d, bx, by, bd } — water point and berth
for (const [id, s] of stops) {
  const [x, y] = proj.toXY(s.lat, s.lon);
  const q = berth(x, y);
  if (!q) { log(`WARNING: ${s.name} — no quay on the harbour within ${BERTH_MAX} m of the pontoon`); continue; }
  const b = snap(q.x, q.y);
  if (!b) { log(`WARNING: ${s.name} — no water with ${CLEAR_SNAP} m clearance within ${SNAP_MAX} m of the berth`); continue; }
  snapOf.set(id, { i: b.i, x: cxOf(b.i % W), y: cyOf((b.i - b.i % W) / W), d: b.d, bx: q.x, by: q.y, bd: q.d });
  log(`  berth ${s.name}: ${Math.round(q.d)} m from the feed's coordinate (${water[rowOf(y) * W + colOf(x)] ? 'in the water' : 'on land'}), water point ${Math.round(b.d)} m out`);
}
// 5a) a raw course per stop pair: berth → A* through the water → berth
const legs = []; // { a, b, raw, simple, expanded }
for (const [, [a, b]] of pairs) {
  const A = snapOf.get(a), B = snapOf.get(b);
  const na = stops.get(a).name, nb = stops.get(b).name;
  if (!A || !B) { log(`SKIPPED ${na} – ${nb}: a stop without water`); continue; }
  const res = astar(A.i, B.i);
  if (!res) { log(`SKIPPED ${na} – ${nb}: no water course with ${CLEAR_MIN} m clearance joins the two`); continue; }
  const wet = simplify(res.path);
  legs.push({ a, b, raw: [[A.bx, A.by], ...res.path, [B.bx, B.by]], wet, simple: [[A.bx, A.by], ...wet, [B.bx, B.by]], expanded: res.expanded });
}
// 5b) the legs chained through every stop that joins exactly two of them —
// the harbour line is one chain Orientkaj … Teglholmen — and each chain
// smoothed as ONE curve, then cut back into its legs at the stop vertices
const adj = new Map(); // stop → leg indices
legs.forEach((l, li) => { for (const s of [l.a, l.b]) { if (!adj.has(s)) adj.set(s, []); adj.get(s).push(li); } });
const usedLeg = new Uint8Array(legs.length);
const chains = [];
const walk = (start, li) => {
  const seq = [start], ls = [];
  let cur = start, l = li;
  for (;;) {
    usedLeg[l] = 1; ls.push(l);
    const nxt = legs[l].a === cur ? legs[l].b : legs[l].a;
    seq.push(nxt);
    const deg = adj.get(nxt);
    if (deg.length !== 2 || nxt === start) break;
    const l2 = deg[0] === l ? deg[1] : deg[0];
    if (usedLeg[l2]) break;
    cur = nxt; l = l2;
  }
  chains.push({ stops: seq, legs: ls });
};
for (const [s, ls] of adj) if (ls.length !== 2) for (const l of ls) if (!usedLeg[l]) walk(s, l);
for (const [s, ls] of adj) for (const l of ls) if (!usedLeg[l]) walk(s, l); // closed loops, if any
const courses = []; // { a, b, pts (xy), raw, simple, stats }
for (const ch of chains) {
  // one polyline for the chain from the water-only legs ('wet') or the legs
  // with their berth runs ('simple'); `pins` are the call vertices
  const build = (key) => {
    const P = [], pins = [0];
    ch.legs.forEach((li, k) => {
      const leg = legs[li];
      const pts = resample(leg.a === ch.stops[k] ? leg[key] : [...leg[key]].reverse(), SMOOTH_STEP);
      P.push(...(k === 0 ? pts : pts.slice(1)));
      pins.push(P.length - 1);
    });
    return { P, pins };
  };
  const cutBy = (Pts, pins, k) => {
    const leg = legs[ch.legs[k]];
    const pts = Pts.slice(pins[k], pins[k + 1] + 1);
    return leg.a === ch.stops[k] ? pts : pts.reverse(); // stored in the leg's a → b order
  };
  const landIn = (Pts, pins, what) => {
    let bad = false;
    ch.legs.forEach((li, k) => {
      const st = audit(cutBy(Pts, pins, k));
      if (!st.land) return;
      bad = true;
      const [lon, lat] = proj.toLonLat(st.minAt[0], st.minAt[1]);
      log(`  ${what} ${stops.get(legs[li].a).name} – ${stops.get(legs[li].b).name}: ${st.land} land samples from @${lat.toFixed(5)},${lon.toFixed(5)}`);
    });
    return bad;
  };
  const berthXY = ch.stops.map((id) => [snapOf.get(id).bx, snapOf.get(id).by]);
  // the water course, docked at the berths, bent smooth with the calls pinned
  const wet = build('wet');
  let pins = wet.pins;
  let Q = relaxChain(dock(relaxLeash(wet.P, pins), pins, berthXY), pins, DOCK_ITER);
  if (landIn(Q, pins, 'docked')) {
    // cannot happen by construction — but a course on land would be the one
    // unforgivable drawing, so the berth-to-berth simplified chain stands in
    log(`WARNING chain ${stops.get(ch.stops[0]).name} … ${stops.get(ch.stops[ch.stops.length - 1]).name}: the docked curve touched land — drawing the simplified courses instead`);
    ({ P: Q, pins } = build('simple'));
  }
  const inner = pins.slice(1, -1);
  const cut = (Pts, k) => cutBy(Pts, pins, k);
  // the turn a call makes: the angle between the course 30 m before and after its berth
  const turnAt = (i) => {
    const back = (s) => { let k = i; while (k > 0 && Math.hypot(Q[k][0] - Q[i][0], Q[k][1] - Q[i][1]) < s) k += -1; return Q[k]; };
    const fwd = (s) => { let k = i; while (k < Q.length - 1 && Math.hypot(Q[k][0] - Q[i][0], Q[k][1] - Q[i][1]) < s) k++; return Q[k]; };
    const a = back(30), b = fwd(30);
    const h1 = Math.atan2(Q[i][1] - a[1], Q[i][0] - a[0]), h2 = Math.atan2(b[1] - Q[i][1], b[0] - Q[i][0]);
    return Math.abs(((h2 - h1) * 180 / Math.PI + 540) % 360 - 180);
  };
  log(`chain ${ch.stops.map((s) => stops.get(s).name.replace(/\s*\(.*\)$/, '')).join(' – ')}: ${Q.length} vertices, turn at the calls ${inner.map((i) => Math.round(turnAt(i)) + '°').join(' ')}`);
  ch.legs.forEach((li, k) => {
    const leg = legs[li], pts = cut(Q, k), st = audit(pts);
    courses.push({ a: leg.a, b: leg.b, pts, raw: leg.raw, simple: leg.simple, stats: st });
    const where = st.minAt ? proj.toLonLat(st.minAt[0], st.minAt[1]).map((v) => v.toFixed(5)).reverse().join(',') : '';
    log(`  ${stops.get(leg.a).name} – ${stops.get(leg.b).name}: ${(st.len / 1000).toFixed(2)} km, ${leg.raw.length} grid cells → ${leg.simple.length} vertices → ${pts.length} smoothed; min clearance ${st.minCInner.toFixed(0)} m mid-course (@${where}), ${st.minC.toFixed(0)} m at the quays (${leg.expanded} cells searched)${st.land ? ` — ${st.land} LAND SAMPLES` : ''}`);
  });
}

// ---------- 6) basin names ----------
const inRings = (rings, x, y) => {
  let inside = false;
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const basinAt = (x, y) => {
  let best = null;
  for (const b of basins) {
    if (x < b.bbox[0] || x > b.bbox[2] || y < b.bbox[1] || y > b.bbox[3]) continue;
    if ((!best || b.area < best.area) && inRings(b.rings, x, y)) best = b;
  }
  return best ? best.name : '';
};

// ---------- 7) synthetic ways + QA ----------
let nid = -7000000, wid = -7000000;
const stopNode = new Map(); // stop id → the node id of its water point (shared by every course touching it)
const nodeOf = (id) => { if (!stopNode.has(id)) stopNode.set(id, nid--); return stopNode.get(id); };
const elements = [];
const qa = [];
let totalLen = 0;
for (const co of courses) {
  // name per vertex, boundary wobbles absorbed, then one way per named stretch
  const names = co.pts.map(([x, y]) => basinAt(x, y));
  const runs = [];
  for (let i = 0; i < names.length; i++) {
    if (runs.length && runs[runs.length - 1].name === names[i]) runs[runs.length - 1].i1 = i;
    else runs.push({ name: names[i], i0: i, i1: i });
  }
  const spanM = (r) => (r.i1 - r.i0) * SMOOTH_STEP;
  for (let changed = true; changed && runs.length > 1;) {
    changed = false;
    for (let k = 0; k < runs.length; k++) {
      if (spanM(runs[k]) >= BASIN_MIN) continue;
      const prev = runs[k - 1], next = runs[k + 1];
      const into = prev && next ? (spanM(prev) >= spanM(next) ? prev : next) : (prev || next);
      if (!into) break;
      into.i0 = Math.min(into.i0, runs[k].i0); into.i1 = Math.max(into.i1, runs[k].i1);
      runs.splice(k, 1);
      // the wobble gone, its two neighbours may now be one basin
      for (let m = 0; m + 1 < runs.length; m++) {
        if (runs[m].name !== runs[m + 1].name) continue;
        runs[m].i1 = runs[m + 1].i1;
        runs.splice(m + 1, 1);
        m--;
      }
      changed = true;
      break;
    }
  }
  runs.sort((p, q) => p.i0 - q.i0);
  let prevNode = nodeOf(co.a);
  runs.forEach((r, ri) => {
    const last = ri === runs.length - 1;
    const i0 = ri === 0 ? 0 : runs[ri - 1].i1, i1 = last ? co.pts.length - 1 : r.i1;
    const nodes = [], geometry = [];
    for (let i = i0; i <= i1; i++) {
      const id = i === i0 ? prevNode : (i === co.pts.length - 1 ? nodeOf(co.b) : nid--);
      const [lon, lat] = proj.toLonLat(co.pts[i][0], co.pts[i][1]);
      nodes.push(id); geometry.push({ lat: round6(lat), lon: round6(lon) });
    }
    prevNode = nodes[nodes.length - 1];
    elements.push({ type: 'way', id: wid--, nodes, geometry, tags: { route: 'ferry', name: r.name } });
  });
  totalLen += co.stats.len;
  const ll = (pts) => pts.map(([x, y]) => { const [lon, lat] = proj.toLonLat(x, y); return [round6(lon), round6(lat)]; });
  const props = { from: stops.get(co.a).name, to: stops.get(co.b).name, km: Math.round(co.stats.len) / 1000, minClear: Math.round(co.stats.minCInner), basins: runs.map((r) => r.name || '—').join(' · ') };
  qa.push({ type: 'Feature', properties: { ...props, kind: 'course' }, geometry: { type: 'LineString', coordinates: ll(co.pts) } });
  qa.push({ type: 'Feature', properties: { ...props, kind: 'grid' }, geometry: { type: 'LineString', coordinates: ll(co.raw) } });
}
const berths = {}; // stop id → [lat, lon] of its berth — build.mjs draws the stop there
for (const [id, s] of snapOf) {
  const [lon, lat] = proj.toLonLat(s.x, s.y);
  const [blon, blat] = proj.toLonLat(s.bx, s.by);
  berths[id] = [round6(blat), round6(blon)];
  qa.push({ type: 'Feature', properties: { kind: 'water-point', name: stops.get(id).name, offM: Math.round(s.d) }, geometry: { type: 'Point', coordinates: [round6(lon), round6(lat)] } });
  qa.push({ type: 'Feature', properties: { kind: 'berth', name: stops.get(id).name, offM: Math.round(s.bd) }, geometry: { type: 'Point', coordinates: [round6(blon), round6(blat)] } });
  qa.push({ type: 'Feature', properties: { kind: 'pontoon', name: stops.get(id).name }, geometry: { type: 'Point', coordinates: [stops.get(id).lon, stops.get(id).lat] } });
}
writeFileSync(OUT_FILE, JSON.stringify({ version: 0.6, generator: 'pipeline/harbour.mjs', berths, elements }));
writeFileSync(QA_FILE, JSON.stringify({ type: 'FeatureCollection', features: qa }));
// --png: the mask as a picture (land dark, water lighter the farther from
// shore, the courses black) — the quickest way to see what the grid believes
if (ARGS.includes('--png')) {
  const { deflateSync } = await import('node:zlib');
  const S = 2, PW = Math.floor(W / S), PH = Math.floor(H / S);
  const px = new Uint8Array(PW * PH);
  for (let r = 0; r < PH; r++) for (let c = 0; c < PW; c++) {
    const i = (H - 1 - r * S) * W + c * S; // north up
    px[r * PW + c] = water[i] ? Math.min(240, 150 + clear[i] * 0.6) : 60;
  }
  for (const co of courses) for (const [x, y] of co.pts) {
    const c = Math.floor((x - X0) / CELL / S), r = PH - 1 - Math.floor((y - Y0) / CELL / S);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (c + dc >= 0 && r + dr >= 0 && c + dc < PW && r + dr < PH) px[(r + dr) * PW + c + dc] = 0;
  }
  const raw = new Uint8Array((PW + 1) * PH);
  for (let r = 0; r < PH; r++) { raw[r * (PW + 1)] = 0; raw.set(px.subarray(r * PW, (r + 1) * PW), r * (PW + 1) + 1); }
  const crcT = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c; }
  const crc = (buf) => { let c = -1; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const be = (v) => Buffer.from([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  const chunk = (type, data) => { const t = Buffer.from(type, 'latin1'); return Buffer.concat([be(data.length), t, data, be(crc(Buffer.concat([t, data])))]); };
  const ihdr = Buffer.concat([be(PW), be(PH), Buffer.from([8, 0, 0, 0, 0])]);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(join(ROOT, 'data/harbour-mask.png'), png);
  log(`wrote data/harbour-mask.png (${PW} × ${PH})`);
}
log(`wrote ${elements.length} route=ferry ways (${(totalLen / 1000).toFixed(1)} km of water courses, ${courses.length} stop pairs) → ${OUT_FILE.replace(ROOT + '\\', '').replace(ROOT + '/', '')}, QA → data/harbour-qa.geojson`);
