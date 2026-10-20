"""
Propagation Module – computes satellite trajectories using Skyfield and SGP4.

Skyfield wraps the official SGP4 algorithm to propagate orbits from TLE / OMM
data, computing cartesian position & velocity vectors and converting them to
WGS84 geodetic coordinates (latitude, longitude, ellipsoidal height).
"""
import math
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

from skyfield.api import load, EarthSatellite, wgs84
from skyfield.timelib import Time

from .config import TLE_STALE_WARNING_DAYS

# Skyfield timescale loaded once at module level for high performance
ts = load.timescale()

# 16-point standard compass rose
_COMPASS_POINTS = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]


def _heading_to_compass(deg: float) -> str:
    """Map a 0-360 degree bearing to a 16-point compass label."""
    idx = int((deg % 360 + 11.25) / 22.5) % 16
    return _COMPASS_POINTS[idx]


def build_satellite(sat_data: Dict[str, Any]) -> EarthSatellite:
    """
    Construct a Skyfield EarthSatellite from CelesTrak GP JSON / OMM data.

    Supports both:
      1. Classic two-line elements (TLE_LINE1, TLE_LINE2)
      2. Orbit Mean-Elements Messages (OMM JSON format from CelesTrak)
    """
    name = sat_data.get("OBJECT_NAME", "UNKNOWN")

    # If raw TLE lines are present
    line1 = sat_data.get("TLE_LINE1")
    line2 = sat_data.get("TLE_LINE2")
    if line1 and line2:
        return EarthSatellite(line1.strip(), line2.strip(), name, ts)

    # Otherwise construct from OMM fields
    if hasattr(EarthSatellite, "from_omm"):
        return EarthSatellite.from_omm(ts, sat_data)

    raise ValueError(f"Unable to build EarthSatellite from provided data for {name}")


def _compute_heading(sat: EarthSatellite, t: Time) -> Tuple[float, str]:
    """
    Compute ground-track heading (forward azimuth) at time t.

    Compares position at t with position at t + 10 seconds using the
    great-circle initial bearing formula on WGS84 subpoints.
    """
    pos1 = wgs84.subpoint(sat.at(t))
    lat1 = math.radians(pos1.latitude.degrees)
    lon1 = math.radians(pos1.longitude.degrees)

    # Step forward by 10 seconds
    t2_dt = t.utc_datetime() + timedelta(seconds=10)
    t2 = ts.utc(
        t2_dt.year, t2_dt.month, t2_dt.day,
        t2_dt.hour, t2_dt.minute,
        t2_dt.second + t2_dt.microsecond / 1e6
    )
    pos2 = wgs84.subpoint(sat.at(t2))
    lat2 = math.radians(pos2.latitude.degrees)
    lon2 = math.radians(pos2.longitude.degrees)

    dlon = lon2 - lon1
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    bearing = (math.degrees(math.atan2(y, x)) + 360.0) % 360.0

    return bearing, _heading_to_compass(bearing)


def get_position(sat: EarthSatellite, t: Optional[Time] = None) -> Dict[str, Any]:
    """
    Compute current geographic position, speed, and heading.

    Returns:
        dict with latitude, longitude, altitude_km, velocity_km_s,
        heading_degrees, direction, utc_time, tle_epoch, tle_age_days, stale_warning
    """
    if t is None:
        t = ts.now()

    geocentric = sat.at(t)
    subpoint = wgs84.subpoint(geocentric)

    # Orbital velocity magnitude: sqrt(vx^2 + vy^2 + vz^2)
    vx, vy, vz = geocentric.velocity.km_per_s
    speed = math.sqrt(vx**2 + vy**2 + vz**2)

    # Heading & compass direction
    heading_deg, direction = _compute_heading(sat, t)

    # Timestamps & TLE age
    calc_dt = t.utc_datetime()
    epoch_dt = sat.epoch.utc_datetime()
    age_days = abs((calc_dt - epoch_dt).total_seconds()) / 86400.0

    warning = None
    if age_days > TLE_STALE_WARNING_DAYS:
        warning = (
            f"TLE epoch is {age_days:.1f} days old; SGP4 orbital propagation "
            f"accuracy degrades significantly beyond {TLE_STALE_WARNING_DAYS:.0f} days."
        )

    return {
        "latitude": round(float(subpoint.latitude.degrees), 4),
        "longitude": round(float(subpoint.longitude.degrees), 4),
        "altitude_km": round(float(subpoint.elevation.km), 2),
        "velocity_km_s": round(float(speed), 3),
        "heading_degrees": round(float(heading_deg), 1),
        "direction": direction,
        "utc_time": calc_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tle_epoch": epoch_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tle_age_days": round(float(age_days), 2),
        "stale_warning": warning,
    }


def get_track(
    sat: EarthSatellite,
    minutes: int = 90,
    step_seconds: int = 30,
    t_center: Optional[Time] = None,
) -> List[Dict[str, Any]]:
    """
    Compute ground-track coordinates centered on the current time.

    By centering on the current time (e.g. -minutes/2 to +minutes/2),
    the user sees where the satellite recently traveled and where it will go next.
    """
    if t_center is None:
        t_center = ts.now()

    center_dt = t_center.utc_datetime()
    start_dt = center_dt - timedelta(minutes=minutes / 2.0)
    total_steps = max(1, int((minutes * 60) / step_seconds))

    points: List[Dict[str, Any]] = []
    for i in range(total_steps + 1):
        step_dt = start_dt + timedelta(seconds=i * step_seconds)
        t_step = ts.utc(
            step_dt.year, step_dt.month, step_dt.day,
            step_dt.hour, step_dt.minute,
            step_dt.second + step_dt.microsecond / 1e6
        )
        sub = wgs84.subpoint(sat.at(t_step))
        points.append({
            "latitude": round(float(sub.latitude.degrees), 4),
            "longitude": round(float(sub.longitude.degrees), 4),
            "altitude_km": round(float(sub.elevation.km), 2),
            "utc_time": step_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        })

    return points


def get_elements(sat_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extract and parse Keplerian orbital elements from CelesTrak GP JSON.

    Calculates orbital period in minutes as 1440 / mean_motion.
    """
    name = sat_data.get("OBJECT_NAME", "UNKNOWN")
    norad_id = int(sat_data.get("NORAD_CAT_ID", 0))
    epoch = str(sat_data.get("EPOCH", ""))
    inc = float(sat_data.get("INCLINATION", 0.0))
    ecc = float(sat_data.get("ECCENTRICITY", 0.0))
    raan = float(sat_data.get("RA_OF_ASC_NODE", 0.0))
    argp = float(sat_data.get("ARG_OF_PERICENTER", 0.0))
    ma = float(sat_data.get("MEAN_ANOMALY", 0.0))
    mm = float(sat_data.get("MEAN_MOTION", 0.0))
    bstar = float(sat_data.get("BSTAR", 0.0))

    # Orbital period: 1440 minutes per day / revolutions per day
    period = round(1440.0 / mm, 2) if mm > 0 else 0.0

    return {
        "name": name,
        "norad_id": norad_id,
        "epoch": epoch,
        "inclination_deg": round(inc, 4),
        "eccentricity": round(ecc, 7),
        "raan_deg": round(raan, 4),
        "arg_of_perigee_deg": round(argp, 4),
        "mean_anomaly_deg": round(ma, 4),
        "mean_motion_rev_per_day": round(mm, 8),
        "orbital_period_minutes": period,
        "bstar": bstar,
    }
