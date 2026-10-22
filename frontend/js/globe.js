/** 3D Earth and satellite catalog rendering. */
let globe = null;
let worker = null;
let catalogEntries = [];
let visibleEntries = [];
let propagatedPoints = [];
let activeFilters = {};
let activeSearch = '';
let selectedNorad = null;
let followMode = false;

const CATEGORY_COLORS = {
  crewed: '#00ff88', rocket_body: '#ffaa00', debris: '#ff4444',
  constellation: '#00d4ff', gnss: '#aa00ff', weather: '#ffaa00',
  payload: '#ffffff', unknown: '#9aa4b2',
};

export function initGlobe(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (typeof window.Globe !== 'function') {
    showGlobeError('The 3D globe library did not load. Check your connection and reload.');
    return;
  }

  globe = window.Globe()
    .globeImageUrl('https://unpkg.com/three-globe@2.31.3/example/img/earth-blue-marble.jpg')
    .bumpImageUrl('https://unpkg.com/three-globe@2.31.3/example/img/earth-topology.png')
    .backgroundImageUrl('https://unpkg.com/three-globe@2.31.3/example/img/night-sky.png')
    .showAtmosphere(true)
    .atmosphereColor('#4da6ff')
    .atmosphereAltitude(0.15)
    .pointsData([])
    .pointLat(d => d.lat)
    .pointLng(d => d.lng)
    .pointAltitude(d => d.altitude)
    .pointColor(d => d.color)
    .pointRadius(d => d.radius)
    .pointLabel(d => `${d.entry.name || 'Satellite'} · NORAD ${d.norad_id}`)
    .pointResolution(8)
    .pointsMerge(false)
    .pathsData([])
    .pathPoints(d => d)
    .pathPointLat(d => d.lat)
    .pathPointLng(d => d.lng)
    .pathPointAlt(d => d.alt)
    .pathColor(() => '#00d4ff')
    .pathStroke(0.65)
    .pathDashLength(0.015)
    .pathDashGap(0.006)
    .pathDashAnimateTime(12000)
    .onPointClick(point => selectSatellite(point.norad_id))
    (container);

  window.globe = globe;
  const resize = () => {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    globe.width(width).height(height);
  };
  window.addEventListener('resize', resize);
  requestAnimationFrame(resize);
  const controls = globe.controls();
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.3;
  controls.minDistance = 1.02;
  controls.maxDistance = 6.6;
  globe.pointOfView({ lat: 20, lng: 0, altitude: 1.45 }, 0);

  try {
    worker = new Worker('/js/workers/satellite-worker.js');
    worker.onmessage = event => {
      if (event.data.type === 'POSITIONS') renderPositions(event.data);
    };
    worker.onerror = error => {
      console.error('Satellite propagation worker failed:', error);
      showGlobeError('Satellite positions could not be calculated. The Earth is still available.');
    };
  } catch (error) {
    console.error('Could not start satellite worker:', error);
  }
}

export function setCatalog(entries) {
  catalogEntries = Array.isArray(entries) ? entries : [];
  visibleEntries = catalogEntries;
  if (worker && catalogEntries.length) {
    worker.postMessage({ type: 'INIT', catalog: catalogEntries.map(entry => ({
      norad_id: entry.norad_id, line1: entry.line1 || null,
      line2: entry.line2 || null, omm: entry.omm || null,
      category: entry.category || 'unknown',
    })) });
    worker.postMessage({ type: 'COMPUTE', time: Date.now() });
    if (!worker.computeTimer) {
      worker.computeTimer = window.setInterval(() => {
        worker.postMessage({ type: 'COMPUTE', time: Date.now() });
      }, 500);
    }
  }
}

function renderPositions(data) {
  if (!globe) return;
  const points = [];
  for (let i = 0; i < catalogEntries.length; i++) {
    if (!data.valid[i]) continue;
    const x = data.positions[i * 3];
    const y = data.positions[i * 3 + 1];
    const z = data.positions[i * 3 + 2];
    const radius = Math.hypot(x, y, z);
    points.push({
      norad_id: catalogEntries[i].norad_id,
      lat: Math.asin(y / radius) * 180 / Math.PI,
      lng: Math.atan2(z, -x) * 180 / Math.PI,
      altitude: Math.max(0.003, radius - 1),
      color: CATEGORY_COLORS[catalogEntries[i].category] || CATEGORY_COLORS.unknown,
      radius: Math.max(0.08, data.sizes[i] * 12),
      entry: catalogEntries[i],
    });
  }
  propagatedPoints = points;
  applyPointVisibility();
}

export function setFilters(filters) {
  activeFilters = filters || {};
  applyCatalogVisibility();
}

export function setSearch(query) {
  activeSearch = (query || '').toLowerCase().trim();
  applyCatalogVisibility();
}

function applyCatalogVisibility() {
  const filters = activeFilters;
  visibleEntries = catalogEntries.filter(entry => {
    if (activeSearch && ![entry.name, entry.norad_id, entry.intl_designator,
      entry.country, entry.object_type].join(' ').toLowerCase().includes(activeSearch)) return false;
    if (filters.category?.size && !filters.category.has(entry.category || 'unknown')) return false;
    if (filters.regime?.size && !filters.regime.has(entry.orbit_regime || 'unknown')) return false;
    if (filters.objectType?.size) {
      const type = (entry.object_type || 'UNK').replace(/\s+/g, '_').toUpperCase();
      if (!filters.objectType.has(type)) return false;
    }
    if (filters.country?.size && !filters.country.has(entry.country || 'unknown')) return false;
    return true;
  });
  applyPointVisibility();
}

function applyPointVisibility() {
  if (globe) globe.pointsData(propagatedPoints.filter(point => visibleEntries.includes(point.entry)));
}

export function selectSatellite(noradId) {
  selectedNorad = noradId;
  const entry = catalogEntries.find(item => Number(item.norad_id) === Number(noradId));
  if (!entry) return;
  window.globeApp?.fetchAndDrawTrack?.(noradId);
  window.globeApp?.onSatelliteSelected?.(entry);
}
export function hoverSatellite() {}
export function getSelectedNorad() { return selectedNorad; }
export function getHoveredNorad() { return null; }
export function getCatalog() { return catalogEntries; }
export function updateSatMarker() {}

export function drawOrbitPath(points) {
  if (!globe) return;
  const segments = [];
  let segment = [];
  (points || []).forEach((point, index, all) => {
    segment.push({ lat: point.latitude, lng: point.longitude,
      alt: Math.max(0.003, (point.altitude_km || 0) / 6371) });
    if (index < all.length - 1 && Math.abs(all[index + 1].longitude - point.longitude) > 180) {
      if (segment.length > 1) segments.push(segment);
      segment = [];
    }
  });
  if (segment.length > 1) segments.push(segment);
  globe.pathsData(segments);
}
export function followSatellite(lat, lon) {
  if (globe) globe.pointOfView({ lat, lng: lon, altitude: 1.8 }, 1000);
}
export function setFollowMode(on) {
  followMode = on;
  if (globe) globe.controls().autoRotate = !followMode;
}

function showGlobeError(message) {
  const overlay = document.getElementById('message-overlay');
  const title = document.getElementById('overlay-title');
  const text = document.getElementById('overlay-text');
  if (!overlay || !title || !text) return;
  title.textContent = 'Globe unavailable';
  text.textContent = message;
  overlay.classList.add('visible');
}
