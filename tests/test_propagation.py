"""
Tests for the propagation module (Skyfield & SGP4).

Uses a deterministic, hard-coded ISS TLE sample so tests execute fully
offline and verify mathematical bounds independently of upstream networks.
"""
import pytest
from backend.propagation import build_satellite, get_position, get_track, get_elements, ts

# Deterministic ISS orbital dataset (supports both raw TLE and OMM)
ISS_TEST_DATA = {
    "OBJECT_NAME": "ISS (ZARYA)",
    "OBJECT_ID": "1998-067A",
    "EPOCH": "2024-03-20T12:00:00.000000",
    "MEAN_MOTION": 15.50103552,
    "ECCENTRICITY": 0.0002535,
    "INCLINATION": 51.6408,
    "RA_OF_ASC_NODE": 13.9381,
    "ARG_OF_PERICENTER": 46.0487,
    "MEAN_ANOMALY": 119.9757,
    "EPHEMERIS_TYPE": 0,
    "CLASSIFICATION_TYPE": "U",
    "NORAD_CAT_ID": 25544,
    "ELEMENT_SET_NO": 999,
    "REV_AT_EPOCH": 44156,
    "BSTAR": 0.00032352,
    "MEAN_MOTION_DOT": 0.00016806,
    "MEAN_MOTION_DDOT": 0.0,
    "TLE_LINE1": "1 25544U 98067A   24080.50000000  .00016806  00000+0  32352-3 0  9990",
    "TLE_LINE2": "2 25544  51.6408  13.9381 0002535  46.0487 119.9757 15.50103552441560",
}


@pytest.fixture(scope="module")
def iss_satellite():
    """Build and return an EarthSatellite instance for the ISS test dataset."""
    return build_satellite(ISS_TEST_DATA)


class TestPropagation:
    """Validate position bounds and numerical ranges."""

    def test_latitude_within_bounds(self, iss_satellite):
        """Latitude must lie strictly within [-90.0, +90.0]."""
        t = ts.utc(2024, 3, 20, 12, 0, 0)
        pos = get_position(iss_satellite, t)
        assert -90.0 <= pos["latitude"] <= 90.0

    def test_longitude_within_bounds(self, iss_satellite):
        """Longitude must lie strictly within [-180.0, +180.0]."""
        t = ts.utc(2024, 3, 20, 12, 0, 0)
        pos = get_position(iss_satellite, t)
        assert -180.0 <= pos["longitude"] <= 180.0

    def test_altitude_iss_nominal_range(self, iss_satellite):
        """ISS altitude should be between 350 km and 450 km."""
        t = ts.utc(2024, 3, 20, 12, 0, 0)
        pos = get_position(iss_satellite, t)
        assert 350.0 <= pos["altitude_km"] <= 450.0

    def test_velocity_range(self, iss_satellite):
        """ISS speed in LEO should be approximately 7.5 to 7.8 km/s."""
        t = ts.utc(2024, 3, 20, 12, 0, 0)
        pos = get_position(iss_satellite, t)
        assert 7.4 <= pos["velocity_km_s"] <= 7.9

    def test_heading_degrees_and_direction(self, iss_satellite):
        """Heading must be in [0, 360) and direction a valid compass string."""
        t = ts.utc(2024, 3, 20, 12, 0, 0)
        pos = get_position(iss_satellite, t)
        assert 0.0 <= pos["heading_degrees"] < 360.0
        assert pos["direction"] in {
            "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"
        }

    def test_stale_warning_logic(self, iss_satellite):
        """Verify warning trigger when time differs > 7 days from epoch."""
        # 1. Near epoch -> No warning
        t_near = ts.utc(2024, 3, 21, 0, 0, 0)
        pos_near = get_position(iss_satellite, t_near)
        assert pos_near["stale_warning"] is None

        # 2. Far from epoch -> Stale warning present
        t_far = ts.utc(2024, 4, 15, 0, 0, 0)
        pos_far = get_position(iss_satellite, t_far)
        assert pos_far["stale_warning"] is not None
        assert "degrades" in pos_far["stale_warning"]


class TestGroundTrack:
    """Validate track generation logic."""

    def test_track_generation_points(self, iss_satellite):
        """Verify track generates correct number of points and schema."""
        t = ts.utc(2024, 3, 20, 12, 0, 0)
        # 30 minutes at 60-second steps = 30 intervals -> 31 points
        points = get_track(iss_satellite, minutes=30, step_seconds=60, t_center=t)
        assert len(points) == 31
        first_pt = points[0]
        assert "latitude" in first_pt
        assert "longitude" in first_pt
        assert "altitude_km" in first_pt
        assert "utc_time" in first_pt
        assert -90.0 <= first_pt["latitude"] <= 90.0
        assert -180.0 <= first_pt["longitude"] <= 180.0


class TestOrbitalElements:
    """Validate parsing and extraction of Keplerian elements."""

    def test_iss_period_range(self):
        """ISS orbital period must be roughly 90 to 93 minutes."""
        elements = get_elements(ISS_TEST_DATA)
        assert 90.0 <= elements["orbital_period_minutes"] <= 93.0

    def test_elements_parsing_exactness(self):
        """Verify element properties match the source dataset."""
        elements = get_elements(ISS_TEST_DATA)
        assert elements["name"] == "ISS (ZARYA)"
        assert elements["norad_id"] == 25544
        assert abs(elements["inclination_deg"] - 51.6408) < 1e-4
        assert abs(elements["eccentricity"] - 0.0002535) < 1e-7
        assert abs(elements["raan_deg"] - 13.9381) < 1e-4
        assert abs(elements["arg_of_perigee_deg"] - 46.0487) < 1e-4
        assert abs(elements["mean_anomaly_deg"] - 119.9757) < 1e-4
        assert abs(elements["mean_motion_rev_per_day"] - 15.50103552) < 1e-6
