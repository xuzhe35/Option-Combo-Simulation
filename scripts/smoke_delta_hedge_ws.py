import argparse
import asyncio
import json
import sys
import time


ACTION_MAP = {
    "validate": "validate_hedge_order",
    "preview": "preview_hedge_order",
}

TERMINAL_ACTIONS = {
    "hedge_order_validation_result",
    "hedge_order_preview_result",
    "hedge_order_error",
}


def build_arg_parser():
    parser = argparse.ArgumentParser(
        description=(
            "Smoke-test Delta hedge WebSocket routing against a running ib_server.py. "
            "This script intentionally supports validate/preview only and never submits live orders."
        )
    )
    parser.add_argument("--host", default="127.0.0.1", help="ib_server WebSocket host")
    parser.add_argument("--port", type=int, default=8765, help="ib_server WebSocket port")
    parser.add_argument(
        "--action",
        choices=sorted(ACTION_MAP.keys()),
        default="validate",
        help="Safe hedge action to send. submit is intentionally unsupported.",
    )
    parser.add_argument("--hedge-id", default="delta_hedge_smoke", help="Smoke request hedgeId")
    parser.add_argument("--hedge-name", default="Delta Hedge Smoke", help="Smoke request display name")
    parser.add_argument("--sec-type", choices=("STK", "FUT", "stk", "fut"), default="STK")
    parser.add_argument("--symbol", default="SPY", help="Hedge instrument symbol")
    parser.add_argument("--exchange", default="SMART", help="Hedge instrument exchange")
    parser.add_argument("--currency", default="USD", help="Hedge instrument currency")
    parser.add_argument("--contract-month", default="", help="Required for FUT, e.g. 202606")
    parser.add_argument("--multiplier", default="", help="Optional FUT multiplier, e.g. 50 for ES")
    parser.add_argument("--side", choices=("BUY", "SELL", "buy", "sell"), default="BUY")
    parser.add_argument("--quantity", type=int, default=1)
    parser.add_argument("--order-type", choices=("LMT", "MKT", "lmt", "mkt"), default="LMT")
    parser.add_argument("--limit-price", type=float, default=None, help="Required for LMT")
    parser.add_argument("--time-in-force", choices=("DAY", "GTC", "day", "gtc"), default="DAY")
    parser.add_argument(
        "--account",
        default="",
        help="Optional account for preview. Live submit is not supported by this smoke script.",
    )
    parser.add_argument("--timeout", type=float, default=8.0, help="Seconds to wait for target response")
    parser.add_argument("--verbose", action="store_true", help="Print ignored startup messages")
    parser.add_argument(
        "--token",
        default="",
        help=(
            "Server auth token (the token file path is in the server's startup log). "
            "Falls back to the OPTION_COMBO_WS_AUTH_TOKEN environment variable."
        ),
    )
    return parser


def resolve_auth_token(args):
    import os

    token = str(getattr(args, "token", "") or "").strip()
    if token:
        return token
    return str(os.environ.get("OPTION_COMBO_WS_AUTH_TOKEN") or "").strip()


def validate_payload_args(args):
    if args.quantity <= 0:
        raise ValueError("quantity must be positive")

    order_type = str(args.order_type or "").strip().upper()
    if order_type == "LMT" and (args.limit_price is None or args.limit_price <= 0):
        raise ValueError("LMT smoke requests require a positive limit price")

    sec_type = str(args.sec_type or "").strip().upper()
    if sec_type == "FUT" and not str(args.contract_month or "").strip():
        raise ValueError("FUT smoke requests require a contract month")


def build_payload(args):
    validate_payload_args(args)
    payload = {
        "action": ACTION_MAP[args.action],
        "hedgeId": args.hedge_id,
        "hedgeName": args.hedge_name,
        "secType": str(args.sec_type).strip().upper(),
        "symbol": str(args.symbol).strip().upper(),
        "exchange": str(args.exchange).strip(),
        "currency": str(args.currency).strip().upper(),
        "orderAction": str(args.side).strip().upper(),
        "quantity": int(args.quantity),
        "orderType": str(args.order_type).strip().upper(),
        "timeInForce": str(args.time_in_force).strip().upper(),
        "requestSource": "delta_hedge_smoke",
    }

    if payload["orderType"] == "LMT":
        payload["limitPrice"] = float(args.limit_price)
    if args.account:
        payload["account"] = str(args.account).strip()
    if args.contract_month:
        payload["contractMonth"] = str(args.contract_month).strip()
    if args.multiplier:
        payload["multiplier"] = str(args.multiplier).strip()

    return payload


def is_target_response(message, hedge_id):
    if not isinstance(message, dict):
        return False
    action = message.get("action")
    if action not in TERMINAL_ACTIONS:
        return False
    return str(message.get("hedgeId") or "") == str(hedge_id or "")


async def run_smoke(args):
    import websockets

    payload = build_payload(args)
    url = f"ws://{args.host}:{args.port}"
    deadline = time.monotonic() + max(float(args.timeout), 0.1)

    auth_token = resolve_auth_token(args)

    async with websockets.connect(url) as websocket:
        if auth_token:
            await websocket.send(json.dumps({"action": "authenticate", "token": auth_token}))
        await websocket.send(json.dumps(payload))

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    f"Timed out waiting for hedge response {payload['action']} "
                    f"for hedgeId={payload['hedgeId']} from {url}"
                )

            raw_message = await asyncio.wait_for(websocket.recv(), timeout=remaining)
            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                if args.verbose:
                    print(f"Ignored non-JSON message: {raw_message}", file=sys.stderr)
                continue

            if is_target_response(message, payload["hedgeId"]):
                return message

            if args.verbose:
                print(f"Ignored message: {json.dumps(message, sort_keys=True)}", file=sys.stderr)


def main(argv=None):
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    try:
        response = asyncio.run(run_smoke(args))
    except Exception as exc:
        print(f"Smoke failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(response, indent=2, sort_keys=True))
    return 2 if response.get("action") == "hedge_order_error" else 0


if __name__ == "__main__":
    raise SystemExit(main())
