/**
 * globe.js – Manages the globe.gl 3D Earth globe, satellite marker, and orbit path.
 *
 * Exports (module-pattern via globals):
 *   initGlobe(containerId)  – create the globe
 *   updateSatMarker(lat, lon, alt, name)  – move the satellite dot
 *   drawOrbitPath(points)   – draw the ground track
 *   followSatellite(lat, lon)  – point camera at the satellite
 *   setFollowMode(on)       – toggle auto-follow
 */

let globe = null;
let followMode = false;

/** Satellite marker data – always a single-element array for globe.gl */
let satMarkerData = [];

/** Orbit-path data – array of {lat, lng, alt} arcs */
let orbitPathData = [];

/**
 * Create and mount the globe into a container element.
 */
function initGlobe(containerId) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.error('Globe container not found:', containerId);
    return;
  }

  globe = Globe()
    .globeImageUrl('https://unpkg.com/three-globe@2.31.3/example/img/earth-blue-marble.jpg')
    .bumpImageUrl('https://unpkg.com/three-globe@2.31.3/example/img/earth-topology.png')
    .backgroundImageUrl('https://unpkg.com/three-globe@2.31.3/example/img/night-sky.png')
    .showAtmosphere(true)
    .atmosphereColor('#4da6ff')
    .atmosphereAltitude(0.15)
    // Satellite marker layer
    .pointsData(satMarkerData)
    .pointLat('lat')
    .pointLng('lng')
    .pointAltitude('alt')
    .pointRadius(0.6)
    .pointColor(() => '#ff4444')
    .pointLabel('name')
    // Orbit path layer  
    .pathsData(orbitPathData)
    .pathPointLat(p => p[0])
    .pathPointLng(p => p[1])
    .pathPointAlt(p => p[2] || 0)
    .pathColor(() => ['#00d4ff80', '#00d4ff80'])
    .pathStroke(1.5)
    .pathDashLength(0.01)
    .pathDashGap(0.008)
    .pathDashAnimateTime(60000)
    (container);

  // Responsive resize
  const onResize = () => {
    globe.width(container.clientWidth);
    globe.height(container.clientHeight);
  };
  window.addEventListener('resize', onResize);
  onResize();

  // Start with a nice view of Earth
  globe.pointOfView({ lat: 20, lng: 0, altitude: 2.5 }, 0);

  // Slow auto-rotation
  globe.controls().autoRotate = true;
  globe.controls().autoRotateSpeed = 0.3;
}

/**
 * Update the satellite's position marker on the globe.
 */
function updateSatMarker(lat, lon, alt, name) {
  // Altitude on globe.gl is in globe radii units; convert km to a visual scale
  const altScale = alt / 6371 + 0.005; // small offset so it's above surface

  satMarkerData.length = 0;
  satMarkerData.push({ lat, lng: lon, alt: altScale, name: `${name}\n${alt.toFixed(1)} km` });
  if (globe) {
    globe.pointsData(satMarkerData);
  }

  // If follow mode is active, move camera to satellite
  if (followMode) {
    followSatellite(lat, lon);
  }
}

/**
 * Draw the satellite's orbital ground track.
 * points: array of {latitude, longitude, altitude_km}
 */
function drawOrbitPath(points) {
  if (!points || points.length === 0) return;

  // Break the path into segments when longitude wraps around (anti-meridian)
  const segments = [];
  let currentSegment = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const altScale = p.altitude_km / 6371 + 0.005;
    currentSegment.push([p.latitude, p.longitude, altScale]);

    // Check for anti-meridian crossing (big longitude jump)
    if (i < points.length - 1) {
      const nextP = points[i + 1];
      if (Math.abs(nextP.longitude - p.longitude) > 180) {
        segments.push(currentSegment);
        currentSegment = [];
      }
    }
  }
  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  orbitPathData.length = 0;
  segments.forEach(seg => orbitPathData.push(seg));

  if (globe) {
    globe.pathsData(orbitPathData);
  }
}

/**
 * Point the camera at a specific lat/lon.
 */
function followSatellite(lat, lon) {
  if (globe) {
    globe.pointOfView({ lat, lng: lon, altitude: 1.8 }, 1000);
  }
}

/**
 * Toggle follow mode on/off.
 */
function setFollowMode(on) {
  followMode = on;
  if (globe) {
    // Disable auto-rotation when following
    globe.controls().autoRotate = !on;
  }
}
