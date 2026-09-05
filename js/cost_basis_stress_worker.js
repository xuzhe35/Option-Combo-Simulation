/* Dedicated worker. Dependencies are the exact versioned script URLs loaded by the page. */
if (typeof document === 'undefined') self.onmessage = function (event) {
    const { generation, dependencies, events, options, bandOptions } = event.data;
    try {
        importScripts(...dependencies);
        const compiled = self.OptionComboCostBasisStressCore.compile(events, options);
        const center = self.OptionComboCostBasisStressCore.sweep(compiled);
        const band = self.OptionComboCostBasisStressBand.calculate(compiled, bandOptions, center);
        self.postMessage({ generation, center, band });
    } catch (error) {
        self.postMessage({ generation, band: { available: false, reason: error.message } });
    }
};
