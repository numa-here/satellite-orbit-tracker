/**
 * app.js – Main application controller for the full catalog UI.
 *
 * Orchestrates globe.gl rendering, the WebGL Points catalog layer,
 * search/filters UI, and the legacy single-satellite tracking panel.
 */

import {
  initGlobe, setCatalog as globeSetCatalog, setFilters, setSearch,
  selectSatellite, hoverSatellite, updateSatMarker, drawOrbitPath,
  followSatellite, setFollowMode, getCatalog, getSelectedNorad,
  setSatellitesVisible, setEarthVisible,
  zoomIn, zoomOut, undoCamera, redoCamera,
} from './globe.js?v=orbit-globe-20261023-9';

import { initCatalogUI, setCatalog as catalogSetCatalog } from './catalog-ui.js?v=orbit-globe-20261023-9';

// --- State -----------------------------------------------------------------

let currentSatId = 25544;
let pollTimer = null;
let altChart = null;
let altData = [];
const MAX_ALT_POINTS = 60;

// Expose callbacks for globe.js
window.globeApp = {
  onWorkerReady: () => {
    console.log('Worker ready in app');
  },
  onSatelliteSelected: (entry) => {
    currentSatId = entry.norad_id;
    const select = document.getElementById('sat-select');
    if (select) select.value = currentSatId;
    // Shareable URL hash
    history.replaceState(null, '', `#norad=${currentSatId}`);
    loadSatellite(currentSatId);
    updateHudFromEntry(entry);
  },
  fetchAndDrawTrack: async (noradId) => {
    try {
      const track = await apiTrack(noradId, 90, 30);
      drawOrbitPath(track.points);
    } catch (err) {
      console.warn('Could not fetch track:', err);
    }
  },
};

// ===========================================================================
// Initialisation
// ===========================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // 1. Create the 3D globe + Points layer
  initGlobe('globe-container');
  // Wire the floating controls before any network requests. A slow catalog
  // must not leave the visible buttons inert while the page is loading.
  if (typeof window.renderGraphsPanel === 'function') window.renderGraphsPanel();
  setupEventListeners();
  setupPanelTheme();
  initAltitudeChart();
  showLoading('Connecting to backend…');

  // Initialize catalog UI (search + filters). catalog-ui owns the search
  // input and filter chips, so react to changes centrally via onChange
  // instead of attaching duplicate listeners here.
  initCatalogUI({
    debounceMs: 150,
    onChange: ({ entries, filters, searchQuery }) => {
      const input = document.getElementById('catalog-search');
      const dropdown = document.getElementById('search-dropdown');
      renderSearchDropdown(input, dropdown, entries);
      setFilters(filters);
      // 'setSearch' here is globe.js's export (syncs text filter to the globe layer).
      setSearch(searchQuery);
    },
  });
  const searchInput = document.getElementById('catalog-search');
  const searchDropdown = document.getElementById('search-dropdown');
  searchInput?.addEventListener('focus', () => renderSearchDropdown(searchInput, searchDropdown, getCatalog()));
  searchInput?.addEventListener('keydown', event => {
    if (event.key === 'Escape' && searchDropdown) searchDropdown.style.display = 'none';
    if (event.key === 'Enter') searchDropdown?.querySelector('.result-item')?.click();
  });

  // 3. Check backend health (non-fatal - globe always renders even if catalog fails)
  try {
    await apiHealth();
  } catch (err) {
    // Show error but continue - globe still renders without catalog
    showError('Backend Offline', 'Could not connect to the backend server. Is it running?', true);
  }

  // 4. Load the full catalog in background (non-blocking)
  //    Globe already rendered above; catalog updates asynchronously
  try {
    showLoading('Loading satellite catalog…');
    // The backend handles upstream, cache, and bundled seed fallbacks.
    const catalog = await loadCatalogWithFallback();
    // Backend returns {"objects": [...], "count": N, "sources": [...], "updated_at": ...}
    // Frontend expects a list of satellite entries
    const entries = catalog.objects || [];
    globeSetCatalog(entries);
    catalogSetCatalog(entries);
    const staleText = catalog.stale ? ' (stale)' : '';
    hideLoading(`Catalog loaded: ${entries.length} objects from ${catalog.source}${staleText}`);
    // Update source info in bottom status bar
    updateSourceInfo(catalog.source, catalog.stale);
    // 5. Populate satellite dropdown (legacy) - only after catalog loads
    try {
      const list = await apiSatellites();
      populateDropdown(list.satellites, currentSatId);
    } catch (err) {
      console.warn('Could not populate satellite dropdown:', err);
    }
  } catch (err) {
    // Catalog failed - show visible error with Retry button instead of silent "0 of 0"
    console.warn('Could not load catalog:', err);
    showCatalogError(err);
    // Still try to populate dropdown with empty list so UI doesn't break
    try {
      populateDropdown([], currentSatId);
    } catch (e) {
      // ignore
    }
  }

  // 5. Populate satellite dropdown (legacy)
  try {
    const list = await apiSatellites();
    populateDropdown(list.satellites, currentSatId);
  } catch (err) {
    console.warn('Could not load satellite list, using defaults');
  }

  // 8. Read shareable satellite from URL hash (#norad=25544)
  const hashMatch = location.hash.match(/#norad=(\d+)/);
  if (hashMatch) currentSatId = parseInt(hashMatch[1], 10);

  // 8. Load initial satellite
  await loadSatellite(currentSatId);

// 10. Position polling is handled by the Web Worker via onmessage
  startPolling();
});

