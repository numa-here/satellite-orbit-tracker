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
  const fixed = (value, digits, suffix = '') => Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}${suffix}` : '—';
  setText('val-lat',       fixed(pos.latitude, 4, '°'));
  setText('val-lon',       fixed(pos.longitude, 4, '°'));
  setText('val-alt',       fixed(pos.altitude_km, 2, ' km'));
  setText('val-speed',     fixed(pos.velocity_km_s, 3, ' km/s'));
  setText('val-direction', pos.heading_degrees == null ? '—' : `${fixed(pos.heading_degrees, 1, '°')} ${pos.direction || ''}`);
  setText('val-time',      formatUTC(pos.utc_time));
  setText('val-norad',     pos.norad_id);
  setText('val-epoch',     formatUTC(pos.tle_epoch));
  setText('val-age',       fixed(pos.tle_age_days, 1, ' days'));

  // Update status badge
  const badge = document.getElementById('status-badge');
  if (!badge) return;
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
  if (!elems) return;
  const fixed = (value, digits, suffix = '') => Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}${suffix}` : '—';
  setText('val-inc',    fixed(elems.inclination_deg, 4, '°'));
  setText('val-ecc',    fixed(elems.eccentricity, 7));
  setText('val-raan',   fixed(elems.raan_deg, 4, '°'));
  setText('val-argp',   fixed(elems.arg_of_perigee_deg, 4, '°'));
  setText('val-ma',     fixed(elems.mean_anomaly_deg, 4, '°'));
  setText('val-mm',     fixed(elems.mean_motion_rev_per_day, 8, ' rev/day'));
  setText('val-period', fixed(elems.orbital_period_minutes, 2, ' min'));
  setText('val-bstar',  Number.isFinite(Number(elems.bstar)) ? Number(elems.bstar).toExponential(5) : '—');
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

window.renderInfoPanel = renderInfoPanel;

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
    if (!canvas) continue;
    if (typeof Chart === 'undefined') {
      window.graphCharts[m.id] = { canvas, color: m.color, values: [], labels: [] };
      drawFallbackChart(window.graphCharts[m.id]);
      continue;
    }
    window.graphCharts[m.id] = new Chart(canvas, {
      type: 'line',
      data: { labels: [], datasets: [{ label: m.label, data: [], borderColor: m.color, backgroundColor: m.color + '20', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
        plugins: { legend: { display: false } },
        scales: {
          x: { display: true, ticks: { color: '#8892a0', maxTicksLimit: 5, font: { size: 9 } }, grid: { color: '#1e2a3a40' } },
          y: { display: true, ticks: { color: '#8892a0', font: { size: 9 } }, grid: { color: '#1e2a3a40' } },
        },
      }});
  }
}

window.renderGraphsPanel = renderGraphsPanel;

function setGraphSeries(series) {
  const chartValues = {
    'graph-altitude': series.altitude,
    'graph-speed': series.speed,
    'graph-lat': series.latitude,
    'graph-lon': series.longitude,
  };
  for (const [id, values] of Object.entries(chartValues)) {
    const chart = window.graphCharts?.[id];
    if (!chart) continue;
    if (chart.data?.datasets) {
      chart.data.labels = [...series.labels];
      chart.data.datasets[0].data = [...values];
      chart.update('none');
    } else {
      chart.labels = [...series.labels];
      chart.values = [...values];
      drawFallbackChart(chart);
    }
  }
}
window.setGraphSeries = setGraphSeries;

/**
 * Add a point to a graph chart.
 * @param {string} graphId - Canvas id (e.g. 'graph-altitude')
 * @param {string} label   - X-axis label
 * @param {number} value   - Y-axis value
 */
function addGraphPoint(graphId, label, value) {
  const chart = window.graphCharts && window.graphCharts[graphId];
  if (!chart) return;
  if (chart.data && chart.data.datasets) {
    // Keep the graph static - don't scroll, just update the data
    chart.data.labels.push(label);
    chart.data.datasets[0].data.push(value);
    // Remove scrolling - keep all data points instead of shifting
    // if (chart.data.labels.length > 60) {
    //   chart.data.labels.shift();
    //   chart.data.datasets[0].data.shift();
    // }
    chart.update('none');
  } else {
    chart.labels.push(label);
    chart.values.push(value);
    // Remove scrolling for fallback chart too
    // if (chart.values.length > 60) { chart.values.shift(); chart.labels.shift(); }
    drawFallbackChart(chart);
  }
}

