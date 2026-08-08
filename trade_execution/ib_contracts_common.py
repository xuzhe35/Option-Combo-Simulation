"""Contract-building helpers shared by the market-data and order-placement paths.

``ib_server`` drives these from plain websocket dicts and module-level tables;
the IBKR execution adapter drives them from ``ComboLegRequest`` dataclasses and
injected instance attributes.  Both shapes normalize to :class:`ContractSpec`
here, so the two callers cannot drift apart the way their hand-copied versions
did -- the order path once re-injected a family default trading class even when
the browser correctly sent none, which sent ML3 on a CL order that IB would
otherwise have qualified.

Everything in this module takes its inputs explicitly -- the families table is a
parameter, never a global -- so neither caller's wiring leaks into the other.
"""
from dataclasses import dataclass
from typing import Any, Optional

from ib_async import Contract, Stock


def normalize_symbol(value):
    return str(value or '').strip().upper()


def to_contract_month(value):
    cleaned = str(value or '').replace('-', '')
    return cleaned[:6]


def to_expiry(value):
    return str(value or '').replace('-', '')


def resolve_family_defaults(supported_live_families, symbol):
    return supported_live_families.get(normalize_symbol(symbol))


def resolve_index_exchange_candidates(index_exchange_fallbacks, symbol, requested_exchange):
    normalized_symbol = normalize_symbol(symbol)
    requested = str(requested_exchange or '').strip()
    candidates = []

    if requested:
        candidates.append(requested)

    for exchange in index_exchange_fallbacks.get(normalized_symbol, ()):
        if exchange not in candidates:
            candidates.append(exchange)

    if '' not in candidates:
        candidates.append('')

    return candidates


def resolve_weekly_fop_trading_class(supported_live_families, symbol, current_trading_class):
    """Drop the family trading-class seed for futures options.

    Every FOP family default (E3A/Q3A/ML3/G3T/S3T/H3T) names one specific
    weekday-and-week listing, so asserting it makes a perfectly valid contract
    fail on every other expiry.  Send nothing and let IB name the class from the
    exact expiry/right/strike.  Index options keep theirs -- SPX/SPXW and NDXP
    are real, stable classes.

    The market-data and order paths must agree here: fixing only one copy still
    leaves the other re-injecting the seed.  That is why this lives in the shared
    module rather than being duplicated at each call site.
    """
    defaults = resolve_family_defaults(supported_live_families, symbol)
    if not defaults:
        return current_trading_class

    base_trading_class = current_trading_class or defaults.get('trading_class') or ''
    if not base_trading_class or len(base_trading_class) < 2:
        return base_trading_class
    if normalize_symbol(defaults.get('option_sec_type')) == 'FOP':
        return ''
    return base_trading_class


@dataclass(frozen=True)
class ContractSpec:
    """A contract request reduced to the fields both callers actually supply."""

    sec_type: str
    symbol: str
    exchange: str
    currency: str
    multiplier: str
    trading_class: str
    strike: Optional[Any]
    right: str
    expiry: str
    contract_month: str


def spec_from_mapping(contract_data):
    """Normalize ib_server's websocket dict, including its snake_case aliases."""
    return ContractSpec(
        sec_type=normalize_symbol(contract_data.get('secType') or contract_data.get('sec_type')),
        symbol=normalize_symbol(contract_data.get('symbol')),
        exchange=contract_data.get('exchange') or '',
        currency=contract_data.get('currency') or 'USD',
        multiplier=str(contract_data.get('multiplier') or ''),
        trading_class=contract_data.get('tradingClass') or contract_data.get('trading_class') or '',
        strike=contract_data.get('strike'),
        right=normalize_symbol(contract_data.get('right')),
        expiry=to_expiry(contract_data.get('expDate') or contract_data.get('expiry')),
        contract_month=to_contract_month(contract_data.get('contractMonth')),
    )


def spec_from_leg_request(leg_request):
    """Normalize the execution adapter's ``ComboLegRequest`` dataclass."""
    return ContractSpec(
        sec_type=normalize_symbol(leg_request.sec_type),
        symbol=normalize_symbol(leg_request.symbol),
        exchange=leg_request.exchange or '',
        currency=leg_request.currency or 'USD',
        multiplier=str(leg_request.multiplier or ''),
        trading_class=leg_request.trading_class or '',
        strike=leg_request.strike,
        right=normalize_symbol(leg_request.right),
        expiry=to_expiry(leg_request.exp_date),
        contract_month=to_contract_month(leg_request.contract_month),
    )


def build_contract_from_spec(supported_live_families, spec):
    """Build the ib_async contract described by ``spec``.

    The trading class is resolved for every secType, not just the option
    branches, to match the order the hand-copied versions used.
    """
    trading_class = resolve_weekly_fop_trading_class(
        supported_live_families, spec.symbol, spec.trading_class
    )

    if spec.sec_type == 'STK':
        return Stock(spec.symbol, spec.exchange or 'SMART', spec.currency)

    if spec.sec_type == 'IND':
        return Contract(
            secType='IND',
            symbol=spec.symbol,
            exchange=spec.exchange,
            currency=spec.currency,
        )

    if spec.sec_type == 'FUT':
        return Contract(
            secType='FUT',
            symbol=spec.symbol,
            lastTradeDateOrContractMonth=spec.contract_month,
            exchange=spec.exchange,
            currency=spec.currency,
            multiplier=spec.multiplier,
        )

    if spec.sec_type in ('OPT', 'FOP'):
        return Contract(
            secType=spec.sec_type,
            symbol=spec.symbol,
            lastTradeDateOrContractMonth=spec.expiry or spec.contract_month,
            strike=float(spec.strike),
            right=spec.right,
            exchange=spec.exchange,
            currency=spec.currency,
            multiplier=spec.multiplier,
            tradingClass=trading_class,
        )

    raise ValueError(f"Unsupported secType in request: {spec.sec_type!r}")
