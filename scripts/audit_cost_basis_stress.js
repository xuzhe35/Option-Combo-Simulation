#!/usr/bin/env node
/**
 * Offline cash/expiry/calibration/band invariant audit for the new kernel.
 * The original failing legacy probes are preserved in git/review history.
 * No sockets, local books or market services are accessed.
 */
const suite = require('../tests/cost_basis_stress.test');
const checks = suite.tests.map(test => {
    try { test.run(); return { name: test.name, passed: true }; }
    catch (error) { return { name: test.name, passed: false, reason: error.message }; }
});
const violated = checks.filter(check => !check.passed).length;
console.log(JSON.stringify({ checks, passed: checks.length - violated, violated }, null, 2));
if (violated) process.exitCode = 1;
