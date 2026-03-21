const suites = [
    require('./market_holidays.test'),
    require('./product_registry.test'),
    require('./distribution_proxy_config.test'),
    require('./group_order_builder.test'),
    require('./trade_trigger_logic.test'),
    require('./bsm.test'),
    require('./amortized.test'),
    require('./valuation.test'),
    require('./session_logic.test'),
    require('./session_ui.test'),
    require('./control_panel_ui.test'),
    require('./group_ui.test'),
    require('./ws_client.test'),
    require('./group_editor_ui.test'),
    require('./hedge_editor_ui.test'),
];

let passed = 0;
let failed = 0;

for (const suite of suites) {
    console.log(`\n# ${suite.name}`);

    for (const testCase of suite.tests) {
        try {
            testCase.run();
            passed += 1;
            console.log(`ok - ${testCase.name}`);
        } catch (error) {
            failed += 1;
            console.log(`not ok - ${testCase.name}`);
            console.log(error.stack);
        }
    }
}

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exitCode = 1;
}
