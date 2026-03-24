(function chartLab(globalScope) {
    const lab = {
        socket: null,
        bars: [],
        currentPrice: NaN,
        barsSource: 'Waiting',
        selectedGroupId: '',
        visibleBars: 180,
        lastBarsKey: '',
        latestRequestId: '',
    };

    const WS_PORT_STORAGE_KEY = 'optionComboWsPort';
    const DEFAULT_WS_PORT = 8765;
    const GLOBAL_GROUP_ID = '__global__';

    function appState() {
        return globalScope.__optionComboApp && typeof globalScope.__optionComboApp.getState === 'function'
            ? globalScope.__optionComboApp.getState()
            : null;
    }

    function wsPort() {
        try {
            const parsed = parseInt(localStorage.getItem(WS_PORT_STORAGE_KEY), 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WS_PORT;
        } catch (_) {
            return DEFAULT_WS_PORT;
        }
    }

    function money(value) {
        return Number.isFinite(value) ? `$${value.toFixed(2)}` : '--';
    }

    function pct(value) {
        if (!Number.isFinite(value)) return '--';
        return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
    }

    function setMessage(text, kind) {
        const el = document.getElementById('chartLabMessage');
        if (!el) return;
        el.textContent = text || '';
        el.classList.remove('error', 'success');
        if (kind) el.classList.add(kind);
    }

    function normalizeDate(value) {
        return String(value || '').trim().replace(/\//g, '-');
    }

    function underlyingRequest(state) {
        const symbol = String(state && state.underlyingSymbol || 'SPY').trim().toUpperCase();
        const registry = globalScope.OptionComboProductRegistry;
        const profile = registry && typeof registry.resolveUnderlyingProfile === 'function'
            ? registry.resolveUnderlyingProfile(symbol)
            : null;
        if (!profile) {
            return { secType: 'STK', symbol, exchange: 'SMART', currency: 'USD' };
        }
        const request = {
            secType: profile.underlyingSecType,
            symbol: profile.underlyingSymbol || symbol,
            exchange: profile.underlyingExchange || 'SMART',
            currency: profile.currency || 'USD',
        };
        if (profile.underlyingSecType === 'FUT') {
            request.contractMonth = String(state && state.underlyingContractMonth || '').trim();
            if (profile.underlyingLegMultiplier) request.multiplier = String(profile.underlyingLegMultiplier);
        }
        return request;
    }

    function activeGroup(state) {
        if (!state || !Array.isArray(state.groups) || !state.groups.length) return null;
        if (lab.selectedGroupId === GLOBAL_GROUP_ID) return buildGlobalProjectionGroup(state);
        return state.groups.find((group) => group.id === lab.selectedGroupId) || state.groups[0];
    }

    function isGroupIncludedInGlobal(group) {
        const sessionLogic = globalScope.OptionComboSessionLogic;
        if (sessionLogic && typeof sessionLogic.isGroupIncludedInGlobal === 'function') {
            return sessionLogic.isGroupIncludedInGlobal(group);
        }
        return group && group.includedInGlobal !== false;
    }

    function buildGlobalProjectionGroup(state) {
        if (!state || !Array.isArray(state.groups) || !state.groups.length) return null;
        const includedGroups = state.groups.filter(isGroupIncludedInGlobal);
        if (!includedGroups.length) return null;
        return {
            id: GLOBAL_GROUP_ID,
            name: `Global Portfolio (${includedGroups.length} groups)`,
            legs: includedGroups.flatMap((group) => (group.legs || []).map((leg) => ({
                ...leg,
                _viewMode: group.viewMode || 'active',
            }))),
        };
    }

    function groupProjectionDate(group, state) {
        return state.simulatedDate || state.baseDate || '';
    }

    function populateGroupSelect() {
        const state = appState();
        const select = document.getElementById('chartLabGroupSelect');
        if (!select || !state) return;
        const groups = Array.isArray(state.groups) ? state.groups : [];
        const keep = lab.selectedGroupId;
        select.innerHTML = '';
        if (!groups.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No imported groups yet';
            select.appendChild(option);
            lab.selectedGroupId = '';
            return;
        }
        const globalGroup = buildGlobalProjectionGroup(state);
        const showGlobalOption = !!globalGroup && groups.length > 1;
        if (showGlobalOption) {
            const option = document.createElement('option');
            option.value = GLOBAL_GROUP_ID;
            option.textContent = globalGroup.name;
            select.appendChild(option);
        }
        groups.forEach((group, index) => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = group.name ? `${index + 1}. ${group.name}` : `Group ${index + 1}`;
            select.appendChild(option);
        });
        const canKeepCurrent = keep === GLOBAL_GROUP_ID
            ? showGlobalOption
            : groups.some((group) => group.id === keep);
        lab.selectedGroupId = canKeepCurrent
            ? keep
            : (showGlobalOption ? GLOBAL_GROUP_ID : groups[0].id);
        select.value = lab.selectedGroupId;
    }

    function projectionCurve(group, state, minS, maxS) {
        if (!group || !group.legs || !group.legs.length) {
            return { points: [], breakEvens: [], projectionDate: state.simulatedDate || '' };
        }
        const pricingContext = globalScope.OptionComboPricingContext;
        const registry = globalScope.OptionComboProductRegistry;
        const projectionDate = groupProjectionDate(group, state);
        const workingState = { ...state, simulatedDate: projectionDate || state.simulatedDate };
        const simulationDate = pricingContext && typeof pricingContext.resolveSimulationDate === 'function'
            ? pricingContext.resolveSimulationDate(workingState)
            : workingState.simulatedDate;
        const quoteDate = pricingContext && typeof pricingContext.resolveQuoteDate === 'function'
            ? pricingContext.resolveQuoteDate(workingState)
            : workingState.baseDate;
        const anchor = pricingContext && typeof pricingContext.resolveAnchorUnderlyingPrice === 'function'
            ? pricingContext.resolveAnchorUnderlyingPrice(workingState, workingState.underlyingPrice)
            : workingState.underlyingPrice;
        const profile = registry && typeof registry.resolveUnderlyingProfile === 'function'
            ? registry.resolveUnderlyingProfile(state.underlyingSymbol)
            : null;
        const viewMode = group.viewMode || 'active';
        const processed = group.legs.map((leg) => {
            const legCurrentUnderlying = pricingContext && typeof pricingContext.resolveLegCurrentUnderlyingPrice === 'function'
                ? pricingContext.resolveLegCurrentUnderlyingPrice(workingState, leg, anchor)
                : workingState.underlyingPrice;
            const legInterestRate = pricingContext && typeof pricingContext.resolveLegInterestRate === 'function'
                ? pricingContext.resolveLegInterestRate(workingState, leg, workingState.interestRate)
                : workingState.interestRate;
            return processLegData(
                leg,
                simulationDate,
                workingState.ivOffset,
                quoteDate,
                legCurrentUnderlying,
                legInterestRate,
                leg._viewMode || viewMode,
                profile,
                workingState.marketDataMode
            );
        });
        if (processed.some((leg) => !leg.isUnderlyingLeg && !leg.isExpired && !Number.isFinite(leg.simIV))) {
            return { points: [], breakEvens: [], projectionDate, error: 'Missing IV on one or more option legs.' };
        }

        const steps = 220;
        const points = [];
        const evals = [];
        const breakEvens = [];
        let maxAbsPnl = 1;
        for (let i = 0; i < steps; i++) evals.push(minS + ((maxS - minS) * i / Math.max(1, steps - 1)));
        processed.forEach((leg) => {
            if (Number.isFinite(leg.strike) && leg.strike >= minS && leg.strike <= maxS) evals.push(leg.strike, leg.strike - 0.01, leg.strike + 0.01);
        });
        [...new Set(evals)].sort((a, b) => a - b).forEach((price) => {
            let simValue = 0;
            let costBasis = 0;
            processed.forEach((processedLeg, index) => {
                const rawLeg = group.legs[index];
                const scenarioUnderlying = pricingContext && typeof pricingContext.resolveLegScenarioUnderlyingPrice === 'function'
                    ? pricingContext.resolveLegScenarioUnderlyingPrice(workingState, rawLeg, price, anchor)
                    : price;
                const legInterestRate = pricingContext && typeof pricingContext.resolveLegInterestRate === 'function'
                    ? pricingContext.resolveLegInterestRate(workingState, rawLeg, workingState.interestRate)
                    : workingState.interestRate;
                costBasis += processedLeg.costBasis;
                simValue += processedLeg.posMultiplier * computeSimulatedPrice(
                    processedLeg,
                    rawLeg,
                    scenarioUnderlying,
                    legInterestRate,
                    rawLeg._viewMode || viewMode,
                    simulationDate,
                    quoteDate,
                    workingState.ivOffset
                );
            });
            const pnl = simValue - costBasis;
            points.push({ price, pnl });
            maxAbsPnl = Math.max(maxAbsPnl, Math.abs(pnl));
        });
        for (let i = 1; i < points.length; i++) {
            const left = points[i - 1];
            const right = points[i];
            if ((left.pnl > 0 && right.pnl <= 0) || (left.pnl < 0 && right.pnl >= 0)) {
                const denom = Math.abs(left.pnl) + Math.abs(right.pnl);
                if (denom > 0) breakEvens.push(left.price + ((right.price - left.price) * Math.abs(left.pnl) / denom));
            }
        }
        return { points, breakEvens, projectionDate, maxAbsPnl };
    }

    function mergeLivePriceIntoBars() {
        if (!Number.isFinite(lab.currentPrice) || !lab.bars.length) return;
        const today = new Date().toISOString().slice(0, 10);
        const last = lab.bars[lab.bars.length - 1];
        if (last && last.time === today) {
            last.close = lab.currentPrice;
            last.high = Math.max(last.high, lab.currentPrice);
            last.low = Math.min(last.low, lab.currentPrice);
            return;
        }
        if (!last) return;
        lab.bars = lab.bars.concat([{
            time: today,
            open: last.close,
            high: Math.max(last.close, lab.currentPrice),
            low: Math.min(last.close, lab.currentPrice),
            close: lab.currentPrice,
            volume: null,
        }]);
    }

    function pushUniquePoint(target, point) {
        const last = target[target.length - 1];
        if (!last) {
            target.push(point);
            return;
        }
        if (Math.abs(last.price - point.price) < 1e-6 && Math.abs(last.pnl - point.pnl) < 1e-6) return;
        target.push(point);
    }

    function pnlSign(value) {
        if (value > 1e-6) return 1;
        if (value < -1e-6) return -1;
        return 0;
    }

    function buildProjectionSegments(points) {
        const segments = [];
        let current = null;

        function startSegment(sign, point) {
            current = { sign, points: [] };
            pushUniquePoint(current.points, point);
        }

        function closeSegment() {
            if (current && current.points.length > 1) segments.push(current);
            current = null;
        }

        for (let index = 1; index < points.length; index++) {
            const left = points[index - 1];
            const right = points[index];
            const leftSign = pnlSign(left.pnl);
            const rightSign = pnlSign(right.pnl);

            if (!leftSign && !rightSign) {
                closeSegment();
                continue;
            }

            if (leftSign && !current) startSegment(leftSign, left);

            if (leftSign === rightSign) {
                if (rightSign && !current) startSegment(rightSign, left);
                if (current && rightSign) pushUniquePoint(current.points, right);
                if (!rightSign) closeSegment();
                continue;
            }

            const denom = left.pnl - right.pnl;
            const ratio = Math.abs(denom) > 1e-9 ? left.pnl / denom : 0.5;
            const zeroPoint = {
                price: left.price + ((right.price - left.price) * ratio),
                pnl: 0,
            };

            if (leftSign) {
                if (!current) startSegment(leftSign, left);
                pushUniquePoint(current.points, zeroPoint);
                closeSegment();
            }

            if (rightSign) {
                startSegment(rightSign, zeroPoint);
                pushUniquePoint(current.points, right);
            }
        }

        closeSegment();
        return segments;
    }

    function projectionDepth(pnl, maxAbsPnl, overlayWidth) {
        if (!Number.isFinite(pnl) || !Number.isFinite(maxAbsPnl) || maxAbsPnl <= 0) return 0;
        const normalized = Math.min(1, Math.max(0, Math.abs(pnl) / maxAbsPnl));
        return overlayWidth * Math.pow(normalized, 0.7);
    }

    function segmentCenterY(segment, mapY) {
        if (!segment || !segment.points || !segment.points.length) return NaN;
        const midPoint = segment.points[Math.floor(segment.points.length / 2)];
        return mapY(midPoint.price);
    }

    function draw() {
        const canvas = document.getElementById('chartLabCanvas');
        const state = appState();
        if (!canvas || !state) return;
        const ctx = canvas.getContext('2d');
        const dpr = globalScope.devicePixelRatio || 1;
        const shell = canvas.parentElement;
        const rect = shell.getBoundingClientRect();
        const width = Math.max(320, Math.round(shell.clientWidth || rect.width));
        const height = Math.max(420, Math.round(shell.clientHeight || 580));
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        if (!lab.bars.length) {
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '15px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Waiting for daily bars...', width / 2, height / 2);
            return;
        }

        const projectionState = {
            ...state,
            underlyingPrice: Number.isFinite(lab.currentPrice) ? lab.currentPrice : Number(state.underlyingPrice),
        };
        const group = activeGroup(projectionState);
        document.getElementById('chartLabSymbol').textContent = String(state.underlyingSymbol || 'SPY').trim().toUpperCase();
        document.getElementById('chartLabBarsSource').textContent = lab.barsSource;
        document.getElementById('chartLabLivePrice').textContent = money(lab.currentPrice);
        document.getElementById('chartLabProjectionDate').textContent = groupProjectionDate(group, projectionState) || '--';

        const pad = { top: 36, right: 92, bottom: 40, left: 22 };
        const plotLeft = pad.left;
        const plotTop = pad.top;
        const plotWidth = width - pad.left - pad.right;
        const plotHeight = height - pad.top - pad.bottom;
        const bars = lab.bars.slice(-Math.max(20, lab.visibleBars));

        let minPrice = Infinity;
        let maxPrice = -Infinity;
        bars.forEach((bar) => {
            minPrice = Math.min(minPrice, bar.low, bar.open, bar.close);
            maxPrice = Math.max(maxPrice, bar.high, bar.open, bar.close);
        });
        if (Number.isFinite(lab.currentPrice)) {
            minPrice = Math.min(minPrice, lab.currentPrice);
            maxPrice = Math.max(maxPrice, lab.currentPrice);
        }
        const padPrice = Math.max((maxPrice - minPrice) * 0.08, maxPrice * 0.01, 1);
        minPrice -= padPrice;
        maxPrice += padPrice;

        const curve = projectionCurve(group, projectionState, minPrice, maxPrice);
        const mapY = (price) => plotTop + plotHeight - ((price - minPrice) / Math.max(1e-9, maxPrice - minPrice)) * plotHeight;
        const slot = plotWidth / Math.max(bars.length, 1);
        const bodyWidth = Math.max(3, Math.min(16, slot * 0.62));

        ctx.fillStyle = '#05070c';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(255,255,255,0.015)';
        ctx.fillRect(plotLeft, plotTop, plotWidth, plotHeight);
        ctx.font = '12px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        for (let i = 0; i <= 8; i++) {
            const y = plotTop + plotHeight * (i / 8);
            const price = maxPrice - (maxPrice - minPrice) * (i / 8);
            ctx.beginPath();
            ctx.moveTo(plotLeft, y);
            ctx.lineTo(plotLeft + plotWidth, y);
            ctx.strokeStyle = 'rgba(148,163,184,0.11)';
            ctx.stroke();
            ctx.fillStyle = '#cbd5e1';
            ctx.fillText(price.toFixed(2), plotLeft + plotWidth + 14, y);
        }

        for (let i = 0; i < Math.min(6, bars.length); i++) {
            const index = Math.min(bars.length - 1, Math.round((bars.length - 1) * i / Math.max(1, Math.min(6, bars.length) - 1)));
            const x = plotLeft + (index + 0.5) * slot;
            ctx.beginPath();
            ctx.moveTo(x, plotTop);
            ctx.lineTo(x, plotTop + plotHeight);
            ctx.strokeStyle = 'rgba(148,163,184,0.08)';
            ctx.stroke();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(`${bars[index].time}T00:00:00`)), x, plotTop + plotHeight + 10);
        }

        if (curve.points.length > 1) {
            const anchorX = plotLeft + (bars.length - 0.5) * slot;
            const overlayWidth = Math.min(plotWidth * 0.46, Math.max(plotWidth * 0.26, slot * 52));
            const projectionLeft = Math.max(plotLeft, anchorX - overlayWidth);
            const segments = buildProjectionSegments(curve.points);
            ctx.save();
            ctx.beginPath();
            ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
            ctx.clip();
            ctx.fillStyle = 'rgba(255,255,255,0.035)';
            ctx.fillRect(projectionLeft, plotTop, anchorX - projectionLeft, plotHeight);
            segments.forEach((segment) => {
                const isProfit = segment.sign > 0;
                const stroke = isProfit ? 'rgba(110,231,183,0.92)' : 'rgba(252,165,165,0.88)';
                const gradient = ctx.createLinearGradient(projectionLeft, 0, anchorX, 0);
                gradient.addColorStop(0, isProfit ? 'rgba(16,185,129,0.30)' : 'rgba(239,68,68,0.28)');
                gradient.addColorStop(0.55, isProfit ? 'rgba(16,185,129,0.16)' : 'rgba(239,68,68,0.14)');
                gradient.addColorStop(1, 'rgba(255,255,255,0.02)');

                ctx.beginPath();
                ctx.moveTo(anchorX, mapY(segment.points[0].price));
                segment.points.forEach((point) => {
                    const x = anchorX - projectionDepth(point.pnl, curve.maxAbsPnl, overlayWidth);
                    ctx.lineTo(x, mapY(point.price));
                });
                ctx.lineTo(anchorX, mapY(segment.points[segment.points.length - 1].price));
                ctx.closePath();
                ctx.fillStyle = gradient;
                ctx.fill();

                ctx.beginPath();
                segment.points.forEach((point, index) => {
                    const x = anchorX - projectionDepth(point.pnl, curve.maxAbsPnl, overlayWidth);
                    const y = mapY(point.price);
                    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.strokeStyle = stroke;
                ctx.lineWidth = 1.55;
                ctx.stroke();
            });
            ctx.restore();

            ctx.beginPath();
            ctx.moveTo(anchorX, plotTop);
            ctx.lineTo(anchorX, plotTop + plotHeight);
            ctx.strokeStyle = 'rgba(226,232,240,0.18)';
            ctx.stroke();

            const profitSegment = segments.filter((segment) => segment.sign > 0).sort((a, b) => b.points.length - a.points.length)[0];
            const lossSegment = segments.filter((segment) => segment.sign < 0).sort((a, b) => b.points.length - a.points.length)[0];
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.font = '600 12px Inter, sans-serif';
            if (profitSegment) {
                const y = segmentCenterY(profitSegment, mapY);
                ctx.fillStyle = 'rgba(110,231,183,0.82)';
                ctx.fillText('PROFIT AREA', Math.max(plotLeft + 12, projectionLeft + 10), y);
            }
            if (lossSegment) {
                const y = segmentCenterY(lossSegment, mapY);
                ctx.fillStyle = 'rgba(252,165,165,0.78)';
                ctx.fillText('LOSS AREA', Math.max(plotLeft + 12, projectionLeft + 10), y);
            }
        }

        bars.forEach((bar, index) => {
            const x = plotLeft + (index + 0.5) * slot;
            const openY = mapY(bar.open);
            const closeY = mapY(bar.close);
            const highY = mapY(bar.high);
            const lowY = mapY(bar.low);
            const up = bar.close >= bar.open;
            ctx.beginPath();
            ctx.moveTo(x, highY);
            ctx.lineTo(x, lowY);
            ctx.strokeStyle = up ? 'rgba(220,252,231,0.95)' : 'rgba(248,250,252,0.88)';
            ctx.stroke();
            ctx.fillStyle = up ? '#22c55e' : '#ef4444';
            ctx.fillRect(x - bodyWidth / 2, Math.min(openY, closeY), bodyWidth, Math.max(1.5, Math.abs(closeY - openY)));
        });

        ctx.font = '12px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        curve.breakEvens.forEach((be) => {
            if (be < minPrice || be > maxPrice) return;
            const y = mapY(be);
            const movePct = lab.currentPrice > 0 ? ((be - lab.currentPrice) / lab.currentPrice) * 100 : 0;
            ctx.beginPath();
            ctx.moveTo(plotLeft, y);
            ctx.lineTo(plotLeft + plotWidth, y);
            ctx.strokeStyle = 'rgba(245,158,11,0.32)';
            ctx.setLineDash([6, 6]);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#fde68a';
            ctx.fillText(`BE: $${be.toFixed(2)} (${pct(movePct)})`, plotLeft + plotWidth - 8, y - 10);
        });

        if (Number.isFinite(lab.currentPrice)) {
            const y = mapY(lab.currentPrice);
            ctx.beginPath();
            ctx.moveTo(plotLeft, y);
            ctx.lineTo(plotLeft + plotWidth, y);
            ctx.strokeStyle = '#818cf8';
            ctx.setLineDash([5, 5]);
            ctx.lineWidth = 1.3;
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#f8fafc';
        ctx.font = '600 14px Inter, sans-serif';
        ctx.fillText(`${String(state.underlyingSymbol || 'SPY').trim().toUpperCase()} daily candles`, plotLeft, 22);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px Inter, sans-serif';
        ctx.fillText(`${bars[0].time} -> ${bars[bars.length - 1].time} | source: ${lab.barsSource}${curve.error ? ` | ${curve.error}` : ''}`, plotLeft, 38);
    }

    function requestBars(force) {
        const state = appState();
        if (!state || !lab.socket || lab.socket.readyState !== WebSocket.OPEN) return;
        const key = `${state.underlyingSymbol}|${state.underlyingContractMonth || ''}|${lab.visibleBars}`;
        if (!force && key === lab.lastBarsKey && lab.bars.length) return;
        lab.lastBarsKey = key;
        lab.latestRequestId = `bars-${Date.now()}`;
        lab.socket.send(JSON.stringify({
            action: 'request_historical_bars',
            requestId: lab.latestRequestId,
            underlying: underlyingRequest(state),
            barSize: '1 day',
            durationStr: '2 Y',
            useRTH: true,
            limit: Math.max(lab.visibleBars + 20, 220),
        }));
    }

    function subscribeUnderlying() {
        const state = appState();
        if (!state || !lab.socket || lab.socket.readyState !== WebSocket.OPEN) return;
        lab.socket.send(JSON.stringify({
            action: 'subscribe',
            underlying: underlyingRequest(state),
            options: [],
            futures: [],
            stocks: [],
        }));
    }

    function openSocket() {
        if (lab.socket && (lab.socket.readyState === WebSocket.OPEN || lab.socket.readyState === WebSocket.CONNECTING)) return;
        lab.socket = new WebSocket(`ws://127.0.0.1:${wsPort()}`);
        lab.socket.addEventListener('open', () => {
            setMessage('Chart Lab connected. Loading daily bars and live price...', 'success');
            subscribeUnderlying();
            requestBars(true);
        });
        lab.socket.addEventListener('message', (event) => {
            let payload = null;
            try {
                payload = JSON.parse(event.data);
            } catch (_) {
                return;
            }
            if (payload && payload.action === 'historical_bars_response') {
                if (payload.requestId && lab.latestRequestId && payload.requestId !== lab.latestRequestId) return;
                lab.bars = Array.isArray(payload.bars) ? payload.bars.map((bar) => ({
                    time: normalizeDate(bar.time),
                    open: Number(bar.open),
                    high: Number(bar.high),
                    low: Number(bar.low),
                    close: Number(bar.close),
                    volume: Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : null,
                })).filter((bar) => Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close)) : [];
                lab.barsSource = payload.dataSource === 'ibkr' ? 'IBKR' : 'SQLite Daily';
                if (payload.fallbackReason) {
                    lab.barsSource += ' (fallback)';
                    setMessage(`Using SQLite fallback because IB historical bars were unavailable: ${payload.fallbackReason}`, 'error');
                } else {
                    setMessage(`Loaded ${lab.bars.length} daily bars.`, 'success');
                }
                mergeLivePriceIntoBars();
                draw();
                return;
            }
            if (payload && payload.action === 'historical_bars_error') {
                setMessage(payload.message || 'Unable to load historical bars.', 'error');
                return;
            }
            if (payload && Number.isFinite(Number(payload.underlyingPrice))) {
                lab.currentPrice = Number(payload.underlyingPrice);
                mergeLivePriceIntoBars();
                draw();
            }
        });
        lab.socket.addEventListener('close', () => {
            lab.socket = null;
            setMessage('Chart Lab socket disconnected. Retrying...', 'error');
            setTimeout(openSocket, 2500);
        });
        lab.socket.addEventListener('error', () => setMessage('Chart Lab socket error.', 'error'));
    }

    function activateTab(targetId) {
        document.querySelectorAll('.lab-tab-btn').forEach((button) => {
            const active = button.dataset.target === targetId;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('.app-tab-panel').forEach((panel) => {
            const active = panel.id === targetId;
            panel.hidden = !active;
        });
        if (targetId === 'chartLabPage') {
            requestBars(false);
            draw();
            return;
        }

        globalScope.requestAnimationFrame(() => {
            try {
                if (typeof globalScope.renderGroups === 'function') globalScope.renderGroups();
                if (typeof globalScope.renderHedges === 'function') globalScope.renderHedges();
                if (typeof globalScope.updateDerivedValues === 'function') globalScope.updateDerivedValues();
                globalScope.dispatchEvent(new Event('resize'));
            } catch (_) {
                // Best-effort redraw only; avoid breaking tab navigation on auxiliary refresh issues.
            }
        });
    }

    function bind() {
        document.querySelectorAll('.lab-tab-btn').forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.target)));
        document.getElementById('chartLabGroupSelect').addEventListener('change', (event) => {
            lab.selectedGroupId = String(event.target.value || '').trim();
            draw();
        });
        document.getElementById('chartLabBarCountSelect').addEventListener('change', (event) => {
            lab.visibleBars = Math.max(20, parseInt(event.target.value, 10) || 180);
            requestBars(true);
            draw();
        });
        document.getElementById('chartLabRefreshBtn').addEventListener('click', () => requestBars(true));
        document.getElementById('chartLabSyncBtn').addEventListener('click', () => {
            populateGroupSelect();
            const state = appState();
            const group = activeGroup(state);
            setMessage(
                group
                    ? `Projecting ${group.name || 'the selected combo'} using the Portfolio simulated date ${groupProjectionDate(group, state) || '--'}.`
                    : 'Import or create a combo group first.',
                group ? 'success' : 'error'
            );
            subscribeUnderlying();
            requestBars(true);
            draw();
        });
        globalScope.addEventListener('resize', draw);
        setInterval(() => {
            const state = appState();
            if (!state) return;
            populateGroupSelect();
            if (!Number.isFinite(lab.currentPrice) && Number.isFinite(Number(state.underlyingPrice))) {
                lab.currentPrice = Number(state.underlyingPrice);
                draw();
            }
        }, 800);
    }

    function init() {
        if (!document.getElementById('chartLabCanvas')) return;
        populateGroupSelect();
        bind();
        openSocket();
        draw();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(typeof globalThis !== 'undefined' ? globalThis : window);
