# 🛰️ Satellite Orbit Tracker

A high-performance real-time satellite tracking web application. Select any satellite (defaults to the **International Space Station**, NORAD ID `25544`) to view a photorealistic, rotating 3D Earth globe, live sub-satellite coordinates, forward azimuth heading, full Keplerian orbital elements, and altitude-over-time charts.

---

## ✨ Features

* **Interactive 3D Earth Globe**: Powered by [globe.gl](https://globe.gl/) (Three.js/WebGL), featuring high-resolution Blue Marble textures, atmospheric glow, and smooth orbital controls.
* **Real-Time SGP4 Orbit Propagation**: Computes precise sub-satellite geographic coordinates, ellipsoidal altitude, and orbital velocity vectors using [Skyfield](https://rhodesmill.org/skyfield/) and SGP4.
* **Full Ground Track Projection**: Displays the satellite's ground track, seamlessly handling anti-meridian wraps ($180^\circ$ longitude crossings).
* **Live Telemetry & Heading**: Telemetry updates every 3 seconds with instantaneous speed, altitude, and forward-azimuth heading with a 16-point compass rose (`NE`, `SW`, etc.).
* **Auto-Follow Camera**: Toggleable camera tracking follows the satellite across Earth.
* **Keplerian Orbital Elements**: Detailed panel displays inclination, eccentricity, RAAN, argument of perigee, mean anomaly, mean motion, orbital period, and $B^*$ drag term.
* **Educational Tooltips**: Interactive "i" icons provide beginner-friendly explanations for each orbital parameter.
* **Real-time Altitude Chart**: Altitude vs. time telemetry powered by Chart.js.
* **Resilient Caching & Offline Fallback**: File-based 2-hour caching with automatic fallback to stale data if CelesTrak is unreachable, accompanied by visual UI status badges (`LIVE`, `STALE`, `ERROR`).
* **Zero-Build Frontend**: Clean, pure vanilla HTML5, CSS3, and JavaScript—no Node.js build step or bundler needed.

---

## 🏗️ Architecture & How It Works

```
                        ┌────────────────────────┐
                        │   CelesTrak GP API     │
                        │ (OMM / JSON Ephemeris) │
                        └───────────┬────────────┘
                                    │ (2-hr Cache)
                                    ▼
                        ┌────────────────────────┐
                        │     tle_service.py     │
                        └───────────┬────────────┘
                                    │
                                    ▼
                        ┌────────────────────────┐
                        │     propagation.py     │
                        │   (Skyfield / SGP4)    │
                        └───────────┬────────────┘
                                    │ (WGS84 Subpoints)
                                    ▼
                        ┌────────────────────────┐
                        │    backend/main.py     │
                        │   (FastAPI REST API)   │
                        └───────────┬────────────┘
                                    │ JSON
                                    ▼
  ┌─────────────────────────────────┴─────────────────────────────────┐
  │                           Frontend                                │
  │   globe.gl (3D Earth)  │  panel.js (Telemetry)  │  Chart.js (Alt) │
  └───────────────────────────────────────────────────────────────────┘
```

1. **Ephemeris Ingestion**: The backend queries CelesTrak for General Perturbations (GP) data formatted as Orbit Mean-Elements Messages (OMM).
2. **Local Caching**: Data is cached in `backend/cache/` for 2 hours to respect upstream rate limits.
3. **SGP4 Propagation**: When a client requests telemetry, Skyfield evaluates SGP4 equations against the satellite's epoch, deriving geodetic latitude, longitude, and elevation on the WGS84 ellipsoid.
4. **Heading Calculation**: Computes the initial bearing between the current position and a forward position $+10\text{ seconds}$ in the future.
5. **Visualization**: The browser renders the satellite marker and ground track on the 3D globe and streams telemetry into the HUD.

---

## 🛠️ Tech Stack

### Backend
* **Python 3.10+**
* **[FastAPI](https://fastapi.tiangolo.com/)**: Asynchronous high-performance web framework.
* **[Skyfield](https://rhodesmill.org/skyfield/)**: Astronomy and satellite propagation library (powered by `sgp4`).
* **[Requests](https://requests.readthedocs.io/)**: HTTP client for CelesTrak GP API.
* **[Pydantic v2](https://docs.pydantic.dev/)**: Data validation and response schemas.
* **[Pytest](https://docs.pytest.org/)**: Comprehensive unit and integration test suite.
* **[Uvicorn](https://www.uvicorn.org/)**: Lightning-fast ASGI production server.

### Frontend
* **HTML5 / CSS3 / Vanilla JavaScript (ES6+)**: Zero build steps or bundlers required.
* **[globe.gl](https://globe.gl/)**: 3D globe visualization built on Three.js.
* **[Chart.js](https://www.chartjs.org/)**: Real-time altitude trend line chart.

### Data Source
* **[CelesTrak](https://celestrak.org/)**: Public GP API (no API key required).

---

## 📡 API Reference

| Method | Endpoint | Query Parameters | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | _None_ | Service health check and current server UTC timestamp. |
| `GET` | `/api/satellites` | _None_ | Returns list of curated satellites and constellation categories. |
| `GET` | `/api/position` | `sat` (int, default: `25544`) | Live position, speed, altitude, and heading for the given NORAD ID. |
| `GET` | `/api/track` | `sat` (int), `minutes` (int, default: `90`), `step` (int, default: `30`) | Array of ground track points centered on current time. |
| `GET` | `/api/elements` | `sat` (int, default: `25544`) | Parsed Keplerian orbital elements from the latest TLE. |

---

## 🧪 Running Tests

Execute the automated test suite with `pytest`:

```bash
pytest -v
```

This verifies:
1. SGP4 propagation accuracy, geodetic bounding boxes ($-90^\circ \le \text{lat} \le 90^\circ$, $-180^\circ \le \text{lon} \le 180^\circ$).
2. ISS physical bounds ($\sim 350\text{--}450\text{ km}$ altitude, $\sim 7.5\text{--}7.8\text{ km/s}$ velocity, $\sim 90\text{--}93\text{ min}$ period).
3. All FastAPI REST endpoints, mock error handling, and 404 responses.

## 🚀 Deploying on Render

This repository is a single FastAPI web service: `backend/main.py` serves both the API and the frontend files, so it does not need a separate static site or database. The root-level `render.yaml` records the production settings for the `main` branch. Its build command installs `requirements.txt`; its start command runs `uvicorn backend.main:app` on Render's assigned `$PORT`; and its health check uses `/api/health`.

If the existing Render service is not managed by a Blueprint, set these values in **Settings → Build & Deploy**:

| Setting | Value |
| --- | --- |
| Repository | `numa-here/satellite-orbit-tracker` |
| Branch | `main` |
| Root Directory | `.` (repository root) |
| Runtime | Python 3 |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn backend.main:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/api/health` |

Set `PYTHON_VERSION` to `3.13.5` in the service environment. No database or API key is required for the default CelesTrak catalog path; `KEEPTRACK_API_KEY` is optional. Never put a real key in `render.yaml` or commit it to Git. Render does not automatically apply a Blueprint file to a dashboard-managed service: connect or sync the Blueprint in Render, or enter the settings above in the existing service.

---

## 📁 Repository Structure

```
satellite-orbit-tracker/
├── README.md                 # Project documentation & quickstart
├── render.yaml               # Render Blueprint for the main FastAPI service
├── .gitignore                # Git exclusions
├── requirements.txt          # Python dependencies
├── .env.example              # Optional environment variables template
├── backend/
│   ├── __init__.py           # Python package marker
│   ├── main.py               # FastAPI application, API routes, and frontend host
│   ├── config.py             # Server constants and public data-source settings
│   ├── catalog_service.py    # Full catalog, upstream merge, cache, and fallback
│   ├── tle_service.py        # CelesTrak fetcher and disk caching
│   ├── propagation.py        # Skyfield / SGP4 orbital mechanics
│   ├── seed_data.py          # Bundled OMM fallback for popular satellites
│   └── schemas.py            # Pydantic response models
├── frontend/
│   ├── index.html            # Main web layout
│   ├── css/
│   │   └── style.css         # Space-themed responsive UI
│   └── js/
│       ├── api.js            # Same-origin asynchronous API client
│       ├── app.js            # Application bootstrap and polling loops
│       ├── catalog-ui.js     # Catalog search and filters
│       ├── globe.js          # 3D globe and interactive Earth fallback
│       ├── panel.js          # Telemetry, time controls, and charts
│       └── workers/
│           └── satellite-worker.js # Client-side satellite propagation
├── tests/
│   ├── __init__.py           # Package marker
│   ├── test_propagation.py   # SGP4 propagation unit tests
│   ├── test_catalog_merge.py # Catalog merge and deduplication tests
│   └── test_api.py           # FastAPI integration tests
├── scripts/
│   └── check_secrets.sh      # Secret scanning helper
└── docs/
    └── ABOUT.md              # In-depth orbital mechanics reference
```

---

## ⚠️ Known Limitations

1. **TLE Age & Accuracy Decay**: TLEs are mean element sets. Atmospheric drag and solar activity cause predictions to degrade over time. Accuracy begins to drop significantly after $\approx 7\text{ days}$. The app highlights stale data with a warning flag.
2. **CelesTrak Rate Limiting**: CelesTrak is an open academic resource. Aggressive scraping may cause temporary IP bans; our built-in 2-hour file cache prevents spamming upstream endpoints.
3. **LEO / Near-Earth Focus**: SGP4 is optimized for Earth satellites ($e < 1$). It is not designed for interplanetary or parabolic trajectories.

---

## 🔮 Future Enhancements

* **Ground Station Pass Predictions**: Compute upcoming line-of-sight passes, rise/culmination/set times, and azimuth/elevation for user coordinates.
* **Multi-Satellite Constellation View**: Render entire constellations simultaneously (e.g. Starlink, GPS, Iridium).
* **Day/Night Terminator**: Render realistic sunlight shading with dynamic day/night boundary.
* **Radio Footprint Cone**: Display satellite line-of-sight communication horizon on the globe surface.
* **WebSocket Telemetry Streaming**: Low-latency bi-directional push instead of periodic HTTP polling.

---

## 📄 License

This project is licensed under the MIT License.
