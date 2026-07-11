/** Shared fail-closed confirmation surface for broker-facing execution plans. */
(function attachOrderConfirmationUi(globalScope) {
    function _escape(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function _format(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? String(Math.round(parsed * 10000) / 10000) : '--';
    }

    function open(context) {
        const doc = globalScope.document;
        if (!doc || !doc.body || !context || !context.intent || typeof context.onConfirm !== 'function') return false;
        let dialog = doc.getElementById('sharedOrderConfirmationDialog');
        if (!dialog) {
            dialog = doc.createElement('div');
            dialog.id = 'sharedOrderConfirmationDialog';
            dialog.className = 'close-confirmation-dialog';
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.innerHTML = `<div class="close-confirmation-panel" style="width:min(980px,96vw)">
                <div class="close-confirmation-header"><div><div class="close-confirmation-title shared-order-title"></div><div class="shared-order-subtitle text-muted small"></div></div><button type="button" class="btn btn-secondary btn-sm shared-order-cancel">Cancel</button></div>
                <div class="close-confirmation-live-warning shared-order-warning"></div>
                <div class="shared-order-position-impact"></div>
                <h4>Frozen order intent</h4><div class="close-confirmation-table-shell"><table class="close-confirmation-table"><thead><tr><th>Contract</th><th>Action</th><th>Quantity</th><th>Order</th></tr></thead><tbody class="shared-order-legs"></tbody></table></div>
                <div class="close-confirmation-footer"><span class="shared-order-expiry text-muted small"></span><div class="close-confirmation-footer-actions"><button type="button" class="btn btn-secondary shared-order-cancel">Cancel</button><button type="button" class="btn btn-primary shared-order-confirm">Confirm &amp; Submit to TWS</button></div></div>
            </div>`;
            const close = (cancel) => {
                const active = dialog._orderContext;
                dialog.style.display = 'none';
                dialog._orderContext = null;
                if (cancel && active && typeof active.onCancel === 'function') active.onCancel();
            };
            dialog.querySelectorAll('.shared-order-cancel').forEach((button) => button.addEventListener('click', () => close(true)));
            dialog.addEventListener('click', (event) => { if (event.target === dialog) close(true); });
            dialog.querySelector('.shared-order-confirm').addEventListener('click', () => {
                const active = dialog._orderContext;
                if (!active) return;
                const button = dialog.querySelector('.shared-order-confirm');
                button.disabled = true;
                const result = active.onConfirm();
                if (result !== false) close(false); else button.disabled = false;
            });
            doc.body.appendChild(dialog);
        }
        const intent = context.intent;
        const impact = context.positionImpact || { available: false, warnings: [] };
        const warnings = impact.warnings || [];
        dialog._orderContext = context;
        dialog.querySelector('.shared-order-title').textContent = context.title || 'Confirm Order';
        dialog.querySelector('.shared-order-subtitle').textContent = `${intent.source || 'Order'} · Account ${intent.account || 'not selected'}`;
        dialog.querySelector('.shared-order-warning').innerHTML = '<strong>LIVE TWS submission.</strong> Confirming sends this frozen order intent.';
        dialog.querySelector('.shared-order-position-impact').innerHTML = impact.available !== true
            ? `<div class="position-reduction-warning"><strong>Submission blocked.</strong> ${_escape(impact.blockingReason || 'The latest TWS position snapshot is unavailable.')}</div>`
            : (warnings.length ? `<div class="position-reduction-warning"><strong>WARNING: this order reduces an existing TWS position.</strong><ul style="margin:.5rem 0 0 1.2rem">${warnings.map((warning) => `<li><strong>${_escape(warning.label)}</strong>: current ${_format(warning.current)}, order ${_format(warning.orderDelta)}, projected ${_format(warning.projected)}. ${_escape((warning.otherGroupNames || []).length ? `Allocated to: ${warning.otherGroupNames.join(', ')}` : '')}</li>`).join('')}</ul></div>` : '<div class="close-confirmation-summary"><span class="leg-check-status-matched">✓ No existing TWS position is reduced.</span></div>');
        const orderDescription = intent.orderDescription
            || `${intent.orderType || ''}${intent.orderType === 'LMT' ? ` @ ${_format(intent.limitPrice)}` : ''}`;
        const managedDetails = intent.orderType === 'MANAGED'
            ? ` · ${intent.timeInForce || 'DAY'}${Number.isFinite(Number(intent.managedRepriceThreshold)) ? ` · drift ${_format(intent.managedRepriceThreshold)}` : ''}${Number.isFinite(Number(intent.managedConcessionRatio)) && Number(intent.managedConcessionRatio) > 0 ? ` · concession ${_format(Number(intent.managedConcessionRatio) * 100)}%` : ''}`
            : '';
        dialog.querySelector('.shared-order-legs').innerHTML = (intent.legs || []).map((leg) => `<tr><td>${_escape(`${leg.secType || ''} ${leg.symbol || ''} ${leg.contractMonth || ''}`.trim())}</td><td><strong>${Number(leg.pos) < 0 ? 'SELL' : 'BUY'}</strong></td><td>${_format(Math.abs(Number(leg.pos) || 0))}</td><td>${_escape(`${orderDescription}${managedDetails}`)}</td></tr>`).join('');
        const confirm = dialog.querySelector('.shared-order-confirm');
        confirm.disabled = impact.available !== true;
        confirm.title = impact.available === true ? '' : 'A fresh TWS position snapshot is required.';
        dialog.querySelector('.shared-order-expiry').textContent = context.expiresAt ? `Authorization expires ${context.expiresAt}` : 'The order must still match its broker preview at submission.';
        dialog.style.display = 'flex';
        return true;
    }

    globalScope.OptionComboOrderConfirmationUI = { open };
})(typeof globalThis !== 'undefined' ? globalThis : window);
