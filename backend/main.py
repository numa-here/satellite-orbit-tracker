"""
FastAPI application for the Satellite Orbit Tracker.

Exposes RESTful endpoints for real-time satellite telemetry, ground tracks,
and Keplerian orbital elements, and hosts the frontend single-page application.
"""
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import DEFAULT_SATELLITES, SATELLITE_GROUPS
from .propagation import build_satellite, get_elements, get_position, get_track
from .schemas import (
    ErrorResponse,
    HealthResponse,
    OrbitalElementsResponse,
    PositionResponse,
    SatelliteInfo,
    GroupInfo,
    SatelliteListResponse,
    TrackPoint,
    TrackResponse,
)
from .tle_service import fetch_satellite_by_norad

app = FastAPI(
    title="Satellite Orbit Tracker API",
    description="Real-time 3D satellite tracking powered by Skyfield and SGP4.",
    version="1.0.0",
)

# ---------------------------------------------------------------------------
# Cross-Origin Resource Sharing (CORS) Middleware
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


# ---------------------------------------------------------------------------
# REST API Endpoints
# ---------------------------------------------------------------------------

@app.get(
    "/api/health",
    response_model=HealthResponse,
    summary="Health check",
    tags=["Diagnostics"],
)
async def health_check():
    """Verify backend health and return the current server UTC timestamp."""
    return HealthResponse(
        status="ok",
        timestamp=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


@app.get(
    "/api/satellites",
    response_model=SatelliteListResponse,
    summary="List available satellites",
    tags=["Satellites"],
)
async def list_satellites():
    """Return the curated list of popular satellites and constellation groups."""
    sats = [SatelliteInfo(**s) for s in DEFAULT_SATELLITES]
    groups = [GroupInfo(**g) for g in SATELLITE_GROUPS]
    return SatelliteListResponse(satellites=sats, groups=groups)


@app.get(
    "/api/position",
    response_model=PositionResponse,
    responses={
        404: {"model": ErrorResponse, "description": "Satellite not found"},
        502: {"model": ErrorResponse, "description": "Upstream CelesTrak failure"},
    },
    summary="Get live satellite position",
    tags=["Telemetry"],
)
async def get_satellite_position(
    sat: int = Query(25544, ge=1, description="NORAD Catalog Number (e.g. 25544 for ISS)")
):
    """
    Compute current geographic subpoint, altitude, speed, and heading.

    Defaults to the International Space Station (NORAD 25544).
    """
    try:
        tle_result = fetch_satellite_by_norad(sat)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except ConnectionError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))

    sat_data = tle_result["data"]
    try:
        sat_obj = build_satellite(sat_data)
        pos = get_position(sat_obj)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"SGP4 propagation error: {exc}",
        )

    return PositionResponse(
        name=sat_data.get("OBJECT_NAME", "UNKNOWN"),
        norad_id=sat,
        latitude=pos["latitude"],
        longitude=pos["longitude"],
        altitude_km=pos["altitude_km"],
        velocity_km_s=pos["velocity_km_s"],
        heading_degrees=pos["heading_degrees"],
        direction=pos["direction"],
        utc_time=pos["utc_time"],
        tle_epoch=pos["tle_epoch"],
        tle_age_days=pos["tle_age_days"],
        stale_tle=tle_result["stale"] or (pos["stale_warning"] is not None),
        stale_warning=pos["stale_warning"],
        cached=tle_result["cached"],
    )


@app.get(
    "/api/track",
    response_model=TrackResponse,
    responses={
        404: {"model": ErrorResponse, "description": "Satellite not found"},
        502: {"model": ErrorResponse, "description": "Upstream CelesTrak failure"},
    },
    summary="Get orbital ground track",
    tags=["Telemetry"],
)
async def get_satellite_track(
    sat: int = Query(25544, ge=1, description="NORAD Catalog Number"),
    minutes: int = Query(90, ge=10, le=360, description="Duration of track in minutes"),
    step: int = Query(30, ge=5, le=300, description="Step size in seconds between points"),
):
    """
    Generate ground track coordinates for 3D visualization.

    The path is centered on current UTC time to provide historical + projected trajectory.
    """
    try:
        tle_result = fetch_satellite_by_norad(sat)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except ConnectionError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))

    sat_data = tle_result["data"]
    try:
        sat_obj = build_satellite(sat_data)
        points = get_track(sat_obj, minutes=minutes, step_seconds=step)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"SGP4 track computation error: {exc}",
        )

    return TrackResponse(
        name=sat_data.get("OBJECT_NAME", "UNKNOWN"),
        norad_id=sat,
        points=[TrackPoint(**p) for p in points],
        stale_tle=tle_result["stale"],
    )


@app.get(
    "/api/elements",
    response_model=OrbitalElementsResponse,
    responses={
        404: {"model": ErrorResponse, "description": "Satellite not found"},
        502: {"model": ErrorResponse, "description": "Upstream CelesTrak failure"},
    },
    summary="Get Keplerian orbital elements",
    tags=["Orbital Mechanics"],
)
async def get_satellite_elements(
    sat: int = Query(25544, ge=1, description="NORAD Catalog Number")
):
    """
    Parse and return Keplerian orbital elements from the latest TLE / OMM.
    """
    try:
        tle_result = fetch_satellite_by_norad(sat)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except ConnectionError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))

    sat_data = tle_result["data"]
    try:
        elems = get_elements(sat_data)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to parse orbital elements: {exc}",
        )

    return OrbitalElementsResponse(
        **elems,
        stale_tle=tle_result["stale"],
    )


# ---------------------------------------------------------------------------
# Static File & Single Page Application Serving
# ---------------------------------------------------------------------------

@app.get("/", include_in_schema=False)
async def serve_index():
    """Serve the single-page application frontend."""
    index_file = FRONTEND_DIR / "index.html"
    if not index_file.is_file():
        raise HTTPException(status_code=404, detail="Frontend index.html not found")
    return FileResponse(index_file)


# Mount static subdirectories for CSS and JS assets
if (FRONTEND_DIR / "css").is_dir():
    app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")

if (FRONTEND_DIR / "js").is_dir():
    app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
