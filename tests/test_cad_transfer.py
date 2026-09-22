"""COM contract regressions, run without nanoCAD: python -m unittest discover -s tests."""
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app import main as api, cad_operations as cad
from fastapi import HTTPException


class Collection:
    def __init__(self, items):
        self.items = items
        self.Count = len(items)
        self.reads = 0

    def Item(self, index):
        self.reads += 1
        return self.items[index]


class Parameters(Collection):
    def __init__(self, one_based=False, writable=True):
        super().__init__([SimpleNamespace(Name='OTHER', Value='x'), SimpleNamespace(Name='NUMBER', Value='old')])
        self.one_based = one_based
        self.writable = writable

    def Item(self, key):
        if isinstance(key, str):
            return next(p for p in self.items if p.Name == key)
        if self.one_based:
            if key == 0:
                raise IndexError(key)
            key -= 1
        return super().Item(key)

    def SetParameter(self, name, value, *args):
        if self.writable:
            self.Item(name).Value = value


def entity(handle, x=0):
    return SimpleNamespace(Handle=handle, Element=SimpleNamespace(Name='Pile', Parameters=Parameters()),
                           ObjectName='MDS', UnitPosition=(x, 0, 0))


class Document:
    FullName = 'C:/model.dwg'
    Name = 'model.dwg'

    def __init__(self, objects, selected=()):
        self.ModelSpace = Collection(objects)
        self.PickfirstSelectionSet = Collection(list(selected))
        self.lookup = {e.Handle: e for e in objects}
        self.regens = 0
        self.saves = 0

    def HandleToObject(self, handle):
        return self.lookup[handle]

    def Regen(self, mode):
        self.regens += 1

    def Save(self):
        self.saves += 1


def point(id, x, handle=None, document=Document.FullName):
    return {'id': id, 'x': x, 'y': 0, 'number': 7,
            'meta': {'cadHandle': handle, 'cadDocument': document, 'objectName': 'Pile'} if handle else {}}


