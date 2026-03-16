import asyncio
import json
import logging
import random
import signal
import configparser
from datetime import datetime
from ib_async import *
import websockets

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Load Config
config = configparser.ConfigParser()
config.read('config.ini')

TWS_HOST = config.get('tws', 'host', fallback='127.0.0.1')
TWS_PORT = config.getint('tws', 'port', fallback=7496)
TWS_CLIENT_ID = config.getint('tws', 'client_id', fallback=999)

WS_HOST = config.get('server', 'ws_host', fallback='127.0.0.1')
WS_PORT = config.getint('server', 'ws_port', fallback=8765)

ib = IB()
connected_clients = set()
# Map websocket -> { leg_id: Ticker }
client_subscriptions = {}
qualified_underlyings = {}

SUPPORTED_LIVE_FAMILIES = {
    'ES': {
        'underlying_sec_type': 'FUT',
        'option_sec_type': 'FOP',
        'underlying_symbol': 'ES',
        'option_symbol': 'ES',
        'exchange': 'CME',
        'currency': 'USD',
        'multiplier': '50',
        'trading_class': 'E3A',
    },
    'NQ': {
        'underlying_sec_type': 'FUT',
        'option_sec_type': 'FOP',
        'underlying_symbol': 'NQ',
        'option_symbol': 'NQ',
        'exchange': 'CME',
        'currency': 'USD',
        'multiplier': '20',
        'trading_class': 'Q3A',
    },
}

async def connect_ib():
    """Connect to IB TWS/Gateway. Retries indefinitely — one connection per session.

    If Error 326 (client ID already in use) is received during the handshake,
    automatically picks a new random client ID and retries immediately.
    """
    client_id = TWS_CLIENT_ID

    while not ib.isConnected():
        # Temporary listener to capture any error codes emitted during the handshake.
        error_codes: list[int] = []
        def _capture_error(reqId, errorCode, errorString, contract):
            error_codes.append(errorCode)

        ib.errorEvent += _capture_error
        try:
            logging.info(f"Connecting to IB TWS/Gateway at {TWS_HOST}:{TWS_PORT} (Client ID: {client_id})...")
            await ib.connectAsync(TWS_HOST, TWS_PORT, clientId=client_id)
            logging.info(f"Successfully connected to IB (Client ID: {client_id}).")
            # Enforce Real-Time Data (1)
            ib.reqMarketDataType(1)
        except Exception as e:
            if 326 in error_codes:
                # Error 326: "Client ID already in use" — pick a random ID and retry immediately
                client_id = random.randint(1, 998)
                logging.warning(f"Client ID already in use (Error 326). Retrying with Client ID: {client_id}...")
                await asyncio.sleep(1)
            else:
                logging.error(f"Connection failed: {e}. Retrying in 5 seconds...")
                await asyncio.sleep(5)
        finally:
            # Always remove the temporary listener so it doesn't fire during normal operation
            ib.errorEvent -= _capture_error

def _extract_market_price(ticker):
    """Extract the best available price from a market-data ticker.
    Fallback chain: marketPrice() → last → close.
    Returns the price (float) or None if no valid price is available.
    """
    price = ticker.marketPrice()
    if not (price == price and price > 0):  # NaN check
        if ticker.last == ticker.last and ticker.last > 0:
            price = ticker.last
        elif ticker.close == ticker.close and ticker.close > 0:
            price = ticker.close
        else:
            return None
    return price

def _normalize_symbol(value):
    return str(value or '').strip().upper()

def _to_contract_month(value):
    cleaned = str(value or '').replace('-', '')
    return cleaned[:6]

def _to_expiry(value):
    return str(value or '').replace('-', '')

def _resolve_family_defaults(symbol):
    normalized = _normalize_symbol(symbol)
    return SUPPORTED_LIVE_FAMILIES.get(normalized)

