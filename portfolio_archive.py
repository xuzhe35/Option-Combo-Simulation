"""Archive layer for the workspace database admin page.

Two halves (see CODE PLAN/PORTFOLIO_DATABASE_ADMIN_PAGE_PLAN.md):

1. Pure, deterministic candidate rules and the frozen storage-metric
   vocabulary (phase 0). These take injected clocks and never read payload
   business fields: an expired option inside a payload never makes its
   document a candidate.
2. The archive shard machinery (phase 3): shard schema and rollover, safe
   archive-id -> path resolution, preview manifests with generation
   fingerprints, the copy-only batch executor with writer fencing and
   verification, and dead-batch cleanup. In this phase NOTHING is ever
   deleted from the active database — the executor stops at `verified`.

Copy jobs run on worker threads under the cross-process maintenance guard
(portfolio_maintenance.py); every shard write transaction re-checks the
writer fence so a superseded process cannot keep writing.
"""

import hashlib
import json
import os
import re
import shutil
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from portfolio_store import (
    DatabaseCorruptError,
    MAINTENANCE_BACKUP_DIRNAME,
    PortfolioStoreError,
    SCHEMA_USER_VERSION,
)

# ---------------------------------------------------------------------------
# Defaults (config keys live under [portfolio_store]; the retention and
# vacuum keys are the EXISTING ones — archival must not grow a second set of
# truth for them). Auto-run stays off until the manual flow has survived a
# release cycle (plan section 8.4).
# ---------------------------------------------------------------------------

DEFAULT_ARCHIVE_ENABLED = True
DEFAULT_ARCHIVE_AUTO_RUN = False
DEFAULT_ARCHIVE_DELETED_AFTER_DAYS = 30
DEFAULT_ARCHIVE_MAX_ROWS_PER_BATCH = 500
DEFAULT_ARCHIVE_MAX_PAYLOAD_BYTES_PER_BATCH = 64 * 1024 * 1024
DEFAULT_ARCHIVE_COMMIT_MAX_ROWS = 25
DEFAULT_ARCHIVE_COMMIT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
DEFAULT_ARCHIVE_ROLLOVER_BYTES = 2 * 1024 * 1024 * 1024
DEFAULT_ARCHIVE_PLAN_TTL_SECONDS = 900
DEFAULT_RECOVERY_SNAPSHOT_KEEP = 5
DEFAULT_RECOVERY_SNAPSHOT_KEEP_DAYS = 14
DEFAULT_RECOVERY_SNAPSHOT_REUSE_SECONDS = 900
DEFAULT_MAINTENANCE_LEASE_TTL_SECONDS = 60
DEFAULT_MAINTENANCE_LEASE_HEARTBEAT_SECONDS = 15

# ---------------------------------------------------------------------------
# Frozen storage-metric vocabulary (plan section 3.3 / phase 0 item 4).
# Every stats response, candidate preview, and manifest uses these names and
# formulas; the admin page must never blur logical, allocated, reclaimable,
# and on-disk sizes into one number.
# ---------------------------------------------------------------------------

# Canonical UTF-8 byte count of a TEXT payload column. SQLite length() on
# TEXT counts characters, which under-reports multi-byte content; the CAST
# forces byte semantics. This is the only sanctioned backfill formula for
# workspace_revisions.payload_bytes.
PAYLOAD_BYTES_SQL = 'length(CAST(payload_json AS BLOB))'

STORAGE_METRIC_FORMULAS = {
    'logicalPayloadBytes': 'SUM(workspace_revisions.payload_bytes) over rows in the active DB',
    'allocatedDbBytes': 'PRAGMA page_count * PRAGMA page_size',
    'reclaimableBytes': 'PRAGMA freelist_count * PRAGMA page_size',
    'walBytes': 'size of <db>-wal on disk, 0 when absent',
    'shmBytes': 'size of <db>-shm on disk, 0 when absent',
    'dbFileBytes': 'size of <db> on disk',
}


def assemble_storage_metrics(*, page_count, page_size, freelist_count,
                             logical_payload_bytes, db_file_bytes,
                             wal_bytes=0, shm_bytes=0):
    """Assemble the frozen metric dict from raw PRAGMA / stat inputs.

    Missing inputs must be surfaced as None by the caller ("unavailable"),
    never coerced to 0 — 0 is a measurement, not an error state."""
    def _int_or_none(value):
        return None if value is None else int(value)

    page_count = _int_or_none(page_count)
    page_size = _int_or_none(page_size)
    freelist_count = _int_or_none(freelist_count)
    return {
        'logicalPayloadBytes': _int_or_none(logical_payload_bytes),
        'allocatedDbBytes': (
            None if page_count is None or page_size is None
            else page_count * page_size
        ),
        'reclaimableBytes': (
            None if freelist_count is None or page_size is None
            else freelist_count * page_size
        ),
        'walBytes': _int_or_none(wal_bytes),
        'shmBytes': _int_or_none(shm_bytes),
        'dbFileBytes': _int_or_none(db_file_bytes),
    }


# ---------------------------------------------------------------------------
# Candidate rules
# ---------------------------------------------------------------------------

def _parse_utc(value, field):
    if not isinstance(value, str) or not value:
        raise ValueError(f'{field} must be a non-empty ISO-8601 UTC string')
    text = value[:-1] + '+00:00' if value.endswith('Z') else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f'{field} is not ISO-8601: {value!r}') from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _normalized_now(now):
    if not isinstance(now, datetime):
        raise ValueError('now must be a datetime')
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(timezone.utc)


def compute_revision_candidates(revisions, *, current_revision,
                                keep_recent=None, keep_daily_days=None, now):
    """Split one live document's revisions into keep / archive-candidate sets.

    `revisions` is an iterable of dicts with at least `revision` (int) and
    `savedAtUtc` (ISO UTC string); extra keys (hash, bytes) pass through
    untouched so callers can build manifests from the result. The keep rule
    is intentionally identical to PortfolioStore._prune_document:

    - the current revision is ALWAYS kept (hard invariant, checked first);
    - the most recent `keep_recent` revisions (by revision number) are kept;
    - beyond those, the last save of each UTC day is kept while that day is
      on or after `now - keep_daily_days`;
    - everything else is a candidate.

    Deterministic: same inputs, same output, no wall clock. Raises ValueError
    when `current_revision` is missing from `revisions` — that is corruption,
    not a policy decision.
    """
    # Mirror the store's clamps exactly so rule parity is provable.
    keep_recent = max(1, int(keep_recent if keep_recent is not None
                             else _default_keep_recent()))
    keep_daily_days = max(0, int(keep_daily_days if keep_daily_days is not None
                                 else _default_keep_daily_days()))
    now = _normalized_now(now)
    current_revision = int(current_revision)

    rows = []
    seen = set()
    for entry in revisions:
        revision = int(entry['revision'])
        if revision in seen:
            raise ValueError(f'duplicate revision {revision}')
        seen.add(revision)
        _parse_utc(entry['savedAtUtc'], 'savedAtUtc')  # validate early
        rows.append(dict(entry, revision=revision))
    if current_revision not in seen:
        raise ValueError(
            f'current revision {current_revision} is missing from revisions'
        )

    rows.sort(key=lambda row: row['revision'], reverse=True)
    cutoff_date = (now - timedelta(days=keep_daily_days)).date().isoformat()

    keep_reasons = {current_revision: 'current'}
    for row in rows[:keep_recent]:
        keep_reasons.setdefault(row['revision'], 'recent')
    last_per_day = {}
    for row in rows[keep_recent:]:
        day = row['savedAtUtc'][:10]
        if day >= cutoff_date:
            existing = last_per_day.get(day)
            if existing is None or row['revision'] > existing:
                last_per_day[day] = row['revision']
    for revision in last_per_day.values():
        keep_reasons.setdefault(revision, 'daily_anchor')

    kept, candidates = [], []
    for row in rows:
        reason = keep_reasons.get(row['revision'])
        if reason is not None:
            kept.append(dict(row, reason=reason))
        else:
            candidates.append(dict(row, reason='beyond_retention'))
    return {'kept': kept, 'candidates': candidates}


def compute_deleted_document_candidates(documents, *,
                                        archive_deleted_after_days=DEFAULT_ARCHIVE_DELETED_AFTER_DAYS,
                                        now):
    """Split documents into whole-document archive candidates and kept docs.

    A document is a candidate if and only if it is soft-deleted and STRICTLY
    more than `archive_deleted_after_days` days have elapsed since
    `deletedAtUtc` — at exactly the boundary it is still inside the grace
    period. Live documents are never candidates here regardless of any
    payload content (expiry dates are business data, not lifecycle data).
    """
    grace = timedelta(days=max(0, int(archive_deleted_after_days)))
    now = _normalized_now(now)

    kept, candidates = [], []
    seen = set()
    for entry in documents:
        document_id = entry['documentId']
        if document_id in seen:
            raise ValueError(f'duplicate documentId {document_id}')
        seen.add(document_id)
        deleted_at = entry.get('deletedAtUtc')
        if deleted_at is None:
            kept.append(dict(entry, reason='not_deleted'))
            continue
        deleted_at_parsed = _parse_utc(deleted_at, 'deletedAtUtc')
        if now - deleted_at_parsed > grace:
            candidates.append(dict(entry, reason='grace_elapsed'))
        else:
            kept.append(dict(entry, reason='grace_period'))
    return {'kept': kept, 'candidates': candidates}


