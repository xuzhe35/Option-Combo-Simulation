"""SQLite-backed blended-cost event ledger, keyed by IB account and symbol.

Pure storage layer: no WebSocket, no asyncio, no IB. cost_basis_ws.py
translates these calls and exceptions into the browser protocol. Every
operation opens and closes its own connection, so one instance may be shared
across threads as long as each call runs on one thread (the servers call
them through asyncio.to_thread()).

Contract highlights (see CODE PLAN/COST_BASIS_LEDGER_PAGE_PLAN.md):

- The ledger is the source of truth for cost. TWS position snapshots only
  ever *detect* a missing event; nothing in this module writes an event that
  a human did not confirm.
- Events are append-only. Corrections append a void marker; rows are never
  UPDATEd in place beyond their void columns and never DELETEd, because the
  audit trail is the entire point of the ledger. The sole destructive escape
  hatch is an explicit whole-book deletion, which removes the book and every
  related audit artifact behind a server-generated confirmation phrase.
- Every event stores explicit signed quantities and an explicit signed cash
  amount. The engine only sums stored fields; it never re-derives intent
  from a "kind". A CSV export is therefore readable without this code.
- cash_amount is the account cash delta: positive received, negative paid,
  fees already included.
- Assignment/exercise/expiry are validated against the contract's running
  position *at the event's date position*, so back-dating a trade that
  invalidates a later assignment is rejected instead of silently corrupting
  the cost.
- Every new book belongs to exactly one IB account. Existing pre-v5 books
  that already mixed accounts remain readable as explicitly legacy books;
  they are never split or rewritten behind the operator's back.
- Event writes and reset/rebuild are idempotent per client_token; imported rows additionally
  de-duplicate on (book, account, external_ref) so overlapping broker
  statements can be re-imported safely.
"""

import hashlib
import json
import math
import re
import sqlite3
import uuid
from bisect import bisect_left, bisect_right
from datetime import datetime, timezone
from pathlib import Path

from portfolio_store import default_app_data_dir

SCHEMA_USER_VERSION = 10

MAX_SYMBOL_CHARS = 32
MAX_ACCOUNT_CHARS = 32
MAX_NOTE_CHARS = 500
MAX_TAG_CHARS = 64
MAX_LOCAL_SYMBOL_CHARS = 64
MAX_EXTERNAL_REF_CHARS = 128
MAX_SPLIT_RULE_REF_CHARS = 128
MAX_SPLIT_RATIO = 100
MAX_IMPORT_EVENTS = 5000
DEFAULT_EVENT_PAGE_SIZE = 200
MAX_EVENT_PAGE_SIZE = 2000
MAX_SQLITE_INTEGER = (1 << 63) - 1

# A stored cash amount further than this from the amount derived off
# quantity x price x multiplier is flagged (never rejected): brokers really
# do settle a few cents away from the theoretical figure, and the operator
# needs to see which rows were overridden rather than have them refused.
CASH_DERIVATION_TOLERANCE = 0.01

# A delivery's cash is fully determined (shares x strike, fees in their own
# column), so this only has to absorb settlement noise. It stays far below any
# option premium, which is the error it exists to catch: a few cents of slack
# can never hide a premium being counted twice.
DELIVERY_CASH_TOLERANCE = 0.05

EVENT_KINDS = (
    'opening_balance',
    'share_trade',
    'option_trade',
    'option_assignment',
    'option_exercise',
    'option_expiry',
    'dividend',
    'fee',
    'split',
    'manual_adjust',
    'futures_trade',
    'futures_roll',
    'option_split',
)

OPTION_KINDS = frozenset({
    'option_trade', 'option_assignment', 'option_exercise', 'option_expiry',
})

# Kinds that must close an existing position rather than open one.
CLOSING_KINDS = frozenset({
    'option_assignment', 'option_exercise', 'option_expiry',
})

# Kinds whose cash is fully determined, so a deviation is an error rather
# than a rounding difference. An expiry belongs here too: a contract that
# expired moved no cash beyond its fees, and any other figure quietly adds
# money the market never paid.
DELIVERY_KINDS = frozenset({
    'option_assignment', 'option_exercise', 'option_expiry',
})

FUTURE_KINDS = frozenset({'futures_trade', 'futures_roll'})

# Split groups (CODE PLAN/COST_BASIS_CORPORATE_ACTIONS_PLAN.md §15). One
# standard forward split is a group of rows sharing split_group: a `split`
# header (ratio, rule reference, rounding) and one `option_split` row per open
# option series. Groups are written and voided only as a whole
# (append_split_group / void_split_group) and are checked by
# _validate_split_groups after every write that touches their account.
SPLIT_ROUNDING_MODES = ('half_up_cent',)
SPLIT_GROUP_FIELDS = (
    'split_group', 'split_rule_ref', 'split_rounding', 'split_to_strike',
    'split_to_contracts', 'split_to_con_id', 'split_to_local_symbol',
)

EVENT_SOURCES = ('manual', 'reconcile', 'csv_import', 'execution_report')

# A fee row normally takes cash out. The broker sometimes gives cash back
# under the same heading - an exchange rebate on a negative commission, a
# withholding-tax refund - and those rows carry a tag that names the refund,
# so the sign check knows it is looking at money returned, not at a typo.
FEE_REFUND_TAGS = frozenset({'ibkr_rebate', 'withholding_tax_refund', 'fee_refund'})
# A dividend the broker later reversed is booked negative under this tag so
# the income total nets to what was actually kept.
DIVIDEND_REVERSAL_TAG = 'dividend_reversal'
# Opening stubs an importer drafts for positions a partial statement did not
# open; they are replaced, never kept, once the real history arrives.
PRIOR_STUB_TAGS = frozenset({'prior_open', 'prior_basis'})