def _resolve_weekly_fop_trading_class(symbol, expiry, current_trading_class):
    defaults = _resolve_family_defaults(symbol)
    if not defaults:
        return current_trading_class

    base_trading_class = current_trading_class or defaults.get('trading_class') or ''
    if not base_trading_class or len(base_trading_class) < 2:
        return base_trading_class

    try:
        expiry_date = datetime.strptime(expiry, '%Y%m%d')
    except (TypeError, ValueError):
        return base_trading_class

    weekday_suffix = {
        0: 'A',  # Monday
        1: 'B',  # Tuesday
        2: 'C',  # Wednesday
        3: 'D',  # Thursday
    }.get(expiry_date.weekday())

    if weekday_suffix:
        return f"{base_trading_class[:-1]}{weekday_suffix}"
    return base_trading_class

async def _qualify_underlying_future(symbol, contract_month, exchange, currency, multiplier):
    cache_key = (
        _normalize_symbol(symbol),
        _to_contract_month(contract_month),
        exchange or '',
        currency or 'USD',
        str(multiplier or ''),
    )
    if cache_key in qualified_underlyings:
        return qualified_underlyings[cache_key]

    future_contract = Contract(
        secType='FUT',
        symbol=cache_key[0],
        lastTradeDateOrContractMonth=cache_key[1],
        exchange=cache_key[2],
        currency=cache_key[3],
        multiplier=cache_key[4],
    )
    results = await ib.qualifyContractsAsync(future_contract)
    if not results or results[0] is None:
        return None

    qualified_underlyings[cache_key] = results[0]
    return results[0]

def _build_contract_from_request(contract_data):
    if not isinstance(contract_data, dict):
        symbol = _normalize_symbol(contract_data)
        return Stock(symbol, 'SMART', 'USD')

    sec_type = _normalize_symbol(contract_data.get('secType') or contract_data.get('sec_type'))
    symbol = _normalize_symbol(contract_data.get('symbol'))
    exchange = contract_data.get('exchange') or ''
    currency = contract_data.get('currency') or 'USD'
    multiplier = str(contract_data.get('multiplier') or '')
    trading_class = contract_data.get('tradingClass') or contract_data.get('trading_class') or ''
    strike = contract_data.get('strike')
    right = _normalize_symbol(contract_data.get('right'))
    expiry = _to_expiry(contract_data.get('expDate') or contract_data.get('expiry'))
    contract_month = _to_contract_month(contract_data.get('contractMonth'))
    trading_class = _resolve_weekly_fop_trading_class(symbol, expiry, trading_class)

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

async def _qualify_one(contract, contract_request=None):
    sec_type = ''
    underlying_contract_month = ''
    if isinstance(contract_request, dict):
        sec_type = _normalize_symbol(contract_request.get('secType') or contract_request.get('sec_type'))
        if sec_type == 'FOP':
            underlying_contract_month = _to_contract_month(contract_request.get('underlyingContractMonth'))
            if underlying_contract_month:
                defaults = _resolve_family_defaults(contract_request.get('symbol'))
                underlying_symbol = _normalize_symbol(
                    contract_request.get('underlyingSymbol')
                    or (defaults or {}).get('underlying_symbol')
                    or contract_request.get('symbol')
                )
                underlying_exchange = (
                    contract_request.get('underlyingExchange')
                    or (defaults or {}).get('exchange')
                    or contract_request.get('exchange')
                    or ''
                )
                underlying_currency = (
                    contract_request.get('underlyingCurrency')
                    or contract_request.get('currency')
                    or (defaults or {}).get('currency')
                    or 'USD'
                )
                underlying_multiplier = str(
                    contract_request.get('underlyingMultiplier')
                    or (defaults or {}).get('multiplier')
                    or contract_request.get('multiplier')
                    or ''
                )
                qualified_underlying = await _qualify_underlying_future(
                    underlying_symbol,
                    underlying_contract_month,
                    underlying_exchange,
                    underlying_currency,
                    underlying_multiplier,
                )
                if qualified_underlying is None:
                    logging.error(
                        f"Failed to qualify underlying FUT {underlying_symbol} {underlying_contract_month} "
                        f"for option {_describe_contract_request(contract_request)}"
                    )
                    return None
                contract.underConId = qualified_underlying.conId

    results = await ib.qualifyContractsAsync(contract)
    if (not results or results[0] is None) and sec_type == 'FOP' and underlying_contract_month and getattr(contract, 'tradingClass', ''):
        original_trading_class = contract.tradingClass
        contract.tradingClass = ''
        results = await ib.qualifyContractsAsync(contract)
        if results and results[0] is not None:
            logging.info(
                f"Qualified {_describe_contract_request(contract_request)} using underConId fallback "
                f"without tradingClass {original_trading_class}"
            )
    if not results or results[0] is None:
        return None
    return results[0]

