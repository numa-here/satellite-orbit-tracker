/**
 * satellite-worker.js – Web Worker that computes satellite positions.
 * Propagates catalog positions and refreshes the selected inertial orbit path.
 *
 * Messages:
 *   { type: 'INIT', catalog: CatalogEntry[] }
 *   { type: 'COMPUTE', time: number }
 *   { type: 'SELECT', norad_id: number, time: number }
 *
 * Reply:
 *   { type: 'POSITIONS', positions: [latitude, longitude, altitudeKm...], valid }
 */

importScripts('/vendor/satellite.min.js');

const EARTH_RADIUS_KM = 6371.0;
let catalog = [];
let satrecs = {};
let ready = false;
let initIndex = 0;
let initGeneration = 0;
let pendingTime = null;
let pendingSelection = null;
let selectedOrbitNoradId = null;
const INIT_BATCH_SIZE = 250;

self.addEventListener('message', (e) => {
  const { type } = e.data;
  if (type === 'INIT') {
    catalog = e.data.catalog || [];
    satrecs = {};
    ready = false;
    initIndex = 0;
    pendingTime = null;
    pendingSelection = null;
    selectedOrbitNoradId = null;
    const generation = ++initGeneration;
    initializeCatalogBatch(generation);
  } else if (type === 'COMPUTE') {
    pendingTime = e.data.time;
    if (ready) {
      computePositions(pendingTime);
      if (selectedOrbitNoradId != null) computeSelectedOrbit(selectedOrbitNoradId, pendingTime);
      pendingTime = null;
    }
  } else if (type === 'SELECT') {
    selectedOrbitNoradId = e.data.norad_id;
    pendingSelection = { norad_id: e.data.norad_id, time: e.data.time };
    if (ready) {
      computeSelectedOrbit(pendingSelection.norad_id, pendingSelection.time);
      pendingSelection = null;
    }
  }
});

function initializeCatalogBatch(generation) {
  if (generation !== initGeneration) return;
  const end = Math.min(initIndex + INIT_BATCH_SIZE, catalog.length);
  for (; initIndex < end; initIndex++) {
    const entry = catalog[initIndex];
    const satrec = buildSatrec(entry);
    if (satrec) satrecs[entry.norad_id] = satrec;
  }
  self.postMessage({ type: 'INIT_PROGRESS', processed: initIndex, total: catalog.length });
  if (initIndex < catalog.length) {
    setTimeout(() => initializeCatalogBatch(generation), 0);
    return;
  }
  ready = true;
  self.postMessage({ type: 'READY', count: Object.keys(satrecs).length });
  if (pendingTime != null) {
    computePositions(pendingTime);
    pendingTime = null;
  }
  if (pendingSelection) {
    computeSelectedOrbit(pendingSelection.norad_id, pendingSelection.time);
    pendingSelection = null;
  }
}
function computePositions(timeMs) {
  const date = new Date(timeMs);
  const n = catalog.length;
  const positions = new Float32Array(n * 3);
  const valid = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const entry = catalog[i];
    const satrec = satrecs[entry.norad_id];
    if (!satrec) { valid[i] = 0; continue; }
    const result = propagatePosition(satrec, date, entry);
    if (!result) { valid[i] = 0; continue; }
    positions[i * 3] = result.latitude;
    positions[i * 3 + 1] = result.longitude;
    positions[i * 3 + 2] = result.altitudeKm;
    valid[i] = 1;
  }

  self.postMessage({
    type: 'POSITIONS', positions, valid,
  }, [positions.buffer, valid.buffer]);
}

