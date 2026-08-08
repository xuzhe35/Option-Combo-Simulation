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

SCHEMA_USER_VERSION = 1
DEFAULT_MAX_PAYLOAD_BYTES = 5 * 1024 * 1024
MAX_TITLE_CHARS = 120
MAX_JSON_DEPTH = 64
ACCEPTED_PAYLOAD_SCHEMA_VERSIONS = (0, 1)
DEFAULT_REVISION_KEEP_RECENT = 50
DEFAULT_REVISION_KEEP_DAILY_DAYS = 90
DEFAULT_BACKUP_KEEP_DAILY = 14
DEFAULT_BACKUP_KEEP_WEEKLY = 8

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
)


class PortfolioStore:
    def __init__(self, db_path, *, max_payload_bytes=DEFAULT_MAX_PAYLOAD_BYTES, now=None):
        self._db_path = Path(db_path)
        self._max_payload_bytes = int(max_payload_bytes)
        self._now = now or (lambda: datetime.now(timezone.utc))

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

    def _connect(self, for_init=False):
        try:
            conn = sqlite3.connect(self._db_path, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA foreign_keys = ON')
            if not for_init:
                conn.execute('PRAGMA journal_mode = WAL')
            conn.execute('PRAGMA synchronous = FULL')
            conn.execute('PRAGMA busy_timeout = 5000')
            return conn
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc

    def _migrate(self, conn):
        version = conn.execute('PRAGMA user_version').fetchone()[0]
        if version > SCHEMA_USER_VERSION:
            raise StoreUnavailableError(
                f'database schema version {version} is newer than supported '
                f'{SCHEMA_USER_VERSION}'
            )
        if version == SCHEMA_USER_VERSION:
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
                'length(payload_json) AS payload_bytes '
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
                       expected_revision=None):
        """Create (expected_revision None) or update a document.

        Idempotent per save_token: an exact retry returns the original
        result; the same token with different content is rejected.
        """
        _validate_token('documentId', document_id)
        _validate_token('saveToken', save_token)
        title = _validate_title(title)
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

                try:
                    conn.execute(
                        'INSERT INTO workspace_revisions (document_id, revision, '
                        'save_token, payload_schema_version, payload_sha256, '
                        'payload_json, saved_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        (document_id, next_revision, save_token, schema_version,
                         sha256, encoded.decode('utf-8'), now_iso),
                    )
                except sqlite3.IntegrityError:
                    # Unreachable while BEGIN IMMEDIATE serializes writers,
                    # but the UNIQUE constraint stays the last line of defense.
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

            return {
                'documentId': document_id,
                'title': title,
                'symbol': symbol,
                'marketDataMode': market_mode,
                'revision': next_revision,
                'updatedAtUtc': now_iso,
                'payloadSha256': sha256,
                'payloadBytes': len(encoded),
                'idempotentReplay': False,
            }
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def _find_save_token_replay(self, conn, document_id, save_token, sha256):
        row = conn.execute(
            'SELECT document_id, revision, payload_sha256, saved_at_utc, '
            'length(payload_json) AS payload_bytes '
            'FROM workspace_revisions WHERE save_token = ?',
            (save_token,),
        ).fetchone()
        if row is None:
            return None
        if row['document_id'] != document_id or row['payload_sha256'] != sha256:
            raise DuplicateSaveTokenError(
                'saveToken already used with different content'
            )
        doc = conn.execute(
            'SELECT * FROM workspace_documents WHERE document_id = ?',
            (document_id,),
        ).fetchone()
        meta = self._document_row_to_meta(doc) if doc is not None else {
            'documentId': document_id,
        }
        return {
            'documentId': document_id,
            'title': meta.get('title', ''),
            'symbol': meta.get('symbol', ''),
            'marketDataMode': meta.get('marketDataMode', 'live'),
            'revision': row['revision'],
            'updatedAtUtc': row['saved_at_utc'],
            'payloadSha256': row['payload_sha256'],
            'payloadBytes': row['payload_bytes'],
            'idempotentReplay': True,
        }

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
        conn = self._connect()
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
        src = self._connect()
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

        local_snapshot = self._db_path.parent / f'.backup-staging-{stamp}.db'
        try:
            self.backup_to(local_snapshot)  # includes quick_check
            partial = backup_dir / (name + '.partial')
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
