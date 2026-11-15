"""Persistent workspace contracts, using isolated backend files."""
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app import main as api
from app.runtime_paths import RuntimePaths
from app.schemas import UserConfigPatch, ViewSettings


class WorkspaceConfigTests(unittest.TestCase):
    def setUp(self):
        folder = self.enterContext(tempfile.TemporaryDirectory())
        for key, value in RuntimePaths(Path(folder)).globals().items():
            self.enterContext(patch.object(api, key, value))

    def test_fresh_defaults_and_old_config_are_compatible(self):
        self.assertFalse(ViewSettings().highlightUnnumbered)
        self.assertEqual(api.get_user_config().workspace.windows, {})
        api.save_user_config(UserConfigPatch(viewSettings={'highlightUnnumbered': True}, groupManagerVisible=True))
        saved = api.get_user_config()
        self.assertTrue(saved.groupManagerVisible)
        self.assertTrue(saved.viewSettings['highlightUnnumbered'])

    def test_partial_panel_and_workspace_writes_preserve_other_settings(self):
        api.save_user_config(UserConfigPatch.model_validate({
            'workspace': {'windows': {'settings': True, 'journal': True}, 'tabs': {'settings-tab': 'grid'}, 'lists': {'dock-order': ['journal','settings']}},
            'panels': {'settings': {'x': -450, 'y': 180, 'width': 530, 'height': 620, 'dock': 'right', 'detached': True}},
            'nanoCadVersion': '26', 'autosaveSettings': {'enabled': True, 'intervalMinutes': 7}}))
        patches = [
            {'workspace': {'windows': {'journal': False}}},
            {'workspace': {'tabs': {'ribbon-density': 'comfortable'}}},
            {'panels': {'settings': {'x': -300}}},
            {'toolbarHeight': 190}]
        with ThreadPoolExecutor(4) as pool:
            list(pool.map(lambda payload: api.save_user_config(UserConfigPatch.model_validate(payload)), patches))
        saved = api.get_user_config()  # A fresh read from disk, no frontend cache.
        self.assertTrue(saved.workspace.windows['settings'])
        self.assertFalse(saved.workspace.windows['journal'])
        self.assertEqual(saved.workspace.tabs['settings-tab'], 'grid')
        self.assertEqual(saved.workspace.lists['dock-order'], ['journal','settings'])
        self.assertTrue(saved.panels['settings'].detached)
        self.assertEqual(saved.panels['settings'].width, 530)
        self.assertEqual(saved.panels['settings'].x, -300)
        self.assertEqual(saved.nanoCadVersion, '26')
        self.assertEqual(saved.autosaveSettings.intervalMinutes, 7)
