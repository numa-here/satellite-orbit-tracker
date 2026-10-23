"""
Tests for full-catalog merge, de-duplication, SATCAT enrichment, and the
mocked /api/catalog endpoint.
"""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.schemas import CatalogEntry, CatalogResponse

client = TestClient(app)

KEEP_ENTRY = {
    "norad_id": 25544,
    "name": "ISS (ZARYA)",
    "object_type": "PAY",
    "country": "USA",
    "omm": {
        "OBJECT_NAME": "ISS (ZARYA)",
        "NORAD_CAT_ID": 25544,
        "MEAN_MOTION": 15.5,
        "ECCENTRICITY": 0.0002535,
        "INCLINATION": 51.6,
    },
    "source": "keeptrack",
}

CELESTRAK_DUPLICATE = {
    "norad_id": 25544,
    "name": "ISS (ZARYA) DUPLICATE",
    "object_type": "PAY",
    "omm": {
        "OBJECT_NAME": "ISS (ZARYA) DUPLICATE",
        "NORAD_CAT_ID": 25544,
        "MEAN_MOTION": 15.5,
        "ECCENTRICITY": 0.0002535,
        "INCLINATION": 51.6,
    },
    "source": "celestrak",
    "group": "stations",
}

CELESTRAK_UNIQUE = {
    "norad_id": 48274,
    "name": "CSS (TIANGONG)",
    "object_type": "PAY",
    "country": "China",
    "omm": {
        "OBJECT_NAME": "CSS (TIANGONG)",
        "NORAD_CAT_ID": 48274,
        "MEAN_MOTION": 15.6,
        "ECCENTRICITY": 0.00035,
        "INCLINATION": 41.4,
    },
    "source": "celestrak",
    "group": "stations",
}


def _patch_catalog_service(monkeypatch, keep_items=None, celestrak_groups=None, satcat=None):
    monkeypatch.setattr("backend.catalog_service._fetch_keeptrack_brief", lambda: keep_items or [])
    monkeypatch.setattr("backend.catalog_service._fetch_satcat", lambda: satcat or {})

    def fake_fetch_group(group):
        if celestrak_groups is None:
            raise ValueError("group not available")
        return {"data": celestrak_groups.get(group, []), "stale": False, "cached": True}

    monkeypatch.setattr("backend.catalog_service.fetch_group", fake_fetch_group)
    monkeypatch.setattr("backend.catalog_service._read_cache", lambda key: None)
    monkeypatch.setattr("backend.catalog_service._write_cache", lambda key, payload: None)


def test_catalog_dedup_prioritizes_keeptrack(monkeypatch):
    from backend import catalog_service

    _patch_catalog_service(
        monkeypatch,
        keep_items=[KEEP_ENTRY],
        celestrak_groups={"stations": [CELESTRAK_DUPLICATE, CELESTRAK_UNIQUE]},
    )
    data = catalog_service.build_catalog()
    norads = [o["norad_id"] for o in data["objects"]]
    # Fresh upstream rows take precedence while the bundled snapshot fills
    # catalog coverage during the refresh window.
    assert norads.count(25544) == 1
    assert norads.count(48274) == 1
    assert data["count"] >= 5000
    assert "retlector snapshot" in data["sources"]
    iss = next(o for o in data["objects"] if o["norad_id"] == 25544)
    assert iss["name"] == "ISS (ZARYA)"
    assert iss["source"] == "keeptrack"
    assert "keeptrack" in data["sources"]
    assert "celestrak" in data["sources"]


def test_catalog_missing_satcat_rows_remain_valid(monkeypatch):
    from backend import catalog_service

    _patch_catalog_service(
        monkeypatch,
        keep_items=[],
        celestrak_groups={"active": [CELESTRAK_UNIQUE]},
        satcat={},
    )
    data = catalog_service.build_catalog()
    assert data["count"] >= 5000
    entry = next(item for item in data["objects"] if item["norad_id"] == 48274)
    assert entry["norad_id"] == 48274
    # Missing SATCAT metadata must not make the entry invalid.
    assert entry["category"] == "crewed"
    assert entry["orbit_regime"] == "LEO"


def test_catalog_build_uses_large_omm_snapshot_when_upstreams_are_empty(monkeypatch):
    from backend import catalog_service

    _patch_catalog_service(monkeypatch, keep_items=[], celestrak_groups={})
    data = catalog_service.build_catalog()

    assert data["count"] >= 500
    assert data["stale"] is True
    assert "retlector snapshot" in data["sources"]
    assert all(entry["omm"] for entry in data["objects"])
    norad_ids = {entry["norad_id"] for entry in data["objects"]}
    assert {25544, 41866}.issubset(norad_ids)  # ISS and GOES 16 remain searchable.


