from dataclasses import dataclass, field
from typing import Any, Optional


def _parse_int(value: Any, default: int = 0) -> int:
    try:
        if value in (None, ""):
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_optional_float(value: Any) -> Optional[float]:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _payload_alias_value(payload: dict[str, Any], primary: str, alias: str) -> Any:
    """Return the first explicitly supplied non-empty alias, preserving zero."""
    primary_value = payload.get(primary)
    if primary_value not in (None, ""):
        return primary_value
    return payload.get(alias)


def _normalize_upper(value: Any, default: str = "") -> str:
    normalized = str(value or default or "").strip().upper()
    return normalized


@dataclass
class HedgeOrderRequest:
    hedge_id: Optional[str]
    hedge_name: str
    sec_type: str
    symbol: str
    exchange: str
    currency: str
    order_action: str
    quantity: int
    order_type: str
    limit_price: Optional[float] = None
    time_in_force: str = "DAY"
    execution_mode: str = "preview"
    account: str = ""
    request_source: str = "delta_hedge_manual"
    contract_month: str = ""
    multiplier: str = ""
    delta_per_unit: Optional[float] = None
    current_net_delta: Optional[float] = None
    projected_net_delta: Optional[float] = None
    target_lower: Optional[float] = None
    target_upper: Optional[float] = None
    execution_plan_token: str = ""

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "HedgeOrderRequest":
        order_type = _normalize_upper(payload.get("orderType") or payload.get("order_type"), "LMT")
        if order_type not in {"LMT", "MKT"}:
            order_type = "LMT"

        time_in_force = _normalize_upper(payload.get("timeInForce") or payload.get("time_in_force"), "DAY")
        if time_in_force not in {"DAY", "GTC"}:
            time_in_force = "DAY"

        return cls(
            hedge_id=payload.get("hedgeId") or payload.get("hedge_id"),
            hedge_name=str(payload.get("hedgeName") or payload.get("hedge_name") or "Delta Hedge"),
            sec_type=_normalize_upper(payload.get("secType") or payload.get("sec_type")),
            symbol=_normalize_upper(payload.get("symbol")),
            exchange=str(payload.get("exchange") or "SMART").strip(),
            currency=_normalize_upper(payload.get("currency"), "USD"),
            order_action=_normalize_upper(payload.get("orderAction") or payload.get("order_action")),
            quantity=_parse_int(payload.get("quantity") or payload.get("totalQuantity")),
            order_type=order_type,
            limit_price=_parse_optional_float(payload.get("limitPrice") or payload.get("limit_price")),
            time_in_force=time_in_force,
            execution_mode=str(payload.get("executionMode") or payload.get("execution_mode") or "preview"),
            account=str(payload.get("account") or "").strip(),
            request_source=str(payload.get("requestSource") or payload.get("request_source") or "delta_hedge_manual"),
            contract_month=str(payload.get("contractMonth") or payload.get("contract_month") or ""),
            multiplier=str(payload.get("multiplier") or ""),
            delta_per_unit=_parse_optional_float(payload.get("deltaPerUnit") or payload.get("delta_per_unit")),
            current_net_delta=_parse_optional_float(payload.get("currentNetDelta") or payload.get("current_net_delta")),
            projected_net_delta=_parse_optional_float(payload.get("projectedNetDelta") or payload.get("projected_net_delta")),
            target_lower=_parse_optional_float(payload.get("targetLower") or payload.get("target_lower")),
            target_upper=_parse_optional_float(payload.get("targetUpper") or payload.get("target_upper")),
            execution_plan_token=str(payload.get("executionPlanToken") or payload.get("execution_plan_token") or "").strip(),
        )


