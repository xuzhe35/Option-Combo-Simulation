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

    def test_all_broker_routing_fields_are_payload_bound(self):
        authorizer = ExecutionPlanAuthorizer(ttl_seconds=60)
        websocket = object()
        hedge = {
            'account': 'DU1', 'hedgeId': 'dh', 'secType': 'FUT', 'symbol': 'ES',
            'exchange': 'CME', 'currency': 'USD', 'contractMonth': '202609',
            'multiplier': '50', 'orderAction': 'SELL', 'quantity': 1,
            'orderType': 'LMT', 'limitPrice': 5500, 'timeInForce': 'DAY',
            'executionMode': 'submit', 'requestSource': 'delta_hedge_manual',
        }
        combo = {
            'account': 'DU1', 'groupId': 'g1', 'underlyingSymbol': 'ES',
            'underlyingContractMonth': '202609', 'executionMode': 'submit',
            'executionIntent': 'open', 'requestSource': 'manual',
            'profile': {'priceIncrement': 0.05},
            'legs': [{
                'id': 'l1', 'secType': 'FOP', 'symbol': 'ES',
                'underlyingSymbol': 'ES', 'exchange': 'CME',
                'underlyingExchange': 'CME', 'currency': 'USD',
                'multiplier': '50', 'underlyingMultiplier': '50',
                'tradingClass': 'EW3', 'underlyingContractMonth': '202609',
                'expDate': '20260918', 'right': 'C', 'strike': 5500,
                'pos': 1, 'observedBid': 10, 'observedAsk': 11,
            }],
        }
        changes = (
            ('hedge', hedge, {'timeInForce': 'GTC'}),
            ('hedge', hedge, {'currency': 'EUR'}),
            ('combo', combo, {'profile': {'priceIncrement': 0.25}}),
            ('combo', combo, {
                'legs': [{**combo['legs'][0], 'exchange': 'SMART'}],
            }),
            ('combo', combo, {
                'legs': [{**combo['legs'][0], 'multiplier': '5'}],
            }),
        )
        for kind, payload, changed in changes:
            plan = authorizer.register(websocket, kind, payload, 'positions-v1')
            with self.subTest(kind=kind, changed=changed):
                with self.assertRaisesRegex(ValueError, 'Order changed'):
                    authorizer.validate_and_consume(
                        websocket,
                        kind,
                        {**payload, **changed, 'executionPlanToken': plan['executionPlanToken']},
                        'positions-v1',
                    )


if __name__ == '__main__':
    unittest.main()