def _build_underlying_request(raw_underlying, options_data):
    if isinstance(raw_underlying, dict):
        return raw_underlying

    symbol = _normalize_symbol(raw_underlying)
    defaults = _resolve_family_defaults(symbol)
    if not defaults:
        return raw_underlying

    option_contract_month = ''
    if options_data:
        option_contract_month = _to_contract_month(options_data[0].get('contractMonth') or options_data[0].get('expDate'))

    return {
        'secType': defaults['underlying_sec_type'],
        'symbol': defaults['underlying_symbol'],
        'exchange': defaults['exchange'],
        'currency': defaults['currency'],
        'multiplier': defaults['multiplier'],
        'contractMonth': option_contract_month,
    }

def _describe_contract_request(contract_data):
    if isinstance(contract_data, dict):
        sec_type = _normalize_symbol(contract_data.get('secType') or contract_data.get('sec_type'))
        symbol = _normalize_symbol(contract_data.get('symbol'))
        return f"{sec_type or 'UNKNOWN'} {symbol or '<missing>'}".strip()
    return _normalize_symbol(contract_data) or '<missing>'

def on_pending_tickers(tickers):
    """
    Callback fired by ib_async when streaming data ticks arrive.
    We batch process these and send customized state to each connected WS client.
    """
    if not connected_clients:
        return
        
    for ws in list(connected_clients):
        # Build a custom payload for this specific client based on their subscriptions
        subs = client_subscriptions.get(ws, {})
        if not subs:
            continue
            
        payload = {
            "underlyingPrice": None,
            "options": {},
            "stocks": {}
        }
        
        has_data = False
        
        if 'underlying' in subs:
            ticker = subs['underlying']
            price = _extract_market_price(ticker)
            if price is not None:
                payload["underlyingPrice"] = price
                has_data = True

        for sub_id, ticker in subs.items():
            if sub_id == 'underlying':
                continue  # already handled above

            elif sub_id.startswith('stock_'):
                # --- Stock / ETF hedge ---
                stock_sym = sub_id.replace('stock_', '')
                price = _extract_market_price(ticker)
                if price is not None:
                    payload["stocks"][stock_sym] = {
                        "mark": price
                    }
                    has_data = True

            else:
                # --- Option leg ---
                # Use bid/ask midpoint ("mark") instead of marketPrice() which returns
                # last trade price — that can be stale for illiquid options.
                # TWS's "mark" column = (bid + ask) / 2, so we match that here.
                bid = ticker.bid
                ask = ticker.ask
                if bid and ask and bid == bid and ask == ask and bid > 0 and ask > 0:
                    price = round((bid + ask) / 2, 4)
                else:
                    # Fallback chain for illiquid / deep OTM options:
                    # 1. Try IB's model-computed theoretical price (from Generic Tick 106)
                    # 2. Fall back to marketPrice() (last trade — may be stale)
                    price = None
                    if hasattr(ticker, 'modelGreeks') and ticker.modelGreeks:
                        opt_price = getattr(ticker.modelGreeks, 'optPrice', None)
                        if opt_price is not None and opt_price == opt_price and opt_price > 0:
                            price = round(opt_price, 4)
                    if price is None:
                        price = ticker.marketPrice()
                
                # Extract IV: prefer modelGreeks.impliedVol (from Generic Tick 106),
                # fall back to ticker.impliedVolatility if available.
                # Both can be NaN, so filter explicitly.
                iv = None
                if hasattr(ticker, 'modelGreeks') and ticker.modelGreeks:
                    raw = getattr(ticker.modelGreeks, 'impliedVol', None)
                    if raw is not None and raw == raw and raw > 0:  # filter NaN
                        iv = raw
                if iv is None:
                    raw = getattr(ticker, 'impliedVolatility', None)
                    if raw is not None and raw == raw and raw > 0:
                        iv = raw
                
                if price == price and price > 0:
                    payload["options"][sub_id] = {
                        "mark": price
                    }
                    
                    if iv and iv == iv and iv > 0: # Check for NaN
                        payload["options"][sub_id]["iv"] = iv
                    has_data = True
                    
        # Send data only to the client that requested it
        if has_data:
            message = json.dumps(payload)
            # asyncio.create_task ensures we don't block the tick event thread
            asyncio.create_task(send_message_safe(ws, message))