_TOKEN_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$')
_SYMBOL_RE = re.compile(r'^[A-Z0-9][A-Z0-9.\-]{0,31}$')
_ACCOUNT_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$')
_TRADE_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
_BROKER_TIMESTAMP_FIELD_RE = re.compile(
    r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$')
_EXPIRY_RE = re.compile(r'^\d{8}$')
_CONTRACT_MONTH_RE = re.compile(r'^\d{6}(?:\d{2})?$')

# Cash-settled products have no deliverable, so a blended per-share cost is
# meaningless for them. Rejecting at book creation is far kinder than
# letting someone accumulate a year of events against a number that cannot
# mean what they think it means.
DELIVERABLE_SEC_TYPES = ('STK', 'FUT')


class CostBasisStoreError(Exception):
    """Base class. The WebSocket layer maps these to protocol error codes."""

    code = 'cost_basis_store_error'


class StoreUnavailableError(CostBasisStoreError):
    code = 'store_unavailable'


class InvalidRequestError(CostBasisStoreError):
    code = 'invalid_request'


class BookNotFoundError(CostBasisStoreError):
    code = 'book_not_found'


class BookExistsError(CostBasisStoreError):
    code = 'book_exists'


class EventNotFoundError(CostBasisStoreError):
    code = 'event_not_found'


class EventAlreadyVoidedError(CostBasisStoreError):
    code = 'event_already_voided'


class PositionOverdrawError(CostBasisStoreError):
    """Closing more contracts than the ledger shows open at that date."""

    code = 'position_overdraw'


class ResetConfirmationError(CostBasisStoreError):
    """The typed phrase did not match what the server would destroy."""

    code = 'reset_confirmation_mismatch'


class DeleteConfirmationError(CostBasisStoreError):
    """The typed phrase did not match the whole book deletion plan."""

    code = 'delete_confirmation_mismatch'


class LedgerChangedError(CostBasisStoreError):
    """The ledger is not the version the caller previewed against."""

    code = 'ledger_changed'


class ImportRevisionConflictError(CostBasisStoreError):
    """A broker reference already stored carries different economics."""

    code = 'import_revision_conflict'


class DatabaseBusyError(CostBasisStoreError):
    code = 'database_busy'


class DatabaseCorruptError(CostBasisStoreError):
    code = 'database_corrupt'


# Schema v2. Deliberately NOT a foreign key onto cost_basis_events: the whole
# point of the table is to outlive the rows it copied.
_V2_TABLE_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS cost_basis_book_resets (
        reset_id       TEXT PRIMARY KEY,
        book_id        TEXT NOT NULL,
        client_token   TEXT NOT NULL UNIQUE,
        reset_at_utc   TEXT NOT NULL,
        event_count    INTEGER NOT NULL,
        events_sha256  TEXT NOT NULL,
        events_json    TEXT NOT NULL,
        reason         TEXT NOT NULL DEFAULT ''
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_cost_basis_book_resets_book
        ON cost_basis_book_resets(book_id, reset_at_utc DESC)
    """,
)

# Schema v8. One row per statement or execution batch the ledger accepted:
# what file, which account and period, which checks the importer could run.
# Coverage of a period is a fact about the ledger, not something recomputed
# from the rows it happened to add (a month with no trades adds none).
_V8_TABLE_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS cost_basis_import_batches (
        batch_id           TEXT PRIMARY KEY,
        book_id            TEXT NOT NULL,
        mode               TEXT NOT NULL,
        source_format      TEXT NOT NULL DEFAULT '',
        file_name          TEXT NOT NULL DEFAULT '',
        file_sha256        TEXT NOT NULL DEFAULT '',
        account            TEXT NOT NULL DEFAULT '',
        period_from        TEXT NOT NULL DEFAULT '',
        period_through     TEXT NOT NULL DEFAULT '',
        checks_json        TEXT NOT NULL DEFAULT '{}',
        inserted           INTEGER NOT NULL DEFAULT 0,
        skipped            INTEGER NOT NULL DEFAULT 0,
        confirmed_duplicates INTEGER NOT NULL DEFAULT 0,
        registered_at_utc  TEXT NOT NULL,
        ledger_digest      TEXT NOT NULL DEFAULT ''
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_cost_basis_import_batches_book
        ON cost_basis_import_batches(book_id, registered_at_utc DESC)
    """,
)

_V9_TABLE_STATEMENTS = (
    """CREATE TABLE IF NOT EXISTS cost_basis_reset_coverage (
        reset_id TEXT PRIMARY KEY, book_id TEXT NOT NULL,
        batches_json TEXT NOT NULL, batches_sha256 TEXT NOT NULL
    )""",
)

_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE cost_basis_books (
        book_id                     TEXT PRIMARY KEY,
        account                     TEXT NOT NULL,
        symbol                      TEXT NOT NULL,
        sec_type                    TEXT NOT NULL DEFAULT 'STK',
        currency                    TEXT NOT NULL DEFAULT 'USD',
        default_shares_per_contract INTEGER NOT NULL DEFAULT 100
                                    CHECK (default_shares_per_contract > 0),
        start_date                  TEXT NOT NULL,
        note                        TEXT NOT NULL DEFAULT '',
        created_at_utc              TEXT NOT NULL,
        updated_at_utc              TEXT NOT NULL,
        archived_at_utc             TEXT
    )
    """,
    """
    CREATE UNIQUE INDEX idx_cost_basis_books_account_symbol
        ON cost_basis_books(account COLLATE NOCASE, symbol, sec_type, currency)
        WHERE archived_at_utc IS NULL
    """,
    """
    CREATE TABLE cost_basis_events (
        event_id            TEXT PRIMARY KEY,
        book_id             TEXT NOT NULL
                            REFERENCES cost_basis_books(book_id),
        seq                 INTEGER NOT NULL,
        client_token        TEXT NOT NULL UNIQUE,
        kind                TEXT NOT NULL CHECK (kind IN (
                                'opening_balance','share_trade','option_trade',
                                'option_assignment','option_exercise',
                                'option_expiry','dividend','fee','split',
                                'manual_adjust','futures_trade','futures_roll',
                                'option_split')),
        trade_date          TEXT NOT NULL,
        broker_timestamp    TEXT,
        account             TEXT NOT NULL DEFAULT '',
        right               TEXT CHECK (right IN ('C','P') OR right IS NULL),
        strike              REAL,
        expiry              TEXT,
        con_id              INTEGER,
        local_symbol        TEXT,
        option_sec_type     TEXT CHECK (option_sec_type IN ('OPT','FOP')
                                        OR option_sec_type IS NULL),
        shares_per_contract INTEGER,
        contracts           REAL,
        shares              REAL,
        future_expiry       TEXT,
        future_con_id       INTEGER,
        future_local_symbol TEXT,
        future_contracts    REAL,
        roll_to_expiry       TEXT,
        roll_to_con_id       INTEGER,
        roll_to_local_symbol TEXT,
        roll_to_price        REAL,
        roll_group           TEXT,
        price               REAL,
        cash_amount         REAL NOT NULL,
        fees                REAL NOT NULL DEFAULT 0,
        split_ratio         REAL,
        split_group         TEXT,
        split_rule_ref      TEXT,
        split_rounding      TEXT,
        split_to_strike     REAL,
        split_to_contracts  REAL,
        split_to_con_id     INTEGER,
        split_to_local_symbol TEXT,
        split_standard_confirmed INTEGER NOT NULL DEFAULT 0
                            CHECK (split_standard_confirmed IN (0, 1)),
        include_in_cost     INTEGER NOT NULL DEFAULT 1
                            CHECK (include_in_cost IN (0, 1)),
        tag                 TEXT NOT NULL DEFAULT '',
        source              TEXT NOT NULL DEFAULT 'manual' CHECK (source IN (
                                'manual','reconcile','csv_import',
                                'execution_report')),
        external_ref        TEXT,
        import_batch_id     TEXT,
        derived_mismatch    INTEGER NOT NULL DEFAULT 0
                            CHECK (derived_mismatch IN (0, 1)),
        allow_overdraw      INTEGER NOT NULL DEFAULT 0
                            CHECK (allow_overdraw IN (0, 1)),
        note                TEXT NOT NULL DEFAULT '',
        created_at_utc      TEXT NOT NULL,
        voided_at_utc       TEXT,
        voided_by_event_id  TEXT,
        void_reason         TEXT
    )
    """,
    """
    CREATE UNIQUE INDEX idx_cost_basis_events_external
        ON cost_basis_events(book_id, account, external_ref)
        WHERE external_ref IS NOT NULL
    """,
    """
    CREATE UNIQUE INDEX idx_cost_basis_events_book_seq
        ON cost_basis_events(book_id, seq)
    """,
    """
    CREATE INDEX idx_cost_basis_events_book_date
        ON cost_basis_events(book_id, trade_date, broker_timestamp, seq)
    """,
    """
    CREATE INDEX idx_cost_basis_events_batch
        ON cost_basis_events(import_batch_id)
        WHERE import_batch_id IS NOT NULL
    """,
    """
    CREATE TABLE cost_basis_snapshots (
        snapshot_id       TEXT PRIMARY KEY,
        book_id           TEXT NOT NULL
                          REFERENCES cost_basis_books(book_id),
        taken_at_utc      TEXT NOT NULL,
        as_of_date        TEXT NOT NULL,
        account_scope     TEXT NOT NULL DEFAULT '',
        through_seq       INTEGER NOT NULL,
        event_count       INTEGER NOT NULL,
        events_sha256     TEXT NOT NULL,
        summary_json      TEXT NOT NULL,
        tws_snapshot_json TEXT,
        reconciled        INTEGER NOT NULL DEFAULT 0
                          CHECK (reconciled IN (0, 1)),
        note              TEXT NOT NULL DEFAULT ''
    )
    """,
    """
    CREATE INDEX idx_cost_basis_snapshots_book
        ON cost_basis_snapshots(book_id, taken_at_utc DESC)
    """,
) + _V2_TABLE_STATEMENTS + _V8_TABLE_STATEMENTS + _V9_TABLE_STATEMENTS

# Added by v10 after the four event indexes that _V3_EVENT_INDEX_STATEMENTS
# slices by position, so that slice stays valid.
_V10_EVENT_INDEX_STATEMENTS = (
    """
    CREATE INDEX idx_cost_basis_events_split_group
        ON cost_basis_events(book_id, split_group)
        WHERE split_group IS NOT NULL
    """,
)
_SCHEMA_STATEMENTS = _SCHEMA_STATEMENTS + _V10_EVENT_INDEX_STATEMENTS

# Reused by the v2 -> v4 table-rebuild migration. SQLite cannot extend the
# event-kind CHECK constraint with ALTER TABLE, so the event table is copied
# atomically into the v3 definition and all indexes are recreated.
_V4_BOOK_INDEX_SQL = """
    CREATE UNIQUE INDEX idx_cost_basis_books_symbol
        ON cost_basis_books(symbol, sec_type, currency)
        WHERE archived_at_utc IS NULL
"""
_V3_EVENT_TABLE_SQL = _SCHEMA_STATEMENTS[2]
_V3_EVENT_INDEX_STATEMENTS = _SCHEMA_STATEMENTS[3:7]

_EVENT_COLUMNS = (
    'event_id', 'book_id', 'seq', 'client_token', 'kind', 'trade_date',
    'broker_timestamp',
    'account', 'right', 'strike', 'expiry', 'con_id', 'local_symbol',
    'option_sec_type', 'shares_per_contract', 'contracts', 'shares',
    'future_expiry', 'future_con_id', 'future_local_symbol', 'future_contracts',
    'roll_to_expiry', 'roll_to_con_id', 'roll_to_local_symbol', 'roll_to_price',
    'roll_group', 'price', 'cash_amount',
    'fees', 'split_ratio', 'split_group', 'split_rule_ref', 'split_rounding',
    'split_to_strike', 'split_to_contracts', 'split_to_con_id',
    'split_to_local_symbol', 'split_standard_confirmed',
    'include_in_cost', 'tag', 'source', 'external_ref',
    'import_batch_id', 'derived_mismatch', 'allow_overdraw', 'note', 'created_at_utc',
    'voided_at_utc', 'voided_by_event_id', 'void_reason',
)

# The economic order of ledger rows, shared with the browser's
# compareEventOrder: trade date, then split phase (a split group applies at
# the open, before the day's fills), broker second or end of day, then seq.
# tests/fixtures/cost_basis_event_order_vectors.json holds the common cases.
_EVENT_ORDER_SQL = (
    "trade_date ASC, (split_group IS NULL) ASC, "
    "COALESCE(NULLIF(broker_timestamp, ''), "
    "trade_date || 'T23:59:59') ASC, seq ASC"
)

# Frozen for migrations that run before v10 created split_group.
_V9_EVENT_ORDER_SQL = (
    "trade_date ASC, COALESCE(NULLIF(broker_timestamp, ''), "
    "trade_date || 'T23:59:59') ASC, seq ASC"
)


def resolve_db_path(config=None, env=None, platform=None):
    """OPTION_COMBO_COST_BASIS_DB_PATH > config db_path > platform default."""
    import os

    env = env if env is not None else os.environ
    explicit = (env.get('OPTION_COMBO_COST_BASIS_DB_PATH') or '').strip()
    if explicit:
        return Path(explicit)
    if config is not None:
        try:
            configured = (config.get('cost_basis', 'db_path', fallback='') or '').strip()
        except Exception:
            configured = ''
        if configured:
            return Path(configured)
    return default_app_data_dir(platform=platform, env=env) / 'cost_basis.db'


# ----------------------------------------------------------------------
# Field validation
# ----------------------------------------------------------------------


def _require_token(name, value):
    if not isinstance(value, str) or not _TOKEN_RE.match(value):
        raise InvalidRequestError(f'{name} must match the restricted token format')
    return value


def _require_symbol(value):
    symbol = value.strip().upper() if isinstance(value, str) else ''
    if not symbol or not _SYMBOL_RE.match(symbol):
        raise InvalidRequestError('symbol must be 1-32 characters of A-Z, 0-9, dot or dash')
    return symbol


def _optional_account(value):
    if value is None or value == '':
        return ''
    if not isinstance(value, str):
        raise InvalidRequestError('account must be a string')
    account = value.strip()
    if not account:
        return ''
    if not _ACCOUNT_RE.match(account) or len(account) > MAX_ACCOUNT_CHARS:
        raise InvalidRequestError('account must be 1-32 alphanumeric characters')
    return account


def _require_account(value):
    account = _optional_account(value)
    if not account:
        raise InvalidRequestError('account is required')
    return account.upper()


def _require_trade_date(value, field='tradeDate'):
    if not isinstance(value, str) or not _TRADE_DATE_RE.match(value.strip()):
        raise InvalidRequestError(f'{field} must be formatted YYYY-MM-DD')
    text = value.strip()
    try:
        datetime.strptime(text, '%Y-%m-%d')
    except ValueError as exc:
        raise InvalidRequestError(f'{field} is not a real calendar date') from exc
    return text


def _optional_broker_timestamp(value, trade_date):
    if value in (None, ''):
        return None
    text = str(value).strip()
    if not _BROKER_TIMESTAMP_FIELD_RE.match(text):
        raise InvalidRequestError(
            'brokerTimestamp must be formatted YYYY-MM-DDTHH:MM:SS')
    try:
        datetime.strptime(text, '%Y-%m-%dT%H:%M:%S')
    except ValueError as exc:
        raise InvalidRequestError('brokerTimestamp is not a real local timestamp') from exc
    if text[:10] != trade_date:
        raise InvalidRequestError('brokerTimestamp date must equal tradeDate')
    return text


def _optional_expiry(value):
    if value is None or value == '':
        return None
    text = str(value).strip().replace('-', '')
    if not _EXPIRY_RE.match(text):
        raise InvalidRequestError('expiry must be formatted YYYYMMDD')
    try:
        datetime.strptime(text, '%Y%m%d')
    except ValueError as exc:
        raise InvalidRequestError('expiry is not a real calendar date') from exc
    return text


def _optional_contract_month(value, field='futureExpiry'):
    if value is None or value == '':
        return None
    text = str(value).strip().replace('-', '')
    if not _CONTRACT_MONTH_RE.match(text):
        raise InvalidRequestError(f'{field} must be formatted YYYYMM or YYYYMMDD')
    try:
        if len(text) == 6:
            datetime.strptime(text, '%Y%m')
        else:
            datetime.strptime(text, '%Y%m%d')
    except ValueError as exc:
        raise InvalidRequestError(f'{field} is not a real contract month/date') from exc
    return text


def _optional_text(value, field, limit):
    if value is None:
        return ''
    if not isinstance(value, str):
        raise InvalidRequestError(f'{field} must be a string')
    text = value.strip()
    if len(text) > limit:
        raise InvalidRequestError(f'{field} must be at most {limit} characters')
    return text


def _number(value, field, *, allow_none=True):
    if value is None or value == '':
        if allow_none:
            return None
        raise InvalidRequestError(f'{field} is required')
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise InvalidRequestError(f'{field} must be a number') from exc
    if number != number or number in (float('inf'), float('-inf')):
        raise InvalidRequestError(f'{field} must be a finite number')
    return round(number, 6)


def _json_for_storage(value, field):
    """Encode browser-visible JSON without JavaScript-invalid NaN tokens."""
    try:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True,
            separators=(',', ':'), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise InvalidRequestError(
            f'{field} must contain only JSON values and finite numbers') from exc


def _json_from_snapshot(value):
    """Keep legacy non-finite snapshots listable as valid JSON responses."""
    if value in (None, ''):
        return None
    return json.loads(value, parse_constant=lambda _constant: None)


def _positive_int(value, field, *, allow_none=True):
    if value is None or value == '':
        if allow_none:
            return None
        raise InvalidRequestError(f'{field} is required')
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise InvalidRequestError(f'{field} must be an integer') from exc
    if number <= 0:
        raise InvalidRequestError(f'{field} must be a positive integer')
    return number


def _require_nonzero(value, field):
    if value is None or abs(value) < 1e-9:
        raise InvalidRequestError(f'{field} must be a non-zero number')
    return value


def contract_key(event):
    """Identity of one option contract within one account.

    Strike is rounded because a ledger row and a TWS snapshot must land on
    the same key even when one of them carries float noise. The deliverable
    size is part of the identity: an adjusted contract shares a strike and
    an expiry with the standard one but delivers a different number of
    shares, and merging them would validate one against the other.
    """
    strike = event.get('strike')
    strike_text = '' if strike is None else f'{round(float(strike), 4):.4f}'
    per_contract = event.get('sharesPerContract', event.get('shares_per_contract'))
    return '|'.join((
        str(event.get('account') or ''),
        str(event.get('right') or ''),
        strike_text,
        str(event.get('expiry') or ''),
        '' if per_contract in (None, '') else str(abs(int(per_contract))),
    ))


def future_key(event, *, roll_target=False):
    """Structural identity of one FUT month inside an account."""
    def pick(*names):
        for name in names:
            try:
                value = event[name]
            except (KeyError, IndexError, TypeError):
                value = event.get(name) if hasattr(event, 'get') else None
            if value not in (None, ''):
                return value
        return None

    expiry = pick(
        'rollToExpiry' if roll_target else 'futureExpiry',
        'roll_to_expiry' if roll_target else 'future_expiry')
    multiplier = pick('sharesPerContract', 'shares_per_contract')
    return '|'.join((
        str(pick('account') or ''),
        str(expiry or '').replace('-', '')[:6],
        '' if multiplier in (None, '') else str(abs(int(multiplier))),
    ))


def _normalized_local_symbol(value):
    """Ignore presentation-only whitespace when comparing broker identities."""
    return ' '.join(str(value or '').split()).upper()


def _resolve_contract_identity_rows(rows, epoch_of=None):
    """Group one structural contract timeline by its real broker identity.

    A row without conId/localSymbol may join an identified contract only
    when the structural group has exactly one possible identity. With two
    concrete contracts it stays ambiguous instead of closing whichever row
    happens to sort first.

    `epoch_of(row)` optionally names the row's split epoch (see
    _split_epoch_of). Identities never span epochs: after a 2:1 split the
    old K100 trades as K50 while the old K50 became K25, so two different
    contracts share this structural key. A non-zero epoch is appended to
    the identity so their running positions stay apart.
    """
    rows = list(rows)
    if epoch_of is not None:
        epochs = [int(epoch_of(row) or 0) for row in rows]
        if any(epochs):
            partitions = {}
            for index, epoch in enumerate(epochs):
                partitions.setdefault(epoch, []).append(index)
            resolved = [None] * len(rows)
            for epoch, indexes in partitions.items():
                part = _resolve_contract_identity_rows([rows[i] for i in indexes])
                for index, (row, identity, ambiguous) in zip(indexes, part):
                    resolved[index] = (
                        row, f'{identity}@s{epoch}' if epoch else identity, ambiguous)
            return resolved
    con_ids = {
        str(row['con_id']) for row in rows
        if row['con_id'] not in (None, '')
    }
    local_symbols = {
        _normalized_local_symbol(row['local_symbol']) for row in rows
        if row['local_symbol']
    }
    local_to_con_ids = {}
    for row in rows:
        if row['con_id'] in (None, '') or not row['local_symbol']:
            continue
        local_symbol = _normalized_local_symbol(row['local_symbol'])
        local_to_con_ids.setdefault(local_symbol, set()).add(str(row['con_id']))

    resolved = []
    for row in rows:
        con_id = '' if row['con_id'] in (None, '') else str(row['con_id'])
        local_symbol = _normalized_local_symbol(row['local_symbol'])
        ambiguous = False
        if con_id:
            identity = f'con:{con_id}'
        elif con_ids:
            mapped = local_to_con_ids.get(local_symbol, set()) if local_symbol else set()
            if len(mapped) == 1:
                identity = f'con:{next(iter(mapped))}'
            elif not local_symbol and len(con_ids) == 1:
                identity = f'con:{next(iter(con_ids))}'
            else:
                identity = f'ambiguous:{local_symbol}' if local_symbol else 'ambiguous'
                ambiguous = True
        elif local_symbol:
            identity = f'local:{local_symbol}'
        elif len(local_symbols) == 1:
            identity = f'local:{next(iter(local_symbols))}'
        elif len(local_symbols) > 1:
            identity = 'ambiguous'
            ambiguous = True
        else:
            identity = 'structural'
        resolved.append((row, identity, ambiguous))
    return resolved


def _split_epoch_of(conn, book_id, account):
    """Map a row of one account to its split epoch, or None without groups.

    The epoch counts the applied split groups (their `split` header rows)
    before the row. A row on a group's own trade date is post-split because
    the group sorts first; a group's own rows sit on the pre-split side.
    Legacy split rows carry no group and start no epoch. Mirrors the
    browser core's splitEpochs.
    """
    dates = [row['trade_date'] for row in conn.execute(
        "SELECT trade_date FROM cost_basis_events WHERE book_id = ? AND account = ? "
        "AND kind = 'split' AND split_group IS NOT NULL AND voided_at_utc IS NULL "
        "AND include_in_cost = 1 ORDER BY trade_date",
        (book_id, account)).fetchall()]
    if not dates:
        return None

    def epoch_of(row):
        side = row.get('side') if isinstance(row, dict) else None
        if side == 'split_in':
            return bisect_left(dates, row['trade_date']) + 1
        if row['split_group']:
            return bisect_left(dates, row['trade_date'])
        return bisect_right(dates, row['trade_date'])
    return epoch_of


def _upper_text(value):
    return ' '.join(str('' if value is None else value).split()).upper()


def _is_standard_split_ratio(ratio):
    if isinstance(ratio, bool) or not isinstance(ratio, (int, float)):
        return False
    return float(ratio).is_integer() and 2 <= ratio <= MAX_SPLIT_RATIO


def _strike_cents(value):
    """A strike as exact integer cents, or None when it is not a whole cent.

    Mirrors the browser core's strikeToCents: decimal text is read exactly,
    a stored number at eight decimals, and nothing is rounded to a cent.
    """
    if value is None or value == '' or isinstance(value, bool):
        return None
    if isinstance(value, str):
        match = re.fullmatch(r'(\d+)(?:\.(\d+))?', value.strip())
        if not match:
            return None
        whole, fraction = match.group(1), match.group(2) or ''
    else:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(number) or number <= 0:
            return None
        whole, fraction = f'{number:.8f}'.split('.')
    if fraction[2:].strip('0'):
        return None
    cents = int(whole) * 100 + int(fraction[:2].ljust(2, '0'))
    return cents if 0 < cents <= (1 << 53) - 1 else None


def _split_strike_cents(cents, ratio):
    """The adjusted strike of a standard n:1 split, in integer cents.

    Integer division with half-up rounding of the remainder, the rule OCC
    memo #57592 applies to all 167 of its series. Mirrors splitStrikeCents.
    """
    if isinstance(cents, bool) or not isinstance(cents, int) or cents <= 0:
        return None
    if not _is_standard_split_ratio(ratio):
        return None
    quotient, remainder = divmod(cents, int(ratio))
    adjusted = quotient + 1 if 2 * remainder >= int(ratio) else quotient
    return adjusted if adjusted > 0 else None


def _option_root(local_symbol):
    """The option root of an OCC or IBKR local symbol (`2TQQQ` stays itself)."""
    text = _upper_text(local_symbol)
    if not text:
        return ''
    occ = re.fullmatch(r'([A-Z0-9.]{1,6}) ?\d{6}[CP]\d{8}', text)
    if occ:
        return occ.group(1)
    lead = re.match(r'[A-Z0-9][A-Z0-9.\-]*', text)
    return lead.group(0) if lead else ''


def _refuse_split_group_rows(rows):
    """Split groups are written and voided only as a whole group."""
    for row in rows:
        if row['kind'] == 'option_split' or row['split_group'] is not None:
            raise InvalidRequestError(
                'a split with its option conversions is recorded as one split group '
                '(append_split_group), not row by row or from a statement')


def _row_strikes(row):
    """The strikes one option row touches: an option_split touches two."""
    if row['kind'] == 'option_split':
        return [row['strike'], row['split_to_strike']]
    return [row['strike']]


def _option_movements(row):
    """The option position changes one stored row makes.

    An `option_split` row moves its series out and the adjusted series in;
    any code walking contract positions must read rows through this or it
    sees only the outgoing half. Mirrors the browser core's optionMovements.
    """
    def field(name):
        try:
            return row[name]
        except (KeyError, IndexError):
            return None
    kind = field('kind')
    base = {
        'kind': kind, 'account': field('account'), 'right': field('right'),
        'strike': field('strike'), 'expiry': field('expiry'),
        'shares_per_contract': field('shares_per_contract'),
        'con_id': field('con_id'), 'local_symbol': field('local_symbol'),
        'contracts': field('contracts'),
    }
    if kind == 'option_split':
        return [
            {**base, 'side': 'split_out'},
            {**base, 'side': 'split_in', 'strike': field('split_to_strike'),
             'con_id': field('split_to_con_id'),
             'local_symbol': field('split_to_local_symbol'),
             'contracts': field('split_to_contracts')},
        ]
    if kind in OPTION_KINDS:
        return [{**base, 'side': 'trade'}]
    return []


_BROKER_TIMESTAMP_RE = re.compile(
    r'(\d{4}-\d{2}-\d{2})[,\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?')


def _exact_event_timestamp(event):
    """Return broker-clock evidence only, including trusted legacy audit notes."""
    for field in ('brokerTimestamp', 'broker_timestamp'):
        try:
            explicit = event[field]
        except (KeyError, IndexError, TypeError):
            explicit = event.get(field) if hasattr(event, 'get') else None
        if explicit and _BROKER_TIMESTAMP_FIELD_RE.match(str(explicit)):
            return str(explicit)
    source = event.get('source') if hasattr(event, 'get') else event['source']
    tag = event.get('tag') if hasattr(event, 'get') else event['tag']
    trusted_note = source in ('csv_import', 'execution_report') \
        or (source == 'reconcile' and tag == 'tws_snapshot')
    if trusted_note:
        note = str(event.get('note') or '')
        match = _BROKER_TIMESTAMP_RE.search(note)
        if match:
            return (
                f'{match.group(1)}T{match.group(2).zfill(2)}:'
                f'{match.group(3)}:{match.group(4) or "00"}'
            )

    # SQLite insertion time is not the broker snapshot time, even when both
    # happen on the same date. Match the page: no clock means date-level
    # ambiguity; only the explicit targeted quantity proof can resolve it.
    return ''


def _event_precedes_tws_snapshot(event, baseline):
    exact_snapshot = _exact_event_timestamp(baseline)
    if exact_snapshot:
        exact_event = _exact_event_timestamp(event)
        if exact_event:
            return exact_event <= exact_snapshot
        return event['trade_date'] < baseline['tradeDate']
    # Without a broker clock, same-day ordering remains ambiguous.
    return event['trade_date'] < baseline['tradeDate']


def _event_may_overlap_tws_snapshot(event, baseline):
    """True when a CSV row is before, or ambiguously on, the snapshot."""
    exact_snapshot = _exact_event_timestamp(baseline)
    exact_event = _exact_event_timestamp(event)
    if exact_snapshot and exact_event:
        return exact_event <= exact_snapshot
    return event['trade_date'] <= baseline['tradeDate']


def _single_execution_reconstructs_option_baseline(baseline, matching,
                                                   incoming_rows):
    """Prove that one API fill is the exact economics behind a baseline."""
    baseline_contracts = float(baseline.get('contracts') or 0)
    baseline_cash = baseline.get('cashAmount')
    if baseline_cash is None:
        return False
    baseline_cash = float(baseline_cash)
    for item in matching:
        if (item['source'] != 'execution_report' or item['tag'] != 'ibkr_exec'
                or abs(float(item['contracts'] or 0) - baseline_contracts) >= 1e-6):
            continue
        execution_cash = float(item['cash_amount'] or 0)
        rebate_ref = f"{item['external_ref'] or ''}-rebate"
        execution_cash += sum(
            float(row['cash_amount'] or 0) for row in incoming_rows
            if row['source'] == 'execution_report'
            and row['tag'] == 'ibkr_rebate'
            and row['external_ref'] == rebate_ref
        )
        if abs(execution_cash - baseline_cash) < 0.011:
            return True
    return False


def _future_deltas(event):
    """All signed FUT position movements carried by one normalized event."""
    kind = event.get('kind') if hasattr(event, 'get') else event['kind']
    if hasattr(event, 'get'):
        contracts = event.get('future_contracts')
        if contracts is None:
            contracts = event.get('futureContracts')
    else:
        contracts = event['future_contracts']
    if contracts in (None, 0):
        return []
    contracts = float(contracts)
    if kind == 'futures_roll':
        return [
            (future_key(event), -contracts),
            (future_key(event, roll_target=True), contracts),
        ]
    return [(future_key(event), contracts)]


def _future_con_id_for_key(event, key):
    """Broker identity carried by the side of an event matching ``key``."""
    if event['kind'] == 'futures_roll' and future_key(
            event, roll_target=True) == key:
        return event['roll_to_con_id']
    return event['future_con_id']


def derive_cash_amount(event):
    """The cash a row implies, or None when the kind has no derivation.

    One formula covers both directions: selling five puts at 1.20 gives
    contracts = -5 and therefore a positive cash amount.
    """
    kind = event.get('kind')
    fees = float(event.get('fees') or 0)
    if kind in ('share_trade', 'opening_balance'):
        shares = event.get('shares')
        price = event.get('price')
        if shares is None or price is None:
            return None
        return round(-(float(shares) * float(price)) - fees, 6)
    if kind == 'option_trade':
        contracts = event.get('contracts')
        price = event.get('price')
        spc = event.get('sharesPerContract')
        if contracts is None or price is None or not spc:
            return None
        return round(-(float(contracts) * float(spc) * float(price)) - fees, 6)
    if kind in ('futures_trade', 'futures_roll'):
        # A futures fill has no notional cash purchase. Daily variation margin
        # is deliberately outside this ledger; price differences are carried
        # by the futures cost engine and only the explicit fee is cash here.
        return round(-fees, 6)
    if kind in ('option_assignment', 'option_exercise'):
        if str(event.get('optionSecType') or '').upper() == 'FOP':
            # An FOP delivery opens a FUT at the strike; no shares or notional
            # cash move on this row. The premium is already on its trade rows.
            return round(-fees, 6)
        # The premium was banked when the contract was opened; an
        # assignment row is purely the share delivery at the strike.
        shares = event.get('shares')
        strike = event.get('strike')
        if shares is None or strike is None:
            return None
        return round(-(float(shares) * float(strike)) - fees, 6)
    if kind == 'option_expiry':
        return round(-fees, 6)
    if kind in ('split', 'option_split'):
        return 0.0
    return None


def _validate_split_group_row(event, kind, book):
    """Shape of one split-group row; the group as a whole is checked later.

    Everything a standard split implies is derived and compared here rather
    than trusted: the destination strike is the integer-cent rule applied to
    the source strike, and the incoming contracts are the outgoing ones
    times the ratio with the sign flipped.
    """
    if str(book.get('secType') or 'STK').upper() != 'STK':
        raise InvalidRequestError('split groups apply to STK ledgers only')
    if not event['split_group']:
        raise InvalidRequestError(f'{kind} in a split group requires splitGroup')
    if not event['account']:
        raise InvalidRequestError('a split group must belong to one account')
    if event['broker_timestamp'] is not None:
        raise InvalidRequestError(
            'a split group applies at the open of its trade date and carries no '
            'broker time')
    if abs(event['cash_amount']) > 1e-9 or event['fees']:
        raise InvalidRequestError('a split group moves no cash and no fees')
    if not event['include_in_cost']:
        raise InvalidRequestError('a split group cannot be excluded row by row')
    if event['price'] is not None or event['shares'] is not None:
        raise InvalidRequestError('a split group row carries no price or shares')
    ratio = event['split_ratio']
    if not _is_standard_split_ratio(ratio):
        raise InvalidRequestError(
            f'a split group needs an integer forward ratio between 2 and {MAX_SPLIT_RATIO}')
    event['split_ratio'] = float(ratio)
    option_fields = ('right', 'strike', 'expiry', 'con_id', 'local_symbol',
                     'option_sec_type', 'shares_per_contract', 'contracts')
    target_fields = ('split_to_strike', 'split_to_contracts', 'split_to_con_id',
                     'split_to_local_symbol')
    if kind == 'split':
        if not event['split_rule_ref']:
            raise InvalidRequestError(
                'a split group header requires splitRuleRef (for example the OCC memo)')
        if event['split_rounding'] not in SPLIT_ROUNDING_MODES:
            raise InvalidRequestError(
                'splitRounding must be one of ' + ', '.join(SPLIT_ROUNDING_MODES))
        if any(event[field] is not None for field in option_fields + target_fields) \
                or event['split_standard_confirmed']:
            raise InvalidRequestError('a split group header carries no option series')
        return
    if event['split_rule_ref'] is not None or event['split_rounding'] is not None:
        raise InvalidRequestError(
            'the rule reference and rounding live on the split group header only')
    for field, name in (('right', 'right'), ('strike', 'strike'), ('expiry', 'expiry'),
                        ('split_to_strike', 'splitToStrike'),
                        ('split_to_contracts', 'splitToContracts')):
        if event[field] is None:
            raise InvalidRequestError(f'option_split requires {name}')
    if (event['option_sec_type'] or 'OPT') != 'OPT':
        raise InvalidRequestError('option_split converts equity options (OPT) only')
    event['option_sec_type'] = 'OPT'
    if event['shares_per_contract'] is None:
        event['shares_per_contract'] = book['defaultSharesPerContract']
    _require_nonzero(event['contracts'], 'contracts')
    source_cents = _strike_cents(event['strike'])
    if source_cents is None:
        raise InvalidRequestError('option_split needs a whole-cent source strike')
    target_cents = _split_strike_cents(source_cents, ratio)
    if target_cents is None or _strike_cents(event['split_to_strike']) != target_cents:
        raise InvalidRequestError(
            f"splitToStrike must be {(target_cents or 0) / 100:g}: the source strike "
            f"{event['strike']:g} divided by {ratio:g} in integer cents, rounded half up")
    event['split_to_strike'] = target_cents / 100
    expected = -event['contracts'] * ratio
    if abs(event['split_to_contracts'] - expected) > 1e-9:
        raise InvalidRequestError(
            f"splitToContracts must be {expected:g}: the outgoing contracts times "
            f"{ratio:g}, keeping the position's direction")


def _validate_event_shape(payload, book):
    """Normalize one client event dict into stored column values."""
    if not isinstance(payload, dict):
        raise InvalidRequestError('event must be an object')

    kind = payload.get('kind')
    if kind not in EVENT_KINDS:
        raise InvalidRequestError(f'kind must be one of {", ".join(EVENT_KINDS)}')

    source = payload.get('source', 'manual')
    if source not in EVENT_SOURCES:
        raise InvalidRequestError(f'source must be one of {", ".join(EVENT_SOURCES)}')

    right = payload.get('right')
    if right in (None, ''):
        right = None
    else:
        right = str(right).strip().upper()[:1]
        if right not in ('C', 'P'):
            raise InvalidRequestError('right must be C or P')

    book_sec_type = str(book.get('secType') or 'STK').upper()
    option_sec_type = str(payload.get('optionSecType') or '').strip().upper()
    if kind in OPTION_KINDS and not option_sec_type:
        option_sec_type = 'FOP' if book_sec_type == 'FUT' else 'OPT'
    if option_sec_type and option_sec_type not in ('OPT', 'FOP'):
        raise InvalidRequestError('optionSecType must be OPT or FOP')

    trade_date = _require_trade_date(payload.get('tradeDate'))
    event = {
        'kind': kind,
        'trade_date': trade_date,
        'broker_timestamp': _optional_broker_timestamp(
            payload.get('brokerTimestamp'), trade_date),
        'account': _optional_account(payload.get('account')),
        'right': right,
        'strike': _number(payload.get('strike'), 'strike'),
        'expiry': _optional_expiry(payload.get('expiry')),
        'con_id': _positive_int(payload.get('conId'), 'conId'),
        'local_symbol': _optional_text(
            payload.get('localSymbol'), 'localSymbol', MAX_LOCAL_SYMBOL_CHARS) or None,
        'option_sec_type': option_sec_type or None,
        'shares_per_contract': _positive_int(
            payload.get('sharesPerContract'), 'sharesPerContract'),
        'contracts': _number(payload.get('contracts'), 'contracts'),
        'shares': _number(payload.get('shares'), 'shares'),
        'future_expiry': _optional_contract_month(payload.get('futureExpiry')),
        'future_con_id': _positive_int(payload.get('futureConId'), 'futureConId'),
        'future_local_symbol': _optional_text(
            payload.get('futureLocalSymbol'), 'futureLocalSymbol',
            MAX_LOCAL_SYMBOL_CHARS) or None,
        'future_contracts': _number(payload.get('futureContracts'), 'futureContracts'),
        'roll_to_expiry': _optional_contract_month(
            payload.get('rollToExpiry'), 'rollToExpiry'),
        'roll_to_con_id': _positive_int(payload.get('rollToConId'), 'rollToConId'),
        'roll_to_local_symbol': _optional_text(
            payload.get('rollToLocalSymbol'), 'rollToLocalSymbol',
            MAX_LOCAL_SYMBOL_CHARS) or None,
        'roll_to_price': _number(payload.get('rollToPrice'), 'rollToPrice'),
        'roll_group': _optional_text(
            payload.get('rollGroup'), 'rollGroup', MAX_EXTERNAL_REF_CHARS) or None,
        'price': _number(payload.get('price'), 'price'),
        'cash_amount': _number(payload.get('cashAmount'), 'cashAmount', allow_none=False),
        'fees': _number(payload.get('fees'), 'fees') or 0.0,
        'split_ratio': _number(payload.get('splitRatio'), 'splitRatio'),
        'split_group': _optional_text(
            payload.get('splitGroup'), 'splitGroup', MAX_EXTERNAL_REF_CHARS) or None,
        'split_rule_ref': _optional_text(
            payload.get('splitRuleRef'), 'splitRuleRef', MAX_SPLIT_RULE_REF_CHARS) or None,
        'split_rounding': _optional_text(
            payload.get('splitRounding'), 'splitRounding', MAX_TAG_CHARS) or None,
        'split_to_strike': _number(payload.get('splitToStrike'), 'splitToStrike'),
        'split_to_contracts': _number(payload.get('splitToContracts'), 'splitToContracts'),
        'split_to_con_id': _positive_int(payload.get('splitToConId'), 'splitToConId'),
        'split_to_local_symbol': _optional_text(
            payload.get('splitToLocalSymbol'), 'splitToLocalSymbol',
            MAX_LOCAL_SYMBOL_CHARS) or None,
        'split_standard_confirmed': 1 if payload.get('splitStandardConfirmed') is True else 0,
        'include_in_cost': 0 if payload.get('includeInCost') is False else 1,
        'tag': _optional_text(payload.get('tag'), 'tag', MAX_TAG_CHARS),
        'source': source,
        'external_ref': _optional_text(
            payload.get('externalRef'), 'externalRef', MAX_EXTERNAL_REF_CHARS) or None,
        'note': _optional_text(payload.get('note'), 'note', MAX_NOTE_CHARS),
    }

    if kind == 'option_split' or (kind == 'split' and event['split_group'] is not None):
        _validate_split_group_row(event, kind, book)
    elif any(event[field] is not None for field in SPLIT_GROUP_FIELDS) \
            or event['split_standard_confirmed']:
        raise InvalidRequestError('split-group fields belong only to split group rows')

    if event['price'] is not None and event['price'] < 0 \
            and kind not in FUTURE_KINDS:
        raise InvalidRequestError('price must not be negative')
    if event['roll_to_price'] is not None and event['roll_to_price'] < 0 \
            and kind != 'futures_roll':
        raise InvalidRequestError('rollToPrice must not be negative')
    if event['strike'] is not None and event['strike'] <= 0:
        raise InvalidRequestError('strike must be a positive number')
    if event['fees'] < 0:
        raise InvalidRequestError('fees must not be negative; use a fee event for a rebate')

    if book_sec_type == 'STK':
        if kind in FUTURE_KINDS or option_sec_type == 'FOP' or any(
                event[field] is not None for field in (
                    'future_expiry', 'future_con_id', 'future_local_symbol',
                    'future_contracts', 'roll_to_expiry', 'roll_to_con_id',
                    'roll_to_local_symbol', 'roll_to_price', 'roll_group')):
            raise InvalidRequestError('STK ledgers cannot contain FOP/FUT events')
    elif book_sec_type == 'FUT':
        if kind in ('opening_balance', 'share_trade', 'dividend', 'split'):
            raise InvalidRequestError(
                f'FUT ledgers cannot contain {kind}; use futures/FOP events')
        if kind in OPTION_KINDS and option_sec_type != 'FOP':
            raise InvalidRequestError('FUT ledgers accept FOP option events only')

    if kind in OPTION_KINDS:
        if event['right'] is None:
            raise InvalidRequestError(f'{kind} requires right')
        if event['strike'] is None:
            raise InvalidRequestError(f'{kind} requires strike')
        if event['expiry'] is None:
            raise InvalidRequestError(f'{kind} requires expiry')
        _require_nonzero(event['contracts'], 'contracts')
        if event['shares_per_contract'] is None:
            event['shares_per_contract'] = book['defaultSharesPerContract']

    if kind == 'option_trade' and event['price'] is None:
        raise InvalidRequestError('option_trade requires price (premium per share)')

    if kind in ('opening_balance', 'share_trade'):
        _require_nonzero(event['shares'], 'shares')
        if event['price'] is None:
            raise InvalidRequestError(f'{kind} requires price')

    if kind in ('option_assignment', 'option_exercise'):
        # The strike is the delivered underlying's entry price. For OPT this
        # is a share delivery; for FOP it is a futures entry with no notional
        # cash movement.
        event['price'] = event['strike']
        if option_sec_type == 'FOP':
            if event['shares'] not in (None, 0):
                raise InvalidRequestError('FOP delivery must not move shares')
            event['shares'] = None
            _require_nonzero(event['future_contracts'], 'futureContracts')
            if not event['future_expiry']:
                raise InvalidRequestError('FOP delivery requires futureExpiry')
            _validate_fop_delivery_direction(kind, event)
        else:
            _require_nonzero(event['shares'], 'shares')
            _validate_delivery_direction(kind, event)

    if kind == 'option_expiry':
        if event['shares'] not in (None, 0):
            raise InvalidRequestError(
                'option_expiry must not move shares; record an assignment instead')
        event['shares'] = None
        if event['future_contracts'] not in (None, 0):
            raise InvalidRequestError('option_expiry must not move futures')
        event['future_contracts'] = None

    if kind == 'futures_trade':
        _require_nonzero(event['future_contracts'], 'futureContracts')
        if event['price'] is None:
            raise InvalidRequestError('futures_trade requires price')
        if not event['future_expiry']:
            raise InvalidRequestError('futures_trade requires futureExpiry')
        if event['shares_per_contract'] is None:
            event['shares_per_contract'] = book['defaultSharesPerContract']

    if kind == 'futures_roll':
        _require_nonzero(event['future_contracts'], 'futureContracts')
        if event['price'] is None or event['roll_to_price'] is None:
            raise InvalidRequestError(
                'futures_roll requires old close price and rollToPrice')
        if not event['future_expiry'] or not event['roll_to_expiry']:
            raise InvalidRequestError(
                'futures_roll requires futureExpiry and rollToExpiry')
        if event['future_expiry'] == event['roll_to_expiry'] \
                and event['future_con_id'] == event['roll_to_con_id'] \
                and event['future_local_symbol'] == event['roll_to_local_symbol']:
            raise InvalidRequestError('futures_roll must move to a different contract')
        if not event['roll_group']:
            raise InvalidRequestError('futures_roll requires rollGroup')
        if event['shares_per_contract'] is None:
            event['shares_per_contract'] = book['defaultSharesPerContract']

    if kind == 'split':
        ratio = event['split_ratio']
        if ratio is None or ratio <= 0:
            raise InvalidRequestError('split requires a positive splitRatio')
        if abs(event['cash_amount']) > 1e-9:
            raise InvalidRequestError('split must not carry cash; record a fee event instead')

    if kind == 'manual_adjust':
        if not event['note']:
            raise InvalidRequestError(
                'manual_adjust requires a note explaining the adjustment')
        forbidden = (
            'right', 'strike', 'expiry', 'con_id', 'local_symbol',
            'option_sec_type', 'shares_per_contract', 'contracts', 'shares',
            'future_expiry', 'future_con_id', 'future_local_symbol',
            'future_contracts', 'roll_to_expiry', 'roll_to_con_id',
            'roll_to_local_symbol', 'roll_to_price', 'roll_group', 'price',
            'split_ratio',
        )
        if any(event[field] is not None for field in forbidden):
            raise InvalidRequestError(
                'manual_adjust is cash-only; use a typed position event for quantities')

    if kind in ('dividend', 'fee') and abs(event['cash_amount']) < 1e-9:
        raise InvalidRequestError(f'{kind} requires a non-zero cashAmount')
    if kind == 'dividend' and event['cash_amount'] < 0 \
            and event['tag'] != DIVIDEND_REVERSAL_TAG:
        raise InvalidRequestError(
            'dividend cashAmount must be positive; a broker reversal must carry the '
            f'tag {DIVIDEND_REVERSAL_TAG}, and a charge is a fee event')
    if kind == 'fee' and event['cash_amount'] > 0 and event['tag'] not in FEE_REFUND_TAGS:
        raise InvalidRequestError(
            'fee cashAmount must be negative unless the row is a refund tagged one of '
            + ', '.join(sorted(FEE_REFUND_TAGS)))

    derived = derive_cash_amount({
        **event,
        'sharesPerContract': event['shares_per_contract'],
        'optionSecType': event['option_sec_type'],
    })
    mismatch = (
        derived is not None
        and abs(derived - event['cash_amount']) > CASH_DERIVATION_TOLERANCE
    )
    if mismatch and (kind in DELIVERY_KINDS or kind in FUTURE_KINDS):
        # A trade's settlement can legitimately sit a cent or two away from
        # the theoretical figure, so those rows are only flagged. A delivery
        # cannot: its cash is exactly the shares at the strike, plus fees
        # already carried in their own column. A wrong figure here silently
        # re-counts the premium that the opening event already recorded -
        # the one invariant this ledger exists to protect - so it is refused.
        tolerance = max(DELIVERY_CASH_TOLERANCE, abs(derived) * 1e-6)
        if abs(derived - event['cash_amount']) > tolerance:
            if kind in FUTURE_KINDS:
                raise InvalidRequestError(
                    f'{kind} cash {event["cash_amount"]:.2f} must be '
                    f'{derived:.2f} (fees only); futures notional and variation '
                    f'margin are not cash purchases in this ledger'
                )
            if kind == 'option_expiry':
                raise InvalidRequestError(
                    f'option_expiry cash {event["cash_amount"]:.2f} must be '
                    f'{derived:.2f} (fees only); an expiring contract settles '
                    f'no cash, and the premium is already recorded on the '
                    f'opening event'
                )
            if option_sec_type == 'FOP':
                raise InvalidRequestError(
                    f'{kind} cash {event["cash_amount"]:.2f} must be '
                    f'{derived:.2f} (fees only); an FOP delivery opens a FUT '
                    f'at the strike and does not pay its notional value'
                )
            raise InvalidRequestError(
                f'{kind} cash {event["cash_amount"]:.2f} does not match the '
                f'delivery of {event["shares"]:g} shares at {event["strike"]:g} '
                f'({derived:.2f}); the premium is already recorded on the '
                f'opening event and must not be counted again'
            )
    event['derived_mismatch'] = 1 if mismatch else 0
    event['derived_cash_amount'] = derived
    return event


def _bind_event_to_book_account(payload, book):
    """Apply and enforce the account boundary of a v5 book.

    Account-less books are legacy v4 books that may already contain several
    accounts, so their historical behavior is preserved. Every v5-created
    book has an account; an omitted event account inherits it, while a
    different account is rejected before any timeline or cash validation.
    """
    if not isinstance(payload, dict):
        return payload
    book_account = str(book.get('account') or '').strip()
    if not book_account:
        return payload
    event_account = _optional_account(payload.get('account'))
    if event_account and event_account.upper() != book_account.upper():
        raise InvalidRequestError(
            f'event account {event_account} does not match ledger account '
            f'{book_account}')
    return {**payload, 'account': book_account}


def _validate_fop_delivery_direction(kind, event):
    """Validate the FUT created by an FOP assignment/exercise.

    IBKR-listed FOPs normally deliver one FUT per option. The actual CSV/TWS
    quantity is nevertheless stored explicitly and checked rather than
    inferred from the point-value multiplier.
    """
    contracts = event['contracts']
    future_contracts = event['future_contracts']
    right = event['right']
    if kind == 'option_assignment' and contracts <= 0:
        raise InvalidRequestError(
            'FOP option_assignment must close a short, so contracts must be positive')
    if kind == 'option_exercise' and contracts >= 0:
        raise InvalidRequestError(
            'FOP option_exercise must close a long, so contracts must be negative')
    expect_positive = right == ('P' if kind == 'option_assignment' else 'C')
    if expect_positive != (future_contracts > 0):
        raise InvalidRequestError(
            f'{kind} on FOP {right} has the wrong delivered FUT direction')
    if abs(abs(future_contracts) - abs(contracts)) > 1e-6:
        raise InvalidRequestError(
            f'{kind} delivers {abs(future_contracts):g} FUT contracts but closes '
            f'{abs(contracts):g} FOP contracts; expected one FUT per FOP')


def _validate_delivery_direction(kind, event):
    """Assignment closes a short; exercise closes a long. Both deliver
    shares in a direction fixed by the right, and the share count must be
    exactly contracts x multiplier - a mismatch there is the single most
    common data-entry error and it silently distorts the cost."""
    contracts = event['contracts']
    shares = event['shares']
    right = event['right']
    spc = event['shares_per_contract']

    if kind == 'option_assignment' and contracts <= 0:
        raise InvalidRequestError(
            'option_assignment must close a short position, so contracts must be positive')
    if kind == 'option_exercise' and contracts >= 0:
        raise InvalidRequestError(
            'option_exercise must close a long position, so contracts must be negative')

    if kind == 'option_assignment':
        # Short put assigned: shares are put to you. Short call assigned:
        # shares are called away.
        expect_positive_shares = right == 'P'
    else:
        # Long call exercised buys shares; long put exercised sells them.
        expect_positive_shares = right == 'C'

    if expect_positive_shares and shares <= 0:
        raise InvalidRequestError(
            f'{kind} on a {right} must record a positive share delivery')
    if not expect_positive_shares and shares >= 0:
        raise InvalidRequestError(
            f'{kind} on a {right} must record a negative share delivery')

    expected_shares = abs(contracts) * spc
    if abs(abs(shares) - expected_shares) > 1e-6:
        raise InvalidRequestError(
            f'{kind} share count {abs(shares):g} does not match '
            f'{abs(contracts):g} contracts x {spc} shares per contract'
        )


class CostBasisStore:
    def __init__(self, db_path, *, now=None):
        self._db_path = Path(db_path)
        self._now = now or (lambda: datetime.now(timezone.utc))

    @property
    def db_path(self):
        return self._db_path

    # ------------------------------------------------------------------
    # Connection & lifecycle
    # ------------------------------------------------------------------

    def initialize(self):
        try:
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise StoreUnavailableError(f'cannot create database directory: {exc}') from exc
        try:
            conn = self._connect(for_init=True)
        except CostBasisStoreError as exc:
            raise StoreUnavailableError(f'cannot open database: {exc}') from exc
        try:
            self._migrate(conn)
        except CostBasisStoreError:
            raise
        except sqlite3.Error as exc:
            raise StoreUnavailableError(f'schema migration failed: {exc}') from exc
        finally:
            conn.close()
        return self

    def _connect(self, for_init=False):
        conn = None
        try:
            conn = sqlite3.connect(self._db_path, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA foreign_keys = ON')
            if not for_init:
                conn.execute('PRAGMA journal_mode = WAL')
            conn.execute('PRAGMA synchronous = FULL')
            conn.execute('PRAGMA busy_timeout = 5000')
            if not for_init:
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
                    pass
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
        if version == 1:
            # v1 -> v2 only ADDS a table. Existing events are untouched, so
            # the upgrade is safe to run against a live ledger.
            conn.execute('BEGIN IMMEDIATE')
            try:
                for statement in _V2_TABLE_STATEMENTS:
                    conn.execute(statement)
                conn.execute('PRAGMA user_version = 2')
                conn.execute('COMMIT')
            except BaseException:
                conn.execute('ROLLBACK')
                raise
            version = 2
        if version == 2:
            self._migrate_v2_to_v4(conn)
            version = 4
        if version == 3:
            self._migrate_v3_to_v4(conn)
            version = 4
        if version == 4:
            self._migrate_v4_to_v5(conn)
            version = 5
        if version == 5:
            self._migrate_v5_to_v6(conn)
            version = 6
        if version == 6:
            self._migrate_v6_to_v7(conn)
            version = 7
        if version == 7:
            self._migrate_v7_to_v8(conn)
            version = 8
        if version == 8:
            conn.execute('BEGIN IMMEDIATE')
            try:
                for statement in _V9_TABLE_STATEMENTS:
                    conn.execute(statement)
                # v8 did not associate coverage with a history generation.
                # Preserve its audit rows but require fresh verification.
                for batch in conn.execute('SELECT batch_id, checks_json FROM cost_basis_import_batches').fetchall():
                    checks = json.loads(batch['checks_json'])
                    checks['coverageCurrent'] = False
                    conn.execute('UPDATE cost_basis_import_batches SET checks_json = ? WHERE batch_id = ?',
                                 (json.dumps(checks), batch['batch_id']))
                conn.execute('PRAGMA user_version = 9')
                conn.execute('COMMIT')
            except BaseException:
                conn.execute('ROLLBACK')
                raise
            version = 9
        if version == 9:
            self._migrate_v9_to_v10(conn)
            return
        object_count = conn.execute('SELECT count(*) FROM sqlite_master').fetchone()[0]
        if object_count > 0:
            raise StoreUnavailableError(
                'database file exists with unknown contents; refusing to migrate'
            )
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
    def _migrate_v2_to_v4(conn):
        """Atomically rebuild v2 with futures and broker-time columns.

        Every v2 column is copied explicitly. If any copy, index creation or
        version stamp fails, SQLite rolls the rename and copy back together,
        leaving the original v2 database usable by the previous build.
        """
        legacy_columns = (
            'event_id', 'book_id', 'seq', 'client_token', 'kind', 'trade_date',
            'account', 'right', 'strike', 'expiry', 'con_id', 'local_symbol',
            'shares_per_contract', 'contracts', 'shares', 'price', 'cash_amount',
            'fees', 'split_ratio', 'include_in_cost', 'tag', 'source',
            'external_ref', 'import_batch_id', 'derived_mismatch', 'note',
            'created_at_utc', 'voided_at_utc', 'voided_by_event_id', 'void_reason',
        )
        columns_sql = ', '.join(legacy_columns)
        conn.execute('BEGIN IMMEDIATE')
        try:
            conn.execute('DROP INDEX idx_cost_basis_books_symbol')
            conn.execute(_V4_BOOK_INDEX_SQL)
            conn.execute('ALTER TABLE cost_basis_events RENAME TO cost_basis_events_v2')
            conn.execute(_V3_EVENT_TABLE_SQL)
            conn.execute(
                f'INSERT INTO cost_basis_events ({columns_sql}) '
                f'SELECT {columns_sql} FROM cost_basis_events_v2'
            )
            conn.execute('DROP TABLE cost_basis_events_v2')
            for statement in _V3_EVENT_INDEX_STATEMENTS:
                conn.execute(statement)
            conn.execute('PRAGMA user_version = 4')
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise

    @staticmethod
    def _migrate_v4_to_v5(conn):
        """Add the account half of the book identity without splitting history.

        A v4 book may contain several event accounts because the old design
        deliberately aggregated them. Such a book stays account-less and is
        surfaced as a legacy mixed-account book. When all non-empty events
        agree on one account, it is safe to adopt that account as book
        metadata because no event is moved or rewritten. Empty-account split
        rows are book-wide by definition and do not make that identity
        ambiguous; any other empty-account row does.
        """
        conn.execute('BEGIN IMMEDIATE')
        try:
            book_columns = {
                row['name'] for row in conn.execute(
                    'PRAGMA table_info(cost_basis_books)').fetchall()
            }
            if 'account' not in book_columns:
                conn.execute(
                    "ALTER TABLE cost_basis_books ADD COLUMN account TEXT "
                    "NOT NULL DEFAULT ''")
            rows = conn.execute(
                'SELECT book_id FROM cost_basis_books').fetchall()
            for row in rows:
                accounts = conn.execute(
                    "SELECT DISTINCT account FROM cost_basis_events "
                    "WHERE book_id = ? AND account <> '' ORDER BY account",
                    (row['book_id'],),
                ).fetchall()
                ambiguous_empty = conn.execute(
                    "SELECT count(*) AS total FROM cost_basis_events "
                    "WHERE book_id = ? AND account = '' AND kind <> 'split'",
                    (row['book_id'],),
                ).fetchone()['total']
                if len(accounts) == 1 and not ambiguous_empty:
                    conn.execute(
                        'UPDATE cost_basis_books SET account = ? WHERE book_id = ?',
                        (accounts[0]['account'], row['book_id']),
                    )
            conn.execute('DROP INDEX IF EXISTS idx_cost_basis_books_symbol')
            conn.execute(
                'DROP INDEX IF EXISTS idx_cost_basis_books_account_symbol')
            conn.execute(_SCHEMA_STATEMENTS[1])
            conn.execute('PRAGMA user_version = 5')
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise

    @staticmethod
    def _migrate_v5_to_v6(conn):
        """Persist the event that received an explicit overdraw exception.

        Older builds stored only the request flag. Recover existing exceptions
        conservatively: a closing row that already overdraws the timeline could
        only have committed through that explicit escape hatch, because normal
        writes were rejected transactionally.
        """
        conn.execute('BEGIN IMMEDIATE')
        try:
            columns = {
                row['name'] for row in conn.execute(
                    'PRAGMA table_info(cost_basis_events)').fetchall()
            }
            if 'allow_overdraw' not in columns:
                conn.execute(
                    'ALTER TABLE cost_basis_events ADD COLUMN allow_overdraw '
                    'INTEGER NOT NULL DEFAULT 0 CHECK (allow_overdraw IN (0, 1))')
            groups = conn.execute(
                'SELECT DISTINCT book_id, account, right, strike, expiry, '
                'shares_per_contract FROM cost_basis_events '
                'WHERE voided_at_utc IS NULL AND kind IN ('
                "'option_trade','option_assignment','option_exercise','option_expiry')"
            ).fetchall()
            for group in groups:
                rows = conn.execute(
                    'SELECT event_id, kind, trade_date, broker_timestamp, seq, '
                    'contracts, con_id, local_symbol, tag, allow_overdraw '
                    'FROM cost_basis_events WHERE book_id = ? AND account = ? '
                    'AND right IS ? AND strike IS ? AND expiry IS ? '
                    'AND shares_per_contract IS ? AND voided_at_utc IS NULL '
                    f'ORDER BY {_V9_EVENT_ORDER_SQL}',
                    tuple(group),
                ).fetchall()
                positions = {}
                for row, identity, ambiguous in _resolve_contract_identity_rows(rows):
                    if ambiguous:
                        continue
                    position = positions.get(identity, 0.0)
                    contracts = float(row['contracts'] or 0)
                    broker_close = row['kind'] == 'option_trade' \
                        and row['tag'] == 'ibkr_close'
                    closing = row['kind'] in CLOSING_KINDS or broker_close
                    overdraw = closing and (
                        (contracts > 0 and position > -contracts + 1e-9)
                        or (contracts < 0 and position < -contracts - 1e-9))
                    if overdraw and not broker_close:
                        conn.execute(
                            'UPDATE cost_basis_events SET allow_overdraw = 1 '
                            'WHERE event_id = ?', (row['event_id'],))
                    positions[identity] = position + contracts
            conn.execute('PRAGMA user_version = 6')
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise

    @staticmethod
    def _migrate_v9_to_v10(conn):
        """Rebuild the event table so it can hold split groups.

        SQLite cannot extend the kind CHECK in place, so the table is copied
        into the current definition. Every existing column is copied by
        name, the row count is verified, and the version stamp commits with
        the copy: a failure leaves the v9 database untouched. The new split
        columns start empty, so no existing row joins a group.
        """
        conn.execute('BEGIN IMMEDIATE')
        try:
            existing = [row['name'] for row in conn.execute(
                'PRAGMA table_info(cost_basis_events)').fetchall()]
            before = conn.execute(
                'SELECT count(*) FROM cost_basis_events').fetchone()[0]
            conn.execute('ALTER TABLE cost_basis_events RENAME TO cost_basis_events_v9')
            conn.execute(_V3_EVENT_TABLE_SQL)
            current = {row['name'] for row in conn.execute(
                'PRAGMA table_info(cost_basis_events)').fetchall()}
            copied = ', '.join(column for column in existing if column in current)
            conn.execute(
                f'INSERT INTO cost_basis_events ({copied}) '
                f'SELECT {copied} FROM cost_basis_events_v9')
            after = conn.execute(
                'SELECT count(*) FROM cost_basis_events').fetchone()[0]
            if after != before:
                raise StoreUnavailableError(
                    f'v10 migration copied {after} of {before} events; nothing changed')
            conn.execute('DROP TABLE cost_basis_events_v9')
            for statement in _V3_EVENT_INDEX_STATEMENTS + _V10_EVENT_INDEX_STATEMENTS:
                conn.execute(statement)
            conn.execute('PRAGMA user_version = 10')
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise

    @staticmethod
    def _migrate_v7_to_v8(conn):
        """Add the statement/batch registry. Events are untouched."""
        conn.execute('BEGIN IMMEDIATE')
        try:
            for statement in _V8_TABLE_STATEMENTS:
                conn.execute(statement)
            conn.execute('PRAGMA user_version = 8')
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise

    @staticmethod
    def _migrate_v6_to_v7(conn):
        """Remove broker ordering stamps inferred from untrusted free-form notes."""
        conn.execute('BEGIN IMMEDIATE')
        try:
            conn.execute(
                "UPDATE cost_basis_events SET broker_timestamp = NULL "
                "WHERE broker_timestamp IS NOT NULL "
                "AND source NOT IN ('csv_import', 'execution_report') "
                "AND NOT (source = 'reconcile' AND tag = 'tws_snapshot')"
            )
            conn.execute('PRAGMA user_version = 7')
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise

    @staticmethod
    def _migrate_v3_to_v4(conn):
        """Add official broker time and recover it from immutable v3 notes."""
        conn.execute('BEGIN IMMEDIATE')
        try:
            conn.execute(
                'ALTER TABLE cost_basis_events ADD COLUMN broker_timestamp TEXT')
            legacy = conn.execute(
                'SELECT event_id, trade_date, note, source, tag, created_at_utc '
                'FROM cost_basis_events').fetchall()
            for row in legacy:
                timestamp = _exact_event_timestamp(dict(row))
                if timestamp and timestamp[:10] == row['trade_date']:
                    conn.execute(
                        'UPDATE cost_basis_events SET broker_timestamp = ? '
                        'WHERE event_id = ?', (timestamp, row['event_id']))
            conn.execute('DROP INDEX idx_cost_basis_events_book_date')
            conn.execute(
                'CREATE INDEX idx_cost_basis_events_book_date ON '
                'cost_basis_events(book_id, trade_date, broker_timestamp, seq)')
            conn.execute('PRAGMA user_version = 4')
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
        return CostBasisStoreError(message)

    def now_utc(self):
        now = self._now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        return now.astimezone(timezone.utc)

    def _utc_now_iso(self):
        return self.now_utc().strftime('%Y-%m-%dT%H:%M:%SZ')

    # ------------------------------------------------------------------
    # Books
    # ------------------------------------------------------------------

    def create_book(self, *, account, symbol, start_date, sec_type='STK', currency='USD',
                    default_shares_per_contract=100, note='', book_id=None):
        account = _require_account(account)
        symbol = _require_symbol(symbol)
        start_date = _require_trade_date(start_date, 'startDate')
        sec_type = str(sec_type or 'STK').strip().upper()
        if sec_type not in DELIVERABLE_SEC_TYPES:
            raise InvalidRequestError(
                f'{sec_type} has no deliverable underlying, so a per-share blended '
                f'cost cannot be computed; supported: {", ".join(DELIVERABLE_SEC_TYPES)}'
            )
        currency = str(currency or 'USD').strip().upper()
        if not currency.isalpha() or len(currency) != 3:
            raise InvalidRequestError('currency must be a 3-letter code')
        spc = _positive_int(default_shares_per_contract, 'defaultSharesPerContract',
                            allow_none=False)
        note = _optional_text(note, 'note', MAX_NOTE_CHARS)
        book_id = _require_token('bookId', book_id) if book_id else uuid.uuid4().hex
        stamp = self._utc_now_iso()

        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            existing = conn.execute(
                'SELECT book_id FROM cost_basis_books '
                'WHERE account = ? COLLATE NOCASE '
                'AND symbol = ? AND sec_type = ? AND currency = ? '
                'AND archived_at_utc IS NULL',
                (account, symbol, sec_type, currency),
            ).fetchone()
            if existing is not None:
                conn.execute('ROLLBACK')
                raise BookExistsError(
                    f'an active {sec_type} ledger for account {account} and '
                    f'{symbol} ({currency}) already exists'
                )
            conn.execute(
                'INSERT INTO cost_basis_books (book_id, account, symbol, sec_type, currency, '
                'default_shares_per_contract, start_date, note, created_at_utc, '
                'updated_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (book_id, account, symbol, sec_type, currency, spc, start_date,
                 note, stamp, stamp),
            )
            conn.execute('COMMIT')
        except sqlite3.Error as exc:
            self._rollback_quietly(conn)
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()
        return self.get_book(book_id)

    def list_books(self, *, include_archived=False):
        conn = self._connect()
        try:
            sql = 'SELECT * FROM cost_basis_books'
            if not include_archived:
                sql += ' WHERE archived_at_utc IS NULL'
            sql += ' ORDER BY account ASC, symbol ASC, sec_type ASC'
            rows = conn.execute(sql).fetchall()
            books = []
            for row in rows:
                book = _book_row_to_dict(row)
                counts = conn.execute(
                    'SELECT count(*) AS total, '
                    '       sum(CASE WHEN voided_at_utc IS NULL THEN 1 ELSE 0 END) AS live, '
                    '       min(trade_date) AS first_date, max(trade_date) AS last_date '
                    'FROM cost_basis_events WHERE book_id = ?',
                    (row['book_id'],),
                ).fetchone()
                book['eventCount'] = int(counts['live'] or 0)
                book['totalRowCount'] = int(counts['total'] or 0)
                book['firstEventDate'] = counts['first_date'] or ''
                book['lastEventDate'] = counts['last_date'] or ''
                books.append(book)
            return books
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def get_book(self, book_id):
        conn = self._connect()
        try:
            return self._get_book(conn, book_id)
        finally:
            conn.close()

    @staticmethod
    def _ledger_version(conn, book_id):
        """A digest of every row's identity and void state, in sequence order.

        Two ledgers with the same digest hold the same rows in the same
        states. A count alone cannot say that: a book whose one row was
        replaced by a different one keeps its count.
        """
        rows = conn.execute(
            'SELECT event_id, seq, voided_at_utc FROM cost_basis_events '
            'WHERE book_id = ? ORDER BY seq ASC', (book_id,),
        ).fetchall()
        hasher = hashlib.sha256()
        live = 0
        max_seq = 0
        for row in rows:
            hasher.update(f"{row['event_id']}|{row['voided_at_utc'] or ''}\n".encode('utf-8'))
            if not row['voided_at_utc']:
                live += 1
            max_seq = max(max_seq, int(row['seq']))
        return {
            'eventCount': len(rows),
            'liveEventCount': live,
            'maxSeq': max_seq,
            'digest': hasher.hexdigest(),
        }

    def ledger_version(self, book_id):
        conn = self._connect()
        try:
            self._get_book(conn, book_id)
            return self._ledger_version(conn, book_id)
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    @classmethod
    def _require_ledger_version(cls, conn, book_id, expected):
        """Refuse a write planned against a ledger that has since changed."""
        if expected in (None, ''):
            raise InvalidRequestError('expectedLedgerVersion is required; refresh and preview again')
        digest = expected.get('digest') if isinstance(expected, dict) else expected
        if not isinstance(digest, str) or not digest.strip():
            raise InvalidRequestError('expectedLedgerVersion must carry a digest')
        current = cls._ledger_version(conn, book_id)
        if current['digest'] != digest.strip():
            raise LedgerChangedError(
                'the ledger changed after this import was previewed; reload the '
                'book and preview the file again')
        return current

    @staticmethod
    def _require_book_identity(book, identity):
        """Refuse rows prepared for another account, symbol or currency.

        Share rows carry no symbol and every row is currency-less, so the
        store cannot tell from the rows alone that a batch prepared for one
        book was submitted to another; the browser states what it prepared
        the batch for and the store holds it to that.
        """
        if identity in (None, ''):
            raise InvalidRequestError('bookIdentity is required; refresh and preview again')
        if not isinstance(identity, dict):
            raise InvalidRequestError('bookIdentity must be an object')
        checks = (
            ('account', str(book.get('account') or '')),
            ('symbol', str(book.get('symbol') or '')),
            ('secType', str(book.get('secType') or 'STK')),
            ('currency', str(book.get('currency') or 'USD')),
        )
        for field, actual in checks:
            given = identity.get(field)
            if given is None or (given == '' and actual != ''):
                raise InvalidRequestError(f'bookIdentity.{field} is required')
            if str(given).strip().upper() != actual.strip().upper():
                raise InvalidRequestError(
                    f'this batch was prepared for {field} {given}, but the ledger is '
                    f'{actual or "(unset)"}; select the right ledger and preview again')

    @staticmethod
    def _statement_registration(statement):
        """Validate the optional statement/batch registration payload."""
        if statement in (None, ''):
            return None
        if not isinstance(statement, dict):
            raise InvalidRequestError('statement must be an object')
        def text(field, limit=200):
            value = statement.get(field)
            if value in (None, ''):
                return ''
            if not isinstance(value, str) or len(value) > limit:
                raise InvalidRequestError(f'statement.{field} must be a string of at most {limit} characters')
            return value.strip()
        def date(field):
            value = text(field, 10)
            if not value:
                return ''
            return _require_trade_date(value, f'statement.{field}')
        checks = statement.get('checks')
        if checks is None:
            checks = {}
        if not isinstance(checks, dict):
            raise InvalidRequestError('statement.checks must be an object')
        return {
            'source_format': text('format', 32),
            'file_name': text('fileName', 200),
            'file_sha256': text('fileSha256', 64),
            'account': text('account', 32),
            'period_from': date('periodFrom'),
            'period_through': date('periodThrough'),
            'checks_json': json.dumps(
                {str(key): bool(value) for key, value in checks.items()},
                sort_keys=True, separators=(',', ':')),
            'confirmed_duplicates': int(_number(
                statement.get('confirmedDuplicates'), 'statement.confirmedDuplicates') or 0),
        }

    def _register_batch(self, conn, book_id, batch_id, mode, registration, *,
                        inserted, skipped):
        if registration is None:
            return
        digest = self._ledger_version(conn, book_id)['digest']
        conn.execute(
            'INSERT OR REPLACE INTO cost_basis_import_batches (batch_id, book_id, mode, '
            'source_format, file_name, file_sha256, account, period_from, '
            'period_through, checks_json, inserted, skipped, confirmed_duplicates, '
            'registered_at_utc, ledger_digest) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (batch_id, book_id, mode, registration['source_format'],
             registration['file_name'], registration['file_sha256'],
             registration['account'], registration['period_from'],
             registration['period_through'], registration['checks_json'],
             int(inserted), int(skipped), registration['confirmed_duplicates'],
             self._utc_now_iso(), digest),
        )

    @staticmethod
    def _archive_coverage(conn, book_id, reset_id):
        batches = [dict(row) for row in conn.execute(
            'SELECT * FROM cost_basis_import_batches WHERE book_id = ?', (book_id,))]
        encoded = json.dumps(batches, sort_keys=True, separators=(',', ':'))
        conn.execute('INSERT INTO cost_basis_reset_coverage VALUES (?, ?, ?, ?)',
                     (reset_id, book_id, encoded, hashlib.sha256(encoded.encode()).hexdigest()))
        conn.execute('DELETE FROM cost_basis_import_batches WHERE book_id = ?', (book_id,))

    @staticmethod
    def _restore_coverage(conn, book_id, reset_id):
        archive = conn.execute('SELECT * FROM cost_basis_reset_coverage WHERE reset_id = ? AND book_id = ?',
                               (reset_id, book_id)).fetchone()
        if archive is None:
            return
        encoded = archive['batches_json']
        if hashlib.sha256(encoded.encode()).hexdigest() != archive['batches_sha256']:
            raise InvalidRequestError('coverage archive checksum mismatch')
        for batch in json.loads(encoded):
            columns = list(batch)
            conn.execute(f"INSERT INTO cost_basis_import_batches ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
                         tuple(batch[column] for column in columns))

    @staticmethod
    def _invalidate_coverage(conn, book_id, trade_date):
        # Keep the audit entry, but a changed historical event invalidates
        # prior verification at and after that date (including opening basis).
        for batch in conn.execute('SELECT batch_id, checks_json FROM cost_basis_import_batches '
                                  'WHERE book_id = ? AND period_through >= ?', (book_id, trade_date)).fetchall():
            checks = json.loads(batch['checks_json'])
            checks['coverageCurrent'] = False
            conn.execute('UPDATE cost_basis_import_batches SET checks_json = ? WHERE batch_id = ?',
                         (json.dumps(checks), batch['batch_id']))

    def list_import_batches(self, book_id, *, limit=60):
        """Statement periods this book has accepted, newest first."""
        limit = max(1, min(int(limit or 60), 500))
        conn = self._connect()
        try:
            self._get_book(conn, book_id)
            rows = conn.execute(
                'SELECT * FROM cost_basis_import_batches WHERE book_id = ? '
                'ORDER BY registered_at_utc DESC LIMIT ?', (book_id, limit),
            ).fetchall()
            return [{
                'batchId': row['batch_id'],
                'bookId': row['book_id'],
                'mode': row['mode'],
                'format': row['source_format'],
                'fileName': row['file_name'],
                'fileSha256': row['file_sha256'],
                'account': row['account'],
                'periodFrom': row['period_from'],
                'periodThrough': row['period_through'],
                'checks': json.loads(row['checks_json'] or '{}'),
                'inserted': int(row['inserted']),
                'skipped': int(row['skipped']),
                'confirmedDuplicates': int(row['confirmed_duplicates']),
                'registeredAtUtc': row['registered_at_utc'],
                'ledgerDigest': row['ledger_digest'],
            } for row in rows]
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def _get_book(self, conn, book_id):
        _require_token('bookId', book_id)
        row = conn.execute(
            'SELECT * FROM cost_basis_books WHERE book_id = ?', (book_id,)
        ).fetchone()
        if row is None:
            raise BookNotFoundError('no ledger with that id')
        return _book_row_to_dict(row)

    def archive_book(self, book_id):
        conn = self._connect()
        try:
            book = self._get_book(conn, book_id)
            if book['archivedAtUtc']:
                return book
            conn.execute(
                'UPDATE cost_basis_books SET archived_at_utc = ?, updated_at_utc = ? '
                'WHERE book_id = ?',
                (self._utc_now_iso(), self._utc_now_iso(), book_id),
            )
            return self._get_book(conn, book_id)
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def delete_confirmation(self, book_id):
        """Describe every row a permanent whole-book deletion will remove."""
        conn = self._connect()
        try:
            book = self._get_book(conn, book_id)
            return self._build_delete_plan(conn, book)
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    @staticmethod
    def _build_delete_plan(conn, book):
        book_id = book['bookId']
        event_counts = conn.execute(
            'SELECT count(*) AS total, '
            '       sum(CASE WHEN voided_at_utc IS NULL THEN 1 ELSE 0 END) AS live '
            'FROM cost_basis_events WHERE book_id = ?',
            (book_id,),
        ).fetchone()
        event_count = int(event_counts['total'] or 0)
        live_event_count = int(event_counts['live'] or 0)
        snapshot_count = int(conn.execute(
            'SELECT count(*) AS total FROM cost_basis_snapshots WHERE book_id = ?',
            (book_id,),
        ).fetchone()['total'] or 0)
        reset_count = int(conn.execute(
            'SELECT count(*) AS total FROM cost_basis_book_resets WHERE book_id = ?',
            (book_id,),
        ).fetchone()['total'] or 0)
        return {
            'bookId': book_id,
            'account': book['account'],
            'symbol': book['symbol'],
            'eventCount': event_count,
            'liveEventCount': live_event_count,
            'voidedEventCount': event_count - live_event_count,
            'snapshotCount': snapshot_count,
            'resetCount': reset_count,
            'phrase': _delete_phrase(
                book['account'], book['symbol'], event_count,
                snapshot_count, reset_count),
        }

    def delete_book(self, book_id, *, confirmation, client_token):
        """Permanently remove a book and all of its related records.

        Counts and the confirmation phrase are recomputed after taking the
        write lock. A plan that became stale can therefore never authorize
        deletion of records the operator did not see. Unlike reset/rebuild,
        this operation deliberately creates no archive: its meaning is full
        removal, not a recoverable emptying of the active event stream.
        """
        _require_token('clientToken', client_token)
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                book = self._get_book(conn, book_id)
                plan = self._build_delete_plan(conn, book)
                if str(confirmation or '').strip() != plan['phrase']:
                    conn.execute('ROLLBACK')
                    raise DeleteConfirmationError(
                        f"type exactly: {plan['phrase']}"
                    )

                removed_snapshots = conn.execute(
                    'DELETE FROM cost_basis_snapshots WHERE book_id = ?',
                    (book_id,),
                ).rowcount
                removed_events = conn.execute(
                    'DELETE FROM cost_basis_events WHERE book_id = ?',
                    (book_id,),
                ).rowcount
                removed_resets = conn.execute(
                    'DELETE FROM cost_basis_book_resets WHERE book_id = ?',
                    (book_id,),
                ).rowcount
                conn.execute('DELETE FROM cost_basis_reset_coverage WHERE book_id = ?', (book_id,))
                removed_books = conn.execute(
                    'DELETE FROM cost_basis_books WHERE book_id = ?',
                    (book_id,),
                ).rowcount
                if removed_books != 1:
                    raise BookNotFoundError('no ledger with that id')
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return {
                'bookId': book_id,
                'account': plan['account'],
                'symbol': plan['symbol'],
                'removedBooks': removed_books,
                'removedEvents': removed_events,
                'removedSnapshots': removed_snapshots,
                'removedResets': removed_resets,
            }
        except sqlite3.IntegrityError as exc:
            raise self._map_integrity_error(exc) from exc
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Events
    # ------------------------------------------------------------------

    def append_event(self, book_id, event, *, client_token, allow_overdraw=False):
        """Append one confirmed event. Idempotent per client_token."""
        _require_token('clientToken', client_token)
        conn = self._connect()
        try:
            book = self._get_book(conn, book_id)
            event = _bind_event_to_book_account(event, book)
            event = self._resolve_shares_per_contract(conn, book_id, event)
            normalized = _validate_event_shape(event, book)
            _refuse_split_group_rows([normalized])
            conn.execute('BEGIN IMMEDIATE')
            try:
                replay = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE client_token = ?',
                    (client_token,),
                ).fetchone()
                if replay is not None:
                    conn.execute('ROLLBACK')
                    stored = _event_row_to_dict(replay)
                    if stored['bookId'] != book_id:
                        raise InvalidRequestError(
                            'clientToken has already been used for another ledger')
                    return {
                        'bookId': stored['bookId'],
                        'event': stored,
                        'warnings': [],
                        'idempotentReplay': True,
                    }
                result = self._insert_event(
                    conn, book, normalized,
                    client_token=client_token,
                    allow_overdraw=allow_overdraw,
                )
                self._invalidate_coverage(conn, book_id, normalized['trade_date'])
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return result
        except sqlite3.IntegrityError as exc:
            raise self._map_integrity_error(exc) from exc
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def _resolve_shares_per_contract(self, conn, book_id, event):
        """Fill an omitted deliverable size from the contract's own history.

        Defaulting to the book's 100 would key a closing row onto a contract
        that never existed whenever the real contract was adjusted, and the
        timeline check would then reject a perfectly good close. If the
        ledger already knows exactly one deliverable size for this contract,
        that is the answer.
        """
        if not isinstance(event, dict):
            return event
        if event.get('kind') not in OPTION_KINDS:
            return event
        if event.get('sharesPerContract'):
            return event
        try:
            rows = conn.execute(
                'SELECT DISTINCT shares_per_contract FROM cost_basis_events '
                'WHERE book_id = ? AND account = ? AND right = ? AND strike = ? '
                'AND expiry = ? AND shares_per_contract IS NOT NULL '
                'AND voided_at_utc IS NULL',
                (book_id, _optional_account(event.get('account')),
                 str(event.get('right') or '').strip().upper()[:1],
                 _number(event.get('strike'), 'strike'),
                 _optional_expiry(event.get('expiry'))),
            ).fetchall()
        except (sqlite3.Error, CostBasisStoreError):
            return event
        if len(rows) == 1:
            return {**event, 'sharesPerContract': int(rows[0][0])}
        if len(rows) > 1:
            raise InvalidRequestError('multiple option multipliers are known; provide sharesPerContract explicitly')
        return event

    @staticmethod
    def _option_multiplier_key(event):
        """Return the same structural contract key used by single-row inference."""
        return (
            _optional_account(event.get('account')),
            str(event.get('right') or '').strip().upper()[:1],
            _number(event.get('strike'), 'strike'),
            _optional_expiry(event.get('expiry')),
        )

    def _normalize_event_batch(self, conn, book_id, events, book, *,
                               include_existing_history):
        """Validate a batch using unambiguous multipliers from the whole batch.

        A reviewed import may close an adjusted contract without repeating its
        deliverable size on every row.  Single-row append already infers that
        size from the ledger. Bulk import must also see an explicitly sized row
        anywhere in the incoming batch; rebuild must use only replacement rows,
        because the old book is about to be archived and deleted.
        """
        known = {}
        if include_existing_history:
            rows = conn.execute(
                'SELECT account, right, strike, expiry, shares_per_contract '
                'FROM cost_basis_events WHERE book_id = ? '
                'AND kind IN (\'option_trade\', \'option_assignment\', '
                '\'option_exercise\', \'option_expiry\') '
                'AND shares_per_contract IS NOT NULL AND voided_at_utc IS NULL',
                (book_id,),
            ).fetchall()
            for row in rows:
                key = (row['account'], row['right'], row['strike'], row['expiry'])
                known.setdefault(key, set()).add(int(row['shares_per_contract']))

        # Explicit broker time, not payload order, decides which trade came
        # first. Learn validated explicit sizes before resolving omitted ones.
        for item in events:
            candidate = _bind_event_to_book_account(item, book)
            if (isinstance(candidate, dict) and candidate.get('kind') in OPTION_KINDS
                    and candidate.get('sharesPerContract')):
                explicit = _validate_event_shape(candidate, book)
                key = (explicit['account'], explicit['right'], explicit['strike'], explicit['expiry'])
                known.setdefault(key, set()).add(explicit['shares_per_contract'])

        normalized_rows = []
        for item in events:
            candidate = _bind_event_to_book_account(item, book)
            if (isinstance(candidate, dict)
                    and candidate.get('kind') in OPTION_KINDS
                    and not candidate.get('sharesPerContract')):
                try:
                    key = self._option_multiplier_key(candidate)
                except CostBasisStoreError:
                    # Shape validation below owns the precise user-facing error.
                    key = None
                values = known.get(key, set()) if key is not None else set()
                if len(values) > 1:
                    raise InvalidRequestError('multiple option multipliers are known; provide sharesPerContract explicitly')
                if len(values) == 1:
                    candidate = {
                        **candidate,
                        'sharesPerContract': next(iter(values)),
                    }
            normalized = _validate_event_shape(candidate, book)
            normalized_rows.append(normalized)
            if normalized['kind'] in OPTION_KINDS:
                key = (
                    normalized['account'], normalized['right'],
                    normalized['strike'], normalized['expiry'],
                )
                known.setdefault(key, set()).add(
                    int(normalized['shares_per_contract']))
        return normalized_rows

    def _insert_event(self, conn, book, normalized, *, client_token,
                      allow_overdraw, import_batch_id=None,
                      check_share_warning=True, validate_timeline=True):
        book_id = book['bookId']
        seq_row = conn.execute(
            'SELECT COALESCE(max(seq), 0) AS max_seq FROM cost_basis_events '
            'WHERE book_id = ?', (book_id,)
        ).fetchone()
        seq = int(seq_row['max_seq']) + 1
        event_id = uuid.uuid4().hex
        stamp = self._utc_now_iso()

        conn.execute(
            'INSERT INTO cost_basis_events ('
            'event_id, book_id, seq, client_token, kind, trade_date, '
            'broker_timestamp, account, '
            'right, strike, expiry, con_id, local_symbol, option_sec_type, '
            'shares_per_contract, contracts, shares, future_expiry, future_con_id, '
            'future_local_symbol, future_contracts, roll_to_expiry, roll_to_con_id, '
            'roll_to_local_symbol, roll_to_price, roll_group, price, cash_amount, '
            'fees, split_ratio, split_group, split_rule_ref, split_rounding, '
            'split_to_strike, split_to_contracts, split_to_con_id, '
            'split_to_local_symbol, split_standard_confirmed, '
            'include_in_cost, tag, source, external_ref, import_batch_id, '
            'derived_mismatch, allow_overdraw, note, created_at_utc'
            ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '
            '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '
            '?, ?, ?, ?, ?, ?, ?, ?)',
            (
                event_id, book_id, seq, client_token, normalized['kind'],
                normalized['trade_date'], normalized['broker_timestamp'],
                normalized['account'], normalized['right'],
                normalized['strike'], normalized['expiry'], normalized['con_id'],
                normalized['local_symbol'], normalized['option_sec_type'],
                normalized['shares_per_contract'], normalized['contracts'],
                normalized['shares'], normalized['future_expiry'],
                normalized['future_con_id'], normalized['future_local_symbol'],
                normalized['future_contracts'], normalized['roll_to_expiry'],
                normalized['roll_to_con_id'], normalized['roll_to_local_symbol'],
                normalized['roll_to_price'], normalized['roll_group'],
                normalized['price'], normalized['cash_amount'], normalized['fees'],
                normalized['split_ratio'], normalized['split_group'],
                normalized['split_rule_ref'], normalized['split_rounding'],
                normalized['split_to_strike'], normalized['split_to_contracts'],
                normalized['split_to_con_id'], normalized['split_to_local_symbol'],
                normalized['split_standard_confirmed'],
                normalized['include_in_cost'], normalized['tag'], normalized['source'],
                normalized['external_ref'], import_batch_id,
                normalized['derived_mismatch'], 1 if allow_overdraw else 0,
                normalized['note'], stamp,
            ),
        )

        # A batch that replaces stored rows (a superseded baseline or
        # opening stub) may be valid only as a whole: the caller validates
        # every affected timeline once all of its rows are in.
        warnings = self._validate_timeline(
            conn, book_id, normalized,
            check_share_warning=check_share_warning) if validate_timeline else []

        row = conn.execute(
            'SELECT * FROM cost_basis_events WHERE event_id = ?', (event_id,)
        ).fetchone()
        return {
            'bookId': book_id,
            'event': _event_row_to_dict(row),
            'warnings': warnings,
            'idempotentReplay': False,
        }

    def _validate_contract_timeline(self, conn, book_id, row):
        """Replay one contract's timeline and refuse any stranded close.

        An option_split row touches two contracts: the series it empties and
        the adjusted series it fills. Both timelines are replayed.
        """
        if row['kind'] not in OPTION_KINDS and row['kind'] != 'option_split':
            return
        for strike in _row_strikes(row):
            self._replay_contract_key(
                conn, book_id, row['account'], row['right'], strike, row['expiry'],
                row['shares_per_contract'], voiding=True)

    def _contract_key_movements(self, conn, book_id, account, right, strike, expiry,
                                shares_per_contract):
        """Every active position change of one structural contract, in order.

        An option_split row contributes its outgoing half to the source key
        and its incoming half to the destination key (_option_movements).
        """
        rows = conn.execute(
            'SELECT event_id, kind, trade_date, broker_timestamp, seq, contracts, '
            'con_id, local_symbol, tag, allow_overdraw, split_group, strike, '
            'split_to_strike, split_to_contracts, split_to_con_id, split_to_local_symbol '
            'FROM cost_basis_events '
            'WHERE book_id = ? AND account = ? AND right = ? AND expiry = ? '
            'AND shares_per_contract IS ? AND voided_at_utc IS NULL '
            # An excluded row is out of the ledger for the browser's engine;
            # it must not back a close here either, or a row the store
            # accepts is one the engine then refuses.
            'AND include_in_cost = 1 '
            "AND (strike = ? OR (kind = 'option_split' AND split_to_strike = ?)) "
            f'ORDER BY {_EVENT_ORDER_SQL}',
            (book_id, account, right, expiry, shares_per_contract, strike, strike),
        ).fetchall()
        movements = []
        for row in rows:
            base = {key: row[key] for key in (
                'event_id', 'kind', 'trade_date', 'broker_timestamp', 'seq', 'tag',
                'allow_overdraw', 'split_group')}
            if row['kind'] != 'option_split':
                movements.append({**base, 'side': 'trade', 'contracts': row['contracts'],
                                  'con_id': row['con_id'], 'local_symbol': row['local_symbol']})
                continue
            if row['strike'] == strike:
                movements.append({**base, 'side': 'split_out', 'contracts': row['contracts'],
                                  'con_id': row['con_id'], 'local_symbol': row['local_symbol']})
            if row['split_to_strike'] == strike:
                movements.append({**base, 'side': 'split_in',
                                  'contracts': row['split_to_contracts'],
                                  'con_id': row['split_to_con_id'],
                                  'local_symbol': row['split_to_local_symbol']})
        return movements

    def _replay_contract_key(self, conn, book_id, account, right, strike, expiry,
                             shares_per_contract, *, voiding=False):
        """Replay one contract and refuse any close that nothing backs.

        Back-dating is legitimate - you record history out of order - but a
        back-dated close can strand a *later* assignment that no longer has
        a short position behind it, and removing an opening strands every
        close that stood on it. The whole timeline is replayed either way.
        The outgoing half of an option_split is a close that may never
        overdraw: a split moves a position, it cannot create one.
        """
        warnings = []
        movements = self._contract_key_movements(
            conn, book_id, account, right, strike, expiry, shares_per_contract)
        epoch_of = _split_epoch_of(conn, book_id, account)
        positions = {}
        for item, identity, ambiguous in _resolve_contract_identity_rows(movements, epoch_of):
            if ambiguous:
                if voiding:
                    raise InvalidRequestError(
                        'voiding would leave an option event with an ambiguous '
                        'contract identity; add conId or an exact localSymbol')
                raise InvalidRequestError(
                    'option event needs conId or an exact localSymbol because '
                    'multiple real contracts share its account, right, strike, '
                    'expiry and multiplier')
            position = positions.get(identity, 0.0)
            contracts = float(item['contracts'] or 0)
            self._validate_mixed_option_trade(item, position, contracts)
            if (item['kind'] == 'option_trade' and item['tag'] == 'ibkr_open'
                    and abs(position) > 1e-9 and position * contracts < 0):
                if voiding:
                    raise PositionOverdrawError(
                        f"voiding would leave IBKR O trade on {item['trade_date']} "
                        'opposite an existing position')
                raise PositionOverdrawError(
                    f"IBKR O trade on {item['trade_date']} opposes the existing "
                    f'{position:g} contracts; it cannot be treated as a close')
            broker_close = item['kind'] == 'option_trade' and item['tag'] == 'ibkr_close'
            split_out = item['side'] == 'split_out'
            if item['kind'] in CLOSING_KINDS or broker_close or split_out:
                # A closing event must be backed by an opposite-signed
                # position of at least its own size.
                allowed = bool(item['allow_overdraw']) and not broker_close and not split_out
                overdraw = ((contracts > 0 and position > -contracts + 1e-9)
                            or (contracts < 0 and position < -contracts - 1e-9))
                if overdraw and voiding and not allowed:
                    raise PositionOverdrawError(
                        f"voiding this row would leave the {item['kind']} on "
                        f"{item['trade_date']} without an opening behind it")
                if overdraw and not voiding:
                    self._raise_or_warn_overdraw(item, position, contracts, allowed, warnings)
            positions[identity] = position + contracts
        return warnings

    def _validate_futures_timeline(self, conn, book_id, account):
        """Replay every FUT movement for one account and prove each roll.

        Ordinary futures trades may legitimately cross through zero, but a
        row explicitly labelled as a roll promises that it transfers an
        already-held signed quantity from one month to another. That promise
        is enforced for back-dated inserts and voids as well as tail writes.
        """
        rows = conn.execute(
            'SELECT * FROM cost_basis_events WHERE book_id = ? AND account = ? '
            'AND voided_at_utc IS NULL AND include_in_cost = 1 AND ('
            'kind IN (\'futures_trade\', \'futures_roll\') OR '
            '(kind IN (\'option_assignment\', \'option_exercise\') '
            'AND option_sec_type = \'FOP\')) '
            f'ORDER BY {_EVENT_ORDER_SQL}',
            (book_id, account),
        ).fetchall()
        positions = {}
        identities = {}

        def apply_identity(item, target=False):
            key = future_key(item, roll_target=target)
            con_column = 'roll_to_con_id' if target else 'future_con_id'
            local_column = 'roll_to_local_symbol' if target else 'future_local_symbol'
            marker = identities.setdefault(key, {'con_ids': set(), 'locals': set()})
            if item[con_column] not in (None, ''):
                marker['con_ids'].add(str(item[con_column]))
            if item[local_column]:
                marker['locals'].add(_normalized_local_symbol(item[local_column]))
            if len(marker['con_ids']) > 1 or (
                    not marker['con_ids'] and len(marker['locals']) > 1):
                raise InvalidRequestError(
                    'multiple real FUT contracts share one account/month/multiplier; '
                    'provide an unambiguous conId/localSymbol history')
            return key

        for row in rows:
            old_key = apply_identity(row, False)
            if row['kind'] == 'futures_roll':
                moved = float(row['future_contracts'] or 0)
                current = positions.get(old_key, 0.0)
                if (not moved or not current or current * moved <= 0
                        or abs(current) + 1e-9 < abs(moved)):
                    raise PositionOverdrawError(
                        f"futures_roll on {row['trade_date']} transfers {moved:g} "
                        f"contracts but the old FUT month holds {current:g}")
                positions[old_key] = current - moved
                new_key = apply_identity(row, True)
                positions[new_key] = positions.get(new_key, 0.0) + moved
            else:
                positions[old_key] = positions.get(old_key, 0.0) \
                    + float(row['future_contracts'] or 0)

    def _net_short_share_warnings(self, conn, book_id):
        """Report only the final replayed share direction.

        Share assignments in one broker settlement batch commonly carry the
        same timestamp.  Their database sequence is an audit tie-breaker, not
        evidence that the account was economically short between two rows.
        Replaying the complete active, included event stream also keeps split
        handling aligned with the browser core instead of summing raw shares.
        """
        rows = conn.execute(
            'SELECT kind, account, shares, split_ratio FROM cost_basis_events '
            'WHERE book_id = ? AND voided_at_utc IS NULL AND include_in_cost = 1 '
            "AND kind IN ('opening_balance','share_trade','option_assignment',"
            "'option_exercise','split') "
            f'ORDER BY {_EVENT_ORDER_SQL}',
            (book_id,),
        ).fetchall()
        positions = {}
        for row in rows:
            account = str(row['account'] or '')
            if row['kind'] == 'split':
                ratio = float(row['split_ratio'] or 0)
                if ratio <= 0:
                    continue
                if account:
                    positions[account] = positions.get(account, 0.0) * ratio
                else:
                    for name in tuple(positions):
                        positions[name] *= ratio
                continue
            positions[account] = positions.get(account, 0.0) \
                + float(row['shares'] or 0)
        return ['net_short_shares'] if any(
            shares < -1e-9 for shares in positions.values()) else []

    def _validate_timeline(self, conn, book_id, normalized, *,
                           check_share_warning=True, check_split_groups=True):
        """Re-run the affected contract's timeline after the insert.

        shares_per_contract is part of the identity: an adjusted contract
        must not be validated against the standard one. A write in an
        account with split groups also re-proves every group, because a
        back-dated row can change what was open at a split.
        """
        warnings = []
        if normalized['kind'] in OPTION_KINDS or normalized['kind'] == 'option_split':
            for strike in _row_strikes(normalized):
                warnings.extend(self._replay_contract_key(
                    conn, book_id, normalized['account'], normalized['right'], strike,
                    normalized['expiry'], normalized['shares_per_contract']))

        if check_share_warning \
                and (normalized['shares'] is not None
                     or normalized['kind'] == 'split'):
            warnings.extend(self._net_short_share_warnings(conn, book_id))
        if normalized['kind'] in FUTURE_KINDS \
                or normalized['future_contracts'] is not None:
            self._validate_futures_timeline(conn, book_id, normalized['account'])
        if check_split_groups:
            self._validate_split_groups(conn, book_id, normalized['account'])
        return warnings

    def _validate_batch_timelines(self, conn, book_id, rows):
        """Judge an atomic batch by its complete economic timeline.

        Input order assigns same-time sequence ties, but is not evidence that
        an explicitly later close happened before an earlier opening. Also a
        backdated pair can temporarily strand an already-stored later close.
        Nothing becomes visible until every affected timeline passes.
        """
        warnings = []
        options = set()
        futures_accounts = set()
        accounts = set()
        for row in rows:
            accounts.add(row['account'])
            if row['kind'] in OPTION_KINDS or row['kind'] == 'option_split':
                for strike in _row_strikes(row):
                    key = (row['account'], row['right'], strike, row['expiry'],
                           row['shares_per_contract'])
                    if key not in options:
                        options.add(key)
                        warnings.extend(self._replay_contract_key(conn, book_id, *key))
            if row['kind'] in FUTURE_KINDS or row['future_contracts'] is not None:
                futures_accounts.add(row['account'])
        for account in futures_accounts:
            self._validate_futures_timeline(conn, book_id, account)
        for account in accounts:
            self._validate_split_groups(conn, book_id, account)
        return warnings

    def _validate_split_groups(self, conn, book_id, account):
        """Prove every split group of one account against the replayed ledger.

        A group is one standard n:1 split: exactly one `split` header and one
        `option_split` row per option series that was open at the open of
        the effective date. Replaying the account's option positions up to
        each group, every such series (expiring on or after that date) must
        be converted exactly once and emptied completely, and no two series
        may land on one adjusted contract. A partial close is not a split,
        so "not more than open" is not enough: the source must end at zero.
        Legacy split rows are checked only for colliding with a group.
        """
        partial = conn.execute(
            'SELECT split_group FROM cost_basis_events WHERE book_id = ? AND account = ? '
            'AND split_group IS NOT NULL GROUP BY split_group '
            'HAVING count(DISTINCT voided_at_utc IS NULL) > 1',
            (book_id, account)).fetchone()
        if partial is not None:
            raise InvalidRequestError(
                f"split group {partial['split_group']} is partly voided; void or keep "
                'the whole group')
        rows = conn.execute(
            'SELECT * FROM cost_basis_events WHERE book_id = ? AND account = ? '
            'AND voided_at_utc IS NULL AND include_in_cost = 1 AND kind IN ('
            "'option_trade','option_assignment','option_exercise','option_expiry',"
            "'option_split','split') "
            f'ORDER BY {_EVENT_ORDER_SQL}',
            (book_id, account)).fetchall()
        groups = {}
        for row in rows:
            if row['split_group']:
                group = groups.setdefault(row['split_group'], {'headers': [], 'legs': []})
                (group['headers'] if row['kind'] == 'split' else group['legs']).append(row)
        if not groups:
            return
        legacy_dates = {row['trade_date'] for row in conn.execute(
            "SELECT trade_date FROM cost_basis_events WHERE book_id = ? AND kind = 'split' "
            'AND split_group IS NULL AND voided_at_utc IS NULL AND include_in_cost = 1 '
            "AND account IN (?, '')", (book_id, account)).fetchall()}
        group_dates = {}
        for group_id, group in groups.items():
            if len(group['headers']) != 1:
                raise InvalidRequestError(
                    f'split group {group_id} needs exactly one split header row')
            header = group['headers'][0]
            date = header['trade_date']
            for leg in group['legs']:
                if leg['trade_date'] != date or leg['split_ratio'] != header['split_ratio']:
                    raise InvalidRequestError(
                        f'every row of split group {group_id} must share its date and ratio')
            if date in group_dates:
                raise InvalidRequestError(
                    f'{account} already has a split group on {date}; one split per day')
            if date in legacy_dates:
                raise InvalidRequestError(
                    f'a plain split row already records a split on {date}; void it '
                    'before recording the split group')
            group_dates[date] = group_id
        dates = sorted(group_dates)

        # Every option movement with its structural key and split epoch.
        entries = []
        by_key = {}
        for row in rows:
            if row['kind'] == 'split':
                entries.append({'row': row})
                continue
            grouped = bool(row['split_group'])
            for movement in _option_movements(row):
                side = movement['side']
                if side == 'split_in':
                    epoch = bisect_left(dates, row['trade_date']) + 1
                elif grouped:
                    epoch = bisect_left(dates, row['trade_date'])
                else:
                    epoch = bisect_right(dates, row['trade_date'])
                key = (movement['right'], float(movement['strike']), movement['expiry'],
                       movement['shares_per_contract'])
                entry = {**movement, 'row': row, 'key': key, 'epoch': epoch}
                entries.append(entry)
                by_key.setdefault(key, []).append(entry)
        for key, items in by_key.items():
            for item, identity, ambiguous in _resolve_contract_identity_rows(
                    items, lambda entry: entry['epoch']):
                if ambiguous:
                    raise InvalidRequestError(
                        'option event needs conId or an exact localSymbol because '
                        'multiple real contracts share its account, right, strike, '
                        'expiry and multiplier')
                item['position_key'] = (key, identity)

        def describe(key):
            right, strike, expiry, _ = key
            return f'{right}{strike:g} {expiry}'

        positions = {}
        epochs = {}
        applied = set()
        for entry in entries:
            row = entry['row']
            group_id = row['split_group']
            if not group_id:
                if 'position_key' in entry:
                    position_key = entry['position_key']
                    positions[position_key] = positions.get(position_key, 0.0) \
                        + float(entry['contracts'] or 0)
                    epochs[position_key] = entry['epoch']
                continue
            if group_id in applied:
                continue
            applied.add(group_id)
            group = groups[group_id]
            date = group['headers'][0]['trade_date']
            before = bisect_left(dates, date)
            legs = {}
            for leg_entry in (item for item in entries
                              if item['row']['split_group'] == group_id and 'side' in item):
                legs.setdefault(leg_entry['row']['event_id'], {})[leg_entry['side']] = leg_entry
            sources = {}
            targets = set()
            for pair in legs.values():
                out, into = pair['split_out'], pair['split_in']
                source, target = out['position_key'], into['position_key']
                held = positions.get(source, 0.0)
                moved = float(out['contracts'] or 0)
                if source in sources:
                    raise InvalidRequestError(
                        f'split group on {date} converts {describe(out["key"])} twice')
                if abs(held) <= 1e-9:
                    raise InvalidRequestError(
                        f'split group on {date} converts {describe(out["key"])}, '
                        'but nothing is open there')
                if abs(held + moved) > 1e-9:
                    raise InvalidRequestError(
                        f'split group on {date} moves {-moved:g} of {describe(out["key"])} '
                        f'while {held:g} is open; a split moves the whole position')
                if target in targets:
                    raise InvalidRequestError(
                        f'split group on {date} converts two series into '
                        f'{describe(into["key"])}')
                sources[source] = (out, into)
                targets.add(target)
            expiry_floor = date.replace('-', '')
            for position_key, held in positions.items():
                if abs(held) <= 1e-9 or epochs.get(position_key) != before:
                    continue
                key = position_key[0]
                if key[2] and key[2] < expiry_floor:
                    continue
                if position_key not in sources:
                    raise InvalidRequestError(
                        f'split group on {date} leaves {held:g} of {describe(key)} '
                        'unconverted; every option series open at the split must move')
            for source, (out, into) in sources.items():
                positions[source] = positions.get(source, 0.0) + float(out['contracts'])
                target = into['position_key']
                positions[target] = positions.get(target, 0.0) + float(into['contracts'])
                epochs[target] = into['epoch']

    def _check_standard_split_legs(self, conn, book, rows):
        """A1 converts only the standard option class of the ledger's symbol.

        The class is read from option symbols (`TQQQ` vs the adjusted
        `2TQQQ`): the leg's own and every earlier row of the same series.
        A series with no symbol on record needs the operator's explicit
        confirmation, recorded on the leg; the deliverable must be the
        ledger's standard contract size.
        """
        symbol = str(book['symbol']).upper()
        for leg in rows:
            if leg['kind'] != 'option_split':
                continue
            label = f"{leg['right']}{leg['strike']:g} {leg['expiry']}"
            if leg['shares_per_contract'] != book['defaultSharesPerContract']:
                raise InvalidRequestError(
                    f"{label} delivers {leg['shares_per_contract']} shares per contract; "
                    'only the standard contract can be converted by a split group')
            history = conn.execute(
                'SELECT DISTINCT local_symbol FROM cost_basis_events WHERE book_id = ? '
                'AND account = ? AND right = ? AND strike = ? AND expiry = ? '
                'AND shares_per_contract IS ? AND trade_date < ? AND voided_at_utc IS NULL '
                'AND local_symbol IS NOT NULL',
                (book['bookId'], leg['account'], leg['right'], leg['strike'], leg['expiry'],
                 leg['shares_per_contract'], leg['trade_date'])).fetchall()
            symbols = {row['local_symbol'] for row in history}
            if leg['local_symbol']:
                symbols.add(leg['local_symbol'])
            foreign = sorted({_option_root(item) for item in symbols} - {symbol})
            if foreign:
                raise InvalidRequestError(
                    f"{label} is recorded as option class {', '.join(foreign)}; a split group "
                    f'converts only the standard {symbol} class')
            if not symbols and not leg['split_standard_confirmed']:
                raise InvalidRequestError(
                    f'{label} has no option symbol on record; confirm it is the standard '
                    f'{symbol} class (splitStandardConfirmed) before converting it')
            if leg['split_to_local_symbol'] \
                    and _option_root(leg['split_to_local_symbol']) != symbol:
                raise InvalidRequestError(
                    f"{label}: the adjusted contract's symbol names another option class")

    @staticmethod
    def _validate_mixed_option_trade(row, position, contracts):
        # C/O explicitly promises both a close and a new opposite opening.
        # Do not relax pure-C protection or let missing history create a lot.
        if row['kind'] != 'option_trade' or row['tag'] != 'ibkr_close_open':
            return
        if (abs(position) <= 1e-6 or position * contracts >= 0
                or abs(contracts) <= abs(position) + 1e-6):
            raise PositionOverdrawError(
                f"IBKR C/O trade on {row['trade_date']} changes {contracts:g} "
                f'contracts but the ledger holds {position:g}; it requires '
                'a smaller opposite position to close and reverse')

    @staticmethod
    def _raise_or_warn_overdraw(row, position, contracts, allow_overdraw, warnings):
        detail = (
            f"{row['kind']} on {row['trade_date']} closes {abs(contracts):g} "
            f"contracts but the ledger shows {position:g} open at that date"
        )
        if allow_overdraw:
            warnings.append(f'overdraw:{detail}')
            return
        raise PositionOverdrawError(detail)

    def _tws_option_replay_proves_supersession(
            self, conn, book_id, baseline, incoming_rows, proof):
        """Validate a targeted TWS fill replay against the stored ledger.

        The UI supplies the current TWS quantity it just reconciled, but it
        cannot supply the ledger side of the proof: that value is recomputed
        here inside the write transaction.  This makes a stale preview fail
        instead of deleting a provisional row after the ledger has changed.
        """
        if proof is None:
            return False
        if not isinstance(proof, dict) or proof.get('kind') != 'option':
            raise InvalidRequestError('twsReconciliation must describe one option')
        descriptor = {
            'account': _optional_account(proof.get('account')),
            'right': str(proof.get('right') or '').strip().upper()[:1],
            'strike': _number(proof.get('strike'), 'twsReconciliation.strike',
                              allow_none=False),
            'expiry': _optional_expiry(proof.get('expiry')),
            'sharesPerContract': _positive_int(
                proof.get('sharesPerContract'),
                'twsReconciliation.sharesPerContract', allow_none=False),
        }
        if descriptor['right'] not in ('C', 'P') or not descriptor['expiry']:
            raise InvalidRequestError('twsReconciliation option identity is incomplete')
        if contract_key(descriptor) != contract_key(baseline):
            raise InvalidRequestError(
                'twsReconciliation does not match the adopted TWS baseline')
        proof_con_id = _positive_int(
            proof.get('conId'), 'twsReconciliation.conId')
        baseline_con_id = baseline.get('conId')
        if (proof_con_id and baseline_con_id
                and str(proof_con_id) != str(baseline_con_id)):
            raise InvalidRequestError(
                'twsReconciliation conId does not match the adopted baseline')
        ledger_contracts = _number(
            proof.get('ledgerContracts'), 'twsReconciliation.ledgerContracts',
            allow_none=False)
        tws_contracts = _number(
            proof.get('twsContracts'), 'twsReconciliation.twsContracts',
            allow_none=False)

        active_rows = conn.execute(
            'SELECT * FROM cost_basis_events WHERE book_id = ? '
            'AND voided_at_utc IS NULL AND include_in_cost = 1 '
            'AND account = ? AND contracts IS NOT NULL',
            (book_id, descriptor['account']),
        ).fetchall()
        current_contracts = 0.0
        for active_row in active_rows:
            # A split conversion counts on both contracts it touches.
            for movement in _option_movements(active_row):
                if contract_key(movement) != contract_key(descriptor):
                    continue
                active_con_id = movement['con_id']
                if (proof_con_id and active_con_id
                        and str(proof_con_id) != str(active_con_id)):
                    continue
                current_contracts += float(movement['contracts'] or 0)
        if abs(current_contracts - ledger_contracts) >= 1e-6:
            raise InvalidRequestError(
                'the ledger changed after the TWS reconciliation preview')

        matching = []
        for item in incoming_rows:
            if (item['kind'] != 'option_trade'
                    or item['source'] != 'execution_report'
                    or item['tag'] not in ('ibkr_exec', 'ibkr_close')
                    or item['contracts'] is None
                    or contract_key(item) != contract_key(descriptor)):
                continue
            item_con_id = item.get('con_id')
            if (proof_con_id and item_con_id
                    and str(proof_con_id) != str(item_con_id)):
                continue
            if not item.get('broker_timestamp') or not item.get('external_ref'):
                raise InvalidRequestError(
                    'TWS reconciliation executions need broker time and execId')
            duplicate = conn.execute(
                'SELECT 1 FROM cost_basis_events WHERE book_id = ? '
                'AND account = ? AND external_ref = ?',
                (book_id, item['account'], item['external_ref']),
            ).fetchone()
            if duplicate is not None:
                raise InvalidRequestError(
                    'the TWS reconciliation preview is stale; an execId already exists')
            matching.append(item)
        if not matching:
            raise InvalidRequestError(
                'twsReconciliation contains no matching TWS executions')
        replayed = (current_contracts - float(baseline.get('contracts') or 0)
                    + sum(float(item['contracts'] or 0) for item in matching))
        if abs(replayed - tws_contracts) >= 1e-6:
            raise InvalidRequestError(
                'ordered TWS executions do not reach the reconciled TWS position')
        return True

    def _validate_batch_tws_reconciliations(self, conn, book_id, proofs,
                                            event_ids, incoming_rows):
        """Prove every selected contract within the same write transaction.

        A list is the batch variant of the existing single-option proof. The
        normal ledger-version guard and idempotent import receipt still apply.
        No position snapshot is converted into an economic event here.
        """
        if not isinstance(proofs, list):
            return
        if not proofs or len(proofs) > MAX_IMPORT_EVENTS:
            raise InvalidRequestError('TWS reconciliation batch must contain option proofs')
        if event_ids is not None and (not isinstance(event_ids, list)
                                     or any(not isinstance(x, str) for x in event_ids)):
            raise InvalidRequestError('supersedeTwsEventIds must contain strings')
        if len(event_ids or []) > MAX_IMPORT_EVENTS:
            raise InvalidRequestError('too many TWS baselines to supersede')
        selected_baselines = {}
        for event_id in event_ids or []:
            row = conn.execute(
                'SELECT * FROM cost_basis_events WHERE book_id = ? AND event_id = ?',
                (book_id, event_id),
            ).fetchone()
            if row is not None:
                baseline = _event_row_to_dict(row)
                selected_baselines.setdefault(contract_key(baseline), []).append(baseline)
        seen = set()
        covered = set()
        for proof in proofs:
            if not isinstance(proof, dict) or proof.get('kind') != 'option':
                raise InvalidRequestError('TWS reconciliation batch must describe options')
            try:
                key = contract_key(proof)
            except (TypeError, ValueError, OverflowError) as exc:
                raise InvalidRequestError('invalid TWS reconciliation identity') from exc
            if key in seen:
                raise InvalidRequestError('duplicate contract in TWS reconciliation batch')
            seen.add(key)
            baselines = selected_baselines.get(key, [])
            if len(baselines) > 1:
                raise InvalidRequestError('ambiguous adopted TWS option baselines')
            baseline = baselines[0] if baselines else {**proof, 'contracts': 0}
            self._tws_option_replay_proves_supersession(
                conn, book_id, baseline, incoming_rows, proof)
            for item in incoming_rows:
                if (item['kind'] == 'option_trade' and contract_key(item) == key
                        and item['tag'] in ('ibkr_exec', 'ibkr_close')
                        and not (proof.get('conId') and item.get('con_id')
                                 and str(proof['conId']) != str(item['con_id']))):
                    covered.add((item['account'], item['external_ref']))
        for item in incoming_rows:
            ref = item['external_ref'] or ''
            rebate = (item['kind'] == 'fee' and item['tag'] == 'ibkr_rebate'
                      and ref.endswith('-rebate'))
            if rebate:
                ref = ref[:-7]
            if (not rebate and item['kind'] != 'option_trade'):
                raise InvalidRequestError('non-option event in reconciled TWS batch')
            if (item['source'] != 'execution_report'
                    or (item['account'], ref) not in covered):
                raise InvalidRequestError('execution is outside the reconciled TWS batch')

    def _validate_tws_supersessions(self, conn, book_id, event_ids, incoming_rows,
                                    tws_reconciliation=None):
        """Return active provisional rows that broker history can replace.

        The browser supplies candidate ids for preview purposes, but the
        store independently proves the economic condition: broker-history rows
        at or before the snapshot must reconstruct the exact adopted
        quantity. A later incremental statement therefore cannot erase its
        opening basis, even if a buggy or forged client sends the id.
        """
        if event_ids is None:
            return []
        if not isinstance(event_ids, list):
            raise InvalidRequestError('supersedeTwsEventIds must be a list')
        if len(event_ids) > MAX_IMPORT_EVENTS:
            raise InvalidRequestError(
                f'at most {MAX_IMPORT_EVENTS} TWS baselines may be superseded')
        if any(not isinstance(event_id, str) for event_id in event_ids):
            raise InvalidRequestError('supersedeTwsEventIds must contain strings')
        if len(set(event_ids)) != len(event_ids):
            raise InvalidRequestError('supersedeTwsEventIds contains duplicates')

        selected = []
        for event_id in event_ids:
            _require_token('supersedeTwsEventId', event_id)
            row = conn.execute(
                'SELECT * FROM cost_basis_events WHERE book_id = ? AND event_id = ?',
                (book_id, event_id),
            ).fetchone()
            if row is None:
                raise InvalidRequestError('a TWS baseline to supersede was not found')
            baseline = _event_row_to_dict(row)
            if (row['voided_at_utc'] or not row['include_in_cost']
                    or row['source'] != 'reconcile' or row['tag'] != 'tws_snapshot'
                    or row['kind'] not in (
                        'option_trade', 'opening_balance', 'futures_trade')):
                raise InvalidRequestError(
                    'only an active adopted TWS baseline may be superseded')

            if row['kind'] == 'option_trade':
                structural = contract_key(baseline)
                siblings = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE book_id = ? '
                    'AND account = ? AND right = ? AND strike = ? AND expiry = ? '
                    'AND shares_per_contract IS ? AND source = ? AND tag = ? '
                    'AND voided_at_utc IS NULL',
                    (book_id, row['account'], row['right'], row['strike'],
                     row['expiry'], row['shares_per_contract'],
                     'reconcile', 'tws_snapshot'),
                ).fetchall()
                if len(siblings) != 1:
                    raise InvalidRequestError(
                        'ambiguous adopted TWS option baselines require manual review')
                proof = tws_reconciliation
                if isinstance(proof, list):
                    proof = next((item for item in proof
                                  if contract_key(item) == structural), None)
                    if proof is None:
                        raise InvalidRequestError('missing TWS proof for adopted baseline')
                replay_proven = self._tws_option_replay_proves_supersession(
                    conn, book_id, baseline, incoming_rows, proof)
                matching = [item for item in incoming_rows
                            if item['source'] in ('csv_import', 'execution_report')
                            and item['tag'] != 'prior_open'
                            and item['contracts'] is not None
                            and contract_key(item) == structural
                            and _event_precedes_tws_snapshot(item, baseline)]
                con_ids = {str(item['con_id']) for item in matching
                           if item['con_id'] not in (None, '')}
                baseline_con_id = ('' if row['con_id'] in (None, '')
                                   else str(row['con_id']))
                if (not replay_proven and (not matching or len(con_ids) > 1
                        or (baseline_con_id and con_ids
                            and baseline_con_id not in con_ids))):
                    raise InvalidRequestError(
                        'broker history contract identity does not prove this TWS baseline')
                reconstructed = sum(float(item['contracts'] or 0) for item in matching)
                exact_api_execution = _single_execution_reconstructs_option_baseline(
                    baseline, matching, incoming_rows)
                if (not replay_proven
                        and abs(reconstructed - float(row['contracts'] or 0)) >= 1e-6
                        and not exact_api_execution):
                    raise InvalidRequestError(
                        'broker history does not reconstruct the adopted TWS option quantity')
            elif row['kind'] == 'futures_trade':
                baseline_key = future_key(baseline)
                siblings = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE book_id = ? AND account = ? '
                    'AND kind = ? '
                    "AND substr(replace(future_expiry, '-', ''), 1, 6) = ? "
                    'AND shares_per_contract IS ? '
                    'AND source = ? AND tag = ? AND voided_at_utc IS NULL',
                    (book_id, row['account'], 'futures_trade',
                     str(row['future_expiry'] or '').replace('-', '')[:6],
                     row['shares_per_contract'], 'reconcile', 'tws_snapshot'),
                ).fetchall()
                if len(siblings) != 1:
                    raise InvalidRequestError(
                        'ambiguous adopted TWS FUT baselines require manual review')
                matching = []
                con_ids = set()
                for item in incoming_rows:
                    if (item['source'] not in ('csv_import', 'execution_report')
                            or item['tag'] == 'prior_open'
                            or not _event_precedes_tws_snapshot(item, baseline)):
                        continue
                    for key, delta in _future_deltas(item):
                        if key != baseline_key:
                            continue
                        matching.append(delta)
                        matching_con_id = _future_con_id_for_key(item, key)
                        if matching_con_id not in (None, ''):
                            con_ids.add(str(matching_con_id))
                baseline_con_id = '' if row['future_con_id'] in (None, '') \
                    else str(row['future_con_id'])
                if (not matching or len(con_ids) > 1
                        or (baseline_con_id and con_ids
                            and baseline_con_id not in con_ids)):
                    raise InvalidRequestError(
                        'broker history FUT identity does not prove this TWS baseline')
                if abs(sum(matching) - float(row['future_contracts'] or 0)) >= 1e-6:
                    raise InvalidRequestError(
                        'broker history does not reconstruct the adopted TWS FUT quantity')
            else:
                siblings = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE book_id = ? AND account = ? '
                    'AND kind = ? AND source = ? AND tag = ? '
                    'AND voided_at_utc IS NULL',
                    (book_id, row['account'], 'opening_balance',
                     'reconcile', 'tws_snapshot'),
                ).fetchall()
                if len(siblings) != 1:
                    raise InvalidRequestError(
                        'ambiguous adopted TWS share baselines require manual review')
                matching = [item for item in incoming_rows
                            if item['source'] in ('csv_import', 'execution_report')
                            and item['tag'] != 'prior_open'
                            and item['account'] == row['account']
                            and item['shares'] is not None
                            and _event_precedes_tws_snapshot(item, baseline)]
                if not matching:
                    raise InvalidRequestError(
                        'broker history does not contain shares for this TWS baseline')
                reconstructed = sum(float(item['shares'] or 0) for item in matching)
                if abs(reconstructed - float(row['shares'] or 0)) >= 1e-6:
                    raise InvalidRequestError(
                        'broker history does not reconstruct the adopted TWS share quantity')
            selected.append(row)
        return selected

    def _validate_prior_stub_supersessions(self, conn, book_id, event_ids,
                                           incoming_rows):
        """Return opening stubs that the incoming real history replaces.

        The browser proposes the ids; the store proves the condition again:
        the incoming statement rows for the stub's contract, dated at or
        before the stub, must sum to EXACTLY the stub's quantity. Anything
        else would leave the contract held twice or half replaced.
        """
        if event_ids is None:
            return []
        if not isinstance(event_ids, list):
            raise InvalidRequestError('supersedePriorStubEventIds must be a list')
        if len(set(event_ids)) != len(event_ids):
            raise InvalidRequestError('supersedePriorStubEventIds contains duplicates')
        incoming_rows = [item for item in incoming_rows if not conn.execute(
            'SELECT 1 FROM cost_basis_events WHERE book_id = ? AND account = ? AND external_ref = ?',
            (book_id, item['account'], item['external_ref'])).fetchone()]
        selected = []
        for event_id in event_ids:
            if not isinstance(event_id, str):
                raise InvalidRequestError('supersedePriorStubEventIds must contain strings')
            _require_token('supersedePriorStubEventId', event_id)
            row = conn.execute(
                'SELECT * FROM cost_basis_events WHERE book_id = ? AND event_id = ?',
                (book_id, event_id),
            ).fetchone()
            if row is None:
                raise InvalidRequestError('an opening stub to supersede was not found')
            if (row['voided_at_utc'] or not row['include_in_cost']
                    or row['source'] != 'csv_import' or row['tag'] not in PRIOR_STUB_TAGS
                    or row['kind'] not in ('option_trade', 'opening_balance')):
                raise InvalidRequestError(
                    'only an active statement opening stub may be superseded')
            stub = _event_row_to_dict(row)
            if row['kind'] == 'option_trade':
                structural = contract_key(stub)
                matching = [item for item in incoming_rows
                            if item['source'] == 'csv_import'
                            and item['kind'] in ('option_trade', 'option_assignment', 'option_exercise', 'option_expiry')
                            and item['tag'] not in PRIOR_STUB_TAGS
                            and item['account'] == row['account']
                            and item['contracts'] is not None
                            and contract_key(item) == structural
                            and not (row['con_id'] not in (None, '')
                                     and item['con_id'] not in (None, '')
                                     and str(row['con_id']) != str(item['con_id']))
                            and item['trade_date'] <= row['trade_date']]
                total = sum(float(item['contracts']) for item in matching)
                target = float(row['contracts'] or 0)
            else:
                matching = [item for item in incoming_rows
                            if item['source'] == 'csv_import'
                            and item['kind'] == 'share_trade'
                            and item['account'] == row['account']
                            and item['shares'] is not None
                            and item['trade_date'] <= row['trade_date']]
                total = sum(float(item['shares']) for item in matching)
                target = float(row['shares'] or 0)
            if not matching or abs(total - target) >= 1e-6:
                raise InvalidRequestError(
                    'the incoming statement rows do not exactly replace the opening '
                    f'stub ({total:g} against {target:g}); import the complete covering '
                    'statement instead')
            selected.append(row)
        return selected

    @staticmethod
    def _stored_row_conflicts(stored, incoming):
        """Name the economic fields where a stored row and a new row with the
        same broker reference disagree; empty means the same trade."""
        differences = []
        for field, tolerance in (
                ('kind', None), ('trade_date', None), ('account', None),
                ('right', None), ('expiry', None), ('strike', 1e-6),
                ('shares_per_contract', 1e-6), ('contracts', 1e-6), ('shares', 1e-6),
                ('future_expiry', None), ('future_contracts', 1e-6),
                ('roll_to_expiry', None), ('roll_to_price', 1e-8), ('split_ratio', 1e-8),
                ('price', 1e-8), ('cash_amount', 0.011), ('fees', 0.011)):
            old = stored[field]
            new = incoming.get(field)
            if tolerance is None:
                if str(old or '') != str(new or ''):
                    differences.append(f'{field} {old!r} -> {new!r}')
                continue
            if old is None and new is None:
                continue
            if old is None or new is None or abs(float(old) - float(new)) > tolerance:
                differences.append(f'{field} {old} -> {new}')
        for field in ('con_id', 'local_symbol', 'option_sec_type', 'future_con_id',
                      'future_local_symbol', 'roll_to_con_id', 'roll_to_local_symbol',
                      'broker_timestamp'):
            if stored[field] and incoming.get(field) and str(stored[field]) != str(incoming[field]):
                differences.append(f'{field} differs')
        return differences

    def _reject_unresolved_tws_overlap(self, conn, book_id, incoming_rows,
                                       superseded_rows):
        """Never append history already economically covered by a baseline.

        Exact complete history is handled by supersession. No pre-snapshot
        rows means an incremental import and is safe to append. Anything between
        those two states is partial/ambiguous overlap and must stop the whole
        batch instead of manufacturing an inverse prior_open quantity while
        retaining both cash flows.
        """
        selected_ids = {row['event_id'] for row in superseded_rows}
        baselines = conn.execute(
            'SELECT * FROM cost_basis_events WHERE book_id = ? '
            'AND source = ? AND tag = ? AND voided_at_utc IS NULL '
            'AND include_in_cost = 1',
            (book_id, 'reconcile', 'tws_snapshot'),
        ).fetchall()
        for row in baselines:
            if row['event_id'] in selected_ids:
                continue
            baseline = _event_row_to_dict(row)
            if row['kind'] == 'option_trade':
                structural = contract_key(baseline)
                overlaps = [item for item in incoming_rows
                            if item['source'] in ('csv_import', 'execution_report')
                            and item['tag'] != 'prior_open'
                            and item['contracts'] is not None
                            and contract_key(item) == structural
                            and not (row['con_id'] not in (None, '')
                                     and item['con_id'] not in (None, '')
                                     and str(row['con_id']) != str(item['con_id']))
                            and _event_may_overlap_tws_snapshot(item, baseline)]
            elif row['kind'] == 'opening_balance':
                overlaps = [item for item in incoming_rows
                            if item['source'] in ('csv_import', 'execution_report')
                            and item['tag'] != 'prior_open'
                            and item['account'] == row['account']
                            and item['shares'] is not None
                            and _event_may_overlap_tws_snapshot(item, baseline)]
            elif row['kind'] == 'futures_trade':
                baseline_key = future_key(baseline)
                overlaps = []
                for item in incoming_rows:
                    if (item['source'] not in ('csv_import', 'execution_report')
                            or item['tag'] == 'prior_open'
                            or not _event_may_overlap_tws_snapshot(item, baseline)):
                        continue
                    if any(key == baseline_key for key, _delta in _future_deltas(item)):
                        overlaps.append(item)
            else:
                overlaps = []
            if overlaps:
                raise InvalidRequestError(
                    'broker history overlaps an adopted TWS baseline but does not '
                    'safely supersede it; import a complete covering statement '
                    'or use reviewed rebuild')

    def import_events(self, book_id, events, *, import_batch_id, client_token_prefix,
                      allow_overdraw=False, supersede_tws_event_ids=None,
                      tws_reconciliation=None, expected_ledger_version=None,
                      book_identity=None, supersede_prior_stub_event_ids=None,
                      statement=None):
        """Bulk-append reviewed rows from a broker statement.

        Rows whose external_ref already exists with the same economics are
        skipped, not merged: an overlapping statement re-import must be a
        no-op, never a duplicate cost entry. The same reference with
        different economics is a broker revision and stops the batch. The
        whole batch commits or none of it does. With a statement registration
        an empty batch is allowed: it records that a period with no rows for
        this book was checked.
        """
        _require_token('importBatchId', import_batch_id)
        _require_token('clientTokenPrefix', client_token_prefix)
        if not isinstance(events, list):
            raise InvalidRequestError('events must be a list')
        registration = self._statement_registration(statement)
        if not events and registration is None:
            raise InvalidRequestError('events must not be empty')
        if len(events) > MAX_IMPORT_EVENTS:
            raise InvalidRequestError(
                f'an import batch is limited to {MAX_IMPORT_EVENTS} rows')

        conn = self._connect()
        try:
            book = self._get_book(conn, book_id)
            self._require_book_identity(book, book_identity)
            normalized_rows = self._normalize_event_batch(
                conn, book_id, events, book, include_existing_history=True)
            _refuse_split_group_rows(normalized_rows)
            conn.execute('BEGIN IMMEDIATE')
            try:
                existing_batch = conn.execute(
                    'SELECT count(*) AS total FROM cost_basis_events '
                    'WHERE book_id = ? AND import_batch_id = ?',
                    (book_id, import_batch_id),
                ).fetchone()['total']
                if not existing_batch and registration is not None:
                    existing_batch = conn.execute(
                        'SELECT count(*) AS total FROM cost_basis_import_batches '
                        'WHERE book_id = ? AND batch_id = ?',
                        (book_id, import_batch_id),
                    ).fetchone()['total']
                if existing_batch:
                    superseded = conn.execute(
                        'SELECT count(*) AS total FROM cost_basis_events '
                        'WHERE book_id = ? AND voided_by_event_id = ?',
                        (book_id, f'{import_batch_id}-supersede'),
                    ).fetchone()['total']
                    conn.execute('ROLLBACK')
                    return {
                        'bookId': book_id,
                        'importBatchId': import_batch_id,
                        'inserted': 0,
                        'skipped': int(existing_batch),
                        'supersededTwsBaselines': int(superseded or 0),
                        'warnings': [],
                        'idempotentReplay': True,
                    }

                self._require_ledger_version(conn, book_id, expected_ledger_version)
                self._validate_batch_tws_reconciliations(
                    conn, book_id, tws_reconciliation, supersede_tws_event_ids,
                    normalized_rows)
                superseded_rows = self._validate_tws_supersessions(
                    conn, book_id, supersede_tws_event_ids, normalized_rows,
                    tws_reconciliation)
                self._reject_unresolved_tws_overlap(
                    conn, book_id, normalized_rows, superseded_rows)
                superseded_stubs = self._validate_prior_stub_supersessions(
                    conn, book_id, supersede_prior_stub_event_ids, normalized_rows)
                supersede_stamp = self._utc_now_iso()
                supersede_token = f'{import_batch_id}-supersede'
                for row in superseded_rows:
                    conn.execute(
                        'UPDATE cost_basis_events SET voided_at_utc = ?, '
                        'voided_by_event_id = ?, void_reason = ? WHERE event_id = ?',
                        (supersede_stamp, supersede_token,
                         'Superseded atomically by complete broker execution history',
                         row['event_id']),
                    )
                for row in superseded_stubs:
                    conn.execute(
                        'UPDATE cost_basis_events SET voided_at_utc = ?, '
                        'voided_by_event_id = ?, void_reason = ? WHERE event_id = ?',
                        (supersede_stamp, supersede_token,
                         'Opening stub superseded by the statement that opened the position',
                         row['event_id']),
                    )

                inserted = 0
                skipped = 0
                warnings = []
                inserted_rows = []
                for index, normalized in enumerate(normalized_rows):
                    if normalized['external_ref']:
                        duplicate = conn.execute(
                            'SELECT * FROM cost_basis_events WHERE book_id = ? '
                            'AND account = ? AND external_ref = ?',
                            (book_id, normalized['account'], normalized['external_ref']),
                        ).fetchone()
                        if duplicate is not None:
                            if duplicate['voided_at_utc'] or not duplicate['include_in_cost']:
                                raise ImportRevisionConflictError('stored source reference is voided or excluded; use a corrected complete rebuild')
                            differences = self._stored_row_conflicts(duplicate, normalized)
                            if differences:
                                raise ImportRevisionConflictError(
                                    f"broker reference {normalized['external_ref']} is already "
                                    'stored with different economics ('
                                    + '; '.join(differences)
                                    + '); a revision must replace the stored row (void it, '
                                    'or rebuild from the corrected statement)')
                            skipped += 1
                            continue
                    result = self._insert_event(
                        conn, book, normalized,
                        client_token=f'{client_token_prefix}-{index:05d}',
                        allow_overdraw=allow_overdraw,
                        import_batch_id=import_batch_id,
                        check_share_warning=False,
                        validate_timeline=False,
                    )
                    warnings.extend(result['warnings'])
                    inserted_rows.append(normalized)
                    inserted += 1
                warnings.extend(self._validate_batch_timelines(conn, book_id, inserted_rows))
                # Complete batch validation covers inserted timelines.
                # Replaying each affected option once more
                # also covers a future batch shape with all rows de-duplicated.
                for row in superseded_rows:
                    self._validate_contract_timeline(conn, book_id, row)
                    if row['kind'] == 'futures_trade':
                        self._validate_futures_timeline(conn, book_id, row['account'])
                for row in superseded_stubs:
                    if row['kind'] == 'option_trade':
                        self._validate_contract_timeline(conn, book_id, row)
                # Intermediate rows in an atomic import may cross zero only
                # because same-time broker settlements need a deterministic
                # sequence.  Surface the direction after the whole batch.
                warnings.extend(self._net_short_share_warnings(conn, book_id))
                changed_dates = [row['trade_date'] for row in inserted_rows + list(superseded_stubs) + list(superseded_rows)]
                if changed_dates:
                    self._invalidate_coverage(conn, book_id, min(changed_dates))
                self._register_batch(
                    conn, book_id, import_batch_id, 'append', registration,
                    inserted=inserted, skipped=skipped)
                if inserted or superseded_rows or superseded_stubs:
                    conn.execute(
                        'UPDATE cost_basis_books SET updated_at_utc = ? WHERE book_id = ?',
                        (self._utc_now_iso(), book_id))
                ledger_version = self._ledger_version(conn, book_id)
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return {
                'bookId': book_id,
                'importBatchId': import_batch_id,
                'inserted': inserted,
                'skipped': skipped,
                'supersededTwsBaselines': len(superseded_rows),
                'supersededPriorStubs': len(superseded_stubs),
                'warnings': sorted(set(warnings)),
                'ledgerVersion': ledger_version,
                'idempotentReplay': False,
            }
        except sqlite3.IntegrityError as exc:
            raise self._map_integrity_error(exc) from exc
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def list_events(self, book_id, *, account=None, kinds=None, start_date=None,
                    end_date=None, include_voided=False, limit=None, offset=0):
        limit = DEFAULT_EVENT_PAGE_SIZE if limit is None else int(limit)
        if limit < 1 or limit > MAX_EVENT_PAGE_SIZE:
            raise InvalidRequestError(f'limit must be 1-{MAX_EVENT_PAGE_SIZE}')
        offset = int(offset or 0)
        if offset < 0 or offset > MAX_SQLITE_INTEGER:
            raise InvalidRequestError(
                f'offset must be between 0 and {MAX_SQLITE_INTEGER}')

        clauses = ['book_id = ?']
        params = [book_id]
        if account:
            clauses.append('account = ?')
            params.append(_optional_account(account))
        if kinds:
            if not isinstance(kinds, (list, tuple)):
                raise InvalidRequestError('kinds must be a list')
            if len(kinds) > len(EVENT_KINDS):
                raise InvalidRequestError(
                    f'kinds may contain at most {len(EVENT_KINDS)} entries')
            for kind in kinds:
                if kind not in EVENT_KINDS:
                    raise InvalidRequestError(f'unknown kind {kind}')
            clauses.append(f'kind IN ({", ".join("?" for _ in kinds)})')
            params.extend(kinds)
        if start_date:
            clauses.append('trade_date >= ?')
            params.append(_require_trade_date(start_date, 'startDate'))
        if end_date:
            clauses.append('trade_date <= ?')
            params.append(_require_trade_date(end_date, 'endDate'))
        if not include_voided:
            clauses.append('voided_at_utc IS NULL')
        where = ' AND '.join(clauses)

        conn = self._connect()
        try:
            conn.execute('BEGIN')
            self._get_book(conn, book_id)
            total = conn.execute(
                f'SELECT count(*) AS total FROM cost_basis_events WHERE {where}',
                params,
            ).fetchone()['total']
            rows = conn.execute(
                f'SELECT * FROM cost_basis_events WHERE {where} '
                f'ORDER BY {_EVENT_ORDER_SQL} LIMIT ? OFFSET ?',
                (*params, limit, offset),
            ).fetchall()
            return {
                'bookId': book_id,
                'total': int(total or 0),
                'limit': limit,
                'offset': offset,
                'events': [_event_row_to_dict(row) for row in rows],
                'ledgerVersion': self._ledger_version(conn, book_id),
            }
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def append_split_group(self, book_id, events, *, client_token,
                           expected_ledger_version=None, book_identity=None):
        """Record one standard split and its option conversions atomically.

        `events` is the header `split` row plus one `option_split` row per
        option series open at the split (see the core's planSplitGroup). The
        server names the group from the client token, so a retry finds the
        committed group instead of recording the split twice. Every row is
        re-derived and every group invariant is proven against the stored
        ledger inside the write transaction; nothing from the client is
        trusted, and a failure writes nothing.
        """
        _require_token('clientToken', client_token)
        if not isinstance(events, list) or not events:
            raise InvalidRequestError('events must be a non-empty list')
        if len(events) > MAX_IMPORT_EVENTS:
            raise InvalidRequestError(
                f'a split group is limited to {MAX_IMPORT_EVENTS} rows')
        group_id = f'split-{client_token}'
        conn = self._connect()
        try:
            book = self._get_book(conn, book_id)
            self._require_book_identity(book, book_identity)
            if not str(book.get('account') or '').strip():
                raise InvalidRequestError(
                    'split groups need a single-account ledger; this legacy ledger mixes accounts')
            normalized = []
            for item in events:
                if not isinstance(item, dict) or item.get('kind') not in ('split', 'option_split'):
                    raise InvalidRequestError(
                        'a split group holds one split row and option_split rows only')
                if item.get('splitGroup') not in (None, '', group_id):
                    raise InvalidRequestError('the server names the split group')
                normalized.append(_validate_event_shape(
                    _bind_event_to_book_account({**item, 'splitGroup': group_id}, book), book))
            headers = [row for row in normalized if row['kind'] == 'split']
            if len(headers) != 1:
                raise InvalidRequestError('a split group needs exactly one split row')
            header = headers[0]
            for row in normalized:
                if row['trade_date'] != header['trade_date'] \
                        or row['split_ratio'] != header['split_ratio']:
                    raise InvalidRequestError(
                        'every row of a split group shares its date and ratio')
            ordered = [header] + [row for row in normalized if row is not header]
            conn.execute('BEGIN IMMEDIATE')
            try:
                replay = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE book_id = ? AND split_group = ? '
                    'ORDER BY seq', (book_id, group_id)).fetchall()
                if replay:
                    conn.execute('ROLLBACK')
                    return {
                        'bookId': book_id, 'splitGroup': group_id,
                        'events': [_event_row_to_dict(row) for row in replay],
                        'warnings': [], 'idempotentReplay': True,
                    }
                if conn.execute('SELECT 1 FROM cost_basis_events WHERE client_token = ?',
                                (f'{client_token}-00000',)).fetchone() is not None:
                    raise InvalidRequestError('clientToken has already been used')
                self._require_ledger_version(conn, book_id, expected_ledger_version)
                self._check_standard_split_legs(conn, book, ordered)
                for index, row in enumerate(ordered):
                    self._insert_event(
                        conn, book, row, client_token=f'{client_token}-{index:05d}',
                        allow_overdraw=False, check_share_warning=False,
                        validate_timeline=False)
                warnings = self._validate_batch_timelines(conn, book_id, ordered)
                warnings.extend(self._net_short_share_warnings(conn, book_id))
                self._invalidate_coverage(conn, book_id, header['trade_date'])
                stored = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE book_id = ? AND split_group = ? '
                    'ORDER BY seq', (book_id, group_id)).fetchall()
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return {
                'bookId': book_id, 'splitGroup': group_id,
                'events': [_event_row_to_dict(row) for row in stored],
                'warnings': sorted(set(warnings)), 'idempotentReplay': False,
            }
        except sqlite3.IntegrityError as exc:
            raise self._map_integrity_error(exc) from exc
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def void_split_group(self, book_id, split_group, *, reason, client_token):
        """Void every row of one split group together, or nothing.

        Post-split history resolves against the group, so removing it can
        strand later closes; the same replays that guard a write guard this.
        """
        _require_token('clientToken', client_token)
        split_group = _optional_text(split_group, 'splitGroup', MAX_EXTERNAL_REF_CHARS)
        if not split_group:
            raise InvalidRequestError('splitGroup is required')
        reason = _optional_text(reason, 'reason', MAX_NOTE_CHARS)
        if not reason:
            raise InvalidRequestError('a void requires a reason')
        conn = self._connect()
        try:
            self._get_book(conn, book_id)
            conn.execute('BEGIN IMMEDIATE')
            try:
                replay = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE book_id = ? '
                    'AND voided_by_event_id = ? ORDER BY seq', (book_id, client_token),
                ).fetchall()
                if replay:
                    conn.execute('ROLLBACK')
                    return {
                        'bookId': book_id, 'splitGroup': replay[0]['split_group'],
                        'events': [_event_row_to_dict(row) for row in replay],
                        'idempotentReplay': True,
                    }
                rows = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE book_id = ? AND split_group = ? '
                    'ORDER BY seq', (book_id, split_group)).fetchall()
                if not rows:
                    conn.execute('ROLLBACK')
                    raise EventNotFoundError('no split group with that id in this ledger')
                if all(row['voided_at_utc'] for row in rows):
                    conn.execute('ROLLBACK')
                    raise EventAlreadyVoidedError('split group is already voided')
                conn.execute(
                    'UPDATE cost_basis_events SET voided_at_utc = ?, voided_by_event_id = ?, '
                    'void_reason = ? WHERE book_id = ? AND split_group = ? '
                    'AND voided_at_utc IS NULL',
                    (self._utc_now_iso(), client_token, reason, book_id, split_group))
                for row in rows:
                    self._validate_contract_timeline(conn, book_id, row)
                self._validate_split_groups(conn, book_id, rows[0]['account'])
                self._invalidate_coverage(conn, book_id, rows[0]['trade_date'])
                voided = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE book_id = ? AND split_group = ? '
                    'ORDER BY seq', (book_id, split_group)).fetchall()
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return {
                'bookId': book_id, 'splitGroup': split_group,
                'events': [_event_row_to_dict(row) for row in voided],
                'idempotentReplay': False,
            }
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def void_event(self, book_id, event_id, *, reason, client_token):
        """Mark one event void. Append-only: the row stays, and the flow
        table can show it, because an audit trail that hides its own
        corrections is not an audit trail."""
        _require_token('clientToken', client_token)
        _require_token('eventId', event_id)
        reason = _optional_text(reason, 'reason', MAX_NOTE_CHARS)
        if not reason:
            raise InvalidRequestError('a void requires a reason')

        conn = self._connect()
        try:
            self._get_book(conn, book_id)
            conn.execute('BEGIN IMMEDIATE')
            try:
                replay = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE book_id = ? '
                    'AND voided_by_event_id = ?', (book_id, client_token),
                ).fetchone()
                if replay is not None:
                    # A retry after a dropped socket must report the same
                    # success, not "already voided" - the caller cannot tell
                    # that apart from voiding the wrong row.
                    conn.execute('ROLLBACK')
                    return {
                        'bookId': book_id,
                        'event': _event_row_to_dict(replay),
                        'idempotentReplay': True,
                    }

                row = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE book_id = ? AND event_id = ?',
                    (book_id, event_id),
                ).fetchone()
                if row is None:
                    conn.execute('ROLLBACK')
                    raise EventNotFoundError('no event with that id in this ledger')
                if row['voided_at_utc']:
                    conn.execute('ROLLBACK')
                    raise EventAlreadyVoidedError('event is already voided')
                if row['split_group']:
                    conn.execute('ROLLBACK')
                    raise InvalidRequestError(
                        'this row belongs to a split group; void the whole group')
                conn.execute(
                    'UPDATE cost_basis_events SET voided_at_utc = ?, '
                    'voided_by_event_id = ?, void_reason = ? WHERE event_id = ?',
                    (self._utc_now_iso(), client_token, reason, event_id),
                )
                # Removing an OPENING strands every close that stood on it.
                # The same replay that guards an insert has to guard a
                # removal, or the ledger ends up holding an assignment with
                # nothing behind it - exactly the state append_event refuses
                # to create in the first place.
                self._validate_contract_timeline(conn, book_id, row)
                if row['kind'] in FUTURE_KINDS or row['future_contracts'] is not None:
                    self._validate_futures_timeline(conn, book_id, row['account'])
                self._validate_split_groups(conn, book_id, row['account'])
                self._invalidate_coverage(conn, book_id, row['trade_date'])
                voided = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE event_id = ?', (event_id,)
                ).fetchone()
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return {
                'bookId': book_id,
                'event': _event_row_to_dict(voided),
                'idempotentReplay': False,
            }
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Rebuild
    # ------------------------------------------------------------------

    def reset_confirmation(self, book_id):
        """The exact phrase that authorises wiping this book.

        Server-computed and count-bearing on purpose: if the ledger changed
        between the moment the operator read the phrase and the moment they
        submitted it, the phrase no longer matches and the wipe is refused
        instead of destroying something they never saw.
        """
        conn = self._connect()
        try:
            book = self._get_book(conn, book_id)
            counts = conn.execute(
                'SELECT count(*) AS total, '
                '       sum(CASE WHEN voided_at_utc IS NULL THEN 1 ELSE 0 END) AS live '
                'FROM cost_basis_events WHERE book_id = ?', (book_id,)
            ).fetchone()
            total = int(counts['total'] or 0)
            live = int(counts['live'] or 0)
            dates = conn.execute(
                'SELECT min(trade_date) AS first_date, max(trade_date) AS last_date '
                'FROM cost_basis_events WHERE book_id = ? AND voided_at_utc IS NULL',
                (book_id,),
            ).fetchone()
            return {
                'bookId': book_id,
                'account': book['account'],
                'symbol': book['symbol'],
                # The phrase counts what will actually be DELETED. Quoting
                # only the live rows would understate the loss by every
                # voided row, which the wipe removes just the same.
                'eventCount': total,
                'liveEventCount': live,
                'voidedEventCount': total - live,
                'firstTradeDate': dates['first_date'] or '',
                'lastTradeDate': dates['last_date'] or '',
                'phrase': _reset_phrase(book['account'], book['symbol'], total),
                # The phrase is a human-readable summary; this digest is the
                # credential. A rebuild must present the digest of the ledger
                # it was planned against.
                'ledgerVersion': self._ledger_version(conn, book_id),
            }
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def reset_book(self, book_id, *, confirmation, client_token, reason='',
                   expected_ledger_version=None, book_identity=None):
        """Empty a book so it can be rebuilt from statements.

        The rows are archived into cost_basis_book_resets as JSON BEFORE they
        are deleted, so a rebuild is reversible even though the active ledger
        ends up genuinely clean rather than littered with tombstones. This is
        the one operation allowed to delete events, and only behind a typed,
        count-bearing phrase.
        """
        _require_token('clientToken', client_token)
        reason = _optional_text(reason, 'reason', MAX_NOTE_CHARS)

        conn = self._connect()
        try:
            book = self._get_book(conn, book_id)
            self._require_book_identity(book, book_identity)
            conn.execute('BEGIN IMMEDIATE')
            try:
                replay = conn.execute(
                    'SELECT * FROM cost_basis_book_resets WHERE client_token = ?',
                    (client_token,),
                ).fetchone()
                if replay is not None:
                    conn.execute('ROLLBACK')
                    if replay['book_id'] != book_id:
                        raise InvalidRequestError(
                            'clientToken has already been used for another ledger')
                    return {
                        'bookId': book_id,
                        'resetId': replay['reset_id'],
                        'removedEvents': int(replay['event_count']),
                        'idempotentReplay': True,
                    }

                rows = [
                    _event_row_to_dict(row) for row in conn.execute(
                        'SELECT * FROM cost_basis_events WHERE book_id = ? '
                        'ORDER BY seq ASC', (book_id,))
                ]
                expected = _reset_phrase(
                    book['account'], book['symbol'], len(rows))
                if str(confirmation or '').strip() != expected:
                    conn.execute('ROLLBACK')
                    raise ResetConfirmationError(
                        f'type exactly: {expected}'
                    )

                self._require_ledger_version(conn, book_id, expected_ledger_version)
                encoded = json.dumps(rows, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':'))
                reset_id = uuid.uuid4().hex
                conn.execute(
                    'INSERT INTO cost_basis_book_resets (reset_id, book_id, '
                    'client_token, reset_at_utc, event_count, events_sha256, '
                    'events_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    (
                        reset_id, book_id, client_token, self._utc_now_iso(),
                        len(rows),
                        hashlib.sha256(encoded.encode('utf-8')).hexdigest(),
                        encoded, reason,
                    ),
                )
                self._archive_coverage(conn, book_id, reset_id)
                conn.execute('DELETE FROM cost_basis_events WHERE book_id = ?',
                             (book_id,))
                conn.execute(
                    'UPDATE cost_basis_books SET updated_at_utc = ? WHERE book_id = ?',
                    (self._utc_now_iso(), book_id))
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return {
                'bookId': book_id,
                'resetId': reset_id,
                'removedEvents': len(rows),
                'idempotentReplay': False,
            }
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def rebuild_book(self, book_id, events, *, confirmation, client_token,
                     import_batch_id, allow_overdraw=False, reason='',
                     expected_ledger_version=None, book_identity=None,
                     statement=None):
        """Archive, empty and refill a book inside ONE transaction.

        Splitting this into a reset call and an import call leaves a window
        where the ledger is empty and the replacement has not landed: a
        validation failure, a busy database, a dropped socket or a closed tab
        in that window costs the operator their whole book. Here every step
        shares one transaction, so a failure anywhere leaves the original
        ledger exactly as it was.
        """
        _require_token('clientToken', client_token)
        _require_token('importBatchId', import_batch_id)
        reason = _optional_text(reason, 'reason', MAX_NOTE_CHARS)
        if not isinstance(events, list) or not events:
            raise InvalidRequestError('events must be a non-empty list')
        if len(events) > MAX_IMPORT_EVENTS:
            raise InvalidRequestError(
                f'a rebuild is limited to {MAX_IMPORT_EVENTS} rows')

        registration = self._statement_registration(statement)
        conn = self._connect()
        try:
            book = self._get_book(conn, book_id)
            self._require_book_identity(book, book_identity)
            # Validate the replacement BEFORE opening the transaction so a
            # malformed batch never even reaches the delete.
            normalized_rows = self._normalize_event_batch(
                conn, book_id, events, book, include_existing_history=False)
            _refuse_split_group_rows(normalized_rows)

            conn.execute('BEGIN IMMEDIATE')
            try:
                replay = conn.execute(
                    'SELECT * FROM cost_basis_book_resets WHERE client_token = ?',
                    (client_token,),
                ).fetchone()
                if replay is not None:
                    conn.execute('ROLLBACK')
                    if replay['book_id'] != book_id:
                        raise InvalidRequestError(
                            'clientToken has already been used for another ledger')
                    return {
                        'bookId': book_id,
                        'resetId': replay['reset_id'],
                        'removedEvents': int(replay['event_count']),
                        'inserted': conn.execute(
                            'SELECT count(*) AS total FROM cost_basis_events '
                            'WHERE book_id = ?', (book_id,)).fetchone()['total'],
                        'idempotentReplay': True,
                    }

                rows = [
                    _event_row_to_dict(row) for row in conn.execute(
                        'SELECT * FROM cost_basis_events WHERE book_id = ? '
                        'ORDER BY seq ASC', (book_id,))
                ]
                expected = _reset_phrase(
                    book['account'], book['symbol'], len(rows))
                if str(confirmation or '').strip() != expected:
                    conn.execute('ROLLBACK')
                    raise ResetConfirmationError(f'type exactly: {expected}')
                # The count-bearing phrase cannot tell one history from
                # another of the same length; the digest can.
                try:
                    self._require_ledger_version(conn, book_id, expected_ledger_version)
                except LedgerChangedError:
                    conn.execute('ROLLBACK')
                    raise ResetConfirmationError(
                        'the ledger changed after this rebuild was planned; the '
                        'plan is stale and nothing was removed')

                encoded = json.dumps(rows, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':'))
                reset_id = uuid.uuid4().hex
                conn.execute(
                    'INSERT INTO cost_basis_book_resets (reset_id, book_id, '
                    'client_token, reset_at_utc, event_count, events_sha256, '
                    'events_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    (
                        reset_id, book_id, client_token, self._utc_now_iso(),
                        len(rows),
                        hashlib.sha256(encoded.encode('utf-8')).hexdigest(),
                        encoded, reason or 'rebuild from statement',
                    ),
                )
                self._archive_coverage(conn, book_id, reset_id)
                conn.execute('DELETE FROM cost_basis_events WHERE book_id = ?',
                             (book_id,))

                inserted = 0
                warnings = []
                for index, normalized in enumerate(normalized_rows):
                    result = self._insert_event(
                        conn, book, normalized,
                        client_token=f'{client_token}-{index:05d}',
                        allow_overdraw=allow_overdraw,
                        import_batch_id=import_batch_id,
                        check_share_warning=False,
                        validate_timeline=False,
                    )
                    warnings.extend(result['warnings'])
                    inserted += 1
                warnings.extend(self._validate_batch_timelines(conn, book_id, normalized_rows))
                warnings.extend(self._net_short_share_warnings(conn, book_id))
                self._register_batch(
                    conn, book_id, import_batch_id, 'rebuild', registration,
                    inserted=inserted, skipped=0)
                conn.execute(
                    'UPDATE cost_basis_books SET updated_at_utc = ? WHERE book_id = ?',
                    (self._utc_now_iso(), book_id))
                ledger_version = self._ledger_version(conn, book_id)
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return {
                'bookId': book_id,
                'resetId': reset_id,
                'removedEvents': len(rows),
                'inserted': inserted,
                'warnings': sorted(set(warnings)),
                'ledgerVersion': ledger_version,
                'idempotentReplay': False,
            }
        except sqlite3.IntegrityError as exc:
            raise self._map_integrity_error(exc) from exc
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def export_backup(self, book_id):
        """A consistent, checksummed, complete event snapshot for file recovery."""
        conn = self._connect()
        try:
            conn.execute('BEGIN')
            book = self._get_book(conn, book_id)
            rows = [_event_row_to_dict(row) for row in conn.execute(
                'SELECT * FROM cost_basis_events WHERE book_id = ? ORDER BY seq', (book_id,))]
            payload = {'book': book, 'events': rows, 'ledgerVersion': self._ledger_version(conn, book_id)}
            encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
            return {'format': 'cost-basis-backup', 'version': 1, 'payload': payload,
                    'sha256': hashlib.sha256(encoded.encode()).hexdigest()}
        finally:
            conn.close()

    def _validated_backup(self, conn, book, backup):
        if not isinstance(backup, dict) or backup.get('format') != 'cost-basis-backup' or backup.get('version') != 1:
            raise InvalidRequestError('unsupported backup format; use the current backup export')
        payload = backup.get('payload')
        if not isinstance(payload, dict):
            raise InvalidRequestError('backup payload is missing')
        try:
            encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
        except (ValueError, TypeError):
            raise InvalidRequestError('backup contains invalid values')
        if hashlib.sha256(encoded.encode()).hexdigest() != backup.get('sha256'):
            raise InvalidRequestError('backup checksum mismatch; nothing restored')
        self._require_book_identity(book, payload.get('book'))
        rows = payload.get('events')
        if not isinstance(rows, list) or len(rows) > 100000:
            raise InvalidRequestError('backup events must be a list of at most 100000 rows')
        seen = set()
        for row in rows:
            if not isinstance(row, dict):
                raise InvalidRequestError('backup contains an invalid event')
            for field in ('eventId', 'clientToken'):
                _require_token(field, row.get(field))
            if row['eventId'] in seen:
                raise InvalidRequestError('backup contains duplicate event ids')
            seen.add(row['eventId'])
            # Validate the event's data independently of its historic void
            # state; the restore retains the original audit fields below.
            self._normalize_event_batch(conn, book['bookId'], [row], book, include_existing_history=False)
            if row.get('account') != book['account']:
                raise InvalidRequestError('backup event belongs to another account')
        events_json = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        return {'events_json': events_json, 'events_sha256': hashlib.sha256(events_json.encode()).hexdigest()}

    def restore_backup(self, book_id, backup, *, confirmation, client_token,
                       expected_ledger_version=None, book_identity=None):
        return self.restore_book_reset(book_id, 'file-backup', backup=backup,
            confirmation=confirmation, client_token=client_token,
            expected_ledger_version=expected_ledger_version, book_identity=book_identity)

    def restore_book_reset(self, book_id, reset_id, *, confirmation, client_token,
                           expected_ledger_version=None, book_identity=None, backup=None):
        """Put an archived ledger back, archiving the current one first.

        The archive holds the rows exactly as they were, voided ones
        included, so they are written back verbatim rather than re-validated
        as new events: the point is to return to a state that existed, not to
        re-judge it. Inside one transaction: archive the live rows, delete
        them, insert the archived rows.
        """
        _require_token('clientToken', client_token)
        _require_token('resetId', reset_id)
        conn = self._connect()
        try:
            book = self._get_book(conn, book_id)
            self._require_book_identity(book, book_identity)
            conn.execute('BEGIN IMMEDIATE')
            try:
                replay = conn.execute(
                    'SELECT * FROM cost_basis_book_resets WHERE client_token = ?',
                    (client_token,),
                ).fetchone()
                if replay is not None:
                    if replay['book_id'] != book_id:
                        raise InvalidRequestError('clientToken belongs to another ledger')
                    conn.execute('ROLLBACK')
                    return {'bookId': book_id, 'resetId': replay['reset_id'],
                            'restoredFrom': reset_id, 'idempotentReplay': True}
                archive = conn.execute(
                    'SELECT * FROM cost_basis_book_resets WHERE book_id = ? AND reset_id = ?',
                    (book_id, reset_id),
                ).fetchone() if backup is None else self._validated_backup(conn, book, backup)
                if archive is None:
                    conn.execute('ROLLBACK')
                    raise InvalidRequestError('rebuild archive not found for this ledger')
                current = [
                    _event_row_to_dict(row) for row in conn.execute(
                        'SELECT * FROM cost_basis_events WHERE book_id = ? '
                        'ORDER BY seq ASC', (book_id,))
                ]
                expected = _reset_phrase(book['account'], book['symbol'], len(current))
                if str(confirmation or '').strip() != expected:
                    conn.execute('ROLLBACK')
                    raise ResetConfirmationError(f'type exactly: {expected}')
                try:
                    self._require_ledger_version(conn, book_id, expected_ledger_version)
                except LedgerChangedError:
                    conn.execute('ROLLBACK')
                    raise ResetConfirmationError(
                        'the ledger changed after this restore was planned')
                encoded = json.dumps(current, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':'))
                new_reset_id = uuid.uuid4().hex
                conn.execute(
                    'INSERT INTO cost_basis_book_resets (reset_id, book_id, '
                    'client_token, reset_at_utc, event_count, events_sha256, '
                    'events_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    (new_reset_id, book_id, client_token, self._utc_now_iso(),
                     len(current),
                     hashlib.sha256(encoded.encode('utf-8')).hexdigest(),
                     encoded, f'restore of archive {reset_id}'),
                )
                self._archive_coverage(conn, book_id, new_reset_id)
                conn.execute('DELETE FROM cost_basis_events WHERE book_id = ?',
                             (book_id,))
                if hashlib.sha256(archive['events_json'].encode('utf-8')).hexdigest() != archive['events_sha256']:
                    raise InvalidRequestError('archive checksum mismatch; nothing restored')
                restored = 0
                for item in json.loads(archive['events_json']):
                    values = {}
                    for column in _EVENT_COLUMNS:
                        camel = _camel(column)
                        value = item.get(camel)
                        if column in ('include_in_cost', 'derived_mismatch', 'allow_overdraw',
                                      'split_standard_confirmed'):
                            value = 1 if value else 0
                        if column == 'book_id':
                            value = book_id
                        values[column] = value
                    if values.get('fees') is None:
                        values['fees'] = 0.0
                    if values.get('tag') is None:
                        values['tag'] = ''
                    if values.get('note') is None:
                        values['note'] = ''
                    if values.get('account') is None:
                        values['account'] = ''
                    if values.get('source') is None:
                        values['source'] = 'manual'
                    if values.get('created_at_utc') is None:
                        values['created_at_utc'] = self._utc_now_iso()
                    conn.execute(
                        f"INSERT INTO cost_basis_events ({', '.join(_EVENT_COLUMNS)}) "
                        f"VALUES ({', '.join('?' for _ in _EVENT_COLUMNS)})",
                        tuple(values[column] for column in _EVENT_COLUMNS),
                    )
                    restored += 1
                # Rows come back verbatim, but a split group is only meaningful
                # as a proven whole; a hand-edited backup must not restore half
                # of one or a conversion the positions do not support.
                for account_row in conn.execute(
                        'SELECT DISTINCT account FROM cost_basis_events WHERE book_id = ? '
                        'AND split_group IS NOT NULL', (book_id,)).fetchall():
                    self._validate_split_groups(conn, book_id, account_row['account'])
                conn.execute(
                    'UPDATE cost_basis_books SET updated_at_utc = ? WHERE book_id = ?',
                    (self._utc_now_iso(), book_id))
                if backup is None:
                    self._restore_coverage(conn, book_id, reset_id)
                # External backups intentionally restore events only. Their
                # verification checks came from another file/environment;
                # import the statements again to establish coverage here.
                ledger_version = self._ledger_version(conn, book_id)
                conn.execute('COMMIT')
            except BaseException:
                self._rollback_quietly(conn)
                raise
            return {
                'bookId': book_id,
                'resetId': new_reset_id,
                'restoredFrom': reset_id,
                'removedEvents': len(current),
                'restoredEvents': restored,
                'ledgerVersion': ledger_version,
                'idempotentReplay': False,
            }
        except sqlite3.IntegrityError as exc:
            raise self._map_integrity_error(exc) from exc
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def list_book_resets(self, book_id, *, limit=20, include_events=False):
        limit = max(1, min(int(limit or 20), 200))
        conn = self._connect()
        try:
            self._get_book(conn, book_id)
            rows = conn.execute(
                'SELECT * FROM cost_basis_book_resets WHERE book_id = ? '
                'ORDER BY reset_at_utc DESC LIMIT ?', (book_id, limit)
            ).fetchall()
            return [{
                'resetId': row['reset_id'],
                'bookId': row['book_id'],
                'resetAtUtc': row['reset_at_utc'],
                'eventCount': int(row['event_count']),
                'eventsSha256': row['events_sha256'],
                'reason': row['reason'],
                **({'events': json.loads(row['events_json'])} if include_events else {}),
            } for row in rows]
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Reconciliation snapshots
    # ------------------------------------------------------------------

    def save_snapshot(self, book_id, *, as_of_date, summary, account_scope='',
                      tws_snapshot=None, reconciled=False, note=''):
        """Record what the ledger said at a point in time.

        events_sha256 covers every live row, so a snapshot taken today can
        prove tomorrow whether the history behind it was edited.
        """
        as_of_date = _require_trade_date(as_of_date, 'asOfDate')
        note = _optional_text(note, 'note', MAX_NOTE_CHARS)
        account_scope = _optional_text(account_scope, 'accountScope', MAX_NOTE_CHARS)
        if not isinstance(summary, dict):
            raise InvalidRequestError('summary must be an object')
        summary_json = _json_for_storage(summary, 'summary')
        tws_snapshot_json = None if tws_snapshot is None else _json_for_storage(
            tws_snapshot, 'twsSnapshot')

        conn = self._connect()
        try:
            self._get_book(conn, book_id)
            rows = conn.execute(
                'SELECT event_id, seq, kind, trade_date, account, right, strike, '
                'broker_timestamp, '
                'expiry, con_id, local_symbol, option_sec_type, '
                'shares_per_contract, contracts, shares, future_expiry, '
                'future_con_id, future_local_symbol, future_contracts, '
                'roll_to_expiry, roll_to_con_id, roll_to_local_symbol, '
                'roll_to_price, roll_group, price, cash_amount, fees, split_ratio, '
                'include_in_cost, tag, source, external_ref, note, split_group, '
                'split_rule_ref, split_rounding, split_to_strike, split_to_contracts, '
                'split_to_con_id, split_to_local_symbol, split_standard_confirmed '
                'FROM cost_basis_events WHERE book_id = ? AND voided_at_utc IS NULL '
                'ORDER BY seq ASC',
                (book_id,),
            ).fetchall()
            digest = hashlib.sha256()
            through_seq = 0
            for row in rows:
                through_seq = max(through_seq, int(row['seq']))
                digest.update(json.dumps(
                    [row[key] for key in row.keys()],
                    ensure_ascii=False, sort_keys=True, separators=(',', ':'),
                ).encode('utf-8'))
            snapshot_id = uuid.uuid4().hex
            conn.execute(
                'INSERT INTO cost_basis_snapshots (snapshot_id, book_id, taken_at_utc, '
                'as_of_date, account_scope, through_seq, event_count, events_sha256, '
                'summary_json, tws_snapshot_json, reconciled, note) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (
                    snapshot_id, book_id, self._utc_now_iso(), as_of_date,
                    account_scope, through_seq, len(rows), digest.hexdigest(),
                    summary_json,
                    tws_snapshot_json,
                    1 if reconciled else 0, note,
                ),
            )
            return self._get_snapshot(conn, snapshot_id)
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def list_snapshots(self, book_id, *, limit=50):
        limit = max(1, min(int(limit or 50), 500))
        conn = self._connect()
        try:
            self._get_book(conn, book_id)
            rows = conn.execute(
                'SELECT * FROM cost_basis_snapshots WHERE book_id = ? '
                'ORDER BY taken_at_utc DESC LIMIT ?',
                (book_id, limit),
            ).fetchall()
            return [_snapshot_row_to_dict(row) for row in rows]
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def _get_snapshot(self, conn, snapshot_id):
        row = conn.execute(
            'SELECT * FROM cost_basis_snapshots WHERE snapshot_id = ?', (snapshot_id,)
        ).fetchone()
        return _snapshot_row_to_dict(row)

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    def describe(self):
        conn = self._connect()
        try:
            books = conn.execute(
                'SELECT count(*) AS total FROM cost_basis_books '
                'WHERE archived_at_utc IS NULL').fetchone()['total']
            events = conn.execute(
                'SELECT count(*) AS total FROM cost_basis_events '
                'WHERE voided_at_utc IS NULL').fetchone()['total']
            page_size = conn.execute('PRAGMA page_size').fetchone()[0]
            page_count = conn.execute('PRAGMA page_count').fetchone()[0]
            return {
                'schemaVersion': SCHEMA_USER_VERSION,
                'bookCount': int(books or 0),
                'eventCount': int(events or 0),
                'allocatedBytes': int(page_size) * int(page_count),
            }
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    @staticmethod
    def _rollback_quietly(conn):
        try:
            conn.execute('ROLLBACK')
        except sqlite3.Error:
            pass

    @staticmethod
    def _map_integrity_error(exc):
        message = str(exc)
        if 'client_token' in message:
            return InvalidRequestError('clientToken has already been used')
        if 'external_ref' in message:
            return InvalidRequestError('externalRef has already been imported')
        return InvalidRequestError(message)


def _camel(column):
    """snake_case column name -> the camelCase key _event_row_to_dict emits."""
    parts = column.split('_')
    return parts[0] + ''.join(part.capitalize() for part in parts[1:])


def _reset_phrase(account, symbol, row_count):
    """The phrase counts EVERY row the wipe removes, voided ones included."""
    identity = f'{account} {symbol}'.strip()
    return f'RESET {identity} {row_count} EVENTS'


def _delete_phrase(account, symbol, event_count, snapshot_count, reset_count):
    """Name the book plus every related row class that will be destroyed."""
    identity = f'{account} {symbol}'.strip()
    return (f'DELETE {identity} {event_count} EVENTS '
            f'{snapshot_count} SNAPSHOTS {reset_count} RESETS')


def _book_row_to_dict(row):
    return {
        'bookId': row['book_id'],
        'account': row['account'],
        'symbol': row['symbol'],
        'secType': row['sec_type'],
        'currency': row['currency'],
        'defaultSharesPerContract': int(row['default_shares_per_contract']),
        'defaultMultiplier': int(row['default_shares_per_contract']),
        'startDate': row['start_date'],
        'note': row['note'],
        'createdAtUtc': row['created_at_utc'],
        'updatedAtUtc': row['updated_at_utc'],
        'archivedAtUtc': row['archived_at_utc'],
    }


def _event_row_to_dict(row):
    return {
        'eventId': row['event_id'],
        'bookId': row['book_id'],
        'seq': int(row['seq']),
        'clientToken': row['client_token'],
        'kind': row['kind'],
        'tradeDate': row['trade_date'],
        'brokerTimestamp': row['broker_timestamp'],
        'account': row['account'],
        'right': row['right'],
        'strike': row['strike'],
        'expiry': row['expiry'],
        'conId': row['con_id'],
        'localSymbol': row['local_symbol'],
        'optionSecType': row['option_sec_type'],
        'sharesPerContract': row['shares_per_contract'],
        'contracts': row['contracts'],
        'shares': row['shares'],
        'futureExpiry': row['future_expiry'],
        'futureConId': row['future_con_id'],
        'futureLocalSymbol': row['future_local_symbol'],
        'futureContracts': row['future_contracts'],
        'rollToExpiry': row['roll_to_expiry'],
        'rollToConId': row['roll_to_con_id'],
        'rollToLocalSymbol': row['roll_to_local_symbol'],
        'rollToPrice': row['roll_to_price'],
        'rollGroup': row['roll_group'],
        'price': row['price'],
        'cashAmount': row['cash_amount'],
        'fees': row['fees'],
        'splitRatio': row['split_ratio'],
        'splitGroup': row['split_group'],
        'splitRuleRef': row['split_rule_ref'],
        'splitRounding': row['split_rounding'],
        'splitToStrike': row['split_to_strike'],
        'splitToContracts': row['split_to_contracts'],
        'splitToConId': row['split_to_con_id'],
        'splitToLocalSymbol': row['split_to_local_symbol'],
        'splitStandardConfirmed': bool(row['split_standard_confirmed']),
        'includeInCost': bool(row['include_in_cost']),
        'tag': row['tag'],
        'source': row['source'],
        'externalRef': row['external_ref'],
        'importBatchId': row['import_batch_id'],
        'derivedMismatch': bool(row['derived_mismatch']),
        'allowOverdraw': bool(row['allow_overdraw']),
        'note': row['note'],
        'createdAtUtc': row['created_at_utc'],
        'voidedAtUtc': row['voided_at_utc'],
        'voidReason': row['void_reason'],
    }


def _snapshot_row_to_dict(row):
    return {
        'snapshotId': row['snapshot_id'],
        'bookId': row['book_id'],
        'takenAtUtc': row['taken_at_utc'],
        'asOfDate': row['as_of_date'],
        'accountScope': row['account_scope'],
        'throughSeq': int(row['through_seq']),
        'eventCount': int(row['event_count']),
        'eventsSha256': row['events_sha256'],
        'summary': _json_from_snapshot(row['summary_json']),
        'twsSnapshot': _json_from_snapshot(row['tws_snapshot_json']),
        'reconciled': bool(row['reconciled']),
        'note': row['note'],
    }
