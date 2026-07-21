import asyncio

from ib_async import Contract, Stock


def _to_contract_month(self, value):
    cleaned = str(value or '').replace('-', '')
    return cleaned[:6]


def _to_expiry(self, value):
    return str(value or '').replace('-', '')


def _resolve_family_defaults(self, symbol):
    return self.supported_live_families.get(self._normalize_symbol(symbol))


def _resolve_index_exchange_candidates(self, symbol, requested_exchange):
    normalized_symbol = self._normalize_symbol(symbol)
    requested = str(requested_exchange or '').strip()
    candidates = []

    if requested:
        candidates.append(requested)

    for exchange in self.index_exchange_fallbacks.get(normalized_symbol, ()):
        if exchange not in candidates:
            candidates.append(exchange)

    if '' not in candidates:
        candidates.append('')

    return candidates


def _resolve_weekly_fop_trading_class(self, symbol, expiry, current_trading_class):
    defaults = self._resolve_family_defaults(symbol)
    if not defaults:
        return current_trading_class

    base_trading_class = current_trading_class or defaults.get('trading_class') or ''
    if not base_trading_class or len(base_trading_class) < 2:
        return base_trading_class
    if self._normalize_symbol(defaults.get('option_sec_type')) == 'FOP':
        # Let IB resolve the listing-specific daily/weekly class.  Every family
        # default here (E3A/Q3A/ML3/S3T) names one weekday-and-week listing, so
        # asserting it makes a valid contract fail on every other expiry.  This
        # must stay in step with ib_server._resolve_weekly_fop_trading_class:
        # the order path re-injects the family default even when the browser
        # correctly sends none, so fixing only the market-data copy would still
        # send ML3 on a CL order.
        return ''
    return base_trading_class


async def _qualify_underlying_future(self, symbol, contract_month, exchange, currency, multiplier):
    cache_key = (
        self._normalize_symbol(symbol),
        self._to_contract_month(contract_month),
        exchange or '',
        currency or 'USD',
        str(multiplier or ''),
    )
    if cache_key in self.qualified_underlyings:
        return self.qualified_underlyings[cache_key]

    future_contract = Contract(
        secType='FUT',
        symbol=cache_key[0],
        lastTradeDateOrContractMonth=cache_key[1],
        exchange=cache_key[2],
        currency=cache_key[3],
        multiplier=cache_key[4],
    )
    results = await self.ib.qualifyContractsAsync(future_contract)
    if not results or results[0] is None:
        return None

    self.qualified_underlyings[cache_key] = results[0]
    return results[0]


def _build_contract_from_request(self, leg_request):
    sec_type = self._normalize_symbol(leg_request.sec_type)
    symbol = self._normalize_symbol(leg_request.symbol)
    exchange = leg_request.exchange or ''
    currency = leg_request.currency or 'USD'
    multiplier = str(leg_request.multiplier or '')
    trading_class = leg_request.trading_class or ''
    strike = leg_request.strike
    right = self._normalize_symbol(leg_request.right)
    expiry = self._to_expiry(leg_request.exp_date)
    contract_month = self._to_contract_month(leg_request.contract_month)
    trading_class = self._resolve_weekly_fop_trading_class(symbol, expiry, trading_class)

    if sec_type == 'STK':
        return Stock(symbol, exchange or 'SMART', currency)

    if sec_type == 'IND':
        return Contract(secType='IND', symbol=symbol, exchange=exchange, currency=currency)

    if sec_type == 'FUT':
        return Contract(
            secType='FUT',
            symbol=symbol,
            lastTradeDateOrContractMonth=contract_month,
            exchange=exchange,
            currency=currency,
            multiplier=multiplier,
        )

    if sec_type in ('OPT', 'FOP'):
        return Contract(
            secType=sec_type,
            symbol=symbol,
            lastTradeDateOrContractMonth=expiry or contract_month,
            strike=float(strike),
            right=right,
            exchange=exchange,
            currency=currency,
            multiplier=multiplier,
            tradingClass=trading_class,
        )

    raise ValueError(f"Unsupported secType in request: {sec_type!r}")


def _describe_contract_request(self, leg_request):
    return f"{self._normalize_symbol(leg_request.sec_type) or 'UNKNOWN'} {self._normalize_symbol(leg_request.symbol) or '<missing>'}".strip()


