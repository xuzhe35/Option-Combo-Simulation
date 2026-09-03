import ast
import configparser
from pathlib import Path
import unittest

from tws_timezone import read_tws_timezone


class TwsTimezoneTests(unittest.TestCase):
    def configured(self, name):
        config = configparser.ConfigParser()
        config.read_dict({'tws': {'timezone': name}})
        return config

    def test_multiple_operator_timezones_are_valid_without_repo_config(self):
        for name in ('America/New_York', 'Asia/Shanghai', 'Europe/London', 'UTC'):
            with self.subTest(name=name):
                self.assertEqual(read_tws_timezone(self.configured(f' {name} ')), name)

    def test_invalid_names_and_paths_fail_before_decoder_assignment(self):
        for name in ('Not/A_Timezone', '/etc/localtime', '../UTC', 'America/NewYork'):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, r'Invalid \[tws\] timezone'):
                    read_tws_timezone(self.configured(name))

    def test_missing_setting_never_guesses_machine_clock(self):
        self.assertEqual(read_tws_timezone(configparser.ConfigParser()), '')
        self.assertEqual(read_tws_timezone(self.configured('   ')), '')

    def test_startup_validates_before_ib_construction_and_sets_before_connect(self):
        source = (Path(__file__).resolve().parents[1] / 'ib_server.py').read_text()
        tree = ast.parse(source)
        statements = [ast.unparse(node) for node in tree.body]
        validated = statements.index('TWS_TIMEZONE = read_tws_timezone(config)')
        constructed = statements.index('ib = IB()')
        assigned = statements.index('ib.TimezoneTWS = TWS_TIMEZONE')
        self.assertLess(validated, constructed)
        self.assertLess(constructed, assigned)
        self.assertNotIn('connect', '\n'.join(statements[constructed:assigned]))


if __name__ == '__main__':
    unittest.main()
