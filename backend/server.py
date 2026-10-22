#!/usr/bin/env python3
"""Satellite Orbit Tracker Backend Server"""

import os
import time
from flask import Flask, jsonify
from typing import Dict, Any, Optional
import logging

app = Flask(__name__)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, "data")
CACHE_DIR = os.path.join(APP_DIR, "cache")

# Environment variables
KEEPTRACK_API_KEY = os.getenv("KEEPTRACK_API_KEY")
CELESTRAK_USER_AGENT = os.getenv("CELESTRAK_USER_AGENT", "SatelliteOrbitTracker/1.0")
CACHE_TIMEOUT = 300  # 5 minutes default
FALLBACK_TIMEOUT = 15000  # 15 seconds

# Rate limiting for CelesTrak: max once every 2 hours (7200 seconds)
CELESTRAK_RATE_LIMIT_SECONDS = 7200
last_celes_trak_call = 0

# In-memory cache (persists for process lifetime)
memory_cache = None
memory_cache_time = 0

# ---------------------------------------------------------------------------
# Seed data – bundled public orbital data (TLE lines for ~500 satellites)
# ---------------------------------------------------------------------------

SEED_FILE = os.path.join(DATA_DIR, "catalog_seed.json")


def load_seed_data():
    """Load the bundled seed catalog data."""
    try:
        with open(SEED_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        # Ensure data has required fields
        if isinstance(data, dict) and "objects" in data:
            return data
        # If it's just a list, wrap it
        if isinstance(data, list):
            return {"objects": data, "count": len(data), "source": "Seed", "stale": True}
        logging.warning("Seed data format unexpected: %s", type(data))
        return {"objects": [], "count": 0, "source": "Seed", "stale": True}
    except FileNotFoundError:
        logging.error("Seed file not found: %s", SEED_FILE)
        return {"objects": [], "count": 0, "source": "Seed", "stale": True}
    except json.JSONDecodeError as e:
        logging.error("Seed file JSON error: %s", e)
        return {"objects": [], "count": 0, "source": "Seed", "stale": True}


def load_catalog_with_fallback() -> Dict[str, Any]:
    """Load catalog data with caching and fallback to seed data."""
    import time as _time
    from .config import CATALOG_CACHE_TTL_SECONDS
    from .catalog_service import build_catalog, _is_fresh_ttl
    from .seed_data import SEED_SATELLITES
    
    cache_key = "catalog_v1"
    cached = _read_cache_to_disk(cache_key) if hasattr(load_catalog_with_fallback, '_read_cache_to_disk') else None
    
    # Check cache first
    if cached and _is_fresh_ttl(cached, CATALOG_CACHE_TTL_SECONDS):
        data = cached.get("data", {})
        data["cached"] = True
        data["stale"] = False
        # Ensure source field is set
        if "source" not in data:
            data["source"] = "cache"
        return data
    
    try:
        data = build_catalog()
        # Write cache
        _write_cache_to_disk(cache_key, {"timestamp": _time.time(), "data": data})
        data["cached"] = False
        data["stale"] = False
        # Ensure source field is set
        if "source" not in data:
            data["source"] = ", ".join(data.get("sources", [])) or "celestrak"
        return data
    except Exception as exc:
        logger.exception("Catalog build failed")
        if cached:
            data = cached.get("data", {})
            data["cached"] = True
            data["stale"] = True
            # Ensure source field is set
            if "source" not in data:
                data["source"] = cached.get("source", "cache")
            return data
        # Fallback to seed data when everything else fails
        try:
            objects = []
            for norad_id, sat_data in SEED_SATELLITES.items():
                from .schemas import CatalogEntry
                entry = CatalogEntry(
                    norad_id=norad_id,
                    name=sat_data.get("OBJECT_NAME", "Unknown"),
                    object_type=sat_data.get("object_type", "UNK"),
                    category=sat_data.get("category", "unknown"),
                    country=sat_data.get("country", "unknown"),
                    orbit_regime=sat_data.get("orbit_regime", "unknown"),
                    latitude=sat_data.get("latitude", 0.0),
                    longitude=sat_data.get("longitude", 0.0),
                    altitude_km=sat_data.get("altitude_km", 0.0),
                    inclination_deg=sat_data.get("inclination_deg", 0.0),
                    source="Seed",
                    stale=True,
                )
                objects.append(entry)
            catalog_objects = sorted(objects, key=lambda e: e.norad_id)
            return {
                "objects": [entry.model_dump() for entry in catalog_objects],
                "count": len(catalog_objects),
                "source": "Seed",
                "stale": True,
                "updated_at": _time.time(),
            }
        except Exception as e2:
            logger.error("Seed data fallback also failed: %s", e2)
            raise RuntimeError(f"Unable to build satellite catalog: {exc}") from exc


def _read_cache_to_disk(cache_key: str) -> Optional[Dict[str, Any]]:
    """Read cached data from disk."""
    import json
    import os
    from . import CACHE_DIR
    cache_file = os.path.join(CACHE_DIR, f"{cache_key}.json")
    try:
        with open(cache_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _write_cache_to_disk(cache_key: str, data: Dict[str, Any]) -> None:
    """Write data to disk cache."""
    import json
    import os
    from . import CACHE_DIR
    cache_file = os.path.join(CACHE_DIR, f"{cache_key}.json")
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(data, f)

@app.route("/api/catalog", methods=["GET"])
def api_catalog():
    try:
        start = time.time()
        catalog = load_catalog_with_fallback()
        elapsed = (time.time() - start) * 1000

        # Enforce timeout guard
        timeout_ms = FALLBACK_TIMEOUT
        if elapsed > timeout_ms:
            logging.warning(
                "Catalog load took %.1f ms (limit %d ms)", elapsed, timeout_ms
            )

        # Ensure required fields
        if "objects" not in catalog:
            catalog["objects"] = []
        if "count" not in catalog:
            catalog["count"] = len(catalog["objects"])
        if "source" not in catalog:
            catalog["source"] = "None"
        if "stale" not in catalog:
            catalog["stale"] = True

        # Cap results for client performance – send up to 1000 objects
        max_objects = int(os.getenv("MAX_CATALOG_OBJECTS", "1000"))
        objects = catalog["objects"][:max_objects]
        count = min(catalog["count"], max_objects)

        result = {
            "objects": objects,
            "count": count,
            "source": catalog["source"],
            "stale": catalog["stale"],
        }
        return jsonify(result), 200

    except Exception as err:
        logging.error("/api/catalog error: %s", err, exc_info=True)
        return (
            jsonify(
                {
                    "objects": [],
                    "count": 0,
                    "source": "None",
                    "stale": True,
                    "error": str(err),
                }
            ),
            500,
        )

@app.route("/api/health", methods=["GET"])
def api_health():
    try:
        catalog = load_catalog_with_fallback()
        key_configured = bool(KEEPTRACK_API_KEY)
        return jsonify({
            "status": "ok",
            "catalog_count": catalog.get("count", 0),
            "source": catalog.get("source", "None"),
            "last_refresh": catalog.get("last_fetched") or catalog.get("updated_at"),
            "key_configured": key_configured
        }), 200
    except Exception as err:
        logging.error("/api/health error: %s", err, exc_info=True)
        return jsonify({
            "status": "error",
            "catalog_count": 0,
            "source": "None",
            "last_refresh": None,
            "key_configured": False
        }), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)