async def send_message_safe(ws, message):
    try:
        await ws.send(message)
    except Exception as e:
        # Ignore normal disconnect errors; the finally block in handle_ws_client will clean up
        pass

def unsubscribe_client_safely(ws):
    """
    Removes a client's subscriptions. If no other client is watching a specific 
    Ticker contract anymore, we tell IB to cancel the market data stream.
    """
    subs = client_subscriptions.get(ws, {})
    if not subs:
        return
        
    # Count how many total clients are watching each contract ID
    active_contracts = {}
    for other_ws, other_subs in client_subscriptions.items():
        if other_ws != ws:
            for t in other_subs.values():
                active_contracts[t.contract.conId] = True
                
    # Cancel the data stream if this client was the last one watching it
    for ticker in subs.values():
        if ticker.contract.conId not in active_contracts:
            ib.cancelMktData(ticker.contract)
            
    client_subscriptions[ws] = {}

async def handle_ws_client(websocket):
    client_ip = websocket.remote_address[0] if websocket.remote_address else 'Unknown'
    logging.info(f"Client connected: {client_ip}")
    connected_clients.add(websocket)
    client_subscriptions[websocket] = {}
    
    try:
        async for message in websocket:
            data = json.loads(message)
            
            if data.get('action') == 'subscribe':
                raw_underlying = data.get('underlying')
                options_data = data.get('options', [])
                stocks_data = data.get('stocks', [])
                underlying_request = _build_underlying_request(raw_underlying, options_data)

                logging.info(
                    f"Received subscription request from {client_ip} "
                    f"for underlying {_describe_contract_request(underlying_request)}, "
                    f"{len(options_data)} options, and {len(stocks_data)} stocks"
                )

                try:
                    underlying_contract = _build_contract_from_request(underlying_request)
                except Exception as e:
                    logging.error(f"Invalid underlying request from {client_ip}: {underlying_request!r} ({e})")
                    continue

                # Unsubscribe old streams for this specific client safely
                unsubscribe_client_safely(websocket)

                qualified_underlying = await _qualify_one(underlying_contract, underlying_request)
                if qualified_underlying is None:
                    logging.warning(
                        f"Failed to qualify underlying {_describe_contract_request(underlying_request)}; "
                        f"continuing with option subscriptions only"
                    )
                else:
                    # Subscribe underlying price stream.
                    ticker = ib.reqMktData(qualified_underlying, '', False, False)
                    client_subscriptions[websocket]['underlying'] = ticker

                # Process options / FOP legs.
                for opt in options_data:
                    leg_id = opt['id']
                    try:
                        opt_contract = _build_contract_from_request(opt)
                    except Exception as e:
                        logging.error(f"Invalid option request for leg {leg_id}: {opt!r} ({e})")
                        continue

                    qualified_option = await _qualify_one(opt_contract, opt)
                    if qualified_option is None:
                        logging.error(f"Failed to qualify option leg {leg_id}: {_describe_contract_request(opt)}")
                        continue

                    # Generic tick 106 requests option IV/model data; IB also serves it for FOP.
                    opt_ticker = ib.reqMktData(qualified_option, '106', False, False)
                    client_subscriptions[websocket][leg_id] = opt_ticker

                # Process stock hedges.
                for stock_sym in stocks_data:
                    stock_contract = Stock(stock_sym, 'SMART', 'USD')
                    qualified_stock = await _qualify_one(stock_contract)
                    if qualified_stock is None:
                        logging.error(f"Failed to qualify hedge stock {stock_sym}")
                        continue

                    stock_ticker = ib.reqMktData(qualified_stock, '', False, False)
                    
                    def make_stock_tick_handler(s, ws):
                        def _on_stock_tick(t):
                            price = _extract_market_price(t)
                            if price is not None:
                                payload = {"options": {}, "stocks": {s: {"mark": price}}}
                                asyncio.create_task(send_message_safe(ws, json.dumps(payload)))
                        return _on_stock_tick
                    
                    stock_ticker.updateEvent += make_stock_tick_handler(stock_sym, websocket)
                    client_subscriptions[websocket][f"stock_{stock_sym}"] = stock_ticker
                    logging.info(f"Subscribed to stock: {stock_sym}")

            elif data.get('action') == 'sync_underlying':
                raw_underlying = data.get('underlying')
                underlying_request = _build_underlying_request(raw_underlying, [])
                try:
                    contract = _build_contract_from_request(underlying_request)
                except Exception as e:
                    logging.error(f"Invalid manual sync request: {underlying_request!r} ({e})")
                    continue

                qualified_underlying = await _qualify_one(contract, underlying_request)
                if qualified_underlying is None:
                    logging.error(f"Failed to manual sync underlying {_describe_contract_request(underlying_request)}")
                else:
                    ticker = ib.reqMktData(qualified_underlying, '', False, False)
                    # Wait momentarily for IB to populate a snapshot-like first tick.
                    await asyncio.sleep(0.5)
                    price = _extract_market_price(ticker)

                    if price is not None:
                        payload = {
                            "underlyingPrice": price,
                            "options": {}
                        }
                        await send_message_safe(websocket, json.dumps(payload))

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        logging.info(f"Client disconnected: {client_ip}")
        # Clean up all tracking logic for this exact websocket
        unsubscribe_client_safely(websocket)
        if websocket in connected_clients:
            connected_clients.remove(websocket)
        client_subscriptions.pop(websocket, None)