@dataclass
class HedgeOrderPreview:
    hedge_id: Optional[str]
    hedge_name: str
    sec_type: str
    symbol: str
    local_symbol: str
    exchange: str
    currency: str
    order_action: str
    quantity: int
    order_type: str
    limit_price: Optional[float] = None
    time_in_force: str = "DAY"
    execution_mode: str = "preview"
    account: str = ""
    request_source: str = "delta_hedge_manual"
    contract_month: str = ""
    multiplier: str = ""
    con_id: Optional[int] = None
    current_net_delta: Optional[float] = None
    projected_net_delta: Optional[float] = None
    target_lower: Optional[float] = None
    target_upper: Optional[float] = None
    price_increment: Optional[float] = None
    what_if: Optional[dict[str, Any]] = None

    def to_payload(self) -> dict[str, Any]:
        payload = {
            "hedgeId": self.hedge_id,
            "hedgeName": self.hedge_name,
            "secType": self.sec_type,
            "symbol": self.symbol,
            "localSymbol": self.local_symbol,
            "exchange": self.exchange,
            "currency": self.currency,
            "orderAction": self.order_action,
            "quantity": self.quantity,
            "orderType": self.order_type,
            "timeInForce": self.time_in_force,
            "executionMode": self.execution_mode,
            "requestSource": self.request_source,
        }
        if self.limit_price is not None:
            payload["limitPrice"] = self.limit_price
        if self.account:
            payload["account"] = self.account
        if self.contract_month:
            payload["contractMonth"] = self.contract_month
        if self.multiplier:
            payload["multiplier"] = self.multiplier
        if self.con_id is not None:
            payload["conId"] = self.con_id
        if self.current_net_delta is not None:
            payload["currentNetDelta"] = self.current_net_delta
        if self.projected_net_delta is not None:
            payload["projectedNetDelta"] = self.projected_net_delta
        if self.target_lower is not None:
            payload["targetLower"] = self.target_lower
        if self.target_upper is not None:
            payload["targetUpper"] = self.target_upper
        if self.price_increment is not None:
            payload["priceIncrement"] = self.price_increment
        if self.what_if is not None:
            payload["whatIf"] = self.what_if
        return payload


@dataclass
class HedgeSubmitResult:
    preview: HedgeOrderPreview
    order_id: Optional[int]
    perm_id: Optional[int]
    status: Optional[str]
    status_message: Optional[str] = None

    def to_payload(self) -> dict[str, Any]:
        payload = self.preview.to_payload()
        payload.update({
            "orderId": self.order_id,
            "permId": self.perm_id,
            "status": self.status,
        })
        if self.status_message:
            payload["statusMessage"] = self.status_message
        return payload


@dataclass
class HedgeValidationResult:
    hedge_id: Optional[str]
    hedge_name: str
    execution_mode: str
    valid: bool
    sec_type: str
    symbol: str
    local_symbol: str
    con_id: Optional[int]

    def to_payload(self) -> dict[str, Any]:
        return {
            "hedgeId": self.hedge_id,
            "hedgeName": self.hedge_name,
            "executionMode": self.execution_mode,
            "valid": self.valid,
            "secType": self.sec_type,
            "symbol": self.symbol,
            "localSymbol": self.local_symbol,
            "conId": self.con_id,
        }


