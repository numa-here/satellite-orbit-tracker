/** 3D Earth and satellite catalog rendering. */
import * as THREE from '../vendor/three.module.min.js?v=orbit-points-20261024-2';
import { adjacentSatelliteEntry, createSatelliteMarker, filterSatelliteEntries, nearestSatellitePoint } from './satellite-utils.mjs?v=orbit-points-20261024-2';

let globe = null;
let worker = null;
let catalogEntries = [];
let propagationEntries = [];
let visibleEntries = [];
let visibleNoradIds = new Set();
let propagatedPoints = [];
let propagatedNoradIds = new Set();
let pointGrid = new Map();
let pointGeometry = null;
let pointObject = null;
let positionAttribute = null;
let colorAttribute = null;
let sizeAttribute = null;
let visibilityAttribute = null;
let validPositions = new Uint8Array(0);
let baseSizes = new Float32Array(0);
let pointIndices = new Map();
let pointSampleDiagnosticsLogged = false;
let activeFilters = {};
let activeSearch = '';
let selectedNorad = null;
let hoveredNorad = null;
let selectedOrbitPaths = [];
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
const DEFAULT_CAMERA_VIEW = { lat: 20, lng: 0, altitude: 2.2 };

const PICK_GRID_DEGREES = 2;
const MIN_CAMERA_ALTITUDE = 0.08;
const MAX_CAMERA_ALTITUDE = 24;
const DEFAULT_MARKER_SIZE_PX = 2.2;
const SELECTED_MARKER_SIZE_PX = 4.2;
const POINT_VERTEX_SHADER = `
  attribute vec3 color;
  attribute float size;
  attribute float visibility;
  varying vec3 vColor;
  varying float vVisibility;
  void main() {
    vColor = color;
    vVisibility = visibility;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = clamp(size * (320.0 / max(1.0, -viewPosition.z)), 1.3, 4.5);
  }
`;
const POINT_FRAGMENT_SHADER = `
  varying vec3 vColor;
  varying float vVisibility;
  void main() {
    float radius = length(gl_PointCoord - vec2(0.5));
    if (radius > 0.5) discard;
    float alpha = 1.0 - smoothstep(0.28, 0.5, radius);
    gl_FragColor = vec4(vColor, alpha * vVisibility);
  }
`;

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
      .pathsData([])
      .pathPoints(d => d.points)
      .pathPointLat(d => d.lat)
      .pathPointLng(d => d.lng)
      .pathPointAlt(d => d.alt)
      .pathColor(path => path.selected ? '#ffec70' : '#00d4ff')
      .pathLabel(path => `${path.name} · NORAD ${path.norad_id} · the highlighted marker follows this orbit`)
      .pathStroke(path => path.selected ? 2.0 : 1.2)
      .pathDashLength(1)
      .pathDashGap(0)
      .pathDashAnimateTime(0)
      .onPathClick(path => selectSatellite(path.norad_id))
      (container);

    // globe.gl may clear its canvas with an opaque color even when the
    // renderer was created with alpha enabled. Keep the page starfield and
    // textured CSS Earth fallback visible beneath the WebGL scene.
    const renderer = globe.renderer();
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.background = 'transparent';
    globe.scene().background = null;

    // Keep the actual globe sphere visible while its bundled texture loads.
    const globeMaterial = globe.globeMaterial();
    if (globeMaterial?.color?.set) globeMaterial.color.set('#315b78');

    createSatellitePointLayer();

    window.globe = globe;
    const canvas = renderer.domElement;
    canvas.addEventListener('pointermove', event => {
      const bounds = canvas.getBoundingClientRect();
      const coords = globe.toGlobeCoords(event.clientX - bounds.left, event.clientY - bounds.top);
      const point = coords ? findNearestPoint(coords, 0.8) : null;
      const nextNorad = point?.norad_id ?? null;
      if (Number(nextNorad) !== Number(hoveredNorad)) {
        hoveredNorad = nextNorad;
        window.globeApp?.onSatelliteHovered?.(nextNorad, event.clientX, event.clientY);
      } else if (point) {
        window.globeApp?.onSatelliteHovered?.(nextNorad, event.clientX, event.clientY);
      }
    }, { passive: true });
    canvas.addEventListener('pointerleave', () => {
      hoveredNorad = null;
      window.globeApp?.onSatelliteHovered?.(null);
    });
    // Resolve point picking against the geographic grid while ignoring drag
    // gestures used to rotate Earth.
    let pointerStart = null;
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }, { passive: true });
    canvas.addEventListener('pointerup', event => {
      const start = pointerStart;
      pointerStart = null;
      if (!start || start.id !== event.pointerId
        || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      const point = findNearestRenderedPoint(event.clientX, event.clientY, canvas);
      if (point) selectSatellite(point.norad_id);
    }, { passive: true });
    canvas.addEventListener('pointercancel', () => { pointerStart = null; }, { passive: true });
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
    const globeRadius = globe.getGlobeRadius?.() || 100;
    // OrbitControls distances are Three.js world units; the view API uses
    // multiples of the globe radius.
    controls.minDistance = globeRadius * (1 + MIN_CAMERA_ALTITUDE);
    controls.maxDistance = globeRadius * (1 + MAX_CAMERA_ALTITUDE);
    globe.pointOfView(DEFAULT_CAMERA_VIEW, 0);
    } catch (error) {
      console.error('3D globe initialization failed:', error);
      globe = null;
      showGlobeError('The 3D globe could not initialize. Enable WebGL or try a browser with hardware acceleration.');
    }
    console.log('[globe.js] Globe initialization complete, globe object:', !!globe);
  }

  try {
    worker = new Worker('/js/workers/satellite-worker.js?v=orbit-picker-20261024-2');
    worker.onmessage = event => {
      if (event.data.type === 'INIT_PROGRESS') {
        showGlobeStatus(`Preparing satellite elements ${event.data.processed.toLocaleString()} / ${event.data.total.toLocaleString()}…`);
      }
      if (event.data.type === 'READY' && event.data.count === 0) {
        showGlobeStatus('No usable satellite orbital elements were found in the catalog.');
      }
      if (event.data.type === 'POSITIONS') {
        computeInFlight = false;
        renderPositions(event.data);
        if (pendingComputeTime != null) {
          const nextTime = pendingComputeTime;
          pendingComputeTime = null;
          requestPositionCompute(nextTime);
        }
      }
      if (event.data.type === 'ORBITS') {
        if (Number(event.data.norad_id) !== Number(selectedNorad)) return;
        selectedOrbitPaths = (event.data.paths || []).map(path => ({ ...path, selected: true }));
        applyOrbitVisibility();
        fitCameraToSelectedOrbit(selectedOrbitPaths);
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
  startComputeTimer(3000);
}

function createSatellitePointLayer() {
  pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setDrawRange(0, 0);
  const material = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  pointObject = new THREE.Points(pointGeometry, material);
  pointObject.frustumCulled = false;
  pointObject.renderOrder = 2;
  globe.scene().add(pointObject);
}

function configureSatellitePointBuffers(entries) {
  if (!pointGeometry) return;
  const count = entries.length;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const visibility = new Float32Array(count);
  validPositions = new Uint8Array(count);
  baseSizes = new Float32Array(count).fill(DEFAULT_MARKER_SIZE_PX);
  pointIndices = new Map();
  entries.forEach((entry, index) => {
    pointIndices.set(Number(entry.norad_id), index);
    colors.set([0.88, 0.93, 1], index * 3);
    sizes[index] = DEFAULT_MARKER_SIZE_PX;
  });
  pointGeometry.dispose();
  pointGeometry = new THREE.BufferGeometry();
  const positionBuffer = new THREE.BufferAttribute(positions, 3);
  positionBuffer.setUsage(THREE.DynamicDrawUsage);
  colorAttribute = new THREE.BufferAttribute(colors, 3);
  colorAttribute.setUsage(THREE.DynamicDrawUsage);
  sizeAttribute = new THREE.BufferAttribute(sizes, 1);
  sizeAttribute.setUsage(THREE.DynamicDrawUsage);
  visibilityAttribute = new THREE.BufferAttribute(visibility, 1);
  visibilityAttribute.setUsage(THREE.DynamicDrawUsage);
  pointGeometry.setAttribute('position', positionBuffer);
  pointGeometry.setAttribute('color', colorAttribute);
  pointGeometry.setAttribute('size', sizeAttribute);
  pointGeometry.setAttribute('visibility', visibilityAttribute);
  pointGeometry.setDrawRange(0, count);
  pointObject.geometry = pointGeometry;
  positionAttribute = positionBuffer;
}

function setPointAppearance(noradId, selected) {
  const index = pointIndices.get(Number(noradId));
  if (index == null || !colorAttribute || !sizeAttribute) return;
  colorAttribute.array.set(selected ? [1, 0.72, 0.22] : [0.88, 0.93, 1], index * 3);
  sizeAttribute.array[index] = selected ? SELECTED_MARKER_SIZE_PX : baseSizes[index];
  colorAttribute.needsUpdate = true;
  sizeAttribute.needsUpdate = true;
}

export function setCatalog(entries) {
  catalogEntries = Array.isArray(entries) ? entries : [];
  propagatedPoints = [];
  propagatedNoradIds = new Set();
  pointGrid = new Map();
  configureSatellitePointBuffers(catalogEntries);
  propagationEntries = catalogEntries;
  if (selectedNorad != null) setPointAppearance(selectedNorad, true);
  applyCatalogVisibility();
  startComputeTimer(3000);
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
  if (!worker) return;
  if (computeInFlight) {
    pendingComputeTime = time;
    return;
  }
  computeInFlight = true;
  worker.postMessage({ type: 'COMPUTE', time });
}

function renderPositions(data) {
  const expected = propagationEntries.length;
  if (!data?.positions || !data?.valid || data.positions.length !== expected * 3
    || data.valid.length !== expected) {
    showGlobeStatus('Satellite position data did not match the loaded catalog.');
    return;
  }
  const points = [];
  const pointSampleDiagnostics = [];
  const positions = positionAttribute?.array;
  if (!positions || !globe) return;
  validPositions.fill(0);
  for (let i = 0; i < propagationEntries.length; i++) {
    if (!data.valid[i]) continue;
    const point = createSatelliteMarker(propagationEntries[i],
      data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2],
    );
    if (!point) continue;
    const index = pointIndices.get(Number(point.norad_id));
    if (index == null) continue;
    const altitudeRatio = point.altitude; // createSatelliteMarker converts km to altitudeKm / 6371.
    const coords = globe.getCoords(point.lat, point.lng, altitudeRatio);
    if (!coords || ![coords.x, coords.y, coords.z].every(Number.isFinite)) continue;
    positions[index * 3] = coords.x;
    positions[index * 3 + 1] = coords.y;
    positions[index * 3 + 2] = coords.z;
    validPositions[index] = 1;
    points.push(point);
    if (!pointSampleDiagnosticsLogged && points.length <= 3) {
      const distanceFromOrigin = Math.hypot(coords.x, coords.y, coords.z);
      const globeRadius = globe.getGlobeRadius?.() || 100;
      pointSampleDiagnostics.push({
        norad_id: point.norad_id,
        latitude: point.lat,
        longitude: point.lng,
        altitudeKm: data.positions[i * 3 + 2],
        altitudeRatio,
        distanceFromOrigin,
        expectedDistance: globeRadius * (1 + altitudeRatio),
      });
    }
  }
  if (!pointSampleDiagnosticsLogged && pointSampleDiagnostics.length === 3) {
    console.info('[globe.js] Satellite point position samples (globe-radius units):', pointSampleDiagnostics);
    pointSampleDiagnosticsLogged = true;
  }
  positionAttribute.needsUpdate = true;
  propagatedPoints = points;
  propagatedNoradIds = new Set(points.map(point => Number(point.norad_id)));
  pointGrid = buildPointGrid(points);
  if (!globe) {
    showGlobeStatus(`Computed ${points.length.toLocaleString()} valid positions; the globe renderer is unavailable.`);
    return;
  }
  if (!points.length) {
    showGlobeStatus('Satellite positions are unavailable for the loaded orbital elements.');
  } else {
    showGlobeStatus(`Propagated ${points.length.toLocaleString()} satellite positions from catalog orbital elements.`);
  }
  applyPointVisibility();
}

function startComputeTimer(intervalMs) {
  if (computeTimer) clearInterval(computeTimer);
  computeTimer = window.setInterval(() => {
    const now = Date.now();
    simulationTime += (now - lastSimulationTick) * simulationRate;
    lastSimulationTick = now;
    window.simulationTime = simulationTime;
    requestPositionCompute(simulationTime);
  }, intervalMs);
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
  if (selectedNorad != null && !visibleEntries.some(entry => Number(entry.norad_id) === Number(selectedNorad))) {
    setPointAppearance(selectedNorad, false);
    selectedNorad = null;
    selectedOrbitPaths = [];
    window.globeApp?.onSatelliteCleared?.();
  }
  applyPointVisibility();
  applyOrbitVisibility();
}

function applyPointVisibility() {
  const points = satellitesVisible ? propagatedPoints.filter(point => visibleNoradIds.has(Number(point.norad_id))) : [];
  if (visibilityAttribute) {
    const visibility = visibilityAttribute.array;
    for (let i = 0; i < visibility.length; i++) {
      const entry = propagationEntries[i];
      const next = satellitesVisible && validPositions[i] && entry
        && visibleNoradIds.has(Number(entry.norad_id)) ? 1 : 0;
      if (visibility[i] !== next) visibility[i] = next;
    }
    visibilityAttribute.needsUpdate = true;
  }
  if (pointObject) pointObject.visible = satellitesVisible;
  if (propagatedPoints.length) {
    showGlobeStatus(`Displaying ${points.length.toLocaleString()} of ${propagatedPoints.length.toLocaleString()} valid satellite markers.`);
  }
}

function gridCell(lat, lng) {
  const columns = 360 / PICK_GRID_DEGREES;
  const row = Math.max(0, Math.min(89, Math.floor((lat + 90) / PICK_GRID_DEGREES)));
  const normalizedLng = ((lng + 180) % 360 + 360) % 360;
  const column = Math.floor(normalizedLng / PICK_GRID_DEGREES) % columns;
  return { row, column };
}

function buildPointGrid(points) {
  const grid = new Map();
  for (const point of points) {
    const { row, column } = gridCell(point.lat, point.lng);
    const key = `${row}:${column}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(point);
  }
  return grid;
}

function findNearestPoint(coords, maxDegrees) {
  if (!Number.isFinite(coords?.lat) || !Number.isFinite(coords?.lng)) return null;
  const { row, column } = gridCell(coords.lat, coords.lng);
  const columns = 360 / PICK_GRID_DEGREES;
  const candidates = [];
  for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
    const candidateRow = row + rowOffset;
    if (candidateRow < 0 || candidateRow >= 90) continue;
    for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
      const candidateColumn = (column + columnOffset + columns) % columns;
      for (const point of pointGrid.get(`${candidateRow}:${candidateColumn}`) || []) {
        candidates.push(point);
      }
    }
  }
  return nearestSatellitePoint(candidates, coords, maxDegrees,
    point => visibleNoradIds.has(Number(point.norad_id)));
}

// Picking through globe.toGlobeCoords() maps the click to Earth's surface.
// That is inaccurate for satellites several Earth radii above the surface.
// Compare the click with each currently rendered point in screen space and
// discard points hidden behind Earth.
function findNearestRenderedPoint(clientX, clientY, canvas) {
  if (!globe || !pointObject?.visible || !positionAttribute || !visibilityAttribute) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const camera = globe.camera();
  camera.updateMatrixWorld();
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const pointPosition = new THREE.Vector3();
  const globeRadius = globe.getGlobeRadius?.() || 100;
  const radiusSquared = globeRadius * globeRadius * 0.99;
  const coordinates = positionAttribute.array;
  const visibility = visibilityAttribute.array;
  let nearest = null;
  let nearestDistanceSquared = 12 * 12;

  for (let i = 0; i < visibility.length; i++) {
    if (!visibility[i]) continue;
    pointPosition.set(coordinates[i * 3], coordinates[i * 3 + 1], coordinates[i * 3 + 2]);
    pointPosition.project(camera);
    if (pointPosition.z < -1 || pointPosition.z > 1) continue;
    const screenX = rect.left + (pointPosition.x + 1) * rect.width / 2;
    const screenY = rect.top + (1 - pointPosition.y) * rect.height / 2;
    const dx = screenX - clientX;
    const dy = screenY - clientY;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared >= nearestDistanceSquared) continue;

    if (earthVisible) {
      const rayX = coordinates[i * 3] - cameraPosition.x;
      const rayY = coordinates[i * 3 + 1] - cameraPosition.y;
      const rayZ = coordinates[i * 3 + 2] - cameraPosition.z;
      const rayLengthSquared = rayX * rayX + rayY * rayY + rayZ * rayZ;
      const t = Math.max(0, Math.min(1,
        -(cameraPosition.x * rayX + cameraPosition.y * rayY + cameraPosition.z * rayZ) / rayLengthSquared));
      const closestX = cameraPosition.x + t * rayX;
      const closestY = cameraPosition.y + t * rayY;
      const closestZ = cameraPosition.z + t * rayZ;
      if (t < 1 && closestX * closestX + closestY * closestY + closestZ * closestZ < radiusSquared) continue;
    }

    nearestDistanceSquared = distanceSquared;
    nearest = propagationEntries[i];
  }
  return nearest;
}

function applyOrbitVisibility() {
  if (!globe) return;
  globe.pathsData(orbitsVisible ? selectedOrbitPaths : []);
}

function fitCameraToSelectedOrbit(paths) {
  if (!globe || !paths?.length) return;
  const renderer = globe.renderer();
  const camera = globe.camera();
  const canvas = renderer.domElement;
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const verticalHalfFov = camera.fov * Math.PI / 360;
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * aspect);
  const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
  let maxRadiusRatio = 1;
  for (const path of paths) {
    for (const point of path.points || []) {
      if (Number.isFinite(point.alt)) maxRadiusRatio = Math.max(maxRadiusRatio, 1 + point.alt);
    }
  }
  const requiredAltitude = maxRadiusRatio / Math.sin(limitingHalfFov) * 1.08 - 1;
  const view = globe.pointOfView();
  if (requiredAltitude > view.altitude + 0.1) {
    globe.pointOfView({ ...view, altitude: Math.min(MAX_CAMERA_ALTITUDE, requiredAltitude) }, 700);
  }
}

export function selectSatellite(noradId) {
  const entry = catalogEntries.find(item => Number(item.norad_id) === Number(noradId));
  if (!entry || !visibleEntries.includes(entry)) return;
  if (selectedNorad != null) setPointAppearance(selectedNorad, false);
  selectedNorad = entry.norad_id;
  setPointAppearance(selectedNorad, true);
  selectedOrbitPaths = [];
  if (worker) worker.postMessage({ type: 'SELECT', norad_id: selectedNorad, time: simulationTime });
  applyPointVisibility();
  applyOrbitVisibility();
  return window.globeApp?.onSatelliteSelected?.(entry);
}
function navigateSatellite(direction) {
  const visibleValidEntries = visibleEntries.filter(entry => propagatedNoradIds.has(Number(entry.norad_id)));
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
export function updateSatMarker(lat, lon, alt, name) {
  // Catalog positions are propagated from the same element set in the worker.
  // Keep this legacy API as a no-op to avoid drawing a duplicate marker.
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
  requestPositionCompute(simulationTime);
}

export function drawOrbitPath(points, noradId = selectedNorad) {
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
  const entry = catalogEntries.find(item => Number(item.norad_id) === Number(noradId));
  selectedOrbitPaths = entry ? segments.map(segmentPoints => ({
    norad_id: entry.norad_id,
    name: entry.name,
    color: '#8aff4d',
    selected: true,
    points: segmentPoints,
  })) : [];
  applyOrbitVisibility();
}
export function setOrbitsVisible(visible) {
  orbitsVisible = Boolean(visible);
  applyOrbitVisibility();
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
  globe.pointOfView(view, 400);
}

export function zoomIn() {
  if (!globe) return;
  const view = globe.pointOfView();
  setTrackedCameraView({ ...view, altitude: Math.max(MIN_CAMERA_ALTITUDE, view.altitude * 0.78) });
}

export function zoomOut() {
  if (!globe) return;
  const view = globe.pointOfView();
  setTrackedCameraView({ ...view, altitude: Math.min(MAX_CAMERA_ALTITUDE, view.altitude * 1.28) });
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
