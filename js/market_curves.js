/**
 * DOM-free Forward / Carry / Discount curve primitives.
 *
 * The three quantities are intentionally different types:
 *
 *   discount: D(T) = exp(-r(T) T), where r is a continuously-compounded
 *             risk-free zero rate used only for discounting.
 *   forward:  F(T), an outright forward/futures level.
 *   carry:    b(T) = r(T) - q(T), so F(T) = S exp(b(T) T).
 *
 * A carry curve is never accepted where a discount curve is required.  The
 * separate constructors/resolvers and the runtime kind checks are deliberate:
 * callers must not silently use r-q as the Black-76 discount rate.
 *
 * Curve points use calendar-day tenors and ACT/365F by default. Rates are
 * decimals (0.04 = 4%) and continuously compounded. Curve metadata can be
 * supplied at the curve level and overridden per point:
 *
 *   { source, quoteAsOf, stale, quality: { status, flags, score }, snapshotId }
 */

(function attachMarketCurves(globalScope) {
    'use strict';

    const SCHEMA_VERSION = 1;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const DEFAULT_DAY_COUNT_BASIS = 365;
    const DEFAULT_MAX_INTERPOLATION_GAP_DAYS = 370;
    const DEFAULT_TREASURY_MAX_EXTRAPOLATION_DAYS = 31;

    const CURVE_KIND = Object.freeze({
        DISCOUNT: 'discount',
        FORWARD: 'forward',
        CARRY: 'carry',
    });

    const TREASURY_CURVE_SEMANTICS = Object.freeze({
        CONTINUOUS_ZERO: 'continuous_zero',
        CMT_PAR_YIELD: 'cmt_par_yield',
    });

    const QUALITY_RANK = Object.freeze({
        good: 0,
        unknown: 1,
        degraded: 2,
        invalid: 3,
    });

    function finiteNumber(value, label) {
        const parsed = typeof value === 'number' ? value : parseFloat(value);
        if (!Number.isFinite(parsed)) {
            throw new TypeError(`${label} must be a finite number`);
        }
        return parsed;
    }

    function optionalFiniteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = typeof value === 'number' ? value : parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function positiveNumber(value, label) {
        const parsed = finiteNumber(value, label);
        if (parsed <= 0) throw new RangeError(`${label} must be greater than zero`);
        return parsed;
    }

    function nonNegativeNumber(value, label) {
        const parsed = finiteNumber(value, label);
        if (parsed < 0) throw new RangeError(`${label} must be non-negative`);
        return parsed;
    }

    function normalizeIsoDate(value, label = 'date') {
        const raw = String(value || '').trim().replace(/\//g, '-');
        const expanded = /^\d{8}$/.test(raw)
            ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
            : raw;
        const match = expanded.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) throw new TypeError(`${label} must be YYYY-MM-DD or YYYYMMDD`);
        const epochMs = Date.UTC(
            parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10)
        );
        const normalized = new Date(epochMs).toISOString().slice(0, 10);
        if (normalized !== expanded) throw new RangeError(`${label} is not a valid calendar date`);
        return normalized;
    }

    function diffCalendarDays(asOf, expiry) {
        const start = Date.parse(`${normalizeIsoDate(asOf, 'asOf')}T00:00:00Z`);
        const end = Date.parse(`${normalizeIsoDate(expiry, 'expiry')}T00:00:00Z`);
        return (end - start) / MS_PER_DAY;
    }

    function normalizeTimestamp(value, label = 'quoteAsOf') {
        if (value === null || value === undefined || value === '') return '';
        const epochMs = Date.parse(String(value));
        if (!Number.isFinite(epochMs)) throw new TypeError(`${label} must be an ISO-compatible timestamp`);
        return new Date(epochMs).toISOString();
    }

    function canonicalQualityStatus(value) {
        const raw = String(value || '').trim().toLowerCase();
        if (['ok', 'good', 'valid', 'fresh'].includes(raw)) return 'good';
        if (['warning', 'warn', 'degraded', 'indicative', 'partial'].includes(raw)) return 'degraded';
        if (['invalid', 'error', 'rejected', 'bad'].includes(raw)) return 'invalid';
        return 'unknown';
    }

    function normalizeQuality(value) {
        const input = value && typeof value === 'object' ? value : { status: value };
        const flags = Array.isArray(input.flags)
            ? [...new Set(input.flags.map(flag => String(flag || '').trim()).filter(Boolean))]
            : [];
        const score = optionalFiniteNumber(input.score);
        return {
            status: canonicalQualityStatus(input.status),
            flags,
            score,
        };
    }

    function mergeQuality(qualities, extraFlags = []) {
        const normalized = qualities.map(normalizeQuality);
        let worst = 'good';
        if (normalized.length === 0) worst = 'unknown';
        normalized.forEach((quality) => {
            if (QUALITY_RANK[quality.status] > QUALITY_RANK[worst]) worst = quality.status;
        });
        const scores = normalized.map(quality => quality.score).filter(Number.isFinite);
        return {
            status: worst,
            flags: [...new Set([
                ...normalized.flatMap(quality => quality.flags),
                ...extraFlags,
            ].filter(Boolean))],
            // The lowest contributor score is the conservative aggregate.
            score: scores.length > 0 ? Math.min(...scores) : null,
        };
    }

    function firstDefined(...values) {
        return values.find(value => value !== undefined && value !== null && value !== '');
    }

    function normalizeMetadata(input, defaults = {}) {
        const point = input && typeof input === 'object' ? input : {};
        const nested = point.metadata && typeof point.metadata === 'object' ? point.metadata : {};
        const defaultNested = defaults.metadata && typeof defaults.metadata === 'object'
            ? defaults.metadata
            : defaults;
        const source = String(firstDefined(
            nested.source, point.source, defaultNested.source, 'unknown'
        )).trim() || 'unknown';
        const quoteAsOf = normalizeTimestamp(firstDefined(
            nested.quoteAsOf, point.quoteAsOf, defaultNested.quoteAsOf, ''
        ));
        const staleValue = firstDefined(nested.stale, point.stale, defaultNested.stale, false);
        const qualityValue = firstDefined(
            nested.quality, point.quality, defaultNested.quality, { status: 'unknown' }
        );
        const snapshotId = String(firstDefined(
            nested.snapshotId, point.snapshotId, defaultNested.snapshotId, ''
        )).trim();
        return {
            source,
            quoteAsOf,
            stale: staleValue === true,
            quality: normalizeQuality(qualityValue),
            snapshotId,
        };
    }

    function normalizeLimit(value, fallback, label) {
        if (value === null || value === undefined || value === '') return fallback;
        return nonNegativeNumber(value, label);
    }

    function tenorYears(tenorDays, dayCountBasis = DEFAULT_DAY_COUNT_BASIS) {
        return nonNegativeNumber(tenorDays, 'tenorDays') / positiveNumber(dayCountBasis, 'dayCountBasis');
    }

    function discountFactorFromZeroRate(args) {
        const input = args && typeof args === 'object' ? args : {};
        const rate = finiteNumber(input.zeroRate, 'zeroRate');
        const time = input.timeYears !== undefined
            ? nonNegativeNumber(input.timeYears, 'timeYears')
            : tenorYears(input.tenorDays, input.dayCountBasis);
        return Math.exp(-rate * time);
    }

    function zeroRateFromDiscountFactor(args) {
        const input = args && typeof args === 'object' ? args : {};
        const discountFactor = positiveNumber(input.discountFactor, 'discountFactor');
        const time = input.timeYears !== undefined
            ? nonNegativeNumber(input.timeYears, 'timeYears')
            : tenorYears(input.tenorDays, input.dayCountBasis);
        if (time === 0) {
            if (Math.abs(discountFactor - 1) > 1e-12) {
                throw new RangeError('discountFactor must equal one at zero tenor');
            }
            throw new RangeError('zero rate is not identifiable at zero tenor');
        }
        return -Math.log(discountFactor) / time;
    }

    function normalizePointLocation(point, asOf, index) {
        const hasExpiry = point.expiry !== undefined && point.expiry !== null && point.expiry !== '';
        const hasTenor = point.tenorDays !== undefined && point.tenorDays !== null && point.tenorDays !== '';
        if (!hasExpiry && !hasTenor) {
            throw new TypeError(`points[${index}] needs expiry or tenorDays`);
        }
        const expiry = hasExpiry ? normalizeIsoDate(point.expiry, `points[${index}].expiry`) : '';
        const expiryTenor = expiry ? diffCalendarDays(asOf, expiry) : null;
        const explicitTenor = hasTenor
            ? nonNegativeNumber(point.tenorDays, `points[${index}].tenorDays`)
            : null;
        if (expiryTenor !== null && expiryTenor < 0) {
            throw new RangeError(`points[${index}].expiry precedes curve asOf`);
        }
        if (expiryTenor !== null && explicitTenor !== null
            && Math.abs(expiryTenor - explicitTenor) > 1e-9) {
            throw new RangeError(`points[${index}] expiry and tenorDays disagree`);
        }
        return {
            expiry,
            tenorDays: explicitTenor !== null ? explicitTenor : expiryTenor,
        };
    }

    function normalizeDiscountValue(point, location, dayCountBasis, index) {
        const rateInput = firstDefined(point.zeroRate, point.rate);
        const factorInput = point.discountFactor;
        if ((rateInput === undefined || rateInput === null || rateInput === '')
            && (factorInput === undefined || factorInput === null || factorInput === '')) {
            throw new TypeError(`discount points[${index}] needs zeroRate or discountFactor`);
        }
        let zeroRate = rateInput !== undefined && rateInput !== null && rateInput !== ''
            ? finiteNumber(rateInput, `points[${index}].zeroRate`)
            : null;
        let discountFactor = factorInput !== undefined && factorInput !== null && factorInput !== ''
            ? positiveNumber(factorInput, `points[${index}].discountFactor`)
            : null;
        const time = tenorYears(location.tenorDays, dayCountBasis);
        if (time === 0) {
            if (discountFactor !== null && Math.abs(discountFactor - 1) > 1e-10) {
                throw new RangeError(`discount points[${index}] factor must equal one at zero tenor`);
            }
            discountFactor = 1;
            if (zeroRate === null) zeroRate = 0;
        } else {
            if (zeroRate === null) {
                zeroRate = -Math.log(discountFactor) / time;
            }
            const factorFromRate = Math.exp(-zeroRate * time);
            if (discountFactor !== null
                && Math.abs(factorFromRate - discountFactor) > 1e-8) {
                throw new RangeError(`discount points[${index}] zeroRate and discountFactor disagree`);
            }
            discountFactor = factorFromRate;
        }
        return { zeroRate, discountFactor };
    }

    function normalizePoint(kind, point, curveConfig, index) {
        if (!point || typeof point !== 'object') throw new TypeError(`points[${index}] must be an object`);
        const location = normalizePointLocation(point, curveConfig.asOf, index);
        const common = {
            expiry: location.expiry,
            tenorDays: location.tenorDays,
            tenorCode: String(point.tenorCode || '').trim(),
            inputSemantics: String(point.inputSemantics || '').trim(),
            inputRate: optionalFiniteNumber(point.inputRate),
            inputParYield: optionalFiniteNumber(point.inputParYield),
            sourceEffectiveDate: point.sourceEffectiveDate
                ? normalizeIsoDate(point.sourceEffectiveDate, `points[${index}].sourceEffectiveDate`)
                : '',
            publishedAt: point.publishedAt
                ? normalizeTimestamp(point.publishedAt, `points[${index}].publishedAt`)
                : '',
            continuousRateIsProxy: point.continuousRateIsProxy === true,
            proxy: point.proxy === true,
            metadata: normalizeMetadata(point, curveConfig.metadata),
        };
        if (kind === CURVE_KIND.DISCOUNT) {
            return {
                ...common,
                ...normalizeDiscountValue(point, location, curveConfig.dayCountBasis, index),
            };
        }
        if (kind === CURVE_KIND.FORWARD) {
            return { ...common, forward: positiveNumber(point.forward, `points[${index}].forward`) };
        }
        return { ...common, carryRate: finiteNumber(point.carryRate, `points[${index}].carryRate`) };
    }

    function createCurve(kind, config) {
        const input = config && typeof config === 'object' ? config : {};
        if (!Object.values(CURVE_KIND).includes(kind)) throw new TypeError(`unknown curve kind: ${kind}`);
        const asOf = normalizeIsoDate(input.asOf, 'curve.asOf');
        const dayCountBasis = input.dayCountBasis === undefined
            ? DEFAULT_DAY_COUNT_BASIS
            : positiveNumber(input.dayCountBasis, 'curve.dayCountBasis');
        const normalizedConfig = {
            asOf,
            dayCountBasis,
            metadata: normalizeMetadata(input),
        };
        const rawPoints = Array.isArray(input.points) ? input.points : [];
        if (rawPoints.length === 0) throw new RangeError(`${kind} curve needs at least one point`);
        const points = rawPoints
            .map((point, index) => normalizePoint(kind, point, normalizedConfig, index))
            .sort((a, b) => a.tenorDays - b.tenorDays);
        for (let index = 1; index < points.length; index += 1) {
            if (Math.abs(points[index].tenorDays - points[index - 1].tenorDays) <= 1e-9) {
                throw new RangeError(`${kind} curve contains duplicate tenor ${points[index].tenorDays}`);
            }
            if (points[index].expiry && points[index].expiry === points[index - 1].expiry) {
                throw new RangeError(`${kind} curve contains duplicate expiry ${points[index].expiry}`);
            }
        }
        return {
            schemaVersion: SCHEMA_VERSION,
            kind,
            id: String(input.id || '').trim(),
            currency: String(input.currency || '').trim().toUpperCase(),
            asOf,
            dayCountBasis,
            rateConvention: kind === CURVE_KIND.DISCOUNT || kind === CURVE_KIND.CARRY
                ? 'continuous_annualized'
                : null,
            interpolation: kind === CURVE_KIND.DISCOUNT
                ? 'log_discount_factor'
                : (kind === CURVE_KIND.FORWARD ? 'log_linear' : 'linear_rate'),
            maxInterpolationGapDays: normalizeLimit(
                input.maxInterpolationGapDays,
                DEFAULT_MAX_INTERPOLATION_GAP_DAYS,
                'curve.maxInterpolationGapDays'
            ),
            maxExtrapolationDays: normalizeLimit(
                input.maxExtrapolationDays, 0, 'curve.maxExtrapolationDays'
            ),
            metadata: normalizedConfig.metadata,
            points,
        };
    }

    function createDiscountCurve(config) {
        return createCurve(CURVE_KIND.DISCOUNT, config);
    }

    function createForwardCurve(config) {
        return createCurve(CURVE_KIND.FORWARD, config);
    }

    function createCarryCurve(config) {
        return createCurve(CURVE_KIND.CARRY, config);
    }

    function canonicalTreasurySemantics(value) {
        if (value && typeof value === 'object') {
            const candidates = [
                value.discountRateSemantics,
                value.discountingMethod,
                value.inputSemantics,
                value.curveType,
            ];
            for (const candidate of candidates) {
                const resolved = canonicalTreasurySemantics(candidate);
                if (resolved) return resolved;
            }
            if (value.discountingIsApproximate === true
                && value.officialZeroCouponCurve === false) {
                return TREASURY_CURVE_SEMANTICS.CMT_PAR_YIELD;
            }
            return '';
        }
        const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
        if ([
            'continuous_zero', 'continuous_zero_rate', 'continuous_rate',
            'zero_continuous', 'continuously_compounded_zero',
        ].includes(raw)) {
            return TREASURY_CURVE_SEMANTICS.CONTINUOUS_ZERO;
        }
        if ([
            'cmt_par_yield', 'treasury_cmt_par_yield', 'us_treasury_cmt_par_yield',
            'par_yield', 'nominal_semiannual_par_yield', 'par_yield_as_zero_proxy',
            'continuous_zero_proxy_from_cmt_par_yield', 'cmt_par_yield_proxy',
        ].includes(raw)) {
            return TREASURY_CURVE_SEMANTICS.CMT_PAR_YIELD;
        }
        return '';
    }

    function cmtParYieldToContinuousProxy(parYield) {
        const yieldValue = finiteNumber(parYield, 'parYield');
        if (1 + yieldValue / 2 <= 0) {
            throw new RangeError('parYield must be greater than -200%');
        }
        // CMT is a par yield, not a bootstrapped zero rate. This conversion
        // only changes the compounding convention and remains a proxy.
        return 2 * Math.log1p(yieldValue / 2);
    }

    /**
     * Adapt a backend Treasury snapshot to a typed discount curve.
     *
     * Native points may provide `continuousRate`. A generic `rate` is accepted
     * only when snapshot/point `curveSemantics` explicitly says whether it is
     * a continuous zero rate or a Treasury CMT par yield. `parYield` always
     * selects the CMT proxy route.
     *
     * CMT points are converted with 2*ln(1+y/2). This is merely a
     * compounding-equivalent proxy; it is not coupon-curve bootstrapping.
     */
    function createDiscountCurveFromTreasurySnapshot(snapshot, options = {}) {
        const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
        const effectiveDate = normalizeIsoDate(input.effectiveDate, 'snapshot.effectiveDate');
        const asOf = normalizeIsoDate(
            firstDefined(options.asOf, input.asOf, effectiveDate),
            'Treasury curve asOf'
        );
        const rawPoints = Array.isArray(input.points) ? input.points : [];
        if (rawPoints.length === 0) throw new RangeError('Treasury snapshot needs at least one point');
        const snapshotSemanticCandidates = [
            options.curveSemantics,
            input.curveSemantics,
            input.inputSemantics,
            input.discountRateSemantics,
        ];
        let snapshotSemantics = '';
        for (const candidate of snapshotSemanticCandidates) {
            snapshotSemantics = canonicalTreasurySemantics(candidate);
            if (snapshotSemantics) break;
        }
        const source = String(firstDefined(input.source, options.source, 'US_TREASURY')).trim();
        const quoteAsOf = firstDefined(
            input.quoteAsOf,
            options.quoteAsOf,
            `${effectiveDate}T00:00:00Z`
        );
        let usedProxy = false;
        const usedSemantics = new Set();
        const points = rawPoints.map((point, index) => {
            if (!point || typeof point !== 'object') {
                throw new TypeError(`Treasury points[${index}] must be an object`);
            }
            const pointSemanticCandidates = [
                point.curveSemantics,
                point.semantics,
                point.inputSemantics,
                point.discountRateSemantics,
            ];
            let pointSemantics = '';
            for (const candidate of pointSemanticCandidates) {
                pointSemantics = canonicalTreasurySemantics(candidate);
                if (pointSemantics) break;
            }
            const explicitProxy = point.continuousRateIsProxy === true
                || point.proxy === true
                || pointSemantics === TREASURY_CURVE_SEMANTICS.CMT_PAR_YIELD
                || snapshotSemantics === TREASURY_CURVE_SEMANTICS.CMT_PAR_YIELD;
            let semantics = pointSemantics || snapshotSemantics;
            let inputRate;
            if (point.continuousRate !== undefined && point.continuousRate !== null
                && point.continuousRate !== '') {
                // The provider may have already converted a CMT par yield to
                // a continuous number. Use that number directly, but retain
                // its explicit proxy semantics instead of relabelling it as
                // a native zero rate.
                semantics = explicitProxy
                    ? TREASURY_CURVE_SEMANTICS.CMT_PAR_YIELD
                    : TREASURY_CURVE_SEMANTICS.CONTINUOUS_ZERO;
                inputRate = finiteNumber(point.continuousRate, `points[${index}].continuousRate`);
            } else if (point.parYield !== undefined && point.parYield !== null
                && point.parYield !== '') {
                semantics = TREASURY_CURVE_SEMANTICS.CMT_PAR_YIELD;
                inputRate = finiteNumber(point.parYield, `points[${index}].parYield`);
            } else if (point.rate !== undefined && point.rate !== null && point.rate !== '') {
                if (!semantics) {
                    throw new TypeError(
                        `Treasury points[${index}].rate requires explicit curveSemantics`
                    );
                }
                inputRate = finiteNumber(point.rate, `points[${index}].rate`);
            } else {
                throw new TypeError(
                    `Treasury points[${index}] needs continuousRate, parYield, or semantic rate`
                );
            }
            const isProxy = explicitProxy
                || semantics === TREASURY_CURVE_SEMANTICS.CMT_PAR_YIELD;
            usedProxy = usedProxy || isProxy;
            usedSemantics.add(semantics);
            const baseQuality = normalizeQuality(firstDefined(
                point.quality, input.quality, options.quality, { status: 'unknown' }
            ));
            const quality = isProxy
                ? mergeQuality([
                    baseQuality,
                    {
                        status: 'degraded',
                        flags: ['cmt_par_yield_proxy', 'not_bootstrapped_zero_curve'],
                    },
                ])
                : baseQuality;
            return {
                tenorDays: point.tenorDays,
                expiry: point.expiry,
                tenorCode: point.tenorCode,
                zeroRate: point.continuousRate !== undefined
                    && point.continuousRate !== null
                    && point.continuousRate !== ''
                    ? inputRate
                    : (isProxy ? cmtParYieldToContinuousProxy(inputRate) : inputRate),
                inputSemantics: semantics,
                inputRate,
                inputParYield: optionalFiniteNumber(point.parYield),
                continuousRateIsProxy: isProxy,
                proxy: isProxy,
                source: firstDefined(point.source, source),
                quoteAsOf: firstDefined(point.quoteAsOf, quoteAsOf),
                stale: firstDefined(point.stale, input.stale, options.stale, false) === true,
                snapshotId: firstDefined(point.snapshotId, input.snapshotId, options.snapshotId, ''),
                quality,
            };
        });
        const baseCurveQuality = normalizeQuality(firstDefined(
            input.quality, options.quality, { status: 'unknown' }
        ));
        const curveQuality = usedProxy
            ? mergeQuality([
                baseCurveQuality,
                {
                    status: 'degraded',
                    flags: ['cmt_par_yield_proxy', 'not_bootstrapped_zero_curve'],
                },
            ])
            : baseCurveQuality;
        const curve = createDiscountCurve({
            id: firstDefined(options.id, input.id, 'usd-treasury-discount'),
            currency: firstDefined(options.currency, input.currency, 'USD'),
            asOf,
            dayCountBasis: firstDefined(options.dayCountBasis, input.dayCountBasis, 365),
            maxInterpolationGapDays: firstDefined(
                options.maxInterpolationGapDays,
                input.maxInterpolationGapDays,
                DEFAULT_MAX_INTERPOLATION_GAP_DAYS
            ),
            maxExtrapolationDays: firstDefined(
                options.maxExtrapolationDays,
                input.maxExtrapolationDays,
                DEFAULT_TREASURY_MAX_EXTRAPOLATION_DAYS
            ),
            source,
            quoteAsOf,
            stale: firstDefined(input.stale, options.stale, false) === true,
            quality: curveQuality,
            snapshotId: firstDefined(input.snapshotId, options.snapshotId, ''),
            points,
        });
        return {
            ...curve,
            effectiveDate,
            sourceSemantics: usedSemantics.size === 1
                ? [...usedSemantics][0]
                : 'mixed',
            discountSemantics: usedProxy
                ? 'continuous_zero_proxy_from_cmt_par_yield'
                : 'continuous_zero',
            isProxy: usedProxy,
        };
    }

    /**
     * Adapt the canonical backend discount snapshot to a typed curve.
     *
     * Schema-v2 snapshots store D(T) as the canonical value and may contain
     * SOFR, blend, and Treasury-proxy points in one curve.  No source-specific
     * rate conversion is performed here: the backend already supplied a
     * mutually consistent discountFactor / continuous ACT/365F zeroRate.
     * Legacy Treasury payloads continue through the explicit compatibility
     * adapter above.
     */
    function createDiscountCurveFromSnapshot(snapshot, options = {}) {
        const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
        const rawPoints = Array.isArray(input.points) ? input.points : [];
        const isCanonical = Number(input.schemaVersion) >= 2
            || rawPoints.some(point => point && typeof point === 'object'
                && (point.discountFactor !== undefined || point.zeroRate !== undefined));
        if (!isCanonical) {
            return createDiscountCurveFromTreasurySnapshot(input, options);
        }
        if (rawPoints.length === 0) {
            throw new RangeError('Discount snapshot needs at least one point');
        }
        const effectiveDate = normalizeIsoDate(
            firstDefined(input.effectiveDate, input.curveAsOf, input.asOf),
            'snapshot.effectiveDate'
        );
        const asOf = normalizeIsoDate(
            firstDefined(options.asOf, input.curveAsOf, input.asOf, effectiveDate),
            'discount curve asOf'
        );
        const source = String(firstDefined(
            input.source, options.source, 'usd_reference_discount_curve'
        )).trim();
        const quoteAsOf = firstDefined(
            input.quoteAsOf,
            input.availableAsOf,
            options.quoteAsOf,
            `${effectiveDate}T00:00:00Z`
        );
        let usedProxy = input.isProxy === true
            || !!(input.curveSemantics && input.curveSemantics.discountingIsApproximate === true);
        const points = rawPoints.map((point, index) => {
            if (!point || typeof point !== 'object') {
                throw new TypeError(`Discount points[${index}] must be an object`);
            }
            const pointIsProxy = point.proxy === true
                || point.isProxy === true
                || point.continuousRateIsProxy === true;
            usedProxy = usedProxy || pointIsProxy;
            const zeroRate = firstDefined(point.zeroRate, point.continuousRate);
            const discountFactor = point.discountFactor;
            if ((zeroRate === undefined || zeroRate === null || zeroRate === '')
                && (discountFactor === undefined || discountFactor === null || discountFactor === '')) {
                throw new TypeError(
                    `Discount points[${index}] needs discountFactor, zeroRate, or continuousRate`
                );
            }
            return {
                tenorDays: point.tenorDays,
                expiry: point.expiry,
                tenorCode: point.tenorCode,
                zeroRate,
                discountFactor,
                inputSemantics: String(point.inputSemantics || '').trim(),
                inputRate: optionalFiniteNumber(point.inputRate),
                inputParYield: optionalFiniteNumber(firstDefined(
                    point.inputParYield, point.parYield
                )),
                sourceEffectiveDate: point.sourceEffectiveDate,
                publishedAt: point.publishedAt,
                continuousRateIsProxy: pointIsProxy,
                proxy: pointIsProxy,
                source: firstDefined(point.source, source),
                quoteAsOf: firstDefined(point.quoteAsOf, quoteAsOf),
                stale: firstDefined(point.stale, input.stale, options.stale, false) === true,
                snapshotId: firstDefined(point.snapshotId, input.snapshotId, options.snapshotId, ''),
                quality: firstDefined(
                    point.quality, input.quality, options.quality, { status: 'unknown' }
                ),
            };
        });
        const curve = createDiscountCurve({
            id: firstDefined(options.id, input.curveId, input.id, 'usd-reference-discount'),
            currency: firstDefined(options.currency, input.currency, 'USD'),
            asOf,
            dayCountBasis: firstDefined(options.dayCountBasis, input.dayCountBasis, 365),
            maxInterpolationGapDays: firstDefined(
                options.maxInterpolationGapDays,
                input.maxInterpolationGapDays,
                DEFAULT_MAX_INTERPOLATION_GAP_DAYS
            ),
            maxExtrapolationDays: firstDefined(
                options.maxExtrapolationDays,
                input.maxExtrapolationDays,
                DEFAULT_TREASURY_MAX_EXTRAPOLATION_DAYS
            ),
            source,
            quoteAsOf,
            stale: firstDefined(input.stale, options.stale, false) === true,
            quality: firstDefined(input.quality, options.quality, { status: 'unknown' }),
            snapshotId: firstDefined(input.snapshotId, options.snapshotId, ''),
            points,
        });
        return {
            ...curve,
            effectiveDate,
            curveAsOf: asOf,
            availableAsOf: String(input.availableAsOf || quoteAsOf || ''),
            snapshotId: String(firstDefined(input.snapshotId, options.snapshotId, '')),
            sourceSemantics: String(firstDefined(
                input.discountRateSemantics,
                input.curveSemantics && input.curveSemantics.discountRateSemantics,
                'continuous_discount_factor'
            )),
            discountSemantics: String(firstDefined(
                input.discountRateSemantics,
                input.curveSemantics && input.curveSemantics.discountRateSemantics,
                'continuous_zero'
            )),
            policy: input.policy && typeof input.policy === 'object' ? { ...input.policy } : null,
            sources: input.sources && typeof input.sources === 'object' ? { ...input.sources } : null,
            isProxy: usedProxy,
        };
    }

    function assertCurveKind(curve, expectedKind) {
        if (!curve || typeof curve !== 'object') throw new TypeError(`${expectedKind} curve is required`);
        if (curve.kind !== expectedKind) {
            throw new TypeError(`curve kind mismatch: expected ${expectedKind}, received ${curve.kind || 'unknown'}`);
        }
    }

    function normalizeTarget(curve, target) {
        const input = typeof target === 'string'
            ? { expiry: target }
            : (typeof target === 'number' ? { tenorDays: target } : (target || {}));
        const hasExpiry = input.expiry !== undefined && input.expiry !== null && input.expiry !== '';
        const hasTenor = input.tenorDays !== undefined && input.tenorDays !== null && input.tenorDays !== '';
        if (!hasExpiry && !hasTenor) throw new TypeError('target needs expiry or tenorDays');
        const expiry = hasExpiry ? normalizeIsoDate(input.expiry, 'target.expiry') : '';
        const expiryTenor = expiry ? diffCalendarDays(curve.asOf, expiry) : null;
        const explicitTenor = hasTenor ? nonNegativeNumber(input.tenorDays, 'target.tenorDays') : null;
        if (expiryTenor !== null && expiryTenor < 0) throw new RangeError('target expiry precedes curve asOf');
        if (expiryTenor !== null && explicitTenor !== null
            && Math.abs(expiryTenor - explicitTenor) > 1e-9) {
            throw new RangeError('target expiry and tenorDays disagree');
        }
        return { expiry, tenorDays: explicitTenor !== null ? explicitTenor : expiryTenor };
    }

    function metadataAtResolution(points, resolutionMethod, options = {}) {
        const metadata = points.map(point => point.metadata || normalizeMetadata({}));
        const sources = [...new Set(metadata.map(item => item.source).filter(Boolean))];
        const sourceEffectiveDates = [...new Set(
            points.map(point => point.sourceEffectiveDate).filter(Boolean)
        )];
        const snapshotIds = [...new Set(metadata.map(item => item.snapshotId).filter(Boolean))];
        const quoteTimes = metadata
            .map(item => Date.parse(item.quoteAsOf))
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
        const quoteAsOf = quoteTimes.length > 0 ? new Date(quoteTimes[0]).toISOString() : '';
        const quoteAsOfLatest = quoteTimes.length > 0
            ? new Date(quoteTimes[quoteTimes.length - 1]).toISOString()
            : '';
        const quoteSkewMs = quoteTimes.length > 1
            ? quoteTimes[quoteTimes.length - 1] - quoteTimes[0]
            : 0;
        const staleAfterMs = optionalFiniteNumber(options.staleAfterMs);
        const nowMs = options.now === undefined ? Date.now() : finiteNumber(options.now, 'options.now');
        let stale = metadata.some(item => item.stale === true);
        const qualityFlags = [];
        if (resolutionMethod === 'interpolated') qualityFlags.push('interpolated');
        if (resolutionMethod === 'extrapolated_flat') qualityFlags.push('extrapolated');
        if (String(resolutionMethod || '').startsWith('derived_')) qualityFlags.push('derived');
        if (sources.length > 1) qualityFlags.push('mixed_sources');
        if (snapshotIds.length > 1) qualityFlags.push('mixed_snapshots');
        if (quoteSkewMs > 0) qualityFlags.push('quote_time_skew');
        if (staleAfterMs !== null && staleAfterMs >= 0) {
            if (quoteTimes.length !== metadata.length) {
                stale = true;
                qualityFlags.push('missing_quote_as_of');
            } else if (quoteTimes.some(epochMs => nowMs - epochMs > staleAfterMs)) {
                stale = true;
                qualityFlags.push('stale_quote');
            }
        }
        if (quoteTimes.some(epochMs => epochMs > nowMs)) qualityFlags.push('quote_in_future');
        return {
            source: sources.length === 1 ? sources[0] : (sources.length > 1 ? 'mixed' : 'unknown'),
            sources,
            sourceEffectiveDate: sourceEffectiveDates.length === 1 ? sourceEffectiveDates[0] : '',
            sourceEffectiveDates,
            quoteAsOf,
            quoteAsOfLatest,
            quoteSkewMs,
            stale,
            quality: mergeQuality(metadata.map(item => item.quality), qualityFlags),
            snapshotId: snapshotIds.length === 1 ? snapshotIds[0] : '',
            snapshotIds,
        };
    }

    function interpolationValue(kind, lower, upper, weight) {
        if (kind === CURVE_KIND.DISCOUNT) {
            const logDiscountFactor = Math.log(lower.discountFactor)
                + (Math.log(upper.discountFactor) - Math.log(lower.discountFactor)) * weight;
            return {
                discountFactor: Math.exp(logDiscountFactor),
                logDiscountFactor,
            };
        }
        if (kind === CURVE_KIND.FORWARD) {
            return {
                forward: Math.exp(
                    Math.log(lower.forward) + (Math.log(upper.forward) - Math.log(lower.forward)) * weight
                ),
            };
        }
        return { carryRate: lower.carryRate + (upper.carryRate - lower.carryRate) * weight };
    }

    function exactValue(kind, point) {
        if (kind === CURVE_KIND.DISCOUNT) {
            return { zeroRate: point.zeroRate, discountFactor: point.discountFactor };
        }
        if (kind === CURVE_KIND.FORWARD) return { forward: point.forward };
        return { carryRate: point.carryRate };
    }

    function flatValue(kind, point) {
        if (kind === CURVE_KIND.DISCOUNT) return { zeroRate: point.zeroRate };
        return exactValue(kind, point);
    }

    function resolveCurve(curve, expectedKind, target, options = {}) {
        assertCurveKind(curve, expectedKind);
        const normalizedTarget = normalizeTarget(curve, target);
        const exactExpiry = normalizedTarget.expiry
            ? curve.points.find(point => point.expiry === normalizedTarget.expiry)
            : null;
        const exactTenor = curve.points.find(
            point => Math.abs(point.tenorDays - normalizedTarget.tenorDays) <= 1e-9
        );
        let method = '';
        let contributors = [];
        let values = null;
        let bounds = null;
        if (exactExpiry) {
            method = 'exact_expiry';
            contributors = [exactExpiry];
            values = exactValue(curve.kind, exactExpiry);
        } else if (exactTenor) {
            method = 'exact_tenor';
            contributors = [exactTenor];
            values = exactValue(curve.kind, exactTenor);
        } else {
            const lower = [...curve.points].reverse().find(
                point => point.tenorDays < normalizedTarget.tenorDays
            );
            const upper = curve.points.find(point => point.tenorDays > normalizedTarget.tenorDays);
            const maxGap = normalizeLimit(
                options.maxInterpolationGapDays,
                curve.maxInterpolationGapDays,
                'options.maxInterpolationGapDays'
            );
            const maxBracketDistance = normalizeLimit(
                options.maxBracketDistanceDays,
                Number.POSITIVE_INFINITY,
                'options.maxBracketDistanceDays'
            );
            if (lower && upper
                && upper.tenorDays - lower.tenorDays <= maxGap
                && normalizedTarget.tenorDays - lower.tenorDays <= maxBracketDistance
                && upper.tenorDays - normalizedTarget.tenorDays <= maxBracketDistance) {
                const weight = (normalizedTarget.tenorDays - lower.tenorDays)
                    / (upper.tenorDays - lower.tenorDays);
                method = 'interpolated';
                contributors = [lower, upper];
                values = interpolationValue(curve.kind, lower, upper, weight);
                bounds = {
                    lowerExpiry: lower.expiry,
                    lowerTenorDays: lower.tenorDays,
                    upperExpiry: upper.expiry,
                    upperTenorDays: upper.tenorDays,
                    weight,
                };
            } else if (!lower || !upper) {
                const endpoint = !lower ? curve.points[0] : curve.points[curve.points.length - 1];
                const distance = Math.abs(endpoint.tenorDays - normalizedTarget.tenorDays);
                const maxExtrapolation = normalizeLimit(
                    options.maxExtrapolationDays,
                    curve.maxExtrapolationDays,
                    'options.maxExtrapolationDays'
                );
                if (distance <= maxExtrapolation) {
                    method = 'extrapolated_flat';
                    contributors = [endpoint];
                    values = flatValue(curve.kind, endpoint);
                    bounds = {
                        lowerExpiry: endpoint.expiry,
                        lowerTenorDays: endpoint.tenorDays,
                        upperExpiry: endpoint.expiry,
                        upperTenorDays: endpoint.tenorDays,
                        weight: null,
                    };
                }
            }
        }
        if (!values) return null;
        const time = tenorYears(normalizedTarget.tenorDays, curve.dayCountBasis);
        if (curve.kind === CURVE_KIND.DISCOUNT) {
            if (values.discountFactor === undefined) {
                values.discountFactor = Math.exp(-values.zeroRate * time);
            }
            if (values.zeroRate === undefined) {
                values.zeroRate = time === 0 ? 0 : -Math.log(values.discountFactor) / time;
            }
            delete values.logDiscountFactor;
        }
        const metadata = metadataAtResolution(contributors, method, options);
        return {
            kind: curve.kind,
            curveId: curve.id,
            asOf: curve.asOf,
            expiry: normalizedTarget.expiry,
            tenorDays: normalizedTarget.tenorDays,
            timeYears: time,
            rateConvention: curve.rateConvention,
            resolution: {
                method,
                bounds,
            },
            metadata,
            usable: !metadata.stale && metadata.quality.status !== 'invalid',
            ...values,
        };
    }

    function resolveDiscount(curve, target, options) {
        return resolveCurve(curve, CURVE_KIND.DISCOUNT, target, options);
    }

    function resolveForward(curve, target, options) {
        return resolveCurve(curve, CURVE_KIND.FORWARD, target, options);
    }

    function resolveCarry(curve, target, options) {
        return resolveCurve(curve, CURVE_KIND.CARRY, target, options);
    }

    function resolveTimeYears(input) {
        if (input.timeYears !== undefined && input.timeYears !== null) {
            return nonNegativeNumber(input.timeYears, 'timeYears');
        }
        return tenorYears(input.tenorDays, input.dayCountBasis);
    }

    function extractCarryRate(value) {
        if (value && typeof value === 'object') {
            if (value.kind !== CURVE_KIND.CARRY) {
                throw new TypeError(`carry kind mismatch: expected carry, received ${value.kind || 'unknown'}`);
            }
            return finiteNumber(value.carryRate, 'carry.carryRate');
        }
        return finiteNumber(value, 'carryRate');
    }

    function extractForward(value) {
        if (value && typeof value === 'object') {
            if (value.kind !== CURVE_KIND.FORWARD) {
                throw new TypeError(`forward kind mismatch: expected forward, received ${value.kind || 'unknown'}`);
            }
            return positiveNumber(value.forward, 'forward.forward');
        }
        return positiveNumber(value, 'forward');
    }

    function extractDiscountFactor(value) {
        if (value && typeof value === 'object') {
            if (value.kind !== CURVE_KIND.DISCOUNT) {
                throw new TypeError(`discount kind mismatch: expected discount, received ${value.kind || 'unknown'}`);
            }
            return positiveNumber(value.discountFactor, 'discount.discountFactor');
        }
        return positiveNumber(value, 'discountFactor');
    }

    function forwardFromSpotCarry(args) {
        const input = args && typeof args === 'object' ? args : {};
        const spot = positiveNumber(input.spot, 'spot');
        const carryRate = extractCarryRate(firstDefined(input.carry, input.carryRate));
        const time = resolveTimeYears(input);
        return spot * Math.exp(carryRate * time);
    }

    function carryFromSpotForward(args) {
        const input = args && typeof args === 'object' ? args : {};
        const spot = positiveNumber(input.spot, 'spot');
        const forward = extractForward(input.forward);
        const time = resolveTimeYears(input);
        if (time === 0) throw new RangeError('carry is not identifiable at zero tenor');
        return Math.log(forward / spot) / time;
    }

    function forwardFromPutCallParity(args) {
        const input = args && typeof args === 'object' ? args : {};
        const strike = positiveNumber(input.strike, 'strike');
        const callPrice = nonNegativeNumber(input.callPrice, 'callPrice');
        const putPrice = nonNegativeNumber(input.putPrice, 'putPrice');
        const discountFactor = extractDiscountFactor(firstDefined(
            input.discount, input.discountFactor
        ));
        const forward = strike + (callPrice - putPrice) / discountFactor;
        if (!Number.isFinite(forward) || forward <= 0) {
            throw new RangeError('put-call parity produced a non-positive forward');
        }
        return forward;
    }

    function createCurveSet(config) {
        const input = config && typeof config === 'object' ? config : {};
        const asOf = normalizeIsoDate(input.asOf, 'curveSet.asOf');
        const curves = {
            discount: input.discountCurve || null,
            forward: input.forwardCurve || null,
            carry: input.carryCurve || null,
        };
        Object.entries(curves).forEach(([kind, curve]) => {
            if (!curve) return;
            assertCurveKind(curve, kind);
            if (curve.asOf !== asOf) {
                throw new RangeError(`${kind} curve asOf does not match curve set asOf`);
            }
        });
        return {
            schemaVersion: SCHEMA_VERSION,
            asOf,
            marketKey: String(input.marketKey || '').trim(),
            spot: input.spot === undefined || input.spot === null
                ? null
                : positiveNumber(input.spot, 'curveSet.spot'),
            spotMetadata: normalizeMetadata(input.spotMetadata || {}),
            ...curves,
        };
    }

    function resolveCurveSet(curveSet, target, options = {}) {
        if (!curveSet || typeof curveSet !== 'object') throw new TypeError('curveSet is required');
        const discount = curveSet.discount
            ? resolveDiscount(curveSet.discount, target, options)
            : null;
        let forward = curveSet.forward
            ? resolveForward(curveSet.forward, target, options)
            : null;
        let carry = curveSet.carry
            ? resolveCarry(curveSet.carry, target, options)
            : null;
        const targetContext = discount || forward || carry;
        const timeYearsValue = targetContext ? targetContext.timeYears : null;
        if (!forward && carry && Number.isFinite(curveSet.spot)) {
            const derivedMetadata = metadataAtResolution([
                { metadata: curveSet.spotMetadata },
                { metadata: carry.metadata },
            ], 'derived_from_spot_carry', options);
            forward = {
                kind: CURVE_KIND.FORWARD,
                asOf: curveSet.asOf,
                expiry: carry.expiry,
                tenorDays: carry.tenorDays,
                timeYears: carry.timeYears,
                forward: forwardFromSpotCarry({
                    spot: curveSet.spot,
                    carry,
                    timeYears: carry.timeYears,
                }),
                resolution: { method: 'derived_from_spot_carry', bounds: carry.resolution.bounds },
                metadata: derivedMetadata,
                usable: !derivedMetadata.stale && derivedMetadata.quality.status !== 'invalid',
            };
        }
        if (!carry && forward && Number.isFinite(curveSet.spot) && forward.timeYears > 0) {
            const derivedMetadata = metadataAtResolution([
                { metadata: curveSet.spotMetadata },
                { metadata: forward.metadata },
            ], 'derived_from_spot_forward', options);
            carry = {
                kind: CURVE_KIND.CARRY,
                asOf: curveSet.asOf,
                expiry: forward.expiry,
                tenorDays: forward.tenorDays,
                timeYears: forward.timeYears,
                carryRate: carryFromSpotForward({
                    spot: curveSet.spot,
                    forward,
                    timeYears: forward.timeYears,
                }),
                rateConvention: 'continuous_annualized',
                resolution: { method: 'derived_from_spot_forward', bounds: forward.resolution.bounds },
                metadata: derivedMetadata,
                usable: !derivedMetadata.stale && derivedMetadata.quality.status !== 'invalid',
            };
        }
        let forwardConsistency = null;
        if (forward && carry && Number.isFinite(curveSet.spot) && timeYearsValue !== null) {
            const carryImpliedForward = forwardFromSpotCarry({
                spot: curveSet.spot,
                carry,
                timeYears: forward.timeYears,
            });
            forwardConsistency = {
                carryImpliedForward,
                absoluteDifference: forward.forward - carryImpliedForward,
                relativeDifference: forward.forward / carryImpliedForward - 1,
            };
        }
        return { discount, forward, carry, forwardConsistency };
    }

    globalScope.OptionComboMarketCurves = Object.freeze({
        SCHEMA_VERSION,
        CURVE_KIND,
        TREASURY_CURVE_SEMANTICS,
        DEFAULT_DAY_COUNT_BASIS,
        DEFAULT_MAX_INTERPOLATION_GAP_DAYS,
        DEFAULT_TREASURY_MAX_EXTRAPOLATION_DAYS,
        normalizeIsoDate,
        diffCalendarDays,
        tenorYears,
        discountFactorFromZeroRate,
        zeroRateFromDiscountFactor,
        createDiscountCurve,
        createDiscountCurveFromSnapshot,
        createDiscountCurveFromTreasurySnapshot,
        createForwardCurve,
        createCarryCurve,
        resolveDiscount,
        resolveForward,
        resolveCarry,
        forwardFromSpotCarry,
        carryFromSpotForward,
        forwardFromPutCallParity,
        cmtParYieldToContinuousProxy,
        createCurveSet,
        resolveCurveSet,
    });
})(typeof globalThis !== 'undefined' ? globalThis : window);
