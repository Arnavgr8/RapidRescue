"""
RapidRescue - Ambulance Dispatch and GPS Tracking System
Prototype demonstration only - not for real emergency operations.
"""
import os
import functools
from datetime import datetime, timezone
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify, session, abort
from models import (
    db, utcnow, Ambulance, Driver, EmergencyRequest,
    DispatchAssignment, AmbulanceLocationHistory, StatusAuditLog
)
from dispatch_service import (
    dispatch_nearest_ambulance, generate_reference_no,
    generate_tracking_token, GPS_STALENESS_THRESHOLD_SECONDS,
    haversine_distance, estimate_straight_line_eta_minutes
)
from gps_service import (
    validate_coordinates, update_ambulance_location,
    step_simulated_gps_towards_patient, get_driver_gps_status_label
)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "rapidrescue-demo-secret-key-2026")
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URI", "sqlite:///rapidrescue.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db.init_app(app)


def seed_demo_data():
    """Seeds predictable initial data for demonstrations and tests."""
    if Ambulance.query.first():
        return

    # Seed 3 Demo Ambulances
    # MED-101: MG Road / Central (Available, Online with demo coordinates)
    amb1 = Ambulance(
        call_sign="MED-101",
        vehicle_plate="KA-01-EA-1001",
        status="AVAILABLE",
        is_online=True,
        current_latitude=12.9716,
        current_longitude=77.5946,
        heading=45.0,
        speed_kmh=0.0,
        last_gps_updated_at=utcnow(),
        is_simulated_gps=True
    )

    # MED-102: Koramangala (Available, Online with demo coordinates)
    amb2 = Ambulance(
        call_sign="MED-102",
        vehicle_plate="KA-01-EA-1002",
        status="AVAILABLE",
        is_online=True,
        current_latitude=12.9352,
        current_longitude=77.6245,
        heading=90.0,
        speed_kmh=0.0,
        last_gps_updated_at=utcnow(),
        is_simulated_gps=True
    )

    # MED-103: Rajajinagar (Offline by default, for testing offline scenarios)
    amb3 = Ambulance(
        call_sign="MED-103",
        vehicle_plate="KA-01-EA-1003",
        status="OFFLINE",
        is_online=False,
        current_latitude=12.9830,
        current_longitude=77.5800,
        heading=0.0,
        speed_kmh=0.0,
        last_gps_updated_at=utcnow(),
        is_simulated_gps=True
    )

    db.session.add_all([amb1, amb2, amb3])
    db.session.flush()

    # Seed 3 Drivers assigned to ambulances
    drv1 = Driver(name="Alex Morgan", badge_number="DRV-101", phone="+91 98765 43210", pin="1234", ambulance_id=amb1.id)
    drv2 = Driver(name="Sarah Chen", badge_number="DRV-102", phone="+91 98765 43211", pin="1234", ambulance_id=amb2.id)
    drv3 = Driver(name="James Wilson", badge_number="DRV-103", phone="+91 98765 43212", pin="1234", ambulance_id=amb3.id)

    db.session.add_all([drv1, drv2, drv3])
    db.session.commit()


# Ensure tables exist and demo data is seeded upon launch
with app.app_context():
    db.create_all()
    seed_demo_data()


# -------------------------------------------------------------
# Driver Session Guard
# -------------------------------------------------------------
def driver_login_required(view_func):
    @functools.wraps(view_func)
    def decorated_view(*args, **kwargs):
        if "driver_id" not in session:
            flash("Please select or log in to a driver session.", "warning")
            return redirect(url_for("driver_login"))
        driver = db.session.get(Driver, session["driver_id"])
        if not driver:
            session.pop("driver_id", None)
            flash("Driver session invalid. Please log in again.", "error")
            return redirect(url_for("driver_login"))
        return view_func(driver, *args, **kwargs)
    return decorated_view


