const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function loadCore() {
    const context = loadBrowserScripts(['js/workspace_db_admin_core.js']);
    return context.OptionComboWorkspaceDbAdminCore;
}

module.exports = {
    name: 'workspace_db_admin_core.js',
    tests: [
        {
            name: 'formatBytes reports unavailable for missing values, never 0',
            run() {
                const core = loadCore();
                for (const missing of [null, undefined, -1, 1.5, 'x', NaN]) {
                    const formatted = core.formatBytes(missing);
                    assert.equal(formatted.available, false);
                    assert.equal(formatted.human, 'unavailable');
                    assert.equal(formatted.exact, null);
                }
                assert.equal(core.formatBytes(0).human, '0 B');
                assert.equal(core.formatBytes(0).available, true);
            },
        },
        {
            name: 'formatBytes pairs a human value with the exact integer',
            run() {
                const core = loadCore();
                const formatted = core.formatBytes(1572864);
                assert.equal(formatted.human, '1.5 MiB');
                assert.equal(formatted.exact, '1,572,864 B');
                assert.equal(core.formatBytes(512).human, '512 B');
                assert.equal(core.formatBytes(1536).human, '1.5 KiB');
            },
        },
        {
            name: 'normalizeStorageStats keeps missing numbers null, not 0',
            run() {
                const core = loadCore();
                const stats = core.normalizeStorageStats({
                    success: true,
                    mode: 'fast',
                    documents: { active: 3 },
                    storage: { logicalPayloadBytes: 100 },
                });
                assert.equal(stats.documents.active, 3);
                assert.equal(stats.documents.recentlyDeleted, null);
                assert.equal(stats.storage.logicalPayloadBytes, 100);
                assert.equal(stats.storage.allocatedDbBytes, null);
                assert.equal(stats.storage.walBytes, null);
                assert.equal(stats.candidates.oldRevisions.candidateCount, null);
            },
        },
        {
            name: 'normalizeStorageStats rejects error and exact-mode frames',
            run() {
                const core = loadCore();
                assert.equal(core.normalizeStorageStats(null), null);
                assert.equal(core.normalizeStorageStats({ success: false }), null);
                assert.equal(
                    core.normalizeStorageStats({ success: true, mode: 'exact' }),
                    null
                );
            },
        },
        {
            name: 'normalizeAdminStatus fails closed on malformed frames',
            run() {
                const core = loadCore();
                const status = core.normalizeAdminStatus({ nonsense: true });
                assert.equal(status.available, false);
                assert.equal(status.capability.statsFast, false);
                assert.equal(status.capability.archiveExecute, false);

                const good = core.normalizeAdminStatus({
                    success: true,
                    available: true,
                    schemaVersion: 2,
                    capability: { readOnly: true, statsFast: true, statsExact: true },
                    policy: { revisionKeepRecent: 50 },
                });
                assert.equal(good.available, true);
                assert.equal(good.schemaVersion, 2);
                assert.equal(good.capability.statsFast, true);
                assert.equal(good.capability.archiveExecute, false);
            },
        },
        {
            name: 'connection reducer walks the documented transitions',
            run() {
                const core = loadCore();
                let state = 'disconnected';
                state = core.connectionReducer(state, 'socket-connecting');
                assert.equal(state, 'connecting');
                state = core.connectionReducer(state, 'socket-open');
                assert.equal(state, 'connected');
                state = core.connectionReducer(state, 'status-unavailable');
                assert.equal(state, 'unavailable');
                state = core.connectionReducer(state, 'status-available');
                assert.equal(state, 'connected');
                state = core.connectionReducer(state, 'socket-closed');
                assert.equal(state, 'disconnected');
                // Store-status events while disconnected change nothing.
                assert.equal(
                    core.connectionReducer('disconnected', 'status-available'),
                    'disconnected'
                );
            },
        },
        {
            name: 'archive buttons need capability, preview, and confirmation',
            run() {
                const core = loadCore();
                const base = {
                    connection: 'connected',
                    storeAvailable: true,
                    jobRunning: false,
                    capability: { archivePreview: true, archiveExecute: true },
                };
                // Preview is enough for previewArchive…
                assert.equal(core.buttonAvailability(base).previewArchive, true);
                // …but execute additionally needs plan + typed confirmation.
                assert.equal(core.buttonAvailability(base).executeArchive, false);
                assert.equal(core.buttonAvailability({
                    ...base, planReady: true,
                }).executeArchive, false);
                assert.equal(core.buttonAvailability({
                    ...base, planReady: true, confirmationValid: true,
                }).executeArchive, true);
                // No capability, no buttons, whatever the page claims.
                assert.equal(core.buttonAvailability({
                    ...base, capability: {}, planReady: true,
                    confirmationValid: true,
                }).executeArchive, false);
                // Restore follows its own capability flag.
                assert.equal(core.buttonAvailability({
                    ...base, capability: { restore: true },
                }).restore, true);
                assert.equal(core.buttonAvailability({
                    ...base, capability: { restore: true }, jobRunning: true,
                }).restore, false);
                assert.equal(core.buttonAvailability(base).restore, false);

                const offline = core.buttonAvailability({
                    connection: 'disconnected', storeAvailable: true,
                });
                assert.equal(offline.refreshStats, false);
                assert.equal(offline.previewArchive, false);

                const busy = core.buttonAvailability({
                    connection: 'connected', storeAvailable: true, jobRunning: true,
                    capability: { archivePreview: true, archiveExecute: true },
                    planReady: true, confirmationValid: true,
                });
                assert.equal(busy.refreshStats, true);
                assert.equal(busy.exactStats, false);
                assert.equal(busy.executeArchive, false);
            },
        },
        {
            name: 'cancel is withdrawn once the commit stage begins',
            run() {
                const core = loadCore();
                const running = {
                    connection: 'connected', storeAvailable: true,
                    jobRunning: true,
                };
                assert.equal(core.buttonAvailability({
                    ...running, jobStage: 'copying',
                }).cancelJob, true);
                assert.equal(core.buttonAvailability({
                    ...running, jobStage: null,
                }).cancelJob, true);
                assert.equal(core.buttonAvailability({
                    ...running, jobStage: 'committing',
                }).cancelJob, false);
                assert.equal(core.buttonAvailability({
                    ...running, jobRunning: false,
                }).cancelJob, false);
            },
        },
        {
            name: 'confirmation phrase must match the server totals exactly',
            run() {
                const core = loadCore();
                const totals = { revisionCount: 128 };
                assert.equal(core.confirmationTemplate(totals),
                    'ARCHIVE 128 REVISIONS');
                assert.equal(core.validateConfirmation(
                    'ARCHIVE 128 REVISIONS', totals), true);
                assert.equal(core.validateConfirmation(
                    '  ARCHIVE 128 REVISIONS  ', totals), true);
                assert.equal(core.validateConfirmation(
                    'archive 128 revisions', totals), false);
                assert.equal(core.validateConfirmation(
                    'ARCHIVE 127 REVISIONS', totals), false);
                assert.equal(core.validateConfirmation(
                    'ARCHIVE 128 REVISIONS', { revisionCount: null }), false);
            },
        },
        {
            name: 'every stable error code maps to actionable guidance',
            run() {
                const core = loadCore();
                for (const code of ['archive_plan_stale', 'maintenance_busy',
                                    'insufficient_disk_space',
                                    'archive_verification_failed',
                                    'unsafe_reclaim_refused']) {
                    const text = core.errorGuidance(code);
                    assert.equal(typeof text, 'string');
                    assert.ok(text.length > 10, `${code} guidance too short`);
                }
                assert.match(core.errorGuidance('archive_plan_stale'), /[Pp]review/);
                assert.match(core.errorGuidance('something_unknown'), /server log/);
            },
        },
        {
            name: 'the page protocol surface is frozen to the admin actions',
            run() {
                const core = loadCore();
                assert.deepEqual([...core.ALLOWED_CLIENT_ACTIONS].sort(), [
                    'cancel_workspace_maintenance_job',
                    'execute_workspace_archive',
                    'get_workspace_maintenance_job',
                    'list_archived_workspaces',
                    'list_workspace_archive_batches',
                    'list_workspace_maintenance_jobs',
                    'preview_workspace_archive',
                    'request_workspace_admin_status',
                    'request_workspace_space_reclaim',
                    'request_workspace_storage_stats',
                    'restore_archived_workspace',
                ]);
            },
        },
    ],
};
