import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app import main as api
from app.schemas import PileProject


class ProjectFileSafetyTests(unittest.TestCase):
    def test_name_collision_preserves_other_project_and_allows_own_resave(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(api, 'PROJECTS_DIR', Path(folder) / 'projects'), \
                patch.object(api, 'CONFIG_DIR', Path(folder) / 'config'):
            first = PileProject(points=[])
            first.project.name = 'Свайное поле'
            api.save_local_project(first)
            path = Path(folder) / 'projects' / 'Свайное_поле.pilenum.json'
            original = path.read_bytes()
            second = PileProject(points=[])
            second.project.name = first.project.name
            with self.assertRaises(HTTPException) as error:
                api.save_local_project(second)
            self.assertEqual(error.exception.status_code, 409)
            self.assertEqual(path.read_bytes(), original)
            first.project.fileName = path.name
            api.save_local_project(first)
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['project']['id'], first.project.id)

    def test_recent_projects_track_open_order_and_reopen_by_id(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(api, 'PROJECTS_DIR', Path(folder) / 'projects'), \
                patch.object(api, 'CONFIG_DIR', Path(folder) / 'config'):
            first = PileProject(points=[])
            first.project.name = 'Первый'
            second = PileProject(points=[])
            second.project.name = 'Второй'
            first_name = api.save_local_project(first).fileName
            second_name = api.save_local_project(second).fileName
            self.assertEqual([item['fileName'] for item in api.list_recent_project_entries()['projects']], [second_name, first_name])
            api.open_local_project(first_name)
            recent = api.list_recent_project_entries()['projects']
            self.assertEqual([item['fileName'] for item in recent], [first_name, second_name])
            self.assertEqual(api.open_recent_project(recent[0]['id']).project.name, 'Первый')
            with self.assertRaises(HTTPException) as error:
                api.open_recent_project('unknown')
            self.assertEqual(error.exception.status_code, 404)

    def test_location_selects_requested_file_without_opening_another_path(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(api, 'PROJECTS_DIR', Path(folder)), \
                patch.object(api.os, 'name', 'nt'), patch.object(api.subprocess, 'Popen') as open_explorer:
            target = Path(folder) / 'field.pilenum.json'
            target.write_text('{}', encoding='utf-8')
            result = api.open_local_project_location(target.name)
            self.assertTrue(result['opened'])
            open_explorer.assert_called_once_with(['explorer.exe', '/select,', str(target)])
            with self.assertRaises(HTTPException):
                api.open_local_project_location('missing.pilenum.json')


if __name__ == '__main__':
    unittest.main()
