"""Refresh the sampled, offline active-satellite OMM catalog snapshot."""

import json
from pathlib import Path

import requests


SOURCE_URL = "https://retlector.eu/active/json"
SATCAT_URL = "https://celestrak.org/satcat/records.php?GROUP=active&FORMAT=JSON"
SNAPSHOT_PATH = Path(__file__).resolve().parents[1] / "backend" / "data" / "active_omm_snapshot.json"
SATCAT_PATH = Path(__file__).resolve().parents[1] / "backend" / "data" / "satcat_metadata.json"
MAX_RECORDS = 5000


def main():
    response = requests.get(SOURCE_URL, timeout=(5, 30))
    response.raise_for_status()
    records = response.json()
    if not isinstance(records, list) or len(records) < 500:
        raise RuntimeError("The upstream active group returned fewer than 500 records.")

    count = min(MAX_RECORDS, len(records))
    sampled = [records[round(i * (len(records) - 1) / (count - 1))] for i in range(count)]
    SNAPSHOT_PATH.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT_PATH.write_text(
        json.dumps(sampled, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Wrote {count} OMM records to {SNAPSHOT_PATH}")

    satcat_response = requests.get(SATCAT_URL, timeout=(8, 60))
    satcat_response.raise_for_status()
    satcat_rows = satcat_response.json()
    if not isinstance(satcat_rows, list) or len(satcat_rows) < 500:
        raise RuntimeError("The SATCAT endpoint returned fewer than 500 records.")
    fields = (
        "OBJECT_NAME", "OBJECT_ID", "NORAD_CAT_ID", "OBJECT_TYPE", "OPS_STATUS_CODE",
        "OWNER", "LAUNCH_DATE", "LAUNCH_SITE", "DECAY_DATE", "PERIOD", "INCLINATION",
        "APOGEE", "PERIGEE", "RCS", "ORBIT_TYPE",
    )
    satcat = {
        str(int(row["NORAD_CAT_ID"])): {field: row.get(field) for field in fields if row.get(field) not in (None, "")}
        for row in satcat_rows
        if isinstance(row, dict) and str(row.get("NORAD_CAT_ID", "")).strip().isdigit()
    }
    SATCAT_PATH.write_text(json.dumps(satcat, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(satcat):,} SATCAT metadata records to {SATCAT_PATH}")


if __name__ == "__main__":
    main()