class TransferTests(unittest.TestCase):
    def test_wrapped_routes_keep_request_body_contract(self):
        paths = api.app.openapi()['paths']
        for route in ('blocks/import', 'blocks/export', 'modelstudio/import', 'modelstudio/export'):
            self.assertIn('requestBody', paths[f'/api/nanocad/{route}']['post'])

    def setUp(self):
        self.logger = patch.object(cad, 'log_event', lambda *a, **k: None)
        self.logger.start()

    def tearDown(self):
        self.logger.stop()

    def export(self, doc, points, **kwargs):
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            return api.export_modelstudio_objects(api.NanoCadModelStudioExportRequest(
                numberParameter='NUMBER', points=points, **kwargs))

    def test_reads_last_parameter_in_one_based_collection(self):
        e = entity('A')
        e.Element.Parameters = Parameters(one_based=True)
        self.assertEqual(api._iter_modelstudio_parameters(e), {'OTHER': 'x', 'NUMBER': 'old'})

    def test_writes_last_parameter_without_named_item_access(self):
        class NumericOnly(Parameters):
            def Item(self, key):
                if isinstance(key, str):
                    raise TypeError('Numeric keys only')
                return super().Item(key)
        e = entity('A')
        e.Element.Parameters = NumericOnly(one_based=True)
        self.assertTrue(api._set_modelstudio_parameter(e, 'number', '91'))
        self.assertEqual(e.Element.Parameters.items[-1].Value, '91')

    def test_coordinate_match_does_not_write_different_object_type(self):
        doc = Document([entity('A')])
        p = point('p', 0)
        p['meta'] = {'objectName': 'Different type'}
        result = self.export(doc, [p], matchMode='coordinates')
        self.assertEqual(result['updated'], 0)
        self.assertEqual(result['unusedPoints'], 1)

    def test_handles_do_not_enumerate_modelspace(self):
        e = entity('A')
        doc = Document([e])
        result = self.export(doc, [point('p', 123, 'A')])
        self.assertEqual(result['updated'], 1)
        self.assertEqual(doc.ModelSpace.reads, 0)
        self.assertEqual(e.Element.Parameters.Item('NUMBER').Value, '7')
        self.assertEqual(doc.regens, 1)

    def test_hybrid_falls_back_only_for_unresolved_points(self):
        a, b = entity('A'), entity('B', 10)
        doc = Document([a, b])
        result = self.export(doc, [point('a', 0, 'A'), point('b', 10, 'DELETED')])
        self.assertEqual(result['updated'], 2)
        self.assertEqual(result['matched'], 2)
        self.assertEqual(result['unresolvedHandles'], 1)
        self.assertEqual(doc.ModelSpace.reads, 2)

    def test_selection_restricts_handles_and_coordinate_fallback(self):
        a, b = entity('A'), entity('B', 10)
        doc = Document([a, b], [b])
        result = self.export(doc, [point('a', 0, 'A'), point('b', 10)], scope='selection')
        self.assertEqual(result['updated'], 1)
        self.assertEqual(a.Element.Parameters.Item('NUMBER').Value, 'old')
        self.assertEqual(doc.ModelSpace.reads, 0)

    def test_empty_selection_does_not_fall_back_when_explicit(self):
        doc = Document([entity('A')])
        with self.assertRaises(HTTPException):
            self.export(doc, [point('p', 0)], scope='selection')
        self.assertEqual(doc.ModelSpace.reads, 0)

    def test_wrong_document_and_duplicate_handles_fail_before_writing(self):
        e = entity('A')
        doc = Document([e])
        for points, mode in [([point('a', 0, 'A', 'C:/wrong.dwg')], 'handles'),
                             ([point('a', 0, 'A'), point('b', 1, 'A')], 'auto')]:
            with self.assertRaises(HTTPException):
                self.export(doc, points, matchMode=mode)
            self.assertEqual(e.Element.Parameters.Item('NUMBER').Value, 'old')

    def test_failed_write_is_not_counted_as_updated(self):
        e = entity('A')
        doc = Document([e])
        with patch.object(api, '_set_modelstudio_parameter', return_value=False):
            result = self.export(doc, [point('a', 0)])
        self.assertEqual(result['updated'], 0)
        self.assertEqual(result['failedWrites'], 1)

    def test_optional_dwg_save_and_save_failure_preserve_write_result(self):
        doc = Document([entity('A')])
        result = self.export(doc, [point('a', 0)], saveDrawing=True)
        self.assertTrue(result['saved'])
        self.assertEqual(doc.saves, 1)
        with patch.object(doc, 'Save', side_effect=RuntimeError('read-only DWG')):
            result = self.export(doc, [point('a', 0)], saveDrawing=True)
        self.assertEqual(result['updated'], 1)
        self.assertFalse(result['saved'])
        self.assertIn('read-only', result['saveError'])

    def test_write_requires_readback(self):
        class ReadOnlyParameter:
            Name = 'NUMBER'
            Value = property(lambda self: 'old')
        e = entity('A')
        e.Element.Parameters = Parameters(writable=False)
        e.Element.Parameters.items[1] = ReadOnlyParameter()
        self.assertFalse(api._set_modelstudio_parameter(e, 'NUMBER', '7'))

    def test_import_can_skip_number_and_handle(self):
        e = entity('A')
        doc = Document([e], [e])
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            result = api.import_modelstudio_objects(api.NanoCadModelStudioImportRequest(
                selectedObjectParameters={'Pile': ''}, numberParameter='NUMBER', preserveHandles=False))
        self.assertEqual(len(result['points']), 1)
        self.assertIsNone(result['points'][0]['number'])
        self.assertNotIn('cadHandle', result['points'][0]['meta'])
        self.assertEqual(doc.ModelSpace.reads, 0)

    def test_import_handle_survives_project_serialization(self):
        e = entity('A')
        doc = Document([e])
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            result = api.import_modelstudio_objects(api.NanoCadModelStudioImportRequest())
        from app.schemas import PilePoint
        p = PilePoint.model_validate_json(PilePoint.model_validate(result['points'][0]).model_dump_json())
        self.assertEqual(p.meta['cadHandle'], 'A')
        self.assertEqual(p.meta['cadDocument'], doc.FullName)

    def test_job_collection_failure_and_busy_lock(self):
        entered, release = threading.Event(), threading.Event()
        def fail():
            entered.set()
            release.wait(3)
            class Broken:
                Count = 10
                def Item(self, index):
                    raise RuntimeError('RPC unavailable')
            list(cad.entities(Broken()))
        job = cad.start('test', fail)
        self.assertTrue(entered.wait(2))
        try:
            with self.assertRaises(HTTPException) as error:
                cad.start('test2', lambda: {})
            self.assertEqual(error.exception.status_code, 409)
        finally:
            release.set()
        for _ in range(100):
            state = cad.status(job['id'])
            if state['status'] != 'running':
                break
            time.sleep(.01)
        self.assertEqual(state['status'], 'failed')
        self.assertEqual(state['total'], 10)
        self.assertEqual(state['completed'], 0)
        self.assertFalse(cad._lock.locked())


if __name__ == '__main__':
    unittest.main()