// ==========================================================================
// Event listeners
// ==========================================================================

function setupEventListeners() {
  // Satellite selector change (legacy)
  const select = document.getElementById('sat-select');
  if (select) {
    select.addEventListener('change', async (e) => {
      currentSatId = parseInt(e.target.value, 10);
      await loadSatellite(currentSatId);
    });
  }

  // Follow button toggle
  const btnFollow = document.getElementById('btn-follow');
  if (btnFollow) {
    btnFollow.addEventListener('click', () => {
      const isActive = btnFollow.classList.toggle('active');
      setFollowMode(isActive);
      btnFollow.textContent = isActive ? '📷 Following' : '📷 Follow';
    });
  }

  // About modal
  const btnAbout = document.getElementById('btn-about');
  const aboutModal = document.getElementById('about-modal');
  const aboutClose = document.getElementById('about-close');

  if (btnAbout && aboutModal) {
    btnAbout.addEventListener('click', () => aboutModal.classList.add('visible'));
  }
  if (aboutClose && aboutModal) {
    aboutClose.addEventListener('click', () => aboutModal.classList.remove('visible'));
  }
  if (aboutModal) {
    aboutModal.addEventListener('click', (e) => {
      if (e.target === aboutModal) aboutModal.classList.remove('visible');
    });
  }





  // Refresh catalog
  const btnRefresh = document.getElementById('btn-refresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      btnRefresh.classList.add('refreshing');
      try {
        const catalog = await apiCatalog(true);
        // Backend returns {"objects": [...], "count": N, ...}
        // Frontend expects a list of satellite entries
        const entries = catalog.objects || [];
        globeSetCatalog(entries);
        catalogSetCatalog(entries);
        hideLoading(`Catalog refreshed: ${entries.length} objects`);
      } catch (err) {
        console.warn('Refresh failed:', err);
      } finally {
        btnRefresh.classList.remove('refreshing');
      }
    });
  }

  // Center toolbar buttons
  const btnToggleSats = document.getElementById('btn-toggle-sats');
  if (btnToggleSats) {
    btnToggleSats.setAttribute('aria-pressed', 'true');
    btnToggleSats.addEventListener('click', () => {
      const visible = btnToggleSats.getAttribute('aria-pressed') !== 'true';
      btnToggleSats.setAttribute('aria-pressed', String(visible));
      btnToggleSats.classList.toggle('active', visible);
      setSatellitesVisible(visible);
    });
  }
  const btnToggleEarth = document.getElementById('btn-toggle-earth');
  if (btnToggleEarth) {
    btnToggleEarth.setAttribute('aria-pressed', 'true');
    btnToggleEarth.addEventListener('click', () => {
      const visible = btnToggleEarth.getAttribute('aria-pressed') !== 'true';
      btnToggleEarth.setAttribute('aria-pressed', String(visible));
      btnToggleEarth.classList.toggle('active', visible);
      setEarthVisible(visible);
    });
  }

  const cameraActions = {
    'btn-zoom-in': zoomIn,
    'btn-zoom-out': zoomOut,
    'btn-undo': undoCamera,
    'btn-redo': redoCamera,
  };
  for (const [id, action] of Object.entries(cameraActions)) {
    document.getElementById(id)?.addEventListener('click', action);
  }

  // Panel triggers: open/close floating glass panels
  setupPanelTriggers();
}

