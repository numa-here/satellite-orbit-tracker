"""
Full catalog service.

Merges satellite catalog data from KeepTrack (priority) and CelesTrak GP groups,
enriches from CelesTrak SATCAT, and serves a compact, cached /api/catalog payload.
All external calls are cached on disk; nothing is fetched per page load.
"""
import json
import logging
import time
from typing import Any, Dict, List, Optional

import requests

from .config import (
    CATALOG_CACHE_TTL_SECONDS,
    CELESTRAK_GP_GROUPS,
    KEEPTRACK_API_KEY,
    KEEPTRACK_BASE_URL,
    SATCAT_CACHE_TTL_SECONDS,
    SATCAT_URL,
)
from .schemas import CatalogEntry, CatalogError
from .tle_service import _is_fresh, _read_cache, _write_cache, fetch_group

logger = logging.getLogger(__name__)

REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

EARTH_RADIUS_KM = 6378.135
MU_KM3_S2 = 398600.8
MINUTES_PER_DAY = 1440.0


def _is_fresh_ttl(payload: Dict[str, Any], ttl_seconds: float) -> bool:
    stored_time = payload.get("timestamp", 0)
    return (time.time() - stored_time) < ttl_seconds


def _safe_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _safe_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _first_str(item: Dict[str, Any], keys: List[str]) -> Optional[str]:
    for key in keys:
        if key in item and item[key] is not None and str(item[key]).strip() != "":
            return str(item[key]).strip()
    return None


def _category(entry: CatalogEntry) -> str:
    name = (entry.name or "").upper()
    object_type = (entry.object_type or "").upper()
    group = (entry.group or "").lower()
    omm = entry.omm or {}
    ops_status = str(omm.get("OPS_STATUS") or "").upper()

    if any(token in name for token in ["ISS", "ZARYA", "TIANGONG", "CSS"]):
        return "crewed"
    if object_type == "R/B" or name.endswith(" R/B") or " R/B " in name:
        return "rocket_body"
    if object_type == "DEB" or name.endswith(" DEB") or " DEB " in name:
        return "debris"
    if any(token in name for token in ["STARLINK", "ONEWEB", "IRIDIUM"]):
        return "constellation"
    if any(token in name for token in ["GPS", "NAVSTAR", "GALILEO", "BEIDOU", "COMPASS", "GLONASS"]):
        return "gnss"
    if object_type == "PAY":
        if group == "weather" or any(token in name for token in ["NOAA", "TERRA", "AQUA", "GOES", "METOP"]):
            return "weather"
        return "payload"
    if ops_status == "A" or object_type == "PAY":
        return "payload"
    return "unknown"


def _orbit_regime(entry: CatalogEntry) -> str:
    omm = entry.omm or {}
    mm = _safe_float(omm.get("MEAN_MOTION"))
    if mm is None and entry.period_minutes:
        mm = MINUTES_PER_DAY / float(entry.period_minutes)
    ecc = _safe_float(omm.get("ECCENTRICITY")) or 0.0
    inc = _safe_float(omm.get("INCLINATION")) if entry.inclination_deg is None else entry.inclination_deg
    inc = inc or 0.0

    # Approximate circular altitude from mean motion when apogee/perigee are absent.
    xke = 60.0 / ((EARTH_RADIUS_KM ** 3) / MU_KM3_S2) ** 0.5
    alt_km = None
    if mm and mm > 0:
        no_rad_per_min = mm * (2 * 3.141592653589793) / MINUTES_PER_DAY
        a_earth = (xke / no_rad_per_min) ** (2.0 / 3.0)
        alt_km = (a_earth - 1.0) * EARTH_RADIUS_KM
    if entry.apogee_km is not None:
        alt_km = max(alt_km or 0, float(entry.apogee_km))
    if entry.perigee_km is not None and alt_km is not None:
        alt_km = max(alt_km, float(entry.perigee_km))

    if alt_km is None:
        return "unknown"
    if alt_km > 35786.0 or ecc > 0.25:
        return "HEO"
    if abs(alt_km - 35786.0) < 500.0 and inc < 25.0:
        return "GEO"
    if alt_km < 2000.0:
        return "LEO"
    if alt_km < 35786.0:
        return "MEO"
    return "HEO"


def _normalize_omm(sat_data: Dict[str, Any], group: str) -> Optional[CatalogEntry]:
    norad = _safe_int(sat_data.get("NORAD_CAT_ID"))
    if norad is None:
        return None
    return CatalogEntry(
        norad_id=norad,
        name=_first_str(sat_data, ["OBJECT_NAME"]) or "UNKNOWN",
        object_type=_first_str(sat_data, ["OBJECT_TYPE"]),
        country=_first_str(sat_data, ["OWNER"]),
        launch_date=_first_str(sat_data, ["LAUNCH_DATE"]),
        launch_site=_first_str(sat_data, ["LAUNCH_SITE"]),
        intl_designator=_first_str(sat_data, ["OBJECT_ID"]),
        orbit_class=_first_str(sat_data, ["ORBIT_TYPE"]),
        line1=_first_str(sat_data, ["TLE_LINE1"]),
        line2=_first_str(sat_data, ["TLE_LINE2"]),
        omm=sat_data if isinstance(sat_data, dict) else None,
        source="celestrak",
        group=group,
        decay_date=_first_str(sat_data, ["DECAY_DATE"]),
        period_minutes=_safe_float(sat_data.get("PERIOD")),
        apogee_km=_safe_float(sat_data.get("APOGEE")),
        perigee_km=_safe_float(sat_data.get("PERIGEE")),
        inclination_deg=_safe_float(sat_data.get("INCLINATION")),
        rcs_m2=_safe_float(sat_data.get("RCS")),
    )


