/** Three.js satellite layer and globe.gl Earth/camera integration. */
import { adjacentSatelliteEntry, filterSatelliteEntries } from './satellite-utils.mjs?v=orbit-buffer-20261023-1';

const GLOBE_RADIUS = 100;
const EARTH_RADIUS_KM = 6371;
const DEFAULT_CAMERA_VIEW = { lat: 20, lng: 0, altitude: 2.2 };
const CATEGORY_COLORS = {
  crewed: '#00ff88', rocket_body: '#ffaa00', debris: '#ff7777',
  constellation: '#6de8ff', gnss: '#d8aaff', weather: '#ffd27a',
  payload: '#ffffff', unknown: '#c5ceda',
};
const VERTEX_SHADER = `
  attribute float size;
  attribute float visibility;
  attribute vec3 color;
  varying vec3 vColor;
  varying float vVisibility;
  void main() {
    vColor = color;
    vVisibility = visibility;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = clamp(size * (300.0 / max(1.0, -viewPosition.z)), 1.0, 7.0);
  }
`;
const FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying float vVisibility;
  void main() {
    float radius = length(gl_PointCoord - vec2(0.5));
    if (radius > 0.5) discard;
    float edge = 1.0 - smoothstep(0.30, 0.5, radius);
    gl_FragColor = vec4(vColor, edge * vVisibility);
  }