function setupPanelTriggers() {
  const panels = {
    'btn-panel-info': 'panel-info',
    'btn-panel-graphs': 'panel-graphs',
    'btn-panel-settings': 'panel-settings',
  };

  for (const [btnId, panelId] of Object.entries(panels)) {
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    const closeBtn = document.getElementById(`close-${panelId}`);
    if (!btn || !panel) continue;

    btn.addEventListener('click', () => {
      const wasOpen = panel.classList.contains('visible');
      document.querySelectorAll('.glass-panel').forEach(p => p.classList.remove('visible'));
      if (!wasOpen) panel.classList.add('visible');
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        panel.classList.remove('visible');
      });
    }
  }

  document.getElementById('btn-panel-tle')?.addEventListener('click', () => {
    document.querySelectorAll('.glass-panel').forEach(panel => panel.classList.remove('visible'));
    document.getElementById('panel-info')?.classList.add('visible');
    window.switchInfoTab?.('tle');
  });

  document.querySelectorAll('.tab-btn').forEach(button => {
    button.addEventListener('click', () => window.switchInfoTab?.(button.dataset.tab));
  });
  document.getElementById('copy-tle')?.addEventListener('click', async () => {
    const text = document.getElementById('info-tle-data')?.textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      const button = document.getElementById('copy-tle');
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy elements'; }, 1400);
    } catch (_) {
      const button = document.getElementById('copy-tle');
      if (button) button.textContent = 'Select and copy the text above';
    }
  });
  window.switchInfoTab?.('overview');

  // Click outside a panel closes it
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.glass-panel') && !e.target.closest('.panel-trigger')) {
      document.querySelectorAll('.glass-panel').forEach(p => p.classList.remove('visible'));
    }
  });
}



