import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app import sdk_bridge as sdk
from sdk_lisp_host import LispHost


class SelectionTransportTests(unittest.TestCase):
    def channel(self, handles, **options):
        host = LispHost(handles, **options)
        document = SimpleNamespace(FullName='C:/selected.dwg', SendCommand=host.send)
        return sdk.SdkChannel(document), host

    def test_selection_survives_loader_command_and_repeated_scan(self):
        channel, host = self.channel(['A', '2B', 'FF'])
        with patch.object(sdk, 'plugin_path', return_value=Path('C:/SDK/PileNumbering.Sdk26.123456abcdef.nrx')):
            for _ in range(2):
                result = channel.call('scan', scope='selection')
                self.assertEqual([item['handle'] for item in result['objects']], ['A', '2B', 'FF'])
                self.assertEqual(host.selection, ['A', '2B', 'FF'])
        self.assertEqual(host.request_count, 2)
        self.assertEqual(host.events[:2], [('open', '.selection'), ('load', ('A', '2B', 'FF'))])
        self.assertIn(('command', ()), host.events, 'Host deliberately clears PICKFIRST before the SDK reads it')
        self.assertEqual(host.events[-2:], [('restore', ('A', '2B', 'FF')), ('open', '.completed')])

    def test_empty_current_selection_never_reuses_previous_selection(self):
        channel, host = self.channel(['A'])
        with patch.object(sdk, 'plugin_path', return_value=Path('C:/SDK/PileNumbering.Sdk26.nrx')):
            self.assertEqual(len(channel.call('scan', scope='selection')['objects']), 1)
            host.selection = []
            self.assertEqual(channel.call('scan', scope='selection')['objects'], [])
        self.assertEqual(host.selection, [])

    def test_selection_stays_restored_even_if_reading_pickfirst_consumes_it(self):
        channel, host = self.channel(['A', '2B'], consume_implied=True)
        with patch.object(sdk, 'plugin_path', return_value=Path('C:/SDK/PileNumbering.Sdk26.nrx')):
            self.assertEqual(len(channel.call('scan', scope='selection')['objects']), 2)
        self.assertEqual(host.selection, ['A', '2B'])

    def test_selection_is_restored_after_native_error(self):
        channel, host = self.channel(['A'], native_error=True)
        with patch.object(sdk, 'plugin_path', return_value=Path('C:/SDK/PileNumbering.Sdk26.nrx')):
            with self.assertRaises(sdk.SdkBridgeError):
                channel.call('scan', scope='selection')
        self.assertEqual(host.selection, ['A'])
        self.assertEqual(host.request_count, 1)

    def test_full_scan_and_identity_lookup_also_preserve_user_selection(self):
        channel, host = self.channel(['A'])
        with patch.object(sdk, 'plugin_path', return_value=Path('C:/SDK/PileNumbering.Sdk26.nrx')):
            channel.call('identify')
            channel.call('scan', scope='all')
        self.assertEqual(host.selection, ['A'])
        self.assertNotIn(('open', '.selection'), host.events)


if __name__ == '__main__':
    unittest.main()