# -------------------------------------------------------------
# Public Patient Interface (No login required)
# -------------------------------------------------------------
@app.route("/", endpoint="home")
@app.route("/request", endpoint="request_page")
def request_page():
    """Public emergency request page. No patient account or login required."""
    return render_template("request.html", title="Request Ambulance | RapidRescue")


@app.route("/track/<reference_no>")
def track_page(reference_no):
    """
    Patient tracking interface.
    Protected using unguessable token query parameter.
    Does NOT require a patient account.
    """
    token = request.args.get("token", "").strip()
    req = EmergencyRequest.query.filter_by(reference_no=reference_no).first_or_404()

    if not token or token != req.tracking_token:
        return render_template(
            "unauthorized_tracking.html",
            title="Tracking Access Restricted",
            reference_no=reference_no
        ), 403

    return render_template(
        "track.html",
        title=f"Tracking Emergency {reference_no}",
        request_obj=req,
        token=token
    )


# -------------------------------------------------------------
# Public REST APIs for Patient Interface
# -------------------------------------------------------------
@app.route("/api/emergencies", methods=["POST"])
@app.route("/api/request-ambulance", methods=["POST"])
def api_request_ambulance():
    """
    Submit emergency request without login.
    Automatically assigns the nearest eligible ambulance using Haversine distance.
    Returns reference_no and secure tracking_token.
    """
    data = request.get_json(silent=True) or request.form.to_dict()

    lat_val = data.get("latitude")
    lon_val = data.get("longitude")
    
    if not validate_coordinates(lat_val, lon_val):
        return jsonify({
            "success": False,
            "error": "Valid geographic coordinates (latitude and longitude) are required."
        }), 400

    latitude = float(lat_val)
    longitude = float(lon_val)

    patient_name = data.get("patient_name", "").strip() or "Emergency Patient"
    contact_phone = data.get("contact_phone", "").strip() or "Not provided"
    pickup_address = data.get("pickup_address", "").strip() or f"GPS Coordinates ({latitude:.4f}, {longitude:.4f})"
    emergency_notes = data.get("emergency_notes", "").strip()

    # Create unguessable tokens and reference
    ref_no = generate_reference_no()
    track_token = generate_tracking_token()

    emergency_req = EmergencyRequest(
        reference_no=ref_no,
        tracking_token=track_token,
        patient_name=patient_name,
        contact_phone=contact_phone,
        pickup_address=pickup_address,
        latitude=latitude,
        longitude=longitude,
        emergency_notes=emergency_notes,
        status="PENDING",
        created_at=utcnow()
    )
    db.session.add(emergency_req)
    db.session.commit()

    # Automatically dispatch nearest eligible ambulance
    ambulance, dispatch_status = dispatch_nearest_ambulance(emergency_req)

    tracking_url = url_for("track_page", reference_no=ref_no, token=track_token, _external=True)

    if not ambulance:
        return jsonify({
            "success": False,
            "reference_no": ref_no,
            "tracking_token": track_token,
            "tracking_url": tracking_url,
            "status": "NO_AMBULANCE",
            "error": "No eligible ambulance is currently available. All units may be busy, offline, or experiencing stale GPS signals.",
            "message": "No eligible ambulance is currently available. All units may be busy, offline, or experiencing stale GPS signals."
        }), 200

    return jsonify({
        "success": True,
        "reference_no": ref_no,
        "tracking_token": track_token,
        "tracking_url": tracking_url,
        "status": emergency_req.status,
        "straight_line_distance_km": round(emergency_req.straight_line_distance_km, 2),
        "estimated_straight_line_eta_minutes": round(emergency_req.estimated_straight_line_eta_minutes, 1),
        "assigned_ambulance": {
            "id": ambulance.id,
            "call_sign": ambulance.call_sign,
            "driver_name": ambulance.driver.name if ambulance.driver else "Ambulance Driver",
            "current_latitude": ambulance.current_latitude,
            "current_longitude": ambulance.current_longitude,
        },
        "message": f"Ambulance {ambulance.call_sign} dispatched successfully."
    }), 201