async def _fallback_qualify_derivative_contract(self, contract, leg_request, qualified_underlying=None):
    """Resolve an OPT/FOP contract when IB returns multiple matches.

    ``qualifyContractsAsync`` returns no contract for an ambiguous derivative
    request.  This notably happens for SPY strikes where both the regular SPY
    class and a 2SPY class share the same expiry, strike, and right.  Querying
    contract details lets us apply the remaining discriminator locally.
    """
    sec_type = self._normalize_symbol(leg_request.sec_type)
    if sec_type not in ('OPT', 'FOP') or not hasattr(self.ib, 'reqContractDetailsAsync'):
        return None

    requested_expiry = self._to_expiry(leg_request.exp_date or leg_request.contract_month)
    requested_right = self._normalize_symbol(leg_request.right)
    requested_symbol = self._normalize_symbol(leg_request.symbol)
    requested_trading_class = self._normalize_symbol(leg_request.trading_class)
    requested_multiplier = str(leg_request.multiplier or '')
    requested_exchange = str(leg_request.exchange or '').strip().upper()
    requested_under_con_id = getattr(qualified_underlying, 'conId', None)

    probe = Contract(
        secType=sec_type,
        symbol=requested_symbol,
        lastTradeDateOrContractMonth=requested_expiry,
        strike=float(leg_request.strike),
        right=requested_right,
        exchange=leg_request.exchange or getattr(contract, 'exchange', '') or '',
        currency=leg_request.currency or getattr(contract, 'currency', '') or 'USD',
        multiplier=requested_multiplier or str(getattr(contract, 'multiplier', '') or ''),
    )
    if requested_under_con_id:
        probe.underConId = requested_under_con_id

    try:
        contract_details = await self.ib.reqContractDetailsAsync(probe)
    except Exception as exc:
        self.logger.warning(
            f"Contract-details fallback failed for {self._describe_contract_request(leg_request)}: {exc}"
        )
        return None

    candidates = []
    for index, detail in enumerate(contract_details or []):
        candidate = getattr(detail, 'contract', None)
        if candidate is None:
            continue
        if self._normalize_symbol(getattr(candidate, 'secType', '')) not in ('', sec_type):
            continue

        candidate_expiry = str(getattr(candidate, 'lastTradeDateOrContractMonth', '') or '').replace('-', '')[:8]
        if requested_expiry and candidate_expiry != requested_expiry:
            continue
        if requested_right and self._normalize_symbol(getattr(candidate, 'right', '')) != requested_right:
            continue
        try:
            if abs(float(getattr(candidate, 'strike', 0)) - float(leg_request.strike)) > 0.000001:
                continue
        except (TypeError, ValueError):
            continue

        # IB exposes the authoritative underlying futures conId on
        # ContractDetails, not on its nested Contract. Reading the nested
        # object silently made the FOP month discriminator ineffective.
        candidate_under_con_id = getattr(detail, 'underConId', None)
        if requested_under_con_id and candidate_under_con_id and candidate_under_con_id != requested_under_con_id:
            continue
        if requested_multiplier and str(getattr(candidate, 'multiplier', '') or '') != requested_multiplier:
            continue

        candidate_trading_class = self._normalize_symbol(getattr(candidate, 'tradingClass', ''))
        candidate_exchange = str(getattr(candidate, 'exchange', '') or '').strip().upper()
        score = 0
        if requested_trading_class and candidate_trading_class == requested_trading_class:
            score += 1000
        # Equity/ETF option requests normally use their root symbol as the
        # canonical trading class (SPY rather than 2SPY, for example).
        if not requested_trading_class and candidate_trading_class == requested_symbol:
            score += 100
        if requested_under_con_id and candidate_under_con_id == requested_under_con_id:
            score += 10
        if requested_exchange and candidate_exchange == requested_exchange:
            score += 5
        if candidate_trading_class:
            score += 1
        candidates.append((score, index, candidate))

    if not candidates:
        return None

    candidates.sort(key=lambda item: (-item[0], item[1]))
    selected = candidates[0][2]
    self.logger.info(
        f"Qualified {self._describe_contract_request(leg_request)} using contract-details fallback "
        f"symbol={getattr(selected, 'symbol', '')} "
        f"tradingClass={getattr(selected, 'tradingClass', '') or '<blank>'} "
        f"expiry={str(getattr(selected, 'lastTradeDateOrContractMonth', '') or '')[:8]}"
    )
    return selected


