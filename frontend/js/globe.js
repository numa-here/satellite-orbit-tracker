/** 3D Earth and satellite catalog rendering. */
let globe = null;
let worker = null;
let catalogEntries = [];
let propagationEntries = [];
let visibleEntries = [];
let propagatedPoints = [];
let activeFilters = {};
let activeSearch = '';
let selectedNorad = null;
let followMode = false;
let simulationTime = Date.now();
let simulationRate = 1;
let lastSimulationTick = Date.now();
let computeTimer = null;
let satellitesVisible = true;
let earthVisible = true;
let liveMarker = null;
let cameraHistory = [];
let cameraHistoryIndex = -1;

const CATEGORY_COLORS = {
  crewed: '#00ff88', rocket_body: '#ffaa00', debris: '#ff4444',
  constellation: '#00d4ff', gnss: '#aa00ff', weather: '#ffaa00',
  payload: '#ffffff', unknown: '#9aa4b2',
};

export function initGlobe(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (typeof window.Globe !== 'function') {
    showGlobeError('The local 3D renderer did not load. Reload the page or check the deployment static files.');
  } else {
    try {
    globe = window.Globe({ rendererConfig: { alpha: true, antialias: true } })
      .globeImageUrl('/vendor/earth-blue-marble.jpg')
      .bumpImageUrl('/vendor/earth-topology.png')
      .showGlobe(true)
      .showAtmosphere(true)
      .atmosphereColor('#4da6ff')
      .atmosphereAltitude(0.15)
      .pointsData([])
      .pointLat(d => d.lat)
      .pointLng(d => d.lng)
      .pointAltitude(d => d.altitude)
      .pointColor(d => d.color)
      .pointRadius(d => d.radius)
      .pointLabel(d => `${d.entry?.name || d.name || 'Satellite'} · NORAD ${d.norad_id || ''}`)
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

    // globe.gl may clear its canvas with an opaque color even when the
    // renderer was created with alpha enabled. Keep the page starfield and
    // textured CSS Earth fallback visible beneath the WebGL scene.
    const renderer = globe.renderer();
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.background = 'transparent';
    globe.scene().background = null;

    // Keep the Earth sphere visible if the texture request fails. Once the
    // texture loads, globe.gl applies it over this fallback material color.
    const globeMaterial = globe.globeMaterial();
    if (globeMaterial?.color?.set) globeMaterial.color.set('#315b78');

    // Some hosted/headless WebGL builds report a ready globe but never paint
    // the Earth texture. Put the bundled textured Earth above that empty
    // canvas until a real texture image is available.
    let textureChecks = 0;
    const checkEarthTexture = () => {
      if (!globe) return;
      const image = globe.globeMaterial()?.map?.image;
      if (image?.complete && image.naturalWidth > 0) {
        container.classList.remove('earth-fallback-overlay');
        return;
      }
      container.classList.add('earth-fallback-overlay');
      textureChecks += 1;
      if (textureChecks < 12) window.setTimeout(checkEarthTexture, 1000);
    };
    window.setTimeout(checkEarthTexture, 1200);

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
    const initialView = { lat: 20, lng: 0, altitude: 1.45 };
    globe.pointOfView(initialView, 0);
    cameraHistory = [initialView];
    cameraHistoryIndex = 0;
    } catch (error) {
      console.error('3D globe initialization failed:', error);
      globe = null;
      showGlobeError('The 3D globe could not initialize. Enable WebGL or try a browser with hardware acceleration.');
    }
  }

  try {
    worker = new Worker('/js/workers/satellite-worker.js');
    worker.onmessage = event => {
      if (event.data.type === 'POSITIONS') renderPositions(event.data);
    };
    worker.onerror = error => {
      console.error('Satellite propagation worker failed:', error);
      showGlobeStatus('Satellite propagation unavailable · showing Earth and live selection');
    };
  } catch (error) {
    console.error('Could not start satellite worker:', error);
  }
  startComputeTimer(250);
}

export function setCatalog(entries) {
  catalogEntries = Array.isArray(entries) ? entries : [];
  visibleEntries = catalogEntries;
  // Keep search on the full catalog, while limiting the animated 3D layer to
  // a representative spread of objects so mid-range devices stay responsive.
  const maxRenderedSatellites = 3000;
  propagationEntries = catalogEntries.length <= maxRenderedSatellites
    ? catalogEntries
    : Array.from({ length: maxRenderedSatellites }, (_, index) =>
      catalogEntries[Math.round(index * (catalogEntries.length - 1) / (maxRenderedSatellites - 1))]);
  startComputeTimer(propagationEntries.length > 1200 ? 1000 : 250);
  if (worker && catalogEntries.length) {
    worker.postMessage({ type: 'INIT', catalog: propagationEntries.map(entry => ({
      norad_id: entry.norad_id, line1: entry.line1 || null,
      line2: entry.line2 || null, omm: entry.omm || null,
      category: entry.category || 'unknown',
    })) });
    worker.postMessage({ type: 'COMPUTE', time: simulationTime });
  }
}

