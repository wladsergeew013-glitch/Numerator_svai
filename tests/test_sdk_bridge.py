"""Exercise existing scan/import/export against SDK data without TeighaX objects."""
import copy
import json
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app import main as api, cad_operations as cad, sdk_bridge as sdk
from fastapi import HTTPException


class ComDocumentWithoutObjectApi:
    FullName = 'C:/sdk-test.dwg'
    Name = 'sdk-test.dwg'
    saves = 0

    @property
    def ModelSpace(self):
        raise AssertionError('TeighaX ModelSpace must not be accessed')

    @property
    def PickfirstSelectionSet(self):
        raise AssertionError('TeighaX selection must not be accessed')

    def HandleToObject(self, _):
        raise AssertionError('TeighaX object conversion must not be accessed')

    def Regen(self, _):
        pass

    def Save(self):
        self.saves += 1


class SdkBridgeTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(cad.sys, 'platform', 'test'))
        self.com = ComDocumentWithoutObjectApi()
        self.doc = sdk.SdkDocument(self.com)
        self.records = [
            {'handle': 'A', 'kind': 'model_studio', 'objectName': 'linCSParametricSolid',
             'name': 'Pile', 'position': [125, 220, 50], 'parameters': {'GPP_PILE_NUMBER': '17', 'MARK': 'Pile-1'}},
            {'handle': 'B', 'kind': 'block', 'objectName': 'AcDbBlockReference',
             'name': 'PileBlock', 'position': [300, 400, 0], 'attributes': {'NUMBER': '18'}},
        ]
        self.calls = []
        self.doc._channel.call = self.call
        self.enterContext(patch.object(api, '_connect_nanocad', return_value=(None, self.doc, self.doc.ModelSpace)))

    def call(self, operation, **values):
        self.calls.append((operation, values))
        result = {'protocol': 1, 'ok': True, 'document': self.com.FullName}
        if operation == 'scan':
            result['objects'] = copy.deepcopy(self.records if values['scope'] == 'all' else self.records[:1])
        else:
            item = next(item for item in self.records if item['handle'] == values['handle'])
            if operation in ('parameter', 'attribute'):
                item['parameters' if operation == 'parameter' else 'attributes'][values['name']] = values['value']
            result['object'] = copy.deepcopy(item)
        return result

    def test_scan_and_import_use_sdk_coordinates_parameters_and_handles(self):
        scanned = api.scan_modelstudio_objects('all')
        self.assertEqual(scanned['objects'][0]['name'], 'Pile')
        self.assertEqual(scanned['objects'][0]['coordinateCount'], 1)
        imported = api.import_modelstudio_objects(api.NanoCadModelStudioImportRequest(
            scope='all', scanId=scanned['scanId'], selectedObjectNames=['Pile'],
            numberParameter='GPP_PILE_NUMBER', baseX=100, baseY=200))
        point = imported['points'][0]
        self.assertEqual((point['x'], point['y'], point['number']), (25, 20, 17))
        self.assertEqual(point['meta']['rawInsertionPoint']['z'], 50)
        self.assertEqual(point['meta']['cadHandle'], 'A')
        self.assertEqual(len(self.calls), 1, 'Import reuses the SDK scan snapshot')
        self.assertEqual(self.com.saves, 0)

    def test_selection_uses_sdk_pickfirst_without_reading_full_drawing(self):
        scanned = api.scan_modelstudio_objects('selection')
        self.assertEqual(scanned['scope'], 'selection')
        self.assertEqual(self.calls, [('scan', {'scope': 'selection'})])

    def test_unsaved_scan_can_be_imported_but_not_reused_for_another_untitled_dwg(self):
        guid = '37ba4d19-6523-48a2-9b1c-07d9e281ade1'
        self.com.FullName = self.com.Name = 'Без имени0'
        self.com.GetVariable = lambda _: guid
        document = sdk.SdkDocument(self.com)
        document._channel.call = self.call
        with patch.object(api, '_connect_nanocad', return_value=(None, document, document.ModelSpace)):
            scanned = api.scan_modelstudio_objects('all')
            imported = api.import_modelstudio_objects(api.NanoCadModelStudioImportRequest(
                scope='all', scanId=scanned['scanId'], selectedObjectNames=['Pile'], numberParameter='GPP_PILE_NUMBER'))
        self.assertEqual(imported['points'][0]['meta']['cadDocument'], 'unsaved:' + guid)
        self.com.GetVariable = lambda _: '5bfb49e2-989f-45ec-a763-71ab0fd801ad'
        other = sdk.SdkDocument(self.com)
        with patch.object(api, '_connect_nanocad', return_value=(None, other, other.ModelSpace)):
            with self.assertRaises(HTTPException) as error:
                api.import_modelstudio_objects(api.NanoCadModelStudioImportRequest(scope='all', scanId=scanned['scanId']))
        self.assertEqual(error.exception.status_code, 409)

    def test_sdk_number_export_writes_existing_parameter_and_verifies_readback(self):
        point = api.NanoCadExportPoint(id='pile', x=125, y=220, number=91,
            meta={'cadHandle': 'A', 'cadDocument': self.com.FullName, 'objectName': 'Pile'})
        result = api.export_modelstudio_objects(api.NanoCadModelStudioExportRequest(
            scope='all', matchMode='handles', numberParameter='GPP_PILE_NUMBER', points=[point]))
        self.assertEqual(result['updated'], 1)
        self.assertEqual(self.records[0]['parameters']['GPP_PILE_NUMBER'], '91')
        self.assertTrue(any(op == 'parameter' for op, _ in self.calls))
        self.assertEqual(self.com.saves, 0)

    def test_blocks_scan_and_export_use_sdk_attributes(self):
        scanned = api.scan_nanocad_blocks('all')
        self.assertEqual(scanned['blocks'][0]['name'], 'PileBlock')
        result = api.export_nanocad_blocks(api.NanoCadBlockExportRequest(
            scope='all', blockName='PileBlock', numberAttribute='NUMBER',
            points=[api.NanoCadExportPoint(id='block', x=300, y=400, number=92)]))
        self.assertEqual(result['updated'], 1)
        self.assertEqual(self.records[1]['attributes']['NUMBER'], '92')

    def test_native_write_failure_is_not_retried_through_other_com_setters(self):
        entity = sdk.SdkEntity(self.doc._channel, copy.deepcopy(self.records[0]))
        with patch.object(self.doc._channel, 'call', side_effect=sdk.SdkBridgeError('SDK write failed')) as call:
            with self.assertRaises(HTTPException):
                api._set_modelstudio_parameter(entity, 'GPP_PILE_NUMBER', '93')
        self.assertEqual(call.call_count, 1)