@dataclass
class ComboLegRequest:
    id: Optional[str]
    type: str
    pos: int
    sec_type: str
    symbol: str
    underlying_symbol: str
    exchange: str
    underlying_exchange: str
    currency: str
    multiplier: str
    underlying_multiplier: str
    trading_class: Optional[str]
    right: str
    strike: Optional[float]
    exp_date: str
    contract_month: str
    underlying_contract_month: str
    observed_bid: Optional[float] = None
    observed_ask: Optional[float] = None
    observed_mark: Optional[float] = None
    source_position: Optional[int] = None
    source_cost: Optional[float] = None
    source_realized_pnl: float = 0.0

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "ComboLegRequest":
        return cls(
            id=payload.get("id"),
            type=str(payload.get("type") or ""),
            pos=_parse_int(payload.get("pos")),
            sec_type=str(payload.get("secType") or payload.get("sec_type") or ""),
            symbol=str(payload.get("symbol") or ""),
            underlying_symbol=str(payload.get("underlyingSymbol") or payload.get("underlying_symbol") or ""),
            exchange=str(payload.get("exchange") or ""),
            underlying_exchange=str(payload.get("underlyingExchange") or payload.get("underlying_exchange") or ""),
            currency=str(payload.get("currency") or "USD"),
            multiplier=str(payload.get("multiplier") or ""),
            underlying_multiplier=str(payload.get("underlyingMultiplier") or payload.get("underlying_multiplier") or ""),
            trading_class=payload.get("tradingClass") or payload.get("trading_class"),
            right=str(payload.get("right") or ""),
            strike=_parse_optional_float(payload.get("strike")),
            exp_date=str(payload.get("expDate") or payload.get("expiry") or ""),
            contract_month=str(payload.get("contractMonth") or ""),
            underlying_contract_month=str(payload.get("underlyingContractMonth") or ""),
            observed_bid=_parse_optional_float(
                _payload_alias_value(payload, "observedBid", "observed_bid")
            ),
            observed_ask=_parse_optional_float(
                _payload_alias_value(payload, "observedAsk", "observed_ask")
            ),
            observed_mark=_parse_optional_float(
                _payload_alias_value(payload, "observedMark", "observed_mark")
            ),
            source_position=(
                _parse_int(payload.get("sourcePosition") or payload.get("source_position"))
                if payload.get("sourcePosition") is not None or payload.get("source_position") is not None
                else None
            ),
            source_cost=_parse_optional_float(payload.get("sourceCost") or payload.get("source_cost")),
            source_realized_pnl=(
                _parse_optional_float(payload.get("sourceRealizedPnl") or payload.get("source_realized_pnl"))
                or 0.0
            ),
        )


@dataclass
class ComboOrderRequest:
    group_id: Optional[str]
    group_name: str
    underlying_symbol: str
    underlying_contract_month: str
    execution_mode: str
    account: str = ""
    execution_intent: str = "open"
    request_source: str = "manual"
    managed_reprice_threshold: Optional[float] = None
    managed_concession_ratio: Optional[float] = None
    time_in_force: str = "DAY"
    close_strategy: str = "auto"
    observed_underlying_price: Optional[float] = None
    equivalent_close_max_otm_ask: float = 0.02
    close_confirmation_target_mode: str = ""
    close_plan_token: str = ""
    profile: dict[str, Any] = field(default_factory=dict)
    legs: list[ComboLegRequest] = field(default_factory=list)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "ComboOrderRequest":
        return cls(
            group_id=payload.get("groupId"),
            group_name=str(payload.get("groupName") or "Trial Combo"),
            underlying_symbol=str(payload.get("underlyingSymbol") or ""),
            underlying_contract_month=str(payload.get("underlyingContractMonth") or ""),
            execution_mode=str(payload.get("executionMode") or ""),
            account=str(payload.get("account") or ""),
            execution_intent=str(payload.get("executionIntent") or payload.get("intent") or "open"),
            request_source=str(payload.get("requestSource") or payload.get("source") or "manual"),
            managed_reprice_threshold=_parse_optional_float(
                payload.get("managedRepriceThreshold") or payload.get("managed_reprice_threshold")
            ),
            managed_concession_ratio=_parse_optional_float(
                payload.get("managedConcessionRatio") or payload.get("managed_concession_ratio")
            ),
            time_in_force=str(payload.get("timeInForce") or payload.get("time_in_force") or "DAY").upper(),
            close_strategy=str(payload.get("closeStrategy") or payload.get("close_strategy") or "auto").strip().lower(),
            observed_underlying_price=_parse_optional_float(
                payload.get("observedUnderlyingPrice") or payload.get("observed_underlying_price")
            ),
            equivalent_close_max_otm_ask=(
                _parse_optional_float(
                    payload.get("equivalentCloseMaxOtmAsk") or payload.get("equivalent_close_max_otm_ask")
                )
                or 0.02
            ),
            close_confirmation_target_mode=str(
                payload.get("confirmationTargetMode") or payload.get("close_confirmation_target_mode") or ""
            ).strip().lower(),
            close_plan_token=str(payload.get("closePlanToken") or payload.get("close_plan_token") or "").strip(),
            profile=dict(payload.get("profile") or {}),
            legs=[ComboLegRequest.from_payload(item) for item in (payload.get("legs") or [])],
        )


