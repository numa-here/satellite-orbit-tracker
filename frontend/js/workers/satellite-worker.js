/**
 * satellite-worker.js – Web Worker that computes satellite positions.
 * Loads satellite.js from CDN, propagates TLE/OMM orbits to geodetic
 * (lat/lon/alt), and converts to Three.js globe units (Earth radius = 1).
 *
 * Messages:
 *   { type: 'INIT', catalog: CatalogEntry[] }
 *   { type: 'COMPUTE', time: number }
 *
 * Reply:
 *   { type: 'POSITIONS', positions, colors, sizes, valid }
 */

try {
  importScripts('https://cdn.jsdelivr.net/npm/satellite.js@6.0.2/dist/satellite.min.js');
} catch (primaryError) {
  importScripts('https://unpkg.com/satellite.js@6.0.2/dist/satellite.min.js');
}

const EARTH_RADIUS_KM = 6371.0;
let catalog = [];
let satrecs = {};
let ready = false;

self.addEventListener('message', (e) => {
  const { type } = e.data;
  if (type === 'INIT') {
    catalog = e.data.catalog || [];
    satrecs = {};
    for (const entry of catalog) {
      const satrec = buildSatrec(entry);
      if (satrec) satrecs[entry.norad_id] = satrec;
    }
    ready = true;
    self.postMessage({ type: 'READY', count: Object.keys(satrecs).length });
  } else if (type === 'COMPUTE') {
    if (!ready) return;
    computePositions(e.data.time);
  }
});

function computePositions(timeMs) {
  const date = new Date(timeMs);
  const n = catalog.length;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const valid = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const entry = catalog[i];
    const satrec = satrecs[entry.norad_id];
    if (!satrec) { valid[i] = 0; continue; }
    const result = propagatePosition(satrec, date, entry);
    if (!result) { valid[i] = 0; continue; }
    positions[i * 3] = result.x;
    positions[i * 3 + 1] = result.y;
    positions[i * 3 + 2] = result.z;
    colors[i * 3] = result.color[0];
    colors[i * 3 + 1] = result.color[1];
    colors[i * 3 + 2] = result.color[2];
    sizes[i] = result.size;
    valid[i] = 1;
  }

  self.postMessage({
    type: 'POSITIONS', positions, colors, sizes, valid,
  }, [positions.buffer, colors.buffer, sizes.buffer, valid.buffer]);
}

/**
 * Build a satellite.js satrec from a catalog entry.
 * Prefers TLE lines; returns null if neither TLE nor usable OMM exists.
 */
function buildSatrec(entry) {
  try {
    if (entry.line1 && entry.line2) {
      return satellite.twoline2satrec(entry.line1, entry.line2);
    }
    if (entry.omm && typeof satellite.json2satrec === 'function') {
      return satellite.json2satrec(entry.omm);
    }
    return null;
  } catch (err) {
    console.warn('Failed to build satrec for', entry.norad_id, err);
    return null;
  }
}

/**
 * Propagate a satrec to a date and return {x, y, z, color, size}
 * in globe units (Earth radius = 1).
 */
function propagatePosition(satrec, date, entry) {
  try {
    const result = satellite.propagate(satrec, date);
    if (!result || !result.position) return null;

    const { position } = result;
    const gstime = satellite.gstime(date);
    const gd = satellite.eciToGeodetic(position, gstime);
    if (!gd) return null;

    const latRad = gd.latitude;
    const lonRad = gd.longitude;
    const altKm = gd.height || 0;

    const phi = Math.PI / 2 - latRad;
    const theta = lonRad + Math.PI;
    const r = 1.0 + altKm / EARTH_RADIUS_KM;

    const x = -r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.cos(phi);
    const z = r * Math.sin(phi) * Math.sin(theta);

    const color = categoryColor(entry.category || 'unknown');
    const size = pointSize(entry.category || 'unknown');

    return { x, y, z, color, size };
  } catch (err) {
    return null;
  }
}

/** Category → RGB color (0..1). */
function categoryColor(category) {
  const map = {
    crewed:     [0.0, 1.0, 0.53],
    rocket_body:[1.0, 0.67, 0.0],
    debris:     [1.0, 0.27, 0.27],
    constellation:[0.0, 0.83, 1.0],
    gnss:       [0.67, 0.0, 1.0],
    weather:    [1.0, 0.67, 0.0],
    payload:    [1.0, 1.0, 1.0],
    unknown:    [0.4, 0.4, 0.4],
  };
  return map[category] || map.unknown;
}

/** Category → point size. */
function pointSize(category) {
  const base = {
    crewed: 0.014, rocket_body: 0.010, debris: 0.006,
    constellation: 0.008, gnss: 0.010, weather: 0.010,
    payload: 0.008, unknown: 0.006,
  };
  return base[category] || base.unknown;
}
