import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { adjacentSatelliteEntry, createSatelliteMarker, filterSatelliteEntries, geodeticToGlobePoint, nearestSatellitePoint } from '../frontend/js/satellite-utils.mjs';

const require = createRequire(import.meta.url);
const satelliteJs = require('../frontend/vendor/satellite.min.js');

const catalog = [
  { name: 'ISS (ZARYA)', norad_id: 25544, category: 'crewed', orbit_regime: 'LEO', object_type: 'PAY', country: 'US' },
  { name: 'NOAA 19', norad_id: 33591, category: 'weather', orbit_regime: 'LEO', object_type: 'PAY', country: 'US' },
  { name: 'GPS IIF-1', norad_id: 36585, category: 'gnss', orbit_regime: 'MEO', object_type: 'PAY', country: 'US' },
  { name: 'Unclassified', norad_id: 90001 },
];

test('filters combine fields with AND and values within a field with OR', () => {
  const results = filterSatelliteEntries(catalog, '', {
    category: new Set(['crewed', 'weather']),
    regime: new Set(['LEO']),
    country: new Set(['US']),
  });
  assert.deepEqual(results.map(item => item.norad_id), [25544, 33591]);
});

test('search matches names, NORAD identifiers and published metadata', () => {
  assert.equal(filterSatelliteEntries(catalog, '33591')[0].name, 'NOAA 19');
  assert.equal(filterSatelliteEntries(catalog, 'zarya')[0].norad_id, 25544);
  assert.equal(filterSatelliteEntries(catalog, 'no match').length, 0);
});

test('missing metadata and malformed filter inputs are handled consistently', () => {
  assert.deepEqual(filterSatelliteEntries(catalog, '', { category: new Set(['unknown']) }).map(x => x.norad_id), [90001]);
  assert.deepEqual(filterSatelliteEntries(null, '', {}), []);
  assert.equal(filterSatelliteEntries(catalog, null, { country: 'US' }).length, 4);
  assert.equal(filterSatelliteEntries(catalog, '', { orbit_regime: new Set(['LEO']) }).length, 4);
});

test('geodetic coordinates map directly to globe coordinates with altitude scaled by Earth radius', () => {
  assert.deepEqual(geodeticToGlobePoint(0, 0, 637.1), { lat: 0, lng: 0, altitude: 0.1 });
  assert.deepEqual(geodeticToGlobePoint(45, -120, 0), { lat: 45, lng: -120, altitude: 0 });
  assert.equal(geodeticToGlobePoint(91, 0, 400), null);
  assert.equal(geodeticToGlobePoint(0, 181, 400), null);
  assert.equal(geodeticToGlobePoint(0, 0, -1), null);
});

test('valid worker coordinates become visible globe markers with scaled altitude and stable identity', () => {
  const entry = { norad_id: 25544, name: 'ISS', category: 'crewed' };
  const marker = createSatelliteMarker(entry, 12.5, -43.25, 420, 0.18);
  assert.deepEqual(marker, {
    norad_id: 25544, lat: 12.5, lng: -43.25, altitude: 420 / 6371,
    radius: 0.28, entry,
  });
  assert.equal(createSatelliteMarker({ norad_id: 'bad' }, 0, 0, 400, 0.3), null);
  assert.equal(createSatelliteMarker(entry, NaN, 0, 400, 0.3), null);
});

test('marker picking selects the nearest visible satellite within the click tolerance', () => {
  const points = [
    { norad_id: 1, lat: 5, lng: 179.8 },
    { norad_id: 2, lat: 5.1, lng: -179.9 },
    { norad_id: 3, lat: 9, lng: 130 },
  ];
  const selected = nearestSatellitePoint(points, { lat: 5, lng: -180 }, 1,
    point => point.norad_id !== 1);
  assert.equal(selected.norad_id, 2);
  assert.equal(nearestSatellitePoint(points, { lat: -40, lng: 30 }, 1), null);
  assert.equal(nearestSatellitePoint(points, { lat: NaN, lng: 30 }, 1), null);
});

