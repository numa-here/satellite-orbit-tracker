"""
Integration and endpoint tests for FastAPI routes.

Uses Starlette's TestClient and mocks upstream CelesTrak calls
so that testing is deterministic, fast, and does not require Internet access.
"""
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)

# Standard mock TLE / OMM payload for tests
MOCK_ISS_OMM = {
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


def mock_fetch_satellite_by_norad(norad_id: int):
    """Mock fetcher returning mock ISS for 25544 and raising ValueError for others."""
    if norad_id == 25544:
        return {
            "data": MOCK_ISS_OMM,
            "stale": False,
            "cached": True,
        }
    raise ValueError(f"Satellite with NORAD ID {norad_id} not found")


class TestDiagnostics:
    """Verify system health and metadata."""

    def test_health_endpoint(self):
        resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "timestamp" in data

    def test_satellites_list_endpoint(self):
        resp = client.get("/api/satellites")
        assert resp.status_code == 200
        data = resp.json()
        assert "satellites" in data
        assert "groups" in data
        norad_ids = [s["norad_id"] for s in data["satellites"]]
        assert 25544 in norad_ids  # ISS must be in the catalogue list


class TestPositionEndpoint:
    """Verify /api/position route."""

    @patch("backend.main.fetch_satellite_by_norad", side_effect=mock_fetch_satellite_by_norad)
    def test_get_position_success(self, mock_fetch):
        resp = client.get("/api/position?sat=25544")
        assert resp.status_code == 200
        data = resp.json()
        assert data["norad_id"] == 25544
        assert data["name"] == "ISS (ZARYA)"
        assert -90.0 <= data["latitude"] <= 90.0
        assert -180.0 <= data["longitude"] <= 180.0
        assert data["altitude_km"] > 0.0
        assert data["velocity_km_s"] > 5.0
        assert "heading_degrees" in data
        assert "direction" in data
        assert "utc_time" in data
        assert "tle_epoch" in data

    @patch("backend.main.fetch_satellite_by_norad", side_effect=mock_fetch_satellite_by_norad)
    def test_get_position_not_found(self, mock_fetch):
        resp = client.get("/api/position?sat=9999999")
        assert resp.status_code == 404
        data = resp.json()
        assert "detail" in data
        assert "not found" in data["detail"].lower()


class TestTrackEndpoint:
    """Verify /api/track route."""

    @patch("backend.main.fetch_satellite_by_norad", side_effect=mock_fetch_satellite_by_norad)
    def test_get_track_success(self, mock_fetch):
        resp = client.get("/api/track?sat=25544&minutes=60&step=60")
        assert resp.status_code == 200
        data = resp.json()
        assert data["norad_id"] == 25544
        assert len(data["points"]) > 0
        p0 = data["points"][0]
        assert "latitude" in p0
        assert "longitude" in p0
        assert "altitude_km" in p0

    @patch("backend.main.fetch_satellite_by_norad", side_effect=mock_fetch_satellite_by_norad)
    def test_get_track_not_found(self, mock_fetch):
        resp = client.get("/api/track?sat=9999999")
        assert resp.status_code == 404


class TestElementsEndpoint:
    """Verify /api/elements route."""

    @patch("backend.main.fetch_satellite_by_norad", side_effect=mock_fetch_satellite_by_norad)
    def test_get_elements_success(self, mock_fetch):
        resp = client.get("/api/elements?sat=25544")
        assert resp.status_code == 200
        data = resp.json()
        assert data["norad_id"] == 25544
        assert abs(data["inclination_deg"] - 51.6408) < 1e-3
        assert 90.0 <= data["orbital_period_minutes"] <= 93.0

    @patch("backend.main.fetch_satellite_by_norad", side_effect=mock_fetch_satellite_by_norad)
    def test_get_elements_not_found(self, mock_fetch):
        resp = client.get("/api/elements?sat=9999999")
        assert resp.status_code == 404


class TestFrontendServing:
    """Verify that frontend static files are served properly."""

    def test_index_html_served(self):
        resp = client.get("/")
        assert resp.status_code == 200
        assert "Satellite Orbit Tracker" in resp.text
