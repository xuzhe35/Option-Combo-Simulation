"""Read-only IB execution serialization for the blended-cost ledger.

This module deliberately has no dependency on ``ib_async``.  The live server
passes its Fill objects in; tests can pass small stand-ins.  It never places,
modifies, or cancels an order and it never writes the ledger.
"""

from datetime import datetime
import math
import re


SUPPORTED_SEC_TYPES = frozenset(('STK', 'OPT', 'FOP', 'FUT'))


def _text(value):
    return str(value or '').strip()


def _upper(value):
    return _text(value).upper()


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or abs(number) >= 1e100:
        return None
    return number


def _contract_date(value):
    digits = ''.join(character for character in _text(value) if character.isdigit())
    return digits[:8]


_LOCAL_TIMESTAMP_RE = re.compile(
    r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$')


def _wall_clock(value, target_timezone=None):
    """Return one wall clock in the explicitly selected broker timezone.

    ``ib_async`` exposes executions as aware datetimes converted to its
    wrapper timezone (UTC by default).  Dropping that tzinfo would relabel a
    UTC instant as TWS local time.  Naive values are retained only for small
    stand-ins and legacy callers that already supply broker-local wall time.
    """
    if not isinstance(value, datetime):
        return ''
    if value.tzinfo is not None:
        if target_timezone is None:
            return ''
        value = value.astimezone(target_timezone)
    return value.replace(tzinfo=None, microsecond=0).strftime('%Y-%m-%dT%H:%M:%S')


def execution_filter_time(since_timestamp, broker_now):
    """Build the TWS execution filter using the TWS wall clock.

    CSV cutoffs are already broker-local timestamps.  When no CSV cutoff is
    available the server passes ``now`` in the TWS timezone so the fallback
    begins at the broker's day boundary, never the browser's local midnight.
    """
    text = str(since_timestamp or '').strip()[:19]
    if _LOCAL_TIMESTAMP_RE.match(text):
        try:
            return datetime.strptime(text, '%Y-%m-%dT%H:%M:%S').strftime(
                '%Y%m%d-%H:%M:%S')
        except ValueError:
            pass
    if not isinstance(broker_now, datetime) or broker_now.tzinfo is None:
        return ''
    return broker_now.replace(hour=0, minute=0, second=0, microsecond=0).strftime(
        '%Y%m%d-%H:%M:%S')


_NO_COMMISSION_OVERRIDE = object()


def serialize_fill(
        fill, *, target_timezone=None,
        commission_report_override=_NO_COMMISSION_OVERRIDE):
    """Turn one ib_async Fill into a JSON-safe execution row.

    BAG summary fills are intentionally excluded.  IB normally returns the
    actual option/stock legs as separate fills; accepting the BAG row as well
    would double-count the same combo execution.
    """
    contract = getattr(fill, 'contract', None)
    execution = getattr(fill, 'execution', None)
    if contract is None or execution is None:
        return None, 'invalid_fill'

    sec_type = _upper(getattr(contract, 'secType', ''))
    if sec_type == 'BAG':
        return None, 'bag_summary'
    if sec_type not in SUPPORTED_SEC_TYPES:
        return None, 'unsupported_sec_type'

    exec_id = _text(getattr(execution, 'execId', ''))
    account = _upper(getattr(execution, 'acctNumber', ''))
    symbol = _upper(getattr(contract, 'symbol', ''))
    side = _upper(getattr(execution, 'side', ''))
    quantity = _finite(getattr(execution, 'shares', None))
    price = _finite(getattr(execution, 'price', None))
    if not exec_id or not account or not symbol or side not in ('BOT', 'BUY', 'SLD', 'SELL'):
        return None, 'missing_identity'
    if quantity is None or quantity <= 0 or price is None or price < 0:
        return None, 'invalid_economics'

    report = (
        getattr(fill, 'commissionReport', None)
        if commission_report_override is _NO_COMMISSION_OVERRIDE
        else commission_report_override
    )
    commission = _finite(getattr(report, 'commission', None)) if report is not None else None
    commission_currency = _upper(
        getattr(report, 'currency', '')) if report is not None else ''
    commission_available = commission is not None and bool(commission_currency)

    multiplier = _finite(getattr(contract, 'multiplier', None))
    if multiplier is None or multiplier <= 0:
        multiplier = 1.0 if sec_type == 'STK' else None

    execution_time = getattr(execution, 'time', None)
    timestamp = _wall_clock(
        execution_time or getattr(fill, 'time', None), target_timezone)
    if not timestamp and not isinstance(execution_time, datetime):
        timestamp = _wall_clock(getattr(fill, 'time', None), target_timezone)

    return {
        'execId': exec_id,
        'account': account,
        'symbol': symbol,
        'secType': sec_type,
        'conId': getattr(contract, 'conId', None),
        'localSymbol': _text(getattr(contract, 'localSymbol', '')),
        'expiry': _contract_date(
            getattr(contract, 'lastTradeDateOrContractMonth', '')),
        'right': _upper(getattr(contract, 'right', ''))[:1],
        'strike': _finite(getattr(contract, 'strike', None)),
        'multiplier': multiplier,
        'side': side,
        'quantity': quantity,
        'price': price,
        'brokerTimestamp': timestamp,
        # Keep the sign: IB occasionally reports an exchange rebate as a
        # negative commission. The browser turns that into a separate
        # positive-cash fee event because ledger ``fees`` are non-negative.
        'commission': commission,
        'commissionCurrency': commission_currency,
        'commissionAvailable': commission_available,
        'realizedPnl': _finite(getattr(report, 'realizedPNL', None))
        if report is not None else None,
        'permId': getattr(execution, 'permId', None),
        'orderId': getattr(execution, 'orderId', None),
        'orderRef': _text(getattr(execution, 'orderRef', '')),
    }, ''


def serialize_fills(
        fills, *, account='', symbol='', target_timezone=None,
        commission_reports_by_exec_id=None):
    """Serialize, filter and execId-de-duplicate a broker response."""
    wanted_account = _upper(account)
    wanted_symbol = _upper(symbol)
    commission_reports = commission_reports_by_exec_id or {}
    rows = []
    seen = set()
    ignored = {}
    for fill in fills or []:
        execution = getattr(fill, 'execution', None)
        exec_id = _text(getattr(execution, 'execId', ''))
        report_override = (
            commission_reports[exec_id]
            if exec_id in commission_reports
            else _NO_COMMISSION_OVERRIDE
        )
        row, reason = serialize_fill(
            fill,
            target_timezone=target_timezone,
            commission_report_override=report_override,
        )
        if row is None:
            ignored[reason] = ignored.get(reason, 0) + 1
            continue
        if wanted_account and row['account'] != wanted_account:
            ignored['other_account'] = ignored.get('other_account', 0) + 1
            continue
        if wanted_symbol and row['symbol'] != wanted_symbol:
            ignored['other_symbol'] = ignored.get('other_symbol', 0) + 1
            continue
        if row['execId'] in seen:
            ignored['duplicate_exec_id'] = ignored.get('duplicate_exec_id', 0) + 1
            continue
        seen.add(row['execId'])
        rows.append(row)
    rows.sort(key=lambda row: (row['brokerTimestamp'], row['execId']))
    return {'executions': rows, 'ignored': ignored}
