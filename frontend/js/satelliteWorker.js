/// <reference lib="webworker" />

importScripts('https://cdn.jsdelivr.net/npm/satellite@8.15.0/dist/satellite.min.js');

// EARTH_RADIUS_KM from catalog_service.py
const EARTH_RADIUS_KM = 6378.135;

onmessage = e => {
    const {action, data} = e.data;

    if (action === 'init') {
        const {satellites} = data;
        const positions = [];

        for (const sat of satellites) {
            try {
                // Build TLE from available orbital elements
                // satellite.js requires TLE format (line1, line2)
                // We'll construct a basic TLE using the mean elements

                // Convert epoch (modified Julian date reference) to satellite.js date
                // epoch in the compact format is days since 1970-01-01 or specific epoch
                // satellite.js expects epoch in a specific format

                // Use satellite.propagate which takes TLE and a date
                // For now, use a simple approach: calculate ECEF from orbital elements

                // Calculate mean anomaly at epoch
                const M = (sat.mean_anomaly_deg || 0) * Math.PI / 180;
                // Calculate argument of perigee
                const w = (sat.arg_of_perigee_deg || 0) * Math.PI / 180;
                // Calculate right ascension of ascending node
                const Omega = (sat.ra_of_asc_node_deg || 0) * Math.PI / 180;
                // Calculate inclination
                const i = (sat.inclination_deg || 0) * Math.PI / 180;
                // Mean motion (revs per day)
                const n = (sat.mean_motion || 0);

                // Approximate mean motion if not provided
                const meanMotion = n || 2 * Math.PI / (24 * 3600);  // default: 1 rev/day

                // Mean anomaly over time (assuming propagation from epoch)
                // M(t) = M0 + n * t ( simplified )

                // For a circular orbit, position in orbital plane:
                // x' = cos(M), y' = sin(M)
                // Then rotate by i, w, Omega to get ECEF

                // Simplified: compute unit vector in orbital plane
                const cosM = Math.cos(M);
                const sinM = Math.sin(M);

                // Position in orbital plane (before rotations)
                const px = cosM;
                const py = sinM;
                const pz = 0;

                // Apply rotations: argument of perigee, inclination, RAAN
                // Rotate by w (argument of perigee)
                const cosW = Math.cos(w);
                const sinW = Math.sin(w);
                const rx = cosW * px + sinW * py;
                const ry = -sinW * px + cosW * py;
                const rz = pz;

                // Rotate by i (inclination)
                const cosI = Math.cos(i);
                const sinI = Math.sin(i);
                const ix = rx;
                const iy = cosI * ry + sinI * rz;
                const iz = -sinI * ry + cosI * rz;

                // Rotate by Omega (RAAN)
                const cosO = Math.cos(Omega);
                const sinO = Math.sin(Omega);
                const ox = cosO * ix + sinO * iy;
                const oy = -sinO * ix + cosO * iy;
                const oz = iz;

                // Normalize by Earth radius to get unit vector, then scale by apogee radius
                // Actually, for a circular orbit at altitude h:
                // distance from Earth center = R_earth + h
                const apogee = sat.apogee_km || 0;
                const distance = EARTH_RADIUS_KM + apogee;

                const x = ox * distance;
                const y = oy * distance;
                const z = oz * distance;

                positions.push({norad_id: sat.norad_id, x, y, z});
            } catch (err) {
                console.error('Worker propagation error for satellite', sat.norad_id, err);
                positions.push({norad_id: sat.norad_id || 0, x: 0, y: 0, z: 0});
            }
        }

        postMessage({action: 'positions', positions});
    }
};