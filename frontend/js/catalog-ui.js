/**
 * catalog-ui.js – Search, filters, category legend, and UI state for the
 * full satellite catalog renderer. Works with globe.js to filter and
 * highlight catalog objects on the dark globe.
 *
 * Exports:
 *   initCatalogUI(opts)        – build filter chips, wire search + filter events
 *   setCatalog(entries)        – replace the catalog and re-apply all filters
 *   getFilteredEntries()       – entries matching the current search + filters
 *   getEntryByNorad(noradId)   – O(1) lookup of a catalog entry by NORAD id
 *   setSearch(query)           – set the text search query (debounced by the UI wiring)
 *   setFilter(type, value, active) – toggle one category/regime/object-type filter
 *   clearFilters()             – clear all filters and the search query
 *   getActiveFilters()         – copy of the current filter sets
 *   setSelectedNorad(noradId)  – record selection and hide the hover tooltip
 *   setHoveredNorad(noradId)   – show the hover tooltip for a NORAD id
 *   getSelectedNorad() / getHoveredNorad()
 */

import { filterSatelliteEntries } from './satellite-utils.mjs?v=orbit-fix-20261023-4';

const DEFAULT_DEBOUNCE_MS = 150;

// --- Module state ---------------------------------------------------------
let catalog = [];
let noradIndex = new Map(); // String(norad_id) -> entry
let filteredIds = new Set();
let searchQuery = '';
let debounceMs = DEFAULT_DEBOUNCE_MS;
let onChange = null;      // ({ entries, filters, searchQuery }) => void

const filters = {
  category: new Set(),
  regime: new Set(),
  objectType: new Set(),
  country: new Set(),
};

const FILTER_CONTAINERS = [
  { id: 'category-filters', type: 'category' },
  { id: 'orbit-filters', type: 'regime' },
  { id: 'type-filters', type: 'objectType' },
  { id: 'country-filters', type: 'country' },
];

const CATEGORY_CONFIG = {
  crewed:     { label: 'Crewed', color: '#00ff88' },
  rocket_body:{ label: 'Rocket Body', color: '#ffaa00' },
  debris:     { label: 'Debris', color: '#ff4444' },
  constellation:{ label: 'Constellation', color: '#00d4ff' },
  gnss:       { label: 'GNSS', color: '#aa00ff' },
  weather:    { label: 'Weather', color: '#ffaa00' },
  payload:    { label: 'Payload', color: '#ffffff' },
  unknown:    { label: 'Unknown', color: '#666666' },
};

const REGIME_CONFIG = {
  LEO: { label: 'LEO (< 2,000 km)', color: '#00d4ff' },
  MEO: { label: 'MEO (2,000–35,786 km)', color: '#aa00ff' },
  GEO: { label: 'GEO (~35,786 km)', color: '#00ff88' },
  HEO: { label: 'HEO / Elliptical', color: '#ff4444' },
  unknown: { label: 'Unknown', color: '#666666' },
};

const OBJECT_TYPE_CONFIG = {
  PAY: { label: 'Payload (PAY)', color: '#ffffff' },
  R_B: { label: 'Rocket Body (R/B)', color: '#ffaa00' },
  DEB: { label: 'Debris (DEB)', color: '#ff4444' },
  UNK: { label: 'Unknown (UNK)', color: '#666666' },
};

const FILTER_CONFIGS = {
  category: CATEGORY_CONFIG,
  regime: REGIME_CONFIG,
  objectType: OBJECT_TYPE_CONFIG,
  country: {},
};

// --- Filter pipeline ------------------------------------------------------

function applyFilters() {
  filteredIds = new Set(filterSatelliteEntries(catalog, searchQuery, filters)
    .map(entry => String(entry.norad_id)));
}

function refresh() {
  renderCounts();
  renderLegend();
  syncChipStates();
  if (onChange) {
    onChange({
      entries: getFilteredEntries(),
      filters: getActiveFilters(),
      searchQuery,
    });
  }
}

// --- Public API -----------------------------------------------------------

export function initCatalogUI(opts = {}) {
  debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  onChange = opts.onChange || null;

  for (const { id, type } of FILTER_CONTAINERS) {
    buildFilterChips(id, FILTER_CONFIGS[type], type);
  }
  wireSearch();
  wireFilterEvents();
  refresh();
}

export function setCatalog(entries) {
  catalog = Array.isArray(entries) ? entries : [];
  const countries = [...new Set(catalog.map(entry => entry.country || 'unknown'))].sort();
  FILTER_CONFIGS.country = Object.fromEntries(countries.map(country => [country, {
    label: country, color: '#c7d2e0',
  }]));
  buildFilterChips('country-filters', FILTER_CONFIGS.country, 'country');
  noradIndex = new Map();
  for (const entry of catalog) {
    const id = entry.norad_id;
    if (id != null) noradIndex.set(String(id), entry);
  }
  applyFilters();
  refresh();
  return getFilteredEntries();
}

