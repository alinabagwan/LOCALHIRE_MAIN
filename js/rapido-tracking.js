// LocalHire Rapido-Style Real-Time GPS Tracking Module
// Renders an immersive Rapido/Uber-like live dispatch screen with animated vehicle movement, route polylines, live ETA, and call/message actions.

(function () {
  'use strict';

  let currentMap = null;
  let workerMarker = null;
  let customerMarker = null;
  let routeLine = null;
  let simulationInterval = null;
  let simulationIndex = 0;
  let simulatedWaypoints = [];
  let trackingSocket = null;

  function calculateDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Number((R * c).toFixed(2));
  }

  // Generate realistic route waypoints between worker and customer
  function generateWaypoints(startLat, startLng, endLat, endLng, steps = 30) {
    const waypoints = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Introduce slight curved jitter for realistic street trajectory
      const curve = Math.sin(t * Math.PI) * 0.0035;
      const lat = startLat + (endLat - startLat) * t + curve;
      const lng = startLng + (endLng - startLng) * t + (curve * 0.8);
      waypoints.push([lat, lng]);
    }
    return waypoints;
  }

  function playArrivalChime() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.15); // E5
      osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.3); // G5
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
    } catch (e) {}
  }

  const RapidoTracking = {
    open: function (options = {}) {
      this.close();

      const bookingId = options.bookingId || 'BK-LIVE';
      const role = options.currentUserRole || 'Customer';
      const isWorker = role === 'Worker';

      const worker = options.worker || {
        id: 'w-default',
        name: 'Marcus Chen',
        category: 'Licensed Electrician',
        phone: '+91 90000 00003',
        avatarUrl: 'https://api.dicebear.com/7.x/avataaars/svg?seed=MarcusC',
        rating: 4.9
      };

      const customer = options.customer || {
        id: 'c-default',
        name: 'Alice Henderson',
        phone: '+91 90000 00002',
        avatarUrl: 'https://api.dicebear.com/7.x/avataaars/svg?seed=AliceH'
      };

      const otp = options.otp || '4821';
      const targetUser = isWorker ? customer : worker;

      // Base coordinates
      const custLat = options.customerLat || 15.8368;
      const custLng = options.customerLng || 74.5057;
      const workLat = options.workerLat || 15.8589;
      const workLng = options.workerLng || 74.5215;

      const initialDist = calculateDistanceKm(workLat, workLng, custLat, custLng);
      const initialEta = Math.max(2, Math.round(initialDist * 3));

      const overlay = document.createElement('div');
      overlay.id = 'rapido-tracking-overlay';
      overlay.className = 'rapido-overlay';
      overlay.innerHTML = `
        <div class="rapido-container animate-fade-in">
          <!-- Header -->
          <div class="rapido-header">
            <div style="display:flex;align-items:center;gap:12px;">
              <span class="rapido-brand-badge">🛵 RAPIDO LIVE</span>
              <div class="rapido-header-title">
                <span style="font-weight:700;font-size:1rem;color:#f8fafc;">
                  ${isWorker ? 'Navigation to Customer' : 'Worker Coming to You'}
                </span>
                <span class="text-muted" style="font-size:0.75rem;">Booking #${options.bookingNumber || bookingId}</span>
              </div>
            </div>
            <button class="rapido-close-btn" id="rapido-close-x" title="Close Tracking Screen">&times;</button>
          </div>

          <!-- Map -->
          <div class="rapido-map-wrap">
            <div id="rapido-floating-eta" class="rapido-floating-eta">
              <span class="rapido-eta-pill">⚡ ETA: <span id="rapido-eta-text">${initialEta} mins</span></span>
              <span style="color:#64748b;">|</span>
              <span id="rapido-dist-text">${initialDist} km away</span>
              <span style="color:#64748b;">|</span>
              <span id="rapido-speed-text" style="color:#38bdf8;">28 km/h</span>
            </div>
            <div id="rapido-leaflet-map"></div>
          </div>

          <!-- Bottom Sheet -->
          <div class="rapido-bottom-sheet">
            <div class="rapido-worker-row">
              <div class="rapido-worker-profile">
                <img src="${targetUser.avatarUrl || 'https://api.dicebear.com/7.x/avataaars/svg?seed=agent'}" alt="${targetUser.name}" class="rapido-worker-avatar">
                <div class="rapido-worker-info">
                  <h4>${targetUser.name}</h4>
                  <div class="rapido-vehicle-badge">
                    <span>🛵 LocalHire Hero Captain</span>
                    <span style="color:#f8fafc;margin-left:4px;">★ ${worker.rating || '4.9'}</span>
                  </div>
                </div>
              </div>

              <div class="rapido-otp-box">
                <div class="rapido-otp-label">${isWorker ? 'Collect OTP' : 'Start OTP'}</div>
                <div class="rapido-otp-code">${otp}</div>
              </div>
            </div>

            <!-- Actions Bar -->
            <div class="rapido-actions-bar">
              <button id="rapido-btn-call" class="rapido-btn rapido-btn-call" title="Call ${targetUser.name}">
                <svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path></svg>
                <span>Call ${isWorker ? 'Customer' : 'Worker'}</span>
              </button>

              <button id="rapido-btn-chat" class="rapido-btn rapido-btn-chat" title="Send message to ${targetUser.name}">
                <svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                <span>Chat</span>
              </button>

              <button id="rapido-btn-simulate" class="rapido-btn rapido-btn-simulate" title="Simulate Worker Driving towards Location">
                <span>▶ Live Trip Demo</span>
              </button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      // Handle close
      document.getElementById('rapido-close-x').addEventListener('click', () => this.close());

      // Handle Call
      document.getElementById('rapido-btn-call').addEventListener('click', () => {
        if (window.LocalHireCalling) {
          window.LocalHireCalling.startCall({
            name: targetUser.name,
            role: isWorker ? 'Customer' : (worker.category || 'Service Professional'),
            phone: targetUser.phone,
            avatarUrl: targetUser.avatarUrl,
            bookingId
          });
        }
      });

      // Handle Chat
      document.getElementById('rapido-btn-chat').addEventListener('click', () => {
        if (targetUser.id) {
          window.location.href = `chat.html?userId=${encodeURIComponent(targetUser.id)}&bookingId=${encodeURIComponent(bookingId)}`;
        }
      });

      // Initialize Leaflet Map
      setTimeout(() => {
        if (!window.L) {
          alert('Map library is loading. Please try again in a moment.');
          return;
        }

        const mapEl = document.getElementById('rapido-leaflet-map');
        if (!mapEl) return;

        currentMap = L.map(mapEl, {
          zoomControl: true,
          attributionControl: false
        }).setView([(workLat + custLat) / 2, (workLng + custLng) / 2], 14);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19
        }).addTo(currentMap);

        // Custom Worker Bike Icon
        const bikeIcon = L.divIcon({
          className: 'custom-rapido-icon',
          html: `<div class="rapido-bike-marker">🛵</div>`,
          iconSize: [44, 44],
          iconAnchor: [22, 22]
        });

        // Custom Customer Home Icon
        const custIcon = L.divIcon({
          className: 'custom-cust-icon',
          html: `<div class="rapido-customer-marker">📍</div>`,
          iconSize: [40, 40],
          iconAnchor: [20, 20]
        });

        workerMarker = L.marker([workLat, workLng], { icon: bikeIcon }).addTo(currentMap)
          .bindPopup(`<b>${worker.name}</b><br>🛵 On the way to pick up / arrive`)
          .openPopup();

        customerMarker = L.marker([custLat, custLng], { icon: custIcon }).addTo(currentMap)
          .bindPopup(`<b>${customer.name} (Destination)</b><br>Service Location`);

        simulatedWaypoints = generateWaypoints(workLat, workLng, custLat, custLng, 35);

        // Draw Route Polyline
        routeLine = L.polyline(simulatedWaypoints, {
          color: '#facc15',
          weight: 5,
          opacity: 0.85,
          dashArray: '8, 8',
          lineCap: 'round'
        }).addTo(currentMap);

        currentMap.fitBounds(routeLine.getBounds(), { padding: [50, 50] });

        // Connect real-time socket tracking if available
        if (window.localHireAPI && window.localHireAPI.tracking) {
          trackingSocket = window.localHireAPI.tracking.connect(bookingId, {
            onLocation: (payload) => {
              if (payload && payload.location && workerMarker) {
                const lat = payload.location.latitude;
                const lng = payload.location.longitude;
                workerMarker.setLatLng([lat, lng]);
                currentMap.panTo([lat, lng]);
                const remainingDist = calculateDistanceKm(lat, lng, custLat, custLng);
                const etaMins = Math.max(1, Math.round(remainingDist * 2.5));
                document.getElementById('rapido-dist-text').textContent = `${remainingDist} km away`;
                document.getElementById('rapido-eta-text').textContent = `${etaMins} mins`;
              }
            }
          });
        }

        // Handle Simulation Demo Button
        const simBtn = document.getElementById('rapido-btn-simulate');
        let isSimulating = false;

        simBtn.addEventListener('click', () => {
          if (isSimulating) {
            clearInterval(simulationInterval);
            isSimulating = false;
            simBtn.innerHTML = '<span>▶ Resume Demo</span>';
            return;
          }

          isSimulating = true;
          simBtn.innerHTML = '<span>⏸ Pause Demo</span>';

          if (simulationIndex >= simulatedWaypoints.length - 1) {
            simulationIndex = 0; // restart
          }

          simulationInterval = setInterval(() => {
            if (simulationIndex >= simulatedWaypoints.length) {
              clearInterval(simulationInterval);
              isSimulating = false;
              simBtn.innerHTML = '<span>✅ Worker Arrived</span>';
              document.getElementById('rapido-eta-text').textContent = 'ARRIVED';
              document.getElementById('rapido-dist-text').textContent = '0.0 km';
              document.getElementById('rapido-speed-text').textContent = '0 km/h';

              const bikeMarkerEl = document.querySelector('.rapido-bike-marker');
              if (bikeMarkerEl) {
                bikeMarkerEl.style.background = '#22c55e';
                bikeMarkerEl.innerHTML = '✅';
              }

              workerMarker.bindPopup(`<b>${worker.name} has Arrived!</b><br>Ready to start job`).openPopup();
              playArrivalChime();
              return;
            }

            const pt = simulatedWaypoints[simulationIndex];
            workerMarker.setLatLng(pt);
            currentMap.panTo(pt, { animate: true, duration: 0.5 });

            const remainingDist = calculateDistanceKm(pt[0], pt[1], custLat, custLng);
            const eta = Math.max(1, Math.round(remainingDist * 2.5));
            const speed = Math.floor(25 + Math.random() * 8);

            document.getElementById('rapido-dist-text').textContent = `${remainingDist} km away`;
            document.getElementById('rapido-eta-text').textContent = `${eta} mins`;
            document.getElementById('rapido-speed-text').textContent = `${speed} km/h`;

            simulationIndex++;
          }, 800);
        });
      }, 250);
    },

    close: function () {
      if (simulationInterval) {
        clearInterval(simulationInterval);
        simulationInterval = null;
      }
      simulationIndex = 0;
      if (currentMap) {
        try {
          currentMap.remove();
        } catch (e) {}
        currentMap = null;
      }
      const overlay = document.getElementById('rapido-tracking-overlay');
      if (overlay) overlay.remove();
    }
  };

  window.RapidoTracking = RapidoTracking;
})();
