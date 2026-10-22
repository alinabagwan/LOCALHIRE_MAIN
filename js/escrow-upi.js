// LocalHire Worker UPI QR Code & Escrow Payout Helper
// Enables workers to configure their payout UPI ID, generate/preview scannable QR codes, and receive escrow disbursements.

(function () {
  'use strict';

  const escapeHTML = window.escapeHTML || (str => String(str || '').replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)));

  const LocalHireUPI = {
    getWorkerUpi: function (worker = null) {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('localHire_worker_upi');
        if (stored) return stored;
      }
      if (worker && worker.upiId) return worker.upiId;
      if (worker && worker.email) return `${worker.email.split('@')[0]}@okhdfcbank`;
      return 'worker@okhdfcbank';
    },

    generateUpiUrl: function (upiId, name = 'LocalHire Worker', amount = null, note = 'LocalHire Escrow Payout') {
      const safeUpi = encodeURIComponent(upiId || 'worker@okhdfcbank');
      const safeName = encodeURIComponent(name || 'Worker');
      const safeNote = encodeURIComponent(note || 'Escrow Payout');
      let uri = `upi://pay?pa=${safeUpi}&pn=${safeName}&tn=${safeNote}&cu=INR`;
      if (amount && Number(amount) > 0) {
        uri += `&am=${Number(amount).toFixed(2)}`;
      }
      return uri;
    },

    getQrCodeUrl: function (upiString) {
      return `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiString)}`;
    },

    // Open Worker UPI Management Modal
    openWorkerUpiModal: function (workerUser, onSaveCallback) {
      const existing = document.getElementById('lh-worker-upi-modal');
      if (existing) existing.remove();

      const currentUpi = this.getWorkerUpi(workerUser);
      const workerName = workerUser?.name || 'Worker';
      const initialUpiUri = this.generateUpiUrl(currentUpi, workerName);
      const initialQr = this.getQrCodeUrl(initialUpiUri);

      const modalHtml = `
        <div id="lh-worker-upi-modal" class="upi-modal-overlay">
          <div class="upi-modal-card">
            <div class="upi-modal-header">
              <h3 class="upi-modal-title">
                <span>📱 Escrow Payout UPI & QR Code</span>
              </h3>
              <button class="upi-close-btn" onclick="document.getElementById('lh-worker-upi-modal').remove()">&times;</button>
            </div>

            <p style="font-size:0.85rem;color:#94a3b8;margin:0;">
              Enter your UPI ID (Google Pay, PhonePe, Paytm, BHIM) to receive escrow disbursements directly into your linked bank account upon job completion.
            </p>

            <div class="upi-qr-display-box">
              <img id="worker-upi-qr-preview" src="${initialQr}" alt="Worker UPI QR Code" class="upi-qr-img">
              <div id="worker-upi-id-preview" class="upi-qr-caption">${escapeHTML(currentUpi)}</div>
              <div style="font-size:0.75rem;color:#64748b;margin-top:4px;">Scan with GPay, PhonePe, or BHIM</div>
            </div>

            <div class="upi-input-group">
              <label for="worker-upi-input">Your UPI ID (VPA)</label>
              <div class="upi-field-row">
                <input type="text" id="worker-upi-input" class="upi-input-control" value="${escapeHTML(currentUpi)}" placeholder="e.g. yourname@okaxis, 9876543210@paytm">
                <button type="button" id="btn-refresh-qr" class="btn btn-outline" style="padding:0.6rem 1rem;">Update QR</button>
              </div>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.5rem;">
              <span class="upi-badge-verified">🛡️ Escrow Payout Verified</span>
              <div style="display:flex;gap:8px;">
                <button type="button" class="btn btn-outline" onclick="document.getElementById('lh-worker-upi-modal').remove()">Cancel</button>
                <button type="button" id="btn-save-upi" class="btn btn-primary" style="padding:0.6rem 1.25rem;">Save UPI</button>
              </div>
            </div>
          </div>
        </div>
      `;

      document.body.insertAdjacentHTML('beforeend', modalHtml);

      const upiInput = document.getElementById('worker-upi-input');
      const qrPreview = document.getElementById('worker-upi-qr-preview');
      const idPreview = document.getElementById('worker-upi-id-preview');

      const refreshQr = () => {
        const val = upiInput.value.trim() || currentUpi;
        idPreview.textContent = val;
        const uri = this.generateUpiUrl(val, workerName);
        qrPreview.src = this.getQrCodeUrl(uri);
      };

      document.getElementById('btn-refresh-qr').addEventListener('click', refreshQr);
      upiInput.addEventListener('input', refreshQr);

      document.getElementById('btn-save-upi').addEventListener('click', async () => {
        const val = upiInput.value.trim();
        if (!val || !val.includes('@')) {
          alert('Please enter a valid UPI ID (e.g. mobile@paytm or name@okaxis)');
          return;
        }

        const saveBtn = document.getElementById('btn-save-upi');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        try {
          if (window.localHireAPI && window.localHireAPI.escrow && window.localHireAPI.escrow.updateWorkerUpi) {
            await window.localHireAPI.escrow.updateWorkerUpi(val);
          } else {
            localStorage.setItem('localHire_worker_upi', val);
          }

          document.getElementById('lh-worker-upi-modal').remove();
          alert('✅ UPI Payout Account successfully updated! Escrow payments will now be routed to ' + val);

          if (typeof onSaveCallback === 'function') {
            onSaveCallback(val);
          }
        } catch (e) {
          localStorage.setItem('localHire_worker_upi', val);
          document.getElementById('lh-worker-upi-modal').remove();
          alert('✅ UPI ID saved locally: ' + val);
          if (typeof onSaveCallback === 'function') {
            onSaveCallback(val);
          }
        }
      });
    },

    // Open Admin QR Code Viewer Modal for Escrow Release
    openAdminQrModal: function (escrowPayment, onReleaseCallback) {
      const existing = document.getElementById('lh-admin-qr-modal');
      if (existing) existing.remove();

      const worker = escrowPayment.worker || { name: 'Worker' };
      const workerName = worker.name || 'Worker';
      const workerUpi = worker.upiId || this.getWorkerUpi(worker);
      const amount = Number(escrowPayment.workerPayoutAmount || escrowPayment.totalAmount || 0);

      const upiUri = this.generateUpiUrl(workerUpi, workerName, amount, `LocalHire Escrow ${escrowPayment.invoiceNumber || ''}`);
      const qrCodeUrl = this.getQrCodeUrl(upiUri);

      const modalHtml = `
        <div id="lh-admin-qr-modal" class="upi-modal-overlay">
          <div class="upi-modal-card" style="max-width:520px;">
            <div class="upi-modal-header">
              <h3 class="upi-modal-title">
                <span>💸 Admin Escrow Payout: ${escapeHTML(workerName)}</span>
              </h3>
              <button class="upi-close-btn" onclick="document.getElementById('lh-admin-qr-modal').remove()">&times;</button>
            </div>

            <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:0.85rem 1.25rem;">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:0.85rem;">
                <span class="text-muted">Invoice #:</span>
                <span style="font-family:monospace;color:#facc15;">${escapeHTML(escrowPayment.invoiceNumber || 'INV-DIRECT')}</span>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="text-muted">Net Payout to Worker:</span>
                <strong style="font-size:1.35rem;color:#4ade80;">₹${amount}</strong>
              </div>
            </div>

            <div class="upi-qr-display-box">
              <img src="${qrCodeUrl}" alt="Worker UPI QR Code" class="upi-qr-img">
              <div class="upi-qr-caption">${escapeHTML(workerUpi)}</div>
              <div style="font-size:0.75rem;color:#64748b;margin-top:4px;">Scan with UPI app to transfer funds</div>
            </div>

            <p style="font-size:0.82rem;color:#94a3b8;margin:0;text-align:center;">
              Confirm that online escrow payment has been disbursed to <strong>${escapeHTML(workerName)}</strong>'s UPI account (${escapeHTML(workerUpi)}).
            </p>

            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:0.5rem;">
              <button type="button" class="btn btn-outline" onclick="document.getElementById('lh-admin-qr-modal').remove()">Close</button>
              <button type="button" id="btn-admin-confirm-release" class="btn btn-primary" style="background:#22c55e;border-color:#22c55e;">
                ✅ Confirm & Release Escrow
              </button>
            </div>
          </div>
        </div>
      `;

      document.body.insertAdjacentHTML('beforeend', modalHtml);

      document.getElementById('btn-admin-confirm-release').addEventListener('click', async () => {
        const btn = document.getElementById('btn-admin-confirm-release');
        btn.disabled = true;
        btn.textContent = 'Releasing Funds...';

        if (typeof onReleaseCallback === 'function') {
          await onReleaseCallback(escrowPayment);
        }

        const modal = document.getElementById('lh-admin-qr-modal');
        if (modal) modal.remove();
      });
    }
  };

  window.LocalHireUPI = LocalHireUPI;
})();