test('previous and next satellite navigation wraps through the current filtered list', () => {
  const entries = [catalog[0], catalog[1], catalog[2]];
  assert.equal(adjacentSatelliteEntry(entries, 25544, 1).norad_id, 33591);
  assert.equal(adjacentSatelliteEntry(entries, 25544, -1).norad_id, 36585);
  assert.equal(adjacentSatelliteEntry(entries, 36585, 1).norad_id, 25544);
  assert.equal(adjacentSatelliteEntry(entries, null, -1).norad_id, 36585);
  assert.equal(adjacentSatelliteEntry([], 25544, 1), null);
  assert.equal(adjacentSatelliteEntry(entries, 25544, 0), null);
});

test('worker emits selected full orbit paths in the same satellite and altitude scale', () => {
  const source = readFileSync(new URL('../frontend/js/workers/satellite-worker.js', import.meta.url), 'utf8');
  const messages = [];
  let onMessage;
  const fakeSatellite = {
    twoline2satrec: () => ({ no: 0.067, error: 0 }),
    json2satrec: () => ({ no: 0.067, error: 0 }),
    propagate: (_satrec, date) => ({ position: { time: date.getTime() } }),
    eciToGeodetic: position => {
      const angle = (position.time / 1000 % 6000) / 6000 * Math.PI * 2 - Math.PI;
      return { latitude: Math.sin(angle) * 0.4, longitude: angle, height: 400 };
    },
    degreesLong: radians => ((radians * 180 / Math.PI + 540) % 360) - 180,
    gstime: () => 0,
  };
  const context = {
    satellite: fakeSatellite,
    importScripts: () => {},
    setTimeout: callback => callback(),
    self: {
      addEventListener: (_type, listener) => { onMessage = listener; },
      postMessage: message => messages.push(message),
    },
  };
  vm.runInNewContext(source, context);
  onMessage({ data: { type: 'INIT', catalog: [{ norad_id: 25544, name: 'ISS', line1: 'line1', line2: 'line2' }] } });
  onMessage({ data: { type: 'SELECT', norad_id: 25544, time: Date.UTC(2026, 0, 1) } });
  const orbit = messages.find(message => message.type === 'ORBITS');
  assert.equal(orbit.norad_id, 25544);
  const allPoints = orbit.paths.flatMap(path => path.points);
  assert.equal(allPoints.length, 181);
  assert.ok(orbit.paths.length >= 1);
  assert.ok(allPoints.every(point => point.lat >= -90 && point.lat <= 90));
  assert.ok(allPoints.every(point => point.alt === 400 / 6371));
});

test('bundled satellite.js propagates the cached ISS OMM into visible positions and an orbit', () => {
  const source = readFileSync(new URL('../frontend/js/workers/satellite-worker.js', import.meta.url), 'utf8');
  const fixture = JSON.parse(readFileSync(new URL('../backend/cache/norad_25544.json', import.meta.url), 'utf8')).data;
  const messages = [];
  const warnings = [];
  let onMessage;
  const context = {
    satellite: satelliteJs,
    Date,
    importScripts: () => {},
    setTimeout: callback => callback(),
    console: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    self: {
      addEventListener: (_type, listener) => { onMessage = listener; },
      postMessage: message => messages.push(message),
    },
  };
  vm.runInNewContext(source, context);
  const time = Date.UTC(2026, 9, 23, 12);
  onMessage({ data: { type: 'INIT', catalog: [{
    norad_id: 25544, name: fixture.OBJECT_NAME, category: 'crewed', omm: fixture,
  }] } });
  assert.deepEqual(warnings, []);
  assert.equal(messages.find(message => message.type === 'READY').count, 1);
  onMessage({ data: { type: 'COMPUTE', time } });
  const positions = messages.find(message => message.type === 'POSITIONS');
  assert.equal(positions.valid[0], 1);
  assert.ok(positions.positions[0] >= -90 && positions.positions[0] <= 90);
  assert.ok(positions.positions[1] >= -180 && positions.positions[1] <= 180);
  assert.ok(positions.positions[2] >= 350 && positions.positions[2] <= 450);

  onMessage({ data: { type: 'SELECT', norad_id: 25544, time } });
  const orbit = messages.find(message => message.type === 'ORBITS');
  assert.equal(orbit.norad_id, 25544);
  const allPoints = orbit.paths.flatMap(path => path.points);
  assert.equal(allPoints.length, 181);
  assert.ok(allPoints.every(point => Number.isFinite(point.lat) && Number.isFinite(point.lng)));
  assert.ok(allPoints.every(point => point.alt > 0.05 && point.alt < 0.1));
});