export function getFilteredEntries() {
  return catalog.filter(e => filteredIds.has(String(e.norad_id)));
}

export function getEntryByNorad(noradId) {
  return noradIndex.get(String(noradId));
}


export function setSearch(query) {
  searchQuery = (query || '').toLowerCase().trim();
  applyFilters();
  refresh();
  return getFilteredEntries();
}

export function setFilter(type, value, active) {
  const set = filters[type];
  if (!set) return getFilteredEntries();
  if (active) set.add(value);
  else set.delete(value);
  applyFilters();
  refresh();
  return getFilteredEntries();
}

export function clearFilters() {
  const input = document.getElementById('catalog-search');
  if (input) input.value = '';
  searchQuery = '';
  for (const set of Object.values(filters)) set.clear();
  applyFilters();
  refresh();
  return getFilteredEntries();
}

export function getActiveFilters() {
  return {
    category: new Set(filters.category),
    regime: new Set(filters.regime),
    objectType: new Set(filters.objectType),
    country: new Set(filters.country),
  };
}

export function setSelectedNorad(noradId) {
  window.selectedNorad = noradId;
  const el = document.getElementById('hover-tooltip');
  if (el) el.style.display = 'none';
}

export function setHoveredNorad(noradId, x, y) {
  window.hoveredNorad = noradId;
  updateTooltip(x, y);
}

export function getSelectedNorad() {
  return window.selectedNorad;
}

export function getHoveredNorad() {
  return window.hoveredNorad;
}

// --- UI -------------------------------------------------------------------

function buildFilterChips(containerId, config, filterType) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  for (const [key, cfg] of Object.entries(config)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.type = filterType;
    btn.dataset.value = key;
    btn.textContent = cfg.label;
    btn.style.color = cfg.color;
    container.appendChild(btn);
  }
}

function syncChipStates() {
  for (const { id, type } of FILTER_CONTAINERS) {
    const container = document.getElementById(id);
    if (!container) continue;
    const active = filters[type];
    for (const btn of container.querySelectorAll('.chip')) {
      btn.classList.toggle('active', active.has(btn.dataset.value));
    }
  }
}

function renderCounts() {
  const shown = document.getElementById('count-shown');
  const total = document.getElementById('count-total');
  const filtered = document.getElementById('filter-count');
  if (shown) shown.textContent = filteredIds.size;
  if (total) total.textContent = catalog.length;
  if (filtered) filtered.textContent = filteredIds.size;
}

function renderLegend() {
  const container = document.getElementById('category-legend');
  if (!container) return;
  const counts = {};
  for (const entry of catalog) {
    const key = entry.category || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  const rows = [];
  for (const [key, cfg] of Object.entries(CATEGORY_CONFIG)) {
    const count = counts[key] || 0;
    if (count === 0) continue;
    rows.push(`<span class="legend-item" style="color:${cfg.color}">
      <span class="legend-dot"></span>${cfg.label} <span class="legend-count">${count}</span></span>`);
  }
  container.innerHTML = rows.join('');
}

function wireSearch() {
  const input = document.getElementById('catalog-search');
  if (!input) return;
  let timer = null;
  input.addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => setSearch(e.target.value), debounceMs);
  });
}

function wireFilterEvents() {
  for (const { id } of FILTER_CONTAINERS) {
    const container = document.getElementById(id);
    if (!container) continue;
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      const type = btn.dataset.type;
      const value = btn.dataset.value;
      const next = !btn.classList.contains('active');
      btn.classList.toggle('active', next);
      setFilter(type, value, next);
    });
  }
}

function updateTooltip(x, y) {
  const el = document.getElementById('hover-tooltip');
  if (!el) return;
  if (window.hoveredNorad === null) { el.style.display = 'none'; return; }
  const entry = noradIndex.get(String(window.hoveredNorad));
  if (!entry) { el.style.display = 'none'; return; }
  el.innerHTML = `
    <div class="tip-name">${escapeHtml(entry.name || 'Unknown')}</div>
    <div class="tip-norad">NORAD ${entry.norad_id}</div>
    ${entry.category ? `<div class="tip-meta">[${escapeHtml(entry.category)}]</div>` : ''}
    ${entry.orbit_regime ? `<div class="tip-meta">${escapeHtml(entry.orbit_regime)}</div>` : ''}
  `;
  if (Number.isFinite(x)) el.style.left = `${x}px`;
  if (Number.isFinite(y)) el.style.top = `${y}px`;
  el.style.display = 'block';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
