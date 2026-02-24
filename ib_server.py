import asyncio
import json
import logging
import configparser
from ib_insync import *
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
    while not ib.isConnected():
        try:
            logging.info(f"Connecting to IB TWS/Gateway at {TWS_HOST}:{TWS_PORT} (Client ID: {TWS_CLIENT_ID})...")
            # Use connectAsync so it doesn't block the asyncio event loop
            await ib.connectAsync(TWS_HOST, TWS_PORT, clientId=TWS_CLIENT_ID)
            logging.info("Successfully connected to IB.")
            # Set market data type to delayed if live is not available, useful for dev
            ib.reqMarketDataType(3) 
        except Exception as e:
            logging.error(f"Connection failed: {e}. Retrying in 5 seconds...")
            await asyncio.sleep(5)

def on_pending_tickers(tickers):
    """
    Callback fired by ib_insync when streaming data ticks arrive.
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
                price = ticker.marketPrice()
                iv = getattr(ticker, 'impliedVolatility', None) or getattr(ticker.modelGreeks, 'impliedVol', None) if hasattr(ticker, 'modelGreeks') and ticker.modelGreeks else getattr(ticker, 'impliedVolatility', None)
                
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
                
                # Check if the requested symbol is already being streamed by another client to avoid redundant qualification
                contract = Stock(symbol, 'SMART', 'USD')
                try:
                    await ib.qualifyContractsAsync(contract)
                    
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
                        try:
                            await ib.qualifyContractsAsync(opt_contract)
                            # genericTickList '106' explicitly requests Option Implied Volatility and Greeks
                            opt_ticker = ib.reqMktData(opt_contract, '106', False, False)
                            client_subscriptions[websocket][leg_id] = opt_ticker
                        except Exception as e:
                            logging.error(f"Failed to qualify option {strike} {right}: {e}")
                            
                except Exception as e:
                    logging.error(f"Failed to qualify underlying {symbol}: {e}")
                    
            elif data.get('action') == 'sync_underlying':
                symbol = data.get('underlying')
                contract = Stock(symbol, 'SMART', 'USD')
                try:
                    await ib.qualifyContractsAsync(contract)
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
                except Exception as e:
                    logging.error(f"Failed to manual sync underlying {symbol}: {e}")

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
    # Attempt IB connection
    await connect_ib()
    
    # Register the tick callback
    ib.pendingTickersEvent += on_pending_tickers
    
    # Start the WebSocket server
    logging.info(f"Starting WebSocket server on ws://{WS_HOST}:{WS_PORT}")
    async with websockets.serve(handle_ws_client, WS_HOST, WS_PORT):
        # Keep the event loop running forever, yielding to ib_insync's network operations
        while True:
            await asyncio.sleep(1)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Server stopped by user.")
        if ib.isConnected():
            ib.disconnect()
