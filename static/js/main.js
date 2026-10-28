/**
 * RapidRescue - Core Frontend Interactions & Vanilla JS Animations
 */
document.addEventListener("DOMContentLoaded", () => {
    // 1. Mobile navigation
    const menuToggle = document.getElementById("menu-toggle");
    const navLinks = document.getElementById("nav-links");

    if (menuToggle && navLinks) {
        menuToggle.addEventListener("click", () => {
            const isOpen = navLinks.classList.toggle("open");
            menuToggle.setAttribute("aria-expanded", String(isOpen));
            menuToggle.textContent = isOpen ? "✕" : "☰";
        });

        navLinks.querySelectorAll("a").forEach((link) => {
            link.addEventListener("click", () => {
                navLinks.classList.remove("open");
                menuToggle.setAttribute("aria-expanded", "false");
                menuToggle.textContent = "☰";
            });
        });
    }

    // 2. Dynamic footer year
    const yearElement = document.getElementById("year");
    if (yearElement) {
        yearElement.textContent = new Date().getFullYear();
    }

    // 3. Vanilla JS Button Ripple Animation
    document.addEventListener("click", (e) => {
        const btn = e.target.closest(".btn, button:not(.btn-copy)");
        if (!btn || btn.disabled) return;

        const circle = document.createElement("span");
        circle.classList.add("btn-ripple");

        const diameter = Math.max(btn.clientWidth, btn.clientHeight);
        const radius = diameter / 2;

        const rect = btn.getBoundingClientRect();
        circle.style.width = circle.style.height = `${diameter}px`;
        circle.style.left = `${e.clientX - rect.left - radius}px`;
        circle.style.top = `${e.clientY - rect.top - radius}px`;

        const existingRipple = btn.querySelector(".btn-ripple");
        if (existingRipple) {
            existingRipple.remove();
        }

        btn.appendChild(circle);
        setTimeout(() => {
            circle.remove();
        }, 600);
    });
});

/**
 * Global Vanilla JS Animation Helper: Flash Highlight on Element Update
 * Visually confirms when live GPS coordinates or polling statuses update
 */
window.flashUpdate = function(element) {
    if (!element) return;
    element.classList.remove("flash-update");
    // Trigger reflow to restart animation
    void element.offsetWidth;
    element.classList.add("flash-update");
};

/**
 * Global Vanilla JS Animation Helper: Smooth Number Counter
 * Interpolates numeric values smoothly (e.g. distance: 3.20 km -> 2.85 km)
 */
window.animateCounter = function(element, startVal, endVal, duration = 400, decimals = 2) {
    if (!element || isNaN(startVal) || isNaN(endVal)) return;
    const start = parseFloat(startVal);
    const end = parseFloat(endVal);
    if (start === end) return;

    const startTime = performance.now();

    function step(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease-out cubic
        const ease = 1 - Math.pow(1 - progress, 3);
        const current = start + (end - start) * ease;
        element.textContent = current.toFixed(decimals);

        if (progress < 1) {
            requestAnimationFrame(step);
        } else {
            element.textContent = end.toFixed(decimals);
        }
    }

    requestAnimationFrame(step);
};

/**
 * Global Vanilla JS Animation Helper: Smooth Leaflet Marker Glide
 * Glides vehicle marker smoothly between coordinates instead of jumping
 */
window.glideMarker = function(marker, targetLatLng, duration = 800) {
    if (!marker || !targetLatLng) return;
    const fromLatLng = marker.getLatLng();
    const fromLat = fromLatLng.lat;
    const fromLng = fromLatLng.lng;
    const toLat = targetLatLng[0];
    const toLng = targetLatLng[1];

    if (Math.abs(fromLat - toLat) < 0.000001 && Math.abs(fromLng - toLng) < 0.000001) {
        return;
    }

    const startTime = performance.now();

    function animate(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease out quadratic
        const ease = 1 - (1 - progress) * (1 - progress);

        const curLat = fromLat + (toLat - fromLat) * ease;
        const curLng = fromLng + (toLng - fromLng) * ease;
        marker.setLatLng([curLat, curLng]);

        if (progress < 1) {
            requestAnimationFrame(animate);
        } else {
            marker.setLatLng([toLat, toLng]);
        }
    }

    requestAnimationFrame(animate);
};
