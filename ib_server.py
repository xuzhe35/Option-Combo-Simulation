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
current_subscriptions = {} # Map leg_id -> Ticker

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
    We batch process these and broadcast state to all connected WS clients.
    """
    if not connected_clients:
        return
        
    payload = {
        "underlyingPrice": None,
        "options": {}
    }
    
    # We expect current_subscriptions to have 'underlying' and 'leg_X' keys mapping to Ticker objects
    
    if 'underlying' in current_subscriptions:
        ticker = current_subscriptions['underlying']
        # Use marketPrice() which attempts to find the best available price (last, or mid of bid/ask)
        price = ticker.marketPrice()
        if price == price and price > 0: # Check for NaN
            payload["underlyingPrice"] = price

    for sub_id, ticker in current_subscriptions.items():
        if sub_id != 'underlying':
            price = ticker.marketPrice()
            if price == price and price > 0:
                payload["options"][sub_id] = {
                    "mark": price
                }
                
    # Broadcast if there's any usable data
    if payload["underlyingPrice"] is not None or payload["options"]:
        message = json.dumps(payload)
        websockets.broadcast(connected_clients, message)

async def handle_ws_client(websocket):
    client_ip = websocket.remote_address[0] if websocket.remote_address else 'Unknown'
    logging.info(f"Client connected: {client_ip}")
    connected_clients.add(websocket)
    try:
        async for message in websocket:
            data = json.loads(message)
            
            if data.get('action') == 'subscribe':
                symbol = data.get('underlying')
                options_data = data.get('options', [])
                
                logging.info(f"Received subscription request for {symbol} with {len(options_data)} options")
                
                # Try to qualify the underlying symbol (Assuming US Stocks/Indices for now)
                contract = Stock(symbol, 'SMART', 'USD')
                # If it's an index like SPX, we should technically use Index(), but Stock usually resolves for ETFs like SPY.
                try:
                    await ib.qualifyContractsAsync(contract)
                    
                    # Unsubscribe old streams
                    for ticker in current_subscriptions.values():
                        ib.cancelMktData(ticker.contract)
                    current_subscriptions.clear()
                    
                    # Subscribe Underlying
                    ticker = ib.reqMktData(contract, '', False, False)
                    current_subscriptions['underlying'] = ticker
                    
                    # Process Options
                    for opt in options_data:
                        leg_id = opt['id']
                        # Format YYYYMMDD
                        exp_date = opt['expDate'].replace('-', '')
                        strike = float(opt['strike'])
                        right = opt['right'] # 'C' or 'P'
                        
                        # Specify standard SPY option parameters to avoid ambiguity
                        opt_contract = Option(symbol, exp_date, strike, right, 'SMART', multiplier='100', currency='USD')
                        try:
                            await ib.qualifyContractsAsync(opt_contract)
                            opt_ticker = ib.reqMktData(opt_contract, '', False, False)
                            current_subscriptions[leg_id] = opt_ticker
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
                        await websocket.send(json.dumps(payload))
                except Exception as e:
                    logging.error(f"Failed to manual sync underlying {symbol}: {e}")

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        logging.info(f"Client disconnected: {client_ip}")
        connected_clients.remove(websocket)

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