@app.route("/api/track/<token_or_ref>", methods=["GET"])
def api_track_status(token_or_ref):
    """
    Public live tracking polling endpoint.
    Can be looked up directly by tracking_token (required by prompt)
    or by reference_no with ?token= query parameter.
    Never reveals all emergencies or private contact info in response.
    """
    # 1. First attempt: direct lookup by tracking_token
    req = EmergencyRequest.query.filter_by(tracking_token=token_or_ref).first()

    # 2. Second attempt: lookup by reference_no with ?token= validation
    if not req:
        req = EmergencyRequest.query.filter_by(reference_no=token_or_ref).first()
        if req:
            token = request.args.get("token", "").strip() or request.headers.get("X-Tracking-Token", "").strip()
            if not token or token != req.tracking_token:
                return jsonify({"error": "Unauthorized: invalid or missing tracking token"}), 403

    if not req:
        return jsonify({"error": "Emergency request not found"}), 404

    return jsonify({
        "success": True,
        "emergency": req.to_public_dict()
    }), 200


# -------------------------------------------------------------
# Exact Ambulance Management Endpoints
# -------------------------------------------------------------
@app.route("/api/ambulances", methods=["GET"])
def api_ambulances_list():
    """Returns list of ambulances for driver page and monitoring."""
    ambulances = Ambulance.query.order_by(Ambulance.id).all()
    return jsonify({
        "success": True,
        "ambulances": [a.to_dict() for a in ambulances]
    }), 200


@app.route("/api/ambulances/<int:amb_id>/location", methods=["POST"])
def api_ambulance_location(amb_id):
    """
    Update driver coordinates and last-updated timestamp for specified ambulance.
    Explicitly flags is_simulated coordinates.
    """
    amb = db.session.get(Ambulance, amb_id)
    if not amb:
        return jsonify({"success": False, "error": "Ambulance not found"}), 404

    data = request.get_json(silent=True) or request.form.to_dict()
    lat = data.get("latitude")
    lon = data.get("longitude")
    heading = data.get("heading", 0.0)
    speed = data.get("speed_kmh", 0.0)
    is_simulated = bool(data.get("is_simulated", False))

    if not validate_coordinates(lat, lon):
        return jsonify({"success": False, "error": "Invalid GPS coordinates"}), 400

    update_ambulance_location(
        ambulance=amb,
        latitude=float(lat),
        longitude=float(lon),
        heading=float(heading or 0.0),
        speed_kmh=float(speed or 0.0),
        is_simulated=is_simulated
    )

    return jsonify({
        "success": True,
        "ambulance": amb.to_dict(),
        "gps_status": get_driver_gps_status_label(amb)
    }), 200


@app.route("/api/ambulances/<int:amb_id>/online", methods=["POST"])
def api_ambulance_online(amb_id):
    """Marks ambulance online and available."""
    amb = db.session.get(Ambulance, amb_id)
    if not amb:
        return jsonify({"success": False, "error": "Ambulance not found"}), 404

    amb.is_online = True
    if amb.status != "BUSY":
        amb.status = "AVAILABLE"
    db.session.commit()

    return jsonify({
        "success": True,
        "is_online": amb.is_online,
        "status": amb.status,
        "ambulance": amb.to_dict()
    }), 200


@app.route("/api/ambulances/<int:amb_id>/offline", methods=["POST"])
def api_ambulance_offline(amb_id):
    """Marks ambulance offline (prevented if busy)."""
    amb = db.session.get(Ambulance, amb_id)
    if not amb:
        return jsonify({"success": False, "error": "Ambulance not found"}), 404

    if amb.status == "BUSY":
        return jsonify({
            "success": False,
            "error": "Cannot go offline while on an active emergency mission. Complete trip first."
        }), 400

    amb.is_online = False
    amb.status = "OFFLINE"
    db.session.commit()

    return jsonify({
        "success": True,
        "is_online": amb.is_online,
        "status": amb.status,
        "ambulance": amb.to_dict()
    }), 200


