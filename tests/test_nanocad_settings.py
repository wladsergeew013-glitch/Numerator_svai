"""Version preference persists and controls attachment to running CAD instances."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app import main as api
from app.schemas import UserConfig
from fastapi import HTTPException


class NanoCadSettingsTests(unittest.TestCase):
    def setUp(self):
        folder = self.enterContext(tempfile.TemporaryDirectory())
        config_dir = Path(folder) / 'config'
        self.enterContext(patch.object(api, 'CONFIG_DIR', config_dir))
        self.enterContext(patch.object(api, 'USER_CONFIG_PATH', config_dir / 'user_config.json'))
        self.enterContext(patch.dict(api.os.environ, {
            'PILE_NUMBERING_NANOCAD_VERSION': '',
            'PILE_NUMBERING_NANOCAD_PROGID': '',
        }))

    def test_legacy_config_keeps_automatic_order_and_other_settings(self):
        api.CONFIG_DIR.mkdir()
        api.USER_CONFIG_PATH.write_text(json.dumps({
            'commandIcons': {'open': '/custom.png'},
            'gridSettings': {'majorStep': 500},
            'autosaveSettings': {'enabled': True, 'intervalMinutes': 12},
        }), encoding='utf-8')
        config = api.get_user_config()
        self.assertEqual(config.nanoCadVersion, 'auto')
        self.assertEqual(api._nanocad_progid_candidates()[0], 'nanoCADx64.Application.25.0')
        api.save_user_config(config.model_copy(update={'nanoCadVersion': '26'}))
        loaded = api.get_user_config()
        self.assertEqual(loaded.nanoCadVersion, '26')
        self.assertEqual(loaded.commandIcons, {'open': '/custom.png'})
        self.assertEqual(loaded.gridSettings['majorStep'], 500)
        self.assertEqual(loaded.autosaveSettings.intervalMinutes, 12)
        api.save_user_config(UserConfig(toolbarHeight=110))
        self.assertEqual(api.get_user_config().nanoCadVersion, '26')

    def test_selected_26_attaches_before_another_running_version(self):
        api.save_user_config(UserConfig(nanoCadVersion='26'))
        document = SimpleNamespace(ModelSpace=object())
        running = SimpleNamespace(ActiveDocument=document)
        client = SimpleNamespace(GetActiveObject=Mock(return_value=running), Dispatch=Mock())
        with patch.dict(sys.modules, {
            'pythoncom': SimpleNamespace(),
            'win32com': SimpleNamespace(client=client),
            'win32com.client': client,
        }):
            result = api._connect_nanocad()
        self.assertIs(result[0], running)
        client.GetActiveObject.assert_called_once_with('nanoCADx64.Application.26.0')
        client.Dispatch.assert_not_called()

    def test_selected_26_warns_instead_of_attaching_to_running_25(self):
        api.save_user_config(UserConfig(nanoCadVersion='26'))
        running = SimpleNamespace(ActiveDocument=SimpleNamespace(ModelSpace=object()))
        client = SimpleNamespace(GetActiveObject=Mock(), Dispatch=Mock())

        def get_active(progid):
            if progid == 'nanoCADx64.Application.25.0':
                return running
            raise RuntimeError('No running instance')

        client.GetActiveObject.side_effect = get_active
        with patch.dict(sys.modules, {
            'pythoncom': SimpleNamespace(),
            'win32com': SimpleNamespace(client=client),
            'win32com.client': client,
        }):
            with self.assertRaises(HTTPException) as failure:
                api._connect_nanocad()
        self.assertEqual(failure.exception.detail['code'], 'nanocad_connection_unavailable')
        self.assertEqual(failure.exception.detail['version'], '26')
        self.assertIn('nanoCAD 26', failure.exception.detail['message'])
        self.assertNotIn('nanoCADx64.Application.25.0', [call.args[0] for call in client.GetActiveObject.call_args_list])
        self.assertEqual(client.GetActiveObject.call_args_list[0].args[0], 'nanoCADx64.Application.26.0')
        client.Dispatch.assert_not_called()

    def test_auto_still_attaches_to_running_25(self):
        running = SimpleNamespace(ActiveDocument=SimpleNamespace(ModelSpace=object()))
        client = SimpleNamespace(GetActiveObject=Mock(return_value=running))
        with patch.dict(sys.modules, {
            'pythoncom': SimpleNamespace(), 'win32com': SimpleNamespace(client=client), 'win32com.client': client,
        }):
            self.assertIs(api._connect_nanocad()[0], running)
        client.GetActiveObject.assert_called_once_with('nanoCADx64.Application.25.0')

    def test_rot_filters_other_versions_and_accepts_selected_version(self):
        other = SimpleNamespace(Version='25.0', ActiveDocument=SimpleNamespace(ModelSpace=object()))
        selected = SimpleNamespace(Version='26.0 (build 123)', ActiveDocument=SimpleNamespace(ModelSpace=object()))
        monikers = [SimpleNamespace(GetDisplayName=lambda *_: 'nanoCAD 25'),
                    SimpleNamespace(GetDisplayName=lambda *_: 'nanoCAD 26')]
        for objects, expected in (([other, selected], selected), ([other], None)):
            with self.subTest(expected=expected):
                enum = SimpleNamespace(Next=Mock(side_effect=[[item] for item in monikers[:len(objects)]] + [[]]))
                rot = SimpleNamespace(EnumRunning=lambda: enum, GetObject=Mock(side_effect=objects))
                com = SimpleNamespace(GetRunningObjectTable=lambda: rot, CreateBindCtx=lambda *_: None)
                client = SimpleNamespace(Dispatch=lambda obj: obj)
                result, _ = api._find_running_nanocad_from_rot(com, client, '26')
                self.assertIs(result[0] if result else None, expected)

    def test_existing_environment_overrides_still_take_priority(self):
        api.save_user_config(UserConfig(nanoCadVersion='26'))
        with patch.dict(api.os.environ, {
            'PILE_NUMBERING_NANOCAD_VERSION': '24.0',
            'PILE_NUMBERING_NANOCAD_PROGID': 'custom.nanoCAD.Application',
        }):
            candidates = api._nanocad_progid_candidates()
        self.assertEqual(candidates[0], 'custom.nanoCAD.Application')
        self.assertEqual(candidates[1], 'nanoCADx64.Application.24.0')
        self.assertNotIn('nanoCADx64.Application.26.0', candidates)


if __name__ == '__main__':
    unittest.main()
