const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TSCONFIG = path.join(PROJECT_ROOT, 'tsconfig.json');
const TSC = path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

// tsconfig.json carries whole-line // comments; nothing else in it needs them.
function readTsconfig() {
    const text = fs.readFileSync(TSCONFIG, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(text);
}

function checkedScripts() {
    return readTsconfig().files.filter((file) => file.endsWith('.js'));
}

module.exports = {
    name: 'type check (tsc --noEmit over the opted-in modules)',
    tests: [
        {
            name: 'every module the type check covers opts in with // @ts-check',
            run() {
                const scripts = checkedScripts();
                assert.ok(scripts.length > 0, 'tsconfig.json lists no scripts');
                scripts.forEach((file) => {
                    const firstLine = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8').split('\n', 1)[0];
                    assert.equal(firstLine.trim(), '// @ts-check',
                        `${file} is in tsconfig.json but does not start with // @ts-check`);
                });
            },
        },
        {
            name: 'the opted-in modules type-check under strict',
            run() {
                // A missing compiler fails rather than skips: a skipped gate
                // reads as a pass.
                assert.ok(fs.existsSync(TSC),
                    'TypeScript is not installed. Run `npm install` in the project root '
                    + '(a dev dependency only; the pages load plain scripts and need no build).');
                const result = childProcess.spawnSync(process.execPath, [TSC, '-p', TSCONFIG], {
                    cwd: PROJECT_ROOT,
                    encoding: 'utf8',
                });
                assert.equal(result.error, undefined, String(result.error));
                assert.equal(result.status, 0,
                    `tsc reported type errors:\n${result.stdout}${result.stderr}`);
            },
        },
    ],
};
