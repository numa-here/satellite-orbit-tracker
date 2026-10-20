"""
TLE Service – fetches, caches, and manages satellite orbital data from CelesTrak.

Supports:
  * Single satellite lookup by NORAD catalog number (CATNR)
  * Constellation / group lookup (GROUP, e.g. 'stations', 'weather', 'gps-ops')
  * File-based caching with configurable TTL (default: 2 hours)
  * Resilient offline fallback to stale cache when upstream is unreachable
  * Detection and error reporting for invalid / non-existent catalog numbers
"""
import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import requests

from .config import CELESTRAK_BASE_URL, CACHE_DIR, CACHE_TTL_SECONDS

logger = logging.getLogger(__name__)

# Ensure cache directory exists
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _get_cache_path(key: str) -> Path:
    """Derive a safe filesystem path for a cache key."""
    safe_name = "".join(c if (c.isalnum() or c in ("-", "_")) else "_" for c in key)
    return CACHE_DIR / f"{safe_name}.json"


def _read_cache(key: str) -> Optional[Dict[str, Any]]:
    """Read cached JSON entry if valid on disk, else None."""
    path = _get_cache_path(key)
    if not path.is_file():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
            if isinstance(payload, dict) and "timestamp" in payload and "data" in payload:
                return payload
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to read cache for key '%s': %s", key, exc)
    return None


def _write_cache(key: str, data: Any) -> None:
    """Store data payload with current timestamp to file cache."""
    path = _get_cache_path(key)
    payload = {
        "timestamp": time.time(),
        "data": data,
    }
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except OSError as exc:
        logger.warning("Failed to write cache for key '%s': %s", key, exc)


def _is_fresh(cached_payload: Dict[str, Any]) -> bool:
    """Check if cache entry is within the configured TTL."""
    stored_time = cached_payload.get("timestamp", 0)
    return (time.time() - stored_time) < CACHE_TTL_SECONDS


def fetch_satellite_by_norad(norad_id: int) -> Dict[str, Any]:
    """
    Fetch orbital GP data for a single satellite by NORAD ID.

    Returns:
        {
            "data": dict of OMM orbital elements,
            "stale": bool (True if upstream failed and returned old cache),
            "cached": bool (True if served from local cache)
        }

    Raises:
        ValueError: If satellite is not found / invalid NORAD ID (404)
        ConnectionError: If CelesTrak is unreachable and no cache exists
    """
    if not isinstance(norad_id, int) or norad_id <= 0:
        raise ValueError(f"Invalid NORAD ID: {norad_id}. Must be a positive integer.")

    cache_key = f"norad_{norad_id}"
    cached = _read_cache(cache_key)

    # Return immediately if cache is fresh
    if cached and _is_fresh(cached):
        logger.debug("Serving NORAD %d from fresh cache", norad_id)
        return {"data": cached["data"], "stale": False, "cached": True}

    # Otherwise attempt network fetch from CelesTrak
    url = f"{CELESTRAK_BASE_URL}?CATNR={norad_id}&FORMAT=JSON"
    headers = {"User-Agent": "SatelliteOrbitTracker/1.0"}

    try:
        resp = requests.get(url, headers=headers, timeout=10)
        
        # CelesTrak returns 404 or text "No GP data found" for unknown catalog numbers
        text = resp.text.strip()
        if resp.status_code == 404 or "No GP data found" in text or not text:
            raise ValueError(f"Satellite with NORAD ID {norad_id} not found on CelesTrak")

        resp.raise_for_status()

        parsed = resp.json()
        if not parsed:
            raise ValueError(f"Satellite with NORAD ID {norad_id} not found")

        # CelesTrak returns a list with 1 element for single CATNR
        sat_data = parsed[0] if isinstance(parsed, list) else parsed
        if not isinstance(sat_data, dict) or "OBJECT_NAME" not in sat_data:
            raise ValueError(f"Invalid GP data returned for NORAD ID {norad_id}")

        _write_cache(cache_key, sat_data)
        return {"data": sat_data, "stale": False, "cached": False}

    except ValueError:
        # Re-raise satellite not found so callers map to 404
        raise

    except Exception as exc:
        logger.warning("CelesTrak request failed for NORAD %d: %s", norad_id, exc)
        # Fallback to stale cached data if available
        if cached:
            logger.info("Serving NORAD %d from stale fallback cache", norad_id)
            return {"data": cached["data"], "stale": True, "cached": True}
        raise ConnectionError(
            f"Cannot reach CelesTrak and no cached data exists for NORAD {norad_id}"
        ) from exc


def fetch_group(group: str) -> Dict[str, Any]:
    """
    Fetch all satellites in a CelesTrak group (e.g. 'stations', 'weather', 'gps-ops').

    Returns:
        {
            "data": list of dicts,
            "stale": bool,
            "cached": bool
        }
    """
    clean_group = group.strip().lower()
    cache_key = f"group_{clean_group}"
    cached = _read_cache(cache_key)

    if cached and _is_fresh(cached):
        return {"data": cached["data"], "stale": False, "cached": True}

    url = f"{CELESTRAK_BASE_URL}?GROUP={clean_group}&FORMAT=JSON"
    headers = {"User-Agent": "SatelliteOrbitTracker/1.0"}

    try:
        resp = requests.get(url, headers=headers, timeout=15)
        text = resp.text.strip()
        if resp.status_code == 404 or "No GP data found" in text or not text:
            raise ValueError(f"Group '{group}' not found on CelesTrak")

        resp.raise_for_status()
        parsed = resp.json()
        sat_list = parsed if isinstance(parsed, list) else [parsed]

        _write_cache(cache_key, sat_list)
        return {"data": sat_list, "stale": False, "cached": False}

    except ValueError:
        raise
    except Exception as exc:
        logger.warning("CelesTrak group request failed for '%s': %s", group, exc)
        if cached:
            return {"data": cached["data"], "stale": True, "cached": True}
        raise ConnectionError(
            f"Cannot reach CelesTrak and no cached data exists for group '{group}'"
        ) from exc
