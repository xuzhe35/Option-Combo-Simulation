const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadBrowserScripts } = require('./helpers/load-browser-scripts');
const root = path.resolve(__dirname, '..');
module.exports = { name: 'stress worker', tests: [{
    name: 'the actual worker produces the same center and envelope as the synchronous pure modules',
    run() {
        const dependencies = ['js/cost_basis_core.js', 'js/american_binomial.js', 'js/market_curves.js',
            'js/cost_basis_stress_models.js', 'js/cost_basis_stress_core.js', 'js/cost_basis_stress_band.js'];
        const normal = loadBrowserScripts(dependencies);
        const options = { centerPrice: 100, asOfInstant: '2026-09-08T16:00:00Z',
            targetInstant: '2026-09-09T20:00:00Z', throughExpiry: '20260909', pointCount: 11 };
        const events = [{ kind: 'opening_balance', account: 'U1', tradeDate: '2026-01-01',
            shares: 100, cashAmount: -10000, price: 100 },
        { kind: 'option_trade', account: 'U1', tradeDate: '2026-01-02',
            right: 'P', strike: 95, expiry: '20260909', contracts: -1,
            sharesPerContract: 100, cashAmount: 300, price: 3 }];
        const compiled = normal.OptionComboCostBasisStressCore.compile(events, options);
        const expectedCenter = normal.OptionComboCostBasisStressCore.sweep(compiled);
        const expected = normal.OptionComboCostBasisStressBand.calculate(compiled);
        let output;
        const worker = vm.createContext({ Math, Date, Intl });
        worker.self = worker;
        worker.postMessage = message => { output = message; };
        worker.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), worker));
        vm.runInContext(fs.readFileSync(path.join(root, 'js/cost_basis_stress_worker.js'), 'utf8'), worker);
        worker.onmessage({ data: { generation: 7, dependencies, events, options } });
        assert.equal(output.generation, 7);
        assert.equal(output.center.available, true);
        assert.equal(JSON.stringify(output.center), JSON.stringify(expectedCenter));
        assert.ok(new Set(output.center.points.map(p => p.cost)).size > 1);
        assert.equal(JSON.stringify(output.band), JSON.stringify(expected));
        worker.onmessage({ data: { generation: 8, dependencies: ['missing.js'], events, options } });
        assert.equal(output.generation, 8);
        assert.equal(output.band.available, false);
    },
}] };
