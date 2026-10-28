# RapidRescue — Ambulance Dispatch & GPS Tracking Prototype

> **DISCLAIMER:** RapidRescue is an MVP developed for an ideathon demonstration. It is **NOT** intended or suitable for real-world emergency operations.

---

## 1. Product Overview

RapidRescue is a full-stack emergency response prototype designed to solve critical delays in emergency dispatching:
- **Public Patient Portal**: Patients can request emergency assistance **without logging in or creating an account**. They can capture their browser GPS or choose a preset location, submit the request, and track their assigned unit live on an interactive Leaflet map.
- **Driver Dashboard**: Authenticated driver session where drivers can toggle **Go Online / Go Offline**, stream GPS coordinates (live or simulated), accept assignments, mark arrival, and complete trips. Server enforces that busy drivers cannot be double-assigned.
- **Dispatch Backend**: Flask + SQLAlchemy + SQLite architecture that automatically selects the nearest eligible ambulance using the **Haversine formula**, verifies **GPS coordinate freshness**, transactionally reserves the ambulance, and exposes live REST polling endpoints protected by unguessable tracking tokens.

---

## 2. Key Architecture & Features

### Public Patient Interface
- **Zero Login Friction**: Immediate emergency dispatch without signup or password.
- **Location Capture**: HTML5 Geolocation API with manual latitude/longitude fallback and quick preset buttons.
- **Live Leaflet Tracking**: Displays patient location, assigned ambulance vehicle marker, and straight-line trajectory.
- **Secure Token Protection**: Patient tracking pages (`/track/<ref>?token=<token>`) are protected by cryptographically unguessable tokens (`secrets.token_urlsafe(32)`). Public APIs **never** expose all patient emergencies or private phone numbers.
- **No Page Reloads**: Asynchronous polling every 3 seconds updates unit coordinates, distance, and mission stages seamlessly.

### Driver Interface
- **Controlled Demo Access**: Seeded demo drivers with PIN authentication (`Alex Morgan - DRV-101`, `Sarah Chen - DRV-102`, `James Wilson - DRV-103`).
- **Fleet Availability**: Go Online / Go Offline switch. Server strictly prevents going offline while actively engaged on an emergency call.
- **GPS Status Reporting**: Visual indicators for `ACTIVE`, `DENIED`, `STALE`, and `OFFLINE` GPS states.
- **State Machine Progression**: Sequential server-validated state changes:
  1. `DISPATCHED` ➔ `ACCEPTED` (Request becomes `EN_ROUTE`)
  2. `ACCEPTED` ➔ `ARRIVED` (Request becomes `ARRIVED`)
  3. `ARRIVED` ➔ `COMPLETED` (Request becomes `COMPLETED`, unit returns to `AVAILABLE`)
- **Demo Movement Stepper**: Allows simulating vehicle movement in 25% increments towards the patient for reproducible evaluations.

### Dispatch Backend & Algorithms
- **Haversine Distance**: Straight-line geographic distance calculated in kilometers.
- **Distinct Straight-line ETA**: Estimated travel times are explicitly documented and labeled as straight-line estimates (based on assumed city transit speeds), strictly distinct from verified road navigation.
- **GPS Staleness Detection**: Coordinates older than 300 seconds (5 minutes) are deemed stale and disqualified from automatic dispatch.
- **Atomic Reservation**: SQLite transactions ensure competing emergency requests cannot claim the same ambulance simultaneously.
- **Clear Failure Handling**: If no eligible units are online or within fresh GPS limits, the system returns an explicit `NO_AMBULANCE_AVAILABLE` status.

---

## 3. Directory Structure

