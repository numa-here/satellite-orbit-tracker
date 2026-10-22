#!/usr/bin/env python3
"""Script to regenerate the bundled seed catalog (catalog_seed.json).

Fetches current satellite data from CelesTrak and writes it to
backend/data/catalog_seed.json for use as a fallback when live
APIs are unavailable.

Usage:
    python scripts/make_seed.py

Environment variables:
    CELESTRAK_USER_AGENT  – Custom User-Agent header for CelesTrak (default: SatelliteOrbitTracker/1.0)
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

# Add backend to path so we can import the app's config
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from server import app, CELESTRAK_USER_AGENT, DATA_DIR, CACHE_DIR, load_seed_data

SEED_FILE = os.path.join(DATA_DIR, "catalog_seed.json")


def fetch_celes_trak():
    """Fetch active satellite TLE data from CelesTrak and return structured catalog."""
    import urllib.request

    base_url = "https://celestrak.org/NLE/DATA/Active.txt"
    timeout_s = 15

    req = urllib.request.Request(
        base_url,
        headers={"User-Agent": CELESTRAK_USER_AGENT, "Accept": "text/plain"},
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as response:
            lines = response.read().decode("utf-8", errors="replace").splitlines()

        entries = []
        for i in range(0, len(lines) - 2, 3):
            name_line = lines[i].strip()
            line1 = lines[i + 1].strip()
            line2 = lines[i + 2].strip()

            try:
                norad_id = int(name_line) if name_line.isdigit() else None
            except ValueError:
                norad_id = None

            intl_desig = line1[:8] if len(line1) >= 8 else ""

            entries.append(
                {
                    "norad_id": norad_id,
                    "name": name_line if name_line else f"Satellite {norad_id}",
                    "category": "unknown",
                    "orbit_regime": "unknown",
                    "country": "unknown",
                    "object_type": "unknown",
                    "latitude": 0.0,
                    "longitude": 0.0,
                    "altitude_km": 0.0,
                    "inclination": 0.0,
                    "epoch": "",
                    "mean_motion": "",
                    "eccentricity": "",
                    "arg_of_perigee": "",
                    "mean_anomaly": "",
                    "rev_number": "",
                    "intl_designator": intl_desig,
                    "source": "CelesTrak",
                }
            )

        catalog = {
            "objects": entries,
            "count": len(entries),
            "source": "CelesTrak",
            "stale": False,
            "last_fetched": datetime.now(timezone.utc).isoformat(),
        }
        return catalog

    except Exception as e:
        print(f"Error fetching CelesTrak data: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    print("Fetching satellite data from CelesTrak...")
    catalog = fetch_celes_trak()

    # Ensure data directory exists
    os.makedirs(DATA_DIR, exist_ok=True)

    # Write seed file
    with open(SEED_FILE, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2)

    print(f"Seed data written to {SEED_FILE}")
    print(f"Total satellites: {catalog['count']}")
    print("Done.")


if __name__ == "__main__":
    main()