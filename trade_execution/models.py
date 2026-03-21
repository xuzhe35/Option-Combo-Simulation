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
        )


@dataclass
class ComboOrderRequest:
    group_id: Optional[str]
    group_name: str
    underlying_symbol: str
    underlying_contract_month: str
    execution_mode: str
    execution_intent: str = "open"
    request_source: str = "manual"
    managed_reprice_threshold: Optional[float] = None
    time_in_force: str = "DAY"
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
            execution_intent=str(payload.get("executionIntent") or payload.get("intent") or "open"),
            request_source=str(payload.get("requestSource") or payload.get("source") or "manual"),
            managed_reprice_threshold=_parse_optional_float(
                payload.get("managedRepriceThreshold") or payload.get("managed_reprice_threshold")
            ),
            time_in_force=str(payload.get("timeInForce") or payload.get("time_in_force") or "DAY").upper(),
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
    can_concede_pricing: bool = False
    continue_action_label: Optional[str] = None
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
        if self.can_concede_pricing:
            payload["canConcedePricing"] = True
        if self.continue_action_label:
            payload["continueActionLabel"] = self.continue_action_label
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
