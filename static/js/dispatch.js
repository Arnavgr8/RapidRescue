/**
 * RapidRescue - Central Dispatch Overview & Demo Console JavaScript Module
 */
document.addEventListener("DOMContentLoaded", () => {
    const btnReseed = document.getElementById("btn-demo-reseed");
    const btnStepAll = document.getElementById("btn-demo-step-all");

    // Leaflet Overview Map
    const mapElement = document.getElementById("dispatch-map");
    if (mapElement && typeof L !== "undefined" && typeof FLEET_DATA !== "undefined") {
        const map = L.map("dispatch-map").setView([12.9716, 77.5946], 12);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 18
        }).addTo(map);

        const bounds = [];

        // Add Ambulances
        FLEET_DATA.forEach(amb => {
            if (amb.lat && amb.lon) {
                const color = amb.status === "AVAILABLE" ? "#10B981" : (amb.status === "BUSY" ? "#F59E0B" : "#64748B");
                const ambIcon = L.divIcon({
                    className: "overview-amb-pin",
                    html: `<div style="background-color:${color}; width:24px; height:24px; border-radius:50%; border:2px solid white; display:flex; align-items:center; justify-content:center; font-size:12px; box-shadow:0 0 8px ${color};">🚑</div>`,
                    iconSize: [24, 24],
                    iconAnchor: [12, 12]
                });

                const m = L.marker([amb.lat, amb.lon], { icon: ambIcon }).addTo(map);
                m.bindPopup(`<strong>${amb.call_sign}</strong><br>Status: ${amb.status}<br>GPS: ${amb.is_simulated ? 'Simulated' : 'Live'}`);
                bounds.push([amb.lat, amb.lon]);
            }
        });

        // Add Emergencies
        if (typeof EMERGENCY_DATA !== "undefined") {
            EMERGENCY_DATA.forEach(em => {
                if (em.lat && em.lon) {
                    const emIcon = L.divIcon({
                        className: "overview-em-pin",
                        html: '<div style="background-color:#EF4444; width:20px; height:20px; border-radius:50%; border:2px solid white; display:flex; align-items:center; justify-content:center; font-size:10px;">🚨</div>',
                        iconSize: [20, 20],
                        iconAnchor: [10, 10]
                    });
                    const emMarker = L.marker([em.lat, em.lon], { icon: emIcon }).addTo(map);
                    emMarker.bindPopup(`<strong>Emergency: ${em.ref}</strong><br>Status: ${em.status}`);
                    bounds.push([em.lat, em.lon]);
                }
            });
        }

        if (bounds.length > 0) {
            map.fitBounds(bounds, { padding: [40, 40] });
        }
    }

    // Reset Demo Fleet Handler
    if (btnReseed) {
        btnReseed.addEventListener("click", async () => {
            if (!confirm("Reset and re-seed the demo fleet to initial state?")) return;
            btnReseed.disabled = true;
            try {
                const resp = await fetch("/api/demo/seed", { method: "POST" });
                const data = await resp.json();
                if (resp.ok && data.success) {
                    alert("Demo fleet re-seeded successfully!");
                    window.location.reload();
                } else {
                    alert(data.error || "Failed to re-seed demo fleet.");
                }
            } catch (err) {
                alert("Network error resetting demo fleet.");
            } finally {
                btnReseed.disabled = false;
            }
        });
    }

    // Step All Busy Ambulances
    if (btnStepAll) {
        btnStepAll.addEventListener("click", async () => {
            btnStepAll.disabled = true;
            try {
                const resp = await fetch("/api/demo/step-simulation", { method: "POST" });
                const data = await resp.json();
                if (resp.ok && data.success) {
                    window.location.reload();
                } else {
                    alert(data.error || "Could not step simulation.");
                }
            } catch (err) {
                alert("Network error stepping simulation.");
            } finally {
                btnStepAll.disabled = false;
            }
        });
    }
});

