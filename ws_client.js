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

const DEFAULT_WS_HOST = 'localhost';
const DEFAULT_WS_PORT = 8765;
const WS_PORT_STORAGE_KEY = 'optionComboWsPort';

// Exponential backoff state
const WS_BASE_DELAY = 5000;   // 5s initial
const WS_MAX_DELAY = 60000;   // 60s cap
let _wsReconnectDelay = WS_BASE_DELAY;
let _wsReconnectTimer = null;

function _normalizeWsPort(rawValue) {
    const parsed = parseInt(rawValue, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return DEFAULT_WS_PORT;
    }
    return parsed;
}

function _getSavedWsPort() {
    try {
        return _normalizeWsPort(localStorage.getItem(WS_PORT_STORAGE_KEY));
    } catch (e) {
        return DEFAULT_WS_PORT;
    }
}

function _setSavedWsPort(port) {
    const safePort = _normalizeWsPort(port);
    try {
        localStorage.setItem(WS_PORT_STORAGE_KEY, String(safePort));
    } catch (e) {
        // Ignore localStorage failures and keep using the runtime value.
    }
    return safePort;
}

function _syncWsPortInput(port) {
    const input = document.getElementById('wsPortInput');
    if (input) input.value = String(_normalizeWsPort(port));
}

function _getCurrentWsPort() {
    const input = document.getElementById('wsPortInput');
    if (input && input.value) return _normalizeWsPort(input.value);
    return _getSavedWsPort();
}

function _getWsUrl() {
    return `ws://${DEFAULT_WS_HOST}:${_getCurrentWsPort()}`;
}

function _clearWsReconnectTimer() {
    if (_wsReconnectTimer) {
        clearTimeout(_wsReconnectTimer);
        _wsReconnectTimer = null;
    }
}

function updateWsStatusUI(status, nextRetrySec) {
    const el = document.getElementById('wsStatus');
    if (!el) return;

    const port = _getCurrentWsPort();
    if (status === 'connected') {
        el.textContent = `Connected :${port}`;
        el.className = 'ws-status ws-connected';
    } else if (status === 'error') {
        el.textContent = `Error :${port}`;
        el.className = 'ws-status ws-error';
    } else {
        const suffix = nextRetrySec != null ? ` - Retry in ${nextRetrySec}s` : '';
        el.textContent = `Disconnected :${port}${suffix}`;
        el.className = 'ws-status ws-disconnected';
    }
}

function connectWebSocket() {
    _clearWsReconnectTimer();

    const wsUrl = _getWsUrl();
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        isWsConnected = true;
        _wsReconnectDelay = WS_BASE_DELAY;
        console.log(`WebSocket Connected to IB Gateway Backend at ${wsUrl}`);
        updateWsStatusUI('connected');
        handleLiveSubscriptions();
    };

    ws.onclose = () => {
        isWsConnected = false;
        const delaySec = Math.round(_wsReconnectDelay / 1000);
        console.log(`WebSocket Disconnected. Reconnecting in ${delaySec}s...`);
        updateWsStatusUI('disconnected', delaySec);
        _wsReconnectTimer = setTimeout(connectWebSocket, _wsReconnectDelay);
        _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, WS_MAX_DELAY);
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

function reconnectWebSocket() {
    _clearWsReconnectTimer();
    isWsConnected = false;

    if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        try {
            ws.close();
        } catch (e) {
            // Ignore close errors and reconnect below.
        }
        ws = null;
    }

    updateWsStatusUI('disconnected');
    connectWebSocket();
}

function toggleWsPortControls() {
    const controls = document.getElementById('wsPortControls');
    if (!controls) return;
    controls.style.display = controls.style.display === 'none' ? 'block' : 'none';
}

function applyWsPort() {
    const input = document.getElementById('wsPortInput');
    if (!input) return;

    const safePort = _normalizeWsPort(input.value);
    input.value = String(safePort);
    _setSavedWsPort(safePort);
    reconnectWebSocket();
}

function resetWsPort() {
    _setSavedWsPort(DEFAULT_WS_PORT);
    _syncWsPortInput(DEFAULT_WS_PORT);
    reconnectWebSocket();
}

function initWsPortControls() {
    const savedPort = _getSavedWsPort();
    _syncWsPortInput(savedPort);
    updateWsStatusUI('disconnected');
}

window.toggleWsPortControls = toggleWsPortControls;
window.applyWsPort = applyWsPort;
window.resetWsPort = resetWsPort;

// -------------------------------------------------------------
// Subscription Management
// -------------------------------------------------------------

function handleLiveSubscriptions() {
    if (!isWsConnected || !ws) return;

    const payload = {
        action: 'subscribe',
        underlying: state.underlyingSymbol,
        options: [],
        stocks: []
    };

    // Collect all legs from groups that have Live Data == true
    state.groups.forEach(group => {
        if (group.liveData) {
            group.legs.forEach(leg => {
                if (leg.type === 'stock') {
                    // Stock legs subscribe as stocks, not options.
                    if (!payload.stocks.includes(state.underlyingSymbol)) {
                        payload.stocks.push(state.underlyingSymbol);
                    }
                } else {
                    payload.options.push({
                        id: leg.id,
                        right: leg.type.charAt(0).toUpperCase(), // 'C' or 'P'
                        strike: leg.strike,
                        expDate: leg.expDate
                    });
                }
            });
        }
    });

    // Collect all hedge stocks that have Live Data == true
    state.hedges.forEach(hedge => {
        if (hedge.liveData && hedge.symbol) {
            payload.stocks.push(hedge.symbol);
        }
    });

    ws.send(JSON.stringify(payload));
}

function requestUnderlyingPriceSync() {
    if (!isWsConnected || !ws) {
        alert("Live Market Data WebSocket is not connected.");
        return;
    }

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

    // Update Hedge Stocks + Stock-type legs in groups
    if (data.stocks) {
        state.hedges.forEach(hedge => {
            if (hedge.liveData && data.stocks[hedge.symbol] !== undefined) {
                const liveMark = data.stocks[hedge.symbol].mark;
                if (liveMark > 0 && Math.abs(liveMark - hedge.currentPrice) > 0.001) {
                    hedge.currentPrice = liveMark;
                    stateChanged = true;

                    const row = document.querySelector(`tr.hedge-row[data-id="${hedge.id}"]`);
                    if (row) {
                        const currentPriceInput = row.querySelector('.current-price-input');
                        if (currentPriceInput) {
                            currentPriceInput.value = liveMark.toFixed(2);
                            flashElement(currentPriceInput);
                        }
                    }
                }
            }
        });

        state.groups.forEach(group => {
            if (group.liveData) {
                group.legs.forEach(leg => {
                    if (leg.type === 'stock' && data.stocks[state.underlyingSymbol] !== undefined) {
                        const liveMark = data.stocks[state.underlyingSymbol].mark;
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
                    }
                });
            }
        });
    }

    if (stateChanged && !renderScheduled) {
        renderScheduled = true;
        requestAnimationFrame(() => {
            updateDerivedValues();
            renderScheduled = false;
        });
    }
}

// Connect immediately on load
initWsPortControls();
connectWebSocket();
