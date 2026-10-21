/**
 * globe.js – Manages the globe.gl 3D Earth, the full-catalog Three.js Points
 * layer, orbit paths, camera follow, and hover/click picking.
 *
 * Exports:
 *   initGlobe(containerId)        – create globe + Points layer
 *   setCatalog(entries)           – upload catalog to worker + GPU
 *   setFilters(filters)           – apply category/regime/type filters
 *   setSearch(query)              – apply search text filter
 *   selectSatellite(noradId)      // click → info panel + orbit line
 *   hoverSatellite(noradId)       // tooltip
 *   followSatellite(lat, lon)     // point camera
 *   setFollowMode(on)             // toggle auto-follow
 *   updateSatMarker(lat, lon, alt, name)  // legacy single-sat marker
 *   drawOrbitPath(points)         // legacy ground track
 */

import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

let globe = null;
let followMode = false;
let worker = null;
let workerReady = false;
let catalogEntries = [];
let visibleIndices = [];

let pointsMesh = null;
let pointsGeometry = null;
let pointsMaterial = null;
let positions = null;
let colors = null;
let sizes = null;
let valid = null;
let noradIds = null;

let orbitPathData = [];
let raycaster = null;
let mouse = new THREE.Vector2();
let hoveredNorad = null;
let selectedNorad = null;
let followTarget = null;

const CATEGORY_COLORS = {
  crewed:     [0.0, 1.0, 0.53],
  rocket_body:[1.0, 0.67, 0.0],
  debris:     [1.0, 0.27, 0.27],
  constellation:[0.0, 0.83, 1.0],
  gnss:       [0.67, 0.0, 1.0],
  weather:    [1.0, 0.67, 0.0],
  payload:    [1.0, 1.0, 1.0],
  unknown:    [0.4, 0.4, 0.4],
};

let satMarkerData = [];

