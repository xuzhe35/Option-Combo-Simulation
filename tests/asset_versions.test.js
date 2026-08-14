const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// Mirrors scripts/stamp_asset_versions.py. Kept as an independent
// reimplementation on purpose: if the two ever disagree the test fails, which
// is what we want from a guard.
const PAGES = [
    'index.html',
    'chart_lab.html',
    'iv_term_structure.html',
    'workspace_db_admin.html',
];
const HASH_LENGTH = 12;
const ASSET_REFERENCE = /\b(?:src|href)="([A-Za-z0-9_./-]+\.(?:js|css))(?:\?v=([^"]*))?"/g;

function contentTag(relativePath) {
    const bytes = fs.readFileSync(path.join(PROJECT_ROOT, relativePath));
    return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, HASH_LENGTH);
}

function collectReferences(pageName) {
    const html = fs.readFileSync(path.join(PROJECT_ROOT, pageName), 'utf8');
    const references = [];
    let match = ASSET_REFERENCE.exec(html);
    while (match !== null) {
        references.push({ assetPath: match[1], tag: match[2] });
        match = ASSET_REFERENCE.exec(html);
    }
    ASSET_REFERENCE.lastIndex = 0;
    return references;
}

module.exports = {
    name: 'asset cache-busting tags',
    tests: [
        {
            // The workspace is served as static files, so a browser will run a
            // cached valuation.js against a fresh ws_client.js unless the URL
            // changes. Hand-maintained tags failed this repeatedly (commit
            // 94ed93b, and ten stale references found on 2026-08-06), so the
            // tag is now the file's own content hash and this test is the gate.
            name: 'every local script and stylesheet carries its own content hash',
            run() {
                const stale = [];
                const untagged = [];
                const missing = [];

                PAGES.forEach((pageName) => {
                    collectReferences(pageName).forEach(({ assetPath, tag }) => {
                        if (!fs.existsSync(path.join(PROJECT_ROOT, assetPath))) {
                            missing.push(`${pageName}: ${assetPath}`);
                            return;
                        }
                        if (tag === undefined) {
                            untagged.push(`${pageName}: ${assetPath}`);
                            return;
                        }
                        const expected = contentTag(assetPath);
                        if (tag !== expected) {
                            stale.push(`${pageName}: ${assetPath} has ?v=${tag}, expected ${expected}`);
                        }
                    });
                });

                const hint = ' Run: python3 scripts/stamp_asset_versions.py';
                assert.deepEqual(missing, [], `referenced asset does not exist.${hint}`);
                assert.deepEqual(untagged, [], `asset reference has no ?v= tag.${hint}`);
                assert.deepEqual(stale, [], `asset reference points at a stale tag.${hint}`);
            },
        },
        {
            name: 'pages actually reference assets, so the guard cannot pass vacuously',
            run() {
                // The admin page's manifest is deliberately tiny (its exact
                // three-asset content is asserted in
                // workspace_db_admin_page.test.js); trading pages carry many.
                const minimumReferences = { 'workspace_db_admin.html': 3 };
                PAGES.forEach((pageName) => {
                    const references = collectReferences(pageName);
                    const minimum = minimumReferences[pageName] || 6;
                    assert.ok(
                        references.length >= minimum,
                        `${pageName} resolved only ${references.length} asset references; `
                        + 'the reference pattern probably stopped matching.'
                    );
                });
            },
        },
    ],
};
