import pathlib
import sys
import unittest
from types import SimpleNamespace


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


from trade_execution.order_tracking import (
    coerce_int_or_none,
    extract_trade_status_message,
    format_ib_order_error_message,
    infer_ib_order_error_status,
    record_order_error,
    resolve_tracking,
    update_tracking_snapshot,
)


class OrderTrackingHelpersTests(unittest.TestCase):
    def test_extract_trade_status_message_prefers_latest_message_and_code(self):
        trade = SimpleNamespace(
            log=[
                SimpleNamespace(message='older message', errorCode=''),
                SimpleNamespace(message='route rejected', errorCode=201),
            ],
            advancedError='',
        )

        self.assertEqual(
            extract_trade_status_message(trade),
            'IB 201: route rejected',
        )

    def test_resolve_tracking_refreshes_both_maps(self):
        tracking = {'orderId': 7, 'permId': 9}
        by_order_id = {7: tracking}
        by_perm_id = {}

        resolved = resolve_tracking(by_order_id, by_perm_id, 7, 9)

        self.assertIs(resolved, tracking)
        self.assertIs(by_perm_id[9], tracking)

    def test_update_tracking_snapshot_applies_shared_and_order_specific_fields(self):
        tracking = {}
        order = SimpleNamespace(
            account='DU12345',
            orderId=7001,
            action='SELL',
            totalQuantity=3,
            orderType='LMT',
            lmtPrice=481.25,
            tif='DAY',
        )
        order_status = SimpleNamespace(
            permId=9001,
            status='Submitted',
            filled=0.0,
            remaining=3.0,
            avgFillPrice=0.0,
            lastFillPrice=0.0,
            whyHeld='',
            mktCapPrice=0.0,
        )

        update_tracking_snapshot(
            tracking,
            order=order,
            order_status=order_status,
            status_message='Submitted to IB',
            order_field_mappings=(
                ('action', 'orderAction'),
                ('totalQuantity', 'quantity'),
                ('orderType', 'orderType'),
                ('lmtPrice', 'limitPrice'),
                ('tif', 'timeInForce'),
            ),
        )

        self.assertEqual(tracking['account'], 'DU12345')
        self.assertEqual(tracking['orderId'], 7001)
        self.assertEqual(tracking['permId'], 9001)
        self.assertEqual(tracking['orderAction'], 'SELL')
        self.assertEqual(tracking['quantity'], 3)
        self.assertEqual(tracking['orderType'], 'LMT')
        self.assertEqual(tracking['limitPrice'], 481.25)
        self.assertEqual(tracking['timeInForce'], 'DAY')
        self.assertEqual(tracking['statusMessage'], 'Submitted to IB')

    def test_record_order_error_updates_message_and_implied_status(self):
        tracking = {'status': 'Submitted'}

        message = record_order_error(tracking, 202, 'Order cancelled by user')

        self.assertEqual(message, 'IB 202: Order cancelled by user')
        self.assertEqual(tracking['status'], 'Cancelled')
        self.assertEqual(tracking['statusMessage'], 'IB 202: Order cancelled by user')

    def test_numeric_and_status_helpers_match_expected_behavior(self):
        self.assertEqual(coerce_int_or_none('42'), 42)
        self.assertIsNone(coerce_int_or_none('abc'))
        self.assertEqual(format_ib_order_error_message(201, 'Reject<br>details'), 'IB 201: Reject details')
        self.assertEqual(infer_ib_order_error_status(201, 'Submitted'), 'Inactive')


if __name__ == '__main__':
    unittest.main()
