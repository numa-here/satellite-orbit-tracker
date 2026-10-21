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
    data = catalog_service.get_catalog()
    norads = [o["norad_id"] for o in data["objects"]]
    assert norads == [25544, 48274]
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
    data = catalog_service.get_catalog()
    assert data["count"] == 1
    entry = data["objects"][0]
    assert entry["norad_id"] == 48274
    # Missing SATCAT metadata must not make the entry invalid.
    assert entry["category"] == "payload"
    assert entry["orbit_regime"] == "LEO"


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