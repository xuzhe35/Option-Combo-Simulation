"""Shared runtime payload contracts for frontend/backend boundaries."""

from __future__ import annotations

from typing import Any, TypedDict


class QuoteTimeEvidence(TypedDict, total=False):
    quoteAsOf: str
    batchId: str
    snapshotId: str


class PayloadTimeEvidence(TypedDict, total=False):
    marketDataGeneration: int
    payloadAsOf: str
    batchId: str
    quoteComplete: bool
    coherent: bool
    coherenceReason: str


class QuoteSnapshot(QuoteTimeEvidence, total=False):
    bid: float | None
    ask: float | None
    mark: float
    bidPresent: bool
    askPresent: bool
    bidAskValid: bool
    # 'two_sided' | 'one_sided_bid' | 'one_sided_ask' | 'crossed' | 'missing'
    bidAskStatus: str
    # 'bid_ask_mid' | 'model' | 'last_close' — set for option quotes so
    # consumers can tell a real two-sided market from a TWS-model fallback.
    # Missing sides remain null in JSON and are never backfilled from mark.
    markSource: str


class OptionQuoteSnapshot(QuoteSnapshot, total=False):
    # Exact option identity returned by IB qualification / ContractDetails.
    # Consumers should validate these fields against the requested leg before
    # accepting a quote, especially for futures options that can share an
    # expiry/strike/right across more than one underlying futures month.
    conId: int
    secType: str
    symbol: str
    localSymbol: str
    exchange: str
    currency: str
    multiplier: str
    tradingClass: str
    right: str
    strike: float
    optionExpiry: str
    contractIdentitySource: str
    underConId: int
    underlyingContractMonth: str
    underlyingBindingVerified: bool
    underlyingBindingSource: str
    underlyingBindingStatus: str
    iv: float
    delta: float
    expiryAsOf: str
    expiryTimingSource: str
    lastTradeDate: str
    lastTradeTime: str
    timeZoneId: str
    realExpirationDate: str


class OptionContractMetadataPayload(TypedDict, total=False):
    """Price-independent qualified option identity and expiry timing.

    This payload deliberately does not inherit ``PayloadTimeEvidence``.  A
    ContractDetails handoff is not a market quote and must not refresh the
    browser's live quote/feed clock.
    """

    action: str
    marketDataGeneration: int
    contractMetadataOnly: bool
    options: dict[str, OptionQuoteSnapshot]


class MarketReferenceQuoteSnapshot(QuoteSnapshot, total=False):
    conId: int
    secType: str
    symbol: str
    localSymbol: str
    exchange: str
    currency: str
    multiplier: str
    contractMonth: str
    # 'ib_contract_details' (authoritative delivery month) or 'last_trade_date'
    # (derived, and wrong whenever expiry leads delivery as it does for CL).
    contractMonthSource: str
    lastTradeDate: str


class LiveMarketDataPayload(PayloadTimeEvidence):
    underlyingPrice: float | None
    underlyingQuote: QuoteSnapshot | None
    options: dict[str, OptionQuoteSnapshot]
    futures: dict[str, MarketReferenceQuoteSnapshot]
    stocks: dict[str, QuoteSnapshot]
    # Optional diagnostics such as SPX for ES/MES or NDX for NQ/MNQ.
    # FOP pricing never depends on these references; its Forward remains the
    # leg-bound futures quote.
    carryReferences: dict[str, MarketReferenceQuoteSnapshot]


class ManualUnderlyingSyncPayload(TypedDict, total=False):
    marketDataGeneration: int
    underlyingPrice: float
    underlyingQuote: QuoteSnapshot
    options: dict[str, Any]


class HistoricalReplayErrorPayload(TypedDict, total=False):
    action: str
    marketDataGeneration: int
    message: str
    requestId: str


class HistoricalBarsResponsePayload(TypedDict, total=False):
    action: str
    marketDataGeneration: int
    symbol: str
    bars: list[dict[str, Any]]
    dataSource: str
    fallbackReason: str
    requestId: str


class DiscountCurvePointPayload(TypedDict, total=False):
    tenorCode: str
    tenorDays: int
    discountFactor: float
    zeroRate: float
    parYield: float
    rate: float
    continuousRate: float
    continuousRateIsProxy: bool
    proxy: bool
    source: str
    sourceEffectiveDate: str
    quoteAsOf: str
    inputSemantics: str
    inputRate: float
    inputParYield: float
    quality: dict[str, Any]


class DiscountCurveDataPayload(TypedDict, total=False):
    schemaVersion: int
    kind: str
    curveId: str
    currency: str
    snapshotId: str
    requestedDate: str
    curveAsOf: str
    asOf: str
    effectiveDate: str
    availableAsOf: str
    quoteAsOf: str
    quoteAsOfPrecision: str
    source: str
    sourceUrl: str
    points: list[DiscountCurvePointPayload]
    curveSemantics: dict[str, Any]
    inputSemantics: str
    discountRateSemantics: str
    quality: dict[str, Any]
    policy: dict[str, Any]
    sources: dict[str, Any]
    syncMetadata: dict[str, Any] | None


