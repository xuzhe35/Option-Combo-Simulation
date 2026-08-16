"""SQLite-backed workspace document store for the option combo workspaces.

Pure storage layer: no WebSocket, no asyncio, no IB. The WebSocket layer
(portfolio_store_ws.py) translates these calls and exceptions into the
persistence protocol. Every operation opens and closes its own connection,
so instances may be shared across threads as long as each call runs on one
thread (the servers call them via asyncio.to_thread()).

Contract highlights (see CODE PLAN/PORTFOLIO_SQLITE_PERSISTENCE_PLAN.md):
- Documents are identified by client-generated UUID-like tokens; titles are
  not unique. Revisions are dense integers from 1.
- Saves are idempotent per save_token and optimistically locked by
  expected_revision. A stale revision NEVER auto-overwrites.
- Payloads are canonicalized (sorted keys, compact, UTF-8, no NaN/Infinity)
  and hashed before the write transaction opens.
- The active database must live outside synced folders; resolve_db_path()
  points at the platform application-data directory unless overridden.
- Pruning and vacuum are explicit maintenance calls, never part of a save,
  and callers must hold a verified backup before pruning.
"""

import json
import hashlib
import os
import re
import shutil
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA_USER_VERSION = 2
DEFAULT_MAX_PAYLOAD_BYTES = 5 * 1024 * 1024
MAX_TITLE_CHARS = 120
MAX_JSON_DEPTH = 64
ACCEPTED_PAYLOAD_SCHEMA_VERSIONS = (0, 1)
DEFAULT_REVISION_KEEP_RECENT = 50
DEFAULT_REVISION_KEEP_DAILY_DAYS = 90
DEFAULT_BACKUP_KEEP_DAILY = 14
DEFAULT_BACKUP_KEEP_WEEKLY = 8

# Reserved save-operation labels for workspace_save_receipts.operation. The
# client-side operation typing (commit 99b2895) is not sent over the wire
# yet; until the protocol carries it, saves record NULL and the server never
# infers a value (plan section 3.1).
RECEIPT_OPERATIONS = ('create', 'update', 'copy')

MAINTENANCE_BACKUP_DIRNAME = 'maintenance-backups'

# v1 -> v2 receipt/bytes backfill runs in bounded, journaled batches so a
# large database never migrates inside one giant startup transaction and an
# interrupted migration resumes from committed work (plan section 3.1).
DEFAULT_MIGRATION_BATCH_ROWS = 500
DEFAULT_MIGRATION_BATCH_PAYLOAD_BYTES = 32 * 1024 * 1024

# portfolio-<UTC stamp>-schema<user_version>-<install id>.db — the install id
# keeps two machines publishing into one synced folder from colliding, and
# retention only ever touches this machine's own matching files.
_BACKUP_FILE_RE = re.compile(
    r'^portfolio-(\d{8}T\d{6}Z)-schema(\d+)-([A-Za-z0-9][A-Za-z0-9-]{7,63})\.db$'
)

# UUIDs pass; so do project-style tokens. Anything shorter than 8 chars or
# carrying separators/exotic characters is rejected before touching SQL.
_TOKEN_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$')

_LIST_FIELDS = ('groups', 'hedges', 'futuresPool', 'forwardRateSamples')


class PortfolioStoreError(Exception):
    """Base class; `code` is the stable protocol error code."""

    code = 'internal_store_error'

    def __init__(self, message=''):
        super().__init__(message or self.code)


class StoreUnavailableError(PortfolioStoreError):
    code = 'store_unavailable'


class InvalidRequestError(PortfolioStoreError):
    code = 'invalid_request'


class InvalidPayloadError(PortfolioStoreError):
    code = 'invalid_payload'


class PayloadTooLargeError(PortfolioStoreError):
    code = 'payload_too_large'


class DocumentNotFoundError(PortfolioStoreError):
    code = 'document_not_found'


class DocumentDeletedError(PortfolioStoreError):
    code = 'document_deleted'


class RevisionConflictError(PortfolioStoreError):
    code = 'revision_conflict'

    def __init__(self, message='', *, current_revision=None, updated_at_utc=None):
        super().__init__(message)
        self.current_revision = current_revision
        self.updated_at_utc = updated_at_utc


class DuplicateSaveTokenError(PortfolioStoreError):
    code = 'duplicate_save_token_mismatch'


class DatabaseBusyError(PortfolioStoreError):
    code = 'database_busy'


class LeaseLostError(PortfolioStoreError):
    """The cross-process maintenance lease no longer belongs to the caller;
    whatever maintenance work was underway must stop immediately."""

    code = 'maintenance_busy'


class DatabaseCorruptError(PortfolioStoreError):
    code = 'database_corrupt'


def default_app_data_dir(platform=None, env=None):
    """Platform application-data directory for the active database.

    Never inside the repository: the repo lives on OneDrive and sync software
    must not touch a live SQLite WAL.
    """
    platform = platform if platform is not None else sys.platform
    env = env if env is not None else os.environ
    home = Path(env.get('HOME', '')) if env.get('HOME') else Path.home()
    if platform == 'darwin':
        return home / 'Library' / 'Application Support' / 'Option Combo Simulator'
    if platform.startswith('win'):
        local_app_data = env.get('LOCALAPPDATA', '')
        base = Path(local_app_data) if local_app_data else home / 'AppData' / 'Local'
        return base / 'OptionComboSimulator'
    xdg = env.get('XDG_DATA_HOME', '')
    base = Path(xdg) if xdg else home / '.local' / 'share'
    return base / 'option-combo-simulator'


def resolve_db_path(config=None, env=None, platform=None):
    """OPTION_COMBO_PORTFOLIO_DB_PATH > config db_path > platform default."""
    env = env if env is not None else os.environ
    explicit = (env.get('OPTION_COMBO_PORTFOLIO_DB_PATH') or '').strip()
    if explicit:
        return Path(explicit)
    if config is not None:
        configured = (config.get('portfolio_store', 'db_path', fallback='') or '').strip()
        if configured:
            return Path(configured)
    return default_app_data_dir(platform=platform, env=env) / 'portfolio.db'


def resolve_backup_dir(config=None, env=None):
    """OPTION_COMBO_PORTFOLIO_BACKUP_DIR > config backup_dir > None (off).

    This is the static-snapshot publish target (typically a OneDrive folder).
    Only completed, verified copies land here — never the live WAL/SHM."""
    env = env if env is not None else os.environ
    explicit = (env.get('OPTION_COMBO_PORTFOLIO_BACKUP_DIR') or '').strip()
    if explicit:
        return Path(explicit)
    if config is not None:
        configured = (config.get('portfolio_store', 'backup_dir', fallback='') or '').strip()
        if configured:
            return Path(configured)
    return None


def restore_database(backup_path, db_path, *, now=None):
    """Install a verified backup as the active database (backends stopped).

    The candidate is copied to a temp name and quick_check-verified first; an
    existing database (with WAL/SHM) is moved aside as a timestamped
    recoverable copy, never overwritten in place. Returns a dict describing
    what happened."""
    backup_path = Path(backup_path)
    db_path = Path(db_path)
    if not backup_path.is_file():
        raise StoreUnavailableError(f'backup not found: {backup_path}')
    if backup_path.name.endswith('.partial'):
        raise StoreUnavailableError('refusing to restore a partial backup file')

    stamp = (now or datetime.now(timezone.utc)).strftime('%Y%m%dT%H%M%SZ')
    db_path.parent.mkdir(parents=True, exist_ok=True)
    staging = db_path.parent / f'{db_path.name}.restore-{stamp}.tmp'
    shutil.copyfile(backup_path, staging)
    try:
        PortfolioStore(staging).initialize().quick_check()
    except PortfolioStoreError:
        staging.unlink(missing_ok=True)
        raise

    displaced = None
    if db_path.exists():
        displaced = db_path.parent / f'{db_path.name}.pre-restore-{stamp}'
        os.replace(db_path, displaced)
        for suffix in ('-wal', '-shm'):
            sidecar = Path(str(db_path) + suffix)
            if sidecar.exists():
                os.replace(sidecar, Path(str(displaced) + suffix))
    os.replace(staging, db_path)
    PortfolioStore(db_path).initialize().quick_check()
    return {
        'restored_from': str(backup_path),
        'db_path': str(db_path),
        'displaced_to': str(displaced) if displaced else None,
    }


def canonicalize_payload(payload, max_payload_bytes=DEFAULT_MAX_PAYLOAD_BYTES):
    """Validate and encode a workspace payload as canonical UTF-8 JSON bytes.

    Raises InvalidPayloadError / PayloadTooLargeError. Runs entirely before
    any write transaction so lock hold time stays short.
    """
    if not isinstance(payload, dict):
        raise InvalidPayloadError('payload must be a JSON object')

    _check_payload_structure(payload)

    try:
        text = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(',', ':'),
            allow_nan=False,
        )
    except ValueError as exc:
        raise InvalidPayloadError(f'payload contains non-finite numbers: {exc}') from exc
    except TypeError as exc:
        raise InvalidPayloadError(f'payload is not JSON-serializable: {exc}') from exc

    encoded = text.encode('utf-8')
    if len(encoded) > max_payload_bytes:
        raise PayloadTooLargeError(
            f'canonical payload is {len(encoded)} bytes; limit is {max_payload_bytes}'
        )
    return encoded


