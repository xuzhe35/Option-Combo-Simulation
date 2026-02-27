/**
 * WebSocket & Live Data Integration
 * ====================================
 * Extracted from app.js for maintainability.
 *
 * Depends on (global):
 *   - state, currencyFormatter, flashElement   (app.js)
 *   - updateDerivedValues                       (app.js)
 */

// -------------------------------------------------------------
// WebSocket Connection (Exponential Backoff)
// -------------------------------------------------------------

let ws = null;
let isWsConnected = false;

// Exponential backoff state
const WS_BASE_DELAY = 5000;   // 5s initial
const WS_MAX_DELAY = 60000;   // 60s cap
let _wsReconnectDelay = WS_BASE_DELAY;
let _wsReconnectTimer = null;

function updateWsStatusUI(status, nextRetrySec) {
    const el = document.getElementById('wsStatus');
    if (!el) return;
    if (status === 'connected') {
        el.textContent = '🟢 Connected';
        el.className = 'ws-status ws-connected';
    } else if (status === 'error') {
        el.textContent = '🔴 Error';
        el.className = 'ws-status ws-error';
    } else {
        // disconnected
        const suffix = nextRetrySec != null ? ` — Retry in ${nextRetrySec}s` : '';
        el.textContent = `🔴 Disconnected${suffix}`;
        el.className = 'ws-status ws-disconnected';
    }
}

function connectWebSocket() {
    // Default config assuming Python server on localhost:8765
    ws = new WebSocket('ws://localhost:8765');

    ws.onopen = () => {
        isWsConnected = true;
        _wsReconnectDelay = WS_BASE_DELAY; // reset backoff on success
        console.log("WebSocket Connected to IB Gateway Backend");
        updateWsStatusUI('connected');
        handleLiveSubscriptions();
    };

    ws.onclose = () => {
        isWsConnected = false;
        const delaySec = Math.round(_wsReconnectDelay / 1000);
        console.log(`WebSocket Disconnected. Reconnecting in ${delaySec}s...`);
        updateWsStatusUI('disconnected', delaySec);
        _wsReconnectTimer = setTimeout(connectWebSocket, _wsReconnectDelay);
        _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, WS_MAX_DELAY); // exponential backoff
    };

    ws.onerror = (error) => {
        console.error("WebSocket Error:", error);
        updateWsStatusUI('error');
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            processLiveMarketData(data);
        } catch (e) {
            console.error("Error parsing WS message:", e);
        }
    };
}

// -------------------------------------------------------------
// Subscription Management
// -------------------------------------------------------------

function handleLiveSubscriptions() {
    if (!isWsConnected || !ws) return;

    const payload = {
        action: 'subscribe',
        underlying: state.underlyingSymbol,
        options: []
    };

    // Collect all options from groups that have Live Data == true
    state.groups.forEach(group => {
        if (group.liveData) {
            group.legs.forEach(leg => {
                payload.options.push({
                    id: leg.id,
                    right: leg.type.charAt(0).toUpperCase(), // 'C' or 'P'
                    strike: leg.strike,
                    expDate: leg.expDate
                });
            });
        }
    });

    ws.send(JSON.stringify(payload));
}

function requestUnderlyingPriceSync() {
    if (!isWsConnected || !ws) {
        alert("Live Market Data WebSocket is not connected.");
        return;
    }

    // Create a special sync request just for the underlying
    const payload = {
        action: 'sync_underlying',
        underlying: state.underlyingSymbol
    };

    ws.send(JSON.stringify(payload));
}

// -------------------------------------------------------------
// Live Market Data Processing
// -------------------------------------------------------------

let renderScheduled = false;

function processLiveMarketData(data) {
    let stateChanged = false;

    // Update Underlying Price if present
    if (data.underlyingPrice) {
        state.underlyingPrice = data.underlyingPrice;
        document.getElementById('underlyingPrice').value = state.underlyingPrice.toFixed(2);
        document.getElementById('underlyingPriceSlider').value = state.underlyingPrice;
        document.getElementById('underlyingPriceDisplay').textContent = currencyFormatter.format(state.underlyingPrice);
        stateChanged = true;
    }

    // Update Option Legs
    if (data.options) {
        state.groups.forEach(group => {
            if (group.liveData) {
                group.legs.forEach(leg => {
                    if (data.options[leg.id] !== undefined) {
                        const liveMark = data.options[leg.id].mark;
                        const liveIV = data.options[leg.id].iv;

                        // Only update Price if there is a realistic quote and it's different
                        if (liveMark > 0 && Math.abs(liveMark - leg.currentPrice) > 0.001) {
                            leg.currentPrice = liveMark;
                            stateChanged = true;

                            const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                            if (row) {
                                const currentPriceInput = row.querySelector('.current-price-input');
                                if (currentPriceInput) {
                                    currentPriceInput.value = liveMark.toFixed(2);
                                    flashElement(currentPriceInput);
                                }
                            }
                        }

                        // Update Implied Volatility if the server streams model Greeks natively
                        // Threshold pushed to virtually zero to catch any microscopic Greek movements
                        if (liveIV && liveIV > 0 && Math.abs(liveIV - leg.iv) > 0.000001) {
                            leg.iv = liveIV;
                            stateChanged = true;

                            const row = document.querySelector(`tr[data-id="${leg.id}"]`);
                            if (row) {
                                const ivInput = row.querySelector('.iv-input');
                                if (ivInput) {
                                    ivInput.value = (liveIV * 100).toFixed(4) + '%';
                                    flashElement(ivInput);
                                }
                            }
                        }
                    }
                });
            }
        });
    }

    // Throttle rendering request
    if (stateChanged && !renderScheduled) {
        renderScheduled = true;
        requestAnimationFrame(() => {
            updateDerivedValues();
            renderScheduled = false;
        });
    }
}

// Connect immediately on load
connectWebSocket();
