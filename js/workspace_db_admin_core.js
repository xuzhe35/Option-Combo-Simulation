/**
 * Workspace DB admin page — DOM-free core.
 *
 * Response normalization, capacity formatting, the connection state machine,
 * and button availability rules. No DOM, no WebSocket, no timers: everything
 * here is deterministic and unit-tested in Node.
 *
 * Hard rules (plan sections 10/11):
 * - a missing statistic renders as "unavailable", never as 0;
 * - bytes always carry both a human-readable value and the exact integer;
 * - phase 2 is read-only: archive/restore/cancel actions are disabled no
 *   matter what the inputs claim.
 */

(function attachWorkspaceDbAdminCore(globalScope) {
    'use strict';

    const CONNECTION_STATES = Object.freeze([
        'disconnected', 'connecting', 'connected', 'unavailable',
    ]);

    // The only actions this page is ever allowed to send. The page script
    // routes every outbound request through this list; anything else (orders,
    // market data, valuation) is structurally impossible.
    const ALLOWED_CLIENT_ACTIONS = Object.freeze([
        'request_workspace_admin_status',
        'request_workspace_storage_stats',
        'get_workspace_maintenance_job',
        'preview_workspace_archive',
        'execute_workspace_archive',
        'cancel_workspace_maintenance_job',
        'list_workspace_maintenance_jobs',
        'list_workspace_archive_batches',
        'list_archived_workspaces',
        'request_workspace_space_reclaim',
        'restore_archived_workspace',
    ]);

    function _isCount(value) {
        return typeof value === 'number' && Number.isFinite(value)
            && Number.isInteger(value) && value >= 0;
    }

    function _intOrNull(value) {
        return _isCount(value) ? value : null;
    }

    function formatBytes(value) {
        if (!_isCount(value)) {
            return { available: false, human: 'unavailable', exact: null };
        }
        const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        let scaled = value;
        let unitIndex = 0;
        while (scaled >= 1024 && unitIndex < units.length - 1) {
            scaled /= 1024;
            unitIndex += 1;
        }
        const human = unitIndex === 0
            ? `${value} B`
            : `${scaled.toFixed(1)} ${units[unitIndex]}`;
        return {
            available: true,
            human,
            exact: `${value.toLocaleString('en-US')} B`,
        };
    }

    function formatCount(value) {
        if (!_isCount(value)) {
            return { available: false, human: 'unavailable' };
        }
        return { available: true, human: value.toLocaleString('en-US') };
    }

    function normalizeAdminStatus(response) {
        if (!response || typeof response !== 'object'
            || response.success !== true) {
            return {
                available: false,
                reason: (response && typeof response.code === 'string')
                    ? response.code : 'malformed_response',
                schemaVersion: null,
                capability: _emptyCapability(),
                policy: null,
                currentJob: null,
            };
        }
        const capability = (response.capability && typeof response.capability === 'object')
            ? response.capability : {};
        return {
            available: response.available === true,
            reason: typeof response.reason === 'string' ? response.reason : '',
            schemaVersion: _intOrNull(response.schemaVersion),
            capability: {
                readOnly: capability.readOnly === true,
                statsFast: capability.statsFast === true,
                statsExact: capability.statsExact === true,
                archivePreview: capability.archivePreview === true,
                archiveExecute: capability.archiveExecute === true,
                restore: capability.restore === true,
            },
            policy: (response.policy && typeof response.policy === 'object')
                ? response.policy : null,
            currentJob: normalizeJob(response.currentJob),
        };
    }

    function _emptyCapability() {
        return {
            readOnly: true,
            statsFast: false,
            statsExact: false,
            archivePreview: false,
            archiveExecute: false,
            restore: false,
        };
    }

    function normalizeStorageStats(response) {
        if (!response || typeof response !== 'object'
            || response.success !== true || response.mode !== 'fast') {
            return null;
        }
        const documents = response.documents || {};
        const revisions = response.revisions || {};
        const storage = response.storage || {};
        const archive = response.archive || {};
        const recent = response.recent || {};
        const candidates = response.candidates || {};
        const oldRevisions = candidates.oldRevisions || {};
        const expiredDeleted = candidates.expiredDeletedDocuments || {};

        function _recentWindow(window) {
            const value = recent[window] || {};
            return {
                revisions: _intOrNull(value.revisions),
                payloadBytes: _intOrNull(value.payloadBytes),
            };
        }

        return {
            generatedAtUtc: typeof response.generatedAtUtc === 'string'
                ? response.generatedAtUtc : null,
            documents: {
                active: _intOrNull(documents.active),
                recentlyDeleted: _intOrNull(documents.recentlyDeleted),
            },
            revisions: {
                count: _intOrNull(revisions.count),
                receiptCount: _intOrNull(revisions.receiptCount),
                receiptBytesEstimate: _intOrNull(revisions.receiptBytesEstimate),
            },
            storage: {
                logicalPayloadBytes: _intOrNull(storage.logicalPayloadBytes),
                allocatedDbBytes: _intOrNull(storage.allocatedDbBytes),
                reclaimableBytes: _intOrNull(storage.reclaimableBytes),
                walBytes: _intOrNull(storage.walBytes),
                shmBytes: _intOrNull(storage.shmBytes),
                dbFileBytes: _intOrNull(storage.dbFileBytes),
            },
            recent: {
                last7Days: _recentWindow('last7Days'),
                last30Days: _recentWindow('last30Days'),
            },
            archive: {
                archiveCount: _intOrNull(archive.archiveCount),
                sealedCount: _intOrNull(archive.sealedCount),
                missingCount: _intOrNull(archive.missingCount),
                fileBytes: _intOrNull(archive.fileBytes),
                logicalPayloadBytes: _intOrNull(archive.logicalPayloadBytes),
                revisionCount: _intOrNull(archive.revisionCount),
                lastVerifiedAtUtc: typeof archive.lastVerifiedAtUtc === 'string'
                    ? archive.lastVerifiedAtUtc : null,
                archiveIds: Array.isArray(archive.archiveIds)
                    ? archive.archiveIds.filter(
                        (id) => typeof id === 'string')
                    : [],
            },
            candidates: {
                oldRevisions: {
                    candidateCount: _intOrNull(oldRevisions.candidateCount),
                    candidateBytes: _intOrNull(oldRevisions.candidateBytes),
                    documentCount: _intOrNull(oldRevisions.documentCount),
                },
                expiredDeletedDocuments: {
                    documentCount: _intOrNull(expiredDeleted.documentCount),
                    revisionCount: _intOrNull(expiredDeleted.revisionCount),
                    payloadBytes: _intOrNull(expiredDeleted.payloadBytes),
                },
            },
        };
    }

    function normalizeJob(job) {
        if (!job || typeof job !== 'object' || typeof job.jobId !== 'string') {
            return null;
        }
        const terminal = ['completed', 'failed', 'interrupted', 'canceled'];
        const status = typeof job.status === 'string' ? job.status : 'unknown';
        return {
            jobId: job.jobId,
            jobType: typeof job.jobType === 'string' ? job.jobType : '',
            status,
            isTerminal: terminal.indexOf(status) !== -1,
            summary: (job.summary && typeof job.summary === 'object')
                ? job.summary : null,
            errorCode: typeof job.errorCode === 'string' ? job.errorCode : null,
        };
    }

    function connectionReducer(state, event) {
        if (CONNECTION_STATES.indexOf(state) === -1) {
            state = 'disconnected';
        }
        switch (event) {
            case 'socket-connecting':
                return 'connecting';
            case 'socket-open':
                return 'connected';
            case 'socket-closed':
                return 'disconnected';
            case 'status-unavailable':
                // Transport is up but the store refused; only meaningful
                // while connected.
                return state === 'connected' || state === 'unavailable'
                    ? 'unavailable' : state;
            case 'status-available':
                return state === 'unavailable' ? 'connected' : state;
            default:
                return state;
        }
    }

    function buttonAvailability(context) {
        const ctx = context || {};
        const capability = ctx.capability || {};
        const online = ctx.connection === 'connected'
            && ctx.storeAvailable === true;
        const idle = online && ctx.jobRunning !== true;
        return {
            refreshStats: online,
            exactStats: idle,
            previewArchive: idle && capability.archivePreview === true,
            // Execute needs the full chain: server capability, a live
            // preview, AND the exact confirmation phrase typed.
            executeArchive: idle
                && capability.archiveExecute === true
                && ctx.planReady === true
                && ctx.confirmationValid === true,
            // Cancel exists only in the safe copy/verify stage; once the
            // main-DB commit begins it is withdrawn (plan section 11).
            cancelJob: ctx.jobRunning === true
                && ctx.jobStage !== 'committing',
            reclaim: idle,
            restore: idle && capability.restore === true,
        };
    }

    function confirmationTemplate(totals) {
        const count = totals && _isCount(totals.revisionCount)
            ? totals.revisionCount : null;
        return count === null ? null : `ARCHIVE ${count} REVISIONS`;
    }

    function validateConfirmation(input, totals) {
        const expected = confirmationTemplate(totals);
        return expected !== null && typeof input === 'string'
            && input.trim() === expected;
    }

    function jobStage(job) {
        if (!job || job.isTerminal) {
            return null;
        }
        const summary = job.summary;
        return summary && typeof summary.stage === 'string'
            ? summary.stage : null;
    }

    const ERROR_GUIDANCE = Object.freeze({
        archive_plan_stale:
            'The workspace changed since the preview. Run Preview again.',
        archive_plan_expired:
            'The preview expired. Run Preview again.',
        archive_plan_already_consumed:
            'This preview was already executed; check the task list.',
        maintenance_busy:
            'Another maintenance task is running. Wait for it, then retry.',
        insufficient_disk_space:
            'Not enough free disk space for the archive copy plus the '
            + 'recovery snapshot. Free space, then retry.',
        archive_verification_failed:
            'The archive copy failed verification. Nothing was removed. '
            + 'Do not retry until the server log has been checked.',
        archive_conflict:
            'An existing archived copy conflicts with the current data. '
            + 'Nothing was removed; check the server log.',
        archive_corrupt:
            'An archive shard failed its integrity check. Nothing was '
            + 'removed; restore the shard from its static backup.',
        unsafe_reclaim_refused:
            'The freelist is below the reclaim threshold; there is nothing '
            + 'worth reclaiming yet.',
        archive_disabled:
            'Archiving is disabled in the configuration.',
        job_not_found:
            'That task is unknown to this backend; refresh the task list.',
        restore_conflict:
            'The document changed while restoring. Nothing was overwritten; '
            + 'retry the restore.',
        archive_not_found:
            'That archived record (or its shard) was not found. Verify the '
            + 'shard files and the registry.',
        revision_conflict:
            'The document changed while restoring. Nothing was overwritten; '
            + 'retry the restore.',
    });

    function errorGuidance(code) {
        return ERROR_GUIDANCE[code]
            || 'The request failed; see the server log for details.';
    }

    function normalizeArchivePreview(response) {
        if (!response || typeof response !== 'object'
            || response.success !== true
            || typeof response.planToken !== 'string') {
            return null;
        }
        const totals = response.totals || {};
        return {
            planToken: response.planToken,
            expiresInSeconds: _intOrNull(response.expiresInSeconds),
            totals: {
                revisionCount: _intOrNull(totals.revisionCount),
                payloadBytes: _intOrNull(totals.payloadBytes),
                oldRevisionCount: _intOrNull(totals.oldRevisionCount),
                deletedDocumentCount: _intOrNull(totals.deletedDocumentCount),
            },
            manifestHashPrefix:
                typeof response.manifestHashPrefix === 'string'
                    ? response.manifestHashPrefix : '',
        };
    }

    function normalizePagedList(response, itemsKey) {
        if (!response || typeof response !== 'object'
            || response.success !== true
            || !Array.isArray(response[itemsKey])) {
            return null;
        }
        return {
            page: _intOrNull(response.page) || 1,
            pageSize: _intOrNull(response.pageSize) || 25,
            total: _intOrNull(response.total),
            items: response[itemsKey],
        };
    }

    globalScope.OptionComboWorkspaceDbAdminCore = {
        ALLOWED_CLIENT_ACTIONS,
        CONNECTION_STATES,
        formatBytes,
        formatCount,
        normalizeAdminStatus,
        normalizeStorageStats,
        normalizeJob,
        normalizeArchivePreview,
        normalizePagedList,
        connectionReducer,
        buttonAvailability,
        confirmationTemplate,
        validateConfirmation,
        jobStage,
        errorGuidance,
    };
})(typeof window !== 'undefined' ? window : globalThis);