```
Ideathon/
├── app.py                     # Main Flask application and REST routes
├── models.py                  # SQLAlchemy models (Ambulance, Driver, EmergencyRequest, etc.)
├── dispatch_service.py        # Haversine distance, staleness checks, atomic assignment
├── gps_service.py             # Coordinate validation, location history, simulation stepper
├── requirements.txt           # Python dependencies
├── .env.example               # Environment configuration template
├── .gitignore                 # Git ignore rules
├── templates/
│   ├── base.html              # Dark navy master layout with Leaflet CDN
│   ├── request.html           # Public patient request page
│   ├── track.html             # Patient live tracking map with auto-polling
│   ├── unauthorized_tracking.html # Guard screen when token is invalid
│   ├── driver_login.html      # Driver session portal
│   ├── driver_dashboard.html  # Driver control dashboard
│   ├── dispatch_overview.html # Fleet status and demo console
│   ├── about.html             # About project page
│   └── 404.html               # 404 error page
├── static/
│   ├── css/
│   │   └── style.css          # Dark navy theme with high-contrast status accents
│   └── js/
│       ├── request.js         # Patient GPS capture & async submission
│       ├── track.js           # Live polling and Leaflet tracking
│       ├── driver.js          # Driver GPS publishing & action controls
│       ├── dispatch.js        # Fleet console map and demo resets
│       └── main.js            # General utilities
└── tests/
    └── test_dispatch.py       # Pytest suite covering all 9 required scenarios
```

---

## 4. Setup & Installation

### Requirements
- Python 3.10+
- Modern Web Browser (Chrome, Firefox, Edge, Safari)

### 1. Install Dependencies
```bash
pip install -r requirements.txt
```

### 2. Run Automated Tests
```bash
python -m pytest -v
```
All 9 test scenarios test:
1. Patient submits request without logging in.
2. Graceful rejection when no eligible ambulance is available.
3. Selection of next available ambulance when the closest unit is offline.
4. Exclusion of units with stale GPS coordinates (> 300s).
5. Concurrency protection when two requests compete for one ambulance.
6. Driver toggles online and offline.
7. Location updates and location history tracking.
8. Patient tracking updates via polling without page reload.
9. Driver completes trip and returns unit to `AVAILABLE`.

### 3. Start Application
```bash
python app.py
```
Open your browser at:
- **Patient Portal & Live Tracker:** [http://127.0.0.1:5000/](http://127.0.0.1:5000/)
- **Driver Portal & GPS Broadcaster:** [http://127.0.0.1:5000/driver](http://127.0.0.1:5000/driver)
- **Central Fleet Overview:** [http://127.0.0.1:5000/dispatch](http://127.0.0.1:5000/dispatch)

---

## 5. Required Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/ambulances/<id>/location` | Broadcasts driver GPS or simulated demo coordinates (every 5s). |
| `POST` | `/api/ambulances/<id>/online` | Marks ambulance online & available. |
| `POST` | `/api/ambulances/<id>/offline` | Marks ambulance offline (prevented if currently busy on a call). |
| `POST` | `/api/emergencies` | Public emergency request with latitude/longitude; auto-dispatches nearest unit. |
| `GET` | `/api/track/<tracking_token>` | Unguessable token lookup returning sanitized live coordinates and status. |
| `GET` | `/driver` | Direct driver availability and GPS broadcasting interface. |
| `GET` | `/` | Patient request form and embedded live tracking map. |

---

## 6. Demo Walkthrough for Evaluators

1. **Request an Ambulance as Patient**:
   - Go to `http://127.0.0.1:5000/`.
   - Click one of the test preset buttons (e.g. *Central Metro*) or use *📍 Use My Location*.
   - Click **🚨 Dispatch Nearest Ambulance Now**.
   - The view automatically switches to the live Leaflet map tracker showing the patient pin and assigned ambulance marker!
   - Polling runs automatically every 5 seconds without reloading the page.

2. **Operate as Driver**:
   - In another tab, open `http://127.0.0.1:5000/driver`.
   - Enter or select ambulance (e.g. `1: MED-101`) and click **🟢 Go Online**.
   - Browser GPS or demo simulated coordinates begin broadcasting every 5 seconds.
   - When an emergency is assigned, the Active Emergency Assignment card appears.
   - Click **Mark Arrived** and **Complete Trip** to finish the mission and release the unit back to `AVAILABLE`.