@dataclass
class ComboPreviewLeg:
    id: Optional[str]
    symbol: str
    local_symbol: str
    sec_type: str
    ratio: int
    mark: float
    target_position: int
    execution_action: str
    combo_leg_action: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "symbol": self.symbol,
            "localSymbol": self.local_symbol,
            "secType": self.sec_type,
            "ratio": self.ratio,
            "mark": self.mark,
            "targetPosition": self.target_position,
            "executionAction": self.execution_action,
            "comboLegAction": self.combo_leg_action,
        }


@dataclass
class ComboOrderPreview:
    group_id: Optional[str]
    group_name: str
    combo_symbol: str
    combo_exchange: str
    order_action: str
    total_quantity: int
    limit_price: float
    pricing_source: str
    raw_net_mid: float
    time_in_force: str = "DAY"
    execution_mode: str = "preview"
    account: str = ""
    execution_intent: str = "open"
    request_source: str = "manual"
    pricing_note: str = ""
    managed_mode: bool = False
    managed_state: Optional[str] = None
    working_limit_price: Optional[float] = None
    latest_combo_mid: Optional[float] = None
    repricing_count: Optional[int] = None
    last_reprice_at: Optional[str] = None
    managed_message: Optional[str] = None
    managed_reprice_threshold: Optional[float] = None
    managed_concession_ratio: Optional[float] = None
    best_combo_price: Optional[float] = None
    worst_combo_price: Optional[float] = None
    price_increment: Optional[float] = None
    can_concede_pricing: bool = False
    continue_action_label: Optional[str] = None
    close_plan_stage: Optional[str] = None
    close_plan_complete: Optional[bool] = None
    close_plan_message: Optional[str] = None
    assignment_adjustments: list[dict[str, Any]] = field(default_factory=list)
    staged_orders: list[dict[str, Any]] = field(default_factory=list)
    close_plan_token: Optional[str] = None
    close_plan_generated_at: Optional[str] = None
    close_plan_expires_at: Optional[str] = None
    close_plan_legs: list[dict[str, Any]] = field(default_factory=list)
    close_plan_orders: list[dict[str, Any]] = field(default_factory=list)
    close_plan_adjustments: list[dict[str, Any]] = field(default_factory=list)
    legs: list[ComboPreviewLeg] = field(default_factory=list)
    what_if: Optional[dict[str, Any]] = None

    def to_payload(self) -> dict[str, Any]:
        payload = {
            "groupId": self.group_id,
            "groupName": self.group_name,
            "comboSymbol": self.combo_symbol,
            "comboExchange": self.combo_exchange,
            "orderAction": self.order_action,
            "totalQuantity": self.total_quantity,
            "limitPrice": self.limit_price,
            "pricingSource": self.pricing_source,
            "rawNetMid": self.raw_net_mid,
            "timeInForce": self.time_in_force,
            "executionMode": self.execution_mode,
            "executionIntent": self.execution_intent,
            "requestSource": self.request_source,
            "legs": [leg.to_payload() for leg in self.legs],
        }
        if self.account:
            payload["account"] = self.account
        if self.pricing_note:
            payload["pricingNote"] = self.pricing_note
        if self.managed_mode:
            payload["managedMode"] = True
        if self.managed_state:
            payload["managedState"] = self.managed_state
        if self.working_limit_price is not None:
            payload["workingLimitPrice"] = self.working_limit_price
        if self.latest_combo_mid is not None:
            payload["latestComboMid"] = self.latest_combo_mid
        if self.repricing_count is not None:
            payload["repricingCount"] = self.repricing_count
        if self.last_reprice_at:
            payload["lastRepriceAt"] = self.last_reprice_at
        if self.managed_message:
            payload["managedMessage"] = self.managed_message
        if self.managed_reprice_threshold is not None:
            payload["managedRepriceThreshold"] = self.managed_reprice_threshold
        if self.managed_concession_ratio is not None:
            payload["managedConcessionRatio"] = self.managed_concession_ratio
        if self.best_combo_price is not None:
            payload["bestComboPrice"] = self.best_combo_price
        if self.worst_combo_price is not None:
            payload["worstComboPrice"] = self.worst_combo_price
        if self.price_increment is not None:
            payload["priceIncrement"] = self.price_increment
        if self.can_concede_pricing:
            payload["canConcedePricing"] = True
        if self.continue_action_label:
            payload["continueActionLabel"] = self.continue_action_label
        if self.close_plan_stage:
            payload["closePlanStage"] = self.close_plan_stage
        if self.close_plan_complete is not None:
            payload["closePlanComplete"] = self.close_plan_complete
        if self.close_plan_message:
            payload["closePlanMessage"] = self.close_plan_message
        if self.assignment_adjustments:
            payload["assignmentAdjustments"] = self.assignment_adjustments
        if self.staged_orders:
            payload["stagedOrders"] = self.staged_orders
        if self.close_plan_token:
            payload["closePlanToken"] = self.close_plan_token
        if self.close_plan_generated_at:
            payload["closePlanGeneratedAt"] = self.close_plan_generated_at
        if self.close_plan_expires_at:
            payload["closePlanExpiresAt"] = self.close_plan_expires_at
        if self.close_plan_legs:
            payload["closePlanLegs"] = self.close_plan_legs
        if self.close_plan_orders:
            payload["closePlanOrders"] = self.close_plan_orders
        if self.close_plan_adjustments:
            payload["closePlanAdjustments"] = self.close_plan_adjustments
        if self.what_if is not None:
            payload["whatIf"] = self.what_if
        return payload


