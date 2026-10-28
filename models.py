"""
Database models for RapidRescue ambulance dispatch system.
Prototype demonstration only - not for real emergency dispatch.
"""
from datetime import datetime, timezone
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


def utcnow():
    """Helper to return naive UTC datetime."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Ambulance(db.Model):
    __tablename__ = "ambulances"

    id = db.Column(db.Integer, primary_key=True)
    call_sign = db.Column(db.String(30), unique=True, nullable=False, index=True)
    vehicle_plate = db.Column(db.String(30), nullable=False)
    # Status: 'AVAILABLE', 'BUSY', 'OFFLINE'
    status = db.Column(db.String(20), nullable=False, default="OFFLINE", index=True)
    is_online = db.Column(db.Boolean, default=False, nullable=False)
    
    # Latest GPS coordinates
    current_latitude = db.Column(db.Float, nullable=True)
    current_longitude = db.Column(db.Float, nullable=True)
    heading = db.Column(db.Float, default=0.0)
    speed_kmh = db.Column(db.Float, default=0.0)
    last_gps_updated_at = db.Column(db.DateTime, nullable=True)
    is_simulated_gps = db.Column(db.Boolean, default=False, nullable=False)

    driver = db.relationship("Driver", back_populates="ambulance", uselist=False)
    assignments = db.relationship("DispatchAssignment", back_populates="ambulance", lazy="dynamic")
    location_history = db.relationship("AmbulanceLocationHistory", back_populates="ambulance", lazy="dynamic")

    def to_dict(self):
        active_assignment = self.assignments.filter(
            DispatchAssignment.status.in_(["DISPATCHED", "ACCEPTED", "EN_ROUTE", "ARRIVED"])
        ).order_by(DispatchAssignment.id.desc()).first()

        return {
            "id": self.id,
            "call_sign": self.call_sign,
            "vehicle_plate": self.vehicle_plate,
            "status": self.status,
            "is_online": self.is_online,
            "current_latitude": self.current_latitude,
            "current_longitude": self.current_longitude,
            "heading": self.heading,
            "speed_kmh": self.speed_kmh,
            "last_gps_updated_at": self.last_gps_updated_at.isoformat() if self.last_gps_updated_at else None,
            "is_simulated_gps": self.is_simulated_gps,
            "driver_name": self.driver.name if self.driver else "Unassigned",
            "active_assignment": {
                "id": active_assignment.id,
                "reference_no": active_assignment.request.reference_no,
                "pickup_address": active_assignment.request.pickup_address,
                "patient_latitude": active_assignment.request.latitude,
                "patient_longitude": active_assignment.request.longitude,
                "status": active_assignment.status
            } if active_assignment and active_assignment.request else None
        }


class Driver(db.Model):
    __tablename__ = "drivers"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    badge_number = db.Column(db.String(30), unique=True, nullable=False, index=True)
    phone = db.Column(db.String(30), nullable=False)
    pin = db.Column(db.String(30), nullable=False, default="1234")
    
    ambulance_id = db.Column(db.Integer, db.ForeignKey("ambulances.id"), unique=True, nullable=True)
    ambulance = db.relationship("Ambulance", back_populates="driver")
    assignments = db.relationship("DispatchAssignment", back_populates="driver", lazy="dynamic")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "badge_number": self.badge_number,
            "phone": self.phone,
            "ambulance_id": self.ambulance_id,
            "ambulance_call_sign": self.ambulance.call_sign if self.ambulance else None,
        }


class EmergencyRequest(db.Model):
    __tablename__ = "emergency_requests"

    id = db.Column(db.Integer, primary_key=True)
    # Human-readable reference e.g. RR-20261028-A4F9
    reference_no = db.Column(db.String(50), unique=True, nullable=False, index=True)
    # Unguessable secure token for patient tracking without login
    tracking_token = db.Column(db.String(80), unique=True, nullable=False, index=True)
    
    patient_name = db.Column(db.String(100), nullable=False)
    contact_phone = db.Column(db.String(30), nullable=False)
    pickup_address = db.Column(db.String(255), nullable=False)
    latitude = db.Column(db.Float, nullable=False)
    longitude = db.Column(db.Float, nullable=False)
    emergency_notes = db.Column(db.Text, nullable=True)
    
    # Request status: 'PENDING', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'COMPLETED', 'CANCELLED', 'NO_AMBULANCE'
    status = db.Column(db.String(30), default="PENDING", nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    
    assigned_ambulance_id = db.Column(db.Integer, db.ForeignKey("ambulances.id"), nullable=True)
    assigned_ambulance = db.relationship("Ambulance")
    
    # Clearly distinct straight-line distance and ETA estimate
    straight_line_distance_km = db.Column(db.Float, nullable=True)
    estimated_straight_line_eta_minutes = db.Column(db.Float, nullable=True)

    dispatch_assignment = db.relationship("DispatchAssignment", back_populates="request", uselist=False)

    def to_public_dict(self):
        """Sanitized dictionary for patient tracking - NEVER exposes phone number or raw driver secrets."""
        amb = self.assigned_ambulance
        return {
            "reference_no": self.reference_no,
            "tracking_token": self.tracking_token,
            "status": self.status,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "pickup_address": self.pickup_address,
            "patient_latitude": self.latitude,
            "patient_longitude": self.longitude,
            "straight_line_distance_km": round(self.straight_line_distance_km, 2) if self.straight_line_distance_km is not None else None,
            "estimated_straight_line_eta_minutes": round(self.estimated_straight_line_eta_minutes, 1) if self.estimated_straight_line_eta_minutes is not None else None,
            "eta_disclaimer": "Straight-line estimate only (not verified road navigation).",
            "assigned_ambulance": {
                "id": amb.id,
                "call_sign": amb.call_sign,
                "vehicle_plate": amb.vehicle_plate,
                "status": amb.status,
                "current_latitude": amb.current_latitude,
                "current_longitude": amb.current_longitude,
                "heading": amb.heading,
                "speed_kmh": amb.speed_kmh,
                "last_gps_updated_at": amb.last_gps_updated_at.isoformat() if amb.last_gps_updated_at else None,
                "is_simulated_gps": amb.is_simulated_gps,
                "driver_name": amb.driver.name if amb.driver else "Ambulance Driver",
            } if amb else None
        }


class DispatchAssignment(db.Model):
    __tablename__ = "dispatch_assignments"

    id = db.Column(db.Integer, primary_key=True)
    request_id = db.Column(db.Integer, db.ForeignKey("emergency_requests.id"), nullable=False, unique=True)
    ambulance_id = db.Column(db.Integer, db.ForeignKey("ambulances.id"), nullable=False)
    driver_id = db.Column(db.Integer, db.ForeignKey("drivers.id"), nullable=True)

    # Assignment status: 'DISPATCHED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'COMPLETED', 'CANCELLED'
    status = db.Column(db.String(30), default="DISPATCHED", nullable=False, index=True)
    
    assigned_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    accepted_at = db.Column(db.DateTime, nullable=True)
    arrived_at = db.Column(db.DateTime, nullable=True)
    completed_at = db.Column(db.DateTime, nullable=True)
    
    initial_distance_km = db.Column(db.Float, nullable=True)

    request = db.relationship("EmergencyRequest", back_populates="dispatch_assignment")
    ambulance = db.relationship("Ambulance", back_populates="assignments")
    driver = db.relationship("Driver", back_populates="assignments")

    def to_dict(self):
        return {
            "id": self.id,
            "request_id": self.request_id,
            "request_ref": self.request.reference_no if self.request else None,
            "ambulance_call_sign": self.ambulance.call_sign if self.ambulance else None,
            "driver_name": self.driver.name if self.driver else None,
            "status": self.status,
            "assigned_at": self.assigned_at.isoformat() if self.assigned_at else None,
            "accepted_at": self.accepted_at.isoformat() if self.accepted_at else None,
            "arrived_at": self.arrived_at.isoformat() if self.arrived_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "pickup_address": self.request.pickup_address if self.request else None,
            "patient_latitude": self.request.latitude if self.request else None,
            "patient_longitude": self.request.longitude if self.request else None,
            "emergency_notes": self.request.emergency_notes if self.request else None,
        }


class AmbulanceLocationHistory(db.Model):
    __tablename__ = "ambulance_location_history"

    id = db.Column(db.Integer, primary_key=True)
    ambulance_id = db.Column(db.Integer, db.ForeignKey("ambulances.id"), nullable=False, index=True)
    latitude = db.Column(db.Float, nullable=False)
    longitude = db.Column(db.Float, nullable=False)
    heading = db.Column(db.Float, default=0.0)
    speed_kmh = db.Column(db.Float, default=0.0)
    recorded_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    is_simulated = db.Column(db.Boolean, default=False, nullable=False)

    ambulance = db.relationship("Ambulance", back_populates="location_history")


class StatusAuditLog(db.Model):
    __tablename__ = "status_audit_logs"

    id = db.Column(db.Integer, primary_key=True)
    entity_type = db.Column(db.String(30), nullable=False, index=True)  # 'AMBULANCE', 'REQUEST', 'ASSIGNMENT'
    entity_id = db.Column(db.Integer, nullable=False, index=True)
    old_status = db.Column(db.String(30), nullable=True)
    new_status = db.Column(db.String(30), nullable=False)
    reason = db.Column(db.String(255), nullable=True)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

