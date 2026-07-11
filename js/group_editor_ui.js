/**
 * Group and leg editor rendering and event binding.
 */

(function attachGroupEditorUI(globalScope) {
    // Butterfly finder candidate-grid limits: keep the ratio grid dense while
    // bounding how many option quotes one dialog subscribes at once.
    const BUTTERFLY_MAX_WIDTH_STEPS = 12;
    const BUTTERFLY_MAX_QUOTE_SUBSCRIPTIONS = 48;

    function _getProductRegistryApi() {
        return globalScope.OptionComboProductRegistry && typeof globalScope.OptionComboProductRegistry === 'object'
            ? globalScope.OptionComboProductRegistry
            : null;
    }

    function _getPricingCoreApi() {
        return globalScope.OptionComboPricingCore && typeof globalScope.OptionComboPricingCore === 'object'
            ? globalScope.OptionComboPricingCore
            : null;
    }

    function _getSessionLogicApi() {
        return globalScope.OptionComboSessionLogic && typeof globalScope.OptionComboSessionLogic === 'object'
            ? globalScope.OptionComboSessionLogic
            : null;
    }

    function _getTradeTriggerLogicApi() {
        return globalScope.OptionComboTradeTriggerLogic && typeof globalScope.OptionComboTradeTriggerLogic === 'object'
            ? globalScope.OptionComboTradeTriggerLogic
            : null;
    }

    function _getGroupOrderBuilderApi() {
        return globalScope.OptionComboGroupOrderBuilder && typeof globalScope.OptionComboGroupOrderBuilder === 'object'
            ? globalScope.OptionComboGroupOrderBuilder
            : null;
    }

    function parseIvPercentInput(rawValue) {
        const normalized = String(rawValue || '')
            .replace(/[^0-9.+-]/g, '');
        const parsed = parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function isUnderlyingLeg(leg) {
        const productRegistry = _getProductRegistryApi();
        if (productRegistry && typeof productRegistry.isUnderlyingLeg === 'function') {
            return productRegistry.isUnderlyingLeg(leg);
        }
        return ['stock', 'future'].includes(String(leg && leg.type || '').toLowerCase());
    }

    function getUnderlyingLegLabel(symbol) {
        const productRegistry = _getProductRegistryApi();
        return productRegistry && typeof productRegistry.getUnderlyingLegLabel === 'function'
            ? productRegistry.getUnderlyingLegLabel(symbol)
            : 'Underlying';
    }

    function getPricingInputMode(symbol) {
        const productRegistry = _getProductRegistryApi();
        return productRegistry && typeof productRegistry.resolvePricingInputMode === 'function'
            ? productRegistry.resolvePricingInputMode(symbol)
            : 'STK';
    }

    function getPriceInputStep(symbol) {
        const productRegistry = _getProductRegistryApi();
        return productRegistry && typeof productRegistry.getPriceInputStep === 'function'
            ? productRegistry.getPriceInputStep(symbol)
            : '0.01';
    }

    function formatPriceInputValue(symbol, value) {
        const productRegistry = _getProductRegistryApi();
        if (productRegistry && typeof productRegistry.formatPriceInputValue === 'function') {
            return productRegistry.formatPriceInputValue(symbol, value);
        }
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed.toFixed(2) : '';
    }

    function _describeLegIvInput(leg) {
        const pricingCore = _getPricingCoreApi();
        if (pricingCore && typeof pricingCore.describeLegIvInput === 'function') {
            return pricingCore.describeLegIvInput(leg);
        }

        const iv = Math.max(parseFloat(leg && leg.iv) || 0, 0);
        return {
            value: `${(iv * 100).toFixed(4)}%`,
            title: 'Manual IV',
        };
    }

    function formatRepriceThresholdValue(value) {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
            return '';
        }
        const raw = parsed >= 0.01 ? parsed.toFixed(2) : parsed.toFixed(4);
        return raw.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
    }

    function getLegAnchorDate(state) {
        if (state && state.marketDataMode === 'historical' && state.historicalQuoteDate) {
            return state.historicalQuoteDate;
        }
        return state.baseDate;
    }

    function _normalizeDateValue(value) {
        return String(value || '').trim();
    }

    function _getCurrentSimulatedDateInputValue() {
        const doc = globalScope.document;
        if (!doc || typeof doc.getElementById !== 'function') {
            return '';
        }
        const input = doc.getElementById('simulatedDate');
        return input ? _normalizeDateValue(input.value) : '';
    }

    function resolveDefaultLegExpirationDate(state, deps) {
        const stateSimulatedDate = _normalizeDateValue(state && state.simulatedDate);
        const inputSimulatedDate = _getCurrentSimulatedDateInputValue();
        const baseDate = _normalizeDateValue(state && state.baseDate);
        const anchorDate = _normalizeDateValue(getLegAnchorDate(state)) || baseDate || stateSimulatedDate;
        const simulatedDate = inputSimulatedDate && (!baseDate || inputSimulatedDate !== baseDate)
            ? inputSimulatedDate
            : stateSimulatedDate;

        if (simulatedDate && (!baseDate || simulatedDate !== baseDate)) {
            return simulatedDate;
        }

        if (anchorDate && deps && typeof deps.addDays === 'function') {
            return deps.addDays(anchorDate, 30);
        }

        return simulatedDate || anchorDate || '';
    }

    function _generateFallbackId(prefix) {
        return `${prefix || 'id'}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    function _generateLegId(deps) {
        return deps && typeof deps.generateId === 'function'
            ? deps.generateId()
            : _generateFallbackId('leg');
    }

    function _createOptionLeg(deps, overrides) {
        return Object.assign({
            id: _generateLegId(deps),
            type: 'call',
            pos: 1,
            strike: 0,
            expDate: '',
            iv: 0.2,
            ivSource: 'manual',
            ivManualOverride: false,
            currentPrice: 0.00,
            currentPriceSource: '',
            portfolioMarketPrice: null,
            portfolioMarketPriceSource: '',
            portfolioUnrealizedPnl: null,
            cost: 0.00,
            closePrice: null,
            underlyingFutureId: ''
        }, overrides || {});
    }

    function _getStrikeIncrement(state) {
        const underlying = Math.abs(parseFloat(state && state.underlyingPrice) || 0);
        if (underlying >= 1000) return 25;
        if (underlying >= 100) return 5;
        if (underlying >= 20) return 1;
        const step = parseFloat(getPriceInputStep(state && state.underlyingSymbol));
        return Number.isFinite(step) && step > 0 ? Math.max(step, 0.5) : 0.5;
    }

    function _roundToIncrement(value, increment) {
        const parsed = parseFloat(value);
        const step = parseFloat(increment);
        if (!Number.isFinite(parsed) || !Number.isFinite(step) || step <= 0) {
            return Number.isFinite(parsed) ? parsed : 0;
        }
        const rounded = Math.round(parsed / step) * step;
        const precision = step < 1 ? 4 : 2;
        return parseFloat(rounded.toFixed(precision));
    }

    function _formatStrikeForInput(state, value) {
        const rounded = _roundToIncrement(value, _getStrikeIncrement(state));
        return String(rounded);
    }

    function _getDefaultComboStrikes(state) {
        const underlying = parseFloat(state && state.underlyingPrice);
        const increment = _getStrikeIncrement(state);
        const centerSource = Number.isFinite(underlying) && underlying > 0 ? underlying : 100;
        const center = _roundToIncrement(centerSource, increment);
        const width = Math.max(increment, _roundToIncrement(centerSource * 0.02, increment));
        return {
            lower: _roundToIncrement(center - width, increment),
            middle: center,
            upper: _roundToIncrement(center + width, increment),
        };
    }

    function _parseComboStrike(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function _normalizeComboStrategy(value) {
        const normalized = String(value || '').trim().toLowerCase();
        return ['bull_spread', 'bear_spread', 'straddle', 'strangle', 'butterfly'].includes(normalized)
            ? normalized
            : 'bull_spread';
    }

    function _getButterflyWingWidthOptions(state) {
        const underlying = Math.abs(parseFloat(state && state.underlyingPrice) || 0);
        if (underlying >= 1000) {
            return [25, 50, 75, 100, 150, 200, 250, 300];
        }
        return [5, 10, 15, 20, 25, 50, 100, 150];
    }

    function _normalizePositiveNumber(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function _getButterflyWingWidthFromStrikes(strikes) {
        if (!strikes || strikes.lower === null || strikes.middle === null || strikes.upper === null) {
            return null;
        }
        const leftWidth = strikes.middle - strikes.lower;
        const rightWidth = strikes.upper - strikes.middle;
        if (!Number.isFinite(leftWidth) || !Number.isFinite(rightWidth) || leftWidth <= 0 || rightWidth <= 0) {
            return null;
        }
        return Math.min(leftWidth, rightWidth);
    }

    function _formatComboNumber(value, digits = 2) {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
            return '';
        }
        return parsed.toFixed(digits).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
    }

    function _buildComboTemplateQuoteId(state, expDate, type, strike) {
        const symbol = String(state && state.underlyingSymbol || 'SYM')
            .replace(/[^A-Za-z0-9]/g, '')
            .toUpperCase() || 'SYM';
        const expiry = String(expDate || '').replace(/[^0-9]/g, '') || 'EXP';
        const right = String(type || '').toLowerCase() === 'put' ? 'P' : 'C';
        const strikeKey = _formatComboNumber(strike, 4).replace('.', 'p');
        return `combo_template_${symbol}_${expiry}_${right}_${strikeKey}`;
    }

    function _buildComboTemplateQuoteRequest(state, expDate, type, strike) {
        return {
            id: _buildComboTemplateQuoteId(state, expDate, type, strike),
            type: String(type || '').toLowerCase() === 'put' ? 'put' : 'call',
            strike,
            expDate,
        };
    }

    function _resolveQuoteMidById(quoteId) {
        const liveQuotes = globalScope.OptionComboWsLiveQuotes;
        const quote = liveQuotes && typeof liveQuotes.getOptionQuote === 'function'
            ? liveQuotes.getOptionQuote(quoteId)
            : null;
        const bid = _normalizePositiveNumber(quote && quote.bid);
        const ask = _normalizePositiveNumber(quote && quote.ask);
        if (bid !== null && ask !== null) {
            return (bid + ask) / 2;
        }
        const mark = _normalizePositiveNumber(quote && quote.mark);
        return mark !== null ? mark : null;
    }

    function _resolveQuoteDisplayById(quoteId) {
        const liveQuotes = globalScope.OptionComboWsLiveQuotes;
        const quote = liveQuotes && typeof liveQuotes.getOptionQuote === 'function'
            ? liveQuotes.getOptionQuote(quoteId)
            : null;
        const bid = _normalizePositiveNumber(quote && quote.bid);
        const ask = _normalizePositiveNumber(quote && quote.ask);
        const mark = _normalizePositiveNumber(quote && quote.mark);
        const mid = bid !== null && ask !== null ? (bid + ask) / 2 : mark;
        return {
            bid,
            ask,
            mark,
            mid: mid !== null ? mid : null,
            hasQuote: bid !== null || ask !== null || mark !== null,
            complete: bid !== null && ask !== null,
        };
    }

    function calculateButterflyRiskFromLegPrices(prices, wingWidth) {
        const lowerPut = _normalizePositiveNumber(prices && prices.lowerPut);
        const middlePut = _normalizePositiveNumber(prices && prices.middlePut);
        const middleCall = _normalizePositiveNumber(prices && prices.middleCall);
        const upperCall = _normalizePositiveNumber(prices && prices.upperCall);
        const width = _normalizePositiveNumber(wingWidth);
        if (lowerPut === null || middlePut === null || middleCall === null || upperCall === null || width === null) {
            return null;
        }

        const netCredit = middlePut + middleCall - lowerPut - upperCall;
        const maxProfit = netCredit;
        const maxLoss = width - netCredit;
        if (!(maxProfit > 0) || !(maxLoss > 0)) {
            return null;
        }
        return {
            maxProfit,
            maxLoss,
            profitLossRatio: maxProfit / maxLoss,
            netCredit,
            wingWidth: width,
        };
    }

    function _buildButterflyCandidate(state, expDate, middleStrike, wingWidth) {
        const width = _normalizePositiveNumber(wingWidth);
        const middle = _parseComboStrike(middleStrike);
        if (width === null || middle === null) {
            return null;
        }
        const lower = _roundToIncrement(middle - width, _getStrikeIncrement(state));
        const upper = _roundToIncrement(middle + width, _getStrikeIncrement(state));
        if (!(lower < middle && middle < upper)) {
            return null;
        }
        const quoteRequests = [
            _buildComboTemplateQuoteRequest(state, expDate, 'put', lower),
            _buildComboTemplateQuoteRequest(state, expDate, 'put', middle),
            _buildComboTemplateQuoteRequest(state, expDate, 'call', middle),
            _buildComboTemplateQuoteRequest(state, expDate, 'call', upper),
        ];
        return {
            lower,
            middle,
            upper,
            wingWidth: width,
            quoteRequests,
        };
    }

    function _evaluateButterflyCandidate(candidate) {
        if (!candidate || !Array.isArray(candidate.quoteRequests)) {
            return null;
        }
        const prices = {
            lowerPut: _resolveQuoteMidById(candidate.quoteRequests[0] && candidate.quoteRequests[0].id),
            middlePut: _resolveQuoteMidById(candidate.quoteRequests[1] && candidate.quoteRequests[1].id),
            middleCall: _resolveQuoteMidById(candidate.quoteRequests[2] && candidate.quoteRequests[2].id),
            upperCall: _resolveQuoteMidById(candidate.quoteRequests[3] && candidate.quoteRequests[3].id),
        };
        const risk = calculateButterflyRiskFromLegPrices(prices, candidate.wingWidth);
        return risk ? { ...candidate, risk } : null;
    }

    function _chooseButterflyCandidate(candidates, targetRatio) {
        const evaluated = (Array.isArray(candidates) ? candidates : [])
            .map(_evaluateButterflyCandidate)
            .filter(Boolean);
        if (evaluated.length === 0) {
            return null;
        }
        const target = _normalizePositiveNumber(targetRatio);
        evaluated.sort((left, right) => {
            if (target !== null) {
                const leftDistance = Math.abs(left.risk.profitLossRatio - target);
                const rightDistance = Math.abs(right.risk.profitLossRatio - target);
                if (Math.abs(leftDistance - rightDistance) > 0.000001) {
                    return leftDistance - rightDistance;
                }
            }
            return right.risk.profitLossRatio - left.risk.profitLossRatio;
        });
        return evaluated[0];
    }

    function _setComboTemplateQuoteRequests(state, requests) {
        if (!state || typeof state !== 'object') {
            return false;
        }
        const unique = [];
        const seen = new Set();
        (Array.isArray(requests) ? requests : []).forEach((request) => {
            if (!request || !request.id || seen.has(request.id)) {
                return;
            }
            seen.add(request.id);
            unique.push(request);
        });
        const current = Array.isArray(state.comboTemplateQuoteRequests) ? state.comboTemplateQuoteRequests : [];
        const unchanged = current.length === unique.length
            && current.every((request, index) => {
                const next = unique[index];
                return next
                    && request.id === next.id
                    && request.type === next.type
                    && request.strike === next.strike
                    && request.expDate === next.expDate;
            });
        if (unchanged) {
            return false;
        }
        state.comboTemplateQuoteRequests = unique;
        return true;
    }

    function _clearComboTemplateQuoteRequests(state, deps) {
        if (state && Array.isArray(state.comboTemplateQuoteRequests) && state.comboTemplateQuoteRequests.length > 0) {
            state.comboTemplateQuoteRequests = [];
            if (deps && typeof deps.handleLiveSubscriptions === 'function') {
                deps.handleLiveSubscriptions();
            }
        }
    }

    function _resolveComboLegSpecs(strategy, strikes) {
        if (strategy === 'straddle') {
            if (strikes.middle === null) {
                return { success: false, reason: 'Enter a valid strike.' };
            }
            return {
                success: true,
                specs: [
                    { type: 'call', pos: 1, strike: strikes.middle },
                    { type: 'put', pos: 1, strike: strikes.middle },
                ],
            };
        }

        if (strategy === 'butterfly') {
            if (strikes.lower === null || strikes.middle === null || strikes.upper === null) {
                return { success: false, reason: 'Enter valid lower, middle, and upper strikes.' };
            }
            if (!(strikes.lower < strikes.middle && strikes.middle < strikes.upper)) {
                return { success: false, reason: 'Butterfly strikes must be lower < middle < upper.' };
            }
            return {
                success: true,
                specs: [
                    { type: 'put', pos: 1, strike: strikes.lower },
                    { type: 'put', pos: -1, strike: strikes.middle },
                    { type: 'call', pos: -1, strike: strikes.middle },
                    { type: 'call', pos: 1, strike: strikes.upper },
                ],
            };
        }

        if (strikes.lower === null || strikes.upper === null) {
            return { success: false, reason: 'Enter valid lower and upper strikes.' };
        }
        if (!(strikes.lower < strikes.upper)) {
            return { success: false, reason: 'Upper strike must be greater than lower strike.' };
        }

        if (strategy === 'bear_spread') {
            return {
                success: true,
                specs: [
                    { type: 'put', pos: 1, strike: strikes.upper },
                    { type: 'put', pos: -1, strike: strikes.lower },
                ],
            };
        }

        if (strategy === 'strangle') {
            return {
                success: true,
                specs: [
                    { type: 'put', pos: 1, strike: strikes.lower },
                    { type: 'call', pos: 1, strike: strikes.upper },
                ],
            };
        }

        return {
            success: true,
            specs: [
                { type: 'call', pos: 1, strike: strikes.lower },
                { type: 'call', pos: -1, strike: strikes.upper },
            ],
        };
    }

    function applyComboTemplateToGroup(group, state, deps = {}, config = {}) {
        if (!group || !Array.isArray(group.legs)) {
            return { success: false, reason: 'Group is unavailable.', legCount: 0 };
        }
        if (group.legs.length > 0) {
            return { success: false, reason: 'Typical combos can only be applied to an empty group.', legCount: 0 };
        }

        const strategy = _normalizeComboStrategy(config.strategy);
        const expDate = _normalizeDateValue(config.expDate || config.expiry || resolveDefaultLegExpirationDate(state, deps));
        if (!expDate) {
            return { success: false, reason: 'Choose an expiration date.', legCount: 0 };
        }

        const defaultStrikes = _getDefaultComboStrikes(state);
        const strikes = {
            lower: _parseComboStrike(config.lowerStrike !== undefined ? config.lowerStrike : defaultStrikes.lower),
            middle: _parseComboStrike(config.middleStrike !== undefined ? config.middleStrike : defaultStrikes.middle),
            upper: _parseComboStrike(config.upperStrike !== undefined ? config.upperStrike : defaultStrikes.upper),
        };
        const resolved = _resolveComboLegSpecs(strategy, strikes);
        if (!resolved.success) {
            return { success: false, reason: resolved.reason, legCount: 0 };
        }

        group.legs = resolved.specs.map((spec) => _createOptionLeg(deps, {
            type: spec.type,
            pos: spec.pos,
            strike: spec.strike,
            expDate,
        }));
        if (strategy === 'butterfly') {
            const wingWidth = _getButterflyWingWidthFromStrikes(strikes);
            const candidate = _buildButterflyCandidate(state, expDate, strikes.middle, wingWidth);
            const evaluated = _evaluateButterflyCandidate(candidate);
            group.comboTemplate = {
                strategy: 'butterfly',
                kind: 'iron_butterfly',
                lowerStrike: strikes.lower,
                middleStrike: strikes.middle,
                upperStrike: strikes.upper,
                wingWidth,
                risk: evaluated && evaluated.risk ? evaluated.risk : null,
            };
            // The finder picked this combo from live quote mids; keep the group on
            // the market data feed so its P&L matches the ratio it was chosen for.
            group.liveData = true;
        } else {
            delete group.comboTemplate;
        }
        _clearComboTemplateQuoteRequests(state, null);

        if (typeof deps.handleLiveSubscriptions === 'function') {
            deps.handleLiveSubscriptions();
        }
        if (typeof deps.renderGroups === 'function') {
            deps.renderGroups();
        }

        return { success: true, reason: '', legCount: group.legs.length };
    }

    function _setComboTemplateError(dialog, message) {
        const errorEl = dialog && dialog.querySelector('.combo-template-error');
        if (errorEl) {
            errorEl.textContent = message || '';
            errorEl.style.display = message ? 'block' : 'none';
        }
    }

    function _setComboTemplateFieldVisibility(dialog) {
        if (!dialog) return;
        const strategy = _normalizeComboStrategy(dialog.querySelector('.combo-template-strategy')?.value);
        const lowerField = dialog.querySelector('[data-combo-field="lower"]');
        const middleField = dialog.querySelector('[data-combo-field="middle"]');
        const upperField = dialog.querySelector('[data-combo-field="upper"]');
        const lowerLabel = dialog.querySelector('.combo-template-lower-label');
        const middleLabel = dialog.querySelector('.combo-template-middle-label');
        const upperLabel = dialog.querySelector('.combo-template-upper-label');
        const butterflyTools = dialog.querySelector('.combo-template-butterfly-tools');

        const showLower = strategy !== 'straddle';
        const showMiddle = strategy === 'straddle' || strategy === 'butterfly';
        const showUpper = strategy !== 'straddle';

        if (lowerField) lowerField.style.display = showLower ? 'block' : 'none';
        if (middleField) middleField.style.display = showMiddle ? 'block' : 'none';
        if (upperField) upperField.style.display = showUpper ? 'block' : 'none';

        if (lowerLabel) {
            lowerLabel.textContent = strategy === 'strangle' ? 'Put Strike' : 'Lower Strike';
        }
        if (middleLabel) {
            middleLabel.textContent = strategy === 'straddle' ? 'Strike' : 'Middle Strike';
        }
        if (upperLabel) {
            upperLabel.textContent = strategy === 'strangle' ? 'Call Strike' : 'Upper Strike';
        }
        if (butterflyTools) {
            butterflyTools.style.display = strategy === 'butterfly' ? 'block' : 'none';
        }
    }

    function _setComboTemplateDefaultInputs(dialog, state) {
        if (!dialog) return;
        const defaults = _getDefaultComboStrikes(state);
        const lowerInput = dialog.querySelector('.combo-template-lower-strike');
        const middleInput = dialog.querySelector('.combo-template-middle-strike');
        const upperInput = dialog.querySelector('.combo-template-upper-strike');
        if (lowerInput) lowerInput.value = _formatStrikeForInput(state, defaults.lower);
        if (middleInput) middleInput.value = _formatStrikeForInput(state, defaults.middle);
        if (upperInput) upperInput.value = _formatStrikeForInput(state, defaults.upper);
    }

    function _getButterflyWidthInputValue(dialog) {
        const manualInput = dialog && dialog.querySelector('.combo-template-wing-width-manual');
        const select = dialog && dialog.querySelector('.combo-template-wing-width-select');
        const selectValue = select ? String(select.value || '').trim() : '';
        if (selectValue && selectValue !== 'custom') {
            return _normalizePositiveNumber(selectValue);
        }
        return _normalizePositiveNumber(manualInput && manualInput.value);
    }

    function _setButterflyRiskStatus(dialog, risk, message) {
        const statusEl = dialog && dialog.querySelector('.combo-template-butterfly-risk-status');
        if (!statusEl) {
            return;
        }
        if (risk) {
            statusEl.textContent = [
                `MaxProfit ${_formatComboNumber(risk.maxProfit, 2)}`,
                `MaxLoss ${_formatComboNumber(risk.maxLoss, 2)}`,
                `Ratio ${_formatComboNumber(risk.profitLossRatio, 3)}`,
            ].join(' / ');
            statusEl.classList.remove('text-danger');
            statusEl.classList.add('text-muted');
            return;
        }
        statusEl.textContent = message || '';
        statusEl.classList.toggle('text-danger', !!message);
        statusEl.classList.toggle('text-muted', !message);
    }

    function _applyButterflyWingWidthToDialog(dialog, state, wingWidth) {
        if (!dialog) return null;
        const width = _normalizePositiveNumber(wingWidth);
        const middleInput = dialog.querySelector('.combo-template-middle-strike');
        const lowerInput = dialog.querySelector('.combo-template-lower-strike');
        const upperInput = dialog.querySelector('.combo-template-upper-strike');
        const middle = _parseComboStrike(middleInput && middleInput.value);
        if (width === null || middle === null || !lowerInput || !upperInput) {
            return null;
        }
        const increment = _getStrikeIncrement(state);
        const lower = _roundToIncrement(middle - width, increment);
        const upper = _roundToIncrement(middle + width, increment);
        lowerInput.value = _formatComboNumber(lower, 4);
        upperInput.value = _formatComboNumber(upper, 4);
        return { lower, middle, upper, wingWidth: width };
    }

    function _syncButterflyWidthControls(dialog, state) {
        if (!dialog) return;
        const select = dialog.querySelector('.combo-template-wing-width-select');
        const manualInput = dialog.querySelector('.combo-template-wing-width-manual');
        if (!select || !manualInput) return;

        const options = _getButterflyWingWidthOptions(state);
        select.innerHTML = options
            .map((value) => `<option value="${value}">${_formatComboNumber(value, 2)}</option>`)
            .join('') + '<option value="custom">Custom</option>';
        const defaultWidth = options.includes(100)
            ? 100
            : options[Math.min(1, options.length - 1)];
        select.value = String(defaultWidth);
        manualInput.value = String(defaultWidth);
        manualInput.disabled = true;
        _applyButterflyWingWidthToDialog(dialog, state, defaultWidth);
        _setButterflyRiskStatus(dialog, null, '');
    }

    function _getButterflyCandidateWidths(state, manualWidth) {
        const increment = _getStrikeIncrement(state);
        const options = _getButterflyWingWidthOptions(state);
        const maxWidth = options[options.length - 1];
        const widths = manualWidth !== null ? [manualWidth] : [];
        // Enumerate widths at strike-increment granularity so candidate ratios are
        // dense enough to land near the target; stride up when the grid gets large.
        const stepCount = Math.max(1, Math.floor(maxWidth / increment));
        const stride = Math.max(1, Math.ceil(stepCount / BUTTERFLY_MAX_WIDTH_STEPS));
        for (let step = 1; step <= stepCount; step += stride) {
            widths.push(step * increment);
        }
        options.forEach((value) => widths.push(value));
        return Array.from(new Set(widths.map((value) => _roundToIncrement(value, increment))))
            .filter((value) => Number.isFinite(value) && value > 0)
            .sort((left, right) => left - right);
    }

    function _buildButterflyCandidateGrid(state, expDate, middleStrike, manualWidth) {
        const middle = _parseComboStrike(middleStrike);
        if (!expDate || middle === null) {
            return [];
        }
        const increment = _getStrikeIncrement(state);
        const widths = _getButterflyCandidateWidths(state, manualWidth);
        // Shifting the body off the entered middle strike is what fills the ratio
        // gaps between symmetric wing widths. Shrink the offset range if the quote
        // subscription budget would be exceeded.
        const offsetPlans = [[-2, -1, 0, 1, 2], [-1, 0, 1], [0]];
        for (const offsets of offsetPlans) {
            const candidates = [];
            const seenStrikes = new Set();
            const quoteIds = new Set();
            offsets.forEach((offset) => {
                const center = _roundToIncrement(middle + offset * increment, increment);
                widths.forEach((width) => {
                    const candidate = _buildButterflyCandidate(state, expDate, center, width);
                    if (!candidate) {
                        return;
                    }
                    const key = `${candidate.lower}:${candidate.middle}:${candidate.upper}`;
                    if (seenStrikes.has(key)) {
                        return;
                    }
                    seenStrikes.add(key);
                    candidates.push(candidate);
                    candidate.quoteRequests.forEach((request) => quoteIds.add(request.id));
                });
            });
            if (quoteIds.size <= BUTTERFLY_MAX_QUOTE_SUBSCRIPTIONS || offsets.length === 1) {
                return candidates;
            }
        }
        return [];
    }

    function _buildButterflyCandidatesFromDialog(dialog, state) {
        const expDate = _normalizeDateValue(dialog && dialog.querySelector('.combo-template-expiry')?.value);
        const middle = _parseComboStrike(dialog && dialog.querySelector('.combo-template-middle-strike')?.value);
        if (!expDate || middle === null) {
            return [];
        }
        return _buildButterflyCandidateGrid(state, expDate, middle, _getButterflyWidthInputValue(dialog));
    }

    function _selectButterflyCandidateInDialog(dialog, candidate) {
        if (!dialog || !candidate) {
            return;
        }
        const lowerInput = dialog.querySelector('.combo-template-lower-strike');
        const middleInput = dialog.querySelector('.combo-template-middle-strike');
        const upperInput = dialog.querySelector('.combo-template-upper-strike');
        const manualInput = dialog.querySelector('.combo-template-wing-width-manual');
        const select = dialog.querySelector('.combo-template-wing-width-select');
        if (lowerInput) lowerInput.value = _formatComboNumber(candidate.lower, 4);
        if (middleInput) middleInput.value = _formatComboNumber(candidate.middle, 4);
        if (upperInput) upperInput.value = _formatComboNumber(candidate.upper, 4);
        if (manualInput) manualInput.value = _formatComboNumber(candidate.wingWidth, 4);
        if (select) {
            const option = Array.from(select.options || []).find((entry) => parseFloat(entry.value) === candidate.wingWidth);
            select.value = option ? option.value : 'custom';
            if (manualInput) {
                manualInput.disabled = select.value !== 'custom';
            }
        }
        _setButterflyRiskStatus(dialog, candidate.risk, '');
    }

    function _stopButterflyQuoteMonitor(dialog) {
        if (!dialog || !dialog._butterflyQuoteTimer) {
            return;
        }
        const clearTimer = globalScope.clearTimeout || (typeof clearTimeout === 'function' ? clearTimeout : null);
        if (typeof clearTimer === 'function') {
            clearTimer(dialog._butterflyQuoteTimer);
        }
        dialog._butterflyQuoteTimer = null;
    }

    function _flashButterflyQuoteRow(row) {
        if (!row || !row.style) {
            return;
        }
        const timer = globalScope.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null);
        row.style.backgroundColor = 'rgba(74, 222, 128, 0.35)';
        if (typeof timer === 'function') {
            timer(() => {
                row.style.transition = 'background-color 0.8s ease';
                row.style.backgroundColor = 'transparent';
                timer(() => {
                    row.style.transition = '';
                }, 800);
            }, 50);
        }
    }

    function _formatQuoteValue(value) {
        return Number.isFinite(value) ? _formatComboNumber(value, 2) : '...';
    }

    // One row per unique strike (the subscription-pool view): a strike that
    // serves several candidates — wing of one, body of another — still shares
    // a single quote per right, so per-candidate rows would just repeat it.
    function _collectButterflyQuoteRows(candidates) {
        const rowsByStrike = new Map();
        (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
            (candidate && Array.isArray(candidate.quoteRequests) ? candidate.quoteRequests : []).forEach((request) => {
                const strike = parseFloat(request && request.strike);
                if (!Number.isFinite(strike)) {
                    return;
                }
                const key = strike.toFixed(4);
                let row = rowsByStrike.get(key);
                if (!row) {
                    row = { strike, putRequest: null, callRequest: null };
                    rowsByStrike.set(key, row);
                }
                if (String(request.type || '').toLowerCase() === 'put') {
                    if (!row.putRequest) {
                        row.putRequest = request;
                    }
                } else if (!row.callRequest) {
                    row.callRequest = request;
                }
            });
        });
        return Array.from(rowsByStrike.values()).sort((left, right) => left.strike - right.strike);
    }

    function _renderButterflyQuoteRows(dialog, candidates) {
        const tbody = dialog && dialog.querySelector('.combo-template-butterfly-quote-body');
        if (!tbody) {
            return;
        }
        const rowsHtml = [];
        _collectButterflyQuoteRows(candidates).forEach((row) => {
            const rowKey = _formatComboNumber(row.strike, 4);
            rowsHtml.push(`
                <tr data-quote-row="${rowKey}" data-strike="${_formatComboNumber(row.strike, 4)}" data-put-quote-id="${row.putRequest ? row.putRequest.id : ''}" data-call-quote-id="${row.callRequest ? row.callRequest.id : ''}" data-quote-signature="">
                    <td class="combo-template-put-bid">${row.putRequest ? '...' : ''}</td>
                    <td class="combo-template-put-ask">${row.putRequest ? '...' : ''}</td>
                    <td class="combo-template-put-mid font-weight-semibold">${row.putRequest ? '...' : ''}</td>
                    <td style="font-weight: 700; text-align: center; background: rgba(var(--primary-rgb), 0.08);">${_formatComboNumber(row.strike, 4)}</td>
                    <td class="combo-template-call-mid font-weight-semibold">${row.callRequest ? '...' : ''}</td>
                    <td class="combo-template-call-bid">${row.callRequest ? '...' : ''}</td>
                    <td class="combo-template-call-ask">${row.callRequest ? '...' : ''}</td>
                </tr>
            `);
        });
        tbody.innerHTML = rowsHtml.join('');
    }

    function _getButterflyQuoteProgress(candidates) {
        const quoteIds = new Set();
        let receivedQuoteCount = 0;
        (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
            (candidate.quoteRequests || []).forEach((request) => {
                if (!request || !request.id || quoteIds.has(request.id)) {
                    return;
                }
                quoteIds.add(request.id);
                if (_resolveQuoteDisplayById(request.id).hasQuote) {
                    receivedQuoteCount += 1;
                }
            });
        });
        const completeCandidates = (Array.isArray(candidates) ? candidates : [])
            .filter((candidate) => !!_evaluateButterflyCandidate(candidate));
        return {
            quoteCount: quoteIds.size,
            receivedQuoteCount,
            candidateCount: Array.isArray(candidates) ? candidates.length : 0,
            completeCandidateCount: completeCandidates.length,
            completeCandidates,
        };
    }

    function _updateButterflyQuoteTable(dialog) {
        if (!dialog || !dialog._comboContext || dialog.style.display === 'none') {
            return;
        }
        const candidates = Array.isArray(dialog._butterflyCandidates) ? dialog._butterflyCandidates : [];
        const quotePanel = dialog.querySelector('.combo-template-butterfly-quote-panel');
        const progressEl = dialog.querySelector('.combo-template-butterfly-progress');
        const findComboBtn = dialog.querySelector('.combo-template-find-combo-btn');
        if (!quotePanel || candidates.length === 0) {
            if (findComboBtn) {
                findComboBtn.disabled = true;
            }
            return;
        }

        quotePanel.style.display = 'block';
        dialog.querySelectorAll('.combo-template-butterfly-quote-body tr').forEach((row) => {
            const putDisplay = row.dataset.putQuoteId
                ? _resolveQuoteDisplayById(row.dataset.putQuoteId)
                : null;
            const callDisplay = row.dataset.callQuoteId
                ? _resolveQuoteDisplayById(row.dataset.callQuoteId)
                : null;
            const signature = [
                row.dataset.putQuoteId || '',
                putDisplay ? putDisplay.bid : '',
                putDisplay ? putDisplay.ask : '',
                putDisplay ? putDisplay.mid : '',
                row.dataset.callQuoteId || '',
                callDisplay ? callDisplay.bid : '',
                callDisplay ? callDisplay.ask : '',
                callDisplay ? callDisplay.mid : '',
            ].join(':');
            if (row.dataset.quoteSignature && row.dataset.quoteSignature !== signature) {
                _flashButterflyQuoteRow(row);
            }
            row.dataset.quoteSignature = signature;

            const putBidEl = row.querySelector('.combo-template-put-bid');
            const putAskEl = row.querySelector('.combo-template-put-ask');
            const putMidEl = row.querySelector('.combo-template-put-mid');
            const callBidEl = row.querySelector('.combo-template-call-bid');
            const callAskEl = row.querySelector('.combo-template-call-ask');
            const callMidEl = row.querySelector('.combo-template-call-mid');

            if (putBidEl) putBidEl.textContent = putDisplay ? _formatQuoteValue(putDisplay.bid) : '';
            if (putAskEl) putAskEl.textContent = putDisplay ? _formatQuoteValue(putDisplay.ask) : '';
            if (putMidEl) putMidEl.textContent = putDisplay ? _formatQuoteValue(putDisplay.mid) : '';
            if (callBidEl) callBidEl.textContent = callDisplay ? _formatQuoteValue(callDisplay.bid) : '';
            if (callAskEl) callAskEl.textContent = callDisplay ? _formatQuoteValue(callDisplay.ask) : '';
            if (callMidEl) callMidEl.textContent = callDisplay ? _formatQuoteValue(callDisplay.mid) : '';
        });

        const progress = _getButterflyQuoteProgress(candidates);
        if (progressEl) {
            progressEl.textContent = progress.completeCandidateCount > 0
                ? `${progress.completeCandidateCount}/${progress.candidateCount} wings ready, ${progress.receivedQuoteCount}/${progress.quoteCount} option quotes received.`
                : `Subscribed ${progress.quoteCount} option quotes, ${progress.receivedQuoteCount}/${progress.quoteCount} received. Waiting for a complete wing.`;
        }
        if (findComboBtn) {
            findComboBtn.disabled = progress.completeCandidateCount === 0;
            findComboBtn.title = progress.completeCandidateCount === 0
                ? 'Wait until at least one wing has all four option quotes.'
                : 'Pick the wing with the closest MaxProfit / MaxLoss ratio.';
        }
    }

    function _scheduleButterflyQuoteTableRefresh(dialog) {
        _stopButterflyQuoteMonitor(dialog);
        const timer = globalScope.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null);
        if (typeof timer !== 'function') {
            return;
        }
        dialog._butterflyQuoteTimer = timer(() => {
            _updateButterflyQuoteTable(dialog);
            if (dialog && dialog._comboContext && dialog.style.display !== 'none') {
                _scheduleButterflyQuoteTableRefresh(dialog);
            }
        }, 1000);
    }

    function _resetButterflyQuoteTable(dialog, message) {
        if (!dialog) {
            return;
        }
        _stopButterflyQuoteMonitor(dialog);
        const context = dialog._comboContext || {};
        _clearComboTemplateQuoteRequests(context.state, context.deps);
        dialog._butterflyCandidates = [];
        const quotePanel = dialog.querySelector('.combo-template-butterfly-quote-panel');
        const tbody = dialog.querySelector('.combo-template-butterfly-quote-body');
        const progressEl = dialog.querySelector('.combo-template-butterfly-progress');
        const findComboBtn = dialog.querySelector('.combo-template-find-combo-btn');
        if (tbody) tbody.innerHTML = '';
        if (quotePanel) quotePanel.style.display = 'none';
        if (progressEl) progressEl.textContent = message || '';
        if (findComboBtn) findComboBtn.disabled = true;
    }

    function _subscribeButterflyCandidateQuotes(dialog) {
        const context = dialog && dialog._comboContext;
        if (!context || !context.state) {
            return false;
        }
        const candidates = _buildButterflyCandidatesFromDialog(dialog, context.state);
        if (candidates.length === 0) {
            _setButterflyRiskStatus(dialog, null, 'Enter a valid expiration and middle strike first.');
            return false;
        }
        const quoteRequests = [];
        candidates.forEach((candidate) => {
            quoteRequests.push(...candidate.quoteRequests);
        });
        dialog._butterflyCandidates = candidates;
        _renderButterflyQuoteRows(dialog, candidates);
        const requestListChanged = _setComboTemplateQuoteRequests(context.state, quoteRequests);
        if (requestListChanged && context.deps && typeof context.deps.handleLiveSubscriptions === 'function') {
            context.deps.handleLiveSubscriptions();
        }
        const uniqueQuoteCount = Array.isArray(context.state.comboTemplateQuoteRequests)
            ? context.state.comboTemplateQuoteRequests.length
            : 0;
        _setButterflyRiskStatus(
            dialog,
            null,
            requestListChanged
                ? `Subscribed ${uniqueQuoteCount} option quotes.`
                : `Already subscribed ${uniqueQuoteCount} option quotes.`
        );
        _updateButterflyQuoteTable(dialog);
        _scheduleButterflyQuoteTableRefresh(dialog);
        return true;
    }

    function _findButterflyComboFromQuotes(dialog) {
        const candidates = Array.isArray(dialog && dialog._butterflyCandidates)
            ? dialog._butterflyCandidates
            : [];
        if (candidates.length === 0) {
            _setButterflyRiskStatus(dialog, null, 'Click Subscribe first to load candidate quotes.');
            return false;
        }
        const targetInput = dialog.querySelector('.combo-template-target-ratio');
        const targetRatio = targetInput ? targetInput.value : '';
        const selected = _chooseButterflyCandidate(candidates, targetRatio);
        if (selected) {
            _selectButterflyCandidateInDialog(dialog, selected);
            return true;
        }

        _setButterflyRiskStatus(dialog, null, 'No complete wing quotes yet. Keep this dialog open while quotes arrive.');
        _updateButterflyQuoteTable(dialog);
        return false;
    }

    function _closeComboTemplateDialog(dialog) {
        if (!dialog) return;
        _stopButterflyQuoteMonitor(dialog);
        const context = dialog._comboContext || {};
        _clearComboTemplateQuoteRequests(context.state, context.deps);
        dialog._butterflyCandidates = [];
        dialog.style.display = 'none';
        dialog._comboContext = null;
        _setComboTemplateError(dialog, '');
    }

    function _ensureComboTemplateDialog() {
        const doc = globalScope.document;
        if (!doc || typeof doc.createElement !== 'function') {
            return null;
        }

        let dialog = doc.getElementById('comboTemplateDialog');
        if (dialog) {
            return dialog;
        }

        dialog = doc.createElement('div');
        dialog.id = 'comboTemplateDialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'comboTemplateDialogTitle');
        dialog.style.cssText = [
            'position: fixed',
            'inset: 0',
            'z-index: 2000',
            'display: none',
            'align-items: center',
            'justify-content: center',
            'background: rgba(15, 23, 42, 0.48)',
            'padding: 1rem',
        ].join('; ');
        dialog.innerHTML = `
            <div class="combo-template-panel panel-card">
                <div class="combo-template-header">
                    <h3 id="comboTemplateDialogTitle" class="h5">Choose Typical Combo</h3>
                    <button type="button" class="btn btn-secondary btn-sm combo-template-cancel-btn">Cancel</button>
                </div>
                <div class="combo-template-body">
                    <div class="combo-template-section">
                        <label class="form-label small text-muted">Strategy</label>
                        <select class="number-input combo-template-strategy">
                            <option value="bull_spread">Bull Spread</option>
                            <option value="bear_spread">Bear Spread</option>
                            <option value="straddle">Straddle</option>
                            <option value="strangle">Strangle</option>
                            <option value="butterfly">Butterfly</option>
                        </select>
                    </div>
                    <div class="combo-template-section">
                        <label class="form-label small text-muted">Expiration</label>
                        <input type="date" class="number-input combo-template-expiry">
                    </div>
                    <div class="combo-template-field-grid">
                        <label data-combo-field="lower">
                            <span class="form-label small text-muted combo-template-lower-label">Lower Strike</span>
                            <input type="number" class="number-input combo-template-lower-strike">
                        </label>
                        <label data-combo-field="middle">
                            <span class="form-label small text-muted combo-template-middle-label">Middle Strike</span>
                            <input type="number" class="number-input combo-template-middle-strike">
                        </label>
                        <label data-combo-field="upper">
                            <span class="form-label small text-muted combo-template-upper-label">Upper Strike</span>
                            <input type="number" class="number-input combo-template-upper-strike">
                        </label>
                    </div>
                    <div class="combo-template-butterfly-tools" style="display: none;">
                        <div class="combo-template-butterfly-grid">
                            <label>
                                <span class="form-label small text-muted">Wing Width</span>
                                <select class="number-input combo-template-wing-width-select"></select>
                            </label>
                            <label>
                                <span class="form-label small text-muted">Manual Width</span>
                                <input type="number" class="number-input combo-template-wing-width-manual" min="0" step="1">
                            </label>
                            <label>
                                <span class="form-label small text-muted">Target P/L Ratio</span>
                                <input type="number" class="number-input combo-template-target-ratio" min="0" step="0.01" placeholder="Auto best">
                            </label>
                        </div>
                        <div class="combo-template-butterfly-risk-status small text-muted" style="min-height: 1.25rem; margin-top: 0.75rem;"></div>
                        <div class="combo-template-butterfly-actions">
                            <button type="button" class="btn btn-secondary btn-sm combo-template-subscribe-butterfly-btn">
                                Subscribe
                            </button>
                            <button type="button" class="btn btn-primary btn-sm combo-template-find-combo-btn" disabled>
                                Find Combo
                            </button>
                        </div>
                        <div class="combo-template-butterfly-quote-panel" style="display: none;">
                            <div class="combo-template-butterfly-progress small text-muted"></div>
                            <div class="combo-template-butterfly-quote-scroll">
                                <table class="portfolio-table" style="margin: 0; font-size: 0.85rem; min-width: 560px;">
                                    <thead>
                                        <tr>
                                            <th colspan="3" style="text-align: center;">PUT</th>
                                            <th rowspan="2" style="text-align: center; vertical-align: middle;">Strike</th>
                                            <th colspan="3" style="text-align: center;">CALL</th>
                                        </tr>
                                        <tr>
                                            <th>Bid</th>
                                            <th>Ask</th>
                                            <th>Mid</th>
                                            <th>Mid</th>
                                            <th>Bid</th>
                                            <th>Ask</th>
                                        </tr>
                                    </thead>
                                    <tbody class="combo-template-butterfly-quote-body"></tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                    <div class="combo-template-error text-danger small" style="display: none;"></div>
                </div>
                <div class="combo-template-footer">
                    <button type="button" class="btn btn-secondary combo-template-cancel-btn">Cancel</button>
                    <button type="button" class="btn btn-primary combo-template-submit-btn">Create Combo</button>
                </div>
            </div>
        `;

        const closeButtons = dialog.querySelectorAll('.combo-template-cancel-btn');
        closeButtons.forEach((button) => {
            button.addEventListener('click', () => _closeComboTemplateDialog(dialog));
        });

        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) {
                _closeComboTemplateDialog(dialog);
            }
        });

        const strategyInput = dialog.querySelector('.combo-template-strategy');
        if (strategyInput) {
            strategyInput.addEventListener('change', () => {
                if (dialog._comboContext) {
                    _setComboTemplateDefaultInputs(dialog, dialog._comboContext.state);
                    if (_normalizeComboStrategy(strategyInput.value) === 'butterfly') {
                        _syncButterflyWidthControls(dialog, dialog._comboContext.state);
                    }
                }
                _setComboTemplateFieldVisibility(dialog);
                _resetButterflyQuoteTable(dialog);
                _setComboTemplateError(dialog, '');
            });
        }

        const wingWidthSelect = dialog.querySelector('.combo-template-wing-width-select');
        const wingWidthManual = dialog.querySelector('.combo-template-wing-width-manual');
        const subscribeButterflyBtn = dialog.querySelector('.combo-template-subscribe-butterfly-btn');
        const findComboBtn = dialog.querySelector('.combo-template-find-combo-btn');
        if (wingWidthSelect) {
            wingWidthSelect.addEventListener('change', () => {
                const context = dialog._comboContext || {};
                if (wingWidthManual) {
                    wingWidthManual.disabled = wingWidthSelect.value !== 'custom';
                    if (wingWidthSelect.value !== 'custom') {
                        wingWidthManual.value = wingWidthSelect.value;
                    }
                }
                const width = _getButterflyWidthInputValue(dialog);
                _applyButterflyWingWidthToDialog(dialog, context.state, width);
                _resetButterflyQuoteTable(dialog);
            });
        }
        if (wingWidthManual) {
            wingWidthManual.addEventListener('input', () => {
                if (wingWidthSelect && wingWidthSelect.value !== 'custom') {
                    return;
                }
                const context = dialog._comboContext || {};
                _applyButterflyWingWidthToDialog(dialog, context.state, _getButterflyWidthInputValue(dialog));
                _setButterflyRiskStatus(dialog, null, '');
                _resetButterflyQuoteTable(dialog);
            });
        }
        ['.combo-template-middle-strike', '.combo-template-expiry'].forEach((selector) => {
            const input = dialog.querySelector(selector);
            if (input) {
                input.addEventListener('change', () => {
                    const context = dialog._comboContext || {};
                    if (_normalizeComboStrategy(strategyInput && strategyInput.value) === 'butterfly') {
                        _applyButterflyWingWidthToDialog(dialog, context.state, _getButterflyWidthInputValue(dialog));
                        _setButterflyRiskStatus(dialog, null, '');
                        _resetButterflyQuoteTable(dialog);
                    }
                });
            }
        });
        if (subscribeButterflyBtn) {
            subscribeButterflyBtn.addEventListener('click', () => {
                _subscribeButterflyCandidateQuotes(dialog);
            });
        }
        if (findComboBtn) {
            findComboBtn.addEventListener('click', () => {
                _findButterflyComboFromQuotes(dialog);
            });
        }

        const submitBtn = dialog.querySelector('.combo-template-submit-btn');
        if (submitBtn) {
            submitBtn.addEventListener('click', () => {
                const context = dialog._comboContext || {};
                const result = applyComboTemplateToGroup(context.group, context.state, context.deps, {
                    strategy: strategyInput ? strategyInput.value : 'bull_spread',
                    expDate: dialog.querySelector('.combo-template-expiry')?.value,
                    lowerStrike: dialog.querySelector('.combo-template-lower-strike')?.value,
                    middleStrike: dialog.querySelector('.combo-template-middle-strike')?.value,
                    upperStrike: dialog.querySelector('.combo-template-upper-strike')?.value,
                });
                if (!result.success) {
                    _setComboTemplateError(dialog, result.reason || 'Unable to create this combo.');
                    return;
                }
                _closeComboTemplateDialog(dialog);
            });
        }

        if (doc.body && typeof doc.body.appendChild === 'function') {
            doc.body.appendChild(dialog);
        }
        return dialog;
    }

    function openComboTemplateDialog(group, state, deps) {
        if (!group || !Array.isArray(group.legs) || group.legs.length > 0) {
            return false;
        }

        const dialog = _ensureComboTemplateDialog();
        if (!dialog) {
            return false;
        }

        dialog._comboContext = { group, state, deps };
        _resetButterflyQuoteTable(dialog);
        const strategyInput = dialog.querySelector('.combo-template-strategy');
        const expiryInput = dialog.querySelector('.combo-template-expiry');
        const step = String(_getStrikeIncrement(state));

        dialog.querySelectorAll('input[type="number"]').forEach((input) => {
            input.step = step;
        });

        if (strategyInput) {
            strategyInput.value = 'bull_spread';
        }
        if (expiryInput) {
            expiryInput.value = resolveDefaultLegExpirationDate(state, deps);
        }

        _setComboTemplateDefaultInputs(dialog, state);
        _setComboTemplateFieldVisibility(dialog);
        _setComboTemplateError(dialog, '');
        dialog.style.display = 'flex';

        if (strategyInput && typeof strategyInput.focus === 'function') {
            strategyInput.focus();
        }
        return true;
    }

    function applyMarketDataToggleUi(state, group, liveToggle) {
        if (!liveToggle) return;

        const statusSpan = liveToggle.parentElement && liveToggle.parentElement.previousElementSibling;
        const labelSpan = liveToggle.parentElement
            ? liveToggle.parentElement.querySelector('.market-data-toggle-label')
            : null;
        const isHistoricalMode = !!(state && state.marketDataMode === 'historical');

        if (statusSpan) {
            statusSpan.textContent = group.liveData
                ? (isHistoricalMode ? 'Replay' : 'Live')
                : 'Offline';
        }

        if (labelSpan) {
            labelSpan.textContent = isHistoricalMode
                ? 'Historical Replay'
                : 'Market Data Feed';
        }
    }

    function _ensureTradeTrigger(group) {
        const tradeTriggerLogic = _getTradeTriggerLogicApi();
        if (tradeTriggerLogic && typeof tradeTriggerLogic.ensureGroupTradeTrigger === 'function') {
            return tradeTriggerLogic.ensureGroupTradeTrigger(group);
        }
        if (!group || typeof group !== 'object') {
            return null;
        }
        if (!group.tradeTrigger || typeof group.tradeTrigger !== 'object') {
            group.tradeTrigger = {
                enabled: false,
                pendingRequest: false,
                status: 'idle',
            };
        }
        return group.tradeTrigger;
    }

    function _ensurePortfolioAvgCostSync(group) {
        if (!group || typeof group !== 'object') {
            return false;
        }
        const sessionLogic = _getSessionLogicApi();
        group.syncAvgCostFromPortfolio = sessionLogic
            && typeof sessionLogic.normalizePortfolioAvgCostSync === 'function'
            ? sessionLogic.normalizePortfolioAvgCostSync(group)
            : group.syncAvgCostFromPortfolio === true;
        return group.syncAvgCostFromPortfolio;
    }

    function _ensureLivePriceMode(group) {
        if (!group || typeof group !== 'object') {
            return 'midpoint';
        }
        const sessionLogic = _getSessionLogicApi();
        if (sessionLogic && typeof sessionLogic.normalizeGroupLivePriceMode === 'function') {
            group.livePriceMode = sessionLogic.normalizeGroupLivePriceMode(group.livePriceMode);
        } else {
            group.livePriceMode = String(group.livePriceMode || '').trim().toLowerCase() === 'mark'
                ? 'mark'
                : 'midpoint';
        }
        return group.livePriceMode;
    }

    function _ensureCloseExecution(group) {
        if (!group || typeof group !== 'object') {
            return null;
        }
        const sessionLogic = _getSessionLogicApi();
        group.closeExecution = sessionLogic
            && typeof sessionLogic.normalizeCloseExecution === 'function'
            ? sessionLogic.normalizeCloseExecution(group.closeExecution)
            : group.closeExecution || null;
        return group.closeExecution;
    }

    function _ensureHistoricalAutoCloseAtExpiry(group) {
        if (!group || typeof group !== 'object') {
            return true;
        }
        const sessionLogic = _getSessionLogicApi();
        if (sessionLogic && typeof sessionLogic.normalizeHistoricalAutoCloseAtExpiry === 'function') {
            group.historicalAutoCloseAtExpiry = sessionLogic.normalizeHistoricalAutoCloseAtExpiry(
                group.historicalAutoCloseAtExpiry
            );
        } else {
            group.historicalAutoCloseAtExpiry = group.historicalAutoCloseAtExpiry !== false;
        }
        return group.historicalAutoCloseAtExpiry;
    }

    function _groupHasCostForAllPositionedLegs(group) {
        return (group && Array.isArray(group.legs) ? group.legs : []).every((leg) => {
            const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
            if (pos < 0.0001) {
                return true;
            }
            return Math.abs(parseFloat(leg && leg.cost) || 0) > 0;
        });
    }

    function _hasResolvedClosePrice(leg) {
        return !!(leg
            && leg.closePrice !== null
            && leg.closePrice !== ''
            && leg.closePrice !== undefined);
    }

    function _legHasOpenPosition(leg) {
        const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
        return pos > 0.0001 && !_hasResolvedClosePrice(leg);
    }

    function _legHasLockedEntryCost(leg) {
        return Math.abs(parseFloat(leg && leg.cost) || 0) > 0;
    }

    function _toPositiveFiniteNumber(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function _resolveSnapshotMidpoint(snapshot) {
        const bid = _toPositiveFiniteNumber(snapshot && snapshot.bid);
        const ask = _toPositiveFiniteNumber(snapshot && snapshot.ask);
        if (bid === null || ask === null) {
            return null;
        }
        return (bid + ask) / 2;
    }

    function _resolveLiveQuoteSnapshotForLeg(leg) {
        const liveQuotes = globalScope.OptionComboWsLiveQuotes;
        if (!liveQuotes || !leg) {
            return null;
        }

        if (isUnderlyingLeg(leg)) {
            if (leg.underlyingFutureId && typeof liveQuotes.getFutureQuote === 'function') {
                return liveQuotes.getFutureQuote(leg.underlyingFutureId);
            }
            if (typeof liveQuotes.getUnderlyingQuote === 'function') {
                return liveQuotes.getUnderlyingQuote();
            }
            return null;
        }

        if (typeof liveQuotes.getOptionQuote === 'function') {
            return liveQuotes.getOptionQuote(leg.id);
        }
        return null;
    }

    function _resolveSimulatedOpenPrice(group, leg) {
        const currentPrice = _toPositiveFiniteNumber(leg && leg.currentPrice);
        const currentPriceSource = String(leg && leg.currentPriceSource || '').trim();
        if (currentPriceSource === 'manual' && currentPrice !== null) {
            return {
                price: currentPrice,
                source: 'manual',
            };
        }

        const livePriceMode = _ensureLivePriceMode(group);
        const midpointPrice = _resolveSnapshotMidpoint(_resolveLiveQuoteSnapshotForLeg(leg));
        const portfolioMarketPrice = _toPositiveFiniteNumber(leg && leg.portfolioMarketPrice);

        if (livePriceMode === 'mark' && portfolioMarketPrice !== null) {
            return {
                price: portfolioMarketPrice,
                source: 'tws_portfolio',
            };
        }

        if (midpointPrice !== null) {
            return {
                price: midpointPrice,
                source: 'live_midpoint',
            };
        }

        if (portfolioMarketPrice !== null) {
            return {
                price: portfolioMarketPrice,
                source: 'tws_portfolio',
            };
        }

        if (currentPriceSource !== 'missing' && currentPrice !== null) {
            return {
                price: currentPrice,
                source: currentPriceSource || 'current_price',
            };
        }

        return null;
    }

    function _hasBlockingOpenOrderRuntime(group) {
        const trigger = group && group.tradeTrigger;
        if (!trigger) {
            return false;
        }

        const status = String(trigger.status || '').trim();
        return trigger.pendingRequest === true
            || status.indexOf('pending_') === 0
            || status === 'submitted'
            || status === 'test_submitted';
    }

    function _collectSimulatedOpenPrices(group) {
        const entries = [];
        let missingCount = 0;

        (group && Array.isArray(group.legs) ? group.legs : []).forEach((leg) => {
            if (!_legHasOpenPosition(leg)) {
                return;
            }

            const resolvedPrice = _resolveSimulatedOpenPrice(group, leg);
            if (!resolvedPrice) {
                missingCount += 1;
                return;
            }

            entries.push({
                leg,
                price: resolvedPrice.price,
                source: resolvedPrice.source,
            });
        });

        return {
            entries,
            missingCount,
            openLegCount: entries.length + missingCount,
        };
    }

    function describeSimulatedOpenState(group, state, activeViewMode) {
        const renderMode = activeViewMode || (group && group.viewMode) || 'active';
        const isHistoricalMode = !!(state && state.marketDataMode === 'historical');
        const collected = _collectSimulatedOpenPrices(group);
        const visible = !isHistoricalMode && renderMode === 'trial' && collected.openLegCount > 0;
        let reason = '';

        if (isHistoricalMode) {
            reason = 'Use Enter @ Replay Day to lock historical replay entry costs.';
        } else if (!visible) {
            reason = renderMode === 'trial'
                ? 'Add a non-zero open leg to enable simulated opening.'
                : 'Simulated opening is only available in Trial mode.';
        } else if (_hasBlockingOpenOrderRuntime(group)) {
            reason = 'A trial-trigger order request is already active for this group.';
        } else if (collected.missingCount > 0) {
            reason = 'Every open leg needs a current quote before simulated opening.';
        }

        return {
            visible,
            disabled: !!reason,
            reason,
            entries: collected.entries,
            openLegCount: collected.openLegCount,
            missingCount: collected.missingCount,
            marketDataMode: isHistoricalMode ? 'historical' : 'live',
        };
    }

    function simulateOpenGroup(group, state, deps = {}) {
        const simState = describeSimulatedOpenState(group, state, (group && group.viewMode) || 'active');
        if (!simState.visible || simState.disabled) {
            return {
                success: false,
                reason: simState.reason || 'This group cannot be simulated-opened right now.',
                updatedLegCount: 0,
            };
        }

        simState.entries.forEach((entry) => {
            entry.leg.cost = entry.price;
            entry.leg.costSource = 'simulated_open';
            entry.leg.simulatedOpenPriceSource = entry.source;
            entry.leg.executionReportedCost = false;
            delete entry.leg.executionReportOrderId;
            delete entry.leg.executionReportPermId;
        });

        group.viewMode = 'active';
        group.syncAvgCostFromPortfolio = false;

        const trigger = _ensureTradeTrigger(group);
        if (trigger) {
            trigger.enabled = false;
            trigger.pendingRequest = false;
            trigger.status = 'idle';
            trigger.lastTriggeredAt = null;
            trigger.lastTriggerPrice = null;
            trigger.lastPreview = null;
            trigger.lastError = '';
        }

        if (typeof deps.renderGroups === 'function') {
            deps.renderGroups();
        } else if (typeof deps.updateDerivedValues === 'function') {
            deps.updateDerivedValues();
        }

        return {
            success: true,
            reason: '',
            updatedLegCount: simState.entries.length,
        };
    }

    function _resolveCloseLegDisabledReason(group, leg, state, deps) {
        if (!_legHasOpenPosition(leg)) {
            return _hasResolvedClosePrice(leg)
                ? 'This leg is already closed.'
                : 'This leg has no open position to close.';
        }

        const closeExecution = _ensureCloseExecution(group);
        if (closeExecution && closeExecution.pendingRequest === true) {
            return 'A close order request is already in progress for this group.';
        }

        const isHistoricalMode = !!(state && state.marketDataMode === 'historical');
        const renderMode = deps && typeof deps.getRenderableGroupViewMode === 'function'
            ? deps.getRenderableGroupViewMode(group)
            : (group && group.viewMode) || 'active';

        if (!isHistoricalMode && renderMode !== 'active') {
            return 'Single-leg close is only available when this group is in Active mode.';
        }

        if (isHistoricalMode && !_legHasLockedEntryCost(leg)) {
            return 'Lock this leg entry cost first with Enter @ Replay Day before closing it.';
        }

        if (!deps || typeof deps.requestCloseLegComboOrder !== 'function') {
            return 'Single-leg close transport is unavailable.';
        }

        return '';
    }

    function _getSettlementUnitsPerContract(state, deps) {
        const pricingCore = _getPricingCoreApi();
        if (pricingCore && typeof pricingCore.getSettlementUnitsPerContract === 'function') {
            return pricingCore.getSettlementUnitsPerContract(
                deps && typeof deps.getUnderlyingProfile === 'function'
                    ? deps.getUnderlyingProfile()
                    : (state && state.underlyingSymbol)
            );
        }
        return 100;
    }

    function _getAssignmentShareDelta(leg, state, deps) {
        const pos = parseFloat(leg && leg.pos) || 0;
        if (Math.abs(pos) < 0.0001) {
            return 0;
        }

        const settlementUnitsPerContract = _getSettlementUnitsPerContract(state, deps);
        const lowerType = String(leg && leg.type || '').trim().toLowerCase();
        if (lowerType === 'call') {
            return pos * settlementUnitsPerContract;
        }
        if (lowerType === 'put') {
            return -pos * settlementUnitsPerContract;
        }
        return 0;
    }

    function _getValidTradeTriggerThresholds() {
        const tradeTriggerLogic = _getTradeTriggerLogicApi();
        return tradeTriggerLogic && Array.isArray(tradeTriggerLogic.VALID_REPRICE_THRESHOLDS)
            ? tradeTriggerLogic.VALID_REPRICE_THRESHOLDS
            : [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05];
    }

    function _getValidTradeTriggerTifs() {
        const tradeTriggerLogic = _getTradeTriggerLogicApi();
        return tradeTriggerLogic && Array.isArray(tradeTriggerLogic.VALID_TIME_IN_FORCE)
            ? tradeTriggerLogic.VALID_TIME_IN_FORCE
            : ['DAY', 'GTC'];
    }

    function _resolveAssignmentActionLabel(leg) {
        if (!leg || isUnderlyingLeg(leg)) {
            return '';
        }

        if (leg.closePriceSource === 'assignment_conversion') {
            return 'Undo';
        }

        return (parseFloat(leg.pos) || 0) < 0 ? 'Assign' : 'Exercise';
    }

    function _isAssignmentConvertible(group, leg, state, deps) {
        if (!group || !leg || isUnderlyingLeg(leg)) {
            return false;
        }

        const pos = Math.abs(parseFloat(leg.pos) || 0);
        if (pos < 0.0001) {
            return false;
        }

        // A leg closed by any other path (manual close price, close order fill,
        // historical settlement) must not be convertible: converting would
        // overwrite its recorded close price with 0, and Undo could only
        // restore null — silently losing the user's data.
        if (_hasResolvedClosePrice(leg) && leg.closePriceSource !== 'assignment_conversion') {
            return false;
        }

        const renderMode = deps && typeof deps.getRenderableGroupViewMode === 'function'
            ? deps.getRenderableGroupViewMode(group)
            : (group.viewMode || 'active');
        if (renderMode !== 'active' && renderMode !== 'settlement') {
            return false;
        }

        if (deps && typeof deps.supportsUnderlyingLegs === 'function' && !deps.supportsUnderlyingLegs(state.underlyingSymbol)) {
            return false;
        }

        return true;
    }

    function applyOptionAssignmentConversion(group, leg, state, deps) {
        if (!_isAssignmentConvertible(group, leg, state, deps)) {
            return false;
        }

        const linkedLegId = String(leg.assignmentUnderlyingLegId || '').trim();
        if (leg.closePriceSource === 'assignment_conversion' && linkedLegId) {
            group.legs = (group.legs || []).filter((entry) => entry.id !== linkedLegId);
            leg.closePrice = null;
            leg.closePriceSource = '';
            leg.assignmentUnderlyingLegId = '';
            leg.assignmentUnderlyingQuantity = 0;
            if (deps && typeof deps.handleLiveSubscriptions === 'function') {
                deps.handleLiveSubscriptions();
            }
            if (deps && typeof deps.renderGroups === 'function') {
                deps.renderGroups();
            }
            return true;
        }

        const shareDelta = _getAssignmentShareDelta(leg, state, deps);
        if (Math.abs(shareDelta) < 0.0001) {
            return false;
        }

        const strike = parseFloat(leg.strike) || 0;
        const nextId = deps && typeof deps.generateId === 'function'
            ? deps.generateId()
            : ('_assignment_' + Math.random().toString(36).slice(2, 11));

        group.legs.push({
            id: nextId,
            type: 'stock',
            pos: shareDelta,
            strike: 0,
            expDate: '',
            iv: 0,
            ivSource: 'manual',
            ivManualOverride: false,
            currentPrice: 0.00,
            currentPriceSource: '',
            portfolioMarketPrice: null,
            portfolioMarketPriceSource: '',
            portfolioUnrealizedPnl: null,
            cost: strike,
            costSource: 'assignment_conversion',
            closePrice: null,
            underlyingFutureId: leg.underlyingFutureId || '',
            assignmentSourceLegId: leg.id,
        });

        leg.closePrice = 0;
        leg.closePriceSource = 'assignment_conversion';
        leg.assignmentUnderlyingLegId = nextId;
        leg.assignmentUnderlyingQuantity = shareDelta;

        if (deps && typeof deps.handleLiveSubscriptions === 'function') {
            deps.handleLiveSubscriptions();
        }
        if (deps && typeof deps.renderGroups === 'function') {
            deps.renderGroups();
        }
        return true;
    }

    function toggleGroupCollapse(btn) {
        const appBridge = globalScope.__optionComboApp;
        const groupCard = btn.closest('.group-card');

        if (groupCard && appBridge && typeof appBridge.getState === 'function' && typeof appBridge.renderGroups === 'function') {
            const state = appBridge.getState();
            const group = state.groups.find(entry => entry.id === groupCard.dataset.groupId);
            if (group) {
                group.isCollapsed = !group.isCollapsed;
                appBridge.renderGroups();
                return;
            }
        }

        const card = btn.closest('.panel-card');
        if (!card) return;

        const isCollapsed = card.classList.toggle('collapsed');
        const body = card.querySelector('.group-body');
        if (body) {
            body.hidden = isCollapsed;
        }

        btn.title = isCollapsed ? 'Expand Group' : 'Collapse Group';
        btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    }

    function addGroup(state, generateId, deps) {
        const newGroup = {
            id: generateId(),
            name: `Combo Group ${state.groups.length + 1}`,
            includedInGlobal: true,
            isCollapsed: false,
            livePriceMode: 'midpoint',
            settleUnderlyingPrice: null,
            historicalAutoCloseAtExpiry: true,
            tradeTrigger: _ensureTradeTrigger({}),
            closeExecution: _ensureCloseExecution({}),
            syncAvgCostFromPortfolio: true,
            legs: []
        };

        state.groups.push(newGroup);
        if (deps && typeof deps.renderGroups === 'function') {
            deps.renderGroups();
        }
    }

    function removeGroup(state, groupId, deps) {
        state.groups = state.groups.filter(group => group.id !== groupId);
        deps.handleLiveSubscriptions();
        deps.renderGroups();
    }

    function moveGroupToIndex(state, groupId, targetIndex, deps) {
        const groups = Array.isArray(state && state.groups) ? state.groups : [];
        const currentIndex = groups.findIndex(group => group && group.id === groupId);
        if (currentIndex < 0) {
            return false;
        }

        const boundedIndex = Math.max(0, Math.min(groups.length - 1, targetIndex));
        if (boundedIndex === currentIndex) {
            return false;
        }

        const [group] = groups.splice(currentIndex, 1);
        groups.splice(boundedIndex, 0, group);

        if (deps && typeof deps.renderGroups === 'function') {
            deps.renderGroups();
        }
        return true;
    }

    function moveGroupByOffset(state, groupId, offset, deps) {
        const groups = Array.isArray(state && state.groups) ? state.groups : [];
        const currentIndex = groups.findIndex(group => group && group.id === groupId);
        if (currentIndex < 0) {
            return false;
        }

        return moveGroupToIndex(state, groupId, currentIndex + (parseInt(offset, 10) || 0), deps);
    }

    function moveGroupToTop(state, groupId, deps) {
        return moveGroupToIndex(state, groupId, 0, deps);
    }

    function addLegToGroupById(state, groupId, generateId, deps) {
        const group = state.groups.find(entry => entry.id === groupId);
        if (!group) return;

        group.legs.push({
            id: generateId(),
            type: 'call',
            pos: 1,
            strike: state.underlyingPrice,
            expDate: resolveDefaultLegExpirationDate(state, deps),
            iv: 0.2,
            ivSource: 'manual',
            ivManualOverride: false,
            currentPrice: 0.00,
            currentPriceSource: '',
            portfolioMarketPrice: null,
            portfolioMarketPriceSource: '',
            portfolioUnrealizedPnl: null,
            cost: 0.00,
            closePrice: null,
            underlyingFutureId: ''
        });

        deps.renderGroups();
    }

    function addLegToGroup(state, buttonEl, generateId, deps) {
        const card = buttonEl.closest('.group-card');
        if (!card) return;

        addLegToGroupById(state, card.dataset.groupId, generateId, deps);
    }

    function removeLeg(state, groupId, legId, deps) {
        const group = state.groups.find(entry => entry.id === groupId);
        if (!group) return;

        group.legs = group.legs.filter(leg => leg.id !== legId);
        deps.handleLiveSubscriptions();
        deps.renderGroups();
    }

    function renderGroups(state, deps) {
        const container = document.getElementById('groupsContainer');
        const globalEmptyState = document.getElementById('globalEmptyState');
        const groupTemplate = document.getElementById('groupCardTemplate');
        const legTemplate = document.getElementById('legRowTemplate');
        if (!container || !globalEmptyState || !groupTemplate || !legTemplate) return;

        container.innerHTML = '';

        if (state.groups.length === 0) {
            globalEmptyState.style.display = 'block';
            document.getElementById('globalChartCard').style.display = 'none';
            document.getElementById('globalAmortizedCard').style.display = 'none';
            document.getElementById('probAnalysisCard').style.display = 'none';
            deps.updateDerivedValues();
            return;
        }

        globalEmptyState.style.display = 'none';
        document.getElementById('globalChartCard').style.display = 'block';
        document.getElementById('globalAmortizedCard').style.display = 'block';
        document.getElementById('probAnalysisCard').style.display = 'block';

        state.groups.forEach(group => {
            _ensureTradeTrigger(group);
            _ensureCloseExecution(group);
            _ensurePortfolioAvgCostSync(group);
            _ensureLivePriceMode(group);
            const clone = groupTemplate.content.cloneNode(true);
        const card = clone.querySelector('.group-card');
        card.dataset.groupId = group.id;

            applyCollapsedState(card, group);
            bindGroupHeader(card, group, state, deps);
            bindGroupLegs(card, group, state, legTemplate, deps);
            bindTrialTriggerControls(card, group, state, deps);
            bindCloseGroupControls(card, group, state, deps);
            applyModeLockState(card, group, state, deps);

            container.appendChild(card);
        });

        deps.updateDerivedValues();
    }

    function bindGroupHeader(card, group, state, deps) {
        const legExistsCheckBtn = card.querySelector('.leg-exists-check-btn');
        if (legExistsCheckBtn) {
            legExistsCheckBtn.disabled = !deps.requestLegExistsCheck;
            legExistsCheckBtn.addEventListener('click', () => {
                if (typeof deps.requestLegExistsCheck === 'function') {
                    deps.requestLegExistsCheck(group.id);
                }
            });
        }
        if (deps.supportsAmortizedMode
            && !deps.supportsAmortizedMode(state.underlyingSymbol)
            && group.viewMode === 'amortized') {
            group.viewMode = 'settlement';
        }

        const nameInput = card.querySelector('.group-name-input');
        nameInput.value = group.name;
        nameInput.addEventListener('change', (e) => {
            group.name = e.target.value;
        });

        const trialTriggerToggleBtn = card.querySelector('.trial-trigger-toggle-btn');
        if (trialTriggerToggleBtn) {
            trialTriggerToggleBtn.addEventListener('click', () => {
                const trigger = _ensureTradeTrigger(group);
                if (!trigger) return;
                trigger.isExpanded = !trigger.isExpanded;
                deps.renderGroups();
            });
        }

        const simulateOpenBtn = card.querySelector('.simulate-open-btn');
        if (simulateOpenBtn) {
            simulateOpenBtn.addEventListener('click', () => {
                const result = simulateOpenGroup(group, state, deps);
                if (!result.success && result.reason && typeof globalScope.alert === 'function') {
                    globalScope.alert(result.reason);
                }
            });
        }

        const closeGroupToggleBtn = card.querySelector('.close-group-toggle-btn');
        if (closeGroupToggleBtn) {
            closeGroupToggleBtn.addEventListener('click', () => {
                const closeExecution = _ensureCloseExecution(group);
                if (!closeExecution) return;
                closeExecution.isExpanded = !closeExecution.isExpanded;
                deps.renderGroups();
            });
        }

        const groupIndex = Array.isArray(state && state.groups)
            ? state.groups.findIndex(entry => entry && entry.id === group.id)
            : -1;
        const isFirstGroup = groupIndex <= 0;
        const isLastGroup = groupIndex < 0 || groupIndex >= ((state.groups || []).length - 1);
        const moveTopBtn = card.querySelector('.move-group-top-btn');
        const moveUpBtn = card.querySelector('.move-group-up-btn');
        const moveDownBtn = card.querySelector('.move-group-down-btn');

        if (moveTopBtn) {
            moveTopBtn.disabled = isFirstGroup;
            moveTopBtn.title = isFirstGroup
                ? 'This group is already at the top'
                : 'Move this group to the top';
            moveTopBtn.addEventListener('click', () => {
                moveGroupToTop(state, group.id, deps);
            });
        }

        if (moveUpBtn) {
            moveUpBtn.disabled = isFirstGroup;
            moveUpBtn.title = isFirstGroup
                ? 'This group is already at the top'
                : 'Move this group up';
            moveUpBtn.addEventListener('click', () => {
                moveGroupByOffset(state, group.id, -1, deps);
            });
        }

        if (moveDownBtn) {
            moveDownBtn.disabled = isLastGroup;
            moveDownBtn.title = isLastGroup
                ? 'This group is already at the bottom'
                : 'Move this group down';
            moveDownBtn.addEventListener('click', () => {
                moveGroupByOffset(state, group.id, 1, deps);
            });
        }

        const collapseToggleBtn = card.querySelector('.collapse-toggle-btn');
        if (collapseToggleBtn) {
            collapseToggleBtn.title = group.isCollapsed ? 'Expand Group' : 'Collapse Group';
            collapseToggleBtn.setAttribute('aria-expanded', group.isCollapsed ? 'false' : 'true');
        }

        const globalToggle = card.querySelector('.group-global-toggle');
        if (globalToggle) {
            globalToggle.checked = deps.isGroupIncludedInGlobal(group);
            globalToggle.addEventListener('change', (e) => {
                group.includedInGlobal = e.target.checked;
                deps.updateDerivedValues();
                if (typeof deps.updateProbCharts === 'function') {
                    deps.updateProbCharts();
                }
            });
        }

        const liveToggle = card.querySelector('.live-data-toggle');
        const avgCostSyncToggle = card.querySelector('.avg-cost-sync-toggle');
        const livePriceModeSelect = card.querySelector('.group-live-price-mode-select');
        const historicalEntryBtn = card.querySelector('.historical-entry-btn');
        const historicalEntryHint = card.querySelector('.historical-entry-hint');
        const isHistoricalMode = !!(state && state.marketDataMode === 'historical');
        const autoCloseExpiredAtExpiry = _ensureHistoricalAutoCloseAtExpiry(group);
        const hasOpenPosition = typeof deps.groupHasOpenPosition === 'function'
            ? deps.groupHasOpenPosition(group)
            : (group.legs || []).some((leg) => Math.abs(parseFloat(leg && leg.pos) || 0) > 0.0001);
        const hasLockedEntryCosts = _groupHasCostForAllPositionedLegs(group);
        liveToggle.checked = !!group.liveData;
        applyMarketDataToggleUi(state, group, liveToggle);
        liveToggle.addEventListener('change', (e) => {
            group.liveData = e.target.checked;
            applyMarketDataToggleUi(state, group, liveToggle);
            deps.handleLiveSubscriptions();
        });

        if (avgCostSyncToggle) {
            avgCostSyncToggle.checked = _ensurePortfolioAvgCostSync(group);
            avgCostSyncToggle.addEventListener('change', (e) => {
                group.syncAvgCostFromPortfolio = e.target.checked === true;
                if (group.syncAvgCostFromPortfolio && typeof deps.requestPortfolioAvgCostSnapshot === 'function') {
                    deps.requestPortfolioAvgCostSnapshot();
                }
            });
        }

        if (livePriceModeSelect) {
            livePriceModeSelect.value = _ensureLivePriceMode(group);
            livePriceModeSelect.title = 'Controls the Price column and Live P&L display only. Order pricing still uses the existing midpoint-based execution flow.';
            livePriceModeSelect.addEventListener('change', (e) => {
                group.livePriceMode = String(e.target.value || '').trim().toLowerCase() === 'midpoint'
                    ? 'midpoint'
                    : 'mark';
                e.target.value = group.livePriceMode;
                deps.updateDerivedValues();
            });
        }

        if (historicalEntryBtn) {
            const showHistoricalEntry = isHistoricalMode && hasOpenPosition && !hasLockedEntryCosts;
            historicalEntryBtn.style.display = showHistoricalEntry ? 'inline-flex' : 'none';
            historicalEntryBtn.disabled = !showHistoricalEntry;
            historicalEntryBtn.title = showHistoricalEntry
                ? 'Lock the current replay-day prices into Cost and move this group into Active mode.'
                : '';
            historicalEntryBtn.addEventListener('click', () => {
                if (typeof deps.enterHistoricalReplayGroup === 'function') {
                    deps.enterHistoricalReplayGroup(group);
                }
            });
        }

        if (historicalEntryHint) {
            const showHistoricalEntryHint = isHistoricalMode && !hasLockedEntryCosts;
            historicalEntryHint.style.display = showHistoricalEntryHint ? 'block' : 'none';
            historicalEntryHint.textContent = hasOpenPosition
                ? 'Lock the replay-day prices into Cost when you want this historical position to be considered opened.'
                : 'Add a non-zero leg to enable historical entry locking.';
        }

        applyViewModeState(card, group, deps.getRenderableGroupViewMode(group));

        const settleInput = card.querySelector('.group-settle-underlying-input');
        const historicalExpiryAutoCloseLabel = card.querySelector('.historical-expiry-auto-close-toggle');
        const historicalExpiryAutoCloseInput = card.querySelector('.group-historical-expiry-auto-close');
        const scenarioModeNote = card.querySelector('.scenario-mode-note');
        if (settleInput) {
            settleInput.value = group.settleUnderlyingPrice !== null && group.settleUnderlyingPrice !== undefined
                ? group.settleUnderlyingPrice.toFixed(2)
                : '';
            settleInput.disabled = isHistoricalMode && autoCloseExpiredAtExpiry;
            settleInput.title = isHistoricalMode && autoCloseExpiredAtExpiry
                ? 'Disable auto-close at expiry to enter a scenario underlying price for deliverable settlement analysis.'
                : 'Price of the underlying at expiration (leave empty to use current global price)';
            settleInput.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                group.settleUnderlyingPrice = isNaN(val) ? null : val;
                deps.updateDerivedValues();
            });
        }

        if (historicalExpiryAutoCloseLabel) {
            historicalExpiryAutoCloseLabel.style.display = isHistoricalMode ? 'inline-flex' : 'none';
        }

        if (historicalExpiryAutoCloseInput) {
            historicalExpiryAutoCloseInput.checked = autoCloseExpiredAtExpiry;
            historicalExpiryAutoCloseInput.addEventListener('change', (e) => {
                group.historicalAutoCloseAtExpiry = e.target.checked;
                if (typeof deps.syncHistoricalReplayExpirySettlement === 'function') {
                    deps.syncHistoricalReplayExpirySettlement(group);
                    return;
                }
                deps.renderGroups();
                deps.updateDerivedValues();
            });
        }

        if (scenarioModeNote) {
            scenarioModeNote.textContent = isHistoricalMode && autoCloseExpiredAtExpiry
                ? 'Expired historical legs will default to Close at the expiry-day replay price. Uncheck to model deliverable exercise/assignment with Scenario Underlying Price.'
                : 'Used by Amortized and Settlement modes for expired options without early close.';
        }

        card.querySelector('.remove-group-btn').addEventListener('click', () => {
            removeGroup(state, group.id, deps);
        });
    }

    function bindGroupLegs(card, group, state, legTemplate, deps) {
        const tbody = card.querySelector('.legsTableBody');
        const table = card.querySelector('table');
        const emptyState = card.querySelector('.group-empty-state');

        if (group.legs.length === 0) {
            table.style.display = 'none';
            emptyState.style.display = 'block';
            const templateBtn = emptyState.querySelector('.combo-template-open-btn');
            if (templateBtn) {
                templateBtn.addEventListener('click', () => {
                    openComboTemplateDialog(group, state, deps);
                });
            }
            return;
        }

        table.style.display = 'table';
        emptyState.style.display = 'none';

        group.legs.forEach(leg => {
            const legClone = legTemplate.content.cloneNode(true);
            const tr = legClone.querySelector('tr');
            tr.dataset.id = leg.id;

            bindLegRow(tr, leg, group, state, deps);
            tbody.appendChild(tr);
        });
    }

    function bindTrialTriggerControls(card, group, state, deps) {
        const trigger = _ensureTradeTrigger(group);
        const container = card.querySelector('.trial-trigger-container');
        if (!container) return;

        const enabledInput = container.querySelector('.trial-trigger-enabled');
        const collapseBtn = container.querySelector('.trial-trigger-collapse-btn');
        const conditionInput = container.querySelector('.trial-trigger-condition');
        const priceInput = container.querySelector('.trial-trigger-price');
        const executionModeInput = container.querySelector('.trial-trigger-execution-mode');
        const repriceThresholdInput = container.querySelector('.trial-trigger-reprice-threshold');
        const concessionInput = container.querySelector('.trial-trigger-concession');
        const timeInForceInput = container.querySelector('.trial-trigger-tif');
        const exitEnabledInput = container.querySelector('.trial-trigger-exit-enabled');
        const exitConditionInput = container.querySelector('.trial-trigger-exit-condition');
        const exitPriceInput = container.querySelector('.trial-trigger-exit-price');
        const resetBtn = container.querySelector('.trial-trigger-reset-btn');
        const body = container.querySelector('.trial-trigger-body');
        const helpText = container.querySelector('.trial-trigger-help');

        if (!enabledInput || !collapseBtn || !conditionInput || !priceInput || !executionModeInput || !repriceThresholdInput || !concessionInput || !timeInForceInput || !exitEnabledInput || !exitConditionInput || !exitPriceInput || !resetBtn || !body) {
            return;
        }

        const isHistoricalMode = !!(state && state.marketDataMode === 'historical');
        const executionOptions = Array.from(executionModeInput.options || []);
        const previewOption = executionOptions.find((option) => option.value === 'preview');
        const testSubmitOption = executionOptions.find((option) => option.value === 'test_submit');
        const submitOption = executionOptions.find((option) => option.value === 'submit');

        if (previewOption) {
            previewOption.textContent = 'Preview Only';
        }
        if (testSubmitOption) {
            testSubmitOption.textContent = isHistoricalMode
                ? 'Simulated Test Submit'
                : 'Send to TWS (Test Only)';
        }
        if (submitOption) {
            submitOption.textContent = isHistoricalMode
                ? 'Simulated Submit'
                : 'Send to TWS';
        }

        enabledInput.checked = trigger.enabled;
        conditionInput.value = trigger.condition;
        priceInput.value = trigger.price !== null && trigger.price !== undefined
            ? Number(trigger.price).toFixed(2)
            : '';
        priceInput.disabled = trigger.enabled === true;
        priceInput.title = trigger.enabled
            ? 'Disable Trial Trigger before editing the trigger price.'
            : '';
        executionModeInput.value = trigger.executionMode;
        repriceThresholdInput.value = formatRepriceThresholdValue(trigger.repriceThreshold || 0.01);
        concessionInput.value = Number(trigger.concessionRatio || 0.0).toFixed(2);
        timeInForceInput.value = String(trigger.timeInForce || 'DAY').toUpperCase();
        exitEnabledInput.checked = trigger.exitEnabled === true;
        exitEnabledInput.disabled = trigger.enabled === true;
        exitConditionInput.value = trigger.exitCondition || 'lte';
        exitConditionInput.disabled = trigger.enabled === true || trigger.exitEnabled !== true;
        exitPriceInput.value = trigger.exitPrice !== null && trigger.exitPrice !== undefined
            ? Number(trigger.exitPrice).toFixed(2)
            : '';
        exitPriceInput.disabled = trigger.enabled === true || trigger.exitEnabled !== true;
        exitPriceInput.title = trigger.enabled
            ? 'Disable Trial Trigger before editing the exit condition.'
            : '';
        executionModeInput.title = isHistoricalMode
            ? 'Historical replay never routes orders to TWS. Submit modes only create a simulated order runtime from replay-day quotes.'
            : (state.allowLiveComboOrders
                ? ''
                : 'Global live combo order switch is OFF. TWS submit modes will not send orders until enabled.');
        if (helpText) {
            helpText.textContent = isHistoricalMode
                ? 'Only works when this group is in Trial mode and Historical Replay is enabled. Preview mode stays local, and submit modes only create a simulated order runtime from replay-day quotes.'
                : 'Only works when this group is in Trial mode and Live Market Data is enabled. Preview mode never sends orders.';
        }
        body.style.display = trigger.isCollapsed ? 'none' : 'block';
        collapseBtn.title = trigger.isCollapsed ? 'Expand Trial Trigger' : 'Collapse Trial Trigger';
        collapseBtn.setAttribute('aria-expanded', trigger.isCollapsed ? 'false' : 'true');

        collapseBtn.addEventListener('click', () => {
            trigger.isCollapsed = !trigger.isCollapsed;
            deps.renderGroups();
        });

        enabledInput.addEventListener('change', (e) => {
            trigger.enabled = e.target.checked === true;
            trigger.pendingRequest = false;
            trigger.status = trigger.enabled ? 'armed' : 'idle';
            trigger.lastError = '';
            deps.renderGroups();
        });

        conditionInput.addEventListener('change', (e) => {
            trigger.condition = e.target.value === 'lte' ? 'lte' : 'gte';
        });

        priceInput.addEventListener('input', (e) => {
            const parsed = parseFloat(e.target.value);
            trigger.price = Number.isFinite(parsed) ? parsed : null;
        });

        executionModeInput.addEventListener('change', (e) => {
            if (e.target.value === 'submit' || e.target.value === 'test_submit') {
                trigger.executionMode = e.target.value;
            } else {
                trigger.executionMode = 'preview';
            }
        });

        repriceThresholdInput.addEventListener('change', (e) => {
            const parsed = parseFloat(e.target.value);
            const validThresholds = _getValidTradeTriggerThresholds();
            trigger.repriceThreshold = validThresholds.some(value => Math.abs(value - parsed) < 0.0001)
                ? parsed
                : 0.01;
            e.target.value = formatRepriceThresholdValue(trigger.repriceThreshold);
        });

        concessionInput.addEventListener('change', (e) => {
            const parsed = parseFloat(e.target.value);
            const validRatios = [0.0, 0.10, 0.20, 0.30, 0.50, 0.75];
            trigger.concessionRatio = validRatios.some(value => Math.abs(value - parsed) < 0.0001)
                ? parsed
                : 0.0;
            e.target.value = Number(trigger.concessionRatio).toFixed(2);
        });

        timeInForceInput.addEventListener('change', (e) => {
            const nextTif = String(e.target.value || '').trim().toUpperCase();
            const validTifs = _getValidTradeTriggerTifs();
            trigger.timeInForce = validTifs.includes(nextTif) ? nextTif : 'DAY';
            e.target.value = trigger.timeInForce;
        });

        exitEnabledInput.addEventListener('change', (e) => {
            trigger.exitEnabled = e.target.checked === true;
            deps.renderGroups();
        });

        exitConditionInput.addEventListener('change', (e) => {
            trigger.exitCondition = e.target.value === 'gte' ? 'gte' : 'lte';
        });

        exitPriceInput.addEventListener('input', (e) => {
            const parsed = parseFloat(e.target.value);
            trigger.exitPrice = Number.isFinite(parsed) ? parsed : null;
        });

        resetBtn.addEventListener('click', () => {
            trigger.pendingRequest = false;
            trigger.enabled = false;
            trigger.status = 'idle';
            trigger.lastTriggeredAt = null;
            trigger.lastTriggerPrice = null;
            trigger.lastPreview = null;
            trigger.lastError = '';
            deps.renderGroups();
        });

        const handleContinueRepricing = (e) => {
            const continueBtn = e.target.closest('.trial-trigger-continue-repricing-btn');
            const manualConcedeBtn = e.target.closest('.trial-trigger-concede-step-btn');
            const concedeBtn = e.target.closest('.trial-trigger-concede-btn');
            const cancelBtn = e.target.closest('.trial-trigger-cancel-order-btn');
            if (!continueBtn && !manualConcedeBtn && !concedeBtn && !cancelBtn) {
                return;
            }
            if (typeof e.preventDefault === 'function') {
                e.preventDefault();
            }
            if (continueBtn && typeof deps.requestContinueManagedComboOrder === 'function') {
                deps.requestContinueManagedComboOrder(group);
            } else if (manualConcedeBtn && typeof deps.requestManualConcedeManagedComboOrder === 'function') {
                const manualContainer = manualConcedeBtn.closest('.trial-trigger-manual-concede-group');
                const stepInput = manualContainer
                    ? manualContainer.querySelector('.trial-trigger-concede-step-input')
                    : null;
                deps.requestManualConcedeManagedComboOrder(group, stepInput ? stepInput.value : '');
            } else if (concedeBtn && typeof deps.requestConcedeManagedComboOrder === 'function') {
                const concedeContainer = concedeBtn.closest('.trial-trigger-concede-group');
                const concedeSelect = concedeContainer
                    ? concedeContainer.querySelector('.trial-trigger-concede-select')
                    : null;
                const concedeValue = concedeSelect ? concedeSelect.value : concedeBtn.dataset.value;
                deps.requestConcedeManagedComboOrder(group, concedeValue);
            } else if (cancelBtn && typeof deps.requestCancelManagedComboOrder === 'function') {
                deps.requestCancelManagedComboOrder(group, 'manual_cancel');
            }
        };

        container.addEventListener('pointerdown', handleContinueRepricing);
        container.addEventListener('click', handleContinueRepricing);
    }

    function _escapeCloseConfirmationHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function _formatCloseConfirmationNumber(value, fallback = '—') {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) {
            return fallback;
        }
        return parsed.toFixed(4).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
    }

    function openLegPositionCheckDialog(context) {
        const doc = globalScope.document;
        const result = context && context.result;
        if (!doc || !doc.body || !result) return false;
        let dialog = doc.getElementById('legPositionCheckDialog');
        if (!dialog) {
            dialog = doc.createElement('div');
            dialog.id = 'legPositionCheckDialog';
            dialog.className = 'close-confirmation-dialog';
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.innerHTML = `
                <div class="close-confirmation-panel" style="width:min(900px,96vw)">
                    <div class="close-confirmation-header">
                        <div>
                            <div class="close-confirmation-title">Leg Exists Check</div>
                            <div class="leg-check-subtitle text-muted small"></div>
                        </div>
                        <button type="button" class="btn btn-secondary btn-sm leg-check-close-btn">Close</button>
                    </div>
                    <div class="close-confirmation-summary leg-check-summary"></div>
                    <div class="close-confirmation-table-shell">
                        <table class="close-confirmation-table">
                            <thead><tr><th>Contract</th><th>Workspace Qty</th><th>TWS Qty</th><th>Status</th><th>Groups</th></tr></thead>
                            <tbody class="leg-check-body"></tbody>
                        </table>
                    </div>
                </div>`;
            const close = () => { dialog.style.display = 'none'; };
            dialog.querySelector('.leg-check-close-btn').addEventListener('click', close);
            dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
            doc.body.appendChild(dialog);
        }
        const rows = Array.isArray(result.rows) ? result.rows : [];
        const statusLabels = {
            matched: 'Matched',
            missing: 'Missing in TWS',
            opposite: 'Opposite direction',
            quantity_mismatch: 'Quantity mismatch',
        };
        dialog.querySelector('.leg-check-subtitle').textContent = `${context.title || 'All Groups'} · Account ${result.account || 'not selected'} · ${new Date(result.checkedAt).toLocaleTimeString()}`;
        dialog.querySelector('.leg-check-summary').innerHTML = result.ibConnected === false
            ? '<span class="leg-check-status-missing">TWS positions are not ready; quantities could not be verified.</span>'
            : (rows.length === 0
                ? '<span class="text-muted">No open, non-zero legs were found in this scope.</span>'
                : `<span><strong>${result.ok ? '✓ All matched' : '⚠ Issues found'}</strong></span><span>Matched: ${result.matched}</span><span>Issues: ${result.issues}</span>`);
        dialog.querySelector('.leg-check-body').innerHTML = rows.length
            ? rows.map((row) => `<tr>
                <td>${_escapeCloseConfirmationHtml(row.label)}</td>
                <td>${_formatCloseConfirmationNumber(row.expected)}</td>
                <td>${_formatCloseConfirmationNumber(row.actual, '0')}</td>
                <td class="leg-check-status-${_escapeCloseConfirmationHtml(row.status)}">${_escapeCloseConfirmationHtml(statusLabels[row.status] || row.status)}</td>
                <td>${_escapeCloseConfirmationHtml((row.groupNames || []).join(', '))}</td>
            </tr>`).join('')
            : '<tr><td colspan="5" class="text-muted">No non-zero legs were found in this scope.</td></tr>';
        dialog.style.display = 'flex';
        return true;
    }

    function _closeTreatmentLabel(treatment) {
        switch (String(treatment || '').trim()) {
            case 'combo_close': return 'Option Combo Close';
            case 'underlying_close': return 'Close Existing Underlying';
            case 'itm_hedged': return 'Expiry Hedge';
            case 'otm_ignored': return 'Ignore to Expiry';
            default: return String(treatment || 'Review');
        }
    }

    function _renderPositionReductionWarning(context) {
        const warnings = Array.isArray(context && context.positionWarnings) ? context.positionWarnings : [];
        if (context && context.positionSnapshotAvailable !== true) {
            return '<div class="position-reduction-warning"><strong>Position check unavailable.</strong> The latest TWS portfolio snapshot is not available, so this order cannot be checked for netting against existing positions.</div>';
        }
        if (warnings.length === 0) {
            const safeMessage = context && context.crossGroupWarningsOnly
                ? '✓ No other workspace Group is allocated to the contracts being closed.'
                : '✓ This order does not reduce any position in the latest TWS snapshot.';
            return `<div class="close-confirmation-summary"><span class="leg-check-status-matched">${safeMessage}</span></div>`;
        }
        const rows = warnings.map((warning) => {
            const groups = (warning.otherGroupNames || []).length
                ? ` Other workspace groups using this contract: ${(warning.otherGroupNames || []).join(', ')}.`
                : '';
            return `<li><strong>${_escapeCloseConfirmationHtml(warning.label)}</strong>: TWS ${_formatCloseConfirmationNumber(warning.current)}, order ${_formatCloseConfirmationNumber(warning.orderDelta)}, projected ${_formatCloseConfirmationNumber(warning.projected)}.${_escapeCloseConfirmationHtml(groups)}</li>`;
        }).join('');
        return `<div class="position-reduction-warning"><strong>WARNING: this order may close or reduce existing TWS positions.</strong><ul style="margin:0.5rem 0 0 1.2rem">${rows}</ul><div style="margin-top:0.5rem">TWS nets identical contracts at account level; it does not preserve this app's Group ownership.</div></div>`;
    }

    function openComboSubmissionConfirmationDialog(context) {
        const doc = globalScope.document;
        if (!doc || !doc.body || !context || !context.payload) return false;
        let dialog = doc.getElementById('comboSubmissionConfirmationDialog');
        if (!dialog) {
            dialog = doc.createElement('div');
            dialog.id = 'comboSubmissionConfirmationDialog';
            dialog.className = 'close-confirmation-dialog';
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.innerHTML = `
                <div class="close-confirmation-panel" style="width:min(980px,96vw)">
                    <div class="close-confirmation-header">
                        <div><div class="close-confirmation-title">Confirm Combo Order</div><div class="combo-submit-subtitle text-muted small"></div></div>
                        <button type="button" class="btn btn-secondary btn-sm combo-submit-cancel-btn">Cancel</button>
                    </div>
                    <div class="close-confirmation-live-warning combo-submit-live-warning"></div>
                    <div class="combo-submit-position-warning"></div>
                    <h4>Order legs</h4>
                    <div class="close-confirmation-table-shell"><table class="close-confirmation-table">
                        <thead><tr><th>Contract</th><th>Action</th><th>Quantity</th></tr></thead><tbody class="combo-submit-leg-body"></tbody>
                    </table></div>
                    <div class="close-confirmation-footer"><span class="text-muted small">Identical contracts are netted by TWS at account level.</span><div class="close-confirmation-footer-actions">
                        <button type="button" class="btn btn-secondary combo-submit-cancel-btn">Cancel</button>
                        <button type="button" class="btn btn-primary combo-submit-confirm-btn">Confirm &amp; Submit to TWS</button>
                    </div></div>
                </div>`;
            const close = (cancel) => {
                const active = dialog._comboSubmitContext;
                dialog.style.display = 'none';
                dialog._comboSubmitContext = null;
                if (cancel && active && typeof active.onCancel === 'function') active.onCancel();
            };
            dialog.querySelectorAll('.combo-submit-cancel-btn').forEach((button) => button.addEventListener('click', () => close(true)));
            dialog.addEventListener('click', (event) => { if (event.target === dialog) close(true); });
            const submit = dialog.querySelector('.combo-submit-confirm-btn');
            submit.addEventListener('click', () => {
                const active = dialog._comboSubmitContext;
                if (!active || typeof active.onConfirm !== 'function') return;
                submit.disabled = true;
                const confirmed = active.onConfirm();
                if (confirmed !== false) close(false);
                else submit.disabled = false;
            });
            doc.body.appendChild(dialog);
        }
        const payload = context.payload;
        const validationLegs = new Map((context.validation && context.validation.legs || []).map((leg) => [String(leg.id || ''), leg]));
        const account = String(payload.account || '').trim() || 'Not selected';
        dialog._comboSubmitContext = context;
        dialog.querySelector('.combo-submit-subtitle').textContent = `${context.group && context.group.name || payload.groupName || 'Group'} · Account ${account}`;
        dialog.querySelector('.combo-submit-live-warning').innerHTML = context.targetMode === 'test_submit'
            ? '<strong>TEST-ONLY TWS submission.</strong> This still sends orders to TWS.'
            : '<strong>LIVE TWS submission.</strong> Confirming sends this combo order.';
        dialog.querySelector('.combo-submit-position-warning').innerHTML = _renderPositionReductionWarning(context);
        dialog.querySelector('.combo-submit-leg-body').innerHTML = (payload.legs || []).map((leg) => {
            const resolved = validationLegs.get(String(leg.id || '')) || {};
            const name = resolved.localSymbol || leg.localSymbol || `${leg.symbol || ''} ${leg.expDate || leg.contractMonth || ''} ${leg.right || ''}${leg.strike || ''}`;
            const quantity = parseFloat(leg.pos) || 0;
            return `<tr><td>${_escapeCloseConfirmationHtml(name)}</td><td><strong>${quantity > 0 ? 'BUY' : 'SELL'}</strong></td><td>${_formatCloseConfirmationNumber(Math.abs(quantity))}</td></tr>`;
        }).join('');
        dialog.querySelector('.combo-submit-confirm-btn').disabled = false;
        dialog.querySelector('.combo-submit-confirm-btn').textContent = context.targetMode === 'test_submit' ? 'Confirm & Send Test Order' : 'Confirm & Submit to TWS';
        dialog.style.display = 'flex';
        return true;
    }

    function _ensureCloseConfirmationDialog() {
        const doc = globalScope.document;
        if (!doc || !doc.body || typeof doc.createElement !== 'function') {
            return null;
        }
        let dialog = doc.getElementById('closeConfirmationDialog');
        if (dialog) {
            return dialog;
        }

        dialog = doc.createElement('div');
        dialog.id = 'closeConfirmationDialog';
        dialog.className = 'close-confirmation-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'closeConfirmationDialogTitle');
        dialog.innerHTML = `
            <div class="close-confirmation-panel">
                <div class="close-confirmation-header">
                    <div>
                        <div id="closeConfirmationDialogTitle" class="close-confirmation-title">Confirm Close Plan</div>
                        <div class="close-confirmation-subtitle text-muted small"></div>
                    </div>
                    <button type="button" class="btn btn-secondary btn-sm close-confirmation-cancel-btn">Cancel</button>
                </div>
                <div class="close-confirmation-live-warning"></div>
                <div class="close-confirmation-position-check"></div>
                <div class="close-confirmation-summary"></div>
                <h4>Leg treatment</h4>
                <div class="close-confirmation-table-shell">
                    <table class="close-confirmation-table">
                        <thead><tr><th>Leg</th><th>Position</th><th>Quote</th><th>Treatment</th><th>Underlying allocation</th></tr></thead>
                        <tbody class="close-confirmation-leg-body"></tbody>
                    </table>
                </div>
                <h4>Orders authorized by this confirmation</h4>
                <div class="close-confirmation-table-shell">
                    <table class="close-confirmation-table">
                        <thead><tr><th>Stage</th><th>Instrument</th><th>Action</th><th>Quantity</th><th>Initial limit</th><th>TIF</th></tr></thead>
                        <tbody class="close-confirmation-order-body"></tbody>
                    </table>
                </div>
                <div class="close-confirmation-warning-text"></div>
                <div class="close-confirmation-footer">
                    <span class="close-confirmation-expiry text-muted small"></span>
                    <div class="close-confirmation-footer-actions">
                        <button type="button" class="btn btn-secondary close-confirmation-cancel-btn">Cancel</button>
                        <button type="button" class="btn btn-primary close-confirmation-submit-btn">Confirm &amp; Submit to TWS</button>
                    </div>
                </div>
            </div>
        `;

        const closeDialog = (invokeCancel) => {
            const context = dialog._closeConfirmationContext;
            dialog.style.display = 'none';
            dialog._closeConfirmationContext = null;
            if (invokeCancel && context && typeof context.onCancel === 'function') {
                context.onCancel();
            }
        };
        dialog.querySelectorAll('.close-confirmation-cancel-btn').forEach((button) => {
            button.addEventListener('click', () => closeDialog(true));
        });
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) {
                closeDialog(true);
            }
        });
        const submitButton = dialog.querySelector('.close-confirmation-submit-btn');
        submitButton.addEventListener('click', () => {
            const context = dialog._closeConfirmationContext;
            if (!context || typeof context.onConfirm !== 'function') {
                return;
            }
            submitButton.disabled = true;
            const confirmed = context.onConfirm();
            if (confirmed !== false) {
                closeDialog(false);
            } else {
                submitButton.disabled = false;
            }
        });
        doc.body.appendChild(dialog);
        return dialog;
    }

    function openCloseConfirmationDialog(context) {
        const dialog = _ensureCloseConfirmationDialog();
        if (!dialog || !context || !context.preview) {
            return false;
        }
        const preview = context.preview;
        const group = context.group || {};
        const targetMode = String(context.targetMode || '').trim();
        const isTestMode = targetMode === 'test_submit';
        const legs = Array.isArray(preview.closePlanLegs) ? preview.closePlanLegs : [];
        const orders = Array.isArray(preview.closePlanOrders) ? preview.closePlanOrders : [];
        const account = String(preview.account || '').trim() || 'Not selected';
        const strategy = String(group.closeExecution && group.closeExecution.pendingCloseStrategy || group.closeExecution && group.closeExecution.strategy || 'auto');
        const closeQuantity = parseInt(context.closeQuantity, 10);
        const closeMaxQuantity = parseInt(context.closeMaxQuantity, 10);
        const remainingQuantity = Number.isInteger(closeQuantity) && Number.isInteger(closeMaxQuantity)
            ? Math.max(closeMaxQuantity - closeQuantity, 0)
            : null;

        dialog._closeConfirmationContext = context;
        dialog.querySelector('.close-confirmation-subtitle').textContent = `${group.name || preview.groupName || 'Group'} · Account ${account}`;
        dialog.querySelector('.close-confirmation-live-warning').innerHTML = isTestMode
            ? '<strong>TEST-ONLY TWS submission.</strong> Guardrail limits are intentionally away from market, but this still sends orders to TWS.'
            : '<strong>LIVE TWS submission.</strong> Confirming authorizes the ordered workflow shown below.';
        dialog.querySelector('.close-confirmation-position-check').innerHTML = _renderPositionReductionWarning(context);
        dialog.querySelector('.close-confirmation-summary').innerHTML = `
            <span><strong>Strategy:</strong> ${_escapeCloseConfirmationHtml(strategy)}</span>
            <span><strong>Account:</strong> ${_escapeCloseConfirmationHtml(account)}</span>
            <span><strong>Orders:</strong> ${orders.length}</span>
            <span><strong>Legs:</strong> ${legs.length}</span>
            ${Number.isInteger(closeQuantity) ? `<span><strong>Close Qty:</strong> ${closeQuantity} of ${closeMaxQuantity}</span>` : ''}
            ${Number.isInteger(remainingQuantity) ? `<span><strong>Remaining:</strong> ${remainingQuantity} strategy unit${remainingQuantity === 1 ? '' : 's'}</span>` : ''}
            <span><strong>Initial concession:</strong> ${_formatCloseConfirmationNumber((group.closeExecution && group.closeExecution.concessionRatio || 0) * 100)}%</span>
            <span><strong>Drift:</strong> ${_formatCloseConfirmationNumber(group.closeExecution && group.closeExecution.repriceThreshold)}</span>
        `;

        const legBody = dialog.querySelector('.close-confirmation-leg-body');
        legBody.innerHTML = legs.length > 0
            ? legs.map((leg) => {
                const optionName = leg.right
                    ? `${leg.symbol || ''} ${leg.expiry || ''} ${leg.right}${_formatCloseConfirmationNumber(leg.strike, '')}`
                    : `${leg.symbol || ''} ${leg.secType || ''}`;
                const quote = `Bid ${_formatCloseConfirmationNumber(leg.observedBid)} / Ask ${_formatCloseConfirmationNumber(leg.observedAsk)}`;
                const required = parseFloat(leg.requiredUnderlyingQuantity);
                const netted = parseFloat(leg.internallyNettedUnderlyingQuantity);
                const executed = parseFloat(leg.executedUnderlyingQuantity);
                const allocation = Number.isFinite(required)
                    ? `Need ${_formatCloseConfirmationNumber(required)}; net ${_formatCloseConfirmationNumber(netted, '0')}; trade ${_formatCloseConfirmationNumber(executed, '0')}`
                    : '—';
                return `<tr>
                    <td>${_escapeCloseConfirmationHtml(optionName)}</td>
                    <td>${_formatCloseConfirmationNumber(leg.originalPosition)} → ${_formatCloseConfirmationNumber(leg.remainingPosition, _formatCloseConfirmationNumber(leg.closePosition))}</td>
                    <td>${_escapeCloseConfirmationHtml(quote)}</td>
                    <td>${_escapeCloseConfirmationHtml(_closeTreatmentLabel(leg.treatment))}</td>
                    <td>${_escapeCloseConfirmationHtml(allocation)}</td>
                </tr>`;
            }).join('')
            : '<tr><td colspan="5" class="text-muted">No leg treatment rows were returned.</td></tr>';

        const orderBody = dialog.querySelector('.close-confirmation-order-body');
        orderBody.innerHTML = orders.length > 0
            ? orders.map((order, index) => `<tr>
                <td>${index + 1}. ${_escapeCloseConfirmationHtml(order.stage || '')}</td>
                <td>${_escapeCloseConfirmationHtml(`${order.symbol || ''} ${order.secType || order.orderKind || ''}`)}</td>
                <td><strong>${_escapeCloseConfirmationHtml(order.orderAction || '')}</strong></td>
                <td>${_formatCloseConfirmationNumber(order.quantity)}</td>
                <td>${_formatCloseConfirmationNumber(order.limitPrice)}</td>
                <td>${_escapeCloseConfirmationHtml(order.timeInForce || preview.timeInForce || '')}</td>
            </tr>`).join('')
            : '<tr><td colspan="6">No TWS order is required; all selected obligations are ignored-to-expiry or internally netted.</td></tr>';

        const hasUnderlyingFirst = orders.some((order) => order.stage === 'underlying');
        const workflowNote = hasUnderlyingFirst
            ? 'Underlying stages are submitted first. Remaining option orders are submitted only after those fills; this is one confirmation but not an atomic multi-leg transaction. '
            : '';
        dialog.querySelector('.close-confirmation-warning-text').textContent = `${workflowNote}${preview.closePlanMessage || preview.pricingNote || ''} Initial limits are frozen from this plan; managed repricing may subsequently follow the displayed concession and drift policy.`;
        const expiresAt = String(preview.closePlanExpiresAt || '').trim();
        dialog.querySelector('.close-confirmation-expiry').textContent = expiresAt
            ? `This one-time plan expires at ${new Date(expiresAt).toLocaleTimeString()}.`
            : 'This one-time plan has a short confirmation lifetime.';

        dialog.querySelector('.close-confirmation-submit-btn').disabled = false;
        dialog.querySelector('.close-confirmation-submit-btn').textContent = isTestMode
            ? 'Confirm & Send Test Orders'
            : 'Confirm & Submit to TWS';
        dialog.style.display = 'flex';
        return true;
    }

    function bindCloseGroupControls(card, group, state, deps) {
        const closeExecution = _ensureCloseExecution(group);
        const container = card.querySelector('.close-group-container');
        if (!container || !closeExecution) return;

        const quantityInput = container.querySelector('.close-group-quantity');
        const strategyInput = container.querySelector('.close-group-strategy');
        const executionModeInput = container.querySelector('.close-group-execution-mode');
        const thresholdInput = container.querySelector('.close-group-reprice-threshold');
        const concessionInput = container.querySelector('.close-group-concession');
        const timeInForceInput = container.querySelector('.close-group-tif');
        const submitBtn = container.querySelector('.close-group-submit-btn');
        const equivalentBtn = container.querySelector('.close-group-equivalent-btn');
        const helpText = container.querySelector('.close-group-help');
        if (!quantityInput || !strategyInput || !executionModeInput || !thresholdInput || !concessionInput
            || !timeInForceInput || !submitBtn || !equivalentBtn) {
            return;
        }

        const isHistoricalMode = state && state.marketDataMode === 'historical';
        const renderMode = deps.getRenderableGroupViewMode(group);
        const hasOpenPosition = typeof deps.groupHasOpenPosition === 'function'
            ? deps.groupHasOpenPosition(group)
            : (group.legs || []).some(leg => Math.abs(parseFloat(leg && leg.pos) || 0) > 0.0001);
        const hasLockedEntryCosts = _groupHasCostForAllPositionedLegs(group);
        const groupOrderBuilder = _getGroupOrderBuilderApi();
        const maxCloseQuantity = groupOrderBuilder
            && typeof groupOrderBuilder.resolveGroupCloseQuantity === 'function'
            ? groupOrderBuilder.resolveGroupCloseQuantity(group)
            : 0;
        const configuredQuantity = parseInt(closeExecution.quantity, 10);
        closeExecution.quantity = Number.isInteger(configuredQuantity) && configuredQuantity >= 1
            ? Math.min(configuredQuantity, maxCloseQuantity || configuredQuantity)
            : maxCloseQuantity;
        const brokerStatus = String(closeExecution.lastPreview && closeExecution.lastPreview.status || '').trim();
        const lastRequestSource = String(closeExecution.lastPreview && closeExecution.lastPreview.requestSource || '').trim();
        const lastPlanStage = String(closeExecution.lastPreview && closeExecution.lastPreview.closePlanStage || '').trim();
        const isStagedUnderlyingClose = lastRequestSource === 'close_group_underlying'
            || (lastPlanStage === 'underlying'
                && closeExecution.lastPreview
                && closeExecution.lastPreview.closePlanComplete === false);
        const isCompleted = brokerStatus === 'Filled' && !isStagedUnderlyingClose && !hasOpenPosition;

        if (isHistoricalMode) {
            closeExecution.executionMode = 'preview';
            closeExecution.quantity = maxCloseQuantity;
        }
        quantityInput.min = '1';
        quantityInput.max = String(maxCloseQuantity || 1);
        quantityInput.value = String(closeExecution.quantity || maxCloseQuantity || 1);
        quantityInput.title = maxCloseQuantity > 0
            ? `Close 1 to ${maxCloseQuantity} complete strategy unit${maxCloseQuantity === 1 ? '' : 's'}.`
            : 'No complete strategy unit is available to close.';
        strategyInput.value = String(closeExecution.strategy || 'auto').toLowerCase();
        executionModeInput.value = String(closeExecution.executionMode || 'preview');
        thresholdInput.value = formatRepriceThresholdValue(closeExecution.repriceThreshold || 0.01);
        concessionInput.value = Number(closeExecution.concessionRatio || 0.0).toFixed(2);
        timeInForceInput.value = String(closeExecution.timeInForce || 'DAY').toUpperCase();

        quantityInput.disabled = isHistoricalMode || closeExecution.pendingRequest === true || isCompleted || maxCloseQuantity < 1;
        strategyInput.disabled = isHistoricalMode || closeExecution.pendingRequest === true || isCompleted;
        executionModeInput.disabled = isHistoricalMode || closeExecution.pendingRequest === true || isCompleted;
        thresholdInput.disabled = isHistoricalMode || closeExecution.pendingRequest === true || isCompleted;
        concessionInput.disabled = isHistoricalMode || closeExecution.pendingRequest === true || isCompleted;
        timeInForceInput.disabled = isHistoricalMode || closeExecution.pendingRequest === true || isCompleted;
        if (helpText) {
            const quantityText = maxCloseQuantity > 1
                ? `Close Qty ${closeExecution.quantity} of ${maxCloseQuantity}; the remaining leg positions stay open. `
                : '';
            helpText.textContent = isHistoricalMode
                ? 'Snapshots every open leg at the current replay day, writes those prices into Close, and switches the group into Settlement mode.'
                : quantityText + (closeExecution.quantity < maxCloseQuantity || closeExecution.strategy === 'combo'
                    ? 'Combo Only always sends the reverse option combo and never substitutes an expiry hedge.'
                    : 'Auto normally sends the reverse combo, but can ignore clearly worthless OTM legs and hedge deep ITM one-sided legs with net Underlying. Expiry Equivalent forces that analysis.');
        }

        if (isCompleted) {
            submitBtn.style.display = 'none';
            equivalentBtn.style.display = 'none';
            submitBtn.disabled = true;
            equivalentBtn.disabled = true;
            submitBtn.title = 'This group is already fully closed.';
        } else {
            submitBtn.style.display = '';
            equivalentBtn.style.display = isHistoricalMode ? 'none' : '';
        }

        if (isCompleted) {
            // Keep the filled summary visible, but remove any further close action affordance.
        } else if (!isHistoricalMode && renderMode !== 'active') {
            submitBtn.disabled = true;
            submitBtn.title = 'Close Group is only available when this group is in Active mode.';
        } else if (isHistoricalMode && !hasLockedEntryCosts) {
            submitBtn.disabled = true;
            submitBtn.title = 'Lock entry costs first with Enter @ Replay Day before settling this group.';
        } else if (!hasOpenPosition) {
            submitBtn.disabled = true;
            submitBtn.title = 'This group has no open position to close.';
        } else if (closeExecution.pendingRequest === true) {
            submitBtn.disabled = true;
            submitBtn.title = 'A close-group order request is already in progress.';
        } else {
            submitBtn.disabled = false;
            submitBtn.title = isHistoricalMode
                ? 'Close every open leg at the current historical replay price.'
                : (closeExecution.executionMode === 'preview'
                    ? 'Preview the reverse combo for all non-zero legs in this group.'
                    : 'Submit a managed combo order that reverses all non-zero legs in this group.');
        }

        if (!isCompleted && !isHistoricalMode) {
            if (renderMode !== 'active') {
                equivalentBtn.disabled = true;
                equivalentBtn.title = 'Expiry Equivalent is only available when this group is in Active mode.';
            } else if (!hasOpenPosition) {
                equivalentBtn.disabled = true;
                equivalentBtn.title = 'This group has no open position to close.';
            } else if (closeExecution.pendingRequest === true) {
                equivalentBtn.disabled = true;
                equivalentBtn.title = 'A close-group order request is already in progress.';
            } else if (closeExecution.quantity < maxCloseQuantity) {
                equivalentBtn.disabled = true;
                equivalentBtn.title = 'Expiry Equivalent requires closing the full group quantity.';
            } else {
                equivalentBtn.disabled = false;
                equivalentBtn.title = 'Force expiry-equivalent analysis for standard physically settled stock options; preview first when selected.';
            }
        }

        submitBtn.textContent = isHistoricalMode
            ? 'Settle @ Replay Day'
            : (closeExecution.executionMode === 'preview'
                ? 'Preview Close'
                : (closeExecution.executionMode === 'test_submit' ? 'Send Test Close' : 'Close Group'));
        equivalentBtn.textContent = closeExecution.executionMode === 'preview'
            ? 'Preview Equivalent'
            : (closeExecution.executionMode === 'test_submit' ? 'Test Equivalent' : 'Expiry Equivalent');

        quantityInput.addEventListener('change', (e) => {
            const parsed = parseInt(e.target.value, 10);
            closeExecution.quantity = Number.isInteger(parsed)
                ? Math.min(Math.max(parsed, 1), maxCloseQuantity || 1)
                : (maxCloseQuantity || 1);
            if (closeExecution.quantity < maxCloseQuantity) {
                closeExecution.strategy = 'combo';
            }
            e.target.value = String(closeExecution.quantity);
            deps.renderGroups();
        });

        strategyInput.addEventListener('change', (e) => {
            const nextStrategy = String(e.target.value || '').trim().toLowerCase();
            closeExecution.strategy = ['auto', 'combo'].includes(nextStrategy) ? nextStrategy : 'auto';
            e.target.value = closeExecution.strategy;
            deps.renderGroups();
        });

        executionModeInput.addEventListener('change', (e) => {
            const nextMode = String(e.target.value || '').trim();
            closeExecution.executionMode = ['preview', 'test_submit', 'submit'].includes(nextMode)
                ? nextMode
                : 'preview';
            e.target.value = closeExecution.executionMode;
            deps.renderGroups();
        });

        thresholdInput.addEventListener('change', (e) => {
            const parsed = parseFloat(e.target.value);
            const validThresholds = _getValidTradeTriggerThresholds();
            closeExecution.repriceThreshold = validThresholds.some(value => Math.abs(value - parsed) < 0.0001)
                ? parsed
                : 0.01;
            e.target.value = formatRepriceThresholdValue(closeExecution.repriceThreshold);
        });

        concessionInput.addEventListener('change', (e) => {
            const parsed = parseFloat(e.target.value);
            const validRatios = [0.0, 0.10, 0.20, 0.30, 0.50, 0.75];
            closeExecution.concessionRatio = validRatios.some(value => Math.abs(value - parsed) < 0.0001)
                ? parsed
                : 0.0;
            e.target.value = Number(closeExecution.concessionRatio).toFixed(2);
        });

        timeInForceInput.addEventListener('change', (e) => {
            const nextTif = String(e.target.value || '').trim().toUpperCase();
            const validTifs = _getValidTradeTriggerTifs();
            closeExecution.timeInForce = validTifs.includes(nextTif) ? nextTif : 'DAY';
            e.target.value = closeExecution.timeInForce;
        });

        submitBtn.addEventListener('click', () => {
            if (typeof deps.requestCloseGroupComboOrder === 'function') {
                deps.requestCloseGroupComboOrder(group);
            }
        });

        equivalentBtn.addEventListener('click', () => {
            if (typeof deps.requestEquivalentCloseGroupComboOrder === 'function') {
                deps.requestEquivalentCloseGroupComboOrder(group);
            }
        });

        const handleCloseGroupAction = (e) => {
            const continueBtn = e.target.closest('.trial-trigger-continue-repricing-btn');
            const manualConcedeBtn = e.target.closest('.trial-trigger-concede-step-btn');
            const concedeBtn = e.target.closest('.trial-trigger-concede-btn');
            const cancelBtn = e.target.closest('.trial-trigger-cancel-order-btn');
            if (!continueBtn && !manualConcedeBtn && !concedeBtn && !cancelBtn) {
                return;
            }

            if (typeof e.preventDefault === 'function') {
                e.preventDefault();
            }

            if (continueBtn && typeof deps.requestContinueManagedComboOrder === 'function') {
                deps.requestContinueManagedComboOrder(group, 'closeExecution');
            } else if (manualConcedeBtn && typeof deps.requestManualConcedeManagedComboOrder === 'function') {
                const manualContainer = manualConcedeBtn.closest('.trial-trigger-manual-concede-group');
                const stepInput = manualContainer
                    ? manualContainer.querySelector('.trial-trigger-concede-step-input')
                    : null;
                deps.requestManualConcedeManagedComboOrder(group, stepInput ? stepInput.value : '', 'closeExecution');
            } else if (concedeBtn && typeof deps.requestConcedeManagedComboOrder === 'function') {
                const concedeContainer = concedeBtn.closest('.trial-trigger-concede-group');
                const concedeSelect = concedeContainer
                    ? concedeContainer.querySelector('.trial-trigger-concede-select')
                    : null;
                const concedeValue = concedeSelect ? concedeSelect.value : concedeBtn.dataset.value;
                deps.requestConcedeManagedComboOrder(group, concedeValue, 'closeExecution');
            } else if (cancelBtn && typeof deps.requestCancelManagedComboOrder === 'function') {
                deps.requestCancelManagedComboOrder(group, 'manual_cancel', 'closeExecution');
            }
        };

        container.addEventListener('pointerdown', handleCloseGroupAction);
        container.addEventListener('click', handleCloseGroupAction);
    }

    function bindLegRow(tr, leg, group, state, deps) {
        const isStock = isUnderlyingLeg(leg);
        const supportsUnderlyingLegs = !deps.supportsUnderlyingLegs || deps.supportsUnderlyingLegs(state.underlyingSymbol);
        const pricingInputMode = getPricingInputMode(state.underlyingSymbol);
        const requiresPerLegFuture = pricingInputMode === 'FOP';

        const typeInput = tr.querySelector('.type-input');
        typeInput.value = leg.type;
        const stockOption = Array.from(typeInput.options || []).find(option => option.value === 'stock');
        if (stockOption) {
            stockOption.textContent = getUnderlyingLegLabel(state.underlyingSymbol);
        }
        if (stockOption && !supportsUnderlyingLegs && leg.type !== 'stock') {
            stockOption.disabled = true;
            stockOption.hidden = true;
        }
        typeInput.addEventListener('change', (e) => {
            const wasStock = isUnderlyingLeg(leg);
            const nowStock = isUnderlyingLeg(e.target.value);
            leg.type = e.target.value;

            if (nowStock && !wasStock) {
                leg.strike = 0;
                leg.expDate = '';
                leg.iv = 0;
                leg.ivSource = 'manual';
                leg.ivManualOverride = false;
            } else if (!nowStock && wasStock) {
                leg.strike = state.underlyingPrice;
                leg.expDate = resolveDefaultLegExpirationDate(state, deps);
                leg.iv = 0.2;
                leg.ivSource = 'manual';
                leg.ivManualOverride = false;
            }

            deps.handleLiveSubscriptions();
            deps.renderGroups();
        });

        const posInput = tr.querySelector('.pos-input');
        posInput.value = leg.pos;
        posInput.addEventListener('input', (e) => {
            leg.pos = parseInt(e.target.value, 10) || 0;
            deps.updateDerivedValues();
        });

        const strikeInput = tr.querySelector('.strike-input');
        const dteInput = tr.querySelector('.dte-input');
        const ivInput = tr.querySelector('.iv-input');
        const underlyingFutureField = tr.querySelector('.fop-underlying-field');
        const underlyingFutureSelect = tr.querySelector('.fop-underlying-select');
        const underlyingFutureHint = tr.querySelector('.fop-underlying-hint');

        if (underlyingFutureField && underlyingFutureSelect) {
            const availableFutures = Array.isArray(state.futuresPool) ? state.futuresPool : [];
            const shouldShowFutureSelector = requiresPerLegFuture;

            underlyingFutureField.style.display = shouldShowFutureSelector ? 'block' : 'none';

            if (shouldShowFutureSelector) {
                underlyingFutureSelect.innerHTML = '';

                const placeholderOption = document.createElement('option');
                placeholderOption.value = '';
                placeholderOption.textContent = availableFutures.length > 0
                    ? 'Select future'
                    : 'Add future in Futures Pool first';
                underlyingFutureSelect.appendChild(placeholderOption);

                availableFutures.forEach((entry) => {
                    const option = document.createElement('option');
                    option.value = entry.id;
                    option.textContent = entry.contractMonth
                        ? `${state.underlyingSymbol} ${entry.contractMonth}`
                        : `${state.underlyingSymbol} (pending month)`;
                    underlyingFutureSelect.appendChild(option);
                });

                underlyingFutureSelect.disabled = availableFutures.length === 0;
                underlyingFutureSelect.value = leg.underlyingFutureId || '';
                if (!availableFutures.some(entry => entry.id === leg.underlyingFutureId)) {
                    leg.underlyingFutureId = '';
                    underlyingFutureSelect.value = '';
                }

                if (underlyingFutureHint) {
                    underlyingFutureHint.textContent = availableFutures.length > 0
                        ? 'Required for FOP legs.'
                        : 'Required for FOP legs. Add futures above first.';
                }

                underlyingFutureSelect.addEventListener('change', (e) => {
                    leg.underlyingFutureId = e.target.value || '';
                    deps.updateDerivedValues();
                    deps.handleLiveSubscriptions();
                });
            }
        }

        if (isStock) {
            strikeInput.style.visibility = 'hidden';
            dteInput.closest('div').style.visibility = 'hidden';
        } else {
            strikeInput.style.visibility = 'visible';
            dteInput.closest('div').style.visibility = 'visible';

            strikeInput.step = getPriceInputStep(state.underlyingSymbol);
            strikeInput.value = leg.strike;
            strikeInput.addEventListener('input', (e) => {
                leg.strike = parseFloat(e.target.value) || 0;
                deps.updateDerivedValues();
            });

            dteInput.value = leg.expDate;
            dteInput.addEventListener('change', (e) => {
                leg.expDate = e.target.value;
                deps.updateDerivedValues();
            });

            const ivDisplay = _describeLegIvInput(leg);
            ivInput.value = ivDisplay.value;
            ivInput.title = ivDisplay.title;
            ivInput.addEventListener('focus', (e) => {
                if (leg.ivSource === 'missing' && String(e.target.value || '').trim().toUpperCase() === 'N/A') {
                    e.target.value = '';
                }
            });
            ivInput.addEventListener('input', (e) => {
                const parsed = parseIvPercentInput(e.target.value);
                if (!Number.isFinite(parsed)) {
                    return;
                }

                leg.iv = Math.max(parsed / 100.0, 0.001);
                leg.ivSource = 'manual';
                leg.ivManualOverride = true;
                deps.updateDerivedValues();
            });
            ivInput.addEventListener('change', (e) => {
                const parsed = parseIvPercentInput(e.target.value);
                if (!Number.isFinite(parsed)) {
                    const resetDisplay = _describeLegIvInput(leg);
                    e.target.value = resetDisplay.value;
                    e.target.title = resetDisplay.title;
                    return;
                }

                leg.iv = Math.max(parsed / 100.0, 0.001);
                leg.ivSource = 'manual';
                leg.ivManualOverride = true;
                const nextDisplay = _describeLegIvInput(leg);
                e.target.value = nextDisplay.value;
                e.target.title = nextDisplay.title;
                deps.updateDerivedValues();
            });
        }

        const currentPriceInput = tr.querySelector('.current-price-input');
        currentPriceInput.step = getPriceInputStep(state.underlyingSymbol);
        currentPriceInput.value = leg.currentPrice > 0 ? formatPriceInputValue(state.underlyingSymbol, leg.currentPrice) : '';
        currentPriceInput.addEventListener('input', (e) => {
            leg.currentPrice = parseFloat(e.target.value) || 0;
            leg.currentPriceSource = leg.currentPrice > 0 ? 'manual' : '';
            deps.updateDerivedValues();
        });

        const costInput = tr.querySelector('.cost-input');
        costInput.step = getPriceInputStep(state.underlyingSymbol);
        costInput.value = leg.cost > 0 ? formatPriceInputValue(state.underlyingSymbol, leg.cost) : '';
        costInput.addEventListener('input', (e) => {
            leg.cost = parseFloat(e.target.value) || 0;
            leg.costSource = 'manual';
            leg.executionReportedCost = false;
            delete leg.executionReportOrderId;
            delete leg.executionReportPermId;
            deps.updateDerivedValues();
        });

        const closePriceInput = tr.querySelector('.close-price-input');
        const closeLabel = tr.querySelector('.close-label');
        const closeLegBtn = tr.querySelector('.close-leg-btn');
        const assignmentBtn = tr.querySelector('.assignment-convert-btn');
        if (closePriceInput && closeLabel) {
            closePriceInput.style.display = 'block';
            closeLabel.style.display = 'block';
            closePriceInput.step = getPriceInputStep(state.underlyingSymbol);
            closePriceInput.value = leg.closePrice !== null && leg.closePrice !== undefined
                ? formatPriceInputValue(state.underlyingSymbol, leg.closePrice)
                : '';
            closePriceInput.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                leg.closePrice = isNaN(val) ? null : val;
                deps.updateDerivedValues();
            });
        }

        if (closeLegBtn) {
            const pos = Math.abs(parseFloat(leg && leg.pos) || 0);
            const disabledReason = _resolveCloseLegDisabledReason(group, leg, state, deps);
            const isHistoricalMode = !!(state && state.marketDataMode === 'historical');
            closeLegBtn.style.visibility = pos > 0.0001 ? 'visible' : 'hidden';
            closeLegBtn.disabled = !!disabledReason;
            closeLegBtn.textContent = _hasResolvedClosePrice(leg)
                ? 'Closed'
                : (isHistoricalMode ? 'Settle' : 'Close');
            closeLegBtn.title = disabledReason || (isHistoricalMode
                ? 'Close this single leg at the current historical replay price.'
                : 'Preview or submit a close order for this single leg using the Group Close settings.');
            if (!disabledReason) {
                closeLegBtn.addEventListener('click', () => {
                    deps.requestCloseLegComboOrder(group, leg);
                });
            }
        }

        if (assignmentBtn) {
            const canConvert = _isAssignmentConvertible(group, leg, state, deps);
            assignmentBtn.style.visibility = canConvert ? 'visible' : 'hidden';
            assignmentBtn.disabled = !canConvert;
            if (canConvert) {
                assignmentBtn.textContent = _resolveAssignmentActionLabel(leg);
                assignmentBtn.title = leg.closePriceSource === 'assignment_conversion'
                    ? 'Undo this manual assignment/exercise conversion.'
                    : 'Convert this option leg into a deliverable underlying position at the strike, while preserving the option premium as realized cash flow.';
                assignmentBtn.addEventListener('click', () => {
                    applyOptionAssignmentConversion(group, leg, state, deps);
                });
            } else {
                assignmentBtn.title = '';
            }
        }

        tr.querySelector('.delete-btn').addEventListener('click', () => {
            removeLeg(state, group.id, leg.id, deps);
        });
    }

    function applyViewModeState(card, group, currentMode) {
        const toggleActiveBtn = card.querySelector('.toggle-view-active');
        const toggleTrialBtn = card.querySelector('.toggle-view-trial');
        const toggleAmortizedBtn = card.querySelector('.toggle-view-amortized');
        const toggleSettlementBtn = card.querySelector('.toggle-view-settlement');
        const settlementControls = card.querySelector('.settlement-controls');

        group.viewMode = currentMode;

        [toggleActiveBtn, toggleTrialBtn, toggleAmortizedBtn, toggleSettlementBtn].forEach(btn => {
            if (!btn) return;
            btn.classList.remove('active', 'btn-primary');
            btn.classList.add('btn-secondary');
        });

        if (currentMode === 'active' && toggleActiveBtn) {
            toggleActiveBtn.classList.remove('btn-secondary');
            toggleActiveBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'none';
            return;
        }

        if (currentMode === 'amortized' && toggleAmortizedBtn) {
            toggleAmortizedBtn.classList.remove('btn-secondary');
            toggleAmortizedBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'flex';
            return;
        }

        if (currentMode === 'settlement' && toggleSettlementBtn) {
            toggleSettlementBtn.classList.remove('btn-secondary');
            toggleSettlementBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'flex';
            return;
        }

        if (toggleTrialBtn) {
            toggleTrialBtn.classList.remove('btn-secondary');
            toggleTrialBtn.classList.add('active', 'btn-primary');
            if (settlementControls) settlementControls.style.display = 'none';
        }
    }

    function applyCollapsedState(card, group) {
        card.classList.toggle('collapsed', !!group.isCollapsed);
        const body = card.querySelector('.group-body');
        if (body) {
            body.hidden = !!group.isCollapsed;
        }

        const collapseToggleBtn = card.querySelector('.collapse-toggle-btn');
        if (collapseToggleBtn) {
            collapseToggleBtn.title = group.isCollapsed ? 'Expand Group' : 'Collapse Group';
            collapseToggleBtn.setAttribute('aria-expanded', group.isCollapsed ? 'false' : 'true');
        }
    }

    function applyModeLockState(card, group, state, deps) {
        const currentMode = deps.getRenderableGroupViewMode(group);
        const supportsAmortizedMode = !deps.supportsAmortizedMode || deps.supportsAmortizedMode(state.underlyingSymbol);
        const toggleActiveBtn = card.querySelector('.toggle-view-active');
        const toggleTrialBtn = card.querySelector('.toggle-view-trial');
        const toggleAmortizedBtn = card.querySelector('.toggle-view-amortized');
        const toggleSettlementBtn = card.querySelector('.toggle-view-settlement');

        [toggleActiveBtn, toggleTrialBtn, toggleAmortizedBtn, toggleSettlementBtn].forEach(btn => {
            if (!btn) return;
            btn.disabled = false;
            btn.title = '';
            btn.classList.remove('text-muted');
            btn.style.opacity = '';
        });

        if (!supportsAmortizedMode && toggleAmortizedBtn) {
            toggleAmortizedBtn.disabled = true;
            toggleAmortizedBtn.title = 'Amortized mode currently supports only equity-style deliverable underlyings.';
            toggleAmortizedBtn.classList.add('text-muted');
            toggleAmortizedBtn.style.opacity = '0.5';
        }

        if (deps.groupHasDeterministicCost(group) || currentMode === 'settlement') {
            return;
        }

        group.viewMode = 'trial';

        if (!toggleTrialBtn || !toggleActiveBtn || !toggleAmortizedBtn) return;

        toggleActiveBtn.disabled = true;
        toggleActiveBtn.title = 'Add a Cost to unlock Active tracking.';
        toggleActiveBtn.classList.add('text-muted');
        toggleActiveBtn.style.opacity = '0.5';

        toggleAmortizedBtn.disabled = true;
        toggleAmortizedBtn.title = 'Add a Cost to unlock Amortized analysis.';
        toggleAmortizedBtn.classList.add('text-muted');
        toggleAmortizedBtn.style.opacity = '0.5';

        toggleTrialBtn.classList.add('active', 'btn-primary');
        toggleTrialBtn.classList.remove('btn-secondary');
        toggleActiveBtn.classList.remove('active', 'btn-primary');
        toggleActiveBtn.classList.add('btn-secondary');
        toggleAmortizedBtn.classList.remove('active', 'btn-primary');
        toggleAmortizedBtn.classList.add('btn-secondary');
    }

    globalScope.OptionComboGroupEditorUI = {
        toggleGroupCollapse,
        addGroup,
        removeGroup,
        moveGroupToTop,
        moveGroupByOffset,
        moveGroupToIndex,
        addLegToGroupById,
        addLegToGroup,
        removeLeg,
        renderGroups,
        applyModeLockState,
        applyOptionAssignmentConversion,
        resolveDefaultLegExpirationDate,
        applyComboTemplateToGroup,
        openComboTemplateDialog,
        describeSimulatedOpenState,
        simulateOpenGroup,
        bindTrialTriggerControls,
        bindCloseGroupControls,
        openCloseConfirmationDialog,
        openComboSubmissionConfirmationDialog,
        openLegPositionCheckDialog,
        _test: {
            describeLegIvInput: _describeLegIvInput,
            resolveSimulatedOpenPrice: _resolveSimulatedOpenPrice,
            getDefaultComboStrikes: _getDefaultComboStrikes,
            calculateButterflyRiskFromLegPrices,
            collectButterflyQuoteRows: _collectButterflyQuoteRows,
            buildButterflyCandidateGrid: _buildButterflyCandidateGrid,
            chooseButterflyCandidate: _chooseButterflyCandidate,
        },
    };
    globalScope.toggleGroupCollapse = toggleGroupCollapse;
})(typeof globalThis !== 'undefined' ? globalThis : window);