@dataclass
class ComboSubmitResult:
    preview: ComboOrderPreview
    order_id: Optional[int]
    perm_id: Optional[int]
    status: Optional[str]
    status_message: Optional[str] = None
    tracking_legs: list[dict[str, Any]] = field(default_factory=list)
    # Live ib_async Trade handle for post-submit fill replay; never serialized.
    trade: Any = None

    def to_payload(self) -> dict[str, Any]:
        payload = self.preview.to_payload()
        payload.update({
            "orderId": self.order_id,
            "permId": self.perm_id,
            "status": self.status,
        })
        if self.status_message:
            payload["statusMessage"] = self.status_message
        return payload


@dataclass
class ComboValidationLeg:
    id: Optional[str]
    symbol: str
    local_symbol: str
    sec_type: str
    con_id: Optional[int]

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "symbol": self.symbol,
            "localSymbol": self.local_symbol,
            "secType": self.sec_type,
            "conId": self.con_id,
        }


@dataclass
class ComboValidationResult:
    group_id: Optional[str]
    group_name: str
    execution_mode: str
    valid: bool
    execution_intent: str = "open"
    request_source: str = "manual"
    legs: list[ComboValidationLeg] = field(default_factory=list)

    def to_payload(self) -> dict[str, Any]:
        return {
            "groupId": self.group_id,
            "groupName": self.group_name,
            "executionMode": self.execution_mode,
            "executionIntent": self.execution_intent,
            "requestSource": self.request_source,
            "valid": self.valid,
            "legs": [leg.to_payload() for leg in self.legs],
        }