// A selected orbit uses 180 propagation samples across one full period.
function computeSelectedOrbit(noradId, timeMs) {
  const satrec = satrecs[noradId];
  const entry = catalog.find(item => Number(item.norad_id) === Number(noradId));
  if (!satrec || !entry || !(satrec.no > 0)) {
    self.postMessage({ type: 'ORBITS', norad_id: noradId, paths: [] });
    return;
  }
  const periodMinutes = 2 * Math.PI / satrec.no;
  // Keep Earth fixed at the selection time while sampling this orbit. Using
  // each future sample's sidereal angle draws a rotating-frame ground track,
  // which twists and fails to close for most non-geostationary satellites.
  const fixedGmst = satellite.gstime(new Date(Number(timeMs)));
  const paths = [];
  let segment = [];
  let previousLongitude = null;
  let previousLatitude = null;
  let previousAltitude = null;
  for (let i = 0; i <= 180; i++) {
    const date = new Date(Number(timeMs) + periodMinutes * 60000 * i / 180);
    const result = satellite.propagate(satrec, date);
    if (!result?.position) {
      if (segment.length > 1) paths.push({ norad_id: entry.norad_id, name: entry.name, points: segment });
      segment = [];
      previousLongitude = null;
      previousLatitude = null;
      previousAltitude = null;
      continue;
    }
    const geo = satellite.eciToGeodetic(result.position, fixedGmst);
    if (!geo || !Number.isFinite(geo.height) || !Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)
      || geo.height < 0) {
      if (segment.length > 1) paths.push({ norad_id: entry.norad_id, name: entry.name, points: segment });
      segment = [];
      previousLongitude = null;
      previousLatitude = null;
      previousAltitude = null;
      continue;
    }
    const longitude = satellite.degreesLong(geo.longitude);
    const latitude = geo.latitude * 180 / Math.PI;
    const altitude = geo.height / EARTH_RADIUS_KM;
    if (previousLongitude !== null && Math.abs(longitude - previousLongitude) > 180) {
      const adjustedLongitude = longitude + (longitude < previousLongitude ? 360 : -360);
      const seamLongitude = previousLongitude > 0 ? 180 : -180;
      const fraction = (seamLongitude - previousLongitude) / (adjustedLongitude - previousLongitude);
      const seamPoint = {
        lat: previousLatitude + (latitude - previousLatitude) * fraction,
        lng: seamLongitude,
        alt: previousAltitude + (altitude - previousAltitude) * fraction,
      };
      segment.push(seamPoint);
      if (segment.length > 1) paths.push({ norad_id: entry.norad_id, name: entry.name, points: segment });
      segment = [{ ...seamPoint, lng: -seamLongitude }];
    }
    segment.push({
      lat: latitude,
      lng: longitude,
      alt: altitude,
    });
    previousLongitude = longitude;
    previousLatitude = latitude;
    previousAltitude = altitude;
  }
  if (segment.length > 1) paths.push({ norad_id: entry.norad_id, name: entry.name, points: segment });
  self.postMessage({ type: 'ORBITS', norad_id: entry.norad_id, paths });
}

/**
 * Build a satellite.js satrec from a catalog entry.
 * Prefers TLE lines; returns null if neither TLE nor usable OMM exists.
 */
function buildSatrec(entry) {
  try {
    if (entry.line1 && entry.line2) {
      const satrec = satellite.twoline2satrec(entry.line1, entry.line2);
      return satrec?.error === 0 ? satrec : null;
    }
    if (entry.omm && typeof satellite.json2satrec === 'function') {
      const satrec = satellite.json2satrec(entry.omm);
      return satrec?.error === 0 ? satrec : null;
    }
    return null;
  } catch (err) {
    console.warn('Failed to build satrec for', entry.norad_id, err);
    return null;
  }
}

/**
 * Propagate a satrec to geodetic latitude, longitude and altitude (km).
 */
function propagatePosition(satrec, date, entry) {
  try {
    const result = satellite.propagate(satrec, date);
    if (!result || !result.position) return null;

    const { position } = result;
    const gstime = satellite.gstime(date);
    const gd = satellite.eciToGeodetic(position, gstime);
    if (!gd) return null;

    const latitude = gd.latitude * 180 / Math.PI;
    const longitude = satellite.degreesLong(gd.longitude);
    const altitudeKm = gd.height;
    if (![latitude, longitude, altitudeKm].every(Number.isFinite) || altitudeKm < 0) return null;
    return { latitude, longitude, altitudeKm };
  } catch (err) {
    return null;
  }
}