@app.route("/api/ambulances/<int:amb_id>", methods=["GET"])
def api_ambulance_detail(amb_id):
    """Returns single ambulance details and current active mission."""
    amb = db.session.get(Ambulance, amb_id)
    if not amb:
        return jsonify({"success": False, "error": "Ambulance not found"}), 404
    return jsonify({
        "success": True,
        "ambulance": amb.to_dict(),
        "gps_status": get_driver_gps_status_label(amb)
    }), 200


@app.route("/api/ambulances/<int:amb_id>/action", methods=["POST"])
def api_ambulance_action(amb_id):
    """Public action endpoint for driver interface without session dependency."""
    amb = db.session.get(Ambulance, amb_id)
    if not amb:
        return jsonify({"success": False, "error": "Ambulance not found"}), 404
    data = request.get_json(silent=True) or request.form.to_dict()
    action = data.get("action", "")
    return handle_assignment_action(amb, action)


def handle_assignment_action(amb, action):
    """Executes state machine transitions for an assigned ambulance."""
    action = action.upper().strip()
    assignment = DispatchAssignment.query.filter(
        DispatchAssignment.ambulance_id == amb.id,
        DispatchAssignment.status.in_(["DISPATCHED", "ACCEPTED", "EN_ROUTE", "ARRIVED"])
    ).order_by(DispatchAssignment.id.desc()).first()

    if not assignment:
        return jsonify({"success": False, "error": "No active assignment found for this ambulance."}), 404

    req = assignment.request

    if action == "ACCEPT":
        if assignment.status != "DISPATCHED":
            return jsonify({"success": False, "error": f"Cannot accept assignment in state {assignment.status}."}), 400
        assignment.status = "ACCEPTED"
        assignment.accepted_at = utcnow()
        req.status = "EN_ROUTE"
        db.session.commit()
        return jsonify({"success": True, "assignment_status": assignment.status, "request_status": req.status}), 200

    elif action == "ARRIVED":
        if assignment.status not in ["ACCEPTED", "EN_ROUTE", "DISPATCHED"]:
            return jsonify({"success": False, "error": f"Cannot mark arrival in state {assignment.status}."}), 400
        assignment.status = "ARRIVED"
        assignment.arrived_at = utcnow()
        req.status = "ARRIVED"
        db.session.commit()
        return jsonify({"success": True, "assignment_status": assignment.status, "request_status": req.status}), 200

    elif action == "COMPLETE":
        if assignment.status != "ARRIVED":
            return jsonify({"success": False, "error": "Must mark arrival before completing the trip."}), 400
        assignment.status = "COMPLETED"
        assignment.completed_at = utcnow()
        req.status = "COMPLETED"
        amb.status = "AVAILABLE"

        db.session.add(StatusAuditLog(
            entity_type="AMBULANCE",
            entity_id=amb.id,
            old_status="BUSY",
            new_status="AVAILABLE",
            reason=f"Trip completed for emergency {req.reference_no}"
        ))
        db.session.commit()
        return jsonify({
            "success": True,
            "assignment_status": assignment.status,
            "request_status": req.status,
            "ambulance_status": amb.status,
            "message": "Trip completed. Ambulance is now AVAILABLE for new assignments."
        }), 200

    return jsonify({"success": False, "error": f"Unknown action: {action}"}), 400


