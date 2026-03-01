import asyncio
import json
import logging
import random
import signal
import configparser
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
            # Set market data type to delayed if live is not available, useful for dev
            ib.reqMarketDataType(3)
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
            "options": {}
        }
        
        has_data = False
        
        if 'underlying' in subs:
            ticker = subs['underlying']
            price = ticker.marketPrice()
            if price == price and price > 0: # Check for NaN
                payload["underlyingPrice"] = price
                has_data = True

        for sub_id, ticker in subs.items():
            if sub_id != 'underlying':
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
                symbol = data.get('underlying')
                options_data = data.get('options', [])

                logging.info(f"Received subscription request from {client_ip} for {symbol} with {len(options_data)} options")

                contract = Stock(symbol, 'SMART', 'USD')
                # ib_async v2.0+: qualifyContractsAsync returns None for failures
                # instead of raising, so we check the result explicitly.
                results = await ib.qualifyContractsAsync(contract)
                if not results or results[0] is None:
                    logging.error(f"Failed to qualify underlying {symbol}")
                else:
                    # Unsubscribe old streams for this specific client safely
                    unsubscribe_client_safely(websocket)

                    # Subscribe Underlying
                    ticker = ib.reqMktData(contract, '', False, False)
                    client_subscriptions[websocket]['underlying'] = ticker

                    # Process Options
                    for opt in options_data:
                        leg_id = opt['id']
                        # Format YYYYMMDD
                        exp_date = opt['expDate'].replace('-', '')
                        strike = float(opt['strike'])
                        right = opt['right'] # 'C' or 'P'

                        opt_contract = Option(symbol, exp_date, strike, right, 'SMART', multiplier='100', currency='USD')
                        opt_results = await ib.qualifyContractsAsync(opt_contract)
                        if not opt_results or opt_results[0] is None:
                            logging.error(f"Failed to qualify option {strike} {right}")
                        else:
                            # genericTickList '106' explicitly requests Option Implied Volatility and Greeks
                            opt_ticker = ib.reqMktData(opt_contract, '106', False, False)
                            client_subscriptions[websocket][leg_id] = opt_ticker

            elif data.get('action') == 'sync_underlying':
                symbol = data.get('underlying')
                contract = Stock(symbol, 'SMART', 'USD')
                results = await ib.qualifyContractsAsync(contract)
                if not results or results[0] is None:
                    logging.error(f"Failed to manual sync underlying {symbol}")
                else:
                    ticker = ib.reqMktData(contract, '', False, False)
                    # wait momentarily for IB to fetch the snapshot
                    await asyncio.sleep(0.5)
                    price = ticker.marketPrice()

                    if price == price and price > 0:
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