`;

let globe = null;
let worker = null;
let catalogEntries = [];
let propagationEntries = [];
let visibleEntries = [];
let visibleNoradIds = new Set();
let validPositions = new Uint8Array(0);
let pointIndices = new Map();
let pointObject = null;
let pointGeometry = null;
let positionAttribute = null;
let colorAttribute = null;
let sizeAttribute = null;
let visibilityAttribute = null;
let baseSizes = new Float32Array(0);
let selectedBaseSize = 0;
let orbitLine = null;
let activeFilters = {};
let activeSearch = '';
let selectedNorad = null;
let selectedIndex = -1;
let hoveredNorad = null;
let followMode = false;
let simulationTime = Date.now();
let simulationRate = 1;
let lastSimulationTick = Date.now();
let computeTimer = null;
let computeInFlight = false;
let pendingComputeTime = null;
let satellitesVisible = true;
let orbitsVisible = true;
let earthVisible = true;
let hoverTimer = null;
let pendingHoverEvent = null;
let pointerDown = null;
let lastHoverAt = 0;
let projectedPoint = null;

export function initGlobe(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (typeof window.Globe !== 'function' || !window.THREE?.BufferGeometry) {
    showGlobeError('The local 3D renderer did not load. Reload the page or check the deployment static files.');
  } else {
    try {
      const THREE = window.THREE;
      projectedPoint = new THREE.Vector3();
      globe = window.Globe({ rendererConfig: { alpha: true, antialias: true } })
        .globeImageUrl('/vendor/earth-blue-marble.jpg')
        .bumpImageUrl('/vendor/earth-topology.png')
        .showGlobe(true)
        .showAtmosphere(true)
        .atmosphereColor('#4da6ff')
        .atmosphereAltitude(0.15)(container);

      const renderer = globe.renderer();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.style.background = 'transparent';
      globe.scene().background = null;
      const globeMaterial = globe.globeMaterial();
      if (globeMaterial?.color?.set) globeMaterial.color.set('#315b78');
      window.globe = globe;

      createPointLayer(THREE);
      const canvas = renderer.domElement;
      canvas.addEventListener('pointerdown', event => {
        pointerDown = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      }, { passive: true });
      canvas.addEventListener('pointerup', event => {
        if (!pointerDown || pointerDown.pointerId !== event.pointerId) return;
        const dragged = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5;
        pointerDown = null;
        if (dragged) return;
        const index = pickSatellite(event.clientX, event.clientY, 10);
        if (index >= 0) selectSatellite(propagationEntries[index]?.norad_id);
        else clearSatelliteSelection();
      }, { passive: true });
      canvas.addEventListener('pointermove', event => {
        pendingHoverEvent = event;
        const elapsed = performance.now() - lastHoverAt;
        if (!hoverTimer && elapsed >= 50) {
          runHoverPick();
        } else if (!hoverTimer) {
          hoverTimer = window.setTimeout(() => {
            hoverTimer = null;
            runHoverPick();
          }, Math.max(0, 50 - elapsed));
        }
      }, { passive: true });
      canvas.addEventListener('pointerleave', () => {
        pendingHoverEvent = null;
        hoveredNorad = null;
        window.globeApp?.onSatelliteHovered?.(null);
      });

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
      controls.minDistance = 1.05;
      controls.maxDistance = 10.1;
      globe.pointOfView(DEFAULT_CAMERA_VIEW, 0);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) globe?.pauseAnimation();
        else {
          globe?.resumeAnimation();
          requestPositionCompute(simulationTime);
        }
      });
    } catch (error) {
      console.error('3D globe initialization failed:', error);
      globe = null;
      showGlobeError('The 3D globe could not initialize. Enable WebGL or try a browser with hardware acceleration.');
    }
    console.log('[globe.js] Globe initialization complete, globe object:', !!globe);
  }

  try {
    worker = new Worker('/js/workers/satellite-worker.js?v=orbit-buffer-20261023-1');
    worker.onmessage = event => {
      const data = event.data;
      if (data.type === 'INIT_PROGRESS') {
        showGlobeStatus(`Preparing satellite elements ${data.processed.toLocaleString()} / ${data.total.toLocaleString()}…`);
      } else if (data.type === 'READY' && data.count === 0) {
        showGlobeStatus('No usable satellite orbital elements were found in the catalog.');
      } else if (data.type === 'POSITIONS') {
        computeInFlight = false;
        renderPositions(data);
        if (pendingComputeTime != null) {
          const nextTime = pendingComputeTime;
          pendingComputeTime = null;
          requestPositionCompute(nextTime);
        }
      } else if (data.type === 'ORBITS' && Number(data.norad_id) === Number(selectedNorad)) {
        renderSelectedOrbit(data.positions);
      }
    };
    worker.onerror = error => {
      computeInFlight = false;
      pendingComputeTime = null;
      console.error('Satellite propagation worker failed:', error);
      showGlobeStatus('Satellite propagation unavailable · showing Earth and live selection');
    };
  } catch (error) {
    console.error('Could not start satellite worker:', error);
  }
  startComputeTimer();
}

function createPointLayer(THREE) {
  pointGeometry = new THREE.BufferGeometry();
  positionAttribute = new THREE.BufferAttribute(new Float32Array(0), 3);
  colorAttribute = new THREE.BufferAttribute(new Float32Array(0), 3);
  sizeAttribute = new THREE.BufferAttribute(new Float32Array(0), 1);
  visibilityAttribute = new THREE.BufferAttribute(new Float32Array(0), 1);
  pointGeometry.setAttribute('position', positionAttribute);
  pointGeometry.setAttribute('color', colorAttribute);
  pointGeometry.setAttribute('size', sizeAttribute);
  pointGeometry.setAttribute('visibility', visibilityAttribute);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });
  pointObject = new THREE.Points(pointGeometry, material);
  pointObject.frustumCulled = false;
  globe.scene().add(pointObject);
}

function configurePointAttributes(entries) {
  const count = entries.length;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  baseSizes = new Float32Array(count);
  const visibility = new Float32Array(count);
  validPositions = new Uint8Array(count);
  pointIndices = new Map();

  entries.forEach((entry, index) => {
    pointIndices.set(Number(entry.norad_id), index);
    const isSelected = Number(entry.norad_id) === Number(selectedNorad);
    const color = isSelected ? [1, 0.94, 0.62] : colorToRgb(CATEGORY_COLORS[entry.category] || CATEGORY_COLORS.unknown);
    colors.set(color, index * 3);
    sizes[index] = 2.1;
    baseSizes[index] = 2.1;
  });
  selectedIndex = selectedNorad == null ? -1 : (pointIndices.get(Number(selectedNorad)) ?? -1);

  positionAttribute.array = positions;
  positionAttribute.count = count;
  colorAttribute.array = colors;
  colorAttribute.count = count;
  sizeAttribute.array = sizes;
  sizeAttribute.count = count;
  visibilityAttribute.array = visibility;
  visibilityAttribute.count = count;
  positionAttribute.needsUpdate = true;
  colorAttribute.needsUpdate = true;
  sizeAttribute.needsUpdate = true;
  visibilityAttribute.needsUpdate = true;
  pointGeometry.setDrawRange(0, count);
}

function colorToRgb(hex) {
  const value = Number.parseInt(String(hex).replace('#', ''), 16);
  const color = [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
  if (hex === '#ffffff') return color;
  return color.map(component => component * 0.38 + 0.62);
}

export function setCatalog(entries) {
  catalogEntries = Array.isArray(entries) ? entries : [];
  propagationEntries = catalogEntries;
  configurePointAttributes(propagationEntries);
  applyCatalogVisibility();
  startComputeTimer();
  if (worker) {
    worker.postMessage({ type: 'INIT', catalog: propagationEntries.map(entry => ({
      norad_id: entry.norad_id, name: entry.name, line1: entry.line1 || null,
      line2: entry.line2 || null, omm: entry.omm || null,
      category: entry.category || 'unknown',
    })) });
    computeInFlight = false;
    pendingComputeTime = null;
    if (catalogEntries.length) {
      requestPositionCompute(simulationTime);
      if (selectedNorad != null) worker.postMessage({ type: 'SELECT', norad_id: selectedNorad, time: simulationTime });
    }
  }
}

function requestPositionCompute(time) {
  if (!worker || document.hidden) return;
  if (computeInFlight) {
    pendingComputeTime = time;
    return;
  }
  computeInFlight = true;
  worker.postMessage({ type: 'COMPUTE', time });
}

function renderPositions(data) {
  if (!positionAttribute || data.positions.length !== positionAttribute.array.length) return;
  positionAttribute.array.set(data.positions);
  positionAttribute.needsUpdate = true;
  validPositions.set(data.valid);
  const sizes = sizeAttribute.array;
  for (let index = 0; index < sizes.length; index++) {
    baseSizes[index] = data.valid[index] ? data.sizes[index] : 0;
    sizes[index] = baseSizes[index];
  }
  if (selectedIndex >= 0) sizes[selectedIndex] = Math.min(4, baseSizes[selectedIndex] * 1.5);
  sizeAttribute.needsUpdate = true;
  refreshPointVisibility();
  const count = data.valid.reduce((sum, value) => sum + value, 0);
  showGlobeStatus(count
    ? `Propagated ${count.toLocaleString()} satellite positions from catalog orbital elements.`
    : 'Satellite positions are unavailable for the loaded orbital elements.');
}

function startComputeTimer() {
  if (computeTimer) clearInterval(computeTimer);
  lastSimulationTick = Date.now();
  computeTimer = window.setInterval(() => {
    const now = Date.now();
    simulationTime += (now - lastSimulationTick) * simulationRate;
    lastSimulationTick = now;
    window.simulationTime = simulationTime;
    requestPositionCompute(simulationTime);
  }, 1000);
}

export function setCatalogView(filters, query) {
  activeFilters = filters || {};
  activeSearch = (query || '').toLowerCase().trim();
  applyCatalogVisibility();
}

function applyCatalogVisibility() {
  visibleEntries = filterSatelliteEntries(catalogEntries, activeSearch, activeFilters);
  visibleNoradIds = new Set(visibleEntries.map(entry => Number(entry.norad_id)));
  if (hoveredNorad != null && !visibleNoradIds.has(Number(hoveredNorad))) {
    hoveredNorad = null;
    window.globeApp?.onSatelliteHovered?.(null);
  }
  if (selectedNorad != null && !visibleNoradIds.has(Number(selectedNorad))) clearSatelliteSelection(false);
  refreshPointVisibility();
}

function refreshPointVisibility() {
  if (!visibilityAttribute) return;
  const values = visibilityAttribute.array;
  for (let index = 0; index < values.length; index++) {
    values[index] = satellitesVisible && validPositions[index]
      && visibleNoradIds.has(Number(propagationEntries[index]?.norad_id)) ? 1 : 0;
  }
  visibilityAttribute.needsUpdate = true;
}

function setSelectedAppearance(index, active) {
  if (!colorAttribute || index < 0 || index >= colorAttribute.count) return;
  const colors = colorAttribute.array;
  const entry = propagationEntries[index];
  const rgb = active ? [1, 0.94, 0.62]
    : colorToRgb(CATEGORY_COLORS[entry?.category] || CATEGORY_COLORS.unknown);
  colors.set(rgb, index * 3);
  colorAttribute.needsUpdate = true;
  if (active) selectedBaseSize = baseSizes[index] || 2;
  sizeAttribute.array[index] = active ? Math.min(4, selectedBaseSize * 1.5) : (baseSizes[index] || 2);
  sizeAttribute.needsUpdate = true;
}

function runHoverPick() {
  hoverTimer = null;
  const event = pendingHoverEvent;
  if (!event) return;
  lastHoverAt = performance.now();
  const index = pickSatellite(event.clientX, event.clientY, 10);
  const nextNorad = index >= 0 ? propagationEntries[index]?.norad_id ?? null : null;
  if (Number(nextNorad) !== Number(hoveredNorad)) {
    hoveredNorad = nextNorad;
    window.globeApp?.onSatelliteHovered?.(nextNorad, event.clientX, event.clientY);
  } else if (nextNorad != null) {
    window.globeApp?.onSatelliteHovered?.(nextNorad, event.clientX, event.clientY);
  }
}

function pickSatellite(clientX, clientY, maxPixels) {
  if (!globe || !positionAttribute || !visibilityAttribute) return -1;
  const camera = globe.camera();
  const canvas = globe.renderer().domElement;
  const rect = canvas.getBoundingClientRect();
  camera.updateMatrixWorld();
  const cameraPosition = camera.position;
  const positions = positionAttribute.array;
  const visibility = visibilityAttribute.array;
  let nearestIndex = -1;
  let nearestDistanceSq = maxPixels * maxPixels;

  for (let index = 0; index < visibility.length; index++) {
    if (visibility[index] <= 0) continue;
    const offset = index * 3;
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    if (x * cameraPosition.x + y * cameraPosition.y + z * cameraPosition.z <= 0) continue;
    const screen = projectedPoint.set(x, y, z).project(camera);
    if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y) || screen.z < -1 || screen.z > 1) continue;
    const screenX = rect.left + (screen.x + 1) * rect.width / 2;
    const screenY = rect.top + (1 - screen.y) * rect.height / 2;
    const dx = screenX - clientX;
    const dy = screenY - clientY;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq <= nearestDistanceSq) {
      nearestDistanceSq = distanceSq;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}

export function selectSatellite(noradId) {
  const index = pointIndices.get(Number(noradId));
  const entry = catalogEntries.find(item => Number(item.norad_id) === Number(noradId));
  if (!entry || index == null || !visibleNoradIds.has(Number(noradId))) return;
  if (selectedIndex >= 0) setSelectedAppearance(selectedIndex, false);
  removeOrbitLine();
  selectedNorad = entry.norad_id;
  selectedIndex = index;
  selectedBaseSize = baseSizes[index] || 2;
  setSelectedAppearance(selectedIndex, true);
  updateAutoRotate();
  worker?.postMessage({ type: 'SELECT', norad_id: selectedNorad, time: simulationTime });
  return window.globeApp?.onSatelliteSelected?.(entry);
}

function renderSelectedOrbit(positions) {
  if (!globe || !window.THREE || positions.length < 6 || !orbitsVisible) return;
  removeOrbitLine();
  const THREE = window.THREE;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ color: '#40e6ff', transparent: true, opacity: 0.92 });
  orbitLine = new THREE.Line(geometry, material);
  orbitLine.frustumCulled = false;
  globe.scene().add(orbitLine);
}

function removeOrbitLine() {
  if (!orbitLine) return;
  globe?.scene().remove(orbitLine);
  orbitLine.geometry.dispose();
  orbitLine.material.dispose();
  orbitLine = null;
}

function clearSatelliteSelection(notify = true) {
  if (selectedIndex >= 0) setSelectedAppearance(selectedIndex, false);
  selectedIndex = -1;
  selectedNorad = null;
  removeOrbitLine();
  updateAutoRotate();
  if (notify) window.globeApp?.onSatelliteCleared?.();
}

function updateAutoRotate() {
  if (globe) globe.controls().autoRotate = !followMode && selectedNorad == null;
}

function navigateSatellite(direction) {
  const visibleValidEntries = visibleEntries.filter(entry => {
    const index = pointIndices.get(Number(entry.norad_id));
    return index != null && validPositions[index];
  });
  const entry = adjacentSatelliteEntry(visibleValidEntries, selectedNorad, direction);
  if (entry) return selectSatellite(entry.norad_id);
  return null;
}
export function previousSatellite() { return navigateSatellite(-1); }
export function nextSatellite() { return navigateSatellite(1); }
export function hoverSatellite() {}
export function getSelectedNorad() { return selectedNorad; }
export function getHoveredNorad() { return hoveredNorad; }
export function getCatalog() { return catalogEntries; }
export function updateSatMarker() {
  // Satellite positions come from the catalog worker; keep the legacy API inert.
}

export function setSatellitesVisible(visible) {
  satellitesVisible = Boolean(visible);
  refreshPointVisibility();
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
  requestPositionCompute(simulationTime);
}

export function drawOrbitPath() {
  // The worker owns orbit propagation; the selected orbit is drawn from xyz samples.
}

export function setOrbitsVisible(visible) {
  orbitsVisible = Boolean(visible);
  if (!orbitsVisible) removeOrbitLine();
  else if (selectedNorad != null) worker?.postMessage({ type: 'SELECT', norad_id: selectedNorad, time: simulationTime });
}

export function followSatellite(lat, lon) {
  if (globe) globe.pointOfView({ lat, lng: lon, altitude: 1.8 }, 1000);
}
export function setFollowMode(on) {
  followMode = on;
  updateAutoRotate();
}

function setTrackedCameraView(view) {
  if (!globe) return;
  globe.pointOfView(view, 400);
}

export function zoomIn() {
  if (!globe) return;
  const view = globe.pointOfView();
  setTrackedCameraView({ ...view, altitude: Math.max(0.05, view.altitude * 0.78) });
}

export function zoomOut() {
  if (!globe) return;
  const view = globe.pointOfView();
  setTrackedCameraView({ ...view, altitude: Math.min(9, view.altitude * 1.28) });
}

export function resetCameraView() {
  if (!globe) return;
  setTrackedCameraView(DEFAULT_CAMERA_VIEW);
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
