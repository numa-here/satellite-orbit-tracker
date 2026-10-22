"""Refresh the sampled, offline active-satellite OMM catalog snapshot."""

import json
from pathlib import Path

import requests


SOURCE_URL = "https://retlector.eu/active/json"
SNAPSHOT_PATH = Path(__file__).resolve().parents[1] / "backend" / "data" / "active_omm_snapshot.json"
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


if __name__ == "__main__":
    main()
