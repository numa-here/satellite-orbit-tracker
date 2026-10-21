/* NEW CONTENT ADDED AT LINE 1 */
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

/* --- New panel rendering helper functions -------------------------------- */

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function dataRow(label, value, tip) {
  const div = document.createElement('div');
  div.className = 'data-row';
  const labelSpan = document.createElement('span');
  labelSpan.className = 'label';
  labelSpan.textContent = label;
  if (tip) {
    const icon = document.createElement('span');
    icon.className = 'info-icon';
    icon.title = tip;
    icon.textContent = 'i';
    labelSpan.appendChild(icon);
  }
  const valueSpan = document.createElement('span');
  valueSpan.className = 'value';
  valueSpan.textContent = value;
  div.appendChild(labelSpan);
  div.appendChild(valueSpan);
  return div;
}

function section(title) {
  const h = document.createElement('h4');
  h.textContent = title;
  h.style.color = 'var(--accent)';
  h.style.textTransform = 'uppercase';
  h.style.letterSpacing = '1px';
  h.style.fontSize = '0.7rem';
  h.style.margin = '14px 0 8px 0';
  return h;
}

/**
 * Populate the Info glass panel with overview, live position, and orbit.
 * @param {Object} entry - Catalog entry
 * @param {Object} pos   - Position response from /api/position
 * @param {Object} elems - Orbital elements response from /api/elements
 */
function renderInfoPanel(entry, pos, elems) {
  const container = document.getElementById('panel-info-content');
  if (!container) return;
  container.innerHTML = '';

  const norad = entry && entry.norad_id != null ? entry.norad_id : (pos && pos.norad_id);
  const name = entry && entry.name ? entry.name : (pos && pos.name) || 'Unknown';

  container.appendChild(section('Overview'));
  container.appendChild(dataRow('Name', escapeHtml(name)));
  container.appendChild(dataRow('NORAD ID', String(norad || '—'), 'Unique catalog number assigned to every tracked object in Earth orbit.'));
  container.appendChild(dataRow('Intl. Designator', escapeHtml(entry && entry.intl_designator ? entry.intl_designator : '—')));
  container.appendChild(dataRow('Country / Owner', escapeHtml(entry && entry.country ? entry.country : '—')));
  container.appendChild(dataRow('Object Type', escapeHtml(entry && entry.object_type ? entry.object_type : '—')));
  container.appendChild(dataRow('Category', escapeHtml(entry && entry.category ? entry.category : '—')));
  container.appendChild(dataRow('Launch Date', escapeHtml(entry && entry.launch_date ? entry.launch_date : '—')));
  container.appendChild(dataRow('Launch Site', escapeHtml(entry && entry.launch_site ? entry.launch_site : '—')));
  container.appendChild(dataRow('Status', escapeHtml(entry && entry.status ? entry.status : '—')));
  container.appendChild(dataRow('RCS Size', escapeHtml(entry && entry.rcs_size != null ? String(entry.rcs_size) : '—'), 'Radar cross-section size indicator.'));

  container.appendChild(section('Live'));
  container.appendChild(dataRow('Latitude', pos ? `${pos.latitude.toFixed(4)}°` : '—'));
  container.appendChild(dataRow('Longitude', pos ? `${pos.longitude.toFixed(4)}°` : '—'));
  container.appendChild(dataRow('Altitude', pos ? `${pos.altitude_km.toFixed(2)} km` : '—', 'Height above sea level in kilometers.'));
  container.appendChild(dataRow('Speed', pos ? `${pos.velocity_km_s.toFixed(3)} km/s` : '—', 'Orbital velocity.'));
  container.appendChild(dataRow('Heading', pos ? `${pos.heading_degrees.toFixed(1)}° ${pos.direction || ''}` : '—'));
  container.appendChild(dataRow('UTC Time', pos ? formatUTC(pos.utc_time) : '—'));
  container.appendChild(dataRow('TLE Epoch', pos ? formatUTC(pos.tle_epoch) : '—', 'Reference time when orbital elements were measured.'));
  const age = pos && pos.tle_age_days != null ? pos.tle_age_days.toFixed(1) : '—';
  const ageRow = dataRow('TLE Age', age + ' days');
  if (pos && pos.stale_tle) {
    ageRow.querySelector('.value').style.color = 'var(--warning)';
    ageRow.querySelector('.value').title = pos.stale_warning || 'TLE data may be outdated';
  }
  container.appendChild(ageRow);

  container.appendChild(section('Orbit'));
  container.appendChild(dataRow('Inclination', elems ? `${elems.inclination_deg.toFixed(4)}°` : '—', 'Tilt of orbit relative to Earth\'s equator.'));
  container.appendChild(dataRow('Eccentricity', elems ? elems.eccentricity.toFixed(7) : '—', 'Orbit shape: 0 = circle, near 1 = elongated.'));
  container.appendChild(dataRow('RAAN', elems ? `${elems.raan_deg.toFixed(4)}°` : '—', 'Right Ascension of the Ascending Node.'));
  container.appendChild(dataRow('Arg. of Perigee', elems ? `${elems.arg_of_perigee_deg.toFixed(4)}°` : '—', 'Angle from ascending node to closest approach.'));
  container.appendChild(dataRow('Mean Anomaly', elems ? `${elems.mean_anomaly_deg.toFixed(4)}°` : '—', 'Position in orbit at TLE epoch.'));
  container.appendChild(dataRow('Mean Motion', elems ? `${elems.mean_motion_rev_per_day.toFixed(8)} rev/day` : '—', 'Orbits per day.'));
  container.appendChild(dataRow('Period', elems ? `${elems.orbital_period_minutes.toFixed(2)} min` : '—', 'Time for one complete orbit.'));
  container.appendChild(dataRow('Apogee', entry && entry.apogee_km != null ? `${entry.apogee_km.toFixed(0)} km` : '—', 'Highest point above Earth\'s surface.'));
  container.appendChild(dataRow('Perigee', entry && entry.perigee_km != null ? `${entry.perigee_km.toFixed(0)} km` : '—', 'Lowest point above Earth\'s surface.'));
}