def _check_payload_structure(payload):
    version = payload.get('sessionSchemaVersion', 0)
    if isinstance(version, bool) or not isinstance(version, int):
        raise InvalidPayloadError('sessionSchemaVersion must be an integer')
    if version not in ACCEPTED_PAYLOAD_SCHEMA_VERSIONS:
        raise InvalidPayloadError(f'unsupported sessionSchemaVersion {version}')
    for field in _LIST_FIELDS:
        if field in payload and not isinstance(payload[field], list):
            raise InvalidPayloadError(f'{field} must be a list when present')

    # Iterative depth check: adversarially nested JSON must fail cleanly
    # instead of blowing the recursion limit inside json.dumps.
    stack = [(payload, 1)]
    while stack:
        node, depth = stack.pop()
        if depth > MAX_JSON_DEPTH:
            raise InvalidPayloadError(f'payload nesting exceeds {MAX_JSON_DEPTH} levels')
        if isinstance(node, dict):
            for child in node.values():
                if isinstance(child, (dict, list)):
                    stack.append((child, depth + 1))
        elif isinstance(node, list):
            for child in node:
                if isinstance(child, (dict, list)):
                    stack.append((child, depth + 1))


def _payload_sha256(encoded):
    return hashlib.sha256(encoded).hexdigest()


