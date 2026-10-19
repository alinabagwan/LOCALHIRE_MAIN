// LocalHire - Escrow & Milestone Payment Module
// Isolated frontend module managing escrow payment flows, payment gateway simulations, job completion releases, and financial transaction ledgers.

(function () {
  'use strict';

  // LocalStorage helper for Escrow offline mode
  const getLocalEscrows = () => JSON.parse(localStorage.getItem('localHire_escrows') || '[]');
  const saveLocalEscrow = (escrow) => {
    const escrows = getLocalEscrows();
    escrows.unshift(escrow);
    localStorage.setItem('localHire_escrows', JSON.stringify(escrows));
  };

  const LocalHireEscrow = {
    // Open payment gateway simulation modal to lock funds in Escrow
    openFundModal: function (jobId, workerId, amount, onCompleteCallback) {
      const existingModal = document.getElementById('escrow-fund-modal');
      if (existingModal) existingModal.remove();

      const modalHtml = `
        <div id="escrow-fund-modal" class="escrow-modal-overlay">
          <div class="escrow-modal animate-fade-in">
            <div class="escrow-modal-header">
              <h3>🔒 Lock Payment in Escrow</h3>
              <button class="escrow-close-btn" onclick="document.getElementById('escrow-fund-modal').remove()">&times;</button>
            </div>
            
            <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 1rem;">
              Funds are held securely by LocalHire Escrow and will only be released to the worker when you confirm job completion.
            </p>

            <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                <span class="text-muted">Escrow Amount:</span>
                <strong style="font-size: 1.2rem; color: var(--primary);">₹${amount}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
                <span class="text-muted">Protection Fee:</span>
                <span style="color: #22c55e;">₹0 (Free Protection)</span>
              </div>
            </div>

            <label style="font-size: 0.85rem; font-weight: 600; color: var(--text-muted);">Select Payment Method:</label>
            <div class="escrow-method-selector">
              <div class="escrow-method-option selected" data-method="UPI (GPay/PhonePe)">📱 UPI / GPay</div>
              <div class="escrow-method-option" data-method="Credit / Debit Card">💳 Card</div>
              <div class="escrow-method-option" data-method="Net Banking">🏦 Net Banking</div>
            </div>

            <div style="margin-top: 1.5rem; display: flex; gap: 0.75rem; justify-content: flex-end;">
              <button class="btn btn-outline" onclick="document.getElementById('escrow-fund-modal').remove()">Cancel</button>
              <button id="btn-confirm-escrow" class="btn btn-primary" style="padding: 0.6rem 1.5rem;">Pay & Lock Escrow</button>
            </div>
          </div>
        </div>
      `;

      document.body.insertAdjacentHTML('beforeend', modalHtml);

      // Handle method selection
      const options = document.querySelectorAll('.escrow-method-option');
      let selectedMethod = 'UPI (GPay/PhonePe)';
      options.forEach(opt => {
        opt.addEventListener('click', () => {
          options.forEach(o => o.classList.remove('selected'));
          opt.classList.add('selected');
          selectedMethod = opt.getAttribute('data-method');
        });
      });

      // Handle confirm click
      document.getElementById('btn-confirm-escrow').addEventListener('click', async () => {
        const btn = document.getElementById('btn-confirm-escrow');
        btn.disabled = true;
        btn.innerText = 'Processing Payment...';

        try {
          let result;
          if (window.localHireAPI && window.localHireAPI.escrow && window.localHireAPI.escrow.fundEscrow) {
            result = await window.localHireAPI.escrow.fundEscrow(jobId, workerId, amount, selectedMethod);
          }

          document.getElementById('escrow-fund-modal').remove();

          if (!result || !result.success) {
            const blockedMessage = result && result.message
              ? result.message
              : 'Live payment processing is unavailable because no verified payment provider is configured yet.';

            if (typeof onCompleteCallback === 'function') {
              onCompleteCallback(false, blockedMessage);
            } else {
              alert(blockedMessage);
            }
            return;
          }

          if (typeof onCompleteCallback === 'function') {
            onCompleteCallback(true, result.message || 'Payment successfully locked in escrow.');
          } else {
            alert(result.message || 'Payment successfully locked in escrow.');
            window.location.reload();
          }
        } catch (err) {
          console.error('[Escrow Module] Error funding escrow:', err);
          alert('Live payment processing is temporarily unavailable. Please check the configured provider and try again.');
          btn.disabled = false;
          btn.innerText = 'Pay & Lock Escrow';
        }
      });
    },

    // Release escrow payment to worker and complete job
    releasePayment: async function (jobId, onCompleteCallback) {
      if (!confirm('Are you sure you want to mark this job as COMPLETED and release the escrow payment to the worker?')) {
        return;
      }

      try {
        let result;
        if (window.localHireAPI && window.localHireAPI.escrow && window.localHireAPI.escrow.releaseEscrow) {
          result = await window.localHireAPI.escrow.releaseEscrow(jobId);
        }

        let releaseSucceeded = !!(result && result.success);
        let releaseMessage = result && result.message ? result.message : 'Live payment processing is unavailable at the moment.';

        if (!releaseSucceeded) {
          releaseMessage = result && result.message ? result.message : 'Live payment processing is unavailable at the moment.';
        }

        alert(releaseMessage);
        if (typeof onCompleteCallback === 'function') {
          onCompleteCallback(releaseSucceeded, releaseMessage);
        } else if (releaseSucceeded) {
          window.location.reload();
        }
      } catch (err) {
        console.error('[Escrow Module] Error releasing payment:', err);
        alert('Could not release escrow payment.');
      }
    },

    // Open User Wallet Ledger Modal
    openWalletLedger: async function () {
      const existing = document.getElementById('escrow-ledger-modal');
      if (existing) existing.remove();

      const currentUser = window.localHireApp ? window.localHireApp.getCurrentUser() : null;
      let transactions = [];

      try {
        if (window.localHireAPI && window.localHireAPI.escrow && window.localHireAPI.escrow.getUserLedger) {
          transactions = await window.localHireAPI.escrow.getUserLedger();
        }
      } catch (e) {
        console.warn('[Escrow Module] API ledger offline, fetching local ledger');
      }

      if (!transactions || transactions.length === 0) {
        const local = getLocalEscrows();
        const cId = currentUser ? currentUser.id : null;
        transactions = local.filter(e => e.customer === cId || e.worker === cId);
      }

      let tableRows = '';
      if (transactions.length === 0) {
        tableRows = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">No transaction history found.</td></tr>`;
      } else {
        transactions.forEach(t => {
          const statusClass = t.status === 'Escrow_Held' ? 'escrow-held' : (t.status === 'Released' ? 'escrow-released' : 'escrow-disputed');
          const dateStr = new Date(t.createdAt || Date.now()).toLocaleDateString();
          tableRows += `
            <tr>
              <td><span style="font-family: monospace; font-size: 0.8rem;">${t.transactionRef || t.id}</span></td>
              <td>₹${t.amount}</td>
              <td><span class="escrow-badge ${statusClass}">${t.status.replace('_', ' ')}</span></td>
              <td>${t.paymentMethod || 'UPI'}</td>
              <td>${dateStr}</td>
            </tr>
          `;
        });
      }

      const modalHtml = `
        <div id="escrow-ledger-modal" class="escrow-modal-overlay">
          <div class="escrow-modal animate-fade-in" style="max-width: 680px; width: 95%;">
            <div class="escrow-modal-header">
              <h3>💳 Escrow Financial Ledger</h3>
              <button class="escrow-close-btn" onclick="document.getElementById('escrow-ledger-modal').remove()">&times;</button>
            </div>
            
            <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">
              Complete history of milestone escrow deposits, payouts, and settlements for your account.
            </p>

            <div style="max-height: 350px; overflow-y: auto;">
              <table class="ledger-table">
                <thead>
                  <tr>
                    <th>Ref ID</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Method</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  ${tableRows}
                </tbody>
              </table>
            </div>

            <div style="margin-top: 1.5rem; text-align: right;">
              <button class="btn btn-outline" onclick="document.getElementById('escrow-ledger-modal').remove()">Close</button>
            </div>
          </div>
        </div>
      `;

      document.body.insertAdjacentHTML('beforeend', modalHtml);
    }
  };

  // Export to global scope
  window.LocalHireEscrow = LocalHireEscrow;

  // Auto-inject wallet button into navbar if present
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      const navLinks = document.querySelector('.nav-links');
      const currentUser = window.localHireApp ? window.localHireApp.getCurrentUser() : null;

      if (navLinks && currentUser && !document.getElementById('nav-escrow-ledger')) {
        const walletBtn = document.createElement('a');
        walletBtn.id = 'nav-escrow-ledger';
        walletBtn.href = '#';
        walletBtn.style.cssText = 'text-decoration: none; color: var(--primary); font-weight: 500; display: flex; align-items: center; gap: 4px;';
        walletBtn.innerHTML = `<svg class="icon" style="width: 16px; height: 16px;" viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg> Wallet Ledger`;
        walletBtn.addEventListener('click', (e) => {
          e.preventDefault();
          LocalHireEscrow.openWalletLedger();
        });
        navLinks.appendChild(walletBtn);
      }
    }, 300);
  });

})();
