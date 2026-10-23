/**
 * Propagate catalog positions and selected satellite orbits off the UI thread.
 * Position and orbit coordinates are already in globe.gl's 100-unit world space.
 */
importScripts('/vendor/satellite.min.js');

const EARTH_RADIUS_KM = 6371;
const GLOBE_RADIUS = 100;
const ORBIT_SAMPLES = 240;
let catalog = [];
let satrecs = {};
let ready = false;
let initIndex = 0;
let initGeneration = 0;
let pendingTime = null;
let pendingSelection = null;
const INIT_BATCH_SIZE = 250;

self.addEventListener('message', event => {
  const { type } = event.data;
  if (type === 'INIT') {
    catalog = event.data.catalog || [];
    satrecs = {};
    ready = false;
    initIndex = 0;
    pendingTime = null;
    pendingSelection = null;
    initializeCatalogBatch(++initGeneration);
  } else if (type === 'COMPUTE') {
    pendingTime = event.data.time;
    if (ready) {
      computePositions(pendingTime);
      pendingTime = null;
    }
  } else if (type === 'SELECT') {
    pendingSelection = { norad_id: event.data.norad_id, time: event.data.time };
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

function geodeticToXyz(latitude, longitude, altitudeKm) {
  if (![latitude, longitude, altitudeKm].every(Number.isFinite)) return null;
  const phi = (90 - latitude) * Math.PI / 180;
  const theta = (90 - longitude) * Math.PI / 180;
  const radius = GLOBE_RADIUS * (1 + altitudeKm / EARTH_RADIUS_KM);
  return [
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
}

function computePositions(timeMs) {
  const date = new Date(timeMs);
  const positions = new Float32Array(catalog.length * 3);
  const sizes = new Float32Array(catalog.length);
  const valid = new Uint8Array(catalog.length);
  for (let i = 0; i < catalog.length; i++) {
    const entry = catalog[i];
    const satrec = satrecs[entry.norad_id];
    if (!satrec) continue;
    const geo = propagatePosition(satrec, date);
    if (!geo) continue;
    const xyz = geodeticToXyz(geo.latitude, geo.longitude, geo.altitudeKm);
    if (!xyz) continue;
    positions.set(xyz, i * 3);
    sizes[i] = pointSize(entry.category || 'unknown');
    valid[i] = 1;
  }
  self.postMessage({ type: 'POSITIONS', positions, sizes, valid },
    [positions.buffer, sizes.buffer, valid.buffer]);
}

function computeSelectedOrbit(noradId, timeMs) {
  const satrec = satrecs[noradId];
  const entry = catalog.find(item => Number(item.norad_id) === Number(noradId));
  if (!satrec || !entry || !(satrec.no > 0)) {
    self.postMessage({ type: 'ORBITS', norad_id: noradId, positions: new Float32Array(0) });
    return;
  }
  const periodMs = (2 * Math.PI / satrec.no) * 60000;
  const positions = new Float32Array((ORBIT_SAMPLES + 1) * 3);
  let count = 0;
  for (let i = 0; i <= ORBIT_SAMPLES; i++) {
    const date = new Date(Number(timeMs) + periodMs * i / ORBIT_SAMPLES);
    try {
      const result = satellite.propagate(satrec, date);
      if (!result?.position) continue;
      const geo = satellite.eciToGeodetic(result.position, satellite.gstime(date));
      if (!geo || !Number.isFinite(geo.height)) continue;
      const xyz = geodeticToXyz(
        geo.latitude * 180 / Math.PI,
        satellite.degreesLong(geo.longitude),
        geo.height,
      );
      if (!xyz) continue;
      positions.set(xyz, count * 3);
      count++;
    } catch (_) {
      // A failed sample does not prevent the remaining orbit points from rendering.
    }
  }
  const orbitPositions = positions.slice(0, count * 3);
  self.postMessage({ type: 'ORBITS', norad_id: entry.norad_id, positions: orbitPositions },
    [orbitPositions.buffer]);
}

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
  } catch (error) {
    console.warn('Failed to build satrec for', entry.norad_id, error);
    return null;
  }
}

function propagatePosition(satrec, date) {
  try {
    const result = satellite.propagate(satrec, date);
    if (!result?.position) return null;
    const geo = satellite.eciToGeodetic(result.position, satellite.gstime(date));
    if (!geo) return null;
    const latitude = geo.latitude * 180 / Math.PI;
    const longitude = satellite.degreesLong(geo.longitude);
    const altitudeKm = geo.height;
    if (![latitude, longitude, altitudeKm].every(Number.isFinite) || altitudeKm < 0) return null;
    return { latitude, longitude, altitudeKm };
  } catch (_) {
    return null;
  }
}

function pointSize(category) {
  const sizes = {
    crewed: 2.7, rocket_body: 2.2, debris: 1.7,
    constellation: 2, gnss: 2.4, weather: 2.4,
    payload: 2, unknown: 1.9,
  };
  return sizes[category] || sizes.unknown;
}