function renderPositions(data) {
  if (!globe) return;
  const points = [];
  for (let i = 0; i < propagationEntries.length; i++) {
    if (!data.valid[i]) continue;
    const x = data.positions[i * 3];
    const y = data.positions[i * 3 + 1];
    const z = data.positions[i * 3 + 2];
    const radius = Math.hypot(x, y, z);
    points.push({
      norad_id: propagationEntries[i].norad_id,
      lat: Math.asin(y / radius) * 180 / Math.PI,
      lng: Math.atan2(z, -x) * 180 / Math.PI,
      altitude: Math.max(0.003, radius - 1),
      color: CATEGORY_COLORS[propagationEntries[i].category] || CATEGORY_COLORS.unknown,
      radius: Math.max(0.08, data.sizes[i] * 12),
      entry: propagationEntries[i],
    });
  }
  propagatedPoints = points;
  applyPointVisibility();
}

function startComputeTimer(intervalMs) {
  if (computeTimer) clearInterval(computeTimer);
  computeTimer = window.setInterval(() => {
    const now = Date.now();
    simulationTime += (now - lastSimulationTick) * simulationRate;
    lastSimulationTick = now;
    window.simulationTime = simulationTime;
    if (worker) worker.postMessage({ type: 'COMPUTE', time: simulationTime });
  }, intervalMs);
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
  const points = satellitesVisible ? propagatedPoints.filter(point => visibleEntries.includes(point.entry)) : [];
  if (satellitesVisible && liveMarker) {
    const entry = catalogEntries.find(item => Number(item.norad_id) === Number(liveMarker.norad_id));
    points.push({ ...liveMarker, color: '#ffec70', radius: 0.2, entry: entry || { name: liveMarker.name } });
  }
  if (globe) globe.pointsData(points);
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
export function updateSatMarker(lat, lon, alt, name) {
  liveMarker = { lat, lng: lon, altitude: Math.max(0.003, alt / 6371), name, norad_id: selectedNorad };
  applyPointVisibility();
}

export function setSatellitesVisible(visible) {
  satellitesVisible = Boolean(visible);
  applyPointVisibility();
}

export function setEarthVisible(visible) {
  earthVisible = Boolean(visible);
  if (globe) globe.showGlobe(earthVisible);
  document.getElementById('globe-container')?.classList.toggle('earth-hidden', !earthVisible);
}

export function setSimulationRate(rate) {
  simulationRate = Math.max(0, Number(rate) || 0);
  lastSimulationTick = Date.now();
}

export function setSimulationTime(time) {
  const nextTime = Number(time);
  if (!Number.isFinite(nextTime)) return;
  simulationTime = nextTime;
  lastSimulationTick = Date.now();
  window.simulationTime = simulationTime;
  if (worker) worker.postMessage({ type: 'COMPUTE', time: simulationTime });
}

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

function setTrackedCameraView(view) {
  if (!globe) return;
  cameraHistory = cameraHistory.slice(0, cameraHistoryIndex + 1);
  cameraHistory.push({ lat: view.lat, lng: view.lng, altitude: view.altitude });
  cameraHistoryIndex = cameraHistory.length - 1;
  globe.pointOfView(view, 400);
}

export function zoomIn() {
  if (!globe) return;
  const view = globe.pointOfView();
  setTrackedCameraView({ ...view, altitude: Math.max(0.7, view.altitude * 0.78) });
}

export function zoomOut() {
  if (!globe) return;
  const view = globe.pointOfView();
  setTrackedCameraView({ ...view, altitude: Math.min(5.6, view.altitude * 1.28) });
}

export function undoCamera() {
  if (!globe || cameraHistoryIndex <= 0) return;
  cameraHistoryIndex -= 1;
  globe.pointOfView(cameraHistory[cameraHistoryIndex], 400);
}

export function redoCamera() {
  if (!globe || cameraHistoryIndex >= cameraHistory.length - 1) return;
  cameraHistoryIndex += 1;
  globe.pointOfView(cameraHistory[cameraHistoryIndex], 400);
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

function showGlobeStatus(message) {
  const status = document.getElementById('stats-text');
  if (status) status.textContent = message;
}
