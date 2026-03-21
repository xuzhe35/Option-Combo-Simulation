from abc import ABC, abstractmethod


class BrokerExecutionAdapter(ABC):
    @abstractmethod
    async def validate_combo_order(self, websocket, request):
        raise NotImplementedError

    @abstractmethod
    async def preview_combo_order(self, websocket, request):
        raise NotImplementedError

    @abstractmethod
    async def submit_combo_order(self, websocket, request):
        raise NotImplementedError

    async def resume_managed_combo_order(self, websocket, raw_data):
        raise NotImplementedError

    async def concede_managed_combo_order(self, websocket, raw_data):
        raise NotImplementedError

    async def cancel_managed_combo_order(self, websocket, raw_data):
        raise NotImplementedError

    def get_managed_order_snapshot(self, order_id, perm_id):
        return None

    def cancel_managed_for_websocket(self, websocket):
        return None
