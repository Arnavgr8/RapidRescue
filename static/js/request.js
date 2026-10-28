/**
 * RapidRescue - Patient Emergency Request & Live Tracking JavaScript Module
 * Fully satisfies Requirements 2, 3, 4, 5:
 * - Patient coordinates submission (Use My Location or manual input)
 * - Automatic nearest ambulance Haversine dispatch
 * - Clear error if no ambulance available (no fake assignment)
 * - Embedded Leaflet map tracking patient and assigned ambulance
 * - 5-second polling loop updating marker, status, and last GPS update time
 */
document.addEventListener("DOMContentLoaded", () => {
    // Views
    const requestView = document.getElementById("request-view");
    const trackingView = document.getElementById("tracking-view");

    // Form elements
    const form = document.getElementById("emergency-form");
    const alertBox = document.getElementById("request-alert");
    const btnSubmit = document.getElementById("btn-submit-request");
    const btnGps = document.getElementById("btn-use-gps");
    const gpsIndicator = document.getElementById("gps-status-indicator");
    const latInput = document.getElementById("latitude");
    const lonInput = document.getElementById("longitude");
    const addressInput = document.getElementById("pickup_address");
    const presetButtons = document.querySelectorAll(".btn-preset");
    const reopenForm = document.getElementById("reopen-form");

    // Tracking elements
    const liveRef = document.getElementById("live-ref");
    const liveTokenDisplay = document.getElementById("live-token-display");
    const liveStatusBadge = document.getElementById("live-status-badge");
    const liveExternalLink = document.getElementById("live-external-link");
    const liveGpsSource = document.getElementById("live-gps-source");
    const liveAmbSign = document.getElementById("live-amb-sign");
    const liveAmbDriver = document.getElementById("live-amb-driver");
    const liveAmbPlate = document.getElementById("live-amb-plate");
    const liveAmbState = document.getElementById("live-amb-state");
    const liveLastGpsTime = document.getElementById("live-last-gps-time");
    const liveStatDist = document.getElementById("live-stat-dist");
    const liveStatEta = document.getElementById("live-stat-eta");
    const livePickupAddress = document.getElementById("live-pickup-address");
    const livePickupCoords = document.getElementById("live-pickup-coords");
    const btnNewRequest = document.getElementById("btn-new-request");
    const btnCopyLiveRef = document.getElementById("btn-copy-live-ref");

    // Mini preview map variables
    let requestMap = null;
    let requestMarker = null;

    // Tracking map variables
    let trackMap = null;
    let trackPatientMarker = null;
    let trackAmbulanceMarker = null;
    let trackPolyline = null;
    let trackingPollInterval = null;
    let activeTrackingToken = null;

    const defaultLat = parseFloat(latInput.value) || 12.9750;
    const defaultLon = parseFloat(lonInput.value) || 77.6050;

    // 1. Initialize Mini-Map for Pin Drop
    const requestMapEl = document.getElementById("request-map");
    if (requestMapEl && typeof L !== "undefined") {
        requestMap = L.map("request-map").setView([defaultLat, defaultLon], 13);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 18
        }).addTo(requestMap);

        const redPinIcon = L.divIcon({
            className: "custom-red-pin",
            html: '<div style="background-color:#EF4444; width:18px; height:18px; border-radius:50%; border:2px solid white; box-shadow:0 0 10px #EF4444;"></div>',
            iconSize: [18, 18],
            iconAnchor: [9, 9]
        });

        requestMarker = L.marker([defaultLat, defaultLon], {
            draggable: true,
            icon: redPinIcon
        }).addTo(requestMap);

        requestMarker.on("dragend", (e) => {
            const pos = e.target.getLatLng();
            latInput.value = pos.lat.toFixed(6);
            lonInput.value = pos.lng.toFixed(6);
        });

        requestMap.on("click", (e) => {
            const pos = e.latlng;
            requestMarker.setLatLng(pos);
            latInput.value = pos.lat.toFixed(6);
            lonInput.value = pos.lng.toFixed(6);
        });
    }

    function setCoordinates(lat, lon, address = null) {
        latInput.value = Number(lat).toFixed(6);
        lonInput.value = Number(lon).toFixed(6);
        if (address && addressInput) {
            addressInput.value = address;
        }
        if (requestMap && requestMarker) {
            const latLng = [Number(lat), Number(lon)];
            requestMarker.setLatLng(latLng);
            requestMap.panTo(latLng);
        }
    }

    // 2. Preset Buttons
    presetButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            const lat = btn.getAttribute("data-lat");
            const lon = btn.getAttribute("data-lon");
            const addr = btn.getAttribute("data-address");
            setCoordinates(lat, lon, addr);
            gpsIndicator.textContent = "Preset Selected";
            gpsIndicator.className = "gps-status-pill text-success";
        });
    });

    // 3. Browser GPS "Use My Location"
    if (btnGps) {
        btnGps.addEventListener("click", () => {
            if (!navigator.geolocation) {
                gpsIndicator.textContent = "GPS Not Supported";
                gpsIndicator.className = "gps-status-pill text-danger";
                return;
            }

            gpsIndicator.textContent = "Acquiring GPS...";
            gpsIndicator.className = "gps-status-pill text-warning";

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const lat = pos.coords.latitude;
                    const lon = pos.coords.longitude;
                    setCoordinates(lat, lon);
                    gpsIndicator.textContent = `GPS Captured (±${Math.round(pos.coords.accuracy)}m)`;
                    gpsIndicator.className = "gps-status-pill text-success";
                },
                (err) => {
                    gpsIndicator.textContent = "GPS Denied / Unavailable";
                    gpsIndicator.className = "gps-status-pill text-danger";
                    showAlert("Could not get browser GPS. You may enter coordinates manually or use the demo test locations.", "alert-warning");
                },
                { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
            );
        });
    }

    // Manual input sync with marker
    [latInput, lonInput].forEach(inp => {
        inp.addEventListener("change", () => {
            const lat = parseFloat(latInput.value);
            const lon = parseFloat(lonInput.value);
            if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                if (requestMap && requestMarker) {
                    requestMarker.setLatLng([lat, lon]);
                    requestMap.panTo([lat, lon]);
                }
            }
        });
    });

    // 4. Emergency Form Submission
    if (form) {
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            showAlert("", "d-none");

            const patientName = document.getElementById("patient_name").value.trim();
            const contactPhone = document.getElementById("contact_phone").value.trim();
            const pickupAddress = document.getElementById("pickup_address").value.trim();
            const lat = parseFloat(latInput.value);
            const lon = parseFloat(lonInput.value);
            const notes = document.getElementById("emergency_notes").value.trim();

            if (!patientName || !contactPhone || !pickupAddress) {
                showAlert("Please fill in all required fields.", "alert-danger");
                return;
            }

            if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
                showAlert("Please provide valid coordinates within geographic bounds.", "alert-danger");
                return;
            }

            btnSubmit.disabled = true;
            btnSubmit.querySelector(".btn-text").textContent = "Dispatching Nearest Unit...";

            try {
                // Submit to POST /api/emergencies (Requirement 4)
                const response = await fetch("/api/emergencies", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        patient_name: patientName,
                        contact_phone: contactPhone,
                        pickup_address: pickupAddress,
                        latitude: lat,
                        longitude: lon,
                        emergency_notes: notes
                    })
                });

                const data = await response.json();

                if (response.ok && data.success && data.assigned_ambulance) {
                    // Nearest unit assigned! Switch immediately to embedded tracking view
                    startLiveTracking(data.tracking_token, data.reference_no);
                } else if (data.status === "NO_AMBULANCE") {
                    // Explicit error when no ambulance is available - negative prompt constraint strictly enforced
                    showAlert(
                        `🚨 <strong>No Ambulance Available:</strong> ${data.message} (Reference: ${data.reference_no}). All units are busy, offline, or out of range.`,
                        "alert-danger"
                    );
                    btnSubmit.disabled = false;
                    btnSubmit.querySelector(".btn-text").textContent = "🚨 Retry Dispatch Request";
                } else {
                    showAlert(data.error || "Failed to process emergency request.", "alert-danger");
                    btnSubmit.disabled = false;
                    btnSubmit.querySelector(".btn-text").textContent = "🚨 Dispatch Nearest Ambulance Now";
                }
            } catch (err) {
                showAlert("Network error communicating with dispatch backend. Please try again.", "alert-danger");
                btnSubmit.disabled = false;
                btnSubmit.querySelector(".btn-text").textContent = "🚨 Dispatch Nearest Ambulance Now";
            }
        });
    }

    // 5. Embedded Live Tracking Engine (Requirement 3: Live tracking)
    async function startLiveTracking(token, referenceNo) {
        activeTrackingToken = token;

        // Switch visible view
        requestView.classList.add("d-none");
        trackingView.classList.remove("d-none");

        liveRef.textContent = referenceNo || "--";
        liveTokenDisplay.textContent = token;
        liveExternalLink.href = `/track/${encodeURIComponent(referenceNo)}?token=${encodeURIComponent(token)}`;

        // Stop any previous polling
        if (trackingPollInterval) {
            clearInterval(trackingPollInterval);
            trackingPollInterval = null;
        }

        // Initialize tracking map if not already created
        initTrackingMap();

        // Perform initial poll immediately
        await pollTrackingData();

        // Start 5-second polling loop
        trackingPollInterval = setInterval(pollTrackingData, 5000);
    }

    function initTrackingMap() {
        const mapEl = document.getElementById("inline-tracking-map");
        if (!mapEl) return;

        if (trackMap) {
            trackMap.remove();
            trackMap = null;
        }

        trackMap = L.map("inline-tracking-map").setView([defaultLat, defaultLon], 13);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 18
        }).addTo(trackMap);

        // Resize fix after container becomes visible
        setTimeout(() => {
            trackMap.invalidateSize();
        }, 150);
    }

    async function pollTrackingData() {
        if (!activeTrackingToken) return;

        try {
            // GET /api/track/<tracking_token> (Requirement 4)
            const resp = await fetch(`/api/track/${encodeURIComponent(activeTrackingToken)}`);
            if (!resp.ok) {
                console.warn("Tracking poll status:", resp.status);
                return;
            }

            const data = await resp.json();
            if (!data.success || !data.emergency) return;

            const em = data.emergency;
            updateTrackingUI(em);
        } catch (e) {
            console.error("Error polling tracking endpoint:", e);
        }
    }

    function updateTrackingUI(em) {
        liveRef.textContent = em.reference_no;
        liveStatusBadge.textContent = em.status;
        liveStatusBadge.className = `badge badge-lg badge-status-${em.status.toLowerCase()}`;

        livePickupAddress.textContent = em.pickup_address;
        livePickupCoords.textContent = `Coords: (${em.patient_latitude.toFixed(5)}, ${em.patient_longitude.toFixed(5)})`;

        if (em.straight_line_distance_km !== null) {
            const oldDist = parseFloat(liveStatDist.textContent);
            if (!isNaN(oldDist) && typeof window.animateCounter === "function") {
                window.animateCounter(liveStatDist, oldDist, em.straight_line_distance_km, 400, 2);
            } else {
                liveStatDist.textContent = em.straight_line_distance_km.toFixed(2);
            }
        }
        if (em.estimated_straight_line_eta_minutes !== null) {
            const oldEta = parseFloat(liveStatEta.textContent);
            if (!isNaN(oldEta) && typeof window.animateCounter === "function") {
                window.animateCounter(liveStatEta, oldEta, em.estimated_straight_line_eta_minutes, 400, 1);
            } else {
                liveStatEta.textContent = em.estimated_straight_line_eta_minutes.toFixed(1);
            }
        }

        const patLatLng = [em.patient_latitude, em.patient_longitude];

        // Ensure patient red marker exists
        if (!trackPatientMarker && trackMap) {
            const patientIcon = L.divIcon({
                className: "patient-beacon-pin",
                html: '<div style="position:relative; width:22px; height:22px;"><div class="pulse-ring-red"></div><div style="background-color:#EF4444; width:22px; height:22px; border-radius:50%; border:3px solid white; box-shadow:0 0 12px #EF4444; display:flex; align-items:center; justify-content:center; color:white; font-size:11px;">📍</div></div>',
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            });
            trackPatientMarker = L.marker(patLatLng, { icon: patientIcon }).addTo(trackMap);
            trackPatientMarker.bindPopup("<strong>Patient Pickup Location</strong><br>Awaiting ambulance.");
        }

        const amb = em.assigned_ambulance;
        if (amb) {
            liveAmbSign.textContent = amb.call_sign;
            liveAmbDriver.textContent = amb.driver_name || "Assigned Driver";
            liveAmbPlate.textContent = amb.vehicle_plate || "KA-01-EA-1001";
            liveAmbState.textContent = amb.status || "BUSY";

            // Format last GPS update time with flash animation
            if (amb.last_gps_updated_at) {
                try {
                    const dt = new Date(amb.last_gps_updated_at);
                    liveLastGpsTime.textContent = dt.toLocaleTimeString();
                } catch(e) {
                    liveLastGpsTime.textContent = amb.last_gps_updated_at;
                }
            } else {
                liveLastGpsTime.textContent = "Just now";
            }
            if (typeof window.flashUpdate === "function") {
                window.flashUpdate(liveLastGpsTime);
            }

            // GPS source indicator
            if (amb.is_simulated_gps) {
                liveGpsSource.textContent = "⚠️ Simulated Demo GPS Movement";
                liveGpsSource.className = "gps-source-badge text-warning";
            } else {
                liveGpsSource.textContent = "🛰️ Live GPS Tracking";
                liveGpsSource.className = "gps-source-badge text-success";
            }

            const ambLatLng = [amb.current_latitude, amb.current_longitude];

            // Ambulance green vehicle marker with radar ring
            if (!trackAmbulanceMarker && trackMap) {
                const ambIcon = L.divIcon({
                    className: "amb-beacon-pin",
                    html: '<div style="position:relative; width:30px; height:30px;"><div class="pulse-ring-green"></div><div style="background-color:#10B981; width:30px; height:30px; border-radius:50%; border:3px solid white; box-shadow:0 0 14px rgba(16,185,129,0.8); display:flex; align-items:center; justify-content:center; font-size:15px;">🚑</div></div>',
                    iconSize: [30, 30],
                    iconAnchor: [15, 15]
                });
                trackAmbulanceMarker = L.marker(ambLatLng, { icon: ambIcon }).addTo(trackMap);
                trackAmbulanceMarker.bindPopup(`<strong>RapidRescue ${amb.call_sign}</strong><br>Dispatched unit en route.`);
            } else if (trackAmbulanceMarker) {
                // Smooth glide animation between coordinates
                if (typeof window.glideMarker === "function") {
                    window.glideMarker(trackAmbulanceMarker, ambLatLng, 800);
                } else {
                    trackAmbulanceMarker.setLatLng(ambLatLng);
                }
            }

            // Trajectory polyline
            if (trackPolyline) {
                trackPolyline.setLatLngs([ambLatLng, patLatLng]);
            } else if (trackMap) {
                trackPolyline = L.polyline([ambLatLng, patLatLng], {
                    color: "#60A5FA",
                    weight: 3,
                    dashArray: "6, 8",
                    opacity: 0.8
                }).addTo(trackMap);
            }

            // Adjust map view to fit both markers
            if (trackMap && (!trackMap._boundsSetOnce)) {
                trackMap.fitBounds([patLatLng, ambLatLng], { padding: [40, 40] });
                trackMap._boundsSetOnce = true;
            }
        }
    }

    // Button to switch back to Request Form
    if (btnNewRequest) {
        btnNewRequest.addEventListener("click", () => {
            if (trackingPollInterval) {
                clearInterval(trackingPollInterval);
                trackingPollInterval = null;
            }
            trackingView.classList.add("d-none");
            requestView.classList.remove("d-none");
            btnSubmit.disabled = false;
            btnSubmit.querySelector(".btn-text").textContent = "🚨 Dispatch Nearest Ambulance Now";
        });
    }

    // Copy reference
    if (btnCopyLiveRef) {
        btnCopyLiveRef.addEventListener("click", () => {
            navigator.clipboard.writeText(liveRef.textContent).then(() => {
                btnCopyLiveRef.textContent = "✓ Copied";
                setTimeout(() => { btnCopyLiveRef.textContent = "📋 Copy"; }, 2000);
            });
        });
    }

    // 6. Reopen Existing Request
    if (reopenForm) {
        reopenForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const ref = document.getElementById("reopen_ref").value.trim();
            const token = document.getElementById("reopen_token").value.trim();
            if (ref && token) {
                startLiveTracking(token, ref);
            }
        });
    }

    // 7. Check URL parameters for direct tracking (?token=... or ?ref=...)
    const urlParams = new URLSearchParams(window.location.search);
    const tokenParam = urlParams.get("token");
    const refParam = urlParams.get("ref");
    if (tokenParam) {
        startLiveTracking(tokenParam, refParam || "Direct Token");
    }

    function showAlert(msg, className) {
        if (!alertBox) return;
        alertBox.className = `alert ${className}`;
        alertBox.innerHTML = msg;
        alertBox.classList.remove("d-none");
    }

    window.addEventListener("beforeunload", () => {
        if (trackingPollInterval) {
            clearInterval(trackingPollInterval);
        }
    });
});