// Render search autocomplete dropdown
function renderSearchDropdown(input, dropdown, entries) {
  if (!input || !dropdown) return;
  const q = input.value.toLowerCase().trim();
  if (!q && document.activeElement !== input) { dropdown.style.display = 'none'; return; }
  const catalog = getCatalog();
  const matches = catalog.filter(e => {
    const haystack = [
      e.name || '', String(e.norad_id || ''), e.intl_designator || '',
      e.country || '', e.object_type || '',
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });

  if (matches.length === 0) {
    dropdown.innerHTML = '<div class="result-summary">No matching satellites</div>';
    dropdown.style.display = q ? 'block' : 'none';
    return;
  }

  // Keep the list responsive for 20k objects while allowing scroll/search to
  // reach every catalog row, not only a fixed handful of suggestions.
  const pageSize = 60;
  let shown = Math.min(pageSize, matches.length);
  const render = () => {
    const noun = q ? 'match' : 'in catalog';
    dropdown.innerHTML = `<div class="result-summary">${matches.length.toLocaleString()} satellites ${noun} · showing ${shown.toLocaleString()}</div>` +
      matches.slice(0, shown).map(e => `
        <button type="button" class="result-item" data-norad="${e.norad_id}">
          <span>${escapeHtml(e.name || 'Unknown')}</span>
          <span class="result-norad">NORAD ${e.norad_id}</span>
        </button>
      `).join('');
    dropdown.querySelectorAll('.result-item').forEach(item => {
      item.addEventListener('click', () => {
        const noradId = parseInt(item.dataset.norad, 10);
        const entry = catalog.find(sat => Number(sat.norad_id) === noradId);
        input.value = entry?.name || String(noradId);
        dropdown.style.display = 'none';
        selectSatellite(noradId);
      });
    });
  };
  dropdown.onscroll = () => {
    if (shown < matches.length && dropdown.scrollTop + dropdown.clientHeight >= dropdown.scrollHeight - 32) {
      shown = Math.min(shown + pageSize, matches.length);
      render();
    }
  };
  render();

  dropdown.style.display = 'block';
}

// Update bottom-left HUD from a catalog entry (name)
function updateHudFromEntry(entry) {
  const title = document.getElementById('hud-title');
  if (title && entry) title.textContent = entry.name || 'Unknown satellite';
}

// Update bottom-left HUD from a position response (live numbers)
function updateHud(pos) {
  const el = (id, value) => { const e = document.getElementById(id); if (e) e.textContent = value; };
  el('hud-speed', `${((pos.velocity_km_s || 0) * 3600).toFixed(0)} km/h`);
  el('hud-height', `${(pos.altitude_km || 0).toFixed(0)} km`);
  el('hud-lat', `${(pos.latitude || 0).toFixed(2)}°`);
  el('hud-lon', `${(pos.longitude || 0).toFixed(2)}°`);
  const timeLabel = pos.utc_time ? new Date(pos.utc_time).toLocaleTimeString() : '';
  if (typeof window.addGraphPoint === 'function') {
    window.addGraphPoint('graph-altitude', timeLabel, pos.altitude_km || 0);
    window.addGraphPoint('graph-speed', timeLabel, pos.velocity_km_s || 0);
    window.addGraphPoint('graph-lat', timeLabel, pos.latitude || 0);
    window.addGraphPoint('graph-lon', timeLabel, pos.longitude || 0);
  }
}

function setupPanelTheme() {
  const button = document.getElementById('panel-theme-toggle');
  if (!button) return;
  const apply = light => {
    document.body.classList.toggle('panels-light', light);
    button.setAttribute('aria-pressed', String(light));
    button.textContent = light ? 'Use dark panels' : 'Use light panels';
    try { localStorage.setItem('orbit-tracker-panel-theme', light ? 'light' : 'dark'); } catch (_) {}
  };
  let light = false;
  try { light = localStorage.getItem('orbit-tracker-panel-theme') === 'light'; } catch (_) {}
  apply(light);
  button.addEventListener('click', () => apply(!document.body.classList.contains('panels-light')));
}

// ==========================================================================
// Data loading
// ==========================================================================

/**
 * Load all data for a satellite: position, track, and elements.
 */
async function loadSatellite(noradId) {
  showLoading(`Loading satellite ${noradId}…`);
  hideError();
  altData = [];
  const entry = getCatalog().find(item => Number(item.norad_id) === Number(noradId));
  if (entry) window.updateInfoPanel?.(entry, null, null);

  try {
    const [positionResult, trackResult, elementsResult] = await Promise.allSettled([
      apiPosition(noradId),
      apiTrack(noradId, 90, 30),
      apiElements(noradId),
    ]);
    const pos = positionResult.status === 'fulfilled'
      ? positionResult.value
      : propagateOmmPosition(entry, Date.now());
    if (!pos) throw positionResult.status === 'rejected'
      ? positionResult.reason
      : new Error('No orbital elements are available for this satellite.');
    const track = trackResult.status === 'fulfilled'
      ? trackResult.value
      : { points: propagateOmmTrack(entry, pos.utc_time) };
    const elems = elementsResult.status === 'fulfilled'
      ? elementsResult.value
      : orbitalElementsFromOmm(entry);

    // Update globe
    updateSatMarker(pos.latitude, pos.longitude, pos.altitude_km, pos.name);
    if (track.points?.length) drawOrbitPath(track.points);

    // Update info panel
    updatePositionPanel(pos);
    updateElementsPanel(elems);
    window.updateInfoPanel?.(entry, pos, elems);

    // Update bottom-left HUD
    updateHud(pos);

    // Seed the altitude chart
    addAltitudePoint(pos.utc_time, pos.altitude_km);

    const fallback = positionResult.status === 'rejected' ? ' · local OMM propagation' : '';
    hideLoading(`Tracking: ${pos.name}${fallback}`);
  } catch (err) {
    console.error('Failed to load satellite:', err);
    if (err.message.includes('not found')) {
      showError('Satellite Not Found', `No data for NORAD ID ${noradId}.`);
    } else {
      showError('Error Loading Data', err.message);
    }
  }
}

// ==========================================================================
// Polling
// ==========================================================================

function createOmmSatrec(entry) {
  if (!entry?.omm || typeof window.satellite?.json2satrec !== 'function') return null;
  try { return window.satellite.json2satrec(entry.omm); } catch (_) { return null; }
}

function propagateOmmPosition(entry, timeMs) {
  const satrec = createOmmSatrec(entry);
  if (!satrec) return null;
  try {
    const date = new Date(timeMs);
    const result = window.satellite.propagate(satrec, date);
    if (!result?.position || !result?.velocity) return null;
    const geo = window.satellite.eciToGeodetic(result.position, window.satellite.gstime(date));
    if (!geo) return null;
    const epoch = entry.omm.EPOCH || null;
    const ageDays = epoch ? (date.getTime() - Date.parse(epoch)) / 86400000 : null;
    return {
      name: entry.name, norad_id: entry.norad_id,
      latitude: geo.latitude * 180 / Math.PI,
      longitude: window.satellite.degreesLong(geo.longitude),
      altitude_km: geo.height,
      velocity_km_s: Math.hypot(result.velocity.x, result.velocity.y, result.velocity.z),
      heading_degrees: null, direction: '', utc_time: date.toISOString(),
      tle_epoch: epoch, tle_age_days: Number.isFinite(ageDays) ? ageDays : null,
      stale_tle: Boolean(entry.stale) || (Number.isFinite(ageDays) && ageDays > 7),
      stale_warning: entry.stale ? 'Catalog is using a cached or bundled orbital record.' : null,
    };
  } catch (_) { return null; }
}

function propagateOmmTrack(entry, startTime) {
  const satrec = createOmmSatrec(entry);
  const meanMotion = Number(entry?.omm?.MEAN_MOTION);
  if (!satrec || !(meanMotion > 0)) return [];
  const start = Date.parse(startTime) || Date.now();
  const periodMinutes = 1440 / meanMotion;
  const points = [];
  for (let i = 0; i <= 120; i++) {
    const date = new Date(start + periodMinutes * 60000 * i / 120);
    try {
      const result = window.satellite.propagate(satrec, date);
      if (!result?.position) continue;
      const geo = window.satellite.eciToGeodetic(result.position, window.satellite.gstime(date));
      if (geo) points.push({ lat: geo.latitude * 180 / Math.PI, lng: window.satellite.degreesLong(geo.longitude), alt: Math.max(0.0005, geo.height / 6371) });
    } catch (_) { /* Skip invalid points while retaining the rest of the orbit. */ }
  }
  return points;
}

function orbitalElementsFromOmm(entry) {
  const omm = entry?.omm;
  if (!omm) return null;
  const meanMotion = Number(omm.MEAN_MOTION);
  const eccentricity = Number(omm.ECCENTRICITY);
  const semiMajorKm = meanMotion > 0 ? Math.cbrt(398600.8 / Math.pow(meanMotion * 2 * Math.PI / 86400, 2)) : NaN;
  return {
    inclination_deg: Number(omm.INCLINATION), eccentricity,
    raan_deg: Number(omm.RA_OF_ASC_NODE), arg_of_perigee_deg: Number(omm.ARG_OF_PERICENTER),
    mean_anomaly_deg: Number(omm.MEAN_ANOMALY), mean_motion_rev_per_day: meanMotion,
    orbital_period_minutes: meanMotion > 0 ? 1440 / meanMotion : NaN,
    apogee_km: Number.isFinite(semiMajorKm) ? semiMajorKm * (1 + eccentricity) - 6378.135 : NaN,
    perigee_km: Number.isFinite(semiMajorKm) ? semiMajorKm * (1 - eccentricity) - 6378.135 : NaN,
    bstar: Number(omm.BSTAR),
  };
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollPosition, 3000);
}