class DiscountCurveSnapshotPayload(TypedDict, total=False):
    action: str
    status: str
    fallbackUsed: bool
    refreshAttempted: bool
    error: str
    curve: DiscountCurveDataPayload | None


# Compatibility names for code importing the first-generation contracts.
TreasuryCurvePointPayload = DiscountCurvePointPayload
TreasuryCurveSnapshotPayload = DiscountCurveDataPayload


class IbConnectionStatusPayload(TypedDict, total=False):
    action: str
    serverSessionId: str
    connected: bool
    connecting: bool
    reconnecting: bool
    connectionState: str
    host: str
    port: int
    clientId: int
    configuredClientId: int
    retryIntervalSeconds: int
    marketDataGeneration: int
    marketDataState: str
    recoveryReason: str
    subscriptionsRequired: bool
    automaticReplayAllowed: bool
    requestId: str
    message: str


class ApiMarketDataResetPayload(TypedDict, total=False):
    action: str
    success: bool
    requestedBy: str
    trackedClientCount: int
    stoppedIvSyncCount: int
    knownTickerCount: int
    cancelledTickerCount: int
    cancelErrorCount: int
    connectionWasConnected: bool
    connectionReset: bool
    reconnecting: bool
    marketDataGeneration: int
    marketDataState: str
    recoveryReason: str
    subscriptionsRequired: bool
    automaticReplayAllowed: bool
    message: str


class IvTermStructureExpiryRowPayload(TypedDict, total=False):
    expiry: str
    dte: int
    atmStrike: float | None
    atmCallSubId: str
    atmPutSubId: str
    subscriptionSelected: bool


class IvTermStructureOptionDescriptor(TypedDict):
    expiry: str
    dte: int
    strike: float
    right: str
    isAtm: bool


class IvTermStructureSyncStartedPayload(PayloadTimeEvidence, total=False):
    action: str
    symbol: str
    protocolVersion: str
    clientProtocolVersion: str
    catalogTimeoutSeconds: float
    accepted: bool
    message: str


class IvTermStructureSnapshotPayload(PayloadTimeEvidence, total=False):
    action: str
    symbol: str
    anchorDate: str
    maxDte: int
    strikeRadius: int
    maxOptionStreams: int
    underlyingPrice: float | None
    underlyingQuote: QuoteSnapshot | None
    expiryRows: list[IvTermStructureExpiryRowPayload]
    optionDescriptors: dict[str, IvTermStructureOptionDescriptor]
    subscribedOptionCount: int
    expectedOptionCount: int
    attemptedOptionCount: int
    failedOptionCount: int
    timedOutOptionCount: int
    subscriptionErrorMessage: str
    sharedAtmProbeTimedOut: bool
    subscriptionPending: bool
    warning: str
    message: str
    underlyingContractMonth: str
    requestedUnderlyingContractMonth: str


class IvTermStructureCatalogPatchPayload(PayloadTimeEvidence, total=False):
    action: str
    symbol: str
    expiryRows: list[IvTermStructureExpiryRowPayload]
    optionDescriptors: dict[str, IvTermStructureOptionDescriptor]
    resolvedExpiryCount: int
    totalExpiryCount: int
    subscribedOptionCount: int
    expectedOptionCount: int
    attemptedOptionCount: int
    failedOptionCount: int
    timedOutOptionCount: int
    subscriptionErrorMessage: str
    sharedAtmProbeTimedOut: bool
    subscriptionPending: bool
    message: str


class IvTermStructureSyncCompletePayload(PayloadTimeEvidence, total=False):
    action: str
    symbol: str
    subscribedOptionCount: int
    expectedOptionCount: int
    attemptedOptionCount: int
    failedOptionCount: int
    timedOutOptionCount: int
    subscriptionErrorMessage: str
    sharedAtmProbeTimedOut: bool


class IvTermStructureQuoteSnapshotPayload(PayloadTimeEvidence, total=False):
    action: str
    symbol: str
    snapshotId: str
    subscriptionComplete: bool
    expectedOptionCount: int
    subscribedOptionCount: int
    attemptedOptionCount: int
    failedOptionCount: int
    timedOutOptionCount: int
    snapshotOptionCount: int
    missingSubscriptionOptionIds: list[str]
    missingQuoteOptionIds: list[str]
    missingQuoteEvidenceOptionIds: list[str]
    invalidQuoteOptionIds: list[str]
    invalidContractIdentityOptionIds: list[str]
    staleQuoteOptionIds: list[str]
    underlyingPrice: float | None
    underlyingQuote: QuoteSnapshot | None
    options: dict[str, OptionQuoteSnapshot]
    underlyingContractMonth: str
    quoteSkewSeconds: float
    maxQuoteAgeSeconds: float
    maxQuoteSkewSeconds: float


class IvTermStructureErrorPayload(PayloadTimeEvidence):
    action: str
    symbol: str
    message: str
