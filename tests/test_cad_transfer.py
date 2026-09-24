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
        self.commands = []

    def HandleToObject(self, handle):
        return self.lookup[handle]

    def Regen(self, mode):
        self.regens += 1

    def Save(self):
        self.saves += 1

    def SendCommand(self, script):
        self.commands.append(script)


class WideParameters(Parameters):
    def __init__(self, number='42'):
        self.items = [SimpleNamespace(Name=f'EXTRA_{index}', Value=str(index)) for index in range(64)]
        if number is not None:
            self.items.append(SimpleNamespace(Name='GPP_PILE_NUMBER', Value=number))
        self.Count = len(self.items)
        self.reads = 0
        self.numeric_reads = 0
        self.named_reads = 0

    def Item(self, key):
        if isinstance(key, str):
            self.named_reads += 1
            return next(item for item in self.items if item.Name.casefold() == key.casefold())
        self.numeric_reads += 1
        return super(Parameters, self).Item(key)


def point(id, x, handle=None, document=Document.FullName):
    return {'id': id, 'x': x, 'y': 0, 'number': 7,
            'meta': {'cadHandle': handle, 'cadDocument': document, 'objectName': 'Pile'} if handle else {}}


class TransferTests(unittest.TestCase):
    def test_selected_block_scan_is_reused_by_import_and_export(self):
        attr = SimpleNamespace(TagString='НОМЕР_СВАИ', TextString='1', Update=lambda: None)
        block = SimpleNamespace(Handle='AB', ObjectName='AcDbBlockReference', EffectiveName='PileBlock',
                                InsertionPoint=(10, 20, 0), GetAttributes=lambda: [attr], Update=lambda: None)
        other = SimpleNamespace(Handle='AC', ObjectName='AcDbBlockReference', EffectiveName='Other',
                                InsertionPoint=(30, 40, 0), GetAttributes=lambda: [], Update=lambda: None)
        doc = Document([block, other], selected=[block])
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            scanned = api.scan_nanocad_blocks('selection')
            reads = doc.PickfirstSelectionSet.reads
            imported = api.import_nanocad_blocks(api.NanoCadBlockImportRequest(
                scope='selection', scanId=scanned['scanId'], blockName='PileBlock', numberAttribute='НОМЕР_СВАИ'))
            exported = api.export_nanocad_blocks(api.NanoCadBlockExportRequest(
                scope='selection', scanId=scanned['scanId'], blockName='PileBlock', numberAttribute='НОМЕР_СВАИ',
                points=[api.NanoCadExportPoint(id='p', x=10, y=20, number=27)]))
            with self.assertRaises(HTTPException):
                api.import_nanocad_blocks(api.NanoCadBlockImportRequest(
                    scope='selection', scanId=scanned['scanId'], blockName='PileBlock'))
        self.assertEqual(len(imported['points']), 1)
        self.assertEqual(imported['points'][0]['meta']['cadHandle'], 'AB')
        self.assertTrue(imported['reusedScan'])
        self.assertEqual(exported['updated'], 1)
        self.assertEqual(attr.TextString, '27')
        self.assertTrue(exported['reusedScan'])
        self.assertEqual(doc.PickfirstSelectionSet.reads, reads)
        self.assertEqual(doc.ModelSpace.reads, 0)

    def test_modelstudio_coordinate_export_uses_scanned_selection(self):
        item = entity('AB', 10)
        doc = Document([item], selected=[item])
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            scanned = api.scan_modelstudio_objects('selection')
            reads = doc.PickfirstSelectionSet.reads
            exported = api.export_modelstudio_objects(api.NanoCadModelStudioExportRequest(
                scope='selection', scanId=scanned['scanId'], matchMode='coordinates', numberParameter='NUMBER',
                points=[api.NanoCadExportPoint(id='p', x=10, y=0, number=27)]))
            with self.assertRaises(HTTPException):
                api.import_modelstudio_objects(api.NanoCadModelStudioImportRequest(
                    scope='selection', scanId=scanned['scanId']))
        self.assertEqual(exported['updated'], 1)
        self.assertTrue(exported['reusedScan'])
        self.assertEqual(item.Element.Parameters.Item('NUMBER').Value, '27')
        self.assertEqual(doc.PickfirstSelectionSet.reads, reads)
        self.assertEqual(doc.ModelSpace.reads, 0)

    def test_modelstudio_export_uses_each_points_parameter_then_type_mapping(self):
        first = entity('A', 0)
        second = entity('B', 10)
        third = entity('C', 20)
        for item in (second, third):
            item.Element.Name = 'OtherPile'
            item.Element.Parameters = Parameters()
            item.Element.Parameters.items.append(SimpleNamespace(Name='ALT_NUMBER', Value='old'))
            item.Element.Parameters.Count = len(item.Element.Parameters.items)
        doc = Document([first, second, third])
        records = [
            api.NanoCadExportPoint(id='first', x=0, y=0, number=11,
                                   meta={'cadHandle': 'A', 'cadDocument': doc.FullName,
                                         'objectName': 'Pile', 'numberParameter': 'NUMBER'}),
            api.NanoCadExportPoint(id='second', x=10, y=0, number=12,
                                   meta={'cadHandle': 'B', 'cadDocument': doc.FullName,
                                         'objectName': 'OtherPile', 'numberParameter': 'ALT_NUMBER'}),
            api.NanoCadExportPoint(id='third', x=20, y=0, number=13,
                                   meta={'cadHandle': 'C', 'cadDocument': doc.FullName,
                                         'objectName': 'OtherPile'}),
        ]
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            result = api.export_modelstudio_objects(api.NanoCadModelStudioExportRequest(
                matchMode='handles', selectedObjectParameters={'OtherPile': 'ALT_NUMBER'}, points=records))
        self.assertEqual(result['updated'], 3)
        self.assertEqual(first.Element.Parameters.Item('NUMBER').Value, '11')
        self.assertEqual(second.Element.Parameters.Item('ALT_NUMBER').Value, '12')
        self.assertEqual(third.Element.Parameters.Item('ALT_NUMBER').Value, '13')
        self.assertEqual(second.Element.Parameters.Item('NUMBER').Value, 'old')

    def test_point_actions_read_write_position_by_handle(self):
        item = entity('AB', 10)
        item.Element.Parameters.Item('NUMBER').Value = '42'
        doc = Document([item])
        request = api.NanoCadPointActionRequest(action='read', handle='AB', documentPath=doc.FullName,
                                                 objectName='Pile', parameterName='NUMBER')
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            read = api.act_on_nanocad_point(request)
            written = api.act_on_nanocad_point(request.model_copy(update={'action': 'write', 'value': '57'}))
            position = api.act_on_nanocad_point(request.model_copy(update={'action': 'position'}))
            with self.assertRaises(HTTPException):
                api.act_on_nanocad_point(request.model_copy(update={'documentPath': 'C:/other.dwg'}))
            with self.assertRaises(HTTPException):
                api.act_on_nanocad_point(request.model_copy(update={'parameterName': 'ABSENT', 'action': 'write', 'value': '1'}))
        self.assertEqual(read['number'], 42)
        self.assertEqual(written['rawNumber'], '57')
        self.assertEqual(position['position']['x'], 10)
        self.assertEqual(doc.ModelSpace.reads, 0)

    def test_selected_scan_import_reuses_coordinates_handles_and_number_values(self):
        objects = [entity(str(index), index * 10) for index in range(4)]
        for index, item in enumerate(objects):
            item.Element.Parameters = WideParameters(str(50 + index))
        doc = Document(objects, selected=objects[1:3])
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            scanned = api.scan_modelstudio_objects('selection')
            reads_after_scan = [item.Element.Parameters.reads for item in objects]
            selected_reads = doc.PickfirstSelectionSet.reads
            result = api.import_modelstudio_objects(api.NanoCadModelStudioImportRequest(
                scope='selection', scanId=scanned['scanId'],
                selectedObjectParameters={'Pile': 'GPP_PILE_NUMBER'}))
        self.assertEqual([point['x'] for point in result['points']], [10, 20])
        self.assertEqual([point['meta']['cadHandle'] for point in result['points']], ['1', '2'])
        self.assertEqual([point['number'] for point in result['points']], [51, 52])
        self.assertEqual([item.Element.Parameters.reads for item in objects], reads_after_scan)
        self.assertEqual(doc.PickfirstSelectionSet.reads, selected_reads)
        self.assertEqual(doc.ModelSpace.reads, 0)
        self.assertTrue(result['diagnostics']['reusedScan'])
        self.assertEqual(result['diagnostics']['directParameterReads'], 0)

    def test_scan_cache_reads_only_newly_chosen_parameter_by_handle(self):
        objects = [entity(str(index), index) for index in range(3)]
        for item in objects:
            item.Element.Parameters = WideParameters()
        doc = Document(objects, selected=objects)
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            scanned = api.scan_modelstudio_objects('selection')
            result = api.import_modelstudio_objects(api.NanoCadModelStudioImportRequest(
                scope='selection', scanId=scanned['scanId'], selectedObjectParameters={'Pile': 'EXTRA_5'}))
        self.assertEqual([point['number'] for point in result['points']], [5, 5, 5])
        self.assertEqual(result['diagnostics']['directParameterReads'], 2)
        self.assertEqual(doc.PickfirstSelectionSet.reads, 3)

    def test_scan_cache_rejects_changed_document_or_scope(self):
        obj = entity('A')
        doc = Document([obj], selected=[obj])
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            scanned = api.scan_modelstudio_objects('selection')
            with self.assertRaises(HTTPException):
                api.import_modelstudio_objects(api.NanoCadModelStudioImportRequest(
                    scope='all', scanId=scanned['scanId']))
            doc.FullName = 'C:/other.dwg'
            with self.assertRaises(HTTPException):
                api.import_modelstudio_objects(api.NanoCadModelStudioImportRequest(
                    scope='selection', scanId=scanned['scanId']))

    def test_scan_reads_full_schema_once_per_name_then_checks_number_directly(self):
        objects = [entity(str(index), index) for index in range(4)]
        for item in objects:
            item.Element.Parameters = WideParameters()
        doc = Document(objects)
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            result = api.scan_modelstudio_objects()
        group = result['objects'][0]
        self.assertEqual(group['count'], 4)
        self.assertEqual(group['coordinateCount'], 4)
        self.assertEqual(group['verifiedNumberParameter'], 'GPP_PILE_NUMBER')
        self.assertEqual(group['missingNumberParameter'], 0)
        self.assertEqual(group['parameters'][0]['count'], 4)
        self.assertLess(sum(item.Element.Parameters.numeric_reads for item in objects), 80)
        self.assertEqual(sum(item.Element.Parameters.named_reads for item in objects), 3)

    def test_schema_variant_is_reported_and_not_assumed_present(self):
        objects = [entity('A'), entity('B', 10), entity('C', 20)]
        for item, number in zip(objects, ('42', None, '43')):
            item.Element.Parameters = WideParameters(number)
        doc = Document(objects)
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            result = api.scan_modelstudio_objects()
        group = result['objects'][0]
        self.assertEqual(group['missingNumberParameter'], 1)
        self.assertEqual(group['count'], 3)
        self.assertEqual(next(param for param in group['parameters'] if param['name'] == 'GPP_PILE_NUMBER')['count'], 2)

    def test_import_reads_only_selected_parameter_after_first_instance(self):
        objects = [entity(str(index), index) for index in range(4)]
        for item in objects:
            item.Element.Parameters = WideParameters(str(40 + int(item.Handle)))
        doc = Document(objects)
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            result = api.import_modelstudio_objects(api.NanoCadModelStudioImportRequest(
                selectedObjectParameters={'Pile': 'GPP_PILE_NUMBER'}))
        self.assertEqual([item['number'] for item in result['points']], [40, 41, 42, 43])
        self.assertEqual(result['diagnostics']['fullParameterReads'], 1)
        self.assertEqual(result['diagnostics']['directParameterReads'], 3)
        self.assertLess(sum(item.Element.Parameters.numeric_reads for item in objects), 80)
        self.assertEqual(result['points'][1]['meta']['parameters'], {'GPP_PILE_NUMBER': '41'})

    def test_selected_parameter_missing_on_same_name_does_not_borrow_other_number(self):
        a, b = entity('A'), entity('B', 10)
        a.Element.Parameters = WideParameters('7')
        b.Element.Parameters = WideParameters(None)
        doc = Document([a, b])
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            result = api.import_modelstudio_objects(api.NanoCadModelStudioImportRequest(
                selectedObjectParameters={'Pile': 'GPP_PILE_NUMBER'}))
        self.assertEqual([item['number'] for item in result['points']], [7, None])
        self.assertEqual(result['diagnostics']['missingNumberParameter'], 1)

    def test_select_in_original_drawing_uses_lisp_handle_and_checks_document(self):
        item = entity('AB', 10)
        doc = Document([item])
        request = api.NanoCadSelectHandleRequest(handle='ab', documentPath=doc.FullName, objectName='Pile')
        with patch.object(api, '_connect_nanocad', return_value=(None, doc, doc.ModelSpace)):
            result = api.select_nanocad_object_by_handle(request)
            self.assertTrue(result['selected'])
            self.assertIn('(handent "AB")', doc.commands[0])
            self.assertIn('sssetfirst nil pn_ss', doc.commands[0])
            with self.assertRaises(HTTPException):
                api.select_nanocad_object_by_handle(request.model_copy(update={'documentPath': 'C:/other.dwg'}))
            with self.assertRaises(HTTPException):
                api.select_nanocad_object_by_handle(request.model_copy(update={'handle': 'AB)'}))
        self.assertEqual(len(doc.commands), 1)
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

    def test_export_refreshes_modelstudio_graphics_once_per_object(self):
        item = entity('A')
        calls = []
        item.UpdateGraphics = lambda: calls.append('UpdateGraphics')
        item.Update = lambda: calls.append('Update')
        item.Element.Regen = lambda: calls.append('Regen')
        self.assertTrue(api._set_modelstudio_parameter(item, 'NUMBER', '91'))
        self.assertEqual(calls, ['UpdateGraphics'])

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