class SdkWireTests(unittest.TestCase):
    def wire(self, response_document='C:/sdk-test.dwg', ok=True, *, document='C:/sdk-test.dwg', guid=None, returned_guid=None):
        doc = SimpleNamespace(FullName=document, Name=document, GetVariable=lambda _: guid or '')
        captured = []

        def send(command):
            captured.append(command)
            match = re.search(r'\(command "PILESDK_RUN(?:_[0-9A-F]{12})?" "([^"]+)"\)', command)
            request = Path(match.group(1))
            fields = dict(line.split('=', 1) for line in request.read_text(encoding='ascii').splitlines())
            decoded = {key: bytes.fromhex(value).decode('utf-8') for key, value in fields.items()}
            self.assertEqual(decoded['document'], doc.FullName)
            self.assertEqual(decoded['protocol'], '1')
            payload = {'protocol': 1, 'ok': ok, 'module': decoded['module'], 'document': response_document,
                       'documentGuid': returned_guid or guid, 'objects': [], 'error': 'Native error'}
            Path(str(request) + '.response.json').write_text(json.dumps(payload), encoding='utf-8')
            Path(str(request) + '.completed').write_text('0:0\n', encoding='ascii')

        doc.SendCommand = send
        return sdk.SdkChannel(doc), captured

    def test_sdk_command_roundtrip_never_uses_collection_item(self):
        channel, commands = self.wire()
        with patch.object(sdk, 'plugin_path', return_value=Path('C:/SDK/PileNumbering.Sdk26.nrx')):
            result = channel.call('scan', scope='all')
        self.assertEqual(result['objects'], [])
        self.assertEqual(len(commands), 1)
        self.assertIn('arxload', commands[0])

    def test_changed_document_and_native_errors_are_rejected(self):
        for document, ok in (('C:/other.dwg', True), ('C:/sdk-test.dwg', False)):
            with self.subTest(document=document, ok=ok):
                channel, commands = self.wire(document, ok)
                with patch.object(sdk, 'plugin_path', return_value=Path('C:/SDK/PileNumbering.Sdk26.nrx')):
                    with self.assertRaises(sdk.SdkBridgeError):
                        channel.call('scan', scope='all')
                self.assertEqual(len(commands), 1)

    def test_untitled_dwg_uses_fingerprint_even_if_com_cannot_read_guid(self):
        guid = '37ba4d19-6523-48a2-9b1c-07d9e281ade1'
        channel, _ = self.wire('Без имени0', document='Без имени0', returned_guid=guid)
        with patch.object(sdk, 'plugin_path', return_value=Path('C:/SDK/PileNumbering.Sdk26.nrx')):
            channel.call('scan', scope='all')
        self.assertEqual(channel.document_key, 'unsaved:' + guid)

    def test_same_untitled_name_does_not_accept_a_different_drawing(self):
        guid = '37ba4d19-6523-48a2-9b1c-07d9e281ade1'
        other = '5bfb49e2-989f-45ec-a763-71ab0fd801ad'
        channel, _ = self.wire('Без имени0', document='Без имени0', guid=guid, returned_guid=other)
        with patch.object(sdk, 'plugin_path', return_value=Path('C:/SDK/PileNumbering.Sdk26.nrx')):
            with self.assertRaises(sdk.SdkBridgeError):
                channel.call('scan', scope='all')

    def test_each_bridge_build_uses_its_own_cad_command(self):
        channel, commands = self.wire()
        with patch.object(sdk, 'plugin_path', return_value=Path('C:/SDK/PileNumbering.Sdk26.abcdef123456.nrx')):
            channel.call('scan', scope='all')
        self.assertIn('PILESDK_RUN_ABCDEF123456', commands[0])

    def test_connector_26_does_not_even_read_com_model_space(self):
        app = SimpleNamespace(Version='26.0', ActiveDocument=ComDocumentWithoutObjectApi())
        with patch.object(api, '_nanocad_selected_version', return_value='26'):
            _, document, model = api._try_nanocad_application(app)
        self.assertIsInstance(document, sdk.SdkDocument)
        self.assertIsInstance(model, sdk.SdkCollection)

    def test_auto_mode_recognizes_26_from_version_or_versioned_progid(self):
        for version, hint in (('nanoCAD x64 26.0', None), ('', '26')):
            with self.subTest(version=version, hint=hint):
                app = SimpleNamespace(Version=version, ActiveDocument=ComDocumentWithoutObjectApi())
                with patch.object(api, '_nanocad_selected_version', return_value=None):
                    _, document, _ = api._try_nanocad_application(app, hint)
                self.assertIsInstance(document, sdk.SdkDocument)

    def test_cancelled_sdk_command_is_not_resubmitted(self):
        doc = SimpleNamespace(FullName='C:/sdk-test.dwg', SendCommand=Mock())
        with patch.object(sdk, 'plugin_path', return_value=Path('C:/SDK/PileNumbering.Sdk26.nrx')), \
                patch.object(cad, 'check_cancelled', side_effect=cad.CadCancelled('cancelled')):
            with self.assertRaises(cad.CadCancelled):
                sdk.SdkChannel(doc).call('parameter', handle='A', name='NUMBER', value='3')
        doc.SendCommand.assert_called_once()

    def test_plugin_updates_use_a_new_cache_path_without_replacing_loaded_build(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'cad_bridge' / 'PileNumbering.Sdk26.nrx'
            source.parent.mkdir()
            source.write_bytes(b'first native build')
            with patch.object(sdk.sys, '_MEIPASS', str(root), create=True), \
                    patch.dict(sdk.os.environ, {'LOCALAPPDATA': str(root / 'cache')}):
                first = sdk.plugin_path()
                source.write_bytes(b'updated native build')
                second = sdk.plugin_path()
            self.assertNotEqual(first, second)
            self.assertNotEqual(first.name, second.name)
            self.assertEqual(first.read_bytes(), b'first native build')
            self.assertEqual(second.read_bytes(), b'updated native build')


if __name__ == '__main__':
    unittest.main()