async def _qualify_one(self, contract, leg_request):
    sec_type = self._normalize_symbol(leg_request.sec_type)
    underlying_contract_month = ''
    qualified_underlying = None

    if sec_type == 'FOP':
        underlying_contract_month = self._to_contract_month(leg_request.underlying_contract_month)
        if underlying_contract_month:
            defaults = self._resolve_family_defaults(leg_request.symbol)
            underlying_symbol = self._normalize_symbol(
                leg_request.underlying_symbol
                or (defaults or {}).get('underlying_symbol')
                or leg_request.symbol
            )
            underlying_exchange = (
                leg_request.underlying_exchange
                or (defaults or {}).get('exchange')
                or leg_request.exchange
                or ''
            )
            underlying_currency = leg_request.currency or (defaults or {}).get('currency') or 'USD'
            underlying_multiplier = str(
                leg_request.underlying_multiplier
                or (defaults or {}).get('multiplier')
                or leg_request.multiplier
                or ''
            )
            qualified_underlying = await self._qualify_underlying_future(
                underlying_symbol,
                underlying_contract_month,
                underlying_exchange,
                underlying_currency,
                underlying_multiplier,
            )
            if qualified_underlying is None:
                self.logger.error(
                    f"Failed to qualify underlying FUT {underlying_symbol} {underlying_contract_month} "
                    f"for option {self._describe_contract_request(leg_request)}"
                )
                return None
            contract.underConId = qualified_underlying.conId

    results = await self.ib.qualifyContractsAsync(contract)
    if (not results or results[0] is None) and sec_type == 'IND':
        original_exchange = contract.exchange
        for candidate_exchange in self._resolve_index_exchange_candidates(contract.symbol, original_exchange):
            if candidate_exchange == original_exchange:
                continue

            contract.exchange = candidate_exchange
            results = await self.ib.qualifyContractsAsync(contract)
            if results and results[0] is not None:
                self.logger.info(
                    f"Qualified {self._describe_contract_request(leg_request)} using IND exchange fallback "
                    f"{candidate_exchange or '<blank>'} instead of {original_exchange or '<blank>'}"
                )
                break

    if (not results or results[0] is None) and sec_type == 'FOP' and underlying_contract_month and getattr(contract, 'tradingClass', ''):
        original_trading_class = contract.tradingClass
        contract.tradingClass = ''
        results = await self.ib.qualifyContractsAsync(contract)
        if results and results[0] is not None:
            self.logger.info(
                f"Qualified {self._describe_contract_request(leg_request)} using underConId fallback "
                f"without tradingClass {original_trading_class}"
            )

    if not results or results[0] is None:
        fallback_contract = await self._fallback_qualify_derivative_contract(
            contract,
            leg_request,
            qualified_underlying=qualified_underlying,
        )
        if fallback_contract is not None:
            return fallback_contract

    if not results or results[0] is None:
        return None

    return results[0]


async def _request_temporary_ticker(self, contract, generic_ticks=''):
    ticker = self.ib.reqMktData(contract, generic_ticks, False, False)
    await asyncio.sleep(0.75)
    return ticker


def _resolve_existing_order_ticker(self, websocket, leg_request):
    subs = self.client_subscriptions.get(websocket, {})
    if leg_request.id and leg_request.id in subs:
        return subs[leg_request.id]

    if self._normalize_symbol(leg_request.sec_type) in ('STK', 'FUT', 'IND'):
        return subs.get('underlying')

    return None


async def _resolve_leg_contract_and_mark(self, websocket, leg_request):
    contract = self._build_contract_from_request(leg_request)
    self.logger.info(
        f"Resolving combo leg market data: id={leg_request.id} "
        f"{self._describe_contract_request(leg_request)}"
    )
    qualified_contract = await self._qualify_one(contract, leg_request)
    if qualified_contract is None:
        raise ValueError(f"Failed to qualify {self._describe_contract_request(leg_request)}")

    ticker = self._resolve_existing_order_ticker(websocket, leg_request)
    created_temp_ticker = False
    if ticker is None:
        ticker = await self._request_temporary_ticker(
            qualified_contract,
            '106' if self._normalize_symbol(leg_request.sec_type) in ('OPT', 'FOP') else ''
        )
        created_temp_ticker = True

    try:
        sec_type = self._normalize_symbol(leg_request.sec_type)
        quote = self._extract_quote_snapshot(ticker, sec_type)
        if quote is None:
            raise ValueError(f"No live mark available for {self._describe_contract_request(leg_request)}")
        self.logger.info(
            f"Resolved combo leg: id={leg_request.id} conId={qualified_contract.conId} "
            f"localSymbol={getattr(qualified_contract, 'localSymbol', '')} "
            f"bid={quote['bid']} ask={quote['ask']} mark={quote['mark']}"
        )
        return qualified_contract, quote
    finally:
        if created_temp_ticker:
            try:
                self.ib.cancelMktData(qualified_contract)
            except Exception:
                pass


async def _validate_leg_contract(self, leg_request):
    contract = self._build_contract_from_request(leg_request)
    self.logger.info(
        f"Validating combo leg: id={leg_request.id} "
        f"{self._describe_contract_request(leg_request)}"
    )
    qualified_contract = await self._qualify_one(contract, leg_request)
    if qualified_contract is None:
        raise ValueError(f"Failed to qualify {self._describe_contract_request(leg_request)}")
    self.logger.info(
        f"Validated combo leg: id={leg_request.id} conId={qualified_contract.conId} "
        f"localSymbol={getattr(qualified_contract, 'localSymbol', '')}"
    )
    return qualified_contract