def _encode_result_json(ack):
    """Compact canonical encoding for workspace_save_receipts.result_json.
    Holds only the small ACK metadata — never the business payload, never
    the idempotentReplay flag (stamped at read time)."""
    return json.dumps(ack, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'))


def _validate_token(name, value):
    if not isinstance(value, str) or not _TOKEN_RE.match(value):
        raise InvalidRequestError(f'{name} must match the restricted token format')
    return value


def _validate_title(title):
    if not isinstance(title, str):
        raise InvalidRequestError('title must be a string')
    trimmed = title.strip()
    if not trimmed or len(trimmed) > MAX_TITLE_CHARS:
        raise InvalidRequestError(
            f'title must be 1-{MAX_TITLE_CHARS} characters after trimming'
        )
    return trimmed


def _derive_symbol(payload):
    symbol = payload.get('underlyingSymbol')
    return symbol.strip().upper()[:32] if isinstance(symbol, str) else ''


def _derive_market_mode(payload):
    return 'historical' if payload.get('marketDataMode') == 'historical' else 'live'


# Schema v2 tables shared by the fresh-create path and the v1 -> v2
# migration. Deliberately NO foreign keys onto workspace_documents /
# workspace_revisions: receipts, archive entries, tombstones, and the
# registry must survive document deletion and payload archival — a cascade
# here would destroy the idempotency ledger and the audit trail.
_V2_TABLE_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS workspace_save_receipts (
        save_token      TEXT PRIMARY KEY,
        document_id     TEXT NOT NULL,
        revision        INTEGER NOT NULL,
        payload_sha256  TEXT NOT NULL,
        payload_bytes   INTEGER NOT NULL,
        saved_at_utc    TEXT NOT NULL,
        operation       TEXT CHECK (operation IN ('create', 'update', 'copy')),
        result_json     TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS workspace_archive_entries (
        document_id       TEXT NOT NULL,
        revision          INTEGER NOT NULL,
        archive_id        TEXT NOT NULL,
        archive_batch_id  TEXT NOT NULL,
        payload_sha256    TEXT NOT NULL,
        payload_bytes     INTEGER NOT NULL,
        saved_at_utc      TEXT NOT NULL,
        archived_at_utc   TEXT NOT NULL,
        PRIMARY KEY (document_id, revision)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_workspace_archive_entries_batch
        ON workspace_archive_entries(archive_batch_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS workspace_archive_tombstones (
        document_id       TEXT PRIMARY KEY,
        title             TEXT NOT NULL,
        symbol            TEXT NOT NULL,
        market_data_mode  TEXT NOT NULL,
        last_revision     INTEGER NOT NULL,
        deleted_at_utc    TEXT NOT NULL,
        archived_at_utc   TEXT NOT NULL,
        archive_id        TEXT NOT NULL,
        archive_batch_id  TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS workspace_archives (
        archive_id              TEXT PRIMARY KEY,
        archive_schema_version  INTEGER NOT NULL,
        status                  TEXT NOT NULL,
        created_at_utc          TEXT NOT NULL,
        sealed_at_utc           TEXT,
        last_verified_at_utc    TEXT,
        last_verify_status      TEXT,
        file_bytes              INTEGER NOT NULL,
        logical_payload_bytes   INTEGER NOT NULL,
        revision_count          INTEGER NOT NULL,
        missing_since_utc       TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS workspace_maintenance_jobs (
        job_id                    TEXT PRIMARY KEY,
        job_type                  TEXT NOT NULL,
        status                    TEXT NOT NULL,
        owner_server_instance_id  TEXT,
        owner_pid                 INTEGER,
        lease_fencing_token       INTEGER,
        created_at_utc            TEXT NOT NULL,
        started_at_utc            TEXT,
        finished_at_utc           TEXT,
        requested_policy_json     TEXT,
        summary_json              TEXT,
        error_code                TEXT,
        error_message             TEXT,
        cancel_requested          INTEGER NOT NULL DEFAULT 0,
        archive_batch_id          TEXT,
        superseded_by_job_id      TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS workspace_maintenance_lease (
        lease_name          TEXT PRIMARY KEY,
        holder_instance_id  TEXT NOT NULL,
        holder_pid          INTEGER NOT NULL,
        fencing_token       INTEGER NOT NULL,
        acquired_at_utc     TEXT NOT NULL,
        heartbeat_at_utc    TEXT NOT NULL,
        expires_at_utc      TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS workspace_migration_journal (
        step             TEXT NOT NULL,
        batch_seq        INTEGER NOT NULL,
        rows_processed   INTEGER NOT NULL,
        payload_bytes    INTEGER NOT NULL,
        completed_at_utc TEXT NOT NULL,
        PRIMARY KEY (step, batch_seq)
    )
    """,
)

_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE workspace_documents (
        document_id      TEXT PRIMARY KEY,
        title            TEXT NOT NULL,
        symbol           TEXT NOT NULL DEFAULT '',
        market_data_mode TEXT NOT NULL DEFAULT 'live'
                         CHECK (market_data_mode IN ('live', 'historical')),
        current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
        created_at_utc   TEXT NOT NULL,
        updated_at_utc   TEXT NOT NULL,
        deleted_at_utc   TEXT
    )
    """,
    """
    CREATE TABLE workspace_revisions (
        document_id            TEXT NOT NULL,
        revision               INTEGER NOT NULL CHECK (revision >= 1),
        save_token             TEXT NOT NULL UNIQUE,
        payload_schema_version INTEGER NOT NULL,
        payload_sha256         TEXT NOT NULL,
        payload_json           TEXT NOT NULL,
        saved_at_utc           TEXT NOT NULL,
        payload_bytes          INTEGER NOT NULL,
        PRIMARY KEY (document_id, revision),
        FOREIGN KEY (document_id)
            REFERENCES workspace_documents(document_id)
            ON DELETE CASCADE
    )
    """,
    """
    CREATE INDEX idx_workspace_documents_updated
        ON workspace_documents(deleted_at_utc, updated_at_utc DESC)
    """,
) + _V2_TABLE_STATEMENTS


class PortfolioStore:
    def __init__(self, db_path, *, max_payload_bytes=DEFAULT_MAX_PAYLOAD_BYTES, now=None,
                 migration_batch_rows=DEFAULT_MIGRATION_BATCH_ROWS,
                 migration_batch_payload_bytes=DEFAULT_MIGRATION_BATCH_PAYLOAD_BYTES):
        self._db_path = Path(db_path)
        self._max_payload_bytes = int(max_payload_bytes)
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._migration_batch_rows = max(1, int(migration_batch_rows))
        self._migration_batch_payload_bytes = max(1, int(migration_batch_payload_bytes))

    @property
    def db_path(self):
        return self._db_path

    # ------------------------------------------------------------------
    # Connection & lifecycle
    # ------------------------------------------------------------------

    def initialize(self):
        """Create/migrate the schema. Raises StoreUnavailableError on any
        failure; never deletes, overwrites, or shadows an unreadable file."""
        try:
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise StoreUnavailableError(f'cannot create database directory: {exc}') from exc
        try:
            conn = self._connect(for_init=True)
        except PortfolioStoreError as exc:
            raise StoreUnavailableError(f'cannot open database: {exc}') from exc
        try:
            self._migrate(conn)
        except PortfolioStoreError as exc:
            raise StoreUnavailableError(f'schema migration failed: {exc}') from exc
        except sqlite3.Error as exc:
            raise StoreUnavailableError(f'schema migration failed: {exc}') from exc
        finally:
            conn.close()
        return self

    def _connect(self, for_init=False, verify_schema=None):
        # A PRAGMA can fail after connect() succeeded (corrupt file, I/O
        # error); the half-configured connection must be closed or it leaks
        # a file descriptor and pins the database file on Windows.
        #
        # verify_schema (default: on for every non-init connection) makes an
        # interrupted v1 -> v2 migration observable as StoreUnavailableError:
        # the store never serves data operations against a half-migrated
        # database. Diagnostics (quick_check, backup_to) opt out because
        # they must run against pre-migration snapshots too.
        verify = (not for_init) if verify_schema is None else verify_schema
        conn = None
        try:
            conn = sqlite3.connect(self._db_path, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA foreign_keys = ON')
            if not for_init:
                conn.execute('PRAGMA journal_mode = WAL')
            conn.execute('PRAGMA synchronous = FULL')
            conn.execute('PRAGMA busy_timeout = 5000')
            if verify:
                version = conn.execute('PRAGMA user_version').fetchone()[0]
                if version != SCHEMA_USER_VERSION:
                    conn.close()
                    raise StoreUnavailableError(
                        f'database schema is at version {version}, expected '
                        f'{SCHEMA_USER_VERSION}; run initialize() to migrate'
                    )
            return conn
        except sqlite3.Error as exc:
            if conn is not None:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass  # keep the original error as the cause
            raise self._map_sqlite_error(exc) from exc

    def _migrate(self, conn):
        version = conn.execute('PRAGMA user_version').fetchone()[0]
        if version > SCHEMA_USER_VERSION:
            raise StoreUnavailableError(
                f'database schema version {version} is newer than supported '
                f'{SCHEMA_USER_VERSION}'
            )
        if version == SCHEMA_USER_VERSION:
            # Top up stragglers: a rolled-back v1 writer that committed
            # between final validation and the version bump could leave a
            # revision without receipt/bytes. Cheap count checks; the
            # backfills only run when something is actually missing.
            self._ensure_v2_completeness(conn)
            return
        if version == 1:
            self._migrate_v1_to_v2(conn)
            return
        object_count = conn.execute('SELECT count(*) FROM sqlite_master').fetchone()[0]
        if object_count > 0:
            # user_version 0 with existing objects is not ours to claim.
            raise StoreUnavailableError(
                'database file exists with unknown contents; refusing to migrate'
            )
        # Fresh database: incremental auto-vacuum must be chosen before the
        # first table exists, and WAL only after auto_vacuum (auto_vacuum
        # cannot change once tables exist without a full VACUUM).
        conn.execute('PRAGMA auto_vacuum = INCREMENTAL')
        conn.execute('PRAGMA journal_mode = WAL')
        conn.execute('BEGIN IMMEDIATE')
        try:
            for statement in _SCHEMA_STATEMENTS:
                conn.execute(statement)
            conn.execute(f'PRAGMA user_version = {SCHEMA_USER_VERSION}')
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise

    # ------------------------------------------------------------------
    # v1 -> v2 migration (plan sections 3.1 / 3.2, phase 1)
    # ------------------------------------------------------------------

    def _migrate_v1_to_v2(self, conn):
        """Resumable in-place upgrade. Structure changes and every backfill
        batch commit independently; user_version stays 1 until the final
        validation passes, so an interrupted migration is indistinguishable
        from a not-yet-started one to data operations (both refuse)."""
        tables = {
            row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        if 'workspace_documents' not in tables or 'workspace_revisions' not in tables:
            raise StoreUnavailableError(
                'database claims schema v1 but lacks the v1 tables; '
                'refusing to migrate'
            )
        if 'workspace_migration_journal' not in tables:
            # First attempt (not a resume): verified safety snapshot before
            # any structural change. Failure aborts with the original file
            # untouched.
            self._create_pre_migration_backup()

        columns = {
            row[1] for row in conn.execute('PRAGMA table_info(workspace_revisions)')
        }
        conn.execute('BEGIN IMMEDIATE')
        try:
            if 'payload_bytes' not in columns:
                # -1 marks "not backfilled yet"; a real canonical payload is
                # at least 2 bytes, so the sentinel can never collide.
                conn.execute(
                    'ALTER TABLE workspace_revisions '
                    'ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT -1'
                )
            for statement in _V2_TABLE_STATEMENTS:
                conn.execute(statement)
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise

        self._backfill_payload_bytes(conn)
        self._backfill_receipts(conn)

        # Validation and the version bump share one write transaction, so a
        # concurrent v1-code writer can never slip an unvalidated row
        # between the check and the bump.
        conn.execute('BEGIN IMMEDIATE')
        try:
            self._validate_v2_backfill(conn)
            conn.execute(f'PRAGMA user_version = {SCHEMA_USER_VERSION}')
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise

    def _ensure_v2_completeness(self, conn):
        missing_receipts = conn.execute(
            'SELECT count(*) FROM workspace_revisions r '
            'LEFT JOIN workspace_save_receipts s ON s.save_token = r.save_token '
            'WHERE s.save_token IS NULL'
        ).fetchone()[0]
        unfilled_bytes = conn.execute(
            'SELECT count(*) FROM workspace_revisions WHERE payload_bytes < 0'
        ).fetchone()[0]
        if unfilled_bytes:
            self._backfill_payload_bytes(conn)
        if missing_receipts:
            self._backfill_receipts(conn)

    def _create_pre_migration_backup(self):
        stamp = self._utc_now_iso().replace('-', '').replace(':', '')[:15] + 'Z'
        backup_dir = self._db_path.parent / MAINTENANCE_BACKUP_DIRNAME
        dest = backup_dir / f'pre-migration-v1-to-v2-{stamp}.db'
        self.backup_to(dest)  # backup API + quick_check; raises on failure

    def _backfill_payload_bytes(self, conn):
        """Set payload_bytes = canonical UTF-8 byte count in bounded batches.
        length() on TEXT counts characters; the BLOB cast forces bytes."""
        while True:
            rows = conn.execute(
                'SELECT rowid, length(CAST(payload_json AS BLOB)) AS byte_len '
                'FROM workspace_revisions WHERE payload_bytes < 0 '
                'ORDER BY rowid LIMIT ?',
                (self._migration_batch_rows,),
            ).fetchall()
            if not rows:
                return
            picked, total = [], 0
            for row in rows:
                if picked and total + row['byte_len'] > self._migration_batch_payload_bytes:
                    break
                picked.append(row['rowid'])
                total += row['byte_len']
            conn.execute('BEGIN IMMEDIATE')
            try:
                conn.executemany(
                    'UPDATE workspace_revisions '
                    'SET payload_bytes = length(CAST(payload_json AS BLOB)) '
                    'WHERE rowid = ?',
                    [(rowid,) for rowid in picked],
                )
                self._journal_batch(conn, 'payload_bytes', len(picked), total)
                conn.execute('COMMIT')
            except BaseException:
                conn.execute('ROLLBACK')
                raise

    def _backfill_receipts(self, conn):
        """Synthesize receipts for pre-receipt revisions in bounded batches.

        result_json mirrors the save_workspace success ACK field-for-field:
        revision/saved time/hash/bytes come from the revision row, symbol and
        market mode are derived from the payload, and the title falls back to
        the CURRENT document title — the same semantics the pre-receipt
        replay path had (it read current document metadata). idempotentReplay
        is stamped at read time, never stored as historical fact."""
        while True:
            rows = conn.execute(
                'SELECT r.document_id, r.revision, r.save_token, '
                'r.payload_sha256, r.saved_at_utc, r.payload_json, d.title '
                'FROM workspace_revisions r '
                'JOIN workspace_documents d ON d.document_id = r.document_id '
                'LEFT JOIN workspace_save_receipts s ON s.save_token = r.save_token '
                'WHERE s.save_token IS NULL '
                'ORDER BY r.document_id, r.revision LIMIT ?',
                (self._migration_batch_rows,),
            ).fetchall()
            if not rows:
                return
            picked, total = [], 0
            for row in rows:
                size = len(row['payload_json'].encode('utf-8'))
                if picked and total + size > self._migration_batch_payload_bytes:
                    break
                try:
                    payload = json.loads(row['payload_json'])
                except ValueError as exc:
                    raise StoreUnavailableError(
                        f'revision {row["revision"]} of {row["document_id"]} '
                        f'holds invalid JSON; migration fails closed: {exc}'
                    ) from exc
                ack = {
                    'documentId': row['document_id'],
                    'title': row['title'],
                    'symbol': _derive_symbol(payload),
                    'marketDataMode': _derive_market_mode(payload),
                    'revision': row['revision'],
                    'updatedAtUtc': row['saved_at_utc'],
                    'payloadSha256': row['payload_sha256'],
                    'payloadBytes': size,
                }
                picked.append((
                    row['save_token'], row['document_id'], row['revision'],
                    row['payload_sha256'], size, row['saved_at_utc'],
                    _encode_result_json(ack),
                ))
                total += size
            conn.execute('BEGIN IMMEDIATE')
            try:
                conn.executemany(
                    'INSERT INTO workspace_save_receipts (save_token, '
                    'document_id, revision, payload_sha256, payload_bytes, '
                    'saved_at_utc, operation, result_json) '
                    'VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
                    picked,
                )
                self._journal_batch(conn, 'save_receipts', len(picked), total)
                conn.execute('COMMIT')
            except BaseException:
                conn.execute('ROLLBACK')
                raise

    def _journal_batch(self, conn, step, rows_processed, payload_bytes):
        seq = conn.execute(
            'SELECT COALESCE(MAX(batch_seq), 0) + 1 '
            'FROM workspace_migration_journal WHERE step = ?',
            (step,),
        ).fetchone()[0]
        conn.execute(
            'INSERT INTO workspace_migration_journal '
            '(step, batch_seq, rows_processed, payload_bytes, completed_at_utc) '
            'VALUES (?, ?, ?, ?, ?)',
            (step, seq, rows_processed, payload_bytes, self._utc_now_iso()),
        )

    @staticmethod
    def _validate_v2_backfill(conn):
        unfilled = conn.execute(
            'SELECT count(*) FROM workspace_revisions WHERE payload_bytes < 0'
        ).fetchone()[0]
        missing = conn.execute(
            'SELECT count(*) FROM workspace_revisions r '
            'LEFT JOIN workspace_save_receipts s ON s.save_token = r.save_token '
            'WHERE s.save_token IS NULL'
        ).fetchone()[0]
        mismatched = conn.execute(
            'SELECT count(*) FROM workspace_revisions r '
            'JOIN workspace_save_receipts s ON s.save_token = r.save_token '
            'WHERE s.document_id != r.document_id OR s.revision != r.revision '
            'OR s.payload_sha256 != r.payload_sha256'
        ).fetchone()[0]
        if unfilled or missing or mismatched:
            raise StoreUnavailableError(
                'migration validation failed: '
                f'{unfilled} revisions without payload_bytes, '
                f'{missing} without receipts, {mismatched} mismatched receipts'
            )

    @staticmethod
    def _map_sqlite_error(exc):
        message = str(exc)
        if isinstance(exc, sqlite3.OperationalError) and 'locked' in message:
            return DatabaseBusyError(message)
        if isinstance(exc, sqlite3.DatabaseError) and (
            'malformed' in message or 'not a database' in message
        ):
            return DatabaseCorruptError(message)
        wrapped = PortfolioStoreError(message)
        return wrapped

    def now_utc(self):
        """The store's injected clock as an aware UTC datetime. Admin-layer
        candidate math must use this, not the wall clock, so fixtures with a
        fake clock stay deterministic."""
        now = self._now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        return now.astimezone(timezone.utc)

    def _utc_now_iso(self):
        now = self._now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        return now.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace(
            '+00:00', 'Z'
        )

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def list_documents(self, include_deleted=False):
        conn = self._connect()
        try:
            where = '' if include_deleted else 'WHERE deleted_at_utc IS NULL'
            rows = conn.execute(
                f'SELECT * FROM workspace_documents {where} '
                'ORDER BY updated_at_utc DESC, document_id'
            ).fetchall()
            return [self._document_row_to_meta(row) for row in rows]
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def load_workspace(self, document_id):
        _validate_token('documentId', document_id)
        conn = self._connect()
        try:
            doc = self._get_document(conn, document_id)
            if doc['deleted_at_utc'] is not None:
                raise DocumentDeletedError(f'document {document_id} is deleted')
            row = conn.execute(
                'SELECT payload_json, payload_sha256, payload_schema_version, saved_at_utc '
                'FROM workspace_revisions WHERE document_id = ? AND revision = ?',
                (document_id, doc['current_revision']),
            ).fetchone()
            if row is None:
                raise DatabaseCorruptError(
                    f'document {document_id} is missing its current revision'
                )
            meta = self._document_row_to_meta(doc)
            meta['payloadSchemaVersion'] = row['payload_schema_version']
            meta['payloadSha256'] = row['payload_sha256']
            meta['savedAtUtc'] = row['saved_at_utc']
            meta['payload'] = json.loads(row['payload_json'])
            return meta
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def list_revisions(self, document_id, limit=50, before_revision=None):
        _validate_token('documentId', document_id)
        limit = max(1, min(int(limit), 200))
        conn = self._connect()
        try:
            self._get_document(conn, document_id)
            params = [document_id]
            where = 'WHERE document_id = ?'
            if before_revision is not None:
                where += ' AND revision < ?'
                params.append(int(before_revision))
            rows = conn.execute(
                'SELECT revision, payload_schema_version, payload_sha256, saved_at_utc, '
                'payload_bytes '
                f'FROM workspace_revisions {where} ORDER BY revision DESC LIMIT ?',
                (*params, limit),
            ).fetchall()
            return [
                {
                    'revision': row['revision'],
                    'payloadSchemaVersion': row['payload_schema_version'],
                    'payloadSha256': row['payload_sha256'],
                    'savedAtUtc': row['saved_at_utc'],
                    'payloadBytes': row['payload_bytes'],
                }
                for row in rows
            ]
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    def save_workspace(self, *, document_id, title, payload, save_token,
                       expected_revision=None, operation=None):
        """Create (expected_revision None) or update a document.

        Idempotent per save_token: an exact retry returns the original ACK
        from workspace_save_receipts; the same token with different content
        is rejected. `operation` is recorded verbatim when the protocol
        supplies it and NULL otherwise — the server never infers it.
        """
        _validate_token('documentId', document_id)
        _validate_token('saveToken', save_token)
        title = _validate_title(title)
        if operation is not None and operation not in RECEIPT_OPERATIONS:
            raise InvalidRequestError(
                f'operation must be one of {RECEIPT_OPERATIONS}'
            )
        if expected_revision is not None:
            expected_revision = int(expected_revision)
            if expected_revision < 1:
                raise InvalidRequestError('expectedRevision must be >= 1')

        encoded = canonicalize_payload(payload, self._max_payload_bytes)
        sha256 = _payload_sha256(encoded)
        schema_version = payload.get('sessionSchemaVersion', 0)
        symbol = _derive_symbol(payload)
        market_mode = _derive_market_mode(payload)

        conn = self._connect()
        try:
            replay = self._find_save_token_replay(conn, document_id, save_token, sha256)
            if replay is not None:
                return replay

            now_iso = self._utc_now_iso()
            conn.execute('BEGIN IMMEDIATE')
            try:
                # Re-check inside the write lock: a concurrent identical
                # request may have committed between fast path and here.
                replay = self._find_save_token_replay(conn, document_id, save_token, sha256)
                if replay is not None:
                    conn.execute('ROLLBACK')
                    return replay

                doc = conn.execute(
                    'SELECT * FROM workspace_documents WHERE document_id = ?',
                    (document_id,),
                ).fetchone()

                if expected_revision is None:
                    if doc is not None:
                        raise RevisionConflictError(
                            f'document {document_id} already exists',
                            current_revision=doc['current_revision'],
                            updated_at_utc=doc['updated_at_utc'],
                        )
                    next_revision = 1
                    conn.execute(
                        'INSERT INTO workspace_documents (document_id, title, symbol, '
                        'market_data_mode, current_revision, created_at_utc, '
                        'updated_at_utc, deleted_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
                        (document_id, title, symbol, market_mode, next_revision,
                         now_iso, now_iso),
                    )
                else:
                    if doc is None:
                        raise DocumentNotFoundError(f'document {document_id} not found')
                    if doc['deleted_at_utc'] is not None:
                        raise DocumentDeletedError(f'document {document_id} is deleted')
                    if doc['current_revision'] != expected_revision:
                        raise RevisionConflictError(
                            f'document {document_id} is at revision '
                            f'{doc["current_revision"]}, expected {expected_revision}',
                            current_revision=doc['current_revision'],
                            updated_at_utc=doc['updated_at_utc'],
                        )
                    next_revision = expected_revision + 1
                    conn.execute(
                        'UPDATE workspace_documents SET title = ?, symbol = ?, '
                        'market_data_mode = ?, current_revision = ?, updated_at_utc = ? '
                        'WHERE document_id = ?',
                        (title, symbol, market_mode, next_revision, now_iso, document_id),
                    )

                ack = {
                    'documentId': document_id,
                    'title': title,
                    'symbol': symbol,
                    'marketDataMode': market_mode,
                    'revision': next_revision,
                    'updatedAtUtc': now_iso,
                    'payloadSha256': sha256,
                    'payloadBytes': len(encoded),
                }
                try:
                    conn.execute(
                        'INSERT INTO workspace_revisions (document_id, revision, '
                        'save_token, payload_schema_version, payload_sha256, '
                        'payload_json, saved_at_utc, payload_bytes) '
                        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        (document_id, next_revision, save_token, schema_version,
                         sha256, encoded.decode('utf-8'), now_iso, len(encoded)),
                    )
                    # Receipt and revision commit or roll back together:
                    # the receipt is the durable idempotency ledger that
                    # outlives the payload once it is archived.
                    conn.execute(
                        'INSERT INTO workspace_save_receipts (save_token, '
                        'document_id, revision, payload_sha256, payload_bytes, '
                        'saved_at_utc, operation, result_json) '
                        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        (save_token, document_id, next_revision, sha256,
                         len(encoded), now_iso, operation,
                         _encode_result_json(ack)),
                    )
                except sqlite3.IntegrityError:
                    # Unreachable while BEGIN IMMEDIATE serializes writers,
                    # but the UNIQUE constraints stay the last line of defense.
                    conn.execute('ROLLBACK')
                    replay = self._find_save_token_replay(
                        conn, document_id, save_token, sha256
                    )
                    if replay is not None:
                        return replay
                    raise DuplicateSaveTokenError(
                        'saveToken already used with different content'
                    )
                conn.execute('COMMIT')
            except BaseException:
                if conn.in_transaction:
                    conn.execute('ROLLBACK')
                raise

            return {**ack, 'idempotentReplay': False}
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def _find_save_token_replay(self, conn, document_id, save_token, sha256):
        # Receipts, not revisions: the original ACK must replay even after
        # the revision payload has been pruned or archived away.
        row = conn.execute(
            'SELECT document_id, payload_sha256, result_json '
            'FROM workspace_save_receipts WHERE save_token = ?',
            (save_token,),
        ).fetchone()
        if row is None:
            return None
        if row['document_id'] != document_id or row['payload_sha256'] != sha256:
            raise DuplicateSaveTokenError(
                'saveToken already used with different content'
            )
        result = json.loads(row['result_json'])
        result['idempotentReplay'] = True
        return result

    def delete_document(self, document_id, expected_revision):
        _validate_token('documentId', document_id)
        expected_revision = int(expected_revision)
        conn = self._connect()
        try:
            now_iso = self._utc_now_iso()
            conn.execute('BEGIN IMMEDIATE')
            try:
                doc = conn.execute(
                    'SELECT * FROM workspace_documents WHERE document_id = ?',
                    (document_id,),
                ).fetchone()
                if doc is None:
                    raise DocumentNotFoundError(f'document {document_id} not found')
                if doc['deleted_at_utc'] is not None:
                    raise DocumentDeletedError(f'document {document_id} is already deleted')
                if doc['current_revision'] != expected_revision:
                    raise RevisionConflictError(
                        f'document {document_id} is at revision '
                        f'{doc["current_revision"]}, expected {expected_revision}',
                        current_revision=doc['current_revision'],
                        updated_at_utc=doc['updated_at_utc'],
                    )
                conn.execute(
                    'UPDATE workspace_documents SET deleted_at_utc = ?, '
                    'updated_at_utc = ? WHERE document_id = ?',
                    (now_iso, now_iso, document_id),
                )
                conn.execute('COMMIT')
            except BaseException:
                if conn.in_transaction:
                    conn.execute('ROLLBACK')
                raise
            return {'documentId': document_id, 'deletedAtUtc': now_iso}
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def undelete_document(self, document_id, expected_revision):
        """Reverse a soft delete. History is untouched; the document simply
        reappears in the default listing at its previous current revision."""
        _validate_token('documentId', document_id)
        expected_revision = int(expected_revision)
        conn = self._connect()
        try:
            now_iso = self._utc_now_iso()
            conn.execute('BEGIN IMMEDIATE')
            try:
                doc = conn.execute(
                    'SELECT * FROM workspace_documents WHERE document_id = ?',
                    (document_id,),
                ).fetchone()
                if doc is None:
                    raise DocumentNotFoundError(f'document {document_id} not found')
                if doc['deleted_at_utc'] is None:
                    raise InvalidRequestError(
                        f'document {document_id} is not deleted'
                    )
                if doc['current_revision'] != expected_revision:
                    raise RevisionConflictError(
                        f'document {document_id} is at revision '
                        f'{doc["current_revision"]}, expected {expected_revision}',
                        current_revision=doc['current_revision'],
                        updated_at_utc=doc['updated_at_utc'],
                    )
                conn.execute(
                    'UPDATE workspace_documents SET deleted_at_utc = NULL, '
                    'updated_at_utc = ? WHERE document_id = ?',
                    (now_iso, document_id),
                )
                conn.execute('COMMIT')
            except BaseException:
                if conn.in_transaction:
                    conn.execute('ROLLBACK')
                raise
            return {
                'documentId': document_id,
                'revision': expected_revision,
                'undeletedAtUtc': now_iso,
            }
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def restore_revision(self, *, document_id, revision, save_token, expected_revision):
        """Copy an old payload forward as a new revision. History is never
        rewritten."""
        _validate_token('documentId', document_id)
        _validate_token('saveToken', save_token)
        revision = int(revision)
        conn = self._connect()
        try:
            source = conn.execute(
                'SELECT payload_json FROM workspace_revisions '
                'WHERE document_id = ? AND revision = ?',
                (document_id, revision),
            ).fetchone()
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()
        if source is None:
            raise DocumentNotFoundError(
                f'revision {revision} of document {document_id} not found'
            )
        payload = json.loads(source['payload_json'])
        doc_meta = self.load_workspace(document_id)
        return self.save_workspace(
            document_id=document_id,
            title=doc_meta['title'],
            payload=payload,
            save_token=save_token,
            expected_revision=expected_revision,
        )

    # ------------------------------------------------------------------
    # Maintenance
    # ------------------------------------------------------------------

    def prune_revisions(self, *, keep_recent=DEFAULT_REVISION_KEEP_RECENT,
                        keep_daily_days=DEFAULT_REVISION_KEEP_DAILY_DAYS):
        """Apply the retention policy to every live document.

        Callers MUST hold a verified backup first — this deletes data. Each
        document is pruned in its own short transaction so a long prune never
        starves a save. Returns the number of deleted revisions.
        """
        keep_recent = max(1, int(keep_recent))
        keep_daily_days = max(0, int(keep_daily_days))
        now = self._now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        cutoff_date = (
            now.astimezone(timezone.utc) - timedelta(days=keep_daily_days)
        ).date().isoformat()

        conn = self._connect()
        try:
            doc_ids = [
                row['document_id']
                for row in conn.execute(
                    'SELECT document_id FROM workspace_documents '
                    'WHERE deleted_at_utc IS NULL'
                ).fetchall()
            ]
            deleted_total = 0
            for doc_id in doc_ids:
                deleted_total += self._prune_document(
                    conn, doc_id, keep_recent, cutoff_date
                )
            return deleted_total
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def _prune_document(self, conn, document_id, keep_recent, cutoff_date):
        conn.execute('BEGIN IMMEDIATE')
        try:
            doc = conn.execute(
                'SELECT current_revision FROM workspace_documents WHERE document_id = ?',
                (document_id,),
            ).fetchone()
            if doc is None:
                conn.execute('ROLLBACK')
                return 0
            rows = conn.execute(
                'SELECT revision, saved_at_utc FROM workspace_revisions '
                'WHERE document_id = ? ORDER BY revision DESC',
                (document_id,),
            ).fetchall()
            keep = {doc['current_revision']}
            keep.update(row['revision'] for row in rows[:keep_recent])
            last_per_day = {}
            for row in rows[keep_recent:]:
                day = row['saved_at_utc'][:10]
                if day >= cutoff_date:
                    existing = last_per_day.get(day)
                    if existing is None or row['revision'] > existing:
                        last_per_day[day] = row['revision']
            keep.update(last_per_day.values())
            to_delete = [row['revision'] for row in rows if row['revision'] not in keep]
            for revision in to_delete:
                conn.execute(
                    'DELETE FROM workspace_revisions '
                    'WHERE document_id = ? AND revision = ?',
                    (document_id, revision),
                )
            conn.execute('COMMIT')
            return len(to_delete)
        except BaseException:
            if conn.in_transaction:
                conn.execute('ROLLBACK')
            raise

    def freelist_count(self):
        conn = self._connect()
        try:
            return conn.execute('PRAGMA freelist_count').fetchone()[0]
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def incremental_vacuum(self, max_pages=256):
        """Bounded space reclamation. Call only when idle and only after the
        freelist justifies it; never on the save path."""
        conn = self._connect()
        try:
            conn.execute(f'PRAGMA incremental_vacuum({max(1, int(max_pages))})')
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def quick_check(self):
        # verify_schema off: quick_check must also validate pre-migration
        # snapshots and foreign schema versions without claiming them.
        conn = self._connect(verify_schema=False)
        try:
            row = conn.execute('PRAGMA quick_check').fetchone()
            if row is None or row[0] != 'ok':
                raise DatabaseCorruptError(
                    f'quick_check reported: {row[0] if row else "no result"}'
                )
            return 'ok'
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def backup_to(self, dest_path):
        """Consistent online backup via the SQLite backup API, then verify
        the copy with quick_check. Never copy the live file directly."""
        dest = Path(dest_path)
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise StoreUnavailableError(f'cannot create backup directory: {exc}') from exc
        # verify_schema off: the pre-migration safety snapshot backs up a
        # database that is still at the previous schema version.
        src = self._connect(verify_schema=False)
        try:
            dst = sqlite3.connect(dest)
            try:
                src.backup(dst)
            finally:
                dst.close()
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            src.close()
        backup_store = PortfolioStore(dest, max_payload_bytes=self._max_payload_bytes)
        backup_store.quick_check()
        return dest

    def ensure_install_id(self):
        """Stable per-machine id stored next to the active database, used in
        published backup names so two machines never overwrite each other."""
        marker = self._db_path.parent / 'install_id'
        try:
            existing = marker.read_text(encoding='utf-8').strip()
        except OSError:
            existing = ''
        if existing and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{7,63}', existing):
            return existing
        install_id = uuid.uuid4().hex[:16]
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(install_id + '\n', encoding='utf-8')
        except OSError as exc:
            raise StoreUnavailableError(f'cannot persist install id: {exc}') from exc
        return install_id

    def latest_own_backup_stamp(self, backup_dir):
        """Newest publish stamp for this install in backup_dir, or None."""
        install_id = self.ensure_install_id()
        newest = None
        try:
            entries = list(Path(backup_dir).iterdir())
        except OSError:
            return None
        for entry in entries:
            match = _BACKUP_FILE_RE.match(entry.name)
            if match and match.group(3) == install_id:
                if newest is None or match.group(1) > newest:
                    newest = match.group(1)
        return newest

    def publish_backup(self, backup_dir, *, keep_daily=DEFAULT_BACKUP_KEEP_DAILY,
                       keep_weekly=DEFAULT_BACKUP_KEEP_WEEKLY):
        """Publish one verified static snapshot into a synced folder.

        The snapshot is produced with the SQLite backup API into a local temp
        file, quick_check-verified, copied to the target as an explicit
        .partial name, flushed, then atomically renamed — sync software never
        sees a half-written final file and never touches the live WAL/SHM.
        Retention prunes only this install's own completed files."""
        backup_dir = Path(backup_dir)
        try:
            backup_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise StoreUnavailableError(f'cannot create backup dir: {exc}') from exc

        install_id = self.ensure_install_id()
        now = self._now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        stamp = now.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        name = f'portfolio-{stamp}-schema{SCHEMA_USER_VERSION}-{install_id}.db'

        # Unique staging/partial names are a second line of defense behind
        # the caller's maintenance lock: even two same-second publishes can
        # never share intermediate files. Partials keep the .partial suffix
        # so restore tooling and retention both ignore them.
        nonce = uuid.uuid4().hex[:8]
        local_snapshot = self._db_path.parent / f'.backup-staging-{stamp}-{nonce}.db'
        try:
            self.backup_to(local_snapshot)  # includes quick_check
            partial = backup_dir / f'{name}.{nonce}.partial'
            with open(local_snapshot, 'rb') as src, open(partial, 'wb') as dst:
                shutil.copyfileobj(src, dst)
                dst.flush()
                os.fsync(dst.fileno())
            os.replace(partial, backup_dir / name)
        finally:
            local_snapshot.unlink(missing_ok=True)
            Path(str(local_snapshot) + '-wal').unlink(missing_ok=True)
            Path(str(local_snapshot) + '-shm').unlink(missing_ok=True)

        self._apply_backup_retention(backup_dir, install_id, keep_daily, keep_weekly)
        return backup_dir / name

    @staticmethod
    def _apply_backup_retention(backup_dir, install_id, keep_daily, keep_weekly):
        own = []
        for entry in Path(backup_dir).iterdir():
            match = _BACKUP_FILE_RE.match(entry.name)
            if match and match.group(3) == install_id:
                own.append((match.group(1), entry))
        own.sort(reverse=True)

        newest_per_day = {}
        newest_per_week = {}
        for stamp, entry in own:
            day = stamp[:8]
            if day not in newest_per_day:
                newest_per_day[day] = entry
            week = datetime.strptime(stamp[:8], '%Y%m%d').isocalendar()[:2]
            if week not in newest_per_week:
                newest_per_week[week] = entry
        keep = set()
        for day in sorted(newest_per_day, reverse=True)[:max(0, int(keep_daily))]:
            keep.add(newest_per_day[day])
        for week in sorted(newest_per_week, reverse=True)[:max(0, int(keep_weekly))]:
            keep.add(newest_per_week[week])
        for _stamp, entry in own:
            if entry not in keep:
                entry.unlink(missing_ok=True)

    # ------------------------------------------------------------------
    # Read-only statistics (admin page phase 2)
    # ------------------------------------------------------------------

    def storage_stats(self):
        """Fast overview numbers: counters, PRAGMAs, and file sizes only —
        no payload scans. Field names follow the frozen storage-metric
        vocabulary in portfolio_archive.STORAGE_METRIC_FORMULAS."""
        conn = self._connect()
        try:
            counts = conn.execute(
                'SELECT '
                '(SELECT count(*) FROM workspace_documents '
                ' WHERE deleted_at_utc IS NULL) AS active_documents, '
                '(SELECT count(*) FROM workspace_documents '
                ' WHERE deleted_at_utc IS NOT NULL) AS deleted_documents, '
                '(SELECT count(*) FROM workspace_revisions) AS revision_count, '
                '(SELECT COALESCE(SUM(payload_bytes), 0) '
                ' FROM workspace_revisions) AS logical_payload_bytes, '
                '(SELECT count(*) FROM workspace_save_receipts) AS receipt_count, '
                '(SELECT COALESCE(SUM(length(CAST(result_json AS BLOB))), 0) '
                ' FROM workspace_save_receipts) AS receipt_bytes'
            ).fetchone()
            page_count = conn.execute('PRAGMA page_count').fetchone()[0]
            page_size = conn.execute('PRAGMA page_size').fetchone()[0]
            freelist_count = conn.execute('PRAGMA freelist_count').fetchone()[0]

            now = self._now()
            if now.tzinfo is None:
                now = now.replace(tzinfo=timezone.utc)
            recent = {}
            for label, days in (('last7Days', 7), ('last30Days', 30)):
                cutoff = (now - timedelta(days=days)).astimezone(timezone.utc)
                cutoff_iso = cutoff.isoformat(timespec='milliseconds').replace(
                    '+00:00', 'Z'
                )
                row = conn.execute(
                    'SELECT count(*), COALESCE(SUM(payload_bytes), 0) '
                    'FROM workspace_revisions WHERE saved_at_utc >= ?',
                    (cutoff_iso,),
                ).fetchone()
                recent[label] = {'revisions': row[0], 'payloadBytes': row[1]}

            archive = conn.execute(
                'SELECT count(*) AS archive_count, '
                "COALESCE(SUM(status = 'sealed'), 0) AS sealed_count, "
                'COALESCE(SUM(missing_since_utc IS NOT NULL), 0) AS missing_count, '
                'COALESCE(SUM(file_bytes), 0) AS file_bytes, '
                'COALESCE(SUM(logical_payload_bytes), 0) AS logical_payload_bytes, '
                'COALESCE(SUM(revision_count), 0) AS revision_count, '
                'MAX(last_verified_at_utc) AS last_verified_at_utc '
                'FROM workspace_archives'
            ).fetchone()
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

        def _file_size(path):
            try:
                return os.stat(path).st_size
            except OSError:
                return 0

        return {
            'activeDocuments': counts['active_documents'],
            'deletedDocuments': counts['deleted_documents'],
            'revisionCount': counts['revision_count'],
            'logicalPayloadBytes': counts['logical_payload_bytes'],
            'receiptCount': counts['receipt_count'],
            'receiptBytesEstimate': counts['receipt_bytes'],
            'pageCount': page_count,
            'pageSize': page_size,
            'freelistCount': freelist_count,
            'dbFileBytes': _file_size(self._db_path),
            'walBytes': _file_size(Path(str(self._db_path) + '-wal')),
            'shmBytes': _file_size(Path(str(self._db_path) + '-shm')),
            'recent': recent,
            'archive': {
                'archiveCount': archive['archive_count'],
                'sealedCount': archive['sealed_count'],
                'missingCount': archive['missing_count'],
                'fileBytes': archive['file_bytes'],
                'logicalPayloadBytes': archive['logical_payload_bytes'],
                'revisionCount': archive['revision_count'],
                'lastVerifiedAtUtc': archive['last_verified_at_utc'],
            },
        }

    def retention_snapshot(self):
        """Per-document revision metadata for candidate computation and
        archive manifests. Never includes payload content."""
        conn = self._connect()
        try:
            live_docs = {}
            deleted_docs = {}
            for row in conn.execute(
                'SELECT document_id, title, symbol, market_data_mode, '
                'current_revision, deleted_at_utc FROM workspace_documents'
            ):
                entry = {
                    'documentId': row['document_id'],
                    'title': row['title'],
                    'symbol': row['symbol'],
                    'marketDataMode': row['market_data_mode'],
                    'currentRevision': row['current_revision'],
                    'deletedAtUtc': row['deleted_at_utc'],
                    'revisions': [],
                }
                if row['deleted_at_utc'] is None:
                    live_docs[row['document_id']] = entry
                else:
                    deleted_docs[row['document_id']] = entry
            for row in conn.execute(
                'SELECT document_id, revision, saved_at_utc, payload_bytes, '
                'payload_sha256 FROM workspace_revisions '
                'ORDER BY document_id, revision'
            ):
                doc = live_docs.get(row['document_id']) \
                    or deleted_docs.get(row['document_id'])
                if doc is not None:
                    doc['revisions'].append({
                        'revision': row['revision'],
                        'savedAtUtc': row['saved_at_utc'],
                        'payloadBytes': row['payload_bytes'],
                        'payloadSha256': row['payload_sha256'],
                    })
            for doc in deleted_docs.values():
                doc['revisionCount'] = len(doc['revisions'])
                doc['payloadBytes'] = sum(
                    revision['payloadBytes'] for revision in doc['revisions']
                )
            return {
                'liveDocuments': list(live_docs.values()),
                'deletedDocuments': list(deleted_docs.values()),
            }
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def fetch_revisions_for_archive(self, keys):
        """Full revision rows (payload included) for (document_id, revision)
        pairs, keyed by pair. Missing pairs are simply absent — the archive
        copier records them as skipped, never fails on them."""
        conn = self._connect()
        try:
            result = {}
            for document_id, revision in keys:
                row = conn.execute(
                    'SELECT document_id, revision, save_token, '
                    'payload_schema_version, payload_sha256, payload_json, '
                    'saved_at_utc, payload_bytes FROM workspace_revisions '
                    'WHERE document_id = ? AND revision = ?',
                    (document_id, int(revision)),
                ).fetchone()
                if row is not None:
                    result[(document_id, int(revision))] = dict(row)
            return result
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def document_deleted_states(self, document_ids):
        """deleted_at_utc per document id (None when live, absent when the
        document row no longer exists)."""
        conn = self._connect()
        try:
            result = {}
            for document_id in document_ids:
                row = conn.execute(
                    'SELECT deleted_at_utc FROM workspace_documents '
                    'WHERE document_id = ?', (document_id,),
                ).fetchone()
                if row is not None:
                    result[document_id] = row['deleted_at_utc']
            return result
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def has_archive_evidence(self, *, partial_keys=(), tombstone_doc_ids=()):
        """True only when EVERY given partial (doc, revision) pair has an
        archive entry and EVERY given document id has a tombstone. The
        reconciler's proof that a verified batch was fully committed."""
        conn = self._connect()
        try:
            for document_id, revision in partial_keys:
                row = conn.execute(
                    'SELECT 1 FROM workspace_archive_entries '
                    'WHERE document_id = ? AND revision = ?',
                    (document_id, int(revision)),
                ).fetchone()
                if row is None:
                    return False
            for document_id in tombstone_doc_ids:
                row = conn.execute(
                    'SELECT 1 FROM workspace_archive_tombstones '
                    'WHERE document_id = ?', (document_id,),
                ).fetchone()
                if row is None:
                    return False
            return True
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Archive shard registry (main-DB index of shards; no payloads)
    # ------------------------------------------------------------------

    def list_archive_registry(self):
        conn = self._connect()
        try:
            return [
                dict(row) for row in conn.execute(
                    'SELECT * FROM workspace_archives ORDER BY archive_id'
                )
            ]
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def upsert_archive_registry(self, *, archive_id, archive_schema_version,
                                status, created_at_utc, sealed_at_utc=None,
                                last_verified_at_utc=None,
                                last_verify_status=None, file_bytes=0,
                                logical_payload_bytes=0, revision_count=0,
                                missing_since_utc=None):
        _validate_token('archiveId', archive_id)
        conn = self._connect()
        try:
            conn.execute(
                'INSERT INTO workspace_archives (archive_id, '
                'archive_schema_version, status, created_at_utc, '
                'sealed_at_utc, last_verified_at_utc, last_verify_status, '
                'file_bytes, logical_payload_bytes, revision_count, '
                'missing_since_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
                'ON CONFLICT(archive_id) DO UPDATE SET '
                'archive_schema_version = excluded.archive_schema_version, '
                'status = excluded.status, '
                'sealed_at_utc = excluded.sealed_at_utc, '
                'last_verified_at_utc = excluded.last_verified_at_utc, '
                'last_verify_status = excluded.last_verify_status, '
                'file_bytes = excluded.file_bytes, '
                'logical_payload_bytes = excluded.logical_payload_bytes, '
                'revision_count = excluded.revision_count, '
                'missing_since_utc = excluded.missing_since_utc',
                (archive_id, int(archive_schema_version), status,
                 created_at_utc, sealed_at_utc, last_verified_at_utc,
                 last_verify_status, int(file_bytes),
                 int(logical_payload_bytes), int(revision_count),
                 missing_since_utc),
            )
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def exact_storage_scan(self):
        """Exact verification scan for the background stats job: recompute
        canonical UTF-8 byte totals across every payload and cross-check the
        stored payload_bytes and receipt coverage."""
        conn = self._connect()
        try:
            row = conn.execute(
                'SELECT count(*) AS revision_count, '
                'COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) '
                '  AS logical_payload_bytes, '
                'COALESCE(SUM(payload_bytes '
                '  != length(CAST(payload_json AS BLOB))), 0) AS byte_mismatches '
                'FROM workspace_revisions'
            ).fetchone()
            missing_receipts = conn.execute(
                'SELECT count(*) FROM workspace_revisions r '
                'LEFT JOIN workspace_save_receipts s '
                'ON s.save_token = r.save_token WHERE s.save_token IS NULL'
            ).fetchone()[0]
            return {
                'revisionCount': row['revision_count'],
                'logicalPayloadBytes': row['logical_payload_bytes'],
                'payloadBytesMismatches': row['byte_mismatches'],
                'revisionsMissingReceipts': missing_receipts,
            }
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Maintenance jobs (admin page; summaries only, never candidate lists)
    # ------------------------------------------------------------------

    def create_maintenance_job(self, *, job_type, requested_policy=None,
                               owner_instance_id=None, owner_pid=None):
        """Jobs record their owning server instance at creation so a later
        orphan sweep (owner gone) can mark them interrupted instead of
        leaving the page staring at a running job with no executor."""
        job_id = f'job-{uuid.uuid4().hex[:20]}'
        now_iso = self._utc_now_iso()
        conn = self._connect()
        try:
            conn.execute(
                'INSERT INTO workspace_maintenance_jobs (job_id, job_type, '
                'status, created_at_utc, requested_policy_json, '
                'owner_server_instance_id, owner_pid) '
                'VALUES (?, ?, ?, ?, ?, ?, ?)',
                (job_id, job_type, 'queued', now_iso,
                 json.dumps(requested_policy) if requested_policy else None,
                 owner_instance_id,
                 int(owner_pid) if owner_pid is not None else None),
            )
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()
        return {'jobId': job_id, 'jobType': job_type, 'status': 'queued',
                'createdAtUtc': now_iso}

    def start_maintenance_job(self, job_id, *, fencing_token=None):
        _validate_token('jobId', job_id)
        conn = self._connect()
        try:
            cursor = conn.execute(
                'UPDATE workspace_maintenance_jobs SET status = ?, '
                'started_at_utc = ?, lease_fencing_token = ? '
                "WHERE job_id = ? AND status = 'queued'",
                ('running', self._utc_now_iso(),
                 int(fencing_token) if fencing_token is not None else None,
                 job_id),
            )
            if cursor.rowcount != 1:
                raise InvalidRequestError(
                    f'job {job_id} is not queued; cannot start'
                )
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def mark_orphan_maintenance_jobs(self, current_instance_id):
        """Mark queued/running jobs owned by OTHER server instances (or by
        nobody) as interrupted. Called after each successful maintenance
        lease acquisition; a job created by this process is untouched."""
        conn = self._connect()
        try:
            cursor = conn.execute(
                'UPDATE workspace_maintenance_jobs SET status = ?, '
                'finished_at_utc = ?, error_code = ?, error_message = ? '
                "WHERE status IN ('queued', 'running') "
                'AND (owner_server_instance_id IS NULL '
                'OR owner_server_instance_id != ?)',
                ('interrupted', self._utc_now_iso(), 'interrupted',
                 'owning server instance is no longer running',
                 current_instance_id),
            )
            return cursor.rowcount
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def finish_maintenance_job(self, job_id, *, status, summary=None,
                               error_code=None, error_message=None):
        _validate_token('jobId', job_id)
        if status not in ('completed', 'failed', 'interrupted', 'canceled'):
            raise InvalidRequestError(f'invalid terminal job status {status!r}')
        conn = self._connect()
        try:
            cursor = conn.execute(
                'UPDATE workspace_maintenance_jobs SET status = ?, '
                'finished_at_utc = ?, summary_json = ?, error_code = ?, '
                'error_message = ? '
                "WHERE job_id = ? AND status IN ('queued', 'running')",
                (status, self._utc_now_iso(),
                 json.dumps(summary) if summary is not None else None,
                 error_code, error_message, job_id),
            )
            if cursor.rowcount != 1:
                raise InvalidRequestError(
                    f'job {job_id} is not active; cannot finish'
                )
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def get_maintenance_job(self, job_id):
        _validate_token('jobId', job_id)
        conn = self._connect()
        try:
            row = conn.execute(
                'SELECT * FROM workspace_maintenance_jobs WHERE job_id = ?',
                (job_id,),
            ).fetchone()
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()
        if row is None:
            return None
        return self._job_row_to_meta(row)

    def latest_active_maintenance_job(self):
        conn = self._connect()
        try:
            row = conn.execute(
                'SELECT * FROM workspace_maintenance_jobs '
                "WHERE status IN ('queued', 'running') "
                'ORDER BY created_at_utc DESC LIMIT 1'
            ).fetchone()
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()
        return self._job_row_to_meta(row) if row is not None else None

    def request_job_cancel(self, job_id):
        """Best-effort cancel flag; the running worker honors it only in
        safe phases (copy/verify), never during a main-DB commit."""
        _validate_token('jobId', job_id)
        conn = self._connect()
        try:
            cursor = conn.execute(
                'UPDATE workspace_maintenance_jobs SET cancel_requested = 1 '
                "WHERE job_id = ? AND status IN ('queued', 'running')",
                (job_id,),
            )
            return cursor.rowcount == 1
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def commit_archive_removal_chunk(self, *, partial_rows=(),
                                     whole_document=None, archive_id,
                                     archive_batch_id, lease_name,
                                     holder_instance_id, fencing_token,
                                     grace_days=30):
        """One short BEGIN IMMEDIATE removal chunk (plan section 9.6).

        INTERNAL to the archive commit stage: callers must have a VERIFIED
        archive batch and a verified recovery snapshot before invoking this
        — portfolio_archive.commit_verified_batches is the only sanctioned
        caller. Every row is re-validated inside the write transaction; the
        archive entry / tombstone insert and the delete share that
        transaction; anything that changed since preview is skipped, never
        force-deleted. The current revision of a live document is
        structurally undeletable here."""
        now = self.now_utc()
        now_iso = self._utc_now_iso()
        removed, already_removed, skipped = [], [], []
        removed_bytes = 0
        tombstone_written = False
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                lease = conn.execute(
                    'SELECT holder_instance_id, fencing_token, expires_at_utc '
                    'FROM workspace_maintenance_lease WHERE lease_name = ?',
                    (lease_name,),
                ).fetchone()
                if (lease is None
                        or lease['holder_instance_id'] != holder_instance_id
                        or lease['fencing_token'] != int(fencing_token)
                        or lease['expires_at_utc'] <= now_iso):
                    raise LeaseLostError(
                        'maintenance lease lost inside removal transaction'
                    )

                if whole_document is not None:
                    result = self._commit_whole_document(
                        conn, whole_document, archive_id, archive_batch_id,
                        now, now_iso, grace_days,
                    )
                    removed.extend(result['removed'])
                    already_removed.extend(result['alreadyRemoved'])
                    skipped.extend(result['skipped'])
                    removed_bytes += result['removedBytes']
                    tombstone_written = result['tombstoneWritten']

                for row in partial_rows:
                    outcome = self._commit_partial_row(
                        conn, row, archive_id, archive_batch_id, now_iso,
                    )
                    if outcome == 'removed':
                        removed.append({'documentId': row['documentId'],
                                        'revision': row['revision']})
                        removed_bytes += row['payloadBytes']
                    elif outcome == 'already_removed':
                        already_removed.append({
                            'documentId': row['documentId'],
                            'revision': row['revision'],
                        })
                    else:
                        skipped.append({'documentId': row['documentId'],
                                        'revision': row['revision'],
                                        'reason': outcome})
                conn.execute('COMMIT')
            except BaseException:
                if conn.in_transaction:
                    conn.execute('ROLLBACK')
                raise
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()
        return {'removed': removed, 'alreadyRemoved': already_removed,
                'skipped': skipped, 'removedBytes': removed_bytes,
                'tombstoneWritten': tombstone_written}

    @staticmethod
    def _commit_partial_row(conn, row, archive_id, archive_batch_id, now_iso):
        active = conn.execute(
            'SELECT r.save_token, r.payload_sha256, r.payload_bytes, '
            'r.saved_at_utc, d.current_revision '
            'FROM workspace_revisions r '
            'JOIN workspace_documents d ON d.document_id = r.document_id '
            'WHERE r.document_id = ? AND r.revision = ?',
            (row['documentId'], row['revision']),
        ).fetchone()
        if active is None:
            entry = conn.execute(
                'SELECT payload_sha256 FROM workspace_archive_entries '
                'WHERE document_id = ? AND revision = ?',
                (row['documentId'], row['revision']),
            ).fetchone()
            if entry is not None and entry['payload_sha256'] == row['payloadSha256']:
                return 'already_removed'
            return 'skipped_changed'
        if active['current_revision'] == row['revision']:
            return 'skipped_current'
        if (active['payload_sha256'] != row['payloadSha256']
                or active['payload_bytes'] != row['payloadBytes']
                or active['saved_at_utc'] != row['savedAtUtc']):
            return 'skipped_changed'
        receipt = conn.execute(
            'SELECT 1 FROM workspace_save_receipts WHERE save_token = ?',
            (active['save_token'],),
        ).fetchone()
        if receipt is None:
            return 'skipped_missing_receipt'
        conn.execute(
            'INSERT INTO workspace_archive_entries (document_id, revision, '
            'archive_id, archive_batch_id, payload_sha256, payload_bytes, '
            'saved_at_utc, archived_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (row['documentId'], row['revision'], archive_id,
             archive_batch_id, row['payloadSha256'], row['payloadBytes'],
             row['savedAtUtc'], now_iso),
        )
        conn.execute(
            'DELETE FROM workspace_revisions '
            'WHERE document_id = ? AND revision = ?',
            (row['documentId'], row['revision']),
        )
        return 'removed'

    @staticmethod
    def _commit_whole_document(conn, doc, archive_id, archive_batch_id,
                               now, now_iso, grace_days):
        """Tombstone + delete of one soft-deleted document, atomic within
        the caller's transaction. Any inconsistency skips the WHOLE
        document — a document is never archived half-way."""
        empty = {'removed': [], 'alreadyRemoved': [], 'skipped': [],
                 'removedBytes': 0, 'tombstoneWritten': False}
        document_id = doc['documentId']
        active = conn.execute(
            'SELECT * FROM workspace_documents WHERE document_id = ?',
            (document_id,),
        ).fetchone()
        if active is None:
            tombstone = conn.execute(
                'SELECT 1 FROM workspace_archive_tombstones '
                'WHERE document_id = ?', (document_id,),
            ).fetchone()
            if tombstone is not None:
                return {**empty, 'alreadyRemoved': [{'documentId': document_id}]}
            return {**empty, 'skipped': [{'documentId': document_id,
                                          'reason': 'skipped_changed'}]}
        if active['deleted_at_utc'] is None:
            return {**empty, 'skipped': [{'documentId': document_id,
                                          'reason': 'skipped_undeleted'}]}
        deleted_at = datetime.fromisoformat(
            active['deleted_at_utc'].replace('Z', '+00:00')
        )
        if now - deleted_at <= timedelta(days=max(0, int(grace_days))):
            return {**empty, 'skipped': [{'documentId': document_id,
                                          'reason': 'skipped_grace_period'}]}

        manifest = {
            (row['revision']): row for row in doc['revisions']
        }
        stored = conn.execute(
            'SELECT revision, save_token, payload_sha256, payload_bytes, '
            'saved_at_utc FROM workspace_revisions WHERE document_id = ?',
            (document_id,),
        ).fetchall()
        if {row['revision'] for row in stored} != set(manifest):
            return {**empty, 'skipped': [{'documentId': document_id,
                                          'reason': 'skipped_changed'}]}
        for row in stored:
            expected = manifest[row['revision']]
            if (row['payload_sha256'] != expected['payloadSha256']
                    or row['payload_bytes'] != expected['payloadBytes']):
                return {**empty, 'skipped': [{'documentId': document_id,
                                              'reason': 'skipped_changed'}]}
            receipt = conn.execute(
                'SELECT 1 FROM workspace_save_receipts WHERE save_token = ?',
                (row['save_token'],),
            ).fetchone()
            if receipt is None:
                return {**empty, 'skipped': [{
                    'documentId': document_id,
                    'reason': 'skipped_missing_receipt'}]}

        conn.execute(
            'INSERT INTO workspace_archive_tombstones (document_id, title, '
            'symbol, market_data_mode, last_revision, deleted_at_utc, '
            'archived_at_utc, archive_id, archive_batch_id) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (document_id, active['title'], active['symbol'],
             active['market_data_mode'], active['current_revision'],
             active['deleted_at_utc'], now_iso, archive_id, archive_batch_id),
        )
        conn.execute(
            'DELETE FROM workspace_revisions WHERE document_id = ?',
            (document_id,),
        )
        conn.execute(
            'DELETE FROM workspace_documents WHERE document_id = ?',
            (document_id,),
        )
        return {
            'removed': [{'documentId': document_id, 'revision': row['revision']}
                        for row in stored],
            'alreadyRemoved': [],
            'skipped': [],
            'removedBytes': sum(row['payload_bytes'] for row in stored),
            'tombstoneWritten': True,
        }

    # ------------------------------------------------------------------
    # Cross-process maintenance lease (storage half; the OS file lock and
    # acquisition ordering live in portfolio_maintenance.py)
    # ------------------------------------------------------------------

    def maintenance_lease_acquire(self, *, lease_name, holder_instance_id,
                                  holder_pid, ttl_seconds):
        """Atomically acquire or renew the lease. Returns the lease dict on
        success, None when another live holder owns it. The fencing token
        increments only on takeover, never on renewal.

        Callers MUST already hold the OS advisory file lock: an expired
        lease alone never authorizes takeover while another process is
        alive (its OS lock is still held, so we would not be here)."""
        _validate_token('leaseName', lease_name)
        _validate_token('holderInstanceId', holder_instance_id)
        ttl_seconds = max(1, int(ttl_seconds))
        conn = self._connect()
        try:
            now = self.now_utc()
            now_iso = self._utc_now_iso()
            expires_iso = (now + timedelta(seconds=ttl_seconds)).isoformat(
                timespec='milliseconds'
            ).replace('+00:00', 'Z')
            conn.execute('BEGIN IMMEDIATE')
            try:
                row = conn.execute(
                    'SELECT * FROM workspace_maintenance_lease '
                    'WHERE lease_name = ?', (lease_name,),
                ).fetchone()
                if row is not None:
                    held_by_me = row['holder_instance_id'] == holder_instance_id
                    expired = row['expires_at_utc'] <= now_iso
                    if not held_by_me and not expired:
                        conn.execute('ROLLBACK')
                        return None
                    token = row['fencing_token'] if held_by_me \
                        else row['fencing_token'] + 1
                else:
                    token = 1
                conn.execute(
                    'INSERT INTO workspace_maintenance_lease (lease_name, '
                    'holder_instance_id, holder_pid, fencing_token, '
                    'acquired_at_utc, heartbeat_at_utc, expires_at_utc) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?) '
                    'ON CONFLICT(lease_name) DO UPDATE SET '
                    'holder_instance_id = excluded.holder_instance_id, '
                    'holder_pid = excluded.holder_pid, '
                    'fencing_token = excluded.fencing_token, '
                    'acquired_at_utc = excluded.acquired_at_utc, '
                    'heartbeat_at_utc = excluded.heartbeat_at_utc, '
                    'expires_at_utc = excluded.expires_at_utc',
                    (lease_name, holder_instance_id, int(holder_pid), token,
                     now_iso, now_iso, expires_iso),
                )
                conn.execute('COMMIT')
            except BaseException:
                if conn.in_transaction:
                    conn.execute('ROLLBACK')
                raise
            return {
                'leaseName': lease_name,
                'holderInstanceId': holder_instance_id,
                'fencingToken': token,
                'expiresAtUtc': expires_iso,
            }
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def maintenance_lease_heartbeat(self, *, lease_name, holder_instance_id,
                                    fencing_token, ttl_seconds):
        """Extend the lease. Returns False when the lease was lost (other
        holder, other token, or row gone) — the caller must stop."""
        ttl_seconds = max(1, int(ttl_seconds))
        conn = self._connect()
        try:
            now = self.now_utc()
            now_iso = self._utc_now_iso()
            expires_iso = (now + timedelta(seconds=ttl_seconds)).isoformat(
                timespec='milliseconds'
            ).replace('+00:00', 'Z')
            cursor = conn.execute(
                'UPDATE workspace_maintenance_lease SET heartbeat_at_utc = ?, '
                'expires_at_utc = ? WHERE lease_name = ? '
                'AND holder_instance_id = ? AND fencing_token = ?',
                (now_iso, expires_iso, lease_name, holder_instance_id,
                 int(fencing_token)),
            )
            return cursor.rowcount == 1
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def maintenance_lease_verify(self, *, lease_name, holder_instance_id,
                                 fencing_token):
        """True while this holder+token owns an unexpired lease."""
        conn = self._connect()
        try:
            row = conn.execute(
                'SELECT holder_instance_id, fencing_token, expires_at_utc '
                'FROM workspace_maintenance_lease WHERE lease_name = ?',
                (lease_name,),
            ).fetchone()
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()
        if row is None:
            return False
        return (row['holder_instance_id'] == holder_instance_id
                and row['fencing_token'] == int(fencing_token)
                and row['expires_at_utc'] > self._utc_now_iso())

    def maintenance_lease_release(self, *, lease_name, holder_instance_id,
                                  fencing_token):
        """Guarded delete: only the current holder+token can release."""
        conn = self._connect()
        try:
            cursor = conn.execute(
                'DELETE FROM workspace_maintenance_lease WHERE lease_name = ? '
                'AND holder_instance_id = ? AND fencing_token = ?',
                (lease_name, holder_instance_id, int(fencing_token)),
            )
            return cursor.rowcount == 1
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    @staticmethod
    def _job_row_to_meta(row):
        summary = None
        if row['summary_json']:
            try:
                summary = json.loads(row['summary_json'])
            except ValueError:
                summary = None
        return {
            'jobId': row['job_id'],
            'jobType': row['job_type'],
            'status': row['status'],
            'createdAtUtc': row['created_at_utc'],
            'startedAtUtc': row['started_at_utc'],
            'finishedAtUtc': row['finished_at_utc'],
            'summary': summary,
            'errorCode': row['error_code'],
            'errorMessage': row['error_message'],
            'cancelRequested': bool(row['cancel_requested']),
            'archiveBatchId': row['archive_batch_id'],
            'supersededByJobId': row['superseded_by_job_id'],
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _get_document(self, conn, document_id):
        row = conn.execute(
            'SELECT * FROM workspace_documents WHERE document_id = ?',
            (document_id,),
        ).fetchone()
        if row is None:
            raise DocumentNotFoundError(f'document {document_id} not found')
        return row

    @staticmethod
    def _document_row_to_meta(row):
        return {
            'documentId': row['document_id'],
            'title': row['title'],
            'symbol': row['symbol'],
            'marketDataMode': row['market_data_mode'],
            'revision': row['current_revision'],
            'createdAtUtc': row['created_at_utc'],
            'updatedAtUtc': row['updated_at_utc'],
            'deletedAtUtc': row['deleted_at_utc'],
        }
