/**
 * Cox-Ross-Rubinstein American option pricer.
 *
 * This module is intentionally standalone so the existing BSM / Black-76
 * pricing paths remain untouched unless the user explicitly selects it.
 * Rates and dividend yield are continuously compounded. `varianceTime` and
 * `rateTime` may differ because the simulator supports a weighted variance
 * clock while discounting remains ACT/365.
 */
(function attachAmericanBinomial(globalScope) {
    const DEFAULT_STEPS = 201;
    const MIN_STEPS = 25;
    const MAX_STEPS = 1001;

    function normalizeSteps(value) {
        const parsed = Math.round(Number(value));
        if (!Number.isFinite(parsed)) return DEFAULT_STEPS;
        return Math.min(MAX_STEPS, Math.max(MIN_STEPS, parsed));
    }

    function intrinsicValue(type, spot, strike) {
        return type === 'call'
            ? Math.max(0, spot - strike)
            : Math.max(0, strike - spot);
    }

    function deterministicAmericanValue(
        type,
        spot,
        strike,
        rate,
        dividendYield,
        rateTime,
        steps
    ) {
        let best = intrinsicValue(type, spot, strike);
        for (let index = 1; index <= steps; index += 1) {
            const fraction = index / steps;
            const nodeSpot = spot * Math.exp(
                (rate - dividendYield) * rateTime * fraction
            );
            const discountedExercise = Math.exp(-rate * rateTime * fraction)
                * intrinsicValue(type, nodeSpot, strike);
            best = Math.max(best, discountedExercise);
        }
        return best;
    }

    function calculateAmericanOptionPrice(options) {
        const input = options && typeof options === 'object' ? options : {};
        const type = String(input.type || '').trim().toLowerCase();
        const spot = Number(input.spot);
        const strike = Number(input.strike);
        const varianceTime = Number(input.varianceTime);
        const rateTime = Number.isFinite(Number(input.rateTime))
            ? Math.max(0, Number(input.rateTime))
            : varianceTime;
        const rate = Number(input.riskFreeRate);
        const volatility = Number(input.volatility);
        const dividendYield = Number.isFinite(Number(input.dividendYield))
            ? Number(input.dividendYield)
            : 0;
        const steps = normalizeSteps(input.steps);

        if (!['call', 'put'].includes(type)
            || ![spot, strike, varianceTime, rateTime, rate, volatility, dividendYield]
                .every(Number.isFinite)
            || spot <= 0
            || strike <= 0
            || varianceTime < 0
            || volatility < 0) {
            return Number.NaN;
        }
        if (varianceTime <= 0) {
            return intrinsicValue(type, spot, strike);
        }

        const varianceStep = varianceTime / steps;
        const rateStep = rateTime / steps;
        const volatilityStep = volatility * Math.sqrt(varianceStep);
        const carryGrowth = Math.exp((rate - dividendYield) * rateStep);

        // At effectively zero variance the CRR probability is undefined.
        // Price the deterministic path directly, still checking exercise at
        // every node so the American floor is preserved.
        if (!Number.isFinite(volatilityStep) || volatilityStep < 1e-7) {
            return deterministicAmericanValue(
                type,
                spot,
                strike,
                rate,
                dividendYield,
                rateTime,
                steps
            );
        }

        const up = Math.exp(volatilityStep);
        const down = 1 / up;
        const probabilityUp = (carryGrowth - down) / (up - down);
        if (!Number.isFinite(probabilityUp)
            || probabilityUp < 0
            || probabilityUp > 1) {
            return deterministicAmericanValue(
                type,
                spot,
                strike,
                rate,
                dividendYield,
                rateTime,
                steps
            );
        }

        const discount = Math.exp(-rate * rateStep);
        const values = new Float64Array(steps + 1);
        const terminalLowestSpot = spot * Math.pow(down, steps);
        const nodeRatio = up / down;
        let nodeSpot = terminalLowestSpot;
        for (let upMoves = 0; upMoves <= steps; upMoves += 1) {
            values[upMoves] = intrinsicValue(type, nodeSpot, strike);
            nodeSpot *= nodeRatio;
        }

        for (let level = steps - 1; level >= 0; level -= 1) {
            nodeSpot = spot * Math.pow(down, level);
            for (let upMoves = 0; upMoves <= level; upMoves += 1) {
                const continuation = discount * (
                    probabilityUp * values[upMoves + 1]
                    + (1 - probabilityUp) * values[upMoves]
                );
                const exercise = intrinsicValue(type, nodeSpot, strike);
                values[upMoves] = Math.max(exercise, continuation);
                nodeSpot *= nodeRatio;
            }
        }

        return Math.max(intrinsicValue(type, spot, strike), values[0]);
    }

    globalScope.OptionComboAmericanBinomial = {
        DEFAULT_STEPS,
        MIN_STEPS,
        MAX_STEPS,
        normalizeSteps,
        calculateAmericanOptionPrice,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
