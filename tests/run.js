const suites = [
    require('./market_holidays.test'),
    require('./product_registry.test'),
    require('./index_forward_rate.test'),
    require('./market_curves.test'),
    require('./pricing_context.test'),
    require('./distribution_proxy_config.test'),
    require('./prob_charts.test'),
    require('./projection_fail_closed.test'),
    require('./calendar_convergence.test'),
    require('./calendar_projection_validator.test'),
    require('./iv_term_structure_core.test'),
    require('./iv_term_structure_page.test'),
    require('./calendar_handoff.test'),
    require('./implied_lambda_handoff.test'),
    require('./implied_lambda_pipeline.test'),
    require('./group_order_builder.test'),
    require('./leg_position_check.test'),
    require('./order_safety.test'),
    require('./trade_trigger_logic.test'),
    require('./combo_order_transport.test'),
    require('./page_capabilities.test'),
    require('./delta_hedge_logic.test'),
    require('./delta_hedge_transport.test'),
    require('./delta_hedge_ui.test'),
    require('./chart_quality_note.test'),
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

async function runSuites() {
    for (const suite of suites) {
        console.log(`\n# ${suite.name}`);

        for (const testCase of suite.tests) {
            try {
                await testCase.run();
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
}

runSuites().catch((error) => {
    failed += 1;
    console.log(error.stack);
    process.exitCode = 1;
});