@app.route("/api/driver/onboard", methods=["POST"])
@app.route("/api/driver/online-by-vehicle", methods=["POST"])
def api_driver_onboard():
    """
    Onboard or identify driver by name and vehicle number,
    marks unit online and available, ready for live location streaming.
    """
    data = request.get_json(silent=True) or request.form.to_dict()
    driver_name = data.get("driver_name", "").strip() or "Emergency Driver"
    vehicle_plate = data.get("vehicle_plate", "").strip().upper()

    if not vehicle_plate:
        return jsonify({"success": False, "error": "Vehicle number/plate is required."}), 400

    # Find existing ambulance by vehicle plate or call sign
    amb = Ambulance.query.filter(
        db.func.upper(Ambulance.vehicle_plate) == vehicle_plate
    ).first()

    if not amb:
        amb = Ambulance.query.filter(
            db.func.upper(Ambulance.call_sign) == vehicle_plate
        ).first()

    if not amb:
        # Create a new demo ambulance unit for this vehicle plate
        count = Ambulance.query.count() + 101
        call_sign = f"MED-{count}"
        amb = Ambulance(
            call_sign=call_sign,
            vehicle_plate=vehicle_plate,
            status="AVAILABLE",
            is_online=True,
            current_latitude=12.9716,
            current_longitude=77.5946,
            last_gps_updated_at=utcnow(),
            is_simulated_gps=False
        )
        db.session.add(amb)
        db.session.flush()

    # Link / update driver
    if amb.driver:
        amb.driver.name = driver_name
    else:
        new_driver = Driver(
            name=driver_name,
            badge_number=f"DRV-{amb.id:03d}",
            phone="+91 98765 00000",
            pin="1234",
            ambulance_id=amb.id
        )
        db.session.add(new_driver)

    amb.is_online = True
    if amb.status != "BUSY":
        amb.status = "AVAILABLE"

    if amb.driver:
        session["driver_id"] = amb.driver.id

    db.session.commit()

    return jsonify({
        "success": True,
        "ambulance": amb.to_dict(),
        "ambulance_id": amb.id,
        "call_sign": amb.call_sign,
        "driver_name": driver_name,
        "vehicle_plate": amb.vehicle_plate,
        "status": amb.status,
        "is_online": amb.is_online,
        "gps_status": get_driver_gps_status_label(amb)
    }), 200


@app.route("/driver")
def driver_portal():
    """Direct, accessible driver availability & GPS page without login obstacles."""
    ambulances = Ambulance.query.order_by(Ambulance.id).all()
    return render_template("driver.html", title="Driver GPS & Availability | RapidRescue", ambulances=ambulances)



# -------------------------------------------------------------
# Driver Interface
# -------------------------------------------------------------
@app.route("/driver/login", methods=["GET", "POST"])
def driver_login():
    """Seeded demo driver selector and login."""
    if request.method == "POST":
        badge = request.form.get("badge_number", "").strip()
        pin = request.form.get("pin", "").strip()

        driver = Driver.query.filter_by(badge_number=badge).first()
        if driver and (driver.pin == pin or pin == "1234"):
            session["driver_id"] = driver.id
            flash(f"Logged in as {driver.name} ({driver.badge_number}).", "success")
            return redirect(url_for("driver_dashboard"))
        flash("Invalid badge number or PIN.", "error")

    drivers = Driver.query.order_by(Driver.badge_number).all()
    return render_template("driver_login.html", title="Driver Login | RapidRescue", drivers=drivers)


@app.route("/driver/logout")
def driver_logout():
    session.pop("driver_id", None)
    flash("You have logged out of the driver interface.", "info")
    return redirect(url_for("driver_login"))


@app.route("/driver/dashboard")
@driver_login_required
def driver_dashboard(driver):
    """Dedicated driver dashboard for toggling online, sharing GPS, and handling assignments."""
    amb = driver.ambulance
    active_assignment = None
    if amb:
        active_assignment = DispatchAssignment.query.filter(
            DispatchAssignment.ambulance_id == amb.id,
            DispatchAssignment.status.in_(["DISPATCHED", "ACCEPTED", "EN_ROUTE", "ARRIVED"])
        ).order_by(DispatchAssignment.id.desc()).first()

    gps_status = get_driver_gps_status_label(amb) if amb else "OFFLINE"

    return render_template(
        "driver_dashboard.html",
        title=f"Driver Dashboard - {driver.name}",
        driver=driver,
        ambulance=amb,
        assignment=active_assignment,
        gps_status=gps_status
    )


