/**
 * Compatibility layer for the extracted pure pricing modules.
 */

(function attachPricingCompatibility(globalScope) {
    const pricingCore = globalScope.OptionComboPricingCore;
    const dateUtils = globalScope.OptionComboDateUtils;

    if (!pricingCore || !dateUtils) {
        throw new Error('date_utils.js and pricing_core.js must be loaded before bsm.js');
    }

    Object.assign(globalScope, dateUtils, pricingCore);
})(typeof globalThis !== 'undefined' ? globalThis : window);
