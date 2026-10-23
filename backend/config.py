"""
Configuration settings for the Satellite Orbit Tracker backend.

All tunable parameters are defined here so they are easy to find and change.
Environment variables can override defaults via a .env file.
"""
import os
from pathlib import Path

# Base directory for the backend package
BASE_DIR = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------
# CelesTrak GP API
# ---------------------------------------------------------------------------
CELESTRAK_BASE_URL = "https://celestrak.org/NORAD/elements/gp.php"

# ---------------------------------------------------------------------------
# File-based cache (backend/cache/, git-ignored)
# ---------------------------------------------------------------------------
CACHE_DIR = BASE_DIR / "cache"
CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "7200"))  # Default: 2 hours

# ---------------------------------------------------------------------------
# TLE staleness threshold
# ---------------------------------------------------------------------------
TLE_STALE_WARNING_DAYS = 7.0  # Warn if TLE epoch is older than 7 days

# ---------------------------------------------------------------------------
# Pre-loaded satellite list for quick and fast dropdown navigation
# ---------------------------------------------------------------------------
DEFAULT_SATELLITES = [
    {"name": "ISS (ZARYA)",            "norad_id": 25544, "group": "stations"},
    {"name": "CSS (TIANGONG)",         "norad_id": 48274, "group": "stations"},
    {"name": "HUBBLE SPACE TELESCOPE", "norad_id": 20580, "group": "science"},
    {"name": "NOAA 19",                "norad_id": 33591, "group": "weather"},
    {"name": "TERRA",                  "norad_id": 25994, "group": "weather"},
    {"name": "AQUA",                   "norad_id": 27424, "group": "weather"},
    {"name": "GOES 16",                "norad_id": 41866, "group": "weather"},
    {"name": "NAVSTAR 81 (USA 319)",   "norad_id": 48859, "group": "gps-ops"},
]

SATELLITE_GROUPS = [
    {"name": "Space Stations",  "group": "stations"},
    {"name": "Weather Satellites", "group": "weather"},
    {"name": "GPS Operational", "group": "gps-ops"},
]

# ---------------------------------------------------------------------------
# Server Configuration
# ---------------------------------------------------------------------------
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
KEEPTRACK_API_KEY = os.getenv("KEEPTRACK_API_KEY", "")
KEEPTRACK_BASE_URL = os.getenv("KEEPTRACK_BASE_URL", "https://api.keeptrack.space")

CATALOG_CACHE_TTL_SECONDS = int(os.getenv("CATALOG_CACHE_TTL_SECONDS", "7200"))
SATCAT_CACHE_TTL_SECONDS = int(os.getenv("SATCAT_CACHE_TTL_SECONDS", "86400"))
CATALOG_MAX_OBJECTS = int(os.getenv("CATALOG_MAX_OBJECTS", "20000"))
SATCAT_URL = os.getenv(
    "SATCAT_URL",
    "https://celestrak.org/satcat/records.php?FORMAT=JSON&MAX=150000",
)

CELESTRAK_GP_GROUPS = [
    "active",
    "stations",
    "starlink",
    "oneweb",
    "gps-ops",
    "galileo",
    "beidou",
    "glo-ops",
    "weather",
    "geo",
    "science",
    "amateur",
    "iridium-NEXT",
    "cosmos-2251-debris",
    "iridium-33-debris",
    "fengyun-1c-debris",
    "cosmos-1408-debris",
]
