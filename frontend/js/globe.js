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
let simulationTime = Date.now();
let simulationRate = 1;
let lastSimulationTick = Date.now();
let computeTimer = null;
let satellitesVisible = true;
let earthVisible = true;
let fallbackCanvas = null;
let fallbackContext = null;
let fallbackRotation = 0;
let fallbackZoom = 1;
let fallbackPaths = [];
let fallbackDragging = false;
let fallbackLastX = 0;
let fallbackPoints = [];
let fallbackMarker = null;

const CONTINENTS = [
  [[72,-168],[68,-140],[59,-128],[55,-125],[48,-124],[42,-123],[38,-118],[32,-117],[27,-110],[23,-105],[19,-104],[15,-92],[10,-84],[8,-78],[18,-77],[24,-80],[30,-81],[32,-76],[37,-74],[43,-70],[48,-67],[53,-55],[58,-62],[63,-70],[69,-82],[72,-105]],
  [[12,-81],[8,-77],[2,-78],[-5,-81],[-12,-77],[-18,-71],[-25,-70],[-33,-72],[-42,-72],[-55,-68],[-52,-60],[-40,-62],[-30,-52],[-20,-45],[-8,-35],[0,-48],[7,-56],[10,-65]],
  [[36,-10],[44,-9],[50,-5],[58,-7],[64,-18],[71,-8],[70,25],[65,32],[60,42],[55,55],[48,52],[44,40],[40,28],[36,18],[34,5]],
  [[35,-6],[31,0],[22,8],[14,13],[5,10],[-5,13],[-12,15],[-19,12],[-27,15],[-34,20],[-35,28],[-28,33],[-18,40],[-5,43],[7,41],[13,45],[20,38],[28,33],[32,24]],
  [[75,40],[70,60],[65,90],[60,115],[55,135],[48,145],[42,142],[35,130],[30,122],[23,115],[18,108],[10,105],[5,98],[10,80],[20,72],[28,62],[35,50],[45,42],[55,38],[65,35]],
  [[30,130],[25,138],[18,132],[12,125],[5,120],[-2,115],[-8,112],[-10,120],[-5,130],[0,138],[8,145],[15,150],[22,145]],
  [[-11,113],[-20,115],[-28,114],[-35,118],[-39,132],[-35,150],[-28,154],[-20,149],[-15,140]],
  [[60,-50],[70,-45],[78,-38],[82,-28],[76,-20],[68,-24],[62,-34]],
];

const CATEGORY_COLORS = {
  crewed: '#00ff88', rocket_body: '#ffaa00', debris: '#ff4444',
  constellation: '#00d4ff', gnss: '#aa00ff', weather: '#ffaa00',
  payload: '#ffffff', unknown: '#9aa4b2',
};

