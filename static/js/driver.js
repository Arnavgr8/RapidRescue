/**
 * RapidRescue - Driver Dashboard JavaScript Module
 * Handles online/offline state, GPS publishing (live & simulated),
 * and state-machine validated emergency assignment progression.
 */
document.addEventListener("DOMContentLoaded", () => {
    const btnOnline = document.getElementById("btn-go-online");
    const btnOffline = document.getElementById("btn-go-offline");
    const btnEnableGps = document.getElementById("btn-enable-browser-gps");
    const btnStepDemo = document.getElementById("btn-step-demo-gps");
    const unitStatusBadge = document.getElementById("unit-status-badge");
    const gpsStatusBadge = document.getElementById("gps-status-badge");
    const gpsCoordsDisplay = document.getElementById("gps-coords-display");
    const gpsTypeTag = document.getElementById("gps-type-tag");
    const assignmentAlert = document.getElementById("assignment-alert");

    // Action buttons
    const btnAccept = document.getElementById("btn-action-accept");
    const btnArrived = document.getElementById("btn-action-arrived");
    const btnComplete = document.getElementById("btn-action-complete");

    // Views
    const noAssignView = document.getElementById("no-assignment-view");
    const activeAssignView = document.getElementById("active-assignment-view");
    const busyIndicator = document.getElementById("assignment-busy-indicator");

    // Leaflet Driver Map
    const mapElement = document.getElementById("driver-map");
    let map = null;
    let driverMarker = null;
    let patientMarker = null;

    if (mapElement && typeof L !== "undefined") {
        const initLat = typeof DRIVER_INITIAL_LAT !== "undefined" ? DRIVER_INITIAL_LAT : 12.9716;
        const initLon = typeof DRIVER_INITIAL_LON !== "undefined" ? DRIVER_INITIAL_LON : 77.5946;

        map = L.map("driver-map").setView([initLat, initLon], 13);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 18
        }).addTo(map);

        const ambIcon = L.divIcon({
            className: "driver-amb-icon",
            html: '<div style="background-color:#10B981; width:28px; height:28px; border-radius:50%; border:2px solid white; display:flex; align-items:center; justify-content:center; font-size:14px; box-shadow:0 0 10px rgba(16,185,129,0.7);">🚑</div>',
            iconSize: [28, 28],
            iconAnchor: [14, 14]
        });

        driverMarker = L.marker([initLat, initLon], { icon: ambIcon }).addTo(map);
        driverMarker.bindPopup("<strong>My Ambulance Unit</strong>");
    }

    // Online / Offline Toggles
    if (btnOnline) {
        btnOnline.addEventListener("click", async () => {
            await setOnlineStatus(true);
        });
    }

    if (btnOffline) {
        btnOffline.addEventListener("click", async () => {
            await setOnlineStatus(false);
        });
    }

    async function setOnlineStatus(goOnline) {
        try {
            const resp = await fetch("/api/driver/status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ online: goOnline })
            });
            const data = await resp.json();

            if (!resp.ok || !data.success) {
                showAlert(data.error || "Failed to update online status.", "alert-danger");
                return;
            }

            showAlert(`Status updated: ${data.status}`, "alert-success");
            updateStatusUI(data.is_online, data.status, data.gps_status);
        } catch (err) {
            showAlert("Network error updating online status.", "alert-danger");
        }
    }

    function updateStatusUI(isOnline, status, gpsStatus) {
        if (isOnline) {
            btnOnline.classList.add("d-none");
            btnOffline.classList.remove("d-none");
        } else {
            btnOnline.classList.remove("d-none");
            btnOffline.classList.add("d-none");
        }

        if (unitStatusBadge) {
            unitStatusBadge.textContent = status;
            unitStatusBadge.className = `badge badge-lg badge-status-${status.toLowerCase()}`;
        }
        if (gpsStatusBadge && gpsStatus) {
            gpsStatusBadge.textContent = gpsStatus;
            gpsStatusBadge.className = `badge badge-gps badge-gps-${gpsStatus.toLowerCase()}`;
        }
    }

    // Browser GPS Publishing
    let watchId = null;
    if (btnEnableGps) {
        btnEnableGps.addEventListener("click", () => {
            if (!navigator.geolocation) {
                if (gpsStatusBadge) {
                    gpsStatusBadge.textContent = "UNAVAILABLE";
                    gpsStatusBadge.className = "badge badge-gps badge-gps-unavailable";
                }
                showAlert("Geolocation is not supported by your browser.", "alert-danger");
                return;
            }

            if (watchId !== null) {
                navigator.geolocation.clearWatch(watchId);
                watchId = null;
                btnEnableGps.textContent = "🛰️ Publish Browser GPS";
                showAlert("GPS publishing paused.", "alert-warning");
                return;
            }

            btnEnableGps.textContent = "⏹️ Stop Publishing GPS";
            showAlert("Requesting GPS permission...", "alert-warning");

            watchId = navigator.geolocation.watchPosition(
                async (pos) => {
                    const lat = pos.coords.latitude;
                    const lon = pos.coords.longitude;
                    const speed = (pos.coords.speed || 0) * 3.6; // m/s to km/h
                    const heading = pos.coords.heading || 0.0;

                    try {
                        const resp = await fetch("/api/driver/location", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                latitude: lat,
                                longitude: lon,
                                speed_kmh: speed,
                                heading: heading,
                                is_simulated: false
                            })
                        });
                        const data = await resp.json();

                        if (resp.ok && data.success) {
                            if (gpsStatusBadge) {
                                gpsStatusBadge.textContent = "ACTIVE";
                                gpsStatusBadge.className = "badge badge-gps badge-gps-active";
                            }
                            if (gpsCoordsDisplay) {
                                gpsCoordsDisplay.textContent = `(${lat.toFixed(5)}, ${lon.toFixed(5)})`;
                            }
                            if (gpsTypeTag) gpsTypeTag.textContent = "[Live]";

                            if (driverMarker && map) {
                                driverMarker.setLatLng([lat, lon]);
                                map.panTo([lat, lon]);
                            }
                        } else {
                            showAlert(data.error || "GPS upload rejected by server.", "alert-danger");
                        }
                    } catch (err) {
                        console.error("GPS upload error:", err);
                    }
                },
                (err) => {
                    if (gpsStatusBadge) {
                        gpsStatusBadge.textContent = "DENIED";
                        gpsStatusBadge.className = "badge badge-gps badge-gps-denied";
                    }
                    showAlert(`GPS Access Denied or Timed Out (Code ${err.code}): ${err.message}`, "alert-danger");
                },
                { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
            );
        });
    }

    // Step Demo Movement
    if (btnStepDemo) {
        btnStepDemo.addEventListener("click", async () => {
            btnStepDemo.disabled = true;
            try {
                const resp = await fetch("/api/demo/step-simulation", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ambulance_id: CURRENT_AMB_ID })
                });
                const data = await resp.json();

                if (resp.ok && data.success) {
                    showAlert("Simulated movement step applied (25% closer).", "alert-success");
                    await pollCurrentState();
                } else {
                    showAlert(data.message || data.error || "Cannot step movement.", "alert-warning");
                }
            } catch (err) {
                showAlert("Network error executing demo step.", "alert-danger");
            } finally {
                btnStepDemo.disabled = false;
            }
        });
    }

    // Assignment Action Triggers
    if (btnAccept) {
        btnAccept.addEventListener("click", () => handleAssignmentAction("ACCEPT"));
    }
    if (btnArrived) {
        btnArrived.addEventListener("click", () => handleAssignmentAction("ARRIVED"));
    }
    if (btnComplete) {
        btnComplete.addEventListener("click", () => handleAssignmentAction("COMPLETE"));
    }

    async function handleAssignmentAction(action) {
        try {
            const resp = await fetch("/api/driver/assignment/action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: action })
            });
            const data = await resp.json();

            if (!resp.ok || !data.success) {
                showAlert(data.error || "Action failed.", "alert-danger");
                return;
            }

            showAlert(`Action '${action}' recorded successfully.`, "alert-success");
            await pollCurrentState();
        } catch (err) {
            showAlert("Network error sending assignment action.", "alert-danger");
        }
    }

    // Polling Driver Current State (every 3 seconds)
    async function pollCurrentState() {
        try {
            const resp = await fetch("/api/driver/current-state");
            if (!resp.ok) return;

            const data = await resp.json();
            if (!data.success) return;

            const amb = data.ambulance;
            const assign = data.assignment;

            if (amb) {
                updateStatusUI(amb.is_online, amb.status, data.gps_status);
                if (amb.current_latitude && amb.current_longitude) {
                    if (gpsCoordsDisplay) {
                        gpsCoordsDisplay.textContent = `(${amb.current_latitude.toFixed(5)}, ${amb.current_longitude.toFixed(5)})`;
                    }
                    if (gpsTypeTag) {
                        gpsTypeTag.textContent = amb.is_simulated_gps ? "[Simulated]" : "[Live]";
                    }
                    if (driverMarker) {
                        driverMarker.setLatLng([amb.current_latitude, amb.current_longitude]);
                    }
                }
            }

            // Update assignment view
            if (assign) {
                noAssignView.classList.add("d-none");
                activeAssignView.classList.remove("d-none");
                busyIndicator.textContent = "BUSY - ACTIVE MISSION";
                busyIndicator.className = "badge badge-emergency";

                // Update text fields
                const assignRef = document.getElementById("assign-ref");
                const assignAddr = document.getElementById("assign-address");
                const assignNotes = document.getElementById("assign-notes");
                const assignStage = document.getElementById("assign-stage-badge");

                if (assignRef) assignRef.textContent = assign.request_ref;
                if (assignAddr) assignAddr.textContent = assign.pickup_address;
                if (assignNotes) assignNotes.textContent = assign.emergency_notes || "None reported";

                if (assignStage) {
                    assignStage.textContent = assign.status;
                    assignStage.className = `badge badge-status-${assign.status.toLowerCase()}`;
                }

                // Update button disabled states based on server state machine rules
                if (btnAccept) btnAccept.disabled = (assign.status !== "DISPATCHED");
                if (btnArrived) btnArrived.disabled = !["ACCEPTED", "EN_ROUTE"].includes(assign.status);
                if (btnComplete) btnComplete.disabled = (assign.status !== "ARRIVED");

                // Update patient marker on driver map
                if (assign.patient_latitude && assign.patient_longitude && map) {
                    const patPos = [assign.patient_latitude, assign.patient_longitude];
                    if (!patientMarker) {
                        const patIcon = L.divIcon({
                            className: "pat-map-icon",
                            html: '<div style="background-color:#EF4444; width:22px; height:22px; border-radius:50%; border:2px solid white; display:flex; align-items:center; justify-content:center; font-size:11px;">📍</div>',
                            iconSize: [22, 22],
                            iconAnchor: [11, 11]
                        });
                        patientMarker = L.marker(patPos, { icon: patIcon }).addTo(map);
                        patientMarker.bindPopup("<strong>Patient Pickup Location</strong>");
                    } else {
                        patientMarker.setLatLng(patPos);
                    }
                }
            } else {
                noAssignView.classList.remove("d-none");
                activeAssignView.classList.add("d-none");
                busyIndicator.textContent = "STANDBY / IDLE";
                busyIndicator.className = "badge badge-outline";

                if (patientMarker && map) {
                    map.removeLayer(patientMarker);
                    patientMarker = null;
                }
            }
        } catch (err) {
            console.error("Error polling driver state:", err);
        }
    }

    function showAlert(msg, className) {
        if (!assignmentAlert) return;
        assignmentAlert.className = `alert ${className}`;
        assignmentAlert.innerHTML = msg;
        assignmentAlert.classList.remove("d-none");
        setTimeout(() => { assignmentAlert.classList.add("d-none"); }, 6000);
    }

    const intervalId = setInterval(pollCurrentState, 3000);
    window.addEventListener("beforeunload", () => clearInterval(intervalId));
});