def test_cold_catalog_uses_bundled_snapshot_without_calling_upstreams(monkeypatch):
    from backend import catalog_service

    monkeypatch.setattr(catalog_service, "_read_cache", lambda key: None)
    monkeypatch.setattr(catalog_service, "_write_cache", lambda key, payload: None)
    monkeypatch.setattr(catalog_service, "_start_background_refresh", lambda: None)
    monkeypatch.setattr(
        catalog_service, "_fetch_keeptrack_brief",
        lambda: pytest.fail("Cold catalog must not wait on KeepTrack"),
    )
    monkeypatch.setattr(
        catalog_service, "fetch_group",
        lambda group: pytest.fail("Cold catalog must not wait on CelesTrak"),
    )
    monkeypatch.setattr(catalog_service, "_fetch_satcat", lambda: {})

    data = catalog_service.get_catalog()

    assert data["count"] >= 5000
    assert data["stale"] is True
    assert 900 in {entry["norad_id"] for entry in data["objects"]}


def test_catalog_cache_writer_receives_catalog_payload_not_an_extra_envelope(monkeypatch):
    from backend import catalog_service

    catalog_payload = {"objects": [{"norad_id": 25544}], "count": 1, "sources": ["snapshot"]}
    writes = []
    monkeypatch.setattr(catalog_service, "_read_cache", lambda key: None)
    monkeypatch.setattr(catalog_service, "_write_cache", lambda key, payload: writes.append((key, payload)))
    monkeypatch.setattr(catalog_service, "_start_background_refresh", lambda: None)
    monkeypatch.setattr(catalog_service, "build_catalog", lambda **kwargs: dict(catalog_payload))

    result = catalog_service.get_catalog()

    assert result["objects"] == catalog_payload["objects"]
    assert writes[0][0] == "catalog_v3"
    assert writes[0][1]["objects"] == catalog_payload["objects"]
    assert "timestamp" not in writes[0][1]
    assert "data" not in writes[0][1]


def test_empty_upstream_and_empty_cache_fall_back_to_omm_seed(monkeypatch):
    from backend import catalog_service

    monkeypatch.setattr(
        catalog_service,
        "_read_cache",
        lambda key: {"timestamp": 1, "data": {"objects": [], "count": 0}},
    )
    monkeypatch.setattr(catalog_service, "_is_fresh_ttl", lambda *args: True)
    monkeypatch.setattr(catalog_service, "build_catalog", lambda **kwargs: {"objects": [], "count": 0})
    monkeypatch.setattr(catalog_service, "_write_cache", lambda key, payload: None)

    data = catalog_service.get_catalog()

    assert data["source"] == "Seed"
    assert data["stale"] is True
    assert data["count"] > 0
    assert all(entry["omm"] for entry in data["objects"])


def test_fetch_group_uses_retlector_mirror_when_celestrak_times_out(monkeypatch):
    from backend import tle_service

    item = {
        "OBJECT_NAME": "TEST SATELLITE",
        "OBJECT_ID": "2024-001A",
        "EPOCH": "2026-10-21T00:00:00",
        "MEAN_MOTION": 15.0,
        "ECCENTRICITY": 0.001,
        "INCLINATION": 51.6,
        "RA_OF_ASC_NODE": 20.0,
        "ARG_OF_PERICENTER": 30.0,
        "MEAN_ANOMALY": 40.0,
        "NORAD_CAT_ID": 99999,
    }

    class Response:
        text = "json"

        def raise_for_status(self):
            return None

        def json(self):
            return [item]

    monkeypatch.setattr(tle_service, "CELESTRAK_ENDPOINTS", ["https://celestrak.test/gp.php"])
    monkeypatch.setattr(tle_service, "_read_cache", lambda key: None)
    monkeypatch.setattr(tle_service, "_write_cache", lambda *args, **kwargs: None)

    def get(url, **kwargs):
        if "retlector.eu" in url:
            return Response()
        raise TimeoutError("CelesTrak unavailable")

    monkeypatch.setattr(tle_service.requests, "get", get)
    result = tle_service.fetch_group("active")

    assert result["provider"] == "retlector"
    assert result["data"][0]["NORAD_CAT_ID"] == 99999
    assert result["stale"] is False


def test_single_satellite_lookup_uses_bundled_omm_before_network(monkeypatch):
    from backend import tle_service

    monkeypatch.setattr(tle_service, "_read_cache", lambda key: None)
    monkeypatch.setattr(
        tle_service.requests,
        "get",
        lambda *args, **kwargs: pytest.fail("Bundled NORAD 900 lookup must not wait for network"),
    )

    result = tle_service.fetch_satellite_by_norad(900)

    assert result["data"]["NORAD_CAT_ID"] == 900
    assert result["data"]["OBJECT_NAME"] == "CALSPHERE 1"
    assert result["data"]["MEAN_MOTION"] > 0
    assert result["stale"] is True
    assert result["cached"] is True


def test_catalog_endpoint_mocked():
    fake_response = CatalogResponse(
        objects=[
            CatalogEntry(
                norad_id=25544,
                name="ISS (ZARYA)",
                object_type="PAY",
                category="crewed",
                source="keeptrack",
                orbit_regime="LEO",
            )
        ],
        count=1,
        sources=["keeptrack"],
        cached=False,
        stale=False,
    )
    with patch("backend.main.get_catalog", return_value=fake_response):
        resp = client.get("/api/catalog")
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 1
    assert body["objects"][0]["norad_id"] == 25544
    assert body["objects"][0]["category"] == "crewed"


def test_health_still_works():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
