/**
 * Probability-distribution proxy mapping.
 *
 * Some underlyings in this app do not have a meaningful long-lived return
 * history for Student-t fitting (for example front futures contracts).
 * In those cases we map the analysis to a liquid proxy ETF/index series
 * whose historical distribution is close enough for the current framework.
 */

(function attachDistributionProxyConfig(globalScope) {
    const DISTRIBUTION_PROXY_MAP = Object.freeze({
        ES: 'SPY',
        SPX: 'SPY',
        SPXW: 'SPY',
        NQ: 'QQQ',
        NDX: 'QQQ',
        NDXP: 'QQQ',
        GC: 'GLD',
        SI: 'SLV',
    });

    function normalizeSymbol(symbol) {
        return String(symbol || '').trim().toUpperCase();
    }

    function resolveDistributionSymbol(underlyingSymbol, profile) {
        const normalizedSymbol = normalizeSymbol(underlyingSymbol);
        const family = normalizeSymbol(profile && profile.family);

        return DISTRIBUTION_PROXY_MAP[normalizedSymbol]
            || DISTRIBUTION_PROXY_MAP[family]
            || normalizedSymbol;
    }

    globalScope.OptionComboDistributionProxyConfig = {
        DISTRIBUTION_PROXY_MAP,
        normalizeSymbol,
        resolveDistributionSymbol,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