export function initGlobe(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (typeof window.Globe !== 'function') {
    initCanvasGlobe(container);
    showGlobeStatus('3D maps unavailable · interactive Earth fallback');
  } else {
    try {
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
    } catch (error) {
      console.error('3D globe initialization failed; using the built-in Earth view:', error);
      globe = null;
      initCanvasGlobe(container);
      showGlobeStatus('3D map failed to initialize · interactive Earth fallback');
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
  if (!computeTimer) {
    computeTimer = window.setInterval(() => {
      const now = Date.now();
      simulationTime += (now - lastSimulationTick) * simulationRate;
      lastSimulationTick = now;
      window.simulationTime = simulationTime;
      if (worker) worker.postMessage({ type: 'COMPUTE', time: simulationTime });
    }, 250);
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
    worker.postMessage({ type: 'COMPUTE', time: simulationTime });
  }
}

function renderPositions(data) {
  if (!globe && !fallbackCanvas) return;
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
  fallbackPoints = points;
  drawFallbackGlobe();
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
  if (satellitesVisible && fallbackMarker) {
    const entry = catalogEntries.find(item => Number(item.norad_id) === Number(fallbackMarker.norad_id));
    points.push({ ...fallbackMarker, color: '#ffec70', radius: 0.2, entry: entry || { name: fallbackMarker.name } });
  }
  if (globe) globe.pointsData(points);
  fallbackPoints = points;
  drawFallbackGlobe();
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
  fallbackMarker = { lat, lng: lon, altitude: Math.max(0.003, alt / 6371), name, norad_id: selectedNorad };
  applyPointVisibility();
}

export function setSatellitesVisible(visible) {
  satellitesVisible = Boolean(visible);
  applyPointVisibility();
}

export function setEarthVisible(visible) {
  earthVisible = Boolean(visible);
  if (globe) globe.showGlobe(earthVisible);
  drawFallbackGlobe();
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
  fallbackPaths = points || [];
  if (!globe) { drawFallbackGlobe(); return; }
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

function showGlobeStatus(message) {
  const status = document.getElementById('stats-text');
  if (status) status.textContent = message;
}

function initCanvasGlobe(container) {
  fallbackCanvas = document.createElement('canvas');
  fallbackCanvas.id = 'globe-fallback-canvas';
  fallbackCanvas.setAttribute('aria-label', 'Interactive rotating Earth globe');
  fallbackCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab';
  container.insertBefore(fallbackCanvas, container.firstChild);
  fallbackContext = fallbackCanvas.getContext('2d');
  if (!fallbackContext) {
    showGlobeError('Your browser could not create a graphics canvas. Enable hardware acceleration or try another browser.');
    return;
  }
  fallbackCanvas.addEventListener('pointerdown', event => {
    fallbackDragging = true;
    fallbackLastX = event.clientX;
    fallbackCanvas.setPointerCapture(event.pointerId);
    fallbackCanvas.style.cursor = 'grabbing';
  });
  fallbackCanvas.addEventListener('pointermove', event => {
    if (!fallbackDragging) return;
    fallbackRotation += (event.clientX - fallbackLastX) / 130;
    fallbackLastX = event.clientX;
    drawFallbackGlobe();
  });
  fallbackCanvas.addEventListener('pointerup', () => {
    fallbackDragging = false;
    fallbackCanvas.style.cursor = 'grab';
  });
  fallbackCanvas.addEventListener('wheel', event => {
    event.preventDefault();
    fallbackZoom = Math.max(0.7, Math.min(1.7, fallbackZoom - event.deltaY * 0.001));
    drawFallbackGlobe();
  }, { passive: false });
  fallbackCanvas.addEventListener('click', event => {
    const hit = fallbackPoints.find(point => {
      const xy = projectFallbackPoint(point.lat, point.lng);
      return xy && Math.hypot(xy.x - event.offsetX, xy.y - event.offsetY) < 12;
    });
    if (hit) selectSatellite(hit.norad_id);
  });
  window.addEventListener('resize', drawFallbackGlobe);
  window.setInterval(() => {
    if (!fallbackDragging && globe === null) fallbackRotation += 0.0015;
    drawFallbackGlobe();
  }, 33);
  drawFallbackGlobe();
}

function projectFallbackPoint(lat, lng) {
  if (!fallbackCanvas) return null;
  const rect = fallbackCanvas.getBoundingClientRect();
  const radius = Math.min(rect.width * 0.39, rect.height * 0.43) * fallbackZoom;
  const lon = (lng * Math.PI / 180) - fallbackRotation;
  const phi = lat * Math.PI / 180;
  const depth = Math.cos(phi) * Math.cos(lon);
  if (depth < 0) return null;
  return {
    x: rect.width / 2 + radius * Math.cos(phi) * Math.sin(lon),
    y: rect.height / 2 - radius * Math.sin(phi),
    depth,
    radius,
  };
}

function drawFallbackGlobe() {
  if (!fallbackCanvas || !fallbackContext) return;
  const rect = fallbackCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (fallbackCanvas.width !== w || fallbackCanvas.height !== h) {
    fallbackCanvas.width = w; fallbackCanvas.height = h;
  }
  const ctx = fallbackContext;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const cx = rect.width / 2, cy = rect.height / 2;
  const radius = Math.min(rect.width * 0.39, rect.height * 0.43) * fallbackZoom;

  for (let i = 0; i < 150; i++) {
    const x = ((i * 97.13) % 997) / 997 * rect.width;
    const y = ((i * 173.71) % 991) / 991 * rect.height;
    ctx.fillStyle = `rgba(208,225,255,${0.2 + (i % 5) * 0.11})`;
    ctx.beginPath(); ctx.arc(x, y, 0.5 + (i % 4) * 0.25, 0, Math.PI * 2); ctx.fill();
  }

  if (earthVisible) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.clip();
    const ocean = ctx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.4, radius * 0.05, cx, cy, radius * 1.2);
    ocean.addColorStop(0, '#327eae'); ocean.addColorStop(0.55, '#145074'); ocean.addColorStop(1, '#071d34');
    ctx.fillStyle = ocean; ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.strokeStyle = 'rgba(119,201,224,.16)'; ctx.lineWidth = 0.7;
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = cy - radius * Math.sin(lat * Math.PI / 180);
      const rx = radius * Math.cos(lat * Math.PI / 180);
      ctx.beginPath(); ctx.ellipse(cx, y, rx, Math.max(2, rx * 0.14), 0, 0, Math.PI * 2); ctx.stroke();
    }
    for (let turn = -2; turn <= 2; turn++) {
      ctx.beginPath(); ctx.ellipse(cx, cy, radius * Math.abs(Math.cos(turn * Math.PI / 5)), radius, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(114,165,119,.9)';
    ctx.strokeStyle = 'rgba(190,206,145,.65)'; ctx.lineWidth = 1;
    for (const polygon of CONTINENTS) {
      const pts = polygon.map(([lat, lng]) => projectFallbackPoint(lat, lng)).filter(Boolean);
      if (pts.length < 3) continue;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (const point of pts.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    const glow = ctx.createRadialGradient(cx, cy, radius * 0.92, cx, cy, radius * 1.12);
    glow.addColorStop(0, 'rgba(63,171,235,.18)'); glow.addColorStop(1, 'rgba(63,171,235,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, radius * 1.12, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(103,198,255,.75)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(0,212,255,.7)'; ctx.lineWidth = 1.3;
  ctx.beginPath();
  let drawingPath = false;
  fallbackPaths.forEach((point, index) => {
    const previous = fallbackPaths[index - 1];
    const projected = projectFallbackPoint(point.latitude, point.longitude);
    const wraps = previous && Math.abs(point.longitude - previous.longitude) > 180;
    if (!projected || wraps) { drawingPath = false; return; }
    if (!drawingPath) ctx.moveTo(projected.x, projected.y);
    else ctx.lineTo(projected.x, projected.y);
    drawingPath = true;
  });
  ctx.stroke();
  for (const point of fallbackPaths) {
    const p = projectFallbackPoint(point.latitude, point.longitude);
    if (p) {
      ctx.fillStyle = 'rgba(0,212,255,.58)';
      ctx.beginPath(); ctx.arc(p.x, p.y, 1, 0, Math.PI * 2); ctx.fill();
    }
  }
  for (const point of fallbackPoints) {
    const p = projectFallbackPoint(point.lat, point.lng);
    if (!p) continue;
    ctx.fillStyle = point.color || '#00d4ff'; ctx.shadowColor = point.color || '#00d4ff'; ctx.shadowBlur = 7;
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
  }
  if (fallbackMarker) {
    const p = projectFallbackPoint(fallbackMarker.lat, fallbackMarker.lng);
    if (p) {
      ctx.fillStyle = '#ffec70'; ctx.shadowColor = '#ffec70'; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    }
  }
}
