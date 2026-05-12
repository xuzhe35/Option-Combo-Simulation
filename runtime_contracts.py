"""Shared runtime payload contracts for frontend/backend boundaries."""

from __future__ import annotations

from typing import Any, TypedDict


class QuoteSnapshot(TypedDict):
    bid: float
    ask: float
    mark: float


class OptionQuoteSnapshot(QuoteSnapshot, total=False):
    iv: float
    delta: float


class LiveMarketDataPayload(TypedDict):
    underlyingPrice: float | None
    underlyingQuote: QuoteSnapshot | None
    options: dict[str, OptionQuoteSnapshot]
    futures: dict[str, QuoteSnapshot]
    stocks: dict[str, QuoteSnapshot]


class ManualUnderlyingSyncPayload(TypedDict):
    underlyingPrice: float
    underlyingQuote: QuoteSnapshot
    options: dict[str, Any]


class HistoricalReplayErrorPayload(TypedDict, total=False):
    action: str
    message: str
    requestId: str


class HistoricalBarsResponsePayload(TypedDict, total=False):
    action: str
    symbol: str
    bars: list[dict[str, Any]]
    dataSource: str
    fallbackReason: str
    requestId: str


class IvTermStructureExpiryRowPayload(TypedDict, total=False):
    expiry: str
    dte: int
    atmStrike: float | None
    atmCallSubId: str
    atmPutSubId: str


class IvTermStructureOptionDescriptor(TypedDict):
    expiry: str
    dte: int
    strike: float
    right: str
    isAtm: bool


class IvTermStructureSnapshotPayload(TypedDict, total=False):
    action: str
    symbol: str
    anchorDate: str
    maxDte: int
    strikeRadius: int
    underlyingPrice: float | None
    underlyingQuote: QuoteSnapshot | None
    expiryRows: list[IvTermStructureExpiryRowPayload]
    optionDescriptors: dict[str, IvTermStructureOptionDescriptor]
    subscribedOptionCount: int
    expectedOptionCount: int
    subscriptionPending: bool
    warning: str


class IvTermStructureCatalogPatchPayload(TypedDict):
    action: str
    symbol: str
    expiryRows: list[IvTermStructureExpiryRowPayload]
    optionDescriptors: dict[str, IvTermStructureOptionDescriptor]
    resolvedExpiryCount: int
    totalExpiryCount: int
    subscribedOptionCount: int
    expectedOptionCount: int
    subscriptionPending: bool


class IvTermStructureSyncCompletePayload(TypedDict):
    action: str
    symbol: str
    subscribedOptionCount: int
    expectedOptionCount: int


class IvTermStructureErrorPayload(TypedDict):
    action: str
    symbol: str
    message: str
