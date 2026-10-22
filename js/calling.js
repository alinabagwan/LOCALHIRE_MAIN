// LocalHire In-App Calling & Communications Module
// Supports seamless two-way voice call simulation, direct dialer link, and message dispatch.

(function () {
  'use strict';

  let currentCallInterval = null;
  let callSeconds = 0;
  let audioCtx = null;
  let oscillator = null;
  let gainNode = null;
  let isRinging = false;

  // Synthesize realistic ringtone using Web Audio API
  function playRingtone() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      audioCtx = new AudioContext();

      const playToneBurst = () => {
        if (!isRinging || !audioCtx) return;
        try {
          oscillator = audioCtx.createOscillator();
          gainNode = audioCtx.createGain();

          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(440, audioCtx.currentTime); // Standard 440Hz

          gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
          gainNode.gain.linearRampToValueAtTime(0.08, audioCtx.currentTime + 0.1);
          gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 1.2);

          oscillator.connect(gainNode);
          gainNode.connect(audioCtx.destination);

          oscillator.start(audioCtx.currentTime);
          oscillator.stop(audioCtx.currentTime + 1.3);
        } catch (e) {}

        if (isRinging) {
          setTimeout(playToneBurst, 3000); // Ring interval
        }
      };

      isRinging = true;
      playToneBurst();
    } catch (e) {
      console.warn('[Calling] Web Audio tone unavailable:', e.message);
    }
  }

  function stopRingtone() {
    isRinging = false;
    if (audioCtx) {
      try {
        audioCtx.close();
      } catch (e) {}
      audioCtx = null;
    }
  }

  const LocalHireCalling = {
    startCall: function (participant = {}) {
      this.endCall(); // Clear any existing call

      const name = participant.name || 'LocalHire Professional';
      const role = participant.role || 'Service Professional';
      const phone = participant.phone || '+91 90000 00000';
      const avatar = participant.avatarUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name)}`;

      const overlay = document.createElement('div');
      overlay.id = 'lh-active-call-modal';
      overlay.className = 'lh-call-overlay';
      overlay.innerHTML = `
        <div class="lh-call-top">
          <div class="lh-call-security">
            <svg style="width:13px;height:13px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            <span>HD Secure Voice Calling</span>
          </div>
        </div>

        <div class="lh-call-center">
          <div class="lh-avatar-pulse-container">
            <div class="lh-pulse-ring"></div>
            <div class="lh-pulse-ring"></div>
            <img src="${avatar}" alt="${name}" class="lh-call-avatar">
          </div>

          <h2 class="lh-call-name">${name}</h2>
          <span class="lh-call-role-badge">${role}</span>

          <div id="lh-call-state-text" class="lh-call-status">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#38bdf8;animation:pulse 1.5s infinite;"></span>
            <span>Ringing...</span>
          </div>
          <div id="lh-call-timer-display" class="lh-call-timer" style="display:none;">00:00</div>
        </div>

        <div class="lh-call-bottom">
          <div class="lh-call-tools">
            <button id="lh-btn-mute" class="lh-tool-btn" title="Mute Microphone">🎤</button>
            <button id="lh-btn-speaker" class="lh-tool-btn" title="Speaker Phone">🔊</button>
            <button id="lh-btn-connect-now" class="lh-tool-btn" title="Simulate Answer" style="background:rgba(34,197,94,0.2);border-color:rgba(34,197,94,0.4);font-size:0.85rem;">⚡ Connect</button>
          </div>

          <div class="lh-call-actions">
            <button id="lh-btn-end-call" class="lh-end-call-btn" title="End Call">
              <svg style="width:28px;height:28px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path><line x1="23" y1="1" x2="1" y2="23"></line></svg>
            </button>
          </div>

          <a href="tel:${phone.replace(/\s+/g, '')}" class="lh-direct-cell-btn" title="Switch to Cellular Phone Call">
            <span>📱 Real Mobile Dial: ${phone}</span>
          </a>
        </div>
      `;

      document.body.appendChild(overlay);
      playRingtone();

      let connected = false;
      const connectCall = () => {
        if (connected) return;
        connected = true;
        stopRingtone();

        const stateText = document.getElementById('lh-call-state-text');
        const timerDisplay = document.getElementById('lh-call-timer-display');
        const rings = overlay.querySelectorAll('.lh-pulse-ring');
        rings.forEach(r => r.style.borderColor = 'rgba(74, 222, 128, 0.4)');

        if (stateText) {
          stateText.innerHTML = '<span style="color:#4ade80;">● Connected</span>';
        }
        if (timerDisplay) {
          timerDisplay.style.display = 'block';
        }

        callSeconds = 0;
        currentCallInterval = setInterval(() => {
          callSeconds++;
          const mins = String(Math.floor(callSeconds / 60)).padStart(2, '0');
          const secs = String(callSeconds % 60).padStart(2, '0');
          if (timerDisplay) {
            timerDisplay.textContent = `${mins}:${secs}`;
          }
        }, 1000);
      };

      // Auto-connect after 3 seconds for realistic simulation
      const autoConnectTimeout = setTimeout(connectCall, 3000);

      document.getElementById('lh-btn-connect-now').addEventListener('click', () => {
        clearTimeout(autoConnectTimeout);
        connectCall();
      });

      document.getElementById('lh-btn-end-call').addEventListener('click', () => {
        clearTimeout(autoConnectTimeout);
        this.endCall();
      });

      // Mute toggle
      let isMuted = false;
      const muteBtn = document.getElementById('lh-btn-mute');
      muteBtn.addEventListener('click', () => {
        isMuted = !isMuted;
        muteBtn.classList.toggle('active', isMuted);
        muteBtn.textContent = isMuted ? '🔇' : '🎤';
      });

      // Speaker toggle
      let isSpeaker = false;
      const speakerBtn = document.getElementById('lh-btn-speaker');
      speakerBtn.addEventListener('click', () => {
        isSpeaker = !isSpeaker;
        speakerBtn.classList.toggle('active', isSpeaker);
      });
    },

    endCall: function () {
      stopRingtone();
      if (currentCallInterval) {
        clearInterval(currentCallInterval);
        currentCallInterval = null;
      }

      const modal = document.getElementById('lh-active-call-modal');
      if (modal) {
        const stateText = document.getElementById('lh-call-state-text');
        if (stateText) stateText.innerHTML = '<span style="color:#ef4444;">Call Ended</span>';
        setTimeout(() => modal.remove(), 600);
      }
    },

    openChat: function (participantId, bookingId = null) {
      if (!participantId) return;
      const url = `chat.html?userId=${encodeURIComponent(participantId)}${bookingId ? '&bookingId=' + encodeURIComponent(bookingId) : ''}`;
      window.location.href = url;
    }
  };

  window.LocalHireCalling = LocalHireCalling;
})();