async function pollPosition() {
  const entry = getCatalog().find(item => Number(item.norad_id) === Number(currentSatId));
  try {
    let pos;
    try {
      pos = await apiPosition(currentSatId);
    } catch (err) {
      pos = propagateOmmPosition(entry, Date.now());
      if (!pos) throw err;
    }
    updateSatMarker(pos.latitude, pos.longitude, pos.altitude_km, pos.name);
    updatePositionPanel(pos);
    window.updateInfoPanel?.(entry, pos, null);
    updateHud(pos);
    addAltitudePoint(pos.utc_time, pos.altitude_km);
  } catch (err) {
    console.warn('Position poll failed:', err.message);
    // Don't show a full error on a single poll failure
  }
}

// ==========================================================================
// Altitude chart (Chart.js)
// ==========================================================================

function initAltitudeChart() {
  const canvas = document.getElementById('altitude-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  altChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Altitude (km)',
        data: [],
        borderColor: '#00d4ff',
        backgroundColor: '#00d4ff20',
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          display: true,
          ticks: { color: '#8892a0', maxRotation: 0, maxTicksLimit: 5, font: { size: 9 } },
          grid: { color: '#1e2a3a40' },
        },
        y: {
          display: true,
          ticks: { color: '#8892a0', font: { size: 9 } },
          grid: { color: '#1e2a3a40' },
        },
      },
    },
  });
}

function addAltitudePoint(timeStr, altKm) {
  if (!altChart) return;

  // Use just HH:MM:SS for the label
  const label = timeStr ? timeStr.split('T')[1]?.replace('Z', '') || '' : '';

  altData.push({ label, value: altKm });
  if (altData.length > MAX_ALT_POINTS) altData.shift();

  altChart.data.labels = altData.map(d => d.label);
  altChart.data.datasets[0].data = altData.map(d => d.value);
  altChart.update('none');  // skip animation for smooth updates
}

// Simple HTML escape for search results
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Show loading bar message
 */