/**
 * Populate the Speed / Time glass panel with time controls.
 */
function renderSpeedPanel() {
  const container = document.getElementById('panel-speed-content');
  if (!container) return;
  container.innerHTML = '';

  container.appendChild(section('Simulation Time'));

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '6px';
  row.style.flexWrap = 'wrap';

  const btnNow = document.createElement('button');
  btnNow.type = 'button'; btnNow.className = 'btn-sm';
  btnNow.id = 'panel-btn-time-now'; btnNow.textContent = 'Now';

  const btnX1 = document.createElement('button');
  btnX1.type = 'button'; btnX1.className = 'btn-sm active';
  btnX1.id = 'panel-btn-speed-1'; btnX1.textContent = '×1';

  const btnX10 = document.createElement('button');
  btnX10.type = 'button'; btnX10.className = 'btn-sm';
  btnX10.id = 'panel-btn-speed-10'; btnX10.textContent = '×10';

  const btnX100 = document.createElement('button');
  btnX100.type = 'button'; btnX100.className = 'btn-sm';
  btnX100.id = 'panel-btn-speed-100'; btnX100.textContent = '×100';

  const btnX1000 = document.createElement('button');
  btnX1000.type = 'button'; btnX1000.className = 'btn-sm';
  btnX1000.id = 'panel-btn-speed-1000'; btnX1000.textContent = '×1000';

  row.appendChild(btnNow);
  row.appendChild(btnX1);
  row.appendChild(btnX10);
  row.appendChild(btnX100);
  row.appendChild(btnX1000);
  container.appendChild(row);

  const dateRow = document.createElement('div');
  dateRow.style.marginTop = '10px';
  dateRow.innerHTML = '<label style="display:block;font-size:0.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Jump to date</label><input type="datetime-local" id="panel-jump-datetime" style="width:100%;background:#1a1e2e;border:1px solid var(--panel-border);border-radius:6px;color:var(--text);padding:6px 10px;font-size:0.8rem;">';
  container.appendChild(dateRow);

  window.panelTimeControls = {
    btnNow, btnX1, btnX10, btnX100, btnX1000,
    jumpInput: document.getElementById('panel-jump-datetime'),
  };
}

/**
 * Populate the Graphs glass panel with empty Chart.js canvases.
 */
function renderGraphsPanel() {
  const container = document.getElementById('panel-graphs-content');
  if (!container) return;
  container.innerHTML = '';

  const metrics = [
    { id: 'graph-altitude', label: 'Altitude (km)', color: '#00d4ff' },
    { id: 'graph-speed',    label: 'Speed (km/s)', color: '#00ff88' },
    { id: 'graph-lat',      label: 'Latitude (°)', color: '#ffaa00' },
    { id: 'graph-lon',      label: 'Longitude (°)', color: '#aa00ff' },
  ];

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = '1fr 1fr';
  grid.style.gap = '12px';

  for (const m of metrics) {
    const card = document.createElement('div');
    card.style.background = '#1a1e2e';
    card.style.border = '1px solid var(--panel-border)';
    card.style.borderRadius = '8px';
    card.style.padding = '10px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';

    const title = document.createElement('div');
    title.textContent = m.label;
    title.style.fontSize = '0.7rem';
    title.style.color = m.color;
    title.style.textTransform = 'uppercase';
    title.style.letterSpacing = '1px';
    title.style.marginBottom = '8px';

    const canvas = document.createElement('canvas');
    canvas.id = m.id;
    canvas.height = 120;

    card.appendChild(title);
    card.appendChild(canvas);
    grid.appendChild(card);
  }

  container.appendChild(grid);

  window.graphCharts = {};
  for (const m of metrics) {
    const canvas = document.getElementById(m.id);
    if (!canvas || typeof Chart === 'undefined') continue;
    window.graphCharts[m.id] = new Chart(canvas, {
      type: 'line',
      data: { labels: [], datasets: [{ label: m.label, data: [], borderColor: m.color, backgroundColor: m.color + '20', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
        plugins: { legend: { display: false } },
        scales: { x: { display: false }, y: { display: true, ticks: { color: '#8892a0', font: { size: 9 } }, grid: { color: '#1e2a3a40' } } },
      });
  }
}

/**
 * Add a point to a graph chart.
 * @param {string} graphId - Canvas id (e.g. 'graph-altitude')
 * @param {string} label   - X-axis label
 * @param {number} value   - Y-axis value
 */
function addGraphPoint(graphId, label, value) {
  const chart = window.graphCharts && window.graphCharts[graphId];
  if (!chart) return;
  chart.data.labels.push(label);
  chart.data.datasets[0].data.push(value);
  if (chart.data.labels.length > 60) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
  }
  chart.update('none');
}

/* --- Helpers -------------------------------------------------------- */

// Test insert
/* End of panel.js */