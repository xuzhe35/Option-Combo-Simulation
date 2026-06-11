const suites = [
    require('./market_holidays.test'),
    require('./ws_auth_client.test'),
    require('./product_registry.test'),
    require('./distribution_proxy_config.test'),
    require('./iv_term_structure_core.test'),
    require('./group_order_builder.test'),
    require('./trade_trigger_logic.test'),
    require('./combo_order_transport.test'),
    require('./page_capabilities.test'),
    require('./delta_hedge_logic.test'),
    require('./delta_hedge_transport.test'),
    require('./delta_hedge_ui.test'),
    require('./bsm.test'),
    require('./amortized.test'),
    require('./valuation.test'),
    require('./session_logic.test'),
    require('./session_ui.test'),
    require('./app.test'),
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