function showLoading(message) {
  const existing = document.getElementById('app-loading');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.id = 'app-loading';
  bar.style.position = 'fixed';
  bar.style.top = '0';
  bar.style.left = '0';
  bar.style.width = '100%';
  bar.style.height = '4px';
  bar.style.zIndex = '50';
  bar.style.pointerEvents = 'none';
  bar.style.background = 'var(--accent)';
  const text = document.createElement('div');
  text.style.position = 'absolute';
  text.style.top = '50%';
  text.style.left = '50%';
  text.style.transform = 'translate(-50%, -50%)';
  text.style.color = 'var(--text)';
  text.style.fontSize = '0.85rem';
  text.style.padding = '8px';
  text.textContent = message;
  bar.appendChild(text);
  document.body.appendChild(bar);
}

/**
 * Hide loading bar
 */
function hideLoading(message) {
  const bar = document.getElementById('app-loading');
  if (bar) {
    bar.remove();
  }
  // Update bottom status bar if message provided
  if (message && document.getElementById('source-info')) {
    document.getElementById('source-info').textContent = message;
  }
}

/**
 * Show catalog error with Retry button instead of silent "0 of 0"
 */
function showCatalogError(err) {
  // Remove any existing error overlay
  const existing = document.getElementById('catalog-error-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'catalog-error-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '20px';
  overlay.style.left = '50%';
  overlay.style.transform = 'translateX(-50%)';
  overlay.style.zIndex = '100';
  overlay.style.background = 'rgba(18, 21, 34, 0.92)';
  overlay.style.backdropFilter = 'blur(8px)';
  overlay.style.border = '1px solid var(--panel-border)';
  overlay.style.borderRadius = '8px';
  overlay.style.padding = '16px 24px';
  overlay.style.color = 'var(--text)';
  overlay.style.maxWidth = '90%';
  overlay.style.textAlign = 'center';

  overlay.innerHTML = `
    <div style="font-size: 0.9rem; margin-bottom: 12px; color: var(--text-dim);">
      Unable to load satellite catalog
    </div>
    <div style="font-size: 0.85rem; margin-bottom: 16px; color: var(--text-dim);">
      ${escapeHtml(err.message || err.toString())}
    </div>
    <button id="retry-catalog" style="
      background: var(--accent);
      color: #0b0d17;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 0.9rem;
      cursor: pointer;
      font-family: var(--font-sans);
    ">
      Retry
    </button>
  `;

  // Add Retry button handler
  const retryBtn = overlay.querySelector('#retry-catalog');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      overlay.remove();
      try {
        showLoading('Retrying catalog load…');
        const catalog = await loadCatalogWithFallback();
        const entries = catalog.objects || [];
        globeSetCatalog(entries);
        catalogSetCatalog(entries);
        const staleText = catalog.stale ? ' (stale)' : '';
        hideLoading(`Catalog loaded: ${entries.length} objects from ${catalog.source}${staleText}`);
        if (document.getElementById('source-info')) {
          document.getElementById('source-info').textContent = `Source: ${catalog.source}`;
        }
      } catch (err2) {
        console.warn('Catalog retry failed:', err2);
        showCatalogError(err2);
      }
    });
  }

  document.body.appendChild(overlay);
}

/**
 * Load the catalog from the backend, which handles upstream, cache, and
 * bundled OMM seed fallbacks server-side.
 */
async function loadCatalogWithFallback() {
  const catalog = await apiCatalog(false);
  if (!catalog || !Array.isArray(catalog.objects) || catalog.objects.length === 0) {
    throw new Error('The backend returned an empty satellite catalog. Check its catalog source and bundled seed data.');
  }
  const source = catalog.source || (Array.isArray(catalog.sources) && catalog.sources.length
    ? catalog.sources.join(', ')
    : 'Backend');
  return { ...catalog, source, stale: Boolean(catalog.stale) };
}

/**
 * Update the bottom status bar with source info
 */
function updateSourceInfo(source, stale) {
  const container = document.getElementById('bottom-stats');
  if (!container) return;

  const sourceEl = document.getElementById('source-info');
  if (sourceEl) {
    sourceEl.textContent = `Source: ${source} ${stale ? '(stale)' : ''}`;
  } else {
    const span = document.createElement('span');
    span.id = 'source-info';
    span.style.marginLeft = 'auto';
    span.style.color = 'var(--text-dim)';
    span.textContent = `Source: ${source} ${stale ? '(stale)' : ''}`;
    container.appendChild(span);
  }
}
