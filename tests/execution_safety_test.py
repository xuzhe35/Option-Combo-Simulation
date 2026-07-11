import unittest

from trade_execution.safety import ExecutionPlanAuthorizer


class ExecutionPlanAuthorizerTests(unittest.TestCase):
    def test_token_is_one_time_and_payload_bound(self):
        authorizer = ExecutionPlanAuthorizer(ttl_seconds=60)
        websocket = object()
        payload = {
            'account': 'DU1', 'hedgeId': 'dh', 'secType': 'STK', 'symbol': 'SPY',
            'orderAction': 'SELL', 'quantity': 5, 'orderType': 'LMT', 'limitPrice': 500,
        }
        plan = authorizer.register(websocket, 'hedge', payload, 'positions-v1')
        authorized = {**payload, 'executionPlanToken': plan['executionPlanToken']}
        authorizer.validate_and_consume(websocket, 'hedge', authorized, 'positions-v1')
        with self.assertRaisesRegex(ValueError, 'expired|already used'):
            authorizer.validate_and_consume(websocket, 'hedge', authorized, 'positions-v1')

    def test_changed_order_or_positions_are_rejected(self):
        authorizer = ExecutionPlanAuthorizer(ttl_seconds=60)
        websocket = object()
        payload = {'account': 'DU1', 'groupId': 'g1', 'executionIntent': 'open', 'legs': [{'id': 'l1', 'secType': 'STK', 'symbol': 'SPY', 'pos': 10}]}
        plan = authorizer.register(websocket, 'combo', payload, 'positions-v1')
        with self.assertRaisesRegex(ValueError, 'Order changed'):
            authorizer.validate_and_consume(websocket, 'combo', {**payload, 'legs': [{**payload['legs'][0], 'pos': 11}], 'executionPlanToken': plan['executionPlanToken']}, 'positions-v1')
        plan = authorizer.register(websocket, 'combo', payload, 'positions-v1')
        with self.assertRaisesRegex(ValueError, 'positions changed'):
            authorizer.validate_and_consume(websocket, 'combo', {**payload, 'executionPlanToken': plan['executionPlanToken']}, 'positions-v2')

    def test_combo_execution_settings_are_payload_bound(self):
        authorizer = ExecutionPlanAuthorizer(ttl_seconds=60)
        websocket = object()
        payload = {
            'account': 'DU1', 'groupId': 'g1', 'executionIntent': 'open',
            'timeInForce': 'GTC', 'managedRepriceThreshold': 0.02,
            'managedConcessionRatio': 0.2,
            'legs': [{'id': 'l1', 'secType': 'OPT', 'symbol': 'SPY', 'pos': 1}],
        }
        for changed in (
            {'timeInForce': 'DAY'},
            {'managedRepriceThreshold': 0.05},
            {'managedConcessionRatio': 0.0},
        ):
            plan = authorizer.register(websocket, 'combo', payload, 'positions-v1')
            with self.assertRaisesRegex(ValueError, 'Order changed'):
                authorizer.validate_and_consume(
                    websocket,
                    'combo',
                    {**payload, **changed, 'executionPlanToken': plan['executionPlanToken']},
                    'positions-v1',
                )


if __name__ == '__main__':
    unittest.main()
