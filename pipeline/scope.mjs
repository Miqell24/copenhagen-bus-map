// Wyznacza zakres mapy Kopenhagi z KRAJOWEGO feedu Rejseplanen (cała Dania,
// ~1400 linii autobusowych) i zapisuje listę route_id do data/scope.json:
//
//  autobusy (route_type 3 + 700 — Movia numeruje S-busy 150S…600S kodem 700):
//   - linia należy do mapy, gdy >=50% jej przystanków leży w promieniu 20 km
//     od Rådhuspladsen — plan palców sięga dalej niż paryska petite couronne,
//     przy 15 km wypadały podmiejskie dowozy do S-tog (114–163, 150S);
//   - odpadają autobusy agencji Metroselskabet (metrobusy zastępcze o nazwach
//     M1/M2/M4) i DSB / DSB S-tog (togbusser) — dublują numery linii szynowych;
//   - odpadają linie z przystankiem dalej niż 35 km.
//  letbane (0): tylko Hovedstadens Letbane (linia L; Odense i Aarhus mają
//   własne „L" w tym samym feedzie).
//  metro (1): M1–M4 (Metroselskabet).
//  S-tog (109): wszystkie 7 linii DSB S-tog, bez reguły promienia — to szkielet.
//  poza mapą: kolej regionalna i lokaltog (2), promy portowe 991–993 (4).
//
// Uruchamiane przez download.sh po pobraniu GTFS; build.mjs wymaga wyniku.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iterCsv, readCsv } from './lib/csv.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GD = join(ROOT, 'data/gtfs');

const CX = 12.5683, CY = 55.6761;     // Rådhuspladsen
const CORE_KM = 20, CORE_SHARE = 0.5, CAP_KM = 45;
const BAD_BUS_AGENCIES = new Set(['Metroselskabet', 'DSB', 'DSB S-tog']);

const t0 = Date.now();
const log = (m) => console.log(`[scope ${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const agency = new Map();
for (const a of await readCsv(join(GD, 'agency.txt'))) agency.set(a.agency_id, a.agency_name);

const busCand = new Set(), tram = [], metro = [], stog = [];
for (const r of await readCsv(join(GD, 'routes.txt'))) {
  const an = agency.get(r.agency_id) || '';
  if (r.route_type === '3' || r.route_type === '700') {
    if (BAD_BUS_AGENCIES.has(an)) continue;
    busCand.add(r.route_id);
  } else if (r.route_type === '0') {
    if (an === 'Hovedstadens Letbane') tram.push(r.route_id);
  } else if (r.route_type === '1') {
    if (an === 'Metroselskabet') metro.push(r.route_id);
  } else if (r.route_type === '109') {
    if (an === 'DSB S-tog') stog.push(r.route_id);
  }
}
log(`kandydatów bus: ${busCand.size}, letbane: ${tram.length}, metro: ${metro.length}, S-tog: ${stog.length}`);

const mx = 111320 * Math.cos(48.85 * Math.PI / 180), my = 111132;
const stopKm = new Map();
for await (const s of iterCsv(join(GD, 'stops.txt'))) {
  const lat = Number(s.stop_lat), lon = Number(s.stop_lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    stopKm.set(s.stop_id, Math.hypot((lon - CX) * mx, (lat - CY) * my) / 1000);
  }
}
const t2r = new Map();
for await (const t of iterCsv(join(GD, 'trips.txt'))) {
  if (busCand.has(t.route_id)) t2r.set(t.trip_id, t.route_id);
}
log(`kursów autobusowych do zmierzenia: ${t2r.size}`);
// jeden strumień przez stop_times: per trasa zbiór przystanków → udział <=15 km i maksimum
const rStops = new Map();
for await (const st of iterCsv(join(GD, 'stop_times.txt'))) {
  const rid = t2r.get(st.trip_id);
  if (!rid) continue;
  let s = rStops.get(rid);
  if (!s) rStops.set(rid, (s = new Set()));
  s.add(st.stop_id);
}
const bus = [];
let cut = 0;
for (const [rid, stops] of rStops) {
  let n = 0, inside = 0, max = 0;
  for (const sid of stops) {
    const d = stopKm.get(sid);
    if (d === undefined) continue;
    n++; if (d <= CORE_KM) inside++; if (d > max) max = d;
  }
  if (!n) continue;
  if (inside / n < CORE_SHARE) continue;
  if (max > CAP_KM) { cut++; continue; }
  bus.push(rid);
}
log(`wybrano bus: ${bus.length} (odrzucone limitem ${CAP_KM} km: ${cut})`);
writeFileSync(join(ROOT, 'data/scope.json'),
  JSON.stringify({ bus: bus.sort(), tram: tram.sort(), metro: metro.sort(), stog: stog.sort() }, null, 0));
log('zapisano data/scope.json');
