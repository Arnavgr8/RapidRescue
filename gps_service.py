"""
GPS service: Coordinate validation, location history logging,
and explicitly labeled demo GPS simulation.
Prototype demonstration only - not for real emergency dispatch.
"""
from datetime import datetime
from models import db, Ambulance, AmbulanceLocationHistory, EmergencyRequest, DispatchAssignment, utcnow
from dispatch_service import haversine_distance, estimate_straight_line_eta_minutes, is_gps_fresh


def validate_coordinates(latitude: float, longitude: float) -> bool:
    """Validate that coordinates fall within standard geographic bounds."""
    try:
        lat = float(latitude)
        lon = float(longitude)
        if -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0:
            return True
        return False
    except (ValueError, TypeError):
        return False


def update_ambulance_location(
    ambulance: Ambulance,
    latitude: float,
    longitude: float,
    heading: float = 0.0,
    speed_kmh: float = 0.0,
    is_simulated: bool = False
):
    """
    Validates coordinates, updates the ambulance record, and appends to location history.
    Also recalculates straight-line distance if assigned to an active emergency.
    """
    if not validate_coordinates(latitude, longitude):
        raise ValueError(f"Invalid coordinates: lat={latitude}, lon={longitude}")

    ambulance.current_latitude = float(latitude)
    ambulance.current_longitude = float(longitude)
    ambulance.heading = float(heading or 0.0)
    ambulance.speed_kmh = float(speed_kmh or 0.0)
    ambulance.last_gps_updated_at = utcnow()
    ambulance.is_simulated_gps = bool(is_simulated)

    # Breadcrumb trail
    log = AmbulanceLocationHistory(
        ambulance_id=ambulance.id,
        latitude=ambulance.current_latitude,
        longitude=ambulance.current_longitude,
        heading=ambulance.heading,
        speed_kmh=ambulance.speed_kmh,
        recorded_at=ambulance.last_gps_updated_at,
        is_simulated=ambulance.is_simulated_gps
    )
    db.session.add(log)

    # If ambulance is on an active assignment, update the patient's remaining distance/ETA
    active_assignment = ambulance.assignments.filter(
        DispatchAssignment.status.in_(["DISPATCHED", "ACCEPTED", "EN_ROUTE", "ARRIVED"])
    ).order_by(db.desc(DispatchAssignment.id)).first()

    if active_assignment and active_assignment.request and active_assignment.request.status in ["ASSIGNED", "EN_ROUTE"]:
        req = active_assignment.request
        new_dist = haversine_distance(ambulance.current_latitude, ambulance.current_longitude, req.latitude, req.longitude)
        req.straight_line_distance_km = new_dist
        req.estimated_straight_line_eta_minutes = estimate_straight_line_eta_minutes(new_dist)

    db.session.commit()
    return ambulance


def step_simulated_gps_towards_patient(ambulance: Ambulance, step_factor: float = 0.25):
    """
    Demonstration helper: moves an ambulance 25% closer toward the assigned emergency request.
    This movement is ALWAYS explicitly tagged with is_simulated_gps = True.
    """
    # Find active assignment
    active_assignment = ambulance.assignments.filter(
        DispatchAssignment.status.in_(["DISPATCHED", "ACCEPTED", "EN_ROUTE", "ARRIVED"])
    ).order_by(db.desc(DispatchAssignment.id)).first()

    if not active_assignment or not active_assignment.request:
        return False, "Ambulance has no active emergency assignment to move toward."

    req = active_assignment.request
    current_lat = ambulance.current_latitude or req.latitude + 0.05
    current_lon = ambulance.current_longitude or req.longitude + 0.05

    dist = haversine_distance(current_lat, current_lon, req.latitude, req.longitude)

    if dist <= 0.05:
        # Reached patient pickup
        new_lat = req.latitude
        new_lon = req.longitude
        speed = 0.0
    else:
        # Move fraction towards patient
        new_lat = current_lat + (req.latitude - current_lat) * step_factor
        new_lon = current_lon + (req.longitude - current_lon) * step_factor
        speed = 45.0  # simulated 45 km/h

    update_ambulance_location(
        ambulance=ambulance,
        latitude=new_lat,
        longitude=new_lon,
        speed_kmh=speed,
        is_simulated=True
    )
    return True, "Simulated GPS step applied."


def get_driver_gps_status_label(ambulance: Ambulance) -> str:
    """
    Returns one of: 'ACTIVE', 'STALE', 'UNAVAILABLE', 'OFFLINE'.
    """
    if not ambulance.is_online:
        return "OFFLINE"
    if ambulance.current_latitude is None or ambulance.current_longitude is None:
        return "UNAVAILABLE"
    if is_gps_fresh(ambulance.last_gps_updated_at):
        return "ACTIVE"
    return "STALE"