def _normalize_keeptrack_item(item: Dict[str, Any]) -> Optional[CatalogEntry]:
    norad = _safe_int(
        item.get("norad_id")
        or item.get("norad_cat_id")
        or item.get("catalog_number")
        or item.get("cat_nr")
        or item.get("id")
    )
    if norad is None:
        return None
    omm = item.get("omm") if isinstance(item.get("omm"), dict) else None
    if omm is None:
        omm = {
            "OBJECT_NAME": _first_str(item, ["name", "object_name", "satellite_name", "title"]),
            "NORAD_CAT_ID": norad,
            "EPOCH": _first_str(item, ["epoch", "tle_epoch"]),
            "MEAN_MOTION": _safe_float(item.get("mean_motion") or item.get("meanMotion")),
            "ECCENTRICITY": _safe_float(item.get("eccentricity")),
            "INCLINATION": _safe_float(item.get("inclination")),
            "RA_OF_ASC_NODE": _safe_float(item.get("raan") or item.get("ra_of_asc_node")),
            "ARG_OF_PERICENTER": _safe_float(item.get("argp") or item.get("arg_of_perigee")),
            "MEAN_ANOMALY": _safe_float(item.get("mean_anomaly") or item.get("ma")),
            "BSTAR": _safe_float(item.get("bstar") or item.get("b_star")),
            "OBJECT_ID": _first_str(item, ["intl_designator", "international_designator", "object_id"]),
            "OBJECT_TYPE": _first_str(item, ["object_type"]),
            "OWNER": _first_str(item, ["country", "owner"]),
            "LAUNCH_DATE": _first_str(item, ["launch_date"]),
        }
    return CatalogEntry(
        norad_id=norad,
        name=_first_str(item, ["name", "object_name", "satellite_name", "title"]) or omm.get("OBJECT_NAME") or "UNKNOWN",
        object_type=_first_str(item, ["object_type"]) or omm.get("OBJECT_TYPE"),
        country=_first_str(item, ["country", "owner"]) or omm.get("OWNER"),
        launch_date=_first_str(item, ["launch_date"]) or omm.get("LAUNCH_DATE"),
        launch_site=_first_str(item, ["launch_site"]) or omm.get("LAUNCH_SITE"),
        intl_designator=_first_str(item, ["intl_designator", "international_designator"]) or omm.get("OBJECT_ID"),
        orbit_class=_first_str(item, ["orbit_class", "orbitClass"]) or omm.get("ORBIT_TYPE"),
        line1=_first_str(item, ["line1", "tle_line1"]),
        line2=_first_str(item, ["line2", "tle_line2"]),
        omm=omm,
        source="keeptrack",
        group=_first_str(item, ["constellation", "group", "category"]),
        decay_date=_first_str(item, ["decay_date"]) or omm.get("DECAY_DATE"),
        period_minutes=_safe_float(item.get("period_minutes") or omm.get("PERIOD")),
        apogee_km=_safe_float(item.get("apogee_km") or omm.get("APOGEE")),
        perigee_km=_safe_float(item.get("perigee_km") or omm.get("PERIGEE")),
        inclination_deg=_safe_float(item.get("inclination_deg") or omm.get("INCLINATION")),
        rcs_m2=_safe_float(item.get("rcs_m2") or omm.get("RCS")),
    )


def _merge_satcat(entry: CatalogEntry, meta: Optional[Dict[str, Any]]) -> None:
    if not meta:
        return
    if not entry.country:
        entry.country = _first_str(meta, ["OWNER", "owner"])
    if not entry.launch_date:
        entry.launch_date = _first_str(meta, ["LAUNCH_DATE", "launch_date"])
    if not entry.launch_site:
        entry.launch_site = _first_str(meta, ["LAUNCH_SITE", "launch_site"])
    if not entry.object_type:
        entry.object_type = _first_str(meta, ["OBJECT_TYPE", "object_type"])
    if not entry.decay_date:
        entry.decay_date = _first_str(meta, ["DECAY_DATE", "decay_date"])
    if not entry.intl_designator:
        entry.intl_designator = _first_str(meta, ["OBJECT_ID", "object_id", "intl_designator"])
    if not entry.orbit_class:
        entry.orbit_class = _first_str(meta, ["ORBIT_TYPE", "orbit_type", "orbit_class"])
    if entry.period_minutes is None:
        entry.period_minutes = _safe_float(meta.get("PERIOD"))
    if entry.inclination_deg is None:
        entry.inclination_deg = _safe_float(meta.get("INCLINATION"))
    if entry.apogee_km is None:
        entry.apogee_km = _safe_float(meta.get("APOGEE"))
    if entry.perigee_km is None:
        entry.perigee_km = _safe_float(meta.get("PERIGEE"))
    if entry.rcs_m2 is None:
        entry.rcs_m2 = _safe_float(meta.get("RCS"))


