import asyncio
import configparser
import json
import logging
import os
import signal

import websockets

from historical_replay_service import (
    HistoricalReplayService,
    describe_contract_request,
    normalize_replay_date,
)


logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

config = configparser.ConfigParser()
config.read('config.ini')

CONFIGURED_WS_HOST = config.get('server', 'ws_host', fallback='127.0.0.1').strip()
WS_HOST = '127.0.0.1'
WS_PORT = config.getint('server', 'ws_port', fallback=8765)
HISTORICAL_SQLITE_DB = os.path.abspath(
    config.get('historical', 'sqlite_db_path', fallback=os.path.join('sqlite_spy', 'spy_options.db'))
)

if CONFIGURED_WS_HOST not in ('127.0.0.1', 'localhost'):
    logging.warning(
        "Ignoring configured server.ws_host=%r and binding WebSocket server to 127.0.0.1 only.",
        CONFIGURED_WS_HOST,
    )
elif CONFIGURED_WS_HOST != WS_HOST:
    logging.info(
        "Normalizing configured server.ws_host=%r to 127.0.0.1.",
        CONFIGURED_WS_HOST,
    )

historical_replay_service = HistoricalReplayService(
    HISTORICAL_SQLITE_DB,
    logger=logging.getLogger('historical_replay.sqlite'),
)


async def send_message_safe(ws, message):
    try:
        await ws.send(message)
    except Exception:
        pass


async def handle_ws_client(websocket):
    client_ip = websocket.remote_address[0] if websocket.remote_address else 'Unknown'
    logging.info("Historical replay client connected: %s", client_ip)

    try:
        async for message in websocket:
            data = json.loads(message)
            action = data.get('action')

            if action == 'request_historical_snapshot':
                raw_underlying = data.get('underlying')
                options_data = data.get('options', [])
                requested_date = normalize_replay_date(data.get('replayDate'))
                underlying_request = raw_underlying if isinstance(raw_underlying, dict) else {}

                logging.info(
                    "Received historical snapshot request from %s for date %s, underlying %s, %d options",
                    client_ip,
                    requested_date or '<latest>',
                    describe_contract_request(underlying_request),
                    len(options_data),
                )

                try:
                    payload = historical_replay_service.build_snapshot_payload(
                        requested_date,
                        underlying_request,
                        options_data,
                    )
                except Exception as exc:
                    logging.exception("Historical replay snapshot failed")
                    await send_message_safe(websocket, json.dumps({
                        "action": "historical_replay_error",
                        "message": str(exc),
                    }))
                    continue

                if payload is None:
                    await send_message_safe(websocket, json.dumps({
                        "action": "historical_replay_error",
                        "message": (
                            f"No underlying historical quote was found for "
                            f"{describe_contract_request(underlying_request)} "
                            f"on {requested_date or 'the latest available date'}."
                        ),
                    }))
                    continue

                await send_message_safe(websocket, json.dumps(payload))
                continue

            if action == 'request_portfolio_avg_cost_snapshot':
                await send_message_safe(websocket, json.dumps({
                    "action": "portfolio_avg_cost_update",
                    "items": [],
                }))
                continue

            await send_message_safe(websocket, json.dumps({
                "action": "historical_replay_error",
                "message": (
                    "historical_server.py only supports historical replay requests. "
                    "Use ib_server.py for live IBKR subscriptions and execution."
                ),
            }))

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        logging.info("Historical replay client disconnected: %s", client_ip)


async def main():
    logging.info("Starting historical replay WebSocket server on ws://%s:%s", WS_HOST, WS_PORT)
    try:
        ws_server = await websockets.serve(handle_ws_client, WS_HOST, WS_PORT)
    except OSError as exc:
        logging.error(
            "Cannot bind WebSocket server on port %s: %s\n"
            "  A previous backend session is likely still running.\n"
            "  Fix: stop the old process, then restart.",
            WS_PORT,
            exc,
        )
        return

    async with ws_server:
        while True:
            await asyncio.sleep(1)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Historical replay server stopped by user.")
