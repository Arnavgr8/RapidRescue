"""
Dispatch service: Haversine distance calculations, GPS staleness validation,
and atomic ambulance assignment.
Prototype demonstration only - not for real emergency dispatch.
"""
import math
import secrets
from datetime import datetime, timezone
from models import db, Ambulance, EmergencyRequest, DispatchAssignment, StatusAuditLog, utcnow

# Default GPS coordinates are considered stale if not refreshed within 300 seconds (5 minutes)
GPS_STALENESS_THRESHOLD_SECONDS = 300
AVERAGE_CITY_SPEED_KMH = 40.0


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate the great-circle distance between two points on Earth using the Haversine formula.
    Returns distance in kilometers.
    NOTE: Straight-line distance is distinct from real road distance.
    """
    R = 6371.0  # Earth's radius in kilometers

    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (math.sin(delta_phi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))

    return R * c


def estimate_straight_line_eta_minutes(distance_km: float) -> float:
    """
    Estimates travel time in minutes based on straight-line distance and an assumed average speed.
    Clearly distinct from verified road navigation or real traffic conditions.
    """
    if distance_km <= 0.05:
        return 1.0
    hours = distance_km / AVERAGE_CITY_SPEED_KMH
    return max(1.0, hours * 60.0)


def is_gps_fresh(last_gps_updated_at: datetime, max_age_seconds: int = GPS_STALENESS_THRESHOLD_SECONDS) -> bool:
    """Returns True if the GPS timestamp is within the freshness threshold."""
    if not last_gps_updated_at:
        return False
    age = (utcnow() - last_gps_updated_at).total_seconds()
    return age <= max_age_seconds


def generate_reference_no() -> str:
    """Generates a human-friendly tracking reference, e.g. RR-20261028-A4F9"""
    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    random_suffix = secrets.token_hex(2).upper()
    return f"RR-{date_str}-{random_suffix}"


def generate_tracking_token() -> str:
    """Generates an unguessable 32-byte secure URL-safe token."""
    return secrets.token_urlsafe(32)


def dispatch_nearest_ambulance(request_record: EmergencyRequest, max_gps_age_sec: int = GPS_STALENESS_THRESHOLD_SECONDS):
    """
    Selects and atomically reserves the nearest available ambulance.
    Enforces eligibility:
      - is_online == True
      - status == 'AVAILABLE'
      - current_latitude and current_longitude are not null
      - GPS timestamp is fresh (not stale)
    Returns:
      (ambulance, message)
    """
    # SQLite / SQLAlchemy atomic transaction
    # We query available online ambulances
    candidates = Ambulance.query.filter_by(is_online=True, status="AVAILABLE").all()

    eligible = []
    for amb in candidates:
        if amb.current_latitude is None or amb.current_longitude is None:
            continue
        if not is_gps_fresh(amb.last_gps_updated_at, max_gps_age_sec):
            continue
        dist = haversine_distance(
            request_record.latitude,
            request_record.longitude,
            amb.current_latitude,
            amb.current_longitude
        )
        eligible.append((dist, amb))

    if not eligible:
        request_record.status = "NO_AMBULANCE"
        audit = StatusAuditLog(
            entity_type="REQUEST",
            entity_id=request_record.id,
            old_status="PENDING",
            new_status="NO_AMBULANCE",
            reason="No eligible available ambulance found with fresh GPS"
        )
        db.session.add(audit)
        db.session.commit()
        return None, "NO_AMBULANCE_AVAILABLE"

    # Sort by straight-line Haversine distance ascending
    eligible.sort(key=lambda item: item[0])
    best_dist, selected_amb = eligible[0]

    # Re-verify availability inside transaction to prevent double assignment
    # in case of competing requests
    fresh_check = Ambulance.query.filter_by(id=selected_amb.id, status="AVAILABLE").with_for_update(nowait=False).first() \
        if hasattr(db.session, "query") else selected_amb
    
    if not fresh_check or fresh_check.status != "AVAILABLE":
        # Another request just claimed this unit, retry or reject
        return None, "CONCURRENT_ASSIGNMENT_COLLISION"

    # Reserve unit
    selected_amb.status = "BUSY"
    request_record.status = "ASSIGNED"
    request_record.assigned_ambulance_id = selected_amb.id
    request_record.straight_line_distance_km = best_dist
    request_record.estimated_straight_line_eta_minutes = estimate_straight_line_eta_minutes(best_dist)

    assignment = DispatchAssignment(
        request_id=request_record.id,
        ambulance_id=selected_amb.id,
        driver_id=selected_amb.driver.id if selected_amb.driver else None,
        status="DISPATCHED",
        initial_distance_km=best_dist,
        assigned_at=utcnow()
    )
    db.session.add(assignment)

    # Log status transitions
    db.session.add(StatusAuditLog(
        entity_type="AMBULANCE",
        entity_id=selected_amb.id,
        old_status="AVAILABLE",
        new_status="BUSY",
        reason=f"Assigned to emergency {request_record.reference_no}"
    ))
    db.session.add(StatusAuditLog(
        entity_type="REQUEST",
        entity_id=request_record.id,
        old_status="PENDING",
        new_status="ASSIGNED",
        reason=f"Dispatched ambulance {selected_amb.call_sign}"
    ))

    db.session.commit()
    return selected_amb, "ASSIGNED"

