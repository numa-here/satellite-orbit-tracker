"""
TLE Service – fetches, caches, and manages satellite orbital data from CelesTrak.

Supports:
  * Single satellite lookup by NORAD catalog number (CATNR)
  * Constellation / group lookup (GROUP, e.g. 'stations', 'weather', 'gps-ops')
  * File-based caching with configurable TTL (default: 2 hours)
  * Resilient offline & cloud fallback (bundled seed data for cloud providers like Render)
  * Multi-domain fallback (celestrak.org and celestrak.com)
  * Detection and error reporting for invalid / non-existent catalog numbers
"""
import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import requests

from .config import CELESTRAK_BASE_URL, CACHE_DIR, CACHE_TTL_SECONDS
from .seed_data import SEED_SATELLITES

logger = logging.getLogger(__name__)

# Ensure cache directory exists
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Candidate upstream endpoints for CelesTrak
CELESTRAK_ENDPOINTS = [
    "https://celestrak.org/NORAD/elements/gp.php",
    "https://celestrak.com/NORAD/elements/gp.php",
]

# Standard browser headers to avoid Cloudflare / WAF / host blocks
REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


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


def _write_cache(key: str, data: Any, **metadata: Any) -> None:
    """Store data payload with current timestamp to file cache."""
    path = _get_cache_path(key)
    payload = {
        "timestamp": time.time(),
        "data": data,
        **metadata,
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
            "stale": bool (True if upstream failed and returned old cache or seed),
            "cached": bool (True if served from local cache or seed)
        }

    Raises:
        ValueError: If satellite is not found / invalid NORAD ID (404)
        ConnectionError: If CelesTrak is unreachable and no cache or seed exists
    """
    if not isinstance(norad_id, int) or norad_id <= 0:
        raise ValueError(f"Invalid NORAD ID: {norad_id}. Must be a positive integer.")

    cache_key = f"norad_{norad_id}"
    cached = _read_cache(cache_key)

    # Return immediately if cache is fresh
    if cached and _is_fresh(cached):
        logger.debug("Serving NORAD %d from fresh cache", norad_id)
        return {"data": cached["data"], "stale": False, "cached": True}

    # The catalog already contains the same current OMM data used to plot the
    # selected object. Reuse it for info/position requests instead of making a
    # second CelesTrak round trip for every click in the search list.
    catalog_cache = _read_cache("catalog_v1")
    catalog_data = (catalog_cache or {}).get("data", {})
    if catalog_cache and _is_fresh(catalog_cache) and isinstance(catalog_data, dict):
        for entry in catalog_data.get("objects", []):
            if not isinstance(entry, dict) or int(entry.get("norad_id") or 0) != norad_id:
                continue
            omm = entry.get("omm")
            if isinstance(omm, dict) and omm.get("MEAN_MOTION") is not None:
                sat_data = dict(omm)
                sat_data.setdefault("NORAD_CAT_ID", norad_id)
                sat_data.setdefault("OBJECT_NAME", entry.get("name", "UNKNOWN"))
                _write_cache(cache_key, sat_data)
                return {"data": sat_data, "stale": bool(entry.get("stale")), "cached": True}

    # Attempt network fetch across candidate endpoints (with 5s connect timeout)
    last_network_exc = None
    # Render and similar hosts may be unable to reach CelesTrak directly.
    # Try the public CelesTrak mirror first so a fresh catalog does not wait
    # through several connection timeouts before receiving usable OMM data.
    try:
        mirror = requests.get(
            f"https://retlector.eu/{clean_group}/json",
            headers=REQUEST_HEADERS,
            timeout=(3, 8),
        )
        mirror.raise_for_status()
        parsed = mirror.json()
        sat_list = parsed if isinstance(parsed, list) else [parsed]
        sat_list = [item for item in sat_list if isinstance(item, dict)]
        if sat_list:
            _write_cache(cache_key, sat_list, provider="retlector")
            return {"data": sat_list, "stale": False, "cached": False, "provider": "retlector"}
    except Exception as exc:
        last_network_exc = exc
        logger.warning("ReTLEctor mirror failed for group '%s': %s", group, exc)

    for endpoint in CELESTRAK_ENDPOINTS:
        url = f"{endpoint}?CATNR={norad_id}&FORMAT=JSON"
        try:
            resp = requests.get(url, headers=REQUEST_HEADERS, timeout=(5, 5))
            text = resp.text.strip()
            if resp.status_code == 404 or "No GP data found" in text or not text:
                raise ValueError(f"Satellite with NORAD ID {norad_id} not found on CelesTrak")

            resp.raise_for_status()
            parsed = resp.json()
            if not parsed:
                raise ValueError(f"Satellite with NORAD ID {norad_id} not found")

            sat_data = parsed[0] if isinstance(parsed, list) else parsed
            if not isinstance(sat_data, dict) or "OBJECT_NAME" not in sat_data:
                raise ValueError(f"Invalid GP data returned for NORAD ID {norad_id}")

            _write_cache(cache_key, sat_data)
            return {"data": sat_data, "stale": False, "cached": False}

        except ValueError:
            # Re-raise 404 satellite not found immediately
            raise
        except Exception as exc:
            last_network_exc = exc
            logger.warning("CelesTrak endpoint '%s' failed for NORAD %d: %s", endpoint, norad_id, exc)

    # If network failed, fall back to disk cache if available
    if cached:
        logger.info("Serving NORAD %d from stale disk cache", norad_id)
        return {"data": cached["data"], "stale": True, "cached": True}

    # If no disk cache exists, fall back to bundled seed data
    if norad_id in SEED_SATELLITES:
        seed = SEED_SATELLITES[norad_id]
        logger.info("Serving NORAD %d from bundled seed fallback", norad_id)
        _write_cache(cache_key, seed)
        return {"data": seed, "stale": True, "cached": True}

    raise ConnectionError(
        f"Cannot reach CelesTrak and no cached/seed data exists for NORAD {norad_id}"
    ) from last_network_exc


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
        return {
            "data": cached["data"],
            "stale": False,
            "cached": True,
            "provider": cached.get("provider", "celestrak"),
        }

    last_network_exc = None
    for endpoint in CELESTRAK_ENDPOINTS:
        url = f"{endpoint}?GROUP={clean_group}&FORMAT=JSON"
        try:
            # Bound the wait for unreachable hosted networks; catalog groups
            # are fetched concurrently by catalog_service.
            resp = requests.get(url, headers=REQUEST_HEADERS, timeout=(3, 5))
            text = resp.text.strip()
            if resp.status_code == 404 or "No GP data found" in text or not text:
                raise ValueError(f"Group '{group}' not found on CelesTrak")

            resp.raise_for_status()
            parsed = resp.json()
            sat_list = parsed if isinstance(parsed, list) else [parsed]

            _write_cache(cache_key, sat_list, provider="celestrak")
            return {"data": sat_list, "stale": False, "cached": False, "provider": "celestrak"}
        except ValueError:
            raise
        except Exception as exc:
            last_network_exc = exc
            logger.warning("CelesTrak endpoint '%s' failed for group '%s': %s", endpoint, group, exc)

    if cached:
        return {
            "data": cached["data"],
            "stale": True,
            "cached": True,
            "provider": cached.get("provider", "celestrak"),
        }

    raise ConnectionError(
        f"Cannot reach CelesTrak and no cache exists for group '{group}'"
    ) from last_network_exc
