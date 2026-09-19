/* JSON-lines worker for the independent Python state-machine tests. No I/O to a broker. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readline = require('node:readline');
const { loadBrowserScripts } = require('./load-browser-scripts');
const c = loadBrowserScripts(['js/cost_basis_core.js', 'js/cost_basis_import.js', 'js/cost_basis.js']);
const root = path.resolve(__dirname, '../..');
vm.runInContext(fs.readFileSync(path.join(root, 'js/cost_basis.js'), 'utf8').replace(
    'globalScope.OptionComboCostBasisPage = {',
    'globalScope.randomHarness={state,parse:_parseImportText,newRows:_importNewRows};\nglobalScope.OptionComboCostBasisPage = {'), c);
const nodes = new Map();
c.document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, hidden: false });
    return nodes.get(id);
} };
const core = c.OptionComboCostBasisCore;
const computeLedger = core.computeLedger;
let capturedPreview;
core.computeLedger = (...args) => { capturedPreview = computeLedger(...args); return capturedPreview; };
function snapshot(ledger) {
    return { combined: ledger.combined, options: ledger.openOptions,
        futures: ledger.openFutures || [], warnings: ledger.warnings,
        running: ledger.rows.map(r => ({cash: r.runningNetCash, shares: r.runningShares})) };
}
function handle(data) {
    if (data.op === 'replay') return snapshot(core.computeLedger(data.rows, data.options || {}));
    if (data.op === 'prefixes') return data.rows.map((_, i) =>
        snapshot(core.computeLedger(data.rows.slice(0, i + 1), data.options || {})));
    if (data.op === 'page') {
        const h = c.randomHarness;
        Object.assign(h.state, {bookId:'random', books:[{...data.book, bookId:'random'}],
            allEvents:data.existing || [], ledger:core.computeLedger(data.existing || [], data.book),
            ledgerVersion:{digest:'random-test'}, importGeneration:1,
            importCommitTokens:null, importCommitPending:false, importReading:false,
            importAccountConfirmation:null});
        c.document.getElementById('import-replace').checked = !!data.rebuild;
        capturedPreview = null;
        h.parse(data.csv, {fileName:'random.csv', fileDigest:'random-test'});
        const r = h.state.importResult;
        return {rows:h.newRows(r), problems:r.problems, preview:r.ledgerPreview,
            snapshot:capturedPreview ? snapshot(capturedPreview) : null};
    }
    throw new Error('Unknown operation: ' + data.op);
}
readline.createInterface({input:process.stdin}).on('line', line => {
    try { process.stdout.write(JSON.stringify({result:handle(JSON.parse(line))}) + '\n'); }
    catch (error) { process.stdout.write(JSON.stringify({error:error.stack}) + '\n'); }
});