function initGlobe(containerId) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.error('Globe container not found:', containerId);
    return;
  }

  globe = Globe()
    .globeImageUrl('https://unpkg.com/three-globe@2.31.3/example/img/earth-blue-marble.jpg')
    .bumpImageUrl('https://unpkg.com/three-globe@2.31.3/example/img/earth-topology.png')
    .backgroundImageUrl('https://unpkg.com/three-globe@2.31.3/example/img/night-sky.png')
    .showAtmosphere(true)
    .atmosphereColor('#4da6ff')
    .atmosphereAltitude(0.15)
    (container);

  window.globe = globe;

  const scene = globe.scene();

  pointsGeometry = new THREE.BufferGeometry();
  positions = new Float32Array(0);
  colors = new Float32Array(0);
  sizes = new Float32Array(0);
  noradIds = new Int32Array(0);
  valid = new Uint8Array(0);

  pointsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  pointsGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  pointsGeometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  pointsGeometry.setAttribute('noradId', new THREE.BufferAttribute(noradIds, 1));

  pointsMaterial = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      attribute vec3 position;
      attribute vec3 color;
      attribute float size;
      attribute float noradId;
      varying vec3 vColor;
      varying float vNoradId;
      void main() {
        vColor = color;
        vNoradId = noradId;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float r = length(gl_PointCoord - vec2(0.5));
        if (r > 0.5) discard;
        float a = 1.0 - smoothstep(0.30, 0.50, r);
        gl_FragColor = vec4(vColor, a);
      }
    `,
    transparent: true,
    vertexColors: true,
  });

  pointsMesh = new THREE.Points(pointsGeometry, pointsMaterial);
  pointsMesh.frustumCulled = false;
  scene.add(pointsMesh);

  raycaster = new THREE.Raycaster();

  if (typeof Worker !== 'undefined') {
    worker = new Worker('/js/workers/satellite-worker.js');
    worker.onmessage = (e) => {
      const { type } = e.data;
      if (type === 'READY') {
        workerReady = true;
        console.log(`Catalog worker ready: ${e.data.count} objects`);
        if (window.globeApp) window.globeApp.onWorkerReady();
      } else if (type === 'POSITIONS') {
        onWorkerPositions(e.data);
      }
    };
    worker.onerror = (err) => {
      console.error('Worker error:', err);
      workerReady = false;
      if (window.globeApp) window.globeApp.onWorkerReady();
    };
  } else {
    console.warn('Web Workers not supported');
    workerReady = false;
    if (window.globeApp) window.globeApp.onWorkerReady();
  }

  const onResize = () => {
    globe.width(container.clientWidth);
    globe.height(container.clientHeight);
  };
  window.addEventListener('resize', onResize);
  onResize();

  const controls = globe.controls();
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.3;

  // Zoom limits: just above the surface out to about GEO distance
  // (GEO radius ≈ 42,164 km ≈ 6.6 Earth radii).
  controls.minDistance = 1.02;
  controls.maxDistance = 6.6;

  // Start close enough that Earth fills most of the screen.
  globe.pointOfView({ lat: 20, lng: 0, altitude: 1.45 }, 1500);

  container.addEventListener('mousemove', (e) => onMouseMove(e, container));
  container.addEventListener('mousedown', (e) => onMouseDown(e, container));

  animate();
}

/** Upload catalog entries and request initial position computation. */
export function setCatalog(entries) {
  catalogEntries = entries || [];
  visibleIndices = catalogEntries.map((_, i) => i);

  const n = catalogEntries.length;
  const pos = new Float32Array(n * 3).fill(0);
  const col = new Float32Array(n * 3);
  const sz = new Float32Array(n).fill(0.005);
  const nr = new Int32Array(n);
  const val = new Uint8Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const e = catalogEntries[i];
    const c = CATEGORY_COLORS[e.category || 'unknown'] || CATEGORY_COLORS.unknown;
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    nr[i] = e.norad_id || 0;
  }

  pointsGeometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pointsGeometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  pointsGeometry.setAttribute('size', new THREE.BufferAttribute(sz, 1));
  pointsGeometry.setAttribute('noradId', new THREE.BufferAttribute(nr, 1));
  pointsGeometry.attributes.position.needsUpdate = true;
  pointsGeometry.attributes.color.needsUpdate = true;
  pointsGeometry.attributes.size.needsUpdate = true;
  pointsGeometry.attributes.noradId.needsUpdate = true;
  pointsGeometry.setDrawRange(0, n);

  if (worker && workerReady) {
    worker.postMessage({ type: 'INIT', catalog: catalogEntries.map(e => ({
      norad_id: e.norad_id, line1: e.line1 || null, line2: e.line2 || null,
      category: e.category || 'unknown',
    })) });
    worker.postMessage({ type: 'COMPUTE', time: Date.now() });
  }
}

/** Apply position data returned by the worker. */
function onWorkerPositions(data) {
  if (!pointsGeometry) return;
  const n = catalogEntries.length;
  positions = data.positions;
  colors = data.colors;
  sizes = data.sizes;
  valid = data.valid;

  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const sz = new Float32Array(n);
  const nr = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    nr[i] = catalogEntries[i].norad_id || 0;
    if (valid[i]) {
      pos[i * 3] = positions[i * 3];
      pos[i * 3 + 1] = positions[i * 3 + 1];
      pos[i * 3 + 2] = positions[i * 3 + 2];
      col[i * 3] = colors[i * 3];
      col[i * 3 + 1] = colors[i * 3 + 1];
      col[i * 3 + 2] = colors[i * 3 + 2];
      sz[i] = sizes[i];
    } else {
      pos[i * 3] = 0; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = -2;
      sz[i] = 0;
    }
  }

  pointsGeometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pointsGeometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  pointsGeometry.setAttribute('size', new THREE.BufferAttribute(sz, 1));
  pointsGeometry.setAttribute('noradId', new THREE.BufferAttribute(nr, 1));
  pointsGeometry.attributes.position.needsUpdate = true;
  pointsGeometry.attributes.color.needsUpdate = true;
  pointsGeometry.attributes.size.needsUpdate = true;
  pointsGeometry.attributes.noradId.needsUpdate = true;
  updatePointsVisibility();
}

/** Apply category / regime / object-type filters. */
export function setFilters(filters) {
  visibleIndices = [];
  for (let i = 0; i < catalogEntries.length; i++) {
    const e = catalogEntries[i];
    if (filters.category && filters.category.size > 0 && !filters.category.has(e.category || 'unknown')) continue;
    if (filters.regime && filters.regime.size > 0 && !filters.regime.has(e.orbit_regime || 'unknown')) continue;
    if (filters.objectType && filters.objectType.size > 0) {
      const ot = (e.object_type || 'UNK').replace(/\s+/g, '_').toUpperCase();
      if (!filters.objectType.has(ot)) continue;
    }
    visibleIndices.push(i);
  }
  updatePointsVisibility();
}

/** Apply search text filter. */
export function setSearch(query) {
  const q = (query || '').toLowerCase().trim();
  visibleIndices = [];
  for (let i = 0; i < catalogEntries.length; i++) {
    const e = catalogEntries[i];
    const haystack = [
      e.name || '', String(e.norad_id || ''), e.intl_designator || '',
      e.country || '', e.object_type || '',
    ].join(' ').toLowerCase();
    if (!q || haystack.includes(q)) visibleIndices.push(i);
  }
  updatePointsVisibility();
}

/** Show only visible indices; hide others inside the earth. */
function updatePointsVisibility() {
  if (!pointsGeometry || !pointsGeometry.attributes.position) return;
  const n = catalogEntries.length;
  const posAttr = pointsGeometry.attributes.position;
  const sizeAttr = pointsGeometry.attributes.size;
  const visibleSet = new Set(visibleIndices);

  for (let i = 0; i < n; i++) {
    if (!visibleSet.has(i)) {
      posAttr.setXYZ(i, 0, 0, -2);
      sizeAttr.setX(i, 0);
    }
  }
  posAttr.needsUpdate = true;
  sizeAttr.needsUpdate = true;
}

/** Select a satellite: draw orbit + notify app. */
export function selectSatellite(noradId) {
  selectedNorad = noradId;
  const entry = catalogEntries.find(e => e.norad_id === noradId);
  if (!entry) return;
  if (window.globeApp && window.globeApp.fetchAndDrawTrack) {
    window.globeApp.fetchAndDrawTrack(noradId);
  }
  if (window.globeApp && window.globeApp.onSatelliteSelected) {
    window.globeApp.onSatelliteSelected(entry);
  }
}

/** Set hovered satellite for tooltip. */
export function hoverSatellite(noradId) {
  hoveredNorad = noradId;
}

export function getSelectedNorad() { return selectedNorad; }
export function getHoveredNorad() { return hoveredNorad; }
export function getCatalog() { return catalogEntries; }

/** Legacy: single-satellite marker (kept for backward compatibility). */
export function updateSatMarker(lat, lon, alt, name) {
  const altScale = alt / 6371 + 0.005;
  satMarkerData.length = 0;
  satMarkerData.push({ lat, lng: lon, alt: altScale, name: `${name}\n${alt.toFixed(1)} km` });
  if (followMode) followSatellite(lat, lon);
}

/** Legacy: draw orbit path. */
export function drawOrbitPath(points) {
  if (!points || points.length === 0) return;
  const segments = [];
  let currentSegment = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const altScale = p.altitude_km / 6371 + 0.005;
    currentSegment.push([p.latitude, p.longitude, altScale]);
    if (i < points.length - 1) {
      const nextP = points[i + 1];
      if (Math.abs(nextP.longitude - p.longitude) > 180) {
        segments.push(currentSegment);
        currentSegment = [];
      }
    }
  }
  if (currentSegment.length > 0) segments.push(currentSegment);
  orbitPathData.length = 0;
  segments.forEach(seg => orbitPathData.push(seg));
}

/** Point camera at lat/lon. */
export function followSatellite(lat, lon) {
  if (globe) globe.pointOfView({ lat, lng: lon, altitude: 1.8 }, 1000);
}

/** Toggle follow mode. */
export function setFollowMode(on) {
  followMode = on;
  if (globe) globe.controls().autoRotate = !on;
}

/** Mouse move → hover pick. */
function onMouseMove(e, container) {
  const rect = container.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  pickPoint();
}

/** Mouse down → select pick. */
function onMouseDown(e, container) {
  const rect = container.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  const noradId = pickPoint();
  if (noradId !== null) {
    selectSatellite(noradId);
  }
}

/** Raycast against Points geometry; return hovered NORAD id. */
function pickPoint() {
  if (!pointsMesh || !pointsGeometry.attributes.position) return null;
  const camera = globe.controls ? globe.controls().object : null;
  if (!camera) return null;
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(pointsMesh, false);
  if (intersects.length === 0) {
    if (hoveredNorad !== null) hoverSatellite(null);
    return null;
  }
  let hitNorad = null;
  let hitDist = Infinity;
  for (const hit of intersects) {
    const idx = hit.index;
    if (idx === undefined || idx < 0 || idx >= catalogEntries.length) continue;
    const noradId = catalogEntries[idx].norad_id;
    if (hit.distance < hitDist) {
      hitDist = hit.distance;
      hitNorad = noradId;
    }
  }
  if (hitNorad !== hoveredNorad) hoverSatellite(hitNorad);
  return hitNorad;
}

/** Animation loop: update positions each tick. */
function animate() {
  requestAnimationFrame(animate);
  const now = Date.now();
  if (!animate.lastTick) animate.lastTick = now;
  if (worker && workerReady && now - animate.lastTick > 200) {
    animate.lastTick = now;
    worker.postMessage({ type: 'COMPUTE', time: now });
  }
  if (followMode && followTarget && globe) {
    globe.pointOfView({ lat: followTarget.lat, lng: followTarget.lon, altitude: 1.8 }, 0);
  }
}