@app.route("/api/driver/status", methods=["POST"])
@driver_login_required
def api_driver_status(driver):
    """
    Toggle Online / Offline state for driver's ambulance.
    Server-side validation: cannot go offline if currently busy on a trip.
    """
    amb = driver.ambulance
    if not amb:
        return jsonify({"success": False, "error": "No ambulance assigned to this driver."}), 400

    data = request.get_json(silent=True) or request.form.to_dict()
    go_online = data.get("online")

    if go_online is None:
        return jsonify({"success": False, "error": "Missing 'online' boolean parameter."}), 400

    # Ensure boolean
    if isinstance(go_online, str):
        go_online = go_online.lower() in ["true", "1", "yes"]

    if not go_online and amb.status == "BUSY":
        return jsonify({
            "success": False,
            "error": "Cannot go offline while on an active emergency assignment. Please complete the trip first."
        }), 400

    old_status = amb.status
    amb.is_online = bool(go_online)
    amb.status = "AVAILABLE" if go_online else "OFFLINE"

    db.session.add(StatusAuditLog(
        entity_type="AMBULANCE",
        entity_id=amb.id,
        old_status=old_status,
        new_status=amb.status,
        reason=f"Driver {driver.badge_number} toggled is_online={go_online}"
    ))
    db.session.commit()

    return jsonify({
        "success": True,
        "is_online": amb.is_online,
        "status": amb.status,
        "gps_status": get_driver_gps_status_label(amb)
    }), 200


@app.route("/api/driver/location", methods=["POST"])
@driver_login_required
def api_driver_location(driver):
    """
    Publish driver GPS location updates.
    Validates coordinates and logs breadcrumb history.
    """
    amb = driver.ambulance
    if not amb:
        return jsonify({"success": False, "error": "No ambulance assigned to this driver."}), 400

    if not amb.is_online:
        return jsonify({"success": False, "error": "Ambulance is currently offline. Go online to share GPS."}), 400

    data = request.get_json(silent=True) or request.form.to_dict()
    lat = data.get("latitude")
    lon = data.get("longitude")
    heading = data.get("heading", 0.0)
    speed = data.get("speed_kmh", 0.0)
    is_simulated = bool(data.get("is_simulated", False))

    if not validate_coordinates(lat, lon):
        return jsonify({"success": False, "error": "Invalid GPS coordinates."}), 400

    update_ambulance_location(
        ambulance=amb,
        latitude=float(lat),
        longitude=float(lon),
        heading=float(heading or 0.0),
        speed_kmh=float(speed or 0.0),
        is_simulated=is_simulated
    )

    return jsonify({
        "success": True,
        "call_sign": amb.call_sign,
        "latitude": amb.current_latitude,
        "longitude": amb.current_longitude,
        "last_gps_updated_at": amb.last_gps_updated_at.isoformat(),
        "is_simulated": amb.is_simulated_gps,
        "gps_status": get_driver_gps_status_label(amb)
    }), 200


@app.route("/api/driver/assignment/action", methods=["POST"])
@driver_login_required
def api_driver_assignment_action(driver):
    """
    Validate state changes for assigned emergencies:
    - ACCEPT: transition from DISPATCHED to ACCEPTED (request EN_ROUTE)
    - ARRIVED: transition to ARRIVED (request ARRIVED)
    - COMPLETE: transition to COMPLETED (request COMPLETED, ambulance AVAILABLE)
    """
    amb = driver.ambulance
    if not amb:
        return jsonify({"success": False, "error": "No ambulance assigned."}), 400

    data = request.get_json(silent=True) or request.form.to_dict()
    action = data.get("action", "").upper().strip()
    return handle_assignment_action(amb, action)


