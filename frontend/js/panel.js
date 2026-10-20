/**
 * panel.js – Updates the info panel DOM elements with satellite data.
 *
 * Provides functions to populate the position, TLE, and orbital-elements
 * sections of the side panel.
 */

/**
 * Update the position section of the info panel.
 * @param {Object} pos - Position response from the API.
 */
function updatePositionPanel(pos) {
  setText('val-lat',       `${pos.latitude.toFixed(4)}°`);
  setText('val-lon',       `${pos.longitude.toFixed(4)}°`);
  setText('val-alt',       `${pos.altitude_km.toFixed(2)} km`);
  setText('val-speed',     `${pos.velocity_km_s.toFixed(3)} km/s`);
  setText('val-direction', `${pos.heading_degrees.toFixed(1)}° ${pos.direction}`);
  setText('val-time',      formatUTC(pos.utc_time));
  setText('val-norad',     pos.norad_id);
  setText('val-epoch',     formatUTC(pos.tle_epoch));
  setText('val-age',       `${pos.tle_age_days.toFixed(1)} days`);

  // Update status badge
  const badge = document.getElementById('status-badge');
  if (pos.stale_tle) {
    badge.textContent = 'STALE';
    badge.className = 'badge badge-stale';
    badge.title = pos.stale_warning || 'TLE data may be outdated';
  } else {
    badge.textContent = 'LIVE';
    badge.className = 'badge badge-live';
    badge.title = 'Fresh data';
  }
  badge.style.display = 'inline-block';
}

/**
 * Update the orbital elements section.
 * @param {Object} elems - OrbitalElements response from the API.
 */
function updateElementsPanel(elems) {
  setText('val-inc',    `${elems.inclination_deg.toFixed(4)}°`);
  setText('val-ecc',    elems.eccentricity.toFixed(7));
  setText('val-raan',   `${elems.raan_deg.toFixed(4)}°`);
  setText('val-argp',   `${elems.arg_of_perigee_deg.toFixed(4)}°`);
  setText('val-ma',     `${elems.mean_anomaly_deg.toFixed(4)}°`);
  setText('val-mm',     `${elems.mean_motion_rev_per_day.toFixed(8)} rev/day`);
  setText('val-period', `${elems.orbital_period_minutes.toFixed(2)} min`);
  setText('val-bstar',  elems.bstar.toExponential(5));
}

/**
 * Show a loading state in the panel.
 */
function showLoading(msg) {
  const spinner = document.getElementById('loading-spinner');
  const statusText = document.getElementById('status-text');
  if (spinner) spinner.style.display = 'block';
  if (statusText) statusText.textContent = msg || 'Loading…';
}

/**
 * Hide the loading spinner and set status.
 */
function hideLoading(msg) {
  const spinner = document.getElementById('loading-spinner');
  const statusText = document.getElementById('status-text');
  if (spinner) spinner.style.display = 'none';
  if (statusText) statusText.textContent = msg || 'Connected';
}

/**
 * Show an error message.
 */
function showError(title, detail) {
  const overlay = document.getElementById('message-overlay');
  const oTitle = document.getElementById('overlay-title');
  const oText = document.getElementById('overlay-text');
  if (oTitle) oTitle.textContent = title;
  if (oText) oText.textContent = detail || '';
  if (overlay) overlay.classList.add('visible');

  const badge = document.getElementById('status-badge');
  if (badge) {
    badge.textContent = 'ERROR';
    badge.className = 'badge badge-error';
    badge.style.display = 'inline-block';
  }
  hideLoading('Error');
}

/**
 * Hide the error overlay.
 */
function hideError() {
  const overlay = document.getElementById('message-overlay');
  if (overlay) overlay.classList.remove('visible');
}

/**
 * Populate the satellite dropdown from API response.
 * @param {Array} satellites - List of {name, norad_id}.
 * @param {number} selectedId - Currently selected NORAD ID.
 */
function populateDropdown(satellites, selectedId) {
  const select = document.getElementById('sat-select');
  if (!select) return;
  select.innerHTML = '';

  satellites.forEach(sat => {
    const opt = document.createElement('option');
    opt.value = sat.norad_id;
    opt.textContent = `${sat.name} (${sat.norad_id})`;
    if (sat.norad_id === selectedId) opt.selected = true;
    select.appendChild(opt);
  });
}

// --- Helpers ----------------------------------------------------------------

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatUTC(isoStr) {
  if (!isoStr) return '—';
  // Show a compact UTC string
  return isoStr.replace('T', ' ').replace('Z', ' UTC');
}
