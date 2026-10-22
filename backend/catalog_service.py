"""
Full catalog service.

Merges satellite catalog data from KeepTrack (priority) and CelesTrak GP groups,
uses cached CelesTrak SATCAT metadata when available, and serves a compact,
cached /api/catalog payload.
"""
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional

import requests

from .config import (
    CATALOG_MAX_OBJECTS,
    CATALOG_CACHE_TTL_SECONDS,
    CELESTRAK_GP_GROUPS,
    KEEPTRACK_API_KEY,
    KEEPTRACK_BASE_URL,
)
from .schemas import CatalogEntry, CatalogError
from .tle_service import _read_cache, _write_cache, fetch_group

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
OWNER_NAMES = {
    "US": "United States", "CIS": "Commonwealth of Independent States", "PRC": "China",
    "CHBZ": "China / Brazil", "ESA": "European Space Agency", "ESRO": "European Space Research Organisation",
    "FR": "France", "GER": "Germany", "UK": "United Kingdom", "JPN": "Japan", "IND": "India",
    "ISRO": "Indian Space Research Organisation", "CA": "Canada", "IT": "Italy", "SPN": "Spain",
    "NETH": "Netherlands", "SKOR": "South Korea", "NKOR": "North Korea", "IRAN": "Iran",
    "ISRA": "Israel", "AUS": "Australia", "BRAZ": "Brazil", "ARGN": "Argentina", "MEX": "Mexico",
    "PAKI": "Pakistan", "TURK": "Türkiye", "UAE": "United Arab Emirates", "SAUD": "Saudi Arabia",
    "NATO": "NATO", "ISS": "International Space Station partners", "GLOB": "Globalstar", "IRID": "Iridium",
    "SES": "SES", "EUTE": "Eutelsat", "IM": "Inmarsat", "UNK": "Unknown",
}
OPS_STATUS_NAMES = {
    "+": "Operational", "-": "Nonoperational", "P": "Partially operational",
    "B": "Backup / standby", "S": "Spare", "X": "Extended mission",
    "D": "Decayed / deorbited", "?": "Unknown",
}


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
    nested_omm = sat_data.get("omm") if isinstance(sat_data.get("omm"), dict) else None
    omm = nested_omm or sat_data
    norad = _safe_int(
        sat_data.get("NORAD_CAT_ID")
        or sat_data.get("norad_id")
        or sat_data.get("catalog_number")
        or omm.get("NORAD_CAT_ID")
    )
    if norad is None:
        return None
    return CatalogEntry(
        norad_id=norad,
        name=_first_str(sat_data, ["OBJECT_NAME", "name"]) or _first_str(omm, ["OBJECT_NAME"]) or "UNKNOWN",
        object_type=_first_str(sat_data, ["OBJECT_TYPE", "object_type"]) or _first_str(omm, ["OBJECT_TYPE"]),
        country=_first_str(sat_data, ["OWNER", "country"]) or _first_str(omm, ["OWNER"]),
        status=_first_str(sat_data, ["OPS_STATUS_CODE", "status"]) or _first_str(omm, ["OPS_STATUS_CODE"]),
        launch_date=_first_str(sat_data, ["LAUNCH_DATE", "launch_date"]) or _first_str(omm, ["LAUNCH_DATE"]),
        launch_site=_first_str(sat_data, ["LAUNCH_SITE", "launch_site"]) or _first_str(omm, ["LAUNCH_SITE"]),
        intl_designator=_first_str(sat_data, ["OBJECT_ID", "intl_designator"]) or _first_str(omm, ["OBJECT_ID"]),
        orbit_class=_first_str(sat_data, ["ORBIT_TYPE", "orbit_class"]) or _first_str(omm, ["ORBIT_TYPE"]),
        line1=_first_str(sat_data, ["TLE_LINE1", "line1", "tle_line1"]) or _first_str(omm, ["TLE_LINE1"]),
        line2=_first_str(sat_data, ["TLE_LINE2", "line2", "tle_line2"]) or _first_str(omm, ["TLE_LINE2"]),
        omm=omm if isinstance(omm, dict) else None,
        source=_first_str(sat_data, ["source"]) or "celestrak",
        group=_first_str(sat_data, ["group"]) or group,
        decay_date=_first_str(sat_data, ["DECAY_DATE", "decay_date"]) or _first_str(omm, ["DECAY_DATE"]),
        period_minutes=_safe_float(sat_data.get("PERIOD") or sat_data.get("period_minutes") or omm.get("PERIOD")),
        apogee_km=_safe_float(sat_data.get("APOGEE") or sat_data.get("apogee_km") or omm.get("APOGEE")),
        perigee_km=_safe_float(sat_data.get("PERIGEE") or sat_data.get("perigee_km") or omm.get("PERIGEE")),
        inclination_deg=_safe_float(sat_data.get("INCLINATION") or sat_data.get("inclination_deg") or omm.get("INCLINATION")),
        rcs_m2=_safe_float(sat_data.get("RCS") or sat_data.get("rcs_m2") or omm.get("RCS")),
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
        status=_first_str(item, ["status", "ops_status_code"]) or omm.get("OPS_STATUS_CODE"),
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
    owner = entry.country or _first_str(meta, ["OWNER", "owner"])
    entry.country = OWNER_NAMES.get(owner, owner) if owner else None
    status = entry.status or _first_str(meta, ["OPS_STATUS_CODE", "ops_status_code", "status"])
    entry.status = OPS_STATUS_NAMES.get(status, status) if status else None
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


def _fetch_satcat() -> Dict[int, Dict[str, Any]]:
    """Load SATCAT enrichment from the runtime cache or bundled public snapshot."""
    cached = _read_cache("satcat_all_v1")
    data = (cached or {}).get("data", {})
    if isinstance(data, dict) and data:
        return {_safe_int(key): value for key, value in data.items() if _safe_int(key) is not None}
    try:
        from pathlib import Path
        snapshot_path = Path(__file__).parent / "data" / "satcat_metadata.json"
        with snapshot_path.open(encoding="utf-8") as snapshot_file:
            rows = json.load(snapshot_file)
        if isinstance(rows, dict):
            return {_safe_int(key): value for key, value in rows.items() if _safe_int(key) is not None and isinstance(value, dict)}
        if isinstance(rows, list):
            return {norad: row for row in rows if isinstance(row, dict) and (norad := _safe_int(row.get("NORAD_CAT_ID") or row.get("norad_id"))) is not None}
    except (OSError, ValueError, TypeError) as exc:
        logger.warning("Bundled SATCAT metadata unavailable: %s", exc)
    return {}


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


def _entry_to_compact(entry: CatalogEntry) -> Dict[str, Any]:
    """Convert a CatalogEntry to a compact dict for JSON transfer.

    Keeps only the fields needed for Three.js satellite.js propagation:
    orbital elements + basic identity. All other SATCAT metadata is
    available on-demand via the /api/satellite/{norad_id} endpoint.
    """
    return {
        "norad_id": entry.norad_id,
        "name": entry.name,
        "object_type": entry.object_type,
        "category": entry.category,
        "country": entry.country,
        "status": entry.status,
        "launch_date": entry.launch_date,
        "launch_site": entry.launch_site,
        "intl_designator": entry.intl_designator,
        "orbit_class": entry.orbit_class,
        "orbit_regime": entry.orbit_regime,
        "period_minutes": entry.period_minutes,
        "decay_date": entry.decay_date,
        "rcs_m2": entry.rcs_m2,
        "group": entry.group,
        "source": entry.source,
        "stale": entry.stale,
        "line1": entry.line1,
        "line2": entry.line2,
        "omm": entry.omm,
        # Orbital elements for satellite.js propagation
        "inclination_deg": entry.inclination_deg,
        "mean_motion": _safe_float(entry.omm.get("MEAN_MOTION")) if entry.omm else None,
        "mean_anomaly_deg": _safe_float(entry.omm.get("MEAN_ANOMALY")) if entry.omm else None,
        "arg_of_perigee_deg": _safe_float(entry.omm.get("ARG_OF_PERIGEE")) if entry.omm else None,
        "ra_of_asc_node_deg": _safe_float(entry.omm.get("RA_OF_ASC_NODE")) if entry.omm else None,
        "epoch": _safe_float(entry.omm.get("EPOCH")) if entry.omm else None,
        # SATCAT fields
        "apogee_km": _safe_float(entry.omm.get("APOGEE")) if entry.omm else None,
        "perigee_km": _safe_float(entry.omm.get("PERIGEE")) if entry.omm else None,
    }


def build_catalog(limit: Optional[int] = None, offset: int = 0) -> Dict[str, Any]:
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

    # 2. Fetch groups concurrently so unreachable feeds don't cause sequential
    # timeouts that leave hosted users staring at an empty loading screen.
    celestrak_ok = False
    celestrak_present = False
    retlector_present = False
    # The active group supplies thousands of objects; companion groups add
    # constellation and debris coverage. Run all group requests concurrently
    # so an unreachable provider costs one bounded timeout window, not one per
    # group.
    groups_to_fetch = CELESTRAK_GP_GROUPS
    with ThreadPoolExecutor(max_workers=max(1, len(groups_to_fetch))) as pool:
        futures = {pool.submit(fetch_group, group): group for group in groups_to_fetch}
        for future in as_completed(futures):
            group = futures[future]
            try:
                result = future.result()
            except Exception as exc:
                logger.warning("CelesTrak group '%s' unavailable: %s", group, exc)
                continue
            sat_list = result.get("data") if isinstance(result, dict) else result
            if not isinstance(sat_list, list):
                continue
            provider = result.get("provider", "celestrak") if isinstance(result, dict) else "celestrak"
            if sat_list:
                if provider == "retlector":
                    retlector_present = True
                else:
                    celestrak_present = True
            group_stale = bool(isinstance(result, dict) and result.get("stale"))
            if sat_list and not group_stale:
                celestrak_ok = True
            for sat_data in sat_list:
                entry = _normalize_omm(sat_data, group)
                if entry and entry.norad_id not in items:
                    entry.source = provider
                    entry.stale = group_stale
                    items[entry.norad_id] = entry

    # Render may not be able to reach either public provider. Keep a larger,
    # periodically refreshed public OMM snapshot bundled so search and the
    # orbit scene remain useful during an outage. Fresh upstream items already
    # in ``items`` take precedence over snapshot rows with matching NORAD IDs.
    snapshot_used = False
    if len(items) < 5000:
        try:
            from pathlib import Path
            snapshot_path = Path(__file__).parent / "data" / "active_omm_snapshot.json"
            with snapshot_path.open(encoding="utf-8") as snapshot_file:
                snapshot_rows = json.load(snapshot_file)
            from .seed_data import SEED_SATELLITES
            snapshot_ids = {
                _safe_int(row.get("NORAD_CAT_ID") or row.get("norad_id"))
                for row in snapshot_rows if isinstance(row, dict)
            }
            snapshot_rows.extend(
                row for norad_id, row in SEED_SATELLITES.items()
                if norad_id not in snapshot_ids
            )
            for sat_data in snapshot_rows:
                entry = _normalize_omm(sat_data, "active snapshot")
                if entry and entry.norad_id not in items:
                    entry.source = "retlector snapshot"
                    entry.stale = True
                    items[entry.norad_id] = entry
                    snapshot_used = True
        except (OSError, ValueError, TypeError) as exc:
            logger.warning("Bundled active catalog snapshot unavailable: %s", exc)

    # Curated OMMs keep the app usable if both feeds and snapshot are absent.
    from .seed_data import SEED_SATELLITES
    seed_used = False
    if not items:
        for norad_id, sat_data in SEED_SATELLITES.items():
            entry = _normalize_omm(sat_data, "seed")
            if entry:
                entry.source = "seed"
                entry.stale = True
                items[norad_id] = entry
                seed_used = True

    if celestrak_present:
        sources.append("celestrak")
    if retlector_present:
        sources.append("retlector")
    if snapshot_used:
        sources.append("retlector snapshot")
    if seed_used:
        sources.append("seed")

    # 3. SATCAT enrichment for all merged NORAD IDs
    # SATCAT is optional enrichment and can be a large request. Use a warmed
    # cache only so metadata lookup never delays the first catalog response.
    satcat = _fetch_satcat()
    for entry in items.values():
        _merge_satcat(entry, satcat.get(entry.norad_id))
        entry.category = _category(entry)
        entry.orbit_regime = _orbit_regime(entry)

    # 4. Pagination + compact serialization
    all_objects = sorted(items.values(), key=lambda e: e.norad_id)
    total = len(all_objects)

    effective_limit = CATALOG_MAX_OBJECTS if limit is None else limit
    if effective_limit is None:
        effective_limit = total
    elif effective_limit < 0:
        effective_limit = 0
    upper = min(offset + effective_limit, total)
    paged_objects = all_objects[offset:upper]

    compact_objects = [_entry_to_compact(entry) for entry in paged_objects]

    return {
        "objects": compact_objects,
        "count": len(compact_objects),
        "total_count": total,
        "sources": sources,
        "stale": not celestrak_ok and "keeptrack" not in sources,
        "updated_at": time.time(),
        "limit": effective_limit,
        "offset": offset,
    }


def get_catalog(force_refresh: bool = False) -> Dict[str, Any]:
    # v3 invalidates partial catalogs cached before snapshot top-up was applied.
    cache_key = "catalog_v3"
    cached = _read_cache(cache_key)
    cached_data = cached.get("data", {}) if isinstance(cached, dict) else {}
    if not isinstance(cached_data, dict):
        cached_data = {}
    has_cached_objects = (
        isinstance(cached_data.get("objects"), list)
        and len(cached_data["objects"]) > 0
    )

    if (
        not force_refresh
        and has_cached_objects
        and _is_fresh_ttl(cached, CATALOG_CACHE_TTL_SECONDS)
    ):
        data = dict(cached_data)
        data["cached"] = True
        data["stale"] = bool(data.get("stale"))
        # Ensure source field is set
        if "source" not in data:
            data["source"] = "cache"
        return data

    try:
        data = build_catalog()
        if not data.get("objects"):
            raise CatalogError("Upstream providers returned an empty satellite catalog")
        _write_cache(cache_key, {"timestamp": time.time(), "data": data})
        data["cached"] = False
        data["stale"] = bool(data.get("stale"))
        # Ensure source field is set
        if "source" not in data:
            data["source"] = ", ".join(data.get("sources", [])) or "celestrak"
        return data
    except Exception as exc:
        logger.exception("Catalog build failed")
        if has_cached_objects:
            data = dict(cached_data)
            data["cached"] = True
            data["stale"] = True
            # Ensure source field is set
            if "source" not in data:
                data["source"] = cached.get("source", "cache")
            return data
        # Fallback to seed data when everything else fails
        try:
            from .seed_data import SEED_SATELLITES
            objects = []
            for norad_id, sat_data in SEED_SATELLITES.items():
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
                    omm=sat_data,
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
                "updated_at": time.time(),
            }
        except Exception as e2:
            logger.error("Seed data fallback also failed: %s", e2)
            raise CatalogError(f"Unable to build satellite catalog: {exc}") from exc