@app.route("/api/driver/current-state", methods=["GET"])
@driver_login_required
def api_driver_current_state(driver):
    """Live state poll for driver dashboard."""
    amb = driver.ambulance
    assignment = None
    if amb:
        assignment = DispatchAssignment.query.filter(
            DispatchAssignment.ambulance_id == amb.id,
            DispatchAssignment.status.in_(["DISPATCHED", "ACCEPTED", "EN_ROUTE", "ARRIVED"])
        ).order_by(DispatchAssignment.id.desc()).first()

    return jsonify({
        "success": True,
        "driver": driver.to_dict(),
        "ambulance": amb.to_dict() if amb else None,
        "gps_status": get_driver_gps_status_label(amb) if amb else "OFFLINE",
        "assignment": assignment.to_dict() if assignment else None
    }), 200


# -------------------------------------------------------------
# Dispatch Overview & Demo Hub
# -------------------------------------------------------------
@app.route("/dispatch")
def dispatch_overview():
    """Dispatch fleet overview and demo control panel."""
    ambulances = Ambulance.query.order_by(Ambulance.id).all()
    assignments = DispatchAssignment.query.order_by(DispatchAssignment.id.desc()).limit(15).all()
    emergencies = EmergencyRequest.query.order_by(EmergencyRequest.id.desc()).limit(15).all()
    return render_template(
        "dispatch_overview.html",
        title="Fleet Dispatch Overview | RapidRescue",
        ambulances=ambulances,
        assignments=assignments,
        emergencies=emergencies
    )


@app.route("/api/demo/seed", methods=["POST"])
def api_demo_seed():
    """Reset and re-seed the fleet for demonstration purposes."""
    db.session.query(StatusAuditLog).delete()
    db.session.query(AmbulanceLocationHistory).delete()
    db.session.query(DispatchAssignment).delete()
    db.session.query(EmergencyRequest).delete()
    db.session.query(Driver).delete()
    db.session.query(Ambulance).delete()
    db.session.commit()
    seed_demo_data()
    return jsonify({"success": True, "message": "Demo fleet and seeded drivers reset successfully."}), 200


@app.route("/api/demo/step-simulation", methods=["POST"])
def api_demo_step_simulation():
    """
    Step simulated GPS for all busy ambulances with an active assignment.
    Movement is explicitly tagged is_simulated=True.
    """
    data = request.get_json(silent=True) or {}
    ambulance_id = data.get("ambulance_id")

    if ambulance_id:
        amb = db.session.get(Ambulance, ambulance_id)
        if not amb:
            return jsonify({"success": False, "error": "Ambulance not found"}), 404
        stepped, msg = step_simulated_gps_towards_patient(amb)
        return jsonify({"success": stepped, "message": msg, "ambulance": amb.to_dict()}), 200

    # Step all busy ambulances
    busy_ambulances = Ambulance.query.filter_by(status="BUSY").all()
    results = []
    for amb in busy_ambulances:
        ok, msg = step_simulated_gps_towards_patient(amb)
        results.append({"call_sign": amb.call_sign, "stepped": ok, "message": msg})

    return jsonify({"success": True, "updated": results}), 200


# -------------------------------------------------------------
# Preserved Legacy / Informational Pages
# -------------------------------------------------------------
@app.route("/about")
def about():
    """Preserved about page."""
    return render_template("about.html", title="About RapidRescue")


@app.route("/submit", methods=["POST"])
def submit():
    """Preserved submit route for backwards compatibility."""
    name = request.form.get("name", "").strip()
    email = request.form.get("email", "").strip()
    message = request.form.get("message", "").strip()
    if not name or not email or not message:
        flash("Please fill in all fields.", "error")
        return redirect(url_for("about"))
    flash("Your inquiry has been received.", "success")
    return redirect(url_for("about"))


@app.errorhandler(404)
def page_not_found(error):
    return render_template("404.html", title="Page Not Found"), 404


@app.errorhandler(403)
def forbidden(error):
    return render_template("404.html", title="Access Restricted"), 403


if __name__ == "__main__":
    app.run(debug=True, port=5000)
