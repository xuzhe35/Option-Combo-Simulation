/**
 * Page-level capability registry.
 *
 * This keeps page differences explicit so shared scripts can branch on named
 * features instead of implicit DOM drift.
 */

(function attachPageCapabilities(globalScope) {
    const PAGE_CAPABILITY_MAP = {
        portfolio: {
            deltaHedgePanel: true,
            chartLabTabs: false,
            chartLabProjection: false,
        },
        'chart-lab': {
            deltaHedgePanel: false,
            chartLabTabs: true,
            chartLabProjection: true,
        },
    };

    function _readBodyDatasetValue() {
        const body = globalScope.document && globalScope.document.body;
        if (!body) {
            return '';
        }
        if (body.dataset && typeof body.dataset.optionComboPage === 'string') {
            return body.dataset.optionComboPage;
        }
        if (typeof body.getAttribute === 'function') {
            return body.getAttribute('data-option-combo-page') || '';
        }
        return '';
    }

    function _normalizePageKind(value) {
        const normalized = String(value || '').trim().toLowerCase();
        return PAGE_CAPABILITY_MAP[normalized] ? normalized : 'portfolio';
    }

    function getPageKind() {
        return _normalizePageKind(globalScope.OPTION_COMBO_PAGE_KIND || _readBodyDatasetValue());
    }

    function resolveCapabilities(pageKind = getPageKind()) {
        return {
            pageKind: _normalizePageKind(pageKind),
            ...(PAGE_CAPABILITY_MAP[_normalizePageKind(pageKind)] || PAGE_CAPABILITY_MAP.portfolio),
        };
    }

    function hasFeature(featureName, pageKind) {
        const capabilities = resolveCapabilities(pageKind);
        return capabilities[featureName] === true;
    }

    globalScope.OptionComboPageCapabilities = {
        getPageKind,
        resolveCapabilities,
        hasFeature,
    };
})(typeof window !== 'undefined' ? window : globalThis);
