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
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from portfolio_store import default_app_data_dir

SCHEMA_USER_VERSION = 5

MAX_SYMBOL_CHARS = 32
MAX_ACCOUNT_CHARS = 32
MAX_NOTE_CHARS = 500
MAX_TAG_CHARS = 64
MAX_LOCAL_SYMBOL_CHARS = 64
MAX_EXTERNAL_REF_CHARS = 128
MAX_IMPORT_EVENTS = 5000
DEFAULT_EVENT_PAGE_SIZE = 200
MAX_EVENT_PAGE_SIZE = 2000

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

EVENT_SOURCES = ('manual', 'reconcile', 'csv_import', 'execution_report')

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
                                'manual_adjust','futures_trade','futures_roll')),
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
) + _V2_TABLE_STATEMENTS

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
    'fees', 'split_ratio', 'include_in_cost', 'tag', 'source', 'external_ref',
    'import_batch_id', 'derived_mismatch', 'note', 'created_at_utc',
    'voided_at_utc', 'voided_by_event_id', 'void_reason',
)

_EVENT_ORDER_SQL = (
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


def _resolve_contract_identity_rows(rows):
    """Group one structural contract timeline by its real broker identity.

    A row without conId/localSymbol may join an identified contract only
    when the structural group has exactly one possible identity. With two
    concrete contracts it stays ambiguous instead of closing whichever row
    happens to sort first.
    """
    rows = list(rows)
    con_ids = {
        str(row['con_id']) for row in rows
        if row['con_id'] not in (None, '')
    }
    local_symbols = {
        str(row['local_symbol']).strip().upper() for row in rows
        if row['local_symbol']
    }
    local_to_con_ids = {}
    for row in rows:
        if row['con_id'] in (None, '') or not row['local_symbol']:
            continue
        local_symbol = str(row['local_symbol']).strip().upper()
        local_to_con_ids.setdefault(local_symbol, set()).add(str(row['con_id']))

    resolved = []
    for row in rows:
        con_id = '' if row['con_id'] in (None, '') else str(row['con_id'])
        local_symbol = str(row['local_symbol'] or '').strip().upper()
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


_BROKER_TIMESTAMP_RE = re.compile(
    r'(\d{4}-\d{2}-\d{2})[,\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?')


def _exact_event_timestamp(event):
    """Return official local broker ordering evidence, with legacy fallbacks."""
    for field in ('brokerTimestamp', 'broker_timestamp'):
        try:
            explicit = event[field]
        except (KeyError, IndexError, TypeError):
            explicit = event.get(field) if hasattr(event, 'get') else None
        if explicit and _BROKER_TIMESTAMP_FIELD_RE.match(str(explicit)):
            return str(explicit)
    note = str(event.get('note') or '')
    match = _BROKER_TIMESTAMP_RE.search(note)
    if match:
        return (
            f'{match.group(1)}T{match.group(2).zfill(2)}:'
            f'{match.group(3)}:{match.group(4) or "00"}'
        )

    # Legacy TWS baselines predate the note-level snapshot timestamp, but
    # their immutable SQLite creation time is still exact. Both the browser
    # snapshot and IBKR Activity Statement are recorded in this machine's
    # local time, so convert UTC back to local for the same comparison. A
    # timezone/date disagreement stays ambiguous and therefore fail-closed.
    source = event.get('source') if hasattr(event, 'get') else event['source']
    tag = event.get('tag') if hasattr(event, 'get') else event['tag']
    if source != 'reconcile' or tag != 'tws_snapshot':
        return ''
    created = (event.get('createdAtUtc') or event.get('created_at_utc') or '') \
        if hasattr(event, 'get') else event['created_at_utc']
    try:
        parsed = datetime.fromisoformat(str(created).replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            return ''
        local = parsed.astimezone()
    except (TypeError, ValueError):
        return ''
    trade_date = (event.get('tradeDate') or event.get('trade_date') or '') \
        if hasattr(event, 'get') else event['trade_date']
    if local.strftime('%Y-%m-%d') != str(trade_date):
        return ''
    return local.strftime('%Y-%m-%dT%H:%M:%S')


def _event_precedes_tws_snapshot(event, baseline):
    exact_snapshot = _exact_event_timestamp(baseline)
    if exact_snapshot:
        exact_event = _exact_event_timestamp(event)
        if exact_event:
            return exact_event <= exact_snapshot
        return event['trade_date'] < baseline['tradeDate']
    # A truly legacy/corrupt row with neither an audit-note timestamp nor a
    # usable immutable creation time remains ambiguous on the same day.
    return event['trade_date'] < baseline['tradeDate']


def _event_may_overlap_tws_snapshot(event, baseline):
    """True when a CSV row is before, or ambiguously on, the snapshot."""
    exact_snapshot = _exact_event_timestamp(baseline)
    exact_event = _exact_event_timestamp(event)
    if exact_snapshot and exact_event:
        return exact_event <= exact_snapshot
    return event['trade_date'] <= baseline['tradeDate']


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
    if kind == 'split':
        return 0.0
    return None


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
        'include_in_cost': 0 if payload.get('includeInCost') is False else 1,
        'tag': _optional_text(payload.get('tag'), 'tag', MAX_TAG_CHARS),
        'source': source,
        'external_ref': _optional_text(
            payload.get('externalRef'), 'externalRef', MAX_EXTERNAL_REF_CHARS) or None,
        'note': _optional_text(payload.get('note'), 'note', MAX_NOTE_CHARS),
    }

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
    if kind == 'dividend' and event['cash_amount'] < 0:
        raise InvalidRequestError('dividend cashAmount must be positive; use a fee event for a charge')
    if kind == 'fee' and event['cash_amount'] > 0:
        raise InvalidRequestError('fee cashAmount must be negative; use a dividend event for income')

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
            conn.execute('BEGIN IMMEDIATE')
            try:
                replay = conn.execute(
                    'SELECT * FROM cost_basis_events WHERE client_token = ?',
                    (client_token,),
                ).fetchone()
                if replay is not None:
                    conn.execute('ROLLBACK')
                    stored = _event_row_to_dict(replay)
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
        return event

    def _insert_event(self, conn, book, normalized, *, client_token,
                      allow_overdraw, import_batch_id=None):
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
            'fees, split_ratio, '
            'include_in_cost, tag, source, external_ref, import_batch_id, '
            'derived_mismatch, note, created_at_utc'
            ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '
            '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
                normalized['split_ratio'],
                normalized['include_in_cost'], normalized['tag'], normalized['source'],
                normalized['external_ref'], import_batch_id,
                normalized['derived_mismatch'], normalized['note'], stamp,
            ),
        )

        warnings = self._validate_timeline(
            conn, book_id, normalized, allow_overdraw=allow_overdraw)

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
        """Replay one contract's timeline and refuse any stranded close."""
        if row['kind'] not in OPTION_KINDS:
            return
        rows = conn.execute(
            'SELECT event_id, kind, trade_date, broker_timestamp, seq, contracts, '
            'con_id, local_symbol, tag '
            'FROM cost_basis_events '
            'WHERE book_id = ? AND account = ? AND right = ? AND strike = ? '
            'AND expiry = ? AND shares_per_contract IS ? AND voided_at_utc IS NULL '
            f'ORDER BY {_EVENT_ORDER_SQL}',
            (book_id, row['account'], row['right'], row['strike'], row['expiry'],
             row['shares_per_contract']),
        ).fetchall()
        positions = {}
        for item, identity, ambiguous in _resolve_contract_identity_rows(rows):
            if ambiguous:
                raise InvalidRequestError(
                    'voiding would leave an option event with an ambiguous '
                    'contract identity; add conId or an exact localSymbol')
            position = positions.get(identity, 0.0)
            contracts = float(item['contracts'] or 0)
            if (item['kind'] == 'option_trade' and item['tag'] == 'ibkr_open'
                    and abs(position) > 1e-9 and position * contracts < 0):
                raise PositionOverdrawError(
                    f"voiding would leave IBKR O trade on {item['trade_date']} "
                    'opposite an existing position')
            if item['kind'] in CLOSING_KINDS or (
                    item['kind'] == 'option_trade'
                    and item['tag'] == 'ibkr_close'):
                if contracts > 0 and position > -contracts + 1e-9:
                    raise PositionOverdrawError(
                        f"voiding this row would leave the {item['kind']} on "
                        f"{item['trade_date']} without an opening behind it"
                    )
                if contracts < 0 and position < -contracts - 1e-9:
                    raise PositionOverdrawError(
                        f"voiding this row would leave the {item['kind']} on "
                        f"{item['trade_date']} without an opening behind it"
                    )
            positions[identity] = position + contracts

    def _validate_futures_timeline(self, conn, book_id, account):
        """Replay every FUT movement for one account and prove each roll.

        Ordinary futures trades may legitimately cross through zero, but a
        row explicitly labelled as a roll promises that it transfers an
        already-held signed quantity from one month to another. That promise
        is enforced for back-dated inserts and voids as well as tail writes.
        """
        rows = conn.execute(
            'SELECT * FROM cost_basis_events WHERE book_id = ? AND account = ? '
            'AND voided_at_utc IS NULL AND ('
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
                marker['locals'].add(str(item[local_column]).strip().upper())
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

    def _validate_timeline(self, conn, book_id, normalized, *, allow_overdraw):
        """Re-run the affected contract's timeline after the insert.

        Back-dating is legitimate - you record history out of order - but a
        back-dated close can strand a *later* assignment that no longer has
        a short position behind it. Checking only the tail would let that
        through, so the whole contract timeline is replayed and any stranded
        closing event fails the write.
        """
        warnings = []
        if normalized['kind'] in OPTION_KINDS:
            # shares_per_contract is part of the identity: an adjusted
            # contract must not be validated against the standard one.
            key_fields = (
                book_id, normalized['account'], normalized['right'],
                normalized['strike'], normalized['expiry'],
                normalized['shares_per_contract'],
            )
            rows = conn.execute(
                'SELECT event_id, kind, trade_date, broker_timestamp, seq, '
                'contracts, con_id, '
                'local_symbol, tag '
                'FROM cost_basis_events '
                'WHERE book_id = ? AND account = ? AND right = ? AND strike = ? '
                'AND expiry = ? AND shares_per_contract IS ? AND voided_at_utc IS NULL '
                f'ORDER BY {_EVENT_ORDER_SQL}',
                key_fields,
            ).fetchall()
            positions = {}
            for row, identity, ambiguous in _resolve_contract_identity_rows(rows):
                if ambiguous:
                    raise InvalidRequestError(
                        'option event needs conId or an exact localSymbol because '
                        'multiple real contracts share its account, right, strike, '
                        'expiry and multiplier')
                position = positions.get(identity, 0.0)
                contracts = float(row['contracts'] or 0)
                if (row['kind'] == 'option_trade' and row['tag'] == 'ibkr_open'
                        and abs(position) > 1e-9 and position * contracts < 0):
                    raise PositionOverdrawError(
                        f"IBKR O trade on {row['trade_date']} opposes the existing "
                        f'{position:g} contracts; it cannot be treated as a close')
                broker_close = row['kind'] == 'option_trade' \
                    and row['tag'] == 'ibkr_close'
                if row['kind'] in CLOSING_KINDS or broker_close:
                    # A closing event must be backed by an opposite-signed
                    # position of at least its own size.
                    if contracts > 0 and position > -contracts + 1e-9:
                        self._raise_or_warn_overdraw(
                            row, position, contracts,
                            False if broker_close else allow_overdraw, warnings)
                    elif contracts < 0 and position < -contracts - 1e-9:
                        self._raise_or_warn_overdraw(
                            row, position, contracts,
                            False if broker_close else allow_overdraw, warnings)
                positions[identity] = position + contracts

        if normalized['shares'] is not None or normalized['kind'] == 'split':
            total = conn.execute(
                'SELECT COALESCE(sum(shares), 0) AS total FROM cost_basis_events '
                'WHERE book_id = ? AND account = ? AND voided_at_utc IS NULL',
                (book_id, normalized['account']),
            ).fetchone()['total']
            if float(total or 0) < -1e-9:
                warnings.append('net_short_shares')
        if normalized['kind'] in FUTURE_KINDS \
                or normalized['future_contracts'] is not None:
            self._validate_futures_timeline(conn, book_id, normalized['account'])
        return warnings

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

    def _validate_tws_supersessions(self, conn, book_id, event_ids, incoming_rows):
        """Return active provisional rows that this CSV can fully replace.

        The browser supplies candidate ids for preview purposes, but the
        store independently proves the economic condition: broker CSV rows
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
                matching = [item for item in incoming_rows
                            if item['source'] == 'csv_import'
                            and item['tag'] != 'prior_open'
                            and item['contracts'] is not None
                            and contract_key(item) == structural
                            and _event_precedes_tws_snapshot(item, baseline)]
                con_ids = {str(item['con_id']) for item in matching
                           if item['con_id'] not in (None, '')}
                baseline_con_id = ('' if row['con_id'] in (None, '')
                                   else str(row['con_id']))
                if (not matching or len(con_ids) > 1
                        or (baseline_con_id and con_ids
                            and baseline_con_id not in con_ids)):
                    raise InvalidRequestError(
                        'CSV contract identity does not prove this TWS baseline')
                reconstructed = sum(float(item['contracts'] or 0) for item in matching)
                if abs(reconstructed - float(row['contracts'] or 0)) >= 1e-6:
                    raise InvalidRequestError(
                        'CSV history does not reconstruct the adopted TWS option quantity')
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
                    if (item['source'] != 'csv_import' or item['tag'] == 'prior_open'
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
                        'CSV FUT identity does not prove this TWS baseline')
                if abs(sum(matching) - float(row['future_contracts'] or 0)) >= 1e-6:
                    raise InvalidRequestError(
                        'CSV history does not reconstruct the adopted TWS FUT quantity')
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
                            if item['source'] == 'csv_import'
                            and item['tag'] != 'prior_open'
                            and item['account'] == row['account']
                            and item['shares'] is not None
                            and _event_precedes_tws_snapshot(item, baseline)]
                if not matching:
                    raise InvalidRequestError(
                        'CSV does not contain share history for this TWS baseline')
                reconstructed = sum(float(item['shares'] or 0) for item in matching)
                if abs(reconstructed - float(row['shares'] or 0)) >= 1e-6:
                    raise InvalidRequestError(
                        'CSV history does not reconstruct the adopted TWS share quantity')
            selected.append(row)
        return selected

    def _reject_unresolved_tws_overlap(self, conn, book_id, incoming_rows,
                                       superseded_rows):
        """Never append history already economically covered by a baseline.

        Exact complete history is handled by supersession. No pre-snapshot
        rows means an incremental CSV and is safe to append. Anything between
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
                            if item['source'] == 'csv_import'
                            and item['tag'] != 'prior_open'
                            and item['contracts'] is not None
                            and contract_key(item) == structural
                            and not (row['con_id'] not in (None, '')
                                     and item['con_id'] not in (None, '')
                                     and str(row['con_id']) != str(item['con_id']))
                            and _event_may_overlap_tws_snapshot(item, baseline)]
            elif row['kind'] == 'opening_balance':
                overlaps = [item for item in incoming_rows
                            if item['source'] == 'csv_import'
                            and item['tag'] != 'prior_open'
                            and item['account'] == row['account']
                            and item['shares'] is not None
                            and _event_may_overlap_tws_snapshot(item, baseline)]
            elif row['kind'] == 'futures_trade':
                baseline_key = future_key(baseline)
                overlaps = []
                for item in incoming_rows:
                    if (item['source'] != 'csv_import' or item['tag'] == 'prior_open'
                            or not _event_may_overlap_tws_snapshot(item, baseline)):
                        continue
                    if any(key == baseline_key for key, _delta in _future_deltas(item)):
                        overlaps.append(item)
            else:
                overlaps = []
            if overlaps:
                raise InvalidRequestError(
                    'CSV history overlaps an adopted TWS baseline but does not '
                    'safely supersede it; import a complete covering statement '
                    'or use reviewed rebuild')

    def import_events(self, book_id, events, *, import_batch_id, client_token_prefix,
                      allow_overdraw=False, supersede_tws_event_ids=None):
        """Bulk-append reviewed rows from a broker statement.

        Rows whose external_ref already exists are skipped, not merged: an
        overlapping statement re-import must be a no-op, never a duplicate
        cost entry. The whole batch commits or none of it does.
        """
        _require_token('importBatchId', import_batch_id)
        _require_token('clientTokenPrefix', client_token_prefix)
        if not isinstance(events, list):
            raise InvalidRequestError('events must be a list')
        if not events:
            raise InvalidRequestError('events must not be empty')
        if len(events) > MAX_IMPORT_EVENTS:
            raise InvalidRequestError(
                f'an import batch is limited to {MAX_IMPORT_EVENTS} rows')

        conn = self._connect()
        try:
            book = self._get_book(conn, book_id)
            normalized_rows = [
                _validate_event_shape(_bind_event_to_book_account(item, book), book)
                for item in events
            ]
            conn.execute('BEGIN IMMEDIATE')
            try:
                existing_batch = conn.execute(
                    'SELECT count(*) AS total FROM cost_basis_events '
                    'WHERE book_id = ? AND import_batch_id = ?',
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

                superseded_rows = self._validate_tws_supersessions(
                    conn, book_id, supersede_tws_event_ids, normalized_rows)
                self._reject_unresolved_tws_overlap(
                    conn, book_id, normalized_rows, superseded_rows)
                supersede_stamp = self._utc_now_iso()
                supersede_token = f'{import_batch_id}-supersede'
                for row in superseded_rows:
                    conn.execute(
                        'UPDATE cost_basis_events SET voided_at_utc = ?, '
                        'voided_by_event_id = ?, void_reason = ? WHERE event_id = ?',
                        (supersede_stamp, supersede_token,
                         'Superseded atomically by complete broker CSV history',
                         row['event_id']),
                    )

                inserted = 0
                skipped = 0
                warnings = []
                for index, normalized in enumerate(normalized_rows):
                    if normalized['external_ref']:
                        duplicate = conn.execute(
                            'SELECT 1 FROM cost_basis_events WHERE book_id = ? '
                            'AND account = ? AND external_ref = ?',
                            (book_id, normalized['account'], normalized['external_ref']),
                        ).fetchone()
                        if duplicate is not None:
                            skipped += 1
                            continue
                    result = self._insert_event(
                        conn, book, normalized,
                        client_token=f'{client_token_prefix}-{index:05d}',
                        allow_overdraw=allow_overdraw,
                        import_batch_id=import_batch_id,
                    )
                    warnings.extend(result['warnings'])
                    inserted += 1
                # Inserting the replacement rows normally validates these
                # timelines already. Replaying each affected option once more
                # also covers a future batch shape with all rows de-duplicated.
                for row in superseded_rows:
                    self._validate_contract_timeline(conn, book_id, row)
                    if row['kind'] == 'futures_trade':
                        self._validate_futures_timeline(conn, book_id, row['account'])
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
                'warnings': sorted(set(warnings)),
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
        if offset < 0:
            raise InvalidRequestError('offset must not be negative')

        clauses = ['book_id = ?']
        params = [book_id]
        if account:
            clauses.append('account = ?')
            params.append(_optional_account(account))
        if kinds:
            if not isinstance(kinds, (list, tuple)):
                raise InvalidRequestError('kinds must be a list')
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
                'phrase': _reset_phrase(book['account'], book['symbol'], total),
            }
        except sqlite3.Error as exc:
            raise self._map_sqlite_error(exc) from exc
        finally:
            conn.close()

    def reset_book(self, book_id, *, confirmation, client_token, reason=''):
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
            conn.execute('BEGIN IMMEDIATE')
            try:
                replay = conn.execute(
                    'SELECT * FROM cost_basis_book_resets WHERE client_token = ?',
                    (client_token,),
                ).fetchone()
                if replay is not None:
                    conn.execute('ROLLBACK')
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
                     import_batch_id, allow_overdraw=False, reason=''):
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

        conn = self._connect()
        try:
            book = self._get_book(conn, book_id)
            # Validate the replacement BEFORE opening the transaction so a
            # malformed batch never even reaches the delete.
            normalized_rows = [
                _validate_event_shape(_bind_event_to_book_account(item, book), book)
                for item in events
            ]

            conn.execute('BEGIN IMMEDIATE')
            try:
                replay = conn.execute(
                    'SELECT * FROM cost_basis_book_resets WHERE client_token = ?',
                    (client_token,),
                ).fetchone()
                if replay is not None:
                    conn.execute('ROLLBACK')
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
                    )
                    warnings.extend(result['warnings'])
                    inserted += 1
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
                'inserted': inserted,
                'warnings': sorted(set(warnings)),
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
                'include_in_cost, tag, source, external_ref, note '
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
                    json.dumps(summary, ensure_ascii=False, sort_keys=True,
                               separators=(',', ':')),
                    json.dumps(tws_snapshot, ensure_ascii=False, sort_keys=True,
                               separators=(',', ':')) if tws_snapshot is not None else None,
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
        'includeInCost': bool(row['include_in_cost']),
        'tag': row['tag'],
        'source': row['source'],
        'externalRef': row['external_ref'],
        'importBatchId': row['import_batch_id'],
        'derivedMismatch': bool(row['derived_mismatch']),
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
        'summary': json.loads(row['summary_json']),
        'twsSnapshot': json.loads(row['tws_snapshot_json']) if row['tws_snapshot_json'] else None,
        'reconciled': bool(row['reconciled']),
        'note': row['note'],
    }
