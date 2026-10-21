/**
 * api.js – Thin wrapper around the backend REST API.
 *
 * Every function returns a Promise that resolves to JSON or rejects on error.
 * The base URL defaults to the current origin so it works when the FastAPI
 * server serves the frontend.
 */

const API_BASE = '';

/** Generic fetch helper with error handling. */
async function apiFetch(path) {
  const resp = await fetch(`${API_BASE}${path}`);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** GET /api/health */
function apiHealth() {
  return apiFetch('/api/health');
}

/** GET /api/satellites */
function apiSatellites() {
  return apiFetch('/api/satellites');
}

/**
 * GET /api/position?sat=<noradId>
 * Returns current lat, lon, alt, speed, heading, etc.
 */
function apiPosition(noradId) {
  return apiFetch(`/api/position?sat=${noradId}`);
}

/**
 * GET /api/track?sat=<noradId>&minutes=<min>&step=<sec>
 * Returns a list of ground-track points.
 */
function apiTrack(noradId, minutes = 90, step = 30) {
  return apiFetch(`/api/track?sat=${noradId}&minutes=${minutes}&step=${step}`);
}

/**
 * GET /api/elements?sat=<noradId>
 * Returns parsed Keplerian orbital elements.
 */
function apiElements(noradId) {
  return apiFetch(`/api/elements?sat=${noradId}`);
}

/**
 * GET /api/catalog?refresh=<bool>
 * Returns the full merged satellite catalog.
 * @param {boolean} refresh - Bypass fresh cache and rebuild from upstream.
 */
function apiCatalog(refresh = false) {
  return apiFetch(`/api/catalog?refresh=${refresh}`);
}
