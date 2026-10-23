export const EARTH_RADIUS_KM = 6371;

export function geodeticToGlobePoint(latitude, longitude, altitudeKm) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  const altitude = Number(altitudeKm);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90
    || !Number.isFinite(lng) || lng < -180 || lng > 180
    || !Number.isFinite(altitude) || altitude < 0) return null;
  return { lat, lng, altitude: altitude / EARTH_RADIUS_KM };
}

export function createSatelliteMarker(entry, latitude, longitude, altitudeKm) {
  const noradId = Number(entry?.norad_id);
  const position = geodeticToGlobePoint(latitude, longitude, altitudeKm);
  if (!entry || !Number.isSafeInteger(noradId) || noradId <= 0 || !position) return null;
  return {
    norad_id: noradId,
    ...position,
    entry,
  };
}

function asSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

function matchesAny(active, value) {
  return active.size === 0 || active.has(value);
}

export function filterSatelliteEntries(entries, query = '', filters = {}) {
  const source = Array.isArray(entries) ? entries : [];
  const search = typeof query === 'string' ? query.trim().toLocaleLowerCase() : '';
  const category = asSet(filters?.category);
  const regime = asSet(filters?.regime);
  const objectType = asSet(filters?.objectType);
  const country = asSet(filters?.country);

  return source.filter(entry => {
    if (!entry || typeof entry !== 'object') return false;
    const normalizedType = String(entry.object_type || 'UNK').trim()
      .replace(/\s+/g, '_').toUpperCase();
    if (!matchesAny(category, entry.category || 'unknown')) return false;
    if (!matchesAny(regime, entry.orbit_regime || 'unknown')) return false;
    if (!matchesAny(objectType, normalizedType)) return false;
    if (!matchesAny(country, entry.country || 'unknown')) return false;
    if (!search) return true;
    const haystack = [entry.name, entry.norad_id, entry.intl_designator,
      entry.country, entry.object_type].map(value => String(value ?? '')).join(' ').toLocaleLowerCase();
    return haystack.includes(search);
  });
}

export function nearestSatellitePoint(points, coords, maxDegrees, isAllowed = () => true) {
  if (!Array.isArray(points) || !Number.isFinite(coords?.lat) || !Number.isFinite(coords?.lng)
    || !Number.isFinite(maxDegrees) || maxDegrees < 0) return null;
  const lat1 = coords.lat * Math.PI / 180;
  let nearest = null;
  let nearestDistance = maxDegrees;
  for (const point of points) {
    if (!point || !isAllowed(point) || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
    const latDelta = point.lat - coords.lat;
    const lonDelta = ((point.lng - coords.lng + 540) % 360) - 180;
    const lat2 = point.lat * Math.PI / 180;
    const haversine = Math.sin(latDelta * Math.PI / 360) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDelta * Math.PI / 360) ** 2;
    const distance = 2 * Math.asin(Math.min(1, Math.sqrt(haversine))) * 180 / Math.PI;
    if (distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function adjacentSatelliteEntry(entries, currentNoradId, direction) {
  if (!Array.isArray(entries) || entries.length === 0 || ![-1, 1].includes(direction)) return null;
  const currentIndex = entries.findIndex(entry => Number(entry?.norad_id) === Number(currentNoradId));
  const nextIndex = currentIndex < 0
    ? (direction > 0 ? 0 : entries.length - 1)
    : (currentIndex + direction + entries.length) % entries.length;
  return entries[nextIndex] || null;
}
