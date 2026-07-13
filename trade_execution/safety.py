"""One-time, short-lived authorization for broker-facing execution plans."""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from typing import Any


class ExecutionPlanAuthorizer:
    def __init__(self, ttl_seconds: float = 60.0):
        self.ttl_seconds = max(float(ttl_seconds), 1.0)
        self._plans: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _canonical(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        common = {
            "kind": kind,
            "account": str(payload.get("account") or "").strip(),
        }
        if kind == "hedge":
            common.update({
                "hedgeId": str(payload.get("hedgeId") or "").strip(),
                "secType": str(payload.get("secType") or "").upper(),
                "symbol": str(payload.get("symbol") or "").upper(),
                "exchange": str(payload.get("exchange") or "").upper(),
                "currency": str(payload.get("currency") or "USD").upper(),
                "contractMonth": str(payload.get("contractMonth") or "")[:6],
                "multiplier": str(payload.get("multiplier") or ""),
                "orderAction": str(payload.get("orderAction") or "").upper(),
                "quantity": int(float(payload.get("quantity") or 0)),
                "orderType": str(payload.get("orderType") or "LMT").upper(),
                "limitPrice": float(payload.get("limitPrice")) if payload.get("limitPrice") not in (None, "") else None,
                "timeInForce": str(payload.get("timeInForce") or "DAY").upper(),
            })
            return common
        legs = []
        for leg in payload.get("legs") or []:
            legs.append({
                "id": str(leg.get("id") or ""),
                "secType": str(leg.get("secType") or "").upper(),
                "symbol": str(leg.get("symbol") or "").upper(),
                "underlyingSymbol": str(leg.get("underlyingSymbol") or "").upper(),
                "exchange": str(leg.get("exchange") or "").upper(),
                "underlyingExchange": str(leg.get("underlyingExchange") or "").upper(),
                "currency": str(leg.get("currency") or "USD").upper(),
                "multiplier": str(leg.get("multiplier") or ""),
                "underlyingMultiplier": str(leg.get("underlyingMultiplier") or ""),
                "tradingClass": str(leg.get("tradingClass") or "").upper(),
                "contractMonth": str(leg.get("contractMonth") or "")[:6],
                "underlyingContractMonth": str(leg.get("underlyingContractMonth") or "")[:6],
                "expDate": str(leg.get("expDate") or "").replace("-", ""),
                "right": str(leg.get("right") or "").upper(),
                "strike": float(leg.get("strike")) if leg.get("strike") not in (None, "") else None,
                "pos": int(float(leg.get("pos") or 0)),
                "observedBid": float(leg.get("observedBid")) if leg.get("observedBid") not in (None, "") else None,
                "observedAsk": float(leg.get("observedAsk")) if leg.get("observedAsk") not in (None, "") else None,
                "observedMark": float(leg.get("observedMark")) if leg.get("observedMark") not in (None, "") else None,
            })
        common.update({
            "groupId": str(payload.get("groupId") or ""),
            "underlyingSymbol": str(payload.get("underlyingSymbol") or "").upper(),
            "underlyingContractMonth": str(payload.get("underlyingContractMonth") or "")[:6],
            "executionIntent": str(payload.get("executionIntent") or "open").lower(),
            "timeInForce": str(payload.get("timeInForce") or "DAY").upper(),
            "managedRepriceThreshold": (
                float(payload.get("managedRepriceThreshold"))
                if payload.get("managedRepriceThreshold") not in (None, "") else None
            ),
            "managedConcessionRatio": (
                float(payload.get("managedConcessionRatio"))
                if payload.get("managedConcessionRatio") not in (None, "") else None
            ),
            "observedUnderlyingPrice": (
                float(payload.get("observedUnderlyingPrice"))
                if payload.get("observedUnderlyingPrice") not in (None, "") else None
            ),
            "profile": payload.get("profile") if isinstance(payload.get("profile"), dict) else {},
            "legs": legs,
        })
        return common

    @classmethod
    def _fingerprint(cls, kind: str, payload: dict[str, Any]) -> str:
        encoded = json.dumps(cls._canonical(kind, payload), sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def register(self, websocket: Any, kind: str, payload: dict[str, Any], position_marker: str | None = None) -> dict[str, Any]:
        self._purge_expired()
        token = secrets.token_urlsafe(24)
        expires_monotonic = time.monotonic() + self.ttl_seconds
        self._plans[token] = {
            "websocket": websocket,
            "kind": kind,
            "fingerprint": self._fingerprint(kind, payload),
            "expiresMonotonic": expires_monotonic,
            "positionMarker": position_marker,
        }
        return {
            "executionPlanToken": token,
            "executionPlanExpiresAtEpochMs": int((time.time() + self.ttl_seconds) * 1000),
        }

    def validate_and_consume(self, websocket: Any, kind: str, payload: dict[str, Any], position_marker: str | None = None) -> None:
        self._purge_expired()
        token = str(payload.get("executionPlanToken") or "").strip()
        if not token:
            raise ValueError("A fresh confirmed execution plan is required before submit.")
        record = self._plans.pop(token, None)
        if not record:
            raise ValueError("Execution plan authorization expired or was already used. Preview again.")
        if record["websocket"] is not websocket or record["kind"] != kind:
            raise ValueError("Execution plan authorization belongs to a different session or order type.")
        if record["fingerprint"] != self._fingerprint(kind, payload):
            raise ValueError("Order changed after confirmation. Preview and confirm again.")
        if record.get("positionMarker") != position_marker:
            raise ValueError("TWS positions changed after confirmation. Refresh positions and confirm again.")

    def revoke_for_websocket(self, websocket: Any) -> None:
        for token in [token for token, record in self._plans.items() if record.get("websocket") is websocket]:
            self._plans.pop(token, None)

    def _purge_expired(self) -> None:
        now = time.monotonic()
        for token in [token for token, record in self._plans.items() if record.get("expiresMonotonic", 0) <= now]:
            self._plans.pop(token, None)