function drawFallbackChart(chart) {
  const canvas = chart.canvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(220, rect.width || 220);
  const height = 120;
  canvas.width = width * dpr; canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(150,170,195,.16)';
  for (let y = 20; y <= 100; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  if (chart.values.length < 2) {
    ctx.fillStyle = 'rgba(150,170,195,.65)'; ctx.font = '12px system-ui';
    ctx.fillText('Waiting for telemetry…', 10, 62);
    return;
  }
  const min = Math.min(...chart.values), max = Math.max(...chart.values);
  const span = max - min || 1;
  ctx.strokeStyle = chart.color; ctx.lineWidth = 2; ctx.beginPath();
  chart.values.forEach((value, index) => {
    const x = 8 + index / (chart.values.length - 1) * (width - 16);
    const y = height - 10 - (value - min) / span * (height - 24);
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/** Switch the info panel tabs */
function switchInfoTab(tabId) {
  const tabContents = document.querySelectorAll('.panel-tab-content');
  tabContents.forEach(content => content.style.display = 'none');
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => btn.classList.remove('active'));
  const selectedContent = document.getElementById('tab-' + tabId);
  if (selectedContent) selectedContent.style.display = 'block';
  const activeBtn = document.querySelector('.tab-btn[data-tab="' + tabId + '"]');
  if (activeBtn) activeBtn.classList.add('active');
}

/** Populate the info panel with satellite data */
function updateInfoPanel(entry, pos, elems) {
  const formatNumber = (value, digits, suffix = '') => {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(digits)}${suffix}` : '—';
  };
  if (entry) {
    const title = document.getElementById('info-panel-title');
    if (title) title.textContent = `${entry.name || 'Satellite'} · NORAD ${entry.norad_id}`;
    document.getElementById('info-norad').textContent = entry.norad_id || '—';
    const unavailable = 'Not listed in catalog';
    document.getElementById('info-desig').textContent = entry.intl_designator || unavailable;
    document.getElementById('info-country').textContent = entry.country || unavailable;
    document.getElementById('info-type').textContent = entry.object_type ? entry.object_type.replace(/_/g, ' ') : unavailable;
    document.getElementById('info-launch-date').textContent = entry.launch_date || unavailable;
    document.getElementById('info-launch-site').textContent = entry.launch_site || unavailable;
    const status = entry.status || (entry.stale ? 'Catalog data is cached' : unavailable);
    document.getElementById('info-status').textContent = status;
    document.getElementById('info-status').className = 'info-value ' + (entry.status === 'Operational' ? 'live' : entry.stale ? 'stale' : '');
    renderSelectedSatelliteImage(entry);
    renderElementRecord(entry);
  }
  if (pos) {
    document.getElementById('info-lat').textContent = formatNumber(pos.latitude, 4, '°');
    document.getElementById('info-lon').textContent = formatNumber(pos.longitude, 4, '°');
    document.getElementById('info-alt').textContent = formatNumber(pos.altitude_km, 2, ' km');
    document.getElementById('info-speed').textContent = formatNumber(pos.velocity_km_s, 3, ' km/s');
    document.getElementById('info-heading').textContent = `${formatNumber(pos.heading_degrees, 1, '°')}${pos.direction ? ` ${pos.direction}` : ''}`;
    document.getElementById('info-epoch').textContent = formatUTC(pos.tle_epoch);
    document.getElementById('info-age').textContent = formatNumber(pos.tle_age_days, 1, ' days');
  }
  if (elems) {
    document.getElementById('info-inc').textContent = formatNumber(elems.inclination_deg, 4, '°');
    document.getElementById('info-ecc').textContent = formatNumber(elems.eccentricity, 7);
    document.getElementById('info-raan').textContent = formatNumber(elems.raan_deg, 4, '°');
    document.getElementById('info-argp').textContent = formatNumber(elems.arg_of_perigee_deg, 4, '°');
    document.getElementById('info-ma').textContent = formatNumber(elems.mean_anomaly_deg, 4, '°');
    document.getElementById('info-mm').textContent = formatNumber(elems.mean_motion_rev_per_day, 8, ' rev/day');
    document.getElementById('info-period').textContent = formatNumber(elems.orbital_period_minutes, 2, ' min');
    document.getElementById('info-apogee').textContent = formatNumber(elems.apogee_km, 1, ' km');
    document.getElementById('info-perigee').textContent = formatNumber(elems.perigee_km, 1, ' km');
  }
}

let imageLookupNorad = null;
async function renderSelectedSatelliteImage(entry) {
  const figure = document.getElementById('satellite-photo');
  const image = document.getElementById('info-image');
  const caption = document.getElementById('info-image-caption');
  if (!figure || !image || !caption || !entry?.norad_id) return;
  if (imageLookupNorad === entry.norad_id) return;
  imageLookupNorad = entry.norad_id;
  figure.hidden = false;
  image.onerror = null;
  image.removeAttribute('src');
  caption.textContent = 'Looking for a public satellite image…';
  try {
    const searches = [`${entry.name || 'satellite'} satellite spacecraft`, entry.name || 'satellite'];
    let page = null;
    for (const search of searches) {
      const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(search)}&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url&iiurlwidth=960&format=json&origin=*`;
      const response = await fetch(url);
      if (!response.ok) continue;
      const data = await response.json();
      page = Object.values(data.query?.pages || {}).find(candidate => candidate.imageinfo?.[0]?.thumburl || candidate.imageinfo?.[0]?.url);
      if (page) break;
    }
    const source = page?.imageinfo?.[0]?.thumburl || page?.imageinfo?.[0]?.url;
    if (!source) throw new Error('No public image found');
    image.alt = `${entry.name || 'Satellite'} (image: ${page.title || 'Wikimedia Commons'})`;
    image.src = source;
    caption.textContent = `${(page.title || 'Satellite image').replace(/^File:/, '')} · Wikimedia Commons`;
    image.onerror = showSatelliteImagePlaceholder;
  } catch (_) {
    showSatelliteImagePlaceholder();
  }
}

function showSatelliteImagePlaceholder() {
  const image = document.getElementById('info-image');
  const caption = document.getElementById('info-image-caption');
  if (!image || !caption) return;
  image.onerror = null;
  image.src = '/vendor/satellite-placeholder.svg';
  image.alt = 'Illustrative satellite placeholder; no verified public photo found';
  caption.textContent = 'Illustrative placeholder · no verified public photo found';
}

function renderElementRecord(entry) {
  const output = document.getElementById('info-tle-data');
  const description = document.getElementById('tle-description');
  if (!output) return;
  if (entry.line1 && entry.line2) {
    output.textContent = `${entry.name || 'SATELLITE'}\n${entry.line1}\n${entry.line2}`;
    if (description) description.textContent = 'Two-Line Element (TLE) set from the catalog source. Epoch and orbital parameters describe the orbit at the listed reference time.';
    return;
  }
  const omm = entry.omm;
  if (omm && typeof omm === 'object') {
    const keys = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
    const values = keys.filter(key => omm[key] != null).map(key => `${key}: ${omm[key]}`);
    output.textContent = values.length ? values.join('\n') : 'No TLE / OMM fields were published for this catalog entry.';
    if (description) description.textContent = 'This source provides CCSDS OMM orbital elements instead of legacy TLE lines. Values below are shown as published; no TLE values are fabricated.';
    return;
  }
  output.textContent = 'Orbital element lines are not available for this catalog entry.';
}

window.updateInfoPanel = updateInfoPanel;
window.switchInfoTab = switchInfoTab;

/** Render graphs with orbit data */
function renderGraphs(altitudes, speeds) {
  const container = document.getElementById('panel-graphs-content');
  if (!container) return;
  const labels = [];
  for (let i = 0; i < 60; i++) labels.push(i);
  const altChart = window.graphCharts && window.graphCharts['graph-altitude'];
  if (altChart) {
    altChart.data.labels = labels;
    altChart.data.datasets[0].data = altitudes || Array(60).fill(0);
    altChart.update('none');
  }
  const speedChart = window.graphCharts && window.graphCharts['graph-speed'];
  if (speedChart) {
    speedChart.data.labels = labels;
    speedChart.data.datasets[0].data = speeds || Array(60).fill(0);
    speedChart.update('none');
  }
}

/* --- Helpers -------------------------------------------------------- */

window.addGraphPoint = addGraphPoint;
