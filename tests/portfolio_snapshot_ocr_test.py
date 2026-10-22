import base64
import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location('snapshot_preview', Path(__file__).resolve().parents[1] / 'scripts/portfolio_snapshot_ocr_server.py')
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class PreviewBoundaries(unittest.TestCase):
    def test_review_crop_requests_use_an_explicit_bounded_catalogue(self):
        for field in ('descriptionRow', 'avgPrice', 'dailyPnl', 'mark', 'costBasis', 'unrealizedPnl', 'deltaDollars', 'marketValue', 'theta', 'lastPrice', 'displayIv'):
            self.assertEqual(SERVER.validate_crops([{'field':field,'cropBbox':[.1,.2,.1,.02]}], review=True)[0]['field'],field)
        for crops in ([], [{'field':'quantity','cropBbox':[.1,.2,.1,.02]}], [{'field':'avgPrice','cropBbox':[.1,.2,0,.02]}], [{'field':'descriptionRow','cropBbox':[.1,.99,.1,.02]}], [{'field':'avgPrice','cropBbox':[True,.2,.1,.02]}], [{'field':'dailyPnl','cropBbox':[.1,float('nan'),.1,.02]}], [{'field':'avgPrice','cropBbox':[.1,.2,.1,.02]}]*1025):
            with self.assertRaises(SERVER.OcrError): SERVER.validate_crops(crops, review=True)
    def test_crop_requests_are_bounded_and_quantity_only(self):
        self.assertEqual(SERVER.validate_crops([{'field': 'quantity', 'cropBbox': [.4,.2,.1,.02]}])[0]['field'], 'quantity')
        for crops in ([], [{}], [{'field':'quantity','cropBbox':[.9,.1,.2,.2]}], [{'field':'symbol','cropBbox':[.4,.2,.1,.02]}], [{'field':'quantity','cropBbox':[float('nan'),.1,.2,.2]}]):
            with self.assertRaises(SERVER.OcrError):
                SERVER.validate_crops(crops)
    def test_private_images_and_existing_databases_are_not_static_assets(self):
        self.assertNotIn('Portfolio SC/20261020.jpg', SERVER.ASSETS)
        self.assertNotIn('cost_basis.db', SERVER.ASSETS)
        self.assertNotIn('config.local.ini', SERVER.ASSETS)

    def test_loopback_and_dns_rebinding_boundary(self):
        for host in ('localhost', '127.0.0.1', '::1'):
            self.assertTrue(SERVER.loopback(host))
        for host in ('example.com', '192.168.0.1', None):
            self.assertFalse(SERVER.loopback(host))

    def test_file_and_remote_origins_remain_rejected(self):
        for origin, allowed in ((None, True), ('http://127.0.0.1:8798', True),
                                ('null', False), ('file://', False), ('https://example.com', False)):
            headers = {'Host': '127.0.0.1:8798'}
            if origin is not None:
                headers['Origin'] = origin
            handler = SimpleNamespace(client_address=('127.0.0.1', 12345), headers=headers)
            self.assertEqual(SERVER.Handler.peer_allowed(handler), allowed, origin)

    def test_image_content_validation_does_not_trust_a_filename(self):
        with self.assertRaises(SERVER.OcrError):
            SERVER.decode_image({'image': base64.b64encode(b'not an image').decode()})
        with self.assertRaises(SERVER.OcrError):
            SERVER.decode_image({'image': '!!!'})
        image, suffix = SERVER.decode_image({'image': base64.b64encode(b'\x89PNG\r\n\x1a\n').decode()})
        self.assertEqual(suffix, '.png')


if __name__ == '__main__':
    unittest.main()