def _fetch_keeptrack_brief() -> List[Dict[str, Any]]:
    if not KEEPTRACK_API_KEY:
        logger.info("KeepTrack API key not configured; skipping KeepTrack catalog source")
        return []
    url = f"{KEEPTRACK_BASE_URL.rstrip('/')}/v4/sats/brief"
    attempts = [
        {"Authorization": f"Bearer {KEEPTRACK_API_KEY}"},
        {"X-API-Key": KEEPTRACK_API_KEY},
    ]
    for headers in attempts:
        request_headers = {**REQUEST_HEADERS, **headers}
        try:
            resp = requests.get(url, headers=request_headers, timeout=(10, 20))
            if resp.status_code in (401, 403):
                logger.warning("KeepTrack API key rejected (%s); skipping KeepTrack source", resp.status_code)
                return []
            resp.raise_for_status()
            payload = resp.json()
            if isinstance(payload, list):
                return payload
            if isinstance(payload, dict):
                for key in ("data", "results", "sats", "satellites", "objects"):
                    if isinstance(payload.get(key), list):
                        return payload[key]
            logger.warning("KeepTrack brief returned unexpected payload type: %s", type(payload))
            return []
        except Exception as exc:
            logger.warning("KeepTrack brief request failed with headers %s: %s", list(headers), exc)
            continue
    return []


def _fetch_satcat() -> Dict[int, Dict[str, Any]]:
    cache_key = "satcat_all_v1"
    cached = _read_cache(cache_key)
    if cached and _is_fresh_ttl(cached, SATCAT_CACHE_TTL_SECONDS):
        return cached.get("data", {})

    mapping: Dict[int, Dict[str, Any]] = {}
    try:
        resp = requests.get(SATCAT_URL, headers=REQUEST_HEADERS, timeout=(15, 40))
        resp.raise_for_status()
        payload = resp.json()
        records = payload if isinstance(payload, list) else (payload.get("records") or [])
        for record in records:
            if not isinstance(record, dict):
                continue
            norad = _safe_int(record.get("NORAD_CAT_ID"))
            if norad is not None:
                mapping[norad] = record
        _write_cache(cache_key, {"timestamp": time.time(), "data": mapping})
    except Exception as exc:
        logger.warning("SATCAT fetch failed: %s", exc)
        if cached:
            return cached.get("data", {})
    return mapping


def build_catalog() -> Dict[str, Any]:
    items: Dict[int, CatalogEntry] = {}
    sources: List[str] = []

    # 1. KeepTrack brief (priority source, key from backend env only)
    keeptrack_items = _fetch_keeptrack_brief()
    if keeptrack_items:
        sources.append("keeptrack")
    for raw in keeptrack_items:
        entry = _normalize_keeptrack_item(raw)
        if entry:
            items[entry.norad_id] = entry

    # 2. CelesTrak GP groups; skip groups that fail rather than aborting the catalog
    celestrak_ok = False
    for group in CELESTRAK_GP_GROUPS:
        try:
            result = fetch_group(group)
        except Exception as exc:
            logger.warning("CelesTrak group '%s' unavailable: %s", group, exc)
            continue
        celestrak_ok = True
        sat_list = result.get("data") if isinstance(result, dict) else result
        if not isinstance(sat_list, list):
            continue
        for sat_data in sat_list:
            entry = _normalize_omm(sat_data, group)
            if entry and entry.norad_id not in items:
                items[entry.norad_id] = entry

    if celestrak_ok:
        sources.append("celestrak")

    # 3. SATCAT enrichment for all merged NORAD IDs
    satcat = _fetch_satcat()
    for entry in items.values():
        _merge_satcat(entry, satcat.get(entry.norad_id))
        entry.category = _category(entry)
        entry.orbit_regime = _orbit_regime(entry)

    objects = sorted(items.values(), key=lambda e: e.norad_id)
    return {
        "objects": [entry.model_dump() for entry in objects],
        "count": len(objects),
        "sources": sources,
        "updated_at": time.time(),
    }


def get_catalog(force_refresh: bool = False) -> Dict[str, Any]:
    cache_key = "catalog_v1"
    cached = _read_cache(cache_key)

    if not force_refresh and cached and _is_fresh_ttl(cached, CATALOG_CACHE_TTL_SECONDS):
        data = cached.get("data", {})
        data["cached"] = True
        data["stale"] = False
        return data

    try:
        data = build_catalog()
        _write_cache(cache_key, {"timestamp": time.time(), "data": data})
        data["cached"] = False
        data["stale"] = False
        return data
    except Exception as exc:
        logger.exception("Catalog build failed")
        if cached:
            data = cached.get("data", {})
            data["cached"] = True
            data["stale"] = True
            return data
        raise CatalogError(f"Unable to build satellite catalog: {exc}") from exc