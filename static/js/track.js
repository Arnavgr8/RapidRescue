/**
 * RapidRescue - Patient Live Tracking JavaScript Module
 * Connects to REST polling endpoint /api/track/<reference_no>?token=<tracking_token>
 * Smoothly updates ambulance coordinates, straight-line distance, ETA, and mission status.
 */
document.addEventListener("DOMContentLoaded", () => {
    if (typeof TRACKING_REF === "undefined" || typeof TRACKING_TOKEN === "undefined") {
        return;
    }

    const liveStatusBadge = document.getElementById("live-status-badge");
    const statDistance = document.getElementById("stat-distance");
    const statEta = document.getElementById("stat-eta");
    const ambCallSign = document.getElementById("amb-call-sign");
    const ambDriver = document.getElementById("amb-driver");
    const ambLastGpsTime = document.getElementById("amb-last-gps-time");
    const gpsSourceLabel = document.getElementById("gps-source-label");
    const btnCopyRef = document.getElementById("btn-copy-ref");
    const btnCopyLink = document.getElementById("btn-copy-link");

    // Copy Handlers
    if (btnCopyRef) {
        btnCopyRef.addEventListener("click", () => {
            navigator.clipboard.writeText(TRACKING_REF).then(() => {
                btnCopyRef.textContent = "✓ Copied";
                setTimeout(() => { btnCopyRef.textContent = "📋 Copy"; }, 2000);
            });
        });
    }

    if (btnCopyLink) {
        btnCopyLink.addEventListener("click", () => {
            navigator.clipboard.writeText(window.location.href).then(() => {
                btnCopyLink.textContent = "✓ Link Copied";
                setTimeout(() => { btnCopyLink.textContent = "🔗 Copy Tracking Link"; }, 2000);
            });
        });
    }

    // Initialize Leaflet Map
    const map = L.map("tracking-map").setView([PATIENT_LAT, PATIENT_LON], 14);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 18
    }).addTo(map);

    // Patient Marker (Red Beacon)
    const patientIcon = L.divIcon({
        className: "patient-map-icon",
        html: `
            <div style="position: relative; width: 22px; height: 22px;">
                <div class="pulse-ring-red"></div>
                <div style="background-color: #EF4444; width: 22px; height: 22px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 12px #EF4444; display: flex; align-items: center; justify-content: center; color: white; font-size: 11px; font-weight: bold;">
                    📍
                </div>
            </div>
        `,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
    });

    const patientMarker = L.marker([PATIENT_LAT, PATIENT_LON], { icon: patientIcon }).addTo(map);
    patientMarker.bindPopup("<strong>Patient Pickup Location</strong><br>Awaiting dispatched unit.");

    // Ambulance Marker (Green vehicle with pulse ring)
    const ambulanceIcon = L.divIcon({
        className: "ambulance-map-icon",
        html: `
            <div style="position: relative; width: 32px; height: 32px;">
                <div class="pulse-ring-green"></div>
                <div style="background-color: #10B981; width: 32px; height: 32px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 16px rgba(16, 185, 129, 0.8); display: flex; align-items: center; justify-content: center; font-size: 16px;">
                    🚑
                </div>
            </div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });

    let ambulanceMarker = null;
    let trajectoryLine = null;

    if (INITIAL_AMB_LAT && INITIAL_AMB_LON) {
        ambulanceMarker = L.marker([INITIAL_AMB_LAT, INITIAL_AMB_LON], { icon: ambulanceIcon }).addTo(map);
        ambulanceMarker.bindPopup(`<strong>RapidRescue ${INITIAL_AMB_SIGN || 'Ambulance'}</strong><br>Dispatched unit en route.`);

        // Connecting trajectory line
        trajectoryLine = L.polyline([
            [INITIAL_AMB_LAT, INITIAL_AMB_LON],
            [PATIENT_LAT, PATIENT_LON]
        ], {
            color: "#60A5FA",
            weight: 3,
            dashArray: "6, 8",
            opacity: 0.8
        }).addTo(map);

        // Fit map bounds to show both
        map.fitBounds([
            [PATIENT_LAT, PATIENT_LON],
            [INITIAL_AMB_LAT, INITIAL_AMB_LON]
        ], { padding: [50, 50] });
    }

    // Auto-Polling Function (Every 3 seconds)
    async function pollEmergencyStatus() {
        try {
            const url = `/api/track/${encodeURIComponent(TRACKING_REF)}?token=${encodeURIComponent(TRACKING_TOKEN)}`;
            const response = await fetch(url);

            if (!response.ok) {
                console.warn("Tracking poll returned non-ok status:", response.status);
                return;
            }

            const data = await response.json();
            if (!data.success || !data.emergency) return;

            const em = data.emergency;

            // 1. Update Status Badge
            if (liveStatusBadge) {
                liveStatusBadge.textContent = em.status;
                liveStatusBadge.className = `badge badge-lg badge-status-${em.status.toLowerCase()}`;
            }

            // 2. Update Straight-line Distance and ETA with smooth counter animation
            if (statDistance && em.straight_line_distance_km !== null) {
                const oldDist = parseFloat(statDistance.textContent);
                if (!isNaN(oldDist) && typeof window.animateCounter === "function") {
                    window.animateCounter(statDistance, oldDist, em.straight_line_distance_km, 400, 2);
                } else {
                    statDistance.textContent = em.straight_line_distance_km.toFixed(2);
                }
            }
            if (statEta && em.estimated_straight_line_eta_minutes !== null) {
                const oldEta = parseFloat(statEta.textContent);
                if (!isNaN(oldEta) && typeof window.animateCounter === "function") {
                    window.animateCounter(statEta, oldEta, em.estimated_straight_line_eta_minutes, 400, 1);
                } else {
                    statEta.textContent = em.estimated_straight_line_eta_minutes.toFixed(1);
                }
            }

            // 3. Update Ambulance Position on Map with smooth glide
            if (em.assigned_ambulance && em.assigned_ambulance.current_latitude && em.assigned_ambulance.current_longitude) {
                const amb = em.assigned_ambulance;
                const newPos = [amb.current_latitude, amb.current_longitude];

                if (!ambulanceMarker) {
                    ambulanceMarker = L.marker(newPos, { icon: ambulanceIcon }).addTo(map);
                    ambulanceMarker.bindPopup(`<strong>RapidRescue ${amb.call_sign}</strong><br>Dispatched unit.`);
                } else {
                    if (typeof window.glideMarker === "function") {
                        window.glideMarker(ambulanceMarker, newPos, 800);
                    } else {
                        ambulanceMarker.setLatLng(newPos);
                    }
                }

                // Update dashed trajectory line
                if (trajectoryLine) {
                    trajectoryLine.setLatLngs([newPos, [PATIENT_LAT, PATIENT_LON]]);
                } else {
                    trajectoryLine = L.polyline([newPos, [PATIENT_LAT, PATIENT_LON]], {
                        color: "#60A5FA",
                        weight: 3,
                        dashArray: "6, 8",
                        opacity: 0.8
                    }).addTo(map);
                }

                // GPS Source Tag (Simulated vs Live)
                if (gpsSourceLabel) {
                    if (amb.is_simulated_gps) {
                        gpsSourceLabel.textContent = "⚠️ Simulated Demo GPS Movement";
                        gpsSourceLabel.className = "gps-source-badge text-warning";
                    } else {
                        gpsSourceLabel.textContent = "🛰️ Live GPS Tracking";
                        gpsSourceLabel.className = "gps-source-badge text-success";
                    }
                }

                if (ambCallSign) ambCallSign.textContent = amb.call_sign;
                if (ambDriver && amb.driver_name) ambDriver.textContent = amb.driver_name;
                if (ambLastGpsTime && amb.last_gps_updated_at) {
                    try {
                        ambLastGpsTime.textContent = new Date(amb.last_gps_updated_at).toLocaleTimeString();
                    } catch(e) {
                        ambLastGpsTime.textContent = amb.last_gps_updated_at;
                    }
                    if (typeof window.flashUpdate === "function") {
                        window.flashUpdate(ambLastGpsTime);
                    }
                }
            }
        } catch (err) {
            console.error("Error polling emergency status:", err);
        }
    }

    // Start polling loop every 5 seconds (Requirement 3: Live tracking)
    const pollInterval = setInterval(pollEmergencyStatus, 5000);

    // Initial immediate poll
    pollEmergencyStatus();

    // Clean up when leaving page
    window.addEventListener("beforeunload", () => {
        clearInterval(pollInterval);
    });
});