def _default_keep_recent():
    from portfolio_store import DEFAULT_REVISION_KEEP_RECENT
    return DEFAULT_REVISION_KEEP_RECENT


def _default_keep_daily_days():
    from portfolio_store import DEFAULT_REVISION_KEEP_DAILY_DAYS
    return DEFAULT_REVISION_KEEP_DAILY_DAYS


# ===========================================================================
# Phase 3: archive shards and the copy-only batch executor
# ===========================================================================

ARCHIVE_SCHEMA_VERSION = 1
ARCHIVE_DIRNAME = 'archives'
ARCHIVE_ID_RE = re.compile(r'^portfolio-archive-(\d{4})-(\d{3})$')
_WRITER_FENCE_NAME = 'writer'

# Free-space precheck margin on top of "archive copy + recovery snapshot".
DISK_SPACE_MARGIN_BYTES = 64 * 1024 * 1024

# Test seam: fault-injection tests replace this to simulate a full disk.
_disk_usage = shutil.disk_usage


class ArchiveError(PortfolioStoreError):
    code = 'archive_copy_failed'


class ArchiveConflictError(ArchiveError):
    code = 'archive_conflict'


class ArchivePlanStaleError(ArchiveError):
    code = 'archive_plan_stale'


class ArchiveVerificationError(ArchiveError):
    code = 'archive_verification_failed'


class ArchiveNotFoundError(ArchiveError):
    code = 'archive_not_found'


class InsufficientDiskSpaceError(ArchiveError):
    code = 'insufficient_disk_space'


class MaintenanceLeaseLostError(ArchiveError):
    code = 'maintenance_busy'