async def main():
    try:
        # Attempt IB connection (one connection for the lifetime of this process)
        await connect_ib()

        # Register the tick callback
        ib.pendingTickersEvent += on_pending_tickers

        # Start the WebSocket server
        logging.info(f"Starting WebSocket server on ws://{WS_HOST}:{WS_PORT}")
        try:
            ws_server = await websockets.serve(handle_ws_client, WS_HOST, WS_PORT)
        except OSError as e:
            logging.error(
                f"Cannot bind WebSocket server on port {WS_PORT}: {e}\n"
                f"  A previous ib_server.py session is likely still running.\n"
                f"  Fix: run  Stop-Process -Name python -Force  in PowerShell, then restart."
            )
            return

        async with ws_server:
            # Keep the event loop running forever, yielding to ib_async's network operations
            while True:
                await asyncio.sleep(1)
    finally:
        # Guaranteed cleanup: runs on Ctrl+C, SIGTERM, or any unhandled exception
        if ib.isConnected():
            logging.info("Disconnecting from IB...")
            ib.disconnect()
            logging.info("Disconnected from IB.")

if __name__ == "__main__":
    # Treat SIGTERM (e.g. `kill`, service stop, terminal closure) identically to
    # Ctrl+C so the finally block in main() always fires and IB is cleanly disconnected.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Server stopped by user.")
