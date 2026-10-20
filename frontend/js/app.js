/**
 * app.js – Main application controller.
 *
 * Initializes the globe, loads the satellite list, and starts the
 * polling loop that keeps the position marker and info panel updated.
 */

// Currently selected NORAD catalog number
let currentSatId = 25544;

// Polling interval handle
let pollTimer = null;

// Chart.js instance for altitude
let altChart = null;
let altData = [];
const MAX_ALT_POINTS = 60;

// ==========================================================================
// Initialisation
// ==========================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // 1. Create the 3D globe
  initGlobe('globe-container');
  showLoading('Connecting to backend…');

  // 2. Check backend health
  try {
    await apiHealth();
  } catch (err) {
    showError('Backend Offline', 'Could not connect to the backend server. Is it running?');
    return;
  }

  // 3. Populate satellite dropdown
  try {
    const list = await apiSatellites();
    populateDropdown(list.satellites, currentSatId);
  } catch (err) {
    console.warn('Could not load satellite list, using defaults');
  }

  // 4. Wire up UI events
  setupEventListeners();

  // 5. Initialise chart
  initAltitudeChart();

  // 6. Load initial satellite
  await loadSatellite(currentSatId);

  // 7. Start position polling (every 3 seconds)
  startPolling();
});

// ==========================================================================
// Event listeners
// ==========================================================================

function setupEventListeners() {
  // Satellite selector change
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
