"""
Pydantic models (schemas) for typed API requests and responses.

Provides validation, serialization, and OpenAPI / Swagger documentation.
"""
from __future__ import annotations

from typing import List, Optional
from pydantic import BaseModel, Field


# ---- Satellite Catalogue Schemas ------------------------------------------

class SatelliteInfo(BaseModel):
    """Metadata for a satellite in the catalog dropdown."""
    name: str = Field(..., description="Display name of the satellite")
    norad_id: int = Field(..., description="NORAD catalog identifier")
    group: Optional[str] = Field(None, description="Category / constellation name")


class GroupInfo(BaseModel):
    """Metadata for a group of satellites."""
    name: str = Field(..., description="Human-friendly group label")
    group: str = Field(..., description="CelesTrak GROUP code, e.g. 'stations'")


class SatelliteListResponse(BaseModel):
    """Response returned by GET /api/satellites."""
    satellites: List[SatelliteInfo]
    groups: List[GroupInfo]


# ---- Position Schemas -----------------------------------------------------

class PositionResponse(BaseModel):
    """Current geographic position, velocity, and orientation of a satellite."""
    name: str = Field(..., description="Satellite name")
    norad_id: int = Field(..., description="NORAD catalog number")
    latitude: float = Field(..., description="Sub-satellite geodetic latitude in degrees [-90, +90]")
    longitude: float = Field(..., description="Sub-satellite geodetic longitude in degrees [-180, +180]")
    altitude_km: float = Field(..., description="Ellipsoidal altitude above sea level in kilometers")
    velocity_km_s: float = Field(..., description="Total orbital speed in kilometers per second")
    heading_degrees: float = Field(..., description="Forward azimuth direction of travel in degrees [0, 360)")
    direction: str = Field(..., description="16-point compass label (e.g. 'NE', 'SSW')")
    utc_time: str = Field(..., description="UTC calculation timestamp in ISO-8601 format")
    tle_epoch: str = Field(..., description="UTC reference epoch of the TLE orbital elements")
    tle_age_days: float = Field(..., description="Age of the TLE in days relative to calculation time")
    stale_tle: bool = Field(False, description="True if data was served from stale cache or is > 7 days old")
    stale_warning: Optional[str] = Field(None, description="Warning message when TLE is older than 7 days")
    cached: bool = Field(False, description="True if served from the local file cache")


# ---- Ground Track Schemas -------------------------------------------------

class TrackPoint(BaseModel):
    """A single point along the satellite ground track."""
    latitude: float = Field(..., description="Geodetic latitude in degrees")
    longitude: float = Field(..., description="Geodetic longitude in degrees")
    altitude_km: float = Field(..., description="Altitude in kilometers")
    utc_time: str = Field(..., description="UTC timestamp of the point")


class TrackResponse(BaseModel):
    """Response returned by GET /api/track."""
    name: str = Field(..., description="Satellite name")
    norad_id: int = Field(..., description="NORAD catalog number")
    points: List[TrackPoint] = Field(..., description="Sequential list of track coordinates")
    stale_tle: bool = Field(False, description="Indicates if source TLE was stale")


# ---- Orbital Elements Schemas ---------------------------------------------

class OrbitalElementsResponse(BaseModel):
    """Parsed Keplerian orbital elements from the TLE / OMM dataset."""
    name: str = Field(..., description="Satellite name")
    norad_id: int = Field(..., description="NORAD catalog number")
    epoch: str = Field(..., description="UTC timestamp of the element set epoch")
    inclination_deg: float = Field(..., description="Orbital inclination in degrees relative to equator")
    eccentricity: float = Field(..., description="Orbital eccentricity (0 = circular)")
    raan_deg: float = Field(..., description="Right Ascension of Ascending Node in degrees")
    arg_of_perigee_deg: float = Field(..., description="Argument of perigee in degrees")
    mean_anomaly_deg: float = Field(..., description="Mean anomaly at epoch in degrees")
    mean_motion_rev_per_day: float = Field(..., description="Mean motion in revolutions per solar day")
    orbital_period_minutes: float = Field(..., description="Calculated orbital period (1440 / mean_motion)")
    bstar: float = Field(..., description="SGP4 aerodynamic drag term B*")
    stale_tle: bool = Field(False, description="True if TLE data is stale")


# ---- Diagnostic & Error Schemas -------------------------------------------

class ErrorResponse(BaseModel):
    """Standardized error response."""
    error: str = Field(..., description="Error message description")
    detail: Optional[str] = Field(None, description="Detailed traceback or explanation")


class HealthResponse(BaseModel):
    """Response returned by GET /api/health."""
    status: str = Field("ok", description="Server status")
    timestamp: str = Field(..., description="Current UTC timestamp")