_ARCHIVE_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE archive_meta (
        archive_id              TEXT NOT NULL,
        archive_schema_version  INTEGER NOT NULL,
        source_install_id       TEXT NOT NULL,
        created_at_utc          TEXT NOT NULL,
        sealed_at_utc           TEXT,
        part_year               INTEGER NOT NULL,
        part_number             INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE archive_batches (
        batch_id                  TEXT PRIMARY KEY,
        status                    TEXT NOT NULL CHECK (status IN (
            'copying', 'copied', 'verified', 'main_committed',
            'cancel_requested', 'cleanup_pending', 'canceled', 'failed')),
        owner_server_instance_id  TEXT,
        lease_fencing_token       INTEGER,
        policy_json               TEXT NOT NULL,
        preview_fingerprint       TEXT NOT NULL,
        document_count            INTEGER NOT NULL DEFAULT 0,
        revision_count            INTEGER NOT NULL DEFAULT 0,
        payload_bytes             INTEGER NOT NULL DEFAULT 0,
        manifest_sha256           TEXT,
        source_schema_version     INTEGER NOT NULL,
        created_at_utc            TEXT NOT NULL,
        verified_at_utc           TEXT,
        committed_at_utc          TEXT
    )
    """,
    """
    CREATE TABLE archived_documents (
        document_id       TEXT NOT NULL,
        archive_batch_id  TEXT NOT NULL,
        archive_kind      TEXT NOT NULL CHECK (archive_kind IN (
            'partial_history', 'deleted_document')),
        title             TEXT NOT NULL,
        symbol            TEXT NOT NULL,
        market_data_mode  TEXT NOT NULL,
        last_revision     INTEGER,
        deleted_at_utc    TEXT,
        PRIMARY KEY (document_id, archive_batch_id)
    )
    """,
    """
    CREATE TABLE archived_revisions (
        document_id             TEXT NOT NULL,
        revision                INTEGER NOT NULL,
        save_token              TEXT NOT NULL UNIQUE,
        payload_schema_version  INTEGER NOT NULL,
        payload_sha256          TEXT NOT NULL,
        payload_json            TEXT NOT NULL,
        saved_at_utc            TEXT NOT NULL,
        payload_bytes           INTEGER NOT NULL,
        archive_batch_id        TEXT NOT NULL,
        archived_at_utc         TEXT NOT NULL,
        PRIMARY KEY (document_id, revision)
    )
    """,
    """
    CREATE INDEX idx_archived_revisions_batch
        ON archived_revisions(archive_batch_id)
    """,
    """
    CREATE TABLE archive_writer_fence (
        fence_name          TEXT PRIMARY KEY,
        main_fencing_token  INTEGER NOT NULL,
        server_instance_id  TEXT NOT NULL,
        updated_at_utc      TEXT NOT NULL
    )
    """,
)

# Batch states whose rows are trustworthy: safe replay may only reuse rows
# belonging to these batches; everything else is dead weight to clean up.
_GOOD_BATCH_STATES = ('copied', 'verified', 'main_committed')


def resolve_archive_dir(db_path, config=None, env=None):
    """OPTION_COMBO_PORTFOLIO_ARCHIVE_DIR > config archive_dir > sibling
    `archives/` next to the active database (same local app-data volume)."""
    env = env if env is not None else os.environ
    explicit = (env.get('OPTION_COMBO_PORTFOLIO_ARCHIVE_DIR') or '').strip()
    if explicit:
        return Path(explicit)
    if config is not None:
        configured = (config.get('portfolio_store', 'archive_dir',
                                 fallback='') or '').strip()
        if configured:
            return Path(configured)
    return Path(db_path).parent / ARCHIVE_DIRNAME


def archive_path_for_id(archive_dir, archive_id):
    """Resolve an archive id to its shard path. The id must match the strict
    pattern and the resolved path must stay inside archive_dir — `..`,
    absolute paths, and symlink escapes are structurally impossible."""
    if not isinstance(archive_id, str) or not ARCHIVE_ID_RE.match(archive_id):
        raise ArchiveNotFoundError('unknown archive id format')
    base = Path(archive_dir)
    candidate = base / f'{archive_id}.db'
    # Compare fully-resolved forms so symlinked shard files cannot escape,
    # while the returned path keeps the caller's directory spelling.
    if candidate.resolve().parent != base.resolve():
        raise ArchiveNotFoundError('archive path escapes the archive directory')
    return candidate


class ArchiveShard:
    """One archive shard database. Mirrors PortfolioStore's connection
    hygiene; every operation opens and closes its own connection."""

    def __init__(self, path, *, now=None):
        self._path = Path(path)
        self._now = now or (lambda: datetime.now(timezone.utc))

    @property
    def path(self):
        return self._path

    def _now_iso(self):
        now = self._now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        return now.astimezone(timezone.utc).isoformat(
            timespec='milliseconds'
        ).replace('+00:00', 'Z')

    def _connect(self):
        conn = None
        try:
            conn = sqlite3.connect(self._path, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA journal_mode = WAL')
            conn.execute('PRAGMA synchronous = FULL')
            conn.execute('PRAGMA busy_timeout = 5000')
            return conn
        except sqlite3.Error as exc:
            if conn is not None:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass
            raise ArchiveError(f'cannot open archive shard: {exc}') from exc

    def create(self, *, archive_id, source_install_id, part_year, part_number):
        if self._path.exists():
            raise ArchiveError('archive shard already exists; refusing to recreate')
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = None
        try:
            conn = sqlite3.connect(self._path, isolation_level=None)
            conn.execute('PRAGMA auto_vacuum = INCREMENTAL')
            conn.execute('PRAGMA journal_mode = WAL')
            conn.execute('PRAGMA synchronous = FULL')
            conn.execute('BEGIN IMMEDIATE')
            for statement in _ARCHIVE_SCHEMA_STATEMENTS:
                conn.execute(statement)
            conn.execute(
                'INSERT INTO archive_meta (archive_id, archive_schema_version, '
                'source_install_id, created_at_utc, sealed_at_utc, part_year, '
                'part_number) VALUES (?, ?, ?, ?, NULL, ?, ?)',
                (archive_id, ARCHIVE_SCHEMA_VERSION, source_install_id,
                 self._now_iso(), int(part_year), int(part_number)),
            )
            conn.execute(f'PRAGMA user_version = {ARCHIVE_SCHEMA_VERSION}')
            conn.execute('COMMIT')
        except sqlite3.Error as exc:
            if conn is not None and conn.in_transaction:
                conn.execute('ROLLBACK')
            raise ArchiveError(f'archive shard creation failed: {exc}') from exc
        finally:
            if conn is not None:
                conn.close()
        return self

    def quick_check(self):
        conn = self._connect()
        try:
            row = conn.execute('PRAGMA quick_check').fetchone()
            if row is None or row[0] != 'ok':
                raise DatabaseCorruptError(
                    f'archive quick_check reported: {row[0] if row else "none"}'
                )
            return 'ok'
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()

    def backup_to(self, dest_path):
        """Consistent online snapshot via the SQLite backup API, then
        quick_check the copy. Never a raw file copy of a live WAL shard."""
        dest = Path(dest_path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        src = self._connect()
        try:
            dst = sqlite3.connect(dest)
            try:
                src.backup(dst)
            finally:
                dst.close()
        except sqlite3.Error as exc:
            raise ArchiveError(f'archive backup failed: {exc}') from exc
        finally:
            src.close()
        ArchiveShard(dest).quick_check()
        return dest

    def meta(self):
        conn = self._connect()
        try:
            row = conn.execute('SELECT * FROM archive_meta').fetchone()
            if row is None:
                raise DatabaseCorruptError('archive shard has no meta row')
            return dict(row)
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()

    def seal(self):
        conn = self._connect()
        try:
            conn.execute(
                'UPDATE archive_meta SET sealed_at_utc = ? '
                'WHERE sealed_at_utc IS NULL', (self._now_iso(),),
            )
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()

    def raise_writer_fence(self, *, instance_id, fencing_token):
        """Claim write access for this main-DB fencing token. A holder with
        a NEWER token has already superseded us: refuse."""
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                row = conn.execute(
                    'SELECT main_fencing_token FROM archive_writer_fence '
                    'WHERE fence_name = ?', (_WRITER_FENCE_NAME,),
                ).fetchone()
                if row is not None and row['main_fencing_token'] > int(fencing_token):
                    raise MaintenanceLeaseLostError(
                        'archive shard is fenced by a newer maintenance holder'
                    )
                conn.execute(
                    'INSERT INTO archive_writer_fence (fence_name, '
                    'main_fencing_token, server_instance_id, updated_at_utc) '
                    'VALUES (?, ?, ?, ?) '
                    'ON CONFLICT(fence_name) DO UPDATE SET '
                    'main_fencing_token = excluded.main_fencing_token, '
                    'server_instance_id = excluded.server_instance_id, '
                    'updated_at_utc = excluded.updated_at_utc',
                    (_WRITER_FENCE_NAME, int(fencing_token), instance_id,
                     self._now_iso()),
                )
                conn.execute('COMMIT')
            except BaseException:
                if conn.in_transaction:
                    conn.execute('ROLLBACK')
                raise
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()

    @staticmethod
    def _check_fence(conn, instance_id, fencing_token):
        row = conn.execute(
            'SELECT main_fencing_token, server_instance_id '
            'FROM archive_writer_fence WHERE fence_name = ?',
            (_WRITER_FENCE_NAME,),
        ).fetchone()
        if row is None or row['main_fencing_token'] != int(fencing_token) \
                or row['server_instance_id'] != instance_id:
            raise MaintenanceLeaseLostError(
                'archive writer fence no longer belongs to this worker'
            )

    def cleanup_dead_batches(self):
        """Purge payload rows of every batch that is not in a good state.
        The batch row survives as an audit stub (status failed/canceled);
        its rows never count in stats and are never reused by safe replay.
        Only callable before sealing."""
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                sealed = conn.execute(
                    'SELECT sealed_at_utc FROM archive_meta'
                ).fetchone()
                if sealed is not None and sealed['sealed_at_utc'] is not None:
                    raise ArchiveError('cannot clean a sealed archive shard')
                dead = [
                    row['batch_id'] for row in conn.execute(
                        'SELECT batch_id FROM archive_batches '
                        'WHERE status NOT IN (?, ?, ?)', _GOOD_BATCH_STATES,
                    )
                ]
                for batch_id in dead:
                    conn.execute(
                        "UPDATE archive_batches SET status = 'cleanup_pending' "
                        'WHERE batch_id = ?', (batch_id,),
                    )
                    conn.execute(
                        'DELETE FROM archived_revisions '
                        'WHERE archive_batch_id = ?', (batch_id,),
                    )
                    conn.execute(
                        'DELETE FROM archived_documents '
                        'WHERE archive_batch_id = ?', (batch_id,),
                    )
                    conn.execute(
                        "UPDATE archive_batches SET status = 'failed', "
                        'document_count = 0, revision_count = 0, '
                        'payload_bytes = 0 WHERE batch_id = ?', (batch_id,),
                    )
                conn.execute('COMMIT')
            except BaseException:
                if conn.in_transaction:
                    conn.execute('ROLLBACK')
                raise
            return dead
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()

    def copy_batch(self, *, batch_id, kind_rows, documents, policy,
                   fingerprint, instance_id, fencing_token,
                   source_schema_version=SCHEMA_USER_VERSION):
        """Insert one batch atomically: batch row, documents, revisions.

        `kind_rows` is a list of dicts with documentId, revision, saveToken,
        payloadSchemaVersion, payloadSha256, payloadJson, savedAtUtc,
        payloadBytes. Idempotent replay: an existing (document, revision)
        with identical sha+bytes in a GOOD batch is skipped; any mismatch
        aborts the whole batch with archive_conflict."""
        now_iso = self._now_iso()
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                self._check_fence(conn, instance_id, fencing_token)
                to_insert = []
                for row in kind_rows:
                    existing = conn.execute(
                        'SELECT r.payload_sha256, r.payload_bytes, b.status '
                        'FROM archived_revisions r '
                        'JOIN archive_batches b ON b.batch_id = r.archive_batch_id '
                        'WHERE r.document_id = ? AND r.revision = ?',
                        (row['documentId'], row['revision']),
                    ).fetchone()
                    if existing is not None:
                        if (existing['payload_sha256'] == row['payloadSha256']
                                and existing['payload_bytes'] == row['payloadBytes']
                                and existing['status'] in _GOOD_BATCH_STATES):
                            continue  # safe replay of an earlier good copy
                        raise ArchiveConflictError(
                            f'archived revision {row["documentId"]}#'
                            f'{row["revision"]} conflicts with an existing copy'
                        )
                    to_insert.append(row)
                if not to_insert:
                    # Every row already lives in a good batch: no new batch
                    # row — a batch only ever describes rows it physically
                    # owns, which is what commit and cleanup operate on.
                    conn.execute('ROLLBACK')
                    return {'insertedRows': 0, 'insertedBytes': 0,
                            'batchCreated': False}
                for row in to_insert:
                    try:
                        conn.execute(
                            'INSERT INTO archived_revisions (document_id, '
                            'revision, save_token, payload_schema_version, '
                            'payload_sha256, payload_json, saved_at_utc, '
                            'payload_bytes, archive_batch_id, archived_at_utc) '
                            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                            (row['documentId'], row['revision'],
                             row['saveToken'], row['payloadSchemaVersion'],
                             row['payloadSha256'], row['payloadJson'],
                             row['savedAtUtc'], row['payloadBytes'],
                             batch_id, now_iso),
                        )
                    except sqlite3.IntegrityError as exc:
                        raise ArchiveConflictError(
                            f'archive uniqueness violated: {exc}'
                        ) from exc
                inserted_docs = {row['documentId'] for row in to_insert}
                batch_documents = [
                    doc for doc in documents
                    if doc['documentId'] in inserted_docs
                ]
                for doc in batch_documents:
                    conn.execute(
                        'INSERT OR REPLACE INTO archived_documents '
                        '(document_id, archive_batch_id, archive_kind, title, '
                        'symbol, market_data_mode, last_revision, '
                        'deleted_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        (doc['documentId'], batch_id, doc['archiveKind'],
                         doc['title'], doc['symbol'], doc['marketDataMode'],
                         doc.get('lastRevision'), doc.get('deletedAtUtc')),
                    )
                manifest_sha = _manifest_hash(to_insert)
                conn.execute(
                    'INSERT INTO archive_batches (batch_id, status, '
                    'owner_server_instance_id, lease_fencing_token, '
                    'policy_json, preview_fingerprint, document_count, '
                    'revision_count, payload_bytes, manifest_sha256, '
                    'source_schema_version, created_at_utc) '
                    "VALUES (?, 'copied', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (batch_id, instance_id, int(fencing_token),
                     json.dumps(policy, sort_keys=True), fingerprint,
                     len(batch_documents), len(to_insert),
                     sum(row['payloadBytes'] for row in to_insert),
                     manifest_sha, int(source_schema_version), now_iso),
                )
                conn.execute('COMMIT')
            except BaseException:
                if conn.in_transaction:
                    conn.execute('ROLLBACK')
                raise
            return {
                'insertedRows': len(to_insert),
                'insertedBytes': sum(row['payloadBytes'] for row in to_insert),
                'batchCreated': True,
            }
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()

    def verify_batch(self, batch_id, expected_rows):
        """Re-read every batch row and verify sha/bytes/counts against the
        expected manifest rows, then mark the batch verified."""
        expected_by_key = {
            (row['documentId'], row['revision']): row for row in expected_rows
        }
        conn = self._connect()
        try:
            batch = conn.execute(
                'SELECT * FROM archive_batches WHERE batch_id = ?', (batch_id,),
            ).fetchone()
            if batch is None:
                raise ArchiveVerificationError(f'batch {batch_id} missing')
            stored = conn.execute(
                'SELECT document_id, revision, payload_sha256, payload_json, '
                'payload_bytes FROM archived_revisions '
                'WHERE archive_batch_id = ?', (batch_id,),
            ).fetchall()
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()

        seen = set()
        for row in stored:
            key = (row['document_id'], row['revision'])
            expected = expected_by_key.get(key)
            if expected is None:
                raise ArchiveVerificationError(
                    f'unexpected archived row {key} in batch {batch_id}'
                )
            recomputed = hashlib.sha256(
                row['payload_json'].encode('utf-8')
            ).hexdigest()
            byte_len = len(row['payload_json'].encode('utf-8'))
            if (recomputed != expected['payloadSha256']
                    or row['payload_sha256'] != expected['payloadSha256']
                    or byte_len != expected['payloadBytes']
                    or row['payload_bytes'] != expected['payloadBytes']):
                raise ArchiveVerificationError(
                    f'payload mismatch for archived row {key}'
                )
            seen.add(key)
        # Rows satisfied by safe replay live in an earlier good batch; check
        # them there rather than assuming this batch holds every row.
        missing = set(expected_by_key) - seen
        if missing:
            conn = self._connect()
            try:
                for key in missing:
                    other = conn.execute(
                        'SELECT payload_sha256, payload_bytes '
                        'FROM archived_revisions '
                        'WHERE document_id = ? AND revision = ?', key,
                    ).fetchone()
                    expected = expected_by_key[key]
                    if (other is None
                            or other['payload_sha256'] != expected['payloadSha256']
                            or other['payload_bytes'] != expected['payloadBytes']):
                        raise ArchiveVerificationError(
                            f'archived row {key} absent after copy'
                        )
            except sqlite3.Error as exc:
                raise ArchiveError(str(exc)) from exc
            finally:
                conn.close()

        conn = self._connect()
        try:
            conn.execute(
                "UPDATE archive_batches SET status = 'verified', "
                'verified_at_utc = ? WHERE batch_id = ?',
                (self._now_iso(), batch_id),
            )
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()

    def list_batches(self, statuses):
        conn = self._connect()
        try:
            placeholders = ','.join('?' for _ in statuses)
            return [
                dict(row) for row in conn.execute(
                    f'SELECT * FROM archive_batches WHERE status IN '
                    f'({placeholders}) ORDER BY created_at_utc',
                    tuple(statuses),
                )
            ]
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()

    def batch_rows(self, batch_id):
        """Row metadata (no payloads) plus document kinds for one batch."""
        conn = self._connect()
        try:
            rows = [
                {
                    'documentId': row['document_id'],
                    'revision': row['revision'],
                    'saveToken': row['save_token'],
                    'payloadSha256': row['payload_sha256'],
                    'payloadBytes': row['payload_bytes'],
                    'savedAtUtc': row['saved_at_utc'],
                }
                for row in conn.execute(
                    'SELECT document_id, revision, save_token, '
                    'payload_sha256, payload_bytes, saved_at_utc '
                    'FROM archived_revisions WHERE archive_batch_id = ? '
                    'ORDER BY document_id, revision', (batch_id,),
                )
            ]
            documents = {
                row['document_id']: {
                    'archiveKind': row['archive_kind'],
                    'title': row['title'],
                    'symbol': row['symbol'],
                    'marketDataMode': row['market_data_mode'],
                    'lastRevision': row['last_revision'],
                    'deletedAtUtc': row['deleted_at_utc'],
                }
                for row in conn.execute(
                    'SELECT * FROM archived_documents '
                    'WHERE archive_batch_id = ?', (batch_id,),
                )
            }
            return {'rows': rows, 'documents': documents}
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()

    def mark_batch_committed(self, batch_id):
        conn = self._connect()
        try:
            conn.execute(
                "UPDATE archive_batches SET status = 'main_committed', "
                'committed_at_utc = ? '
                "WHERE batch_id = ? AND status = 'verified'",
                (self._now_iso(), batch_id),
            )
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()

    def fetch_revision(self, document_id, revision):
        """One archived revision row (payload included), or None. Only rows
        belonging to GOOD batches are served — dead-batch remnants are
        invisible to restore."""
        conn = self._connect()
        try:
            row = conn.execute(
                'SELECT r.* FROM archived_revisions r '
                'JOIN archive_batches b ON b.batch_id = r.archive_batch_id '
                'WHERE r.document_id = ? AND r.revision = ? '
                'AND b.status IN (?, ?, ?)',
                (document_id, int(revision), *_GOOD_BATCH_STATES),
            ).fetchone()
            return dict(row) if row is not None else None
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()

    def stats(self):
        """Counts and logical bytes over GOOD batches only."""
        conn = self._connect()
        try:
            row = conn.execute(
                'SELECT count(*) AS revision_count, '
                'COALESCE(SUM(r.payload_bytes), 0) AS payload_bytes '
                'FROM archived_revisions r '
                'JOIN archive_batches b ON b.batch_id = r.archive_batch_id '
                'WHERE b.status IN (?, ?, ?)', _GOOD_BATCH_STATES,
            ).fetchone()
            return {
                'revisionCount': row['revision_count'],
                'logicalPayloadBytes': row['payload_bytes'],
            }
        except sqlite3.Error as exc:
            raise ArchiveError(str(exc)) from exc
        finally:
            conn.close()


def _manifest_hash(rows):
    canonical = json.dumps(
        sorted(
            [
                [row['documentId'], row['revision'], row['payloadSha256'],
                 row['payloadBytes'], row['savedAtUtc']]
                for row in rows
            ],
        ),
        sort_keys=True, separators=(',', ':'),
    )
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


# ---------------------------------------------------------------------------
# Preview manifests and generation fingerprints
# ---------------------------------------------------------------------------

def build_archive_preview(store, *, policy, now=None):
    """Compute the full candidate manifest plus the generation fingerprint
    inputs. Deterministic given the database contents and `now`."""
    now = now if now is not None else store.now_utc()
    snapshot = store.retention_snapshot()

    old_revision_rows = []
    document_states = {}
    for doc in snapshot['liveDocuments']:
        document_states[doc['documentId']] = {
            'currentRevision': doc['currentRevision'],
            'deletedAtUtc': None,
        }
        if not doc['revisions']:
            continue
        result = compute_revision_candidates(
            doc['revisions'],
            current_revision=doc['currentRevision'],
            keep_recent=policy['revisionKeepRecent'],
            keep_daily_days=policy['revisionKeepDailyDays'],
            now=now,
        )
        for row in result['candidates']:
            old_revision_rows.append({
                'documentId': doc['documentId'],
                'revision': row['revision'],
                'savedAtUtc': row['savedAtUtc'],
                'payloadBytes': row['payloadBytes'],
                'payloadSha256': row['payloadSha256'],
                'reason': row['reason'],
            })

    deleted_result = compute_deleted_document_candidates(
        snapshot['deletedDocuments'],
        archive_deleted_after_days=policy['archiveDeletedAfterDays'],
        now=now,
    )
    deleted_documents = []
    for doc in snapshot['deletedDocuments']:
        document_states[doc['documentId']] = {
            'currentRevision': doc['currentRevision'],
            'deletedAtUtc': doc['deletedAtUtc'],
        }
    for doc in deleted_result['candidates']:
        deleted_documents.append({
            'documentId': doc['documentId'],
            'title': doc['title'],
            'symbol': doc['symbol'],
            'marketDataMode': doc['marketDataMode'],
            'deletedAtUtc': doc['deletedAtUtc'],
            'lastRevision': doc['currentRevision'],
            'revisions': [
                {
                    'documentId': doc['documentId'],
                    'revision': row['revision'],
                    'savedAtUtc': row['savedAtUtc'],
                    'payloadBytes': row['payloadBytes'],
                    'payloadSha256': row['payloadSha256'],
                    'reason': 'deleted_document',
                }
                for row in doc['revisions']
            ],
        })

    document_meta = {}
    for doc in snapshot['liveDocuments'] + snapshot['deletedDocuments']:
        document_meta[doc['documentId']] = {
            'title': doc['title'],
            'symbol': doc['symbol'],
            'marketDataMode': doc['marketDataMode'],
            'currentRevision': doc['currentRevision'],
            'deletedAtUtc': doc['deletedAtUtc'],
        }

    all_rows = list(old_revision_rows)
    for doc in deleted_documents:
        all_rows.extend(doc['revisions'])
    manifest_hash = _manifest_hash(all_rows)
    return {
        'policy': dict(policy),
        'manifest': {
            'oldRevisions': old_revision_rows,
            'deletedDocuments': deleted_documents,
        },
        'manifestHash': manifest_hash,
        'documentStates': document_states,
        'documentMeta': document_meta,
        'totals': {
            'revisionCount': len(all_rows),
            'payloadBytes': sum(row['payloadBytes'] for row in all_rows),
            'oldRevisionCount': len(old_revision_rows),
            'deletedDocumentCount': len(deleted_documents),
        },
    }


def compute_generation_fingerprint(preview, *, install_id, created_at_utc,
                                   nonce):
    canonical = json.dumps({
        'installId': install_id,
        'schemaVersion': SCHEMA_USER_VERSION,
        'manifestHash': preview['manifestHash'],
        'documentStates': preview['documentStates'],
        'policy': preview['policy'],
        'createdAtUtc': created_at_utc,
        'nonce': nonce,
    }, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def split_into_batches(manifest, *, max_rows, max_payload_bytes):
    """Split the manifest into copy batches. Old revisions pack up to the
    caps; a whole deleted document never splits across batches — an
    oversized document gets its own batch (flagged oversized)."""
    max_rows = max(1, int(max_rows))
    max_payload_bytes = max(1, int(max_payload_bytes))
    batches = []
    current = {'rows': [], 'documents': {}, 'bytes': 0, 'oversized': False}

    def _flush():
        nonlocal current
        if current['rows']:
            batches.append(current)
        current = {'rows': [], 'documents': {}, 'bytes': 0, 'oversized': False}

    for row in manifest['oldRevisions']:
        row_cost = row['payloadBytes']
        if current['rows'] and (
                len(current['rows']) + 1 > max_rows
                or current['bytes'] + row_cost > max_payload_bytes):
            _flush()
        current['rows'].append(row)
        current['bytes'] += row_cost
        current['documents'].setdefault(row['documentId'], 'partial_history')

    for doc in manifest['deletedDocuments']:
        doc_rows = doc['revisions']
        doc_bytes = sum(row['payloadBytes'] for row in doc_rows)
        oversized = len(doc_rows) > max_rows or doc_bytes > max_payload_bytes
        fits = (not current['rows']) or (
            len(current['rows']) + len(doc_rows) <= max_rows
            and current['bytes'] + doc_bytes <= max_payload_bytes)
        if oversized or not fits:
            _flush()
        current['rows'].extend(doc_rows)
        current['bytes'] += doc_bytes
        current['documents'][doc['documentId']] = 'deleted_document'
        if oversized:
            current['oversized'] = True
            _flush()
    _flush()
    return batches


# ---------------------------------------------------------------------------
# Static shard backups (plan section 15)
# ---------------------------------------------------------------------------

def publish_archive_backups(store_env, backup_dir):
    """Publish verified static snapshots of every registered, present shard
    into `<backup_dir>/archives/`. File names carry the archive id AND the
    install id so two machines publishing into one synced folder never
    overwrite each other. Snapshots are produced with the SQLite backup
    API, quick-check verified locally, copied as an explicit `.partial`
    name, fsynced, then atomically renamed — sync software never sees a
    half-written file and the live shard WAL/SHM never leave this machine.

    Freshness: a shard republishes when no snapshot exists or when the
    shard (main file or its WAL) changed since the last publish. Must be
    called while holding the maintenance guard."""
    store = store_env['store']
    install_id = store.ensure_install_id()
    archive_dir = resolve_archive_dir(
        Path(store.db_path), config=store_env.get('_config')
    )
    target_dir = Path(backup_dir) / 'archives'
    published = []
    for row in store.list_archive_registry():
        try:
            path = archive_path_for_id(archive_dir, row['archive_id'])
        except ArchiveNotFoundError:
            continue
        if not path.exists():
            continue
        dest = target_dir / f"{row['archive_id']}-{install_id}.db"
        shard_mtime = path.stat().st_mtime
        wal = Path(str(path) + '-wal')
        if wal.exists():
            shard_mtime = max(shard_mtime, wal.stat().st_mtime)
        if dest.exists() and dest.stat().st_mtime >= shard_mtime:
            continue  # snapshot already covers the shard's current state

        shard = ArchiveShard(path, now=store.now_utc)
        nonce = uuid.uuid4().hex[:8]
        staging = path.parent / f'.archive-backup-{nonce}.db'
        try:
            shard.backup_to(staging)  # includes quick_check
            target_dir.mkdir(parents=True, exist_ok=True)
            partial = target_dir / f'{dest.name}.{nonce}.partial'
            with open(staging, 'rb') as src, open(partial, 'wb') as out:
                shutil.copyfileobj(src, out)
                out.flush()
                os.fsync(out.fileno())
            os.replace(partial, dest)
        finally:
            staging.unlink(missing_ok=True)
            Path(str(staging) + '-wal').unlink(missing_ok=True)
            Path(str(staging) + '-shm').unlink(missing_ok=True)
        published.append(dest.name)
    return published


# ---------------------------------------------------------------------------
# Standalone shard verification (plan sections 10.4 / 12)
# ---------------------------------------------------------------------------

def run_verify_job(store_env, guard, *, archive_id):
    """Full integrity verification of one registered shard, refreshing the
    registry either way: a missing file stamps missing_since_utc (so the
    overview's Missing count is active, not restore-time luck), a failed
    verification records last_verify_status='failed' before raising, and a
    clean pass refreshes sizes, counts, and the verified stamp. Unregistered
    files in the archive directory are reported as orphan candidates only —
    never adopted, never deleted."""
    store = store_env['store']
    registry = {
        row['archive_id']: row for row in store.list_archive_registry()
    }
    row = registry.get(archive_id)
    if row is None:
        raise ArchiveNotFoundError('archive shard is not registered')
    archive_dir = resolve_archive_dir(
        Path(store.db_path), config=store_env.get('_config')
    )
    path = archive_path_for_id(archive_dir, archive_id)
    now_iso = _iso(store.now_utc())

    def _registry_update(**overrides):
        store.upsert_archive_registry(
            archive_id=archive_id,
            archive_schema_version=row['archive_schema_version'],
            status=overrides.get('status', row['status']),
            created_at_utc=row['created_at_utc'],
            sealed_at_utc=overrides.get('sealed_at_utc', row['sealed_at_utc']),
            last_verified_at_utc=overrides.get('last_verified_at_utc',
                                               row['last_verified_at_utc']),
            last_verify_status=overrides.get('last_verify_status',
                                             row['last_verify_status']),
            file_bytes=overrides.get('file_bytes', row['file_bytes']),
            logical_payload_bytes=overrides.get('logical_payload_bytes',
                                                row['logical_payload_bytes']),
            revision_count=overrides.get('revision_count',
                                         row['revision_count']),
            missing_since_utc=overrides.get('missing_since_utc'),
        )

    orphans = sorted(
        candidate.name for candidate in archive_dir.glob('*.db')
        if candidate.stem not in registry
    ) if archive_dir.exists() else []

    if not path.exists():
        _registry_update(missing_since_utc=row['missing_since_utc'] or now_iso,
                         last_verify_status='missing')
        return {'archiveId': archive_id, 'status': 'missing',
                'orphanFiles': orphans}

    shard = ArchiveShard(path, now=store.now_utc)
    try:
        shard.quick_check()
        meta = shard.meta()
        if (meta['archive_schema_version'] != ARCHIVE_SCHEMA_VERSION
                or meta['archive_id'] != archive_id):
            raise ArchiveVerificationError(
                'archive meta does not match the registry entry'
            )
        verified_rows = 0
        verified_bytes = 0
        conn = shard._connect()
        try:
            for batch in conn.execute(
                'SELECT batch_id, revision_count, payload_bytes '
                'FROM archive_batches WHERE status IN (?, ?, ?)',
                _GOOD_BATCH_STATES,
            ).fetchall():
                actual = conn.execute(
                    'SELECT count(*) AS n, '
                    'COALESCE(SUM(payload_bytes), 0) AS b '
                    'FROM archived_revisions WHERE archive_batch_id = ?',
                    (batch['batch_id'],),
                ).fetchone()
                if (actual['n'] != batch['revision_count']
                        or actual['b'] != batch['payload_bytes']):
                    raise ArchiveVerificationError(
                        f'batch {batch["batch_id"]} counts do not match '
                        'its rows'
                    )
            for record in conn.execute(
                'SELECT r.document_id, r.revision, r.payload_sha256, '
                'r.payload_bytes, r.payload_json FROM archived_revisions r '
                'JOIN archive_batches b ON b.batch_id = r.archive_batch_id '
                'WHERE b.status IN (?, ?, ?)', _GOOD_BATCH_STATES,
            ):
                encoded = record['payload_json'].encode('utf-8')
                if (hashlib.sha256(encoded).hexdigest()
                        != record['payload_sha256']
                        or len(encoded) != record['payload_bytes']):
                    raise ArchiveVerificationError(
                        f'payload hash mismatch for '
                        f'{record["document_id"]}#{record["revision"]}'
                    )
                verified_rows += 1
                verified_bytes += record['payload_bytes']
        finally:
            conn.close()
    except PortfolioStoreError:
        _registry_update(last_verify_status='failed',
                         last_verified_at_utc=now_iso,
                         missing_since_utc=None)
        raise

    _registry_update(
        last_verify_status='ok', last_verified_at_utc=now_iso,
        file_bytes=os.stat(path).st_size,
        logical_payload_bytes=verified_bytes,
        revision_count=verified_rows,
        missing_since_utc=None,
    )
    return {
        'archiveId': archive_id,
        'status': 'ok',
        'verifiedRevisions': verified_rows,
        'verifiedBytes': verified_bytes,
        'orphanFiles': orphans,
    }


# ---------------------------------------------------------------------------
# Optional low-frequency auto-archive (plan section 8.4 / phase 7)
# ---------------------------------------------------------------------------

# After a failed auto run, no further auto attempt for this long. Manual
# archiving from the admin page is unaffected by the backoff.
AUTO_ARCHIVE_FAILURE_BACKOFF_SECONDS = 6 * 3600.0


def run_auto_archive(store_env, guard, *, now_monotonic):
    """One guarded auto-archive cycle, called from the scheduled maintenance
    pass while the guard is already held. Strictly opt-in
    (archive_auto_run=false by default), and defensive by construction:

    - a previous failure backs off further attempts for hours;
    - zero candidates is a silent no-op;
    - the executor's own disk-space precheck (copy + snapshot + margin) is
      the low-water protection — refusal fails the job, never a save;
    - a restart resumes copied/verified batches through the normal
      resume + reconciler path.

    Returns a small outcome dict for logging; never raises."""
    store = store_env.get('store')
    if store is None or store_env.get('_archive_enabled', True) is not True:
        return {'ran': False, 'reason': 'disabled'}
    if store_env.get('_archive_auto_run', False) is not True:
        return {'ran': False, 'reason': 'auto_run_off'}
    backoff_until = store_env.get('_auto_archive_backoff_until', 0.0)
    if now_monotonic < backoff_until:
        return {'ran': False, 'reason': 'backoff'}

    policy = {
        'revisionKeepRecent': store_env.get('_revision_keep_recent', 50),
        'revisionKeepDailyDays': store_env.get('_revision_keep_daily_days', 90),
        'archiveDeletedAfterDays': store_env.get(
            '_archive_deleted_after_days', 30),
    }
    job = None
    try:
        preview = build_archive_preview(store, policy=policy)
        if preview['totals']['revisionCount'] == 0:
            return {'ran': False, 'reason': 'no_candidates'}
        created_at = _iso(store.now_utc())
        preview['fingerprint'] = compute_generation_fingerprint(
            preview, install_id=store.ensure_install_id(),
            created_at_utc=created_at, nonce=uuid.uuid4().hex,
        )
        job = store.create_maintenance_job(
            job_type='archive_auto',
            requested_policy=policy,
            owner_instance_id=store_env.get('_server_instance_id'),
            owner_pid=os.getpid(),
        )
        store.start_maintenance_job(
            job['jobId'], fencing_token=guard.fencing_token
        )
        summary = run_archive_job(store_env, guard, job['jobId'], preview)
        store.finish_maintenance_job(
            job['jobId'], status='completed', summary=summary
        )
        return {'ran': True, 'jobId': job['jobId'],
                'removed': summary['commit']['removedRevisions']}
    except PortfolioStoreError as exc:
        store_env['_auto_archive_backoff_until'] = (
            now_monotonic + AUTO_ARCHIVE_FAILURE_BACKOFF_SECONDS
        )
        if job is not None:
            try:
                store.finish_maintenance_job(
                    job['jobId'], status='failed', error_code=exc.code,
                    error_message='auto archive failed; see server log',
                )
            except Exception:
                pass  # the backoff alone suffices
        return {'ran': False, 'reason': 'failed', 'errorCode': exc.code}
    except Exception:
        store_env['_auto_archive_backoff_until'] = (
            now_monotonic + AUTO_ARCHIVE_FAILURE_BACKOFF_SECONDS
        )
        return {'ran': False, 'reason': 'crashed'}


# ---------------------------------------------------------------------------
# Restore (plan section 13; phase 6)
# ---------------------------------------------------------------------------

class RestoreConflictError(ArchiveError):
    code = 'restore_conflict'


def _open_verified_shard(store_env, archive_id):
    """Locate a registered shard by id, quick-check it, return the shard.
    Every restore read passes through here — a corrupt or missing shard
    fails closed before any payload is trusted."""
    store = store_env['store']
    registry = {
        row['archive_id']: row for row in store.list_archive_registry()
    }
    if archive_id not in registry:
        raise ArchiveNotFoundError('archive shard is not registered')
    archive_dir = resolve_archive_dir(
        Path(store.db_path), config=store_env.get('_config')
    )
    path = archive_path_for_id(archive_dir, archive_id)
    if not path.exists():
        raise ArchiveNotFoundError('archive shard file is missing')
    shard = ArchiveShard(path, now=store.now_utc)
    shard.quick_check()
    return shard


def _verified_payload(row, *, expected_sha, expected_bytes):
    """Decode an archived payload only after hash, bytes, and schema all
    check out against BOTH the shard row and the main-DB expectation."""
    encoded = row['payload_json'].encode('utf-8')
    recomputed = hashlib.sha256(encoded).hexdigest()
    if (recomputed != expected_sha
            or row['payload_sha256'] != expected_sha
            or len(encoded) != expected_bytes
            or row['payload_bytes'] != expected_bytes):
        raise ArchiveVerificationError(
            'archived payload failed hash/bytes verification; refusing restore'
        )
    from portfolio_store import ACCEPTED_PAYLOAD_SCHEMA_VERSIONS
    if row['payload_schema_version'] not in ACCEPTED_PAYLOAD_SCHEMA_VERSIONS:
        raise ArchiveVerificationError(
            'archived payload schema version is not accepted; refusing restore'
        )
    try:
        return json.loads(row['payload_json'])
    except ValueError as exc:
        raise ArchiveVerificationError(
            'archived payload is not valid JSON; refusing restore'
        ) from exc


def restore_archived_revision(store_env, *, document_id, revision):
    """Copy an archived old revision forward as a NEW head revision of its
    live document, through the normal save path — optimistic concurrency,
    payload validation, and receipts all apply. History is never rewritten
    and the current pointer never moves backward."""
    from portfolio_store import RevisionConflictError

    store = store_env['store']
    entry = store.get_archive_entry(document_id, revision)
    if entry is None:
        raise ArchiveNotFoundError('no archive entry for that revision')
    shard = _open_verified_shard(store_env, entry['archive_id'])
    row = shard.fetch_revision(document_id, revision)
    if row is None:
        raise ArchiveNotFoundError('archived revision missing from its shard')
    payload = _verified_payload(
        row, expected_sha=entry['payload_sha256'],
        expected_bytes=entry['payload_bytes'],
    )

    meta = store.load_workspace(document_id)  # raises if deleted/missing
    save_token = f'restore-{uuid.uuid4().hex}'
    try:
        result = store.save_workspace(
            document_id=document_id,
            title=meta['title'],
            payload=payload,
            save_token=save_token,
            expected_revision=meta['revision'],
        )
    except RevisionConflictError as exc:
        raise RestoreConflictError(
            f'document changed while restoring: {exc}'
        ) from exc
    return {
        'mode': 'revision',
        'documentId': document_id,
        'sourceRevision': revision,
        'sourceArchiveId': entry['archive_id'],
        'restoredRevision': result['revision'],
        'payloadSha256': result['payloadSha256'],
    }


def restore_archived_document_as_copy(store_env, *, document_id):
    """Restore a whole archived (tombstoned) document as a NEW document:
    fresh document id, revision 1 from the archived last revision, title
    marked as a restore. The tombstone stays — the original identity
    remains reserved (Rehydrate Original is a later, stricter feature)."""
    store = store_env['store']
    tombstone = store.get_archive_tombstone(document_id)
    if tombstone is None:
        raise ArchiveNotFoundError('no tombstone for that document')
    shard = _open_verified_shard(store_env, tombstone['archive_id'])
    row = shard.fetch_revision(document_id, tombstone['last_revision'])
    if row is None:
        raise ArchiveNotFoundError('archived document missing from its shard')
    payload = _verified_payload(
        row, expected_sha=row['payload_sha256'],
        expected_bytes=row['payload_bytes'],
    )

    new_document_id = f'doc-restored-{uuid.uuid4().hex[:24]}'
    suffix = ' (restored)'
    title = tombstone['title'][:120 - len(suffix)] + suffix
    save_token = f'restore-{uuid.uuid4().hex}'
    result = store.save_workspace(
        document_id=new_document_id,
        title=title,
        payload=payload,
        save_token=save_token,
        expected_revision=None,
    )
    return {
        'mode': 'copy',
        'sourceDocumentId': document_id,
        'sourceRevision': tombstone['last_revision'],
        'sourceArchiveId': tombstone['archive_id'],
        'newDocumentId': new_document_id,
        'restoredRevision': result['revision'],
        'title': result['title'],
        'payloadSha256': result['payloadSha256'],
    }


# ---------------------------------------------------------------------------
# Shard selection / rollover and the copy-only job executor
# ---------------------------------------------------------------------------

def _iso(now):
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(timezone.utc).isoformat(
        timespec='milliseconds'
    ).replace('+00:00', 'Z')


def select_writable_shard(store, archive_dir, *, rollover_bytes):
    """Pick (or create) the shard new batches write into. Rollover uses the
    ACTUAL allocated file bytes — cleaned-up dead pages still occupy the
    file, so a shard over the cap seals and rolls even when its logical
    bytes look small. Returns (shard, archive_id, registry_row)."""
    now = store.now_utc()
    now_iso = _iso(now)
    registry = store.list_archive_registry()

    for row in sorted(registry, key=lambda r: r['archive_id'], reverse=True):
        if row['status'] != 'active':
            continue
        path = archive_path_for_id(archive_dir, row['archive_id'])
        if not path.exists():
            store.upsert_archive_registry(
                archive_id=row['archive_id'],
                archive_schema_version=row['archive_schema_version'],
                status=row['status'], created_at_utc=row['created_at_utc'],
                sealed_at_utc=row['sealed_at_utc'],
                last_verified_at_utc=row['last_verified_at_utc'],
                last_verify_status=row['last_verify_status'],
                file_bytes=row['file_bytes'],
                logical_payload_bytes=row['logical_payload_bytes'],
                revision_count=row['revision_count'],
                missing_since_utc=row['missing_since_utc'] or now_iso,
            )
            continue
        file_bytes = os.stat(path).st_size
        if file_bytes >= rollover_bytes:
            shard = ArchiveShard(path, now=store.now_utc)
            shard.seal()
            store.upsert_archive_registry(
                archive_id=row['archive_id'],
                archive_schema_version=row['archive_schema_version'],
                status='sealed', created_at_utc=row['created_at_utc'],
                sealed_at_utc=now_iso,
                last_verified_at_utc=row['last_verified_at_utc'],
                last_verify_status=row['last_verify_status'],
                file_bytes=file_bytes,
                logical_payload_bytes=row['logical_payload_bytes'],
                revision_count=row['revision_count'],
            )
            continue
        return ArchiveShard(path, now=store.now_utc), row['archive_id'], row

    year = now.year
    next_part = 1
    for row in registry:
        match = ARCHIVE_ID_RE.match(row['archive_id'])
        if match and int(match.group(1)) == year:
            next_part = max(next_part, int(match.group(2)) + 1)
    archive_id = f'portfolio-archive-{year}-{next_part:03d}'
    path = archive_path_for_id(archive_dir, archive_id)
    shard = ArchiveShard(path, now=store.now_utc).create(
        archive_id=archive_id,
        source_install_id=store.ensure_install_id(),
        part_year=year, part_number=next_part,
    )
    store.upsert_archive_registry(
        archive_id=archive_id,
        archive_schema_version=ARCHIVE_SCHEMA_VERSION,
        status='active', created_at_utc=now_iso,
        file_bytes=os.stat(path).st_size,
    )
    return shard, archive_id, None


def apply_recovery_snapshot_retention(db_dir, *, now, keep=None, keep_days=None):
    """Precise OR rule: a snapshot survives when it is among the newest
    `keep` OR its age is at most `keep_days` days. Only files failing BOTH
    conditions are deleted. Runs while the maintenance guard is held, so no
    other job's snapshot can be mid-use."""
    keep = DEFAULT_RECOVERY_SNAPSHOT_KEEP if keep is None else max(0, int(keep))
    keep_days = DEFAULT_RECOVERY_SNAPSHOT_KEEP_DAYS if keep_days is None \
        else max(0, int(keep_days))
    backups_dir = Path(db_dir)
    try:
        snapshots = sorted(
            backups_dir.glob('pre-archive-*.db'),
            key=lambda p: p.stat().st_mtime, reverse=True,
        )
    except OSError:
        return []
    newest = set(snapshots[:keep])
    cutoff = (now - timedelta(days=keep_days)).timestamp()
    removed = []
    for snapshot in snapshots:
        if snapshot in newest:
            continue
        try:
            if snapshot.stat().st_mtime > cutoff:
                continue
            snapshot.unlink()
            Path(str(snapshot) + '-wal').unlink(missing_ok=True)
            Path(str(snapshot) + '-shm').unlink(missing_ok=True)
            removed.append(snapshot.name)
        except OSError:
            continue
    return removed


def run_copy_job(store_env, guard, job_id, plan):
    """Execute one copy-only archive job under the held maintenance guard.

    Steps (plan sections 9.2-9.5, copy-only): revalidate the generation
    fingerprint, quick-check the active DB, precheck disk space, take the
    per-job recovery snapshot, select/create the shard, raise the writer
    fence, clean dead batches, copy+verify every batch, quick-check the
    shard, refresh the registry. The active database is never written."""
    store = store_env['store']
    policy = plan['policy']

    # 1. Execution-time revalidation: any relevant save/delete/undelete or
    # policy change since preview makes the whole plan stale.
    current = build_archive_preview(store, policy=policy)
    if (current['manifestHash'] != plan['manifestHash']
            or current['documentStates'] != plan['documentStates']):
        raise ArchivePlanStaleError(
            'workspace changed since preview; run a new preview'
        )

    store.quick_check()

    db_path = Path(store.db_path)
    archive_dir = resolve_archive_dir(db_path, config=store_env.get('_config'))
    archive_dir.mkdir(parents=True, exist_ok=True)
    needed = (plan['totals']['payloadBytes']
              + os.stat(db_path).st_size
              + DISK_SPACE_MARGIN_BYTES)
    free = _disk_usage(archive_dir).free
    if free < needed:
        raise InsufficientDiskSpaceError(
            f'need {needed} bytes free for copy + snapshot + margin'
        )

    # 2. Per-job recovery snapshot (verified by backup_to's quick_check).
    snapshot_dir = db_path.parent / MAINTENANCE_BACKUP_DIRNAME
    snapshot_path = snapshot_dir / f'pre-archive-{job_id}.db'
    if not snapshot_path.exists():
        store.backup_to(snapshot_path)

    rollover = store_env.get(
        '_archive_rollover_bytes', DEFAULT_ARCHIVE_ROLLOVER_BYTES
    )
    shard, archive_id, registry_row = select_writable_shard(
        store, archive_dir, rollover_bytes=rollover
    )
    shard.quick_check()
    shard.raise_writer_fence(
        instance_id=guard.instance_id, fencing_token=guard.fencing_token
    )
    cleaned = shard.cleanup_dead_batches()

    # Resume semantics (plan section 6.5): a `copied` batch left behind by a
    # dead run holds real, committed rows. Verify them now — integrity
    # re-checked payload by payload — so they either graduate to `verified`
    # or fail loudly; they are never silently stranded.
    resumed = []
    for stale in shard.list_batches(('copied',)):
        content = shard.batch_rows(stale['batch_id'])
        shard.verify_batch(stale['batch_id'], content['rows'])
        resumed.append(stale['batch_id'])

    fingerprint = plan['fingerprint']
    batches = split_into_batches(
        plan['manifest'],
        max_rows=store_env.get('_archive_max_rows_per_batch',
                               DEFAULT_ARCHIVE_MAX_ROWS_PER_BATCH),
        max_payload_bytes=store_env.get(
            '_archive_max_payload_bytes_per_batch',
            DEFAULT_ARCHIVE_MAX_PAYLOAD_BYTES_PER_BATCH),
    )

    copied_rows = 0
    copied_bytes = 0
    skipped = []
    batch_ids = []
    canceled = False

    for batch in batches:
        job = store.get_maintenance_job(job_id)
        if job is not None and job['cancelRequested']:
            canceled = True
            break
        if not guard.verify():
            raise MaintenanceLeaseLostError(
                'maintenance lease lost during archive copy'
            )

        # Re-check deleted state for whole-document candidates: an undelete
        # since preview drops the ENTIRE document from this batch.
        deleted_doc_ids = [
            doc_id for doc_id, kind in batch['documents'].items()
            if kind == 'deleted_document'
        ]
        undeleted = set()
        if deleted_doc_ids:
            states = store.document_deleted_states(deleted_doc_ids)
            for doc_id in deleted_doc_ids:
                if states.get(doc_id) is None:
                    undeleted.add(doc_id)

        keys = [
            (row['documentId'], row['revision'])
            for row in batch['rows'] if row['documentId'] not in undeleted
        ]
        for doc_id in sorted(undeleted):
            skipped.append({'documentId': doc_id,
                            'reason': 'skipped_undeleted'})
        stored = store.fetch_revisions_for_archive(keys)

        copy_rows = []
        for row in batch['rows']:
            if row['documentId'] in undeleted:
                continue
            source = stored.get((row['documentId'], row['revision']))
            if source is None or source['payload_sha256'] != row['payloadSha256']:
                skipped.append({
                    'documentId': row['documentId'],
                    'revision': row['revision'],
                    'reason': 'skipped_changed',
                })
                continue
            copy_rows.append({
                'documentId': source['document_id'],
                'revision': source['revision'],
                'saveToken': source['save_token'],
                'payloadSchemaVersion': source['payload_schema_version'],
                'payloadSha256': source['payload_sha256'],
                'payloadJson': source['payload_json'],
                'savedAtUtc': source['saved_at_utc'],
                'payloadBytes': source['payload_bytes'],
            })
        if not copy_rows:
            continue

        documents = []
        for doc_id, kind in batch['documents'].items():
            if doc_id in undeleted:
                continue
            meta = plan['documentMeta'].get(doc_id, {})
            documents.append({
                'documentId': doc_id,
                'archiveKind': kind,
                'title': meta.get('title', ''),
                'symbol': meta.get('symbol', ''),
                'marketDataMode': meta.get('marketDataMode', 'live'),
                'lastRevision': meta.get('currentRevision'),
                'deletedAtUtc': meta.get('deletedAtUtc'),
            })

        batch_id = f'batch-{uuid.uuid4().hex[:20]}'
        result = shard.copy_batch(
            batch_id=batch_id, kind_rows=copy_rows, documents=documents,
            policy=policy, fingerprint=fingerprint,
            instance_id=guard.instance_id,
            fencing_token=guard.fencing_token,
        )
        if result['batchCreated']:
            shard.verify_batch(batch_id, copy_rows)
            batch_ids.append(batch_id)
        # Rows satisfied by safe replay live in earlier good batches and
        # still count as ensured-archived for this job.
        copied_rows += len(copy_rows)
        copied_bytes += sum(row['payloadBytes'] for row in copy_rows)

    shard.quick_check()
    shard_stats = shard.stats()
    meta = shard.meta()
    now_iso = _iso(store.now_utc())
    store.upsert_archive_registry(
        archive_id=archive_id,
        archive_schema_version=ARCHIVE_SCHEMA_VERSION,
        status='sealed' if meta['sealed_at_utc'] else 'active',
        created_at_utc=(registry_row or {}).get('created_at_utc') or now_iso,
        sealed_at_utc=meta['sealed_at_utc'],
        last_verified_at_utc=now_iso,
        last_verify_status='ok',
        file_bytes=os.stat(shard.path).st_size,
        logical_payload_bytes=shard_stats['logicalPayloadBytes'],
        revision_count=shard_stats['revisionCount'],
    )

    apply_recovery_snapshot_retention(
        snapshot_dir, now=store.now_utc(),
        keep=store_env.get('_archive_recovery_snapshot_keep'),
        keep_days=store_env.get('_archive_recovery_snapshot_keep_days'),
    )

    return {
        'archiveId': archive_id,
        'batchIds': batch_ids,
        'copiedRevisions': copied_rows,
        'copiedBytes': copied_bytes,
        'skipped': skipped,
        'cleanedDeadBatches': cleaned,
        'resumedBatches': resumed,
        'canceled': canceled,
        'recoverySnapshot': snapshot_path.name,
        'copyOnly': True,
    }


# ---------------------------------------------------------------------------
# Phase 4: verified main-DB removal, reconciler, and bounded reclamation
# ---------------------------------------------------------------------------

# Hard online-commit ceiling for a single soft-deleted document (whole-doc
# atomicity cannot be chunked). Documents beyond this are refused online and
# reported; they need an offline maintenance window.
COMMIT_DOC_HARD_MAX_ROWS = 2000
COMMIT_DOC_HARD_MAX_BYTES = 256 * 1024 * 1024

DEFAULT_COMMIT_MAX_ROWS = DEFAULT_ARCHIVE_COMMIT_MAX_ROWS
DEFAULT_COMMIT_MAX_BYTES = DEFAULT_ARCHIVE_COMMIT_MAX_PAYLOAD_BYTES


def reconcile_verified_batches(store, shard):
    """Crash reconciler (plan section 9.8): a batch whose every row already
    has main-DB evidence (archive entry, tombstone, or the row is gone with
    matching evidence) was committed before the crash — flip it to
    main_committed. Batches with partial or no evidence stay `verified` and
    are simply committed again (the chunk commit is idempotent)."""
    flipped = []
    for batch in shard.list_batches(('verified',)):
        content = shard.batch_rows(batch['batch_id'])
        rows = content['rows']
        if not rows:
            continue
        doc_kinds = {
            doc_id: meta['archiveKind']
            for doc_id, meta in content['documents'].items()
        }
        keys = [(row['documentId'], row['revision']) for row in rows]
        if store.fetch_revisions_for_archive(keys):
            continue  # at least one row still active: resumable, not done
        tombstone_ids = sorted({
            doc_id for doc_id, kind in doc_kinds.items()
            if kind == 'deleted_document'
        })
        # A tombstoned document must have no document row left at all.
        if store.document_deleted_states(tombstone_ids):
            continue
        partial_keys = [
            (row['documentId'], row['revision']) for row in rows
            if doc_kinds.get(row['documentId']) != 'deleted_document'
        ]
        if store.has_archive_evidence(
            partial_keys=partial_keys, tombstone_doc_ids=tombstone_ids,
        ):
            shard.mark_batch_committed(batch['batch_id'])
            flipped.append(batch['batch_id'])
    return flipped


def commit_verified_batches(store_env, guard, job_id, shard, archive_id):
    """The removal stage (plan section 9.6): commit every VERIFIED batch of
    the shard against the active database in short chunk transactions.

    Preconditions enforced here — the main-DB DELETE path is unreachable
    without them: the shard batch is `verified` (only such batches are
    listed) and this job's recovery snapshot exists and quick-checks.
    Cancel is NOT honored in this stage (plan section 11)."""
    store = store_env['store']
    snapshot_path = (Path(store.db_path).parent / MAINTENANCE_BACKUP_DIRNAME
                     / f'pre-archive-{job_id}.db')
    if not snapshot_path.exists():
        raise ArchiveError(
            'recovery snapshot missing; refusing to remove active rows'
        )
    # Re-verify the snapshot right before the destructive stage.
    from portfolio_store import PortfolioStore as _Store
    _Store(snapshot_path).quick_check()

    reconciled = reconcile_verified_batches(store, shard)

    max_rows = store_env.get('_archive_commit_max_rows',
                             DEFAULT_COMMIT_MAX_ROWS)
    max_bytes = store_env.get('_archive_commit_max_payload_bytes',
                              DEFAULT_COMMIT_MAX_BYTES)
    grace_days = store_env.get('_archive_deleted_after_days', 30)
    lease_kwargs = {
        'lease_name': portfolio_maintenance_lease_name(),
        'holder_instance_id': guard.instance_id,
        'fencing_token': guard.fencing_token,
    }

    removed = []
    already_removed = []
    skipped = []
    removed_bytes = 0
    tombstones_written = 0
    commit_chunks = 0
    resumable_batches = []

    for batch in shard.list_batches(('verified',)):
        content = shard.batch_rows(batch['batch_id'])
        rows = content['rows']
        documents = content['documents']
        batch_skipped = []

        whole_docs = {
            doc_id: meta for doc_id, meta in documents.items()
            if meta['archiveKind'] == 'deleted_document'
        }
        partial_rows = [
            row for row in rows if row['documentId'] not in whole_docs
        ]

        # Whole documents: one atomic chunk each, hard-capped.
        for doc_id, meta in whole_docs.items():
            doc_rows = [row for row in rows if row['documentId'] == doc_id]
            doc_bytes = sum(row['payloadBytes'] for row in doc_rows)
            if (len(doc_rows) > COMMIT_DOC_HARD_MAX_ROWS
                    or doc_bytes > COMMIT_DOC_HARD_MAX_BYTES):
                batch_skipped.append({'documentId': doc_id,
                                      'reason': 'skipped_oversized_document'})
                continue
            if not guard.verify():
                raise MaintenanceLeaseLostError(
                    'maintenance lease lost during removal'
                )
            result = store.commit_archive_removal_chunk(
                whole_document={'documentId': doc_id, 'revisions': doc_rows},
                archive_id=archive_id, archive_batch_id=batch['batch_id'],
                grace_days=grace_days, **lease_kwargs,
            )
            commit_chunks += 1
            removed.extend(result['removed'])
            already_removed.extend(result['alreadyRemoved'])
            batch_skipped.extend(result['skipped'])
            removed_bytes += result['removedBytes']
            tombstones_written += 1 if result['tombstoneWritten'] else 0

        # Partial-history rows: bounded chunks.
        chunk, chunk_bytes = [], 0
        chunks = []
        for row in partial_rows:
            if chunk and (len(chunk) + 1 > max_rows
                          or chunk_bytes + row['payloadBytes'] > max_bytes):
                chunks.append(chunk)
                chunk, chunk_bytes = [], 0
            chunk.append(row)
            chunk_bytes += row['payloadBytes']
        if chunk:
            chunks.append(chunk)
        for chunk in chunks:
            if not guard.verify():
                raise MaintenanceLeaseLostError(
                    'maintenance lease lost during removal'
                )
            result = store.commit_archive_removal_chunk(
                partial_rows=chunk, archive_id=archive_id,
                archive_batch_id=batch['batch_id'],
                grace_days=grace_days, **lease_kwargs,
            )
            commit_chunks += 1
            removed.extend(result['removed'])
            already_removed.extend(result['alreadyRemoved'])
            batch_skipped.extend(result['skipped'])
            removed_bytes += result['removedBytes']

        # main_committed only when EVERY row of this batch has removal
        # evidence. Skipped rows (oversized, undeleted, changed, missing
        # receipt) are still active candidates: the batch stays `verified`
        # so a later job re-commits the remainder — otherwise safe replay
        # would treat those rows as done and they could never converge.
        if batch_skipped:
            resumable_batches.append(batch['batch_id'])
            skipped.extend(batch_skipped)
        else:
            shard.mark_batch_committed(batch['batch_id'])

    return {
        'removedRevisions': len(removed),
        'alreadyRemoved': len(already_removed),
        'skipped': skipped,
        'removedBytes': removed_bytes,
        'tombstonesWritten': tombstones_written,
        'commitChunks': commit_chunks,
        'reconciledBatches': reconciled,
        'resumableBatches': resumable_batches,
    }


def portfolio_maintenance_lease_name():
    # Late import avoids a maintenance <-> archive import cycle.
    import portfolio_maintenance
    return portfolio_maintenance.LEASE_NAME


def run_archive_job(store_env, guard, job_id, plan):
    """Full archive job: copy + verify (phase 3 executor), then the removal
    stage, then bounded space reclamation. Reports the three space results
    separately (plan section 9.7): logical bytes removed from active
    tables, freelist growth, and actual file-size change."""
    store = store_env['store']
    stats_before = store.storage_stats()

    # Stage markers let the page disable Cancel once the un-cancelable
    # main-DB commit begins (plan section 11).
    store.update_maintenance_job_progress(job_id, {'stage': 'copying'})
    copy_summary = run_copy_job(store_env, guard, job_id, plan)
    if copy_summary['canceled']:
        return {**copy_summary, 'copyOnly': True, 'commit': None,
                'space': None}

    archive_dir = resolve_archive_dir(
        Path(store.db_path), config=store_env.get('_config')
    )
    shard = ArchiveShard(
        archive_path_for_id(archive_dir, copy_summary['archiveId']),
        now=store.now_utc,
    )
    store.update_maintenance_job_progress(job_id, {
        'stage': 'committing',
        'copiedRevisions': copy_summary['copiedRevisions'],
    })
    commit_summary = commit_verified_batches(
        store_env, guard, job_id, shard, copy_summary['archiveId']
    )

    freelist_before = store.freelist_count()
    vacuum_ran = False
    threshold = store_env.get('_vacuum_freelist_pages', 256)
    if threshold > 0 and freelist_before >= threshold:
        store.incremental_vacuum(
            max_pages=store_env.get('_vacuum_max_pages', 512)
        )
        vacuum_ran = True
    stats_after = store.storage_stats()

    return {
        **copy_summary,
        'stage': 'done',
        'copyOnly': False,
        'commit': commit_summary,
        'space': {
            'logicalRemovedBytes': commit_summary['removedBytes'],
            'logicalPayloadBytesBefore': stats_before['logicalPayloadBytes'],
            'logicalPayloadBytesAfter': stats_after['logicalPayloadBytes'],
            'freelistPagesBefore': freelist_before,
            'freelistPagesAfter': store.freelist_count(),
            'pageSize': stats_after['pageSize'],
            'dbFileBytesBefore': stats_before['dbFileBytes'],
            'dbFileBytesAfter': stats_after['dbFileBytes'],
            'vacuumRan': vacuum_ran,
        },
    }
