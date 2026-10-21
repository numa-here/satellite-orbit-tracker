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
} from './globe.js';

import { initCatalogUI, setCatalog as catalogSetCatalog } from './catalog-ui.js';

// --- State -----------------------------------------------------------------

let currentSatId = 25544;
let pollTimer = null;
let altChart = null;
let altData = [];
const MAX_ALT_POINTS = 60;

let catalogLoaded = false;
let followTarget = null;

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
  showLoading('Connecting to backend…');

  // 2. Initialize catalog UI (search + filters). catalog-ui owns the search
  // input and filter chips, so react to changes centrally via onChange
  // instead of attaching duplicate listeners here.
  initCatalogUI({
    debounceMs: 150,
    onChange: ({ entries, filters, searchQuery }) => {
      const input = document.getElementById('catalog-search');
      const dropdown = document.getElementById('search-dropdown');
      renderSearchDropdown(input, dropdown, entries);
      globeSetFilters(filters);
      // 'setSearch' here is globe.js's export (syncs text filter to the globe layer).
      setSearch(searchQuery);
    },
  });

  // 3. Check backend health
  try {
    await apiHealth();
  } catch (err) {
    showError('Backend Offline', 'Could not connect to the backend server. Is it running?');
    return;
  }

  // 4. Load the full catalog
  try {
    showLoading('Loading satellite catalog…');
    const catalog = await apiCatalog(false);
    // Backend returns {"objects": [...], "count": N, "sources": [...], "updated_at": ...}
    // Frontend expects a list of satellite entries
    const entries = catalog.objects || [];
    globeSetCatalog(entries);
    catalogSetCatalog(entries);
    catalogLoaded = true;
    hideLoading(`Catalog loaded: ${entries.length} objects`);
  } catch (err) {
    console.warn('Could not load catalog:', err);
    hideLoading('Catalog unavailable');
  }

  // 5. Populate satellite dropdown (legacy)
  try {
    const list = await apiSatellites();
    populateDropdown(list.satellites, currentSatId);
  } catch (err) {
    console.warn('Could not load satellite list, using defaults');
  }

  // 6. Wire up UI events
  setupEventListeners();

  // 7. Initialise chart
  initAltitudeChart();

  // 8. Read shareable satellite from URL hash (#norad=25544)
  const hashMatch = location.hash.match(/#norad=(\d+)/);
  if (hashMatch) currentSatId = parseInt(hashMatch[1], 10);

  // 8. Load initial satellite
  await loadSatellite(currentSatId);

  // 9. Start position polling (every 3 seconds)
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
        const entries = catalog.satellites || catalog.entries || catalog;
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

  // Time controls
  const btnNow = document.getElementById('btn-time-now');
  const btnFaster = document.getElementById('btn-time-faster');
  const btnSlower = document.getElementById('btn-time-slower');
  if (btnNow) btnNow.addEventListener('click', () => {
    // Reset to current time – worker already uses Date.now()
    const stats = document.getElementById('stats-text');
    if (stats) stats.textContent = 'Time: Now';
  });
  if (btnFaster) btnFaster.addEventListener('click', () => {
    const stats = document.getElementById('stats-text');
    if (stats) stats.textContent = 'Time: Fast-forward';
  });
  if (btnSlower) btnSlower.addEventListener('click', () => {
    const stats = document.getElementById('stats-text');
    if (stats) stats.textContent = 'Time: Rewind';
  });

  // Center toolbar buttons
  const btnToggleSats = document.getElementById('btn-toggle-sats');
  if (btnToggleSats) {
    btnToggleSats.addEventListener('click', () => {
      // Toggle all satellites on/off via globe
      // (handled by globe.js setFilters / visibility)
      btnToggleSats.classList.toggle('active');
    });
  }
  const btnToggleEarth = document.getElementById('btn-toggle-earth');
  if (btnToggleEarth) {
    btnToggleEarth.addEventListener('click', () => {
      btnToggleEarth.classList.toggle('active');
      // Earth texture toggle – handled in globe.js if implemented
    });
  }

  // Panel triggers: open/close floating glass panels
  setupPanelTriggers();
}

function setupPanelTriggers() {
  const panels = {
    'btn-panel-info': 'panel-info',
    'btn-panel-speed': 'panel-speed',
    'btn-panel-graphs': 'panel-graphs',
    'btn-panel-settings': 'panel-settings',
  };

  for (const [btnId, panelId] of Object.entries(panels)) {
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    const closeBtn = document.getElementById(`close-${panelId}`);
    if (!btn || !panel) continue;

    btn.addEventListener('click', () => {
      // Close all other panels
      document.querySelectorAll('.glass-panel').forEach(p => p.classList.remove('visible'));
      panel.classList.toggle('visible');
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        panel.classList.remove('visible');
      });
    }
  }

  // Click outside a panel closes it
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.glass-panel') && !e.target.closest('.panel-trigger')) {
      document.querySelectorAll('.glass-panel').forEach(p => p.classList.remove('visible'));
    }
  });
}



// Render search autocomplete dropdown
function renderSearchDropdown(input, dropdown, entries) {
  const q = input.value.toLowerCase().trim();
  if (!q || !dropdown) { dropdown.style.display = 'none'; return; }
  const matches = entries.filter(e => {
    const haystack = [
      e.name || '', String(e.norad_id || ''), e.intl_designator || '',
      e.country || '', e.object_type || '',
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  }).slice(0, 8);

  if (matches.length === 0) { dropdown.style.display = 'none'; return; }

  dropdown.innerHTML = matches.map(e => `
    <div class="result-item" data-norad="${e.norad_id}">
      <div>${escapeHtml(e.name || 'Unknown')}</div>
      <div class="result-norad">NORAD ${e.norad_id}</div>
    </div>
  `).join('');

  dropdown.querySelectorAll('.result-item').forEach(item => {
    item.addEventListener('click', () => {
      const noradId = parseInt(item.dataset.norad, 10);
      input.value = '';
      dropdown.style.display = 'none';
      selectSatellite(noradId);
    });
  });

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

  try {
    // Fetch position, track, and elements in parallel
    const [pos, track, elems] = await Promise.all([
      apiPosition(noradId),
      apiTrack(noradId, 90, 30),
      apiElements(noradId),
    ]);

    // Update globe
    updateSatMarker(pos.latitude, pos.longitude, pos.altitude_km, pos.name);
    drawOrbitPath(track.points);

    // Update info panel
    updatePositionPanel(pos);
    updateElementsPanel(elems);

    // Update bottom-left HUD
    updateHud(pos);

    // Seed the altitude chart
    addAltitudePoint(pos.utc_time, pos.altitude_km);

    hideLoading(`Tracking: ${pos.name}`);
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

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollPosition, 3000);
}

async function pollPosition() {
  try {
    const pos = await apiPosition(currentSatId);
    updateSatMarker(pos.latitude, pos.longitude, pos.altitude_km, pos.name);
    updatePositionPanel(pos);
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
