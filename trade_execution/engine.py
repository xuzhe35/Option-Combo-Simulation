import logging

from trade_execution.models import ComboOrderRequest


class ExecutionEngine:
    def __init__(self, adapter, logger=None, on_submit_result=None):
        self.adapter = adapter
        self.logger = logger or logging.getLogger(__name__)
        self.on_submit_result = on_submit_result

    def _build_error_payload(self, group_id, message, request_action=None, execution_intent=None, request_source=None):
        payload = {
            "action": "combo_order_error",
            "groupId": group_id,
            "message": message,
            "requestAction": request_action,
        }
        if execution_intent:
            payload["executionIntent"] = execution_intent
        if request_source:
            payload["requestSource"] = request_source
        return payload

    def _build_resume_payload(self, group_id, snapshot):
        return {
            "action": "combo_order_resume_result",
            "groupId": group_id,
            "orderStatus": snapshot,
        }

    def _build_cancel_payload(self, group_id, snapshot):
        return {
            "action": "combo_order_cancel_result",
            "groupId": group_id,
            "orderStatus": snapshot,
        }

    def _build_concede_payload(self, group_id, snapshot):
        return {
            "action": "combo_order_concede_result",
            "groupId": group_id,
            "orderStatus": snapshot,
        }

    def _log_request_received(self, client_ip, raw_data):
        legs = raw_data.get("legs") or []
        self.logger.info(
            f"Received {raw_data.get('action')} from {client_ip}: "
            f"groupId={raw_data.get('groupId')} groupName={raw_data.get('groupName')!r} "
            f"underlying={raw_data.get('underlyingSymbol')} executionMode={raw_data.get('executionMode')} "
            f"account={raw_data.get('account') or ''} "
            f"executionIntent={raw_data.get('executionIntent') or raw_data.get('intent')} "
            f"requestSource={raw_data.get('requestSource') or raw_data.get('source')} "
            f"legs={len(legs)}"
        )
        for index, leg in enumerate(legs, start=1):
            self.logger.info(
                f"  leg#{index}: id={leg.get('id')} secType={leg.get('secType')} symbol={leg.get('symbol')} "
                f"right={leg.get('right')} strike={leg.get('strike')} exp={leg.get('expDate')} pos={leg.get('pos')} "
                f"exchange={leg.get('exchange')} underlyingContractMonth={leg.get('underlyingContractMonth')}"
            )

    def get_managed_order_snapshot(self, order_id, perm_id):
        if hasattr(self.adapter, "get_managed_order_snapshot"):
            return self.adapter.get_managed_order_snapshot(order_id, perm_id)
        return None

    def cancel_managed_for_websocket(self, websocket):
        if hasattr(self.adapter, "cancel_managed_for_websocket"):
            self.adapter.cancel_managed_for_websocket(websocket)

    async def handle_combo_action(self, websocket, raw_data, client_ip="Unknown"):
        if not isinstance(raw_data, dict):
            return self._build_error_payload(None, "Invalid combo order payload.", None)

        action = raw_data.get("action")
        if action not in ("validate_combo_order", "preview_combo_order", "submit_combo_order", "resume_managed_combo_order", "concede_managed_combo_order", "cancel_managed_combo_order"):
            return None

        if action not in ("resume_managed_combo_order", "concede_managed_combo_order", "cancel_managed_combo_order"):
            self._log_request_received(client_ip, raw_data)

        try:
            if action == "resume_managed_combo_order":
                snapshot = await self.adapter.resume_managed_combo_order(websocket, raw_data)
                payload = self._build_resume_payload(raw_data.get("groupId"), snapshot)
                self.logger.info(
                    f"Resume response sent to {client_ip}: "
                    f"groupId={raw_data.get('groupId')} action={payload.get('action')}"
                )
                return payload

            if action == "concede_managed_combo_order":
                snapshot = await self.adapter.concede_managed_combo_order(websocket, raw_data)
                payload = self._build_concede_payload(raw_data.get("groupId"), snapshot)
                self.logger.info(
                    f"Concede response sent to {client_ip}: "
                    f"groupId={raw_data.get('groupId')} action={payload.get('action')}"
                )
                return payload

            if action == "cancel_managed_combo_order":
                snapshot = await self.adapter.cancel_managed_combo_order(websocket, raw_data)
                payload = self._build_cancel_payload(raw_data.get("groupId"), snapshot)
                self.logger.info(
                    f"Cancel response sent to {client_ip}: "
                    f"groupId={raw_data.get('groupId')} action={payload.get('action')}"
                )
                return payload

            request = ComboOrderRequest.from_payload(raw_data)
        except Exception as exc:
            self.logger.exception("Failed to parse combo order request")
            return self._build_error_payload(
                raw_data.get("groupId"),
                str(exc),
                action,
                raw_data.get("executionIntent") or raw_data.get("intent"),
                raw_data.get("requestSource") or raw_data.get("source"),
            )

        try:
            if action == "validate_combo_order":
                validation = await self.adapter.validate_combo_order(websocket, request)
                payload = {
                    "action": "combo_order_validation_result",
                    "groupId": request.group_id,
                    "validation": validation.to_payload(),
                }
                self.logger.info(
                    f"Validation response sent to {client_ip}: "
                    f"groupId={request.group_id} action={payload.get('action')}"
                )
                return payload

            if action == "preview_combo_order":
                preview = await self.adapter.preview_combo_order(websocket, request)
                payload = {
                    "action": "combo_order_preview_result",
                    "groupId": request.group_id,
                    "preview": preview.to_payload(),
                }
                self.logger.info(
                    f"Preview response sent to {client_ip}: "
                    f"groupId={request.group_id} action={payload.get('action')}"
                )
                return payload

            result = await self.adapter.submit_combo_order(websocket, request)
            payload = {
                "action": "combo_order_submit_result",
                "groupId": request.group_id,
                "order": result.to_payload(),
            }
            if callable(self.on_submit_result):
                try:
                    self.on_submit_result(websocket, request, result)
                except Exception:
                    self.logger.exception("Failed to record submitted combo order for status tracking")
            self.logger.info(
                f"Submit response sent to {client_ip}: "
                f"groupId={request.group_id} action={payload.get('action')} "
                f"status={(payload.get('order') or {}).get('status')}"
            )
            return payload
        except Exception as exc:
            self.logger.exception(f"Combo {action} failed for {client_ip}")
            return self._build_error_payload(
                request.group_id,
                str(exc),
                action,
                request.execution_intent,
                request.request_source,
            )
