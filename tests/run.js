const suites = [
    require('./market_holidays.test'),
    require('./bsm.test'),
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