test('worker propagates a 1000-object bundled catalog sample off the UI thread', () => {
  const source = readFileSync(new URL('../frontend/js/workers/satellite-worker.js', import.meta.url), 'utf8');
  const rows = JSON.parse(readFileSync(new URL('../backend/data/active_omm_snapshot.json', import.meta.url), 'utf8'))
    .slice(0, 1000);
  const catalog = rows.map(row => ({
    norad_id: Number(row.NORAD_CAT_ID),
    name: row.OBJECT_NAME,
    category: 'payload',
    omm: row,
  }));
  const messages = [];
  let onMessage;
  const context = {
    satellite: satelliteJs,
    Date,
    importScripts: () => {},
    setTimeout: callback => callback(),
    self: {
      addEventListener: (_type, listener) => { onMessage = listener; },
      postMessage: message => messages.push(message),
    },
  };
  vm.runInNewContext(source, context);
  const initStarted = performance.now();
  onMessage({ data: { type: 'INIT', catalog } });
  const initMs = performance.now() - initStarted;
  const computeStarted = performance.now();
  onMessage({ data: { type: 'COMPUTE', time: Date.UTC(2026, 9, 23, 12) } });
  const computeMs = performance.now() - computeStarted;
  const ready = messages.find(message => message.type === 'READY');
  const positions = messages.find(message => message.type === 'POSITIONS');
  const validCount = positions.valid.reduce((sum, value) => sum + value, 0);
  assert.ok(ready.count > 900);
  assert.ok(validCount > 900);
  assert.equal(positions.valid.length, 1000);
  console.log(`Worker sample: ${ready.count}/1000 satrecs, ${validCount} positions; init ${initMs.toFixed(1)} ms, compute ${computeMs.toFixed(1)} ms`);
});

test('full bundled catalog produces only finite, renderable satellite positions', () => {
  const source = readFileSync(new URL('../frontend/js/workers/satellite-worker.js', import.meta.url), 'utf8');
  const rows = JSON.parse(readFileSync(new URL('../backend/data/active_omm_snapshot.json', import.meta.url), 'utf8'));
  const catalog = rows.map(row => ({
    norad_id: Number(row.NORAD_CAT_ID), name: row.OBJECT_NAME, category: 'payload', omm: row,
  }));
  const messages = [];
  let onMessage;
  const context = {
    satellite: satelliteJs, Date, importScripts: () => {}, setTimeout: callback => callback(),
    console: { warn: () => {} },
    self: {
      addEventListener: (_type, listener) => { onMessage = listener; },
      postMessage: message => messages.push(message),
    },
  };
  vm.runInNewContext(source, context);
  const time = Date.UTC(2026, 9, 23, 12);
  onMessage({ data: { type: 'INIT', catalog } });
  onMessage({ data: { type: 'COMPUTE', time } });
  const ready = messages.find(message => message.type === 'READY');
  const positions = messages.find(message => message.type === 'POSITIONS');
  const validCount = positions.valid.reduce((sum, value) => sum + value, 0);

  assert.ok(rows.length >= 5000, `expected a full bundled snapshot, found ${rows.length} records`);
  assert.equal(positions.positions.length, catalog.length * 3);
  assert.equal(positions.valid.length, catalog.length);
  assert.ok(validCount >= Math.floor(catalog.length * 0.95),
    `expected at least 95% of bundled records to propagate, found ${validCount}/${catalog.length}`);
  for (let i = 0; i < positions.valid.length; i++) {
    if (!positions.valid[i]) continue;
    const lat = positions.positions[i * 3];
    const lng = positions.positions[i * 3 + 1];
    const altitudeKm = positions.positions[i * 3 + 2];
    assert.ok(Number.isFinite(lat) && lat >= -90 && lat <= 90);
    assert.ok(Number.isFinite(lng) && lng >= -180 && lng <= 180);
    assert.ok(Number.isFinite(altitudeKm) && altitudeKm >= 0);
  }
  console.log(`Full catalog: ${catalog.length} entries, ${ready.count} usable orbital records, ${validCount} valid positions`);
});
