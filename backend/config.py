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
