import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
import multiprocessing
import threading
from queue import Empty
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app import main as api
from app.schemas import PileProject
from app import project_files


def _save_in_process(path, content, started, output):
    started.set()
    try:
        project_files.save_project_file(Path(path), content)
        output.put('saved')
    except project_files.ProjectFileConflict:
        output.put('conflict')


class ProjectFileSafetyTests(unittest.TestCase):
    def test_concurrent_owners_cannot_share_a_successful_write(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(api, 'PROJECTS_DIR', Path(folder)), \
                patch.object(api, 'CONFIG_DIR', Path(folder) / 'config'):
            first, second = PileProject(), PileProject()
            first.project.name = second.project.name = 'Same name'
            entered, release = threading.Event(), threading.Event()
            write = project_files.atomic_write_project

            def pause_write(path, content):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError('test writer was not released')
                write(path, content)

            with patch.object(project_files, 'atomic_write_project', side_effect=pause_write), ThreadPoolExecutor(2) as pool:
                a = pool.submit(api.save_local_project, first)
                self.assertTrue(entered.wait(5))
                b = pool.submit(api.save_local_project, second)
                release.set()
                self.assertTrue(a.result(timeout=5).saved)
                with self.assertRaises(HTTPException) as error:
                    b.result(timeout=5)
                self.assertEqual(error.exception.status_code, 409)
            stored = json.loads((Path(folder) / 'Same_name.pilenum.json').read_text(encoding='utf-8'))
            self.assertEqual(stored['project']['id'], first.project.id)
            self.assertFalse(list(Path(folder).glob('*.tmp')))

    def test_file_lock_protects_against_another_process(self):
        context = multiprocessing.get_context('spawn')
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'shared.json'
            started, output = context.Event(), context.Queue()
            child = context.Process(target=_save_in_process,
                                    args=(str(path), '{"project":{"id":"other"}}', started, output))
            try:
                with project_files.project_file_lock(path):
                    child.start()
                    self.assertTrue(started.wait(60), 'Spawned interpreter did not reach the file-lock fixture')
                    self.assertTrue(child.is_alive())
                    with self.assertRaises(Empty):
                        output.get(timeout=0.2)
                    project_files.atomic_write_project(path, '{"project":{"id":"owner"}}')
                child.join(30)
                self.assertEqual(child.exitcode, 0)
                self.assertEqual(output.get(timeout=5), 'conflict')
                self.assertEqual(json.loads(path.read_text())['project']['id'], 'owner')
            finally:
                if child.is_alive():
                    child.terminate()
                    child.join(5)
                output.close()

    def test_bom_can_be_resaved_and_renaming_back_keeps_ownership(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(api, 'PROJECTS_DIR', Path(folder)), \
                patch.object(api, 'CONFIG_DIR', Path(folder) / 'config'):
            project = PileProject()
            project.project.name = 'A'
            path = Path(folder) / 'A.pilenum.json'
            path.write_text(project.model_dump_json(), encoding='utf-8-sig')
            self.assertTrue(api.save_local_project(project).saved)
            project.project.name = 'B'
            api.save_local_project(project)
            project.project.name = 'A'
            self.assertTrue(api.save_local_project(project).saved)
            self.assertEqual(json.loads(path.read_text())['project']['id'], project.project.id)
            path.write_text(project.model_dump_json(), encoding='utf-8-sig')
            project_files.save_project_file(path, project.model_dump_json())
            self.assertEqual(json.loads(path.read_text())['project']['id'], project.project.id)

    def test_unreadable_owner_and_failed_replace_preserve_original(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'field.json'
            path.write_text('not json', encoding='utf-8')
            with self.assertRaises(project_files.ProjectFileConflict):
                project_files.save_project_file(path, '{"project":{"id":"one"}}')
            self.assertEqual(path.read_text(), 'not json')
            path.write_text('{"project":{"id":"one"}}', encoding='utf-8')
            before = path.read_bytes()
            with patch.object(Path, 'replace', side_effect=OSError('disk full')):
                with self.assertRaises(OSError):
                    project_files.save_project_file(path, '{"project":{"id":"one"},"points":[1]}')
            self.assertEqual(path.read_bytes(), before)
            self.assertFalse(list(Path(folder).glob('*.tmp')))

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
                patch.object(api, 'os', SimpleNamespace(name='nt')), patch.object(api.subprocess, 'Popen') as open_explorer:
            target = Path(folder).resolve() / 'field.pilenum.json'
            target.write_text('{}', encoding='utf-8')
            result = api.open_local_project_location(target.name)
            self.assertTrue(result['opened'])
            open_explorer.assert_called_once_with(['explorer.exe', '/select,', str(target)])
            with self.assertRaises(HTTPException):
                api.open_local_project_location('missing.pilenum.json')

    def test_project_with_spaces_and_bom_opens_from_lists_without_renaming(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(api, 'PROJECTS_DIR', Path(folder) / 'projects'), \
                patch.object(api, 'CONFIG_DIR', Path(folder) / 'config'):
            api.PROJECTS_DIR.mkdir()
            project = PileProject()
            project.project.name = 'Новый проект'
            path = api.PROJECTS_DIR / 'Новый проект.pilenum.json'
            path.write_text(project.model_dump_json(), encoding='utf-8-sig')
            before = path.read_bytes()
            opened = api.open_local_project(path.name)
            self.assertEqual(opened.project.id, project.project.id)
            recent = api.list_recent_project_entries()['projects']
            self.assertEqual(recent[0]['fileName'], path.name)
            self.assertEqual(api.open_recent_project(recent[0]['id']).project.id, project.project.id)
            self.assertEqual(path.read_bytes(), before)
            self.assertFalse((api.PROJECTS_DIR / 'Новый_проект.pilenum.json').exists())
            for invalid in ('../Новый проект.pilenum.json', 'other\\project.pilenum.json'):
                with self.assertRaises(HTTPException):
                    api.open_local_project(invalid)


if __name__ == '__main__':
    unittest.main()
