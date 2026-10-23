// Stage-scoped checks; P2 here covers the local recognition adapter, not OCR accuracy claims.
const suite = { tests: [...require('./portfolio_snapshot.test').tests, ...require('./portfolio_snapshot_structure.test').tests, ...require('./portfolio_snapshot_audit.test').tests, ...require('./portfolio_snapshot_cell_review.test').tests, ...require('./portfolio_snapshot_reply.test').tests, ...require('./portfolio_snapshot_codex.test').tests, ...require('./portfolio_snapshot_codex_review.test').tests, ...require('./portfolio_snapshot_tws_model.test').tests, ...require('./portfolio_snapshot_tws_client.test').tests] };
const stage = process.argv[process.argv.indexOf('--stage') + 1];
// X stages (TWS comparison plan) run after every P stage.
const rank = { P0: 0, P1: 1, P2: 2, X0: 3, X1: 4, X2: 5, X3: 6, X4: 7, X5: 8, X6: 9 };
if (!(stage in rank)) throw new Error('Usage: node tests/run_portfolio_snapshot.js --stage P1 (P0-P2, X0-X6)');
const checks = suite.tests.filter(test => rank[test.stage || 'P2'] <= rank[stage]);
let failed = 0;
(async () => {
    for (const test of checks) {
        try { await test.run(); console.log('ok - ' + test.name); }
        catch (e) { failed++; console.error('FAIL - ' + test.name + '\n' + e.stack); }
    }
    console.log(`${checks.length - failed} passed, ${failed} failed (${stage})`);
    process.exitCode = failed ? 1 : 0;
})();
