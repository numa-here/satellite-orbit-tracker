import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { adjacentSatelliteEntry, filterSatelliteEntries, geodeticToGlobePoint, nearestSatellitePoint } from '../frontend/js/satellite-utils.mjs';

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

test('worker emits xyz buffers for positions and a full selected orbit', () => {
  const source = readFileSync(new URL('../frontend/js/workers/satellite-worker.js', import.meta.url), 'utf8');
  const messages = [];
  const transferLists = [];
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
      postMessage: (message, transfers = []) => { messages.push(message); transferLists.push(transfers); },
    },
  };
  vm.runInNewContext(source, context);
  const time = Date.UTC(2026, 0, 1);
  onMessage({ data: { type: 'INIT', catalog: [{ norad_id: 25544, name: 'ISS', line1: 'line1', line2: 'line2', category: 'crewed' }] } });
  onMessage({ data: { type: 'COMPUTE', time } });
  const positions = messages.find(message => message.type === 'POSITIONS');
  assert.ok(ArrayBuffer.isView(positions.positions));
  assert.equal(positions.positions.length, 3);
  assert.equal(positions.valid[0], 1);
  assert.ok(Math.abs(positions.sizes[0] - 2.7) < 0.0001);
  const angle = (time / 1000 % 6000) / 6000 * Math.PI * 2 - Math.PI;
  const latitude = Math.sin(angle) * 0.4 * 180 / Math.PI;
  const longitude = ((angle * 180 / Math.PI + 540) % 360) - 180;
  const phi = (90 - latitude) * Math.PI / 180;
  const theta = (90 - longitude) * Math.PI / 180;
  const radius = 100 * (1 + 400 / 6371);
  const expected = [radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta)];
  expected.forEach((value, axis) => assert.ok(Math.abs(positions.positions[axis] - value) < 0.001));
  assert.equal(transferLists.at(-1)[0], positions.positions.buffer);
  assert.equal(transferLists.at(-1)[1], positions.sizes.buffer);
  assert.equal(transferLists.at(-1)[2], positions.valid.buffer);

  onMessage({ data: { type: 'SELECT', norad_id: 25544, time } });
  const orbit = messages.find(message => message.type === 'ORBITS');
  assert.equal(orbit.norad_id, 25544);
  assert.ok(ArrayBuffer.isView(orbit.positions));
  assert.equal(orbit.positions.length, 241 * 3);
  assert.equal(transferLists.at(-1)[0], orbit.positions.buffer);
  for (let i = 0; i < orbit.positions.length; i += 3) {
    assert.ok(Math.abs(Math.hypot(orbit.positions[i], orbit.positions[i + 1], orbit.positions[i + 2]) - radius) < 0.001);
  }
});

test('worker xyz conversion matches globe.gl getCoords for a known test point', () => {
  const globeBundle = readFileSync(new URL('../frontend/vendor/globe.gl.min.js', import.meta.url), 'utf8');
  const coordsSource = globeBundle.match(/function ax\(e,t\)\{.*?return\{x:.*?\}\}/s)?.[0];
  assert.ok(coordsSource, 'globe.gl getCoords implementation is available in the bundled build');
  const globeGetCoords = vm.runInNewContext(`(${coordsSource})`, { ix: 100 });
  const expected = globeGetCoords(30, 60, 0);

  const workerSource = readFileSync(new URL('../frontend/js/workers/satellite-worker.js', import.meta.url), 'utf8');
  let onMessage;
  const messages = [];
  const context = {
    satellite: {
      twoline2satrec: () => ({ no: 0.067, error: 0 }),
      propagate: () => ({ position: { x: 1 } }),
      eciToGeodetic: () => ({ latitude: Math.PI / 6, longitude: Math.PI / 3, height: 0 }),
      degreesLong: radians => radians * 180 / Math.PI,
      gstime: () => 0,
    },
    importScripts: () => {},
    setTimeout: callback => callback(),
    self: {
      addEventListener: (_type, listener) => { onMessage = listener; },
      postMessage: message => messages.push(message),
    },
  };
  vm.runInNewContext(workerSource, context);
  onMessage({ data: { type: 'INIT', catalog: [{ norad_id: 1, line1: 'line1', line2: 'line2' }] } });
  onMessage({ data: { type: 'COMPUTE', time: Date.UTC(2026, 0, 1) } });
  const actual = messages.find(message => message.type === 'POSITIONS').positions;
  assert.ok(Math.abs(actual[0] - expected.x) < 0.0001);
  assert.ok(Math.abs(actual[1] - expected.y) < 0.0001);
  assert.ok(Math.abs(actual[2] - expected.z) < 0.0001);
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
