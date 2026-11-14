"""Review counterexamples. CAD fixtures simulate adapters, never a real DWG."""
import asyncio
import copy
import io
import json
import os
import re
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError
from app import main as api, cad_operations as cad, sdk_bridge as sdk
from app.http_boundary import LocalApiBoundary, SESSION_TOKEN
from app.io_project import import_points_from_csv
from app.numbering_rows import apply_numbering_rows, build_rows_order
from app.numbering_route import build_route_order, apply_numbering_route
from app.numbering_vector import apply_numbering_vector
from app.schemas import PilePoint, PileGroup, NumberingSettings, NumberingRowsRequest, UserConfig
from app.sync_import import sync_points_with_source
from app.runtime_paths import RuntimePaths
from test_cad_transfer import Document, entity, point


class ReviewBackendTests(unittest.TestCase):
    def setUp(self):
        self.folder = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(self.folder)
        for key, value in RuntimePaths(self.root).globals().items(): self.enterContext(patch.object(api, key, value))
        self.enterContext(patch.object(cad, '_stopping', threading.Event()))
        self.enterContext(patch.object(cad.sys, 'platform', 'test'))
        api._MODELSTUDIO_SCAN_CACHE.clear(); api._BLOCK_SCAN_CACHE.clear()
        self.client = TestClient(api.app, client=('127.0.0.1',50000), base_url='http://127.0.0.1:8000', headers={'X-Pile-Token': SESSION_TOKEN})
        self.addCleanup(self.close_logger)

    @staticmethod
    def close_logger():
        if api._BACKEND_LOGGER is not None:
            for handler in list(api._BACKEND_LOGGER.handlers):
                api._BACKEND_LOGGER.removeHandler(handler); handler.close()
        api._BACKEND_LOGGER = api._BACKEND_LOGGER_PATH = None

    def test_PN019_022_numeric_contracts_and_error_responses(self):
        for value in [float('nan'), float('inf'), -float('inf')]:
            with self.subTest(value=value), self.assertRaises(ValidationError): PilePoint(x=value, y=0)
        for start in [1.5, 2**53, True]:
            with self.subTest(start=start), self.assertRaises(ValidationError): NumberingSettings(startNumber=start)
        self.assertEqual(NumberingSettings(startNumber=-5).startNumber, -5)
        with self.assertRaises(ValidationError): PilePoint(x=0,y=0,meta={'rawInsertionPoint':{'z':float('nan')}})
        for number in ['NaN','Infinity','P-1',1.5,2**53]:
            with self.subTest(number=number), self.assertRaises(ValidationError): api.NanoCadExportPoint(x=0,y=0,number=number)
        self.assertEqual(api.NanoCadExportPoint(x=0,y=0,number='-13').number,-13)
        with self.assertRaises(ValidationError): api.NanoCadBlockExportRequest(blockName='Pile',numberAttribute='NUMBER',points=[],tolerance=0)
        for text in ['X,Y\nnan,1', 'X,Y\n1,Infinity']:
            response = self.client.post('/api/import/csv', files={'file': ('bad.csv', text)})
            self.assertEqual(response.status_code, 400, response.text)
        response = self.client.post('/api/numbering/rows', content='{"points":[{"x":NaN,"y":0}]}', headers={'Content-Type': 'application/json'})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIsNone(api._coerce_float_triplet([float('inf'), 0]))
        self.assertIsNone(api._safe_float('Infinity'))

    def test_PN023_024_027_csv_records(self):
        for text in ['', 'only-one-column', 'x\n1', 'X,Y\n"broken,1']:
            response = self.client.post('/api/import/csv', files={'file': ('bad.csv', text)})
            self.assertIn(response.status_code, (400, 422), response.text)
        result = import_points_from_csv(b'100;200;P-001\n110;220;P-002')
        self.assertEqual([p.sourceNumber for p in result.points], ['P-001', 'P-002'])
        result = import_points_from_csv(b'1e3;2e3;P-001\n110;220;P-002')
        self.assertEqual(result.points[0].x, 1000)
        result = import_points_from_csv(b'X,Y,Number\n1,2,"P\n001"\n3,4,"P""2"')
        self.assertEqual([p.sourceNumber for p in result.points], ['P\n001', 'P"2'])

    def test_PN044_partial_atomic_config_writers(self):
        api.save_user_config(UserConfig(autosaveSettings={'enabled': True, 'intervalMinutes': 9}, nanoCadVersion='26'))
        barrier = threading.Barrier(3)
        def save(payload): barrier.wait(); api.save_user_config(UserConfig.model_validate(payload))
        writers = [threading.Thread(target=save, args=(payload,)) for payload in [
            {'panels': {'A': {'width': 400}}}, {'panels': {'B': {'height': 300}}}]]
        for writer in writers: writer.start()
        barrier.wait()
        for writer in writers: writer.join(2); self.assertFalse(writer.is_alive())
        api.save_user_config(UserConfig(panels={'A': {'x': 12}}))
        result = api.get_user_config()
        self.assertEqual((result.nanoCadVersion, result.autosaveSettings.enabled, result.autosaveSettings.intervalMinutes), ('26', True, 9))
        self.assertEqual((result.panels['A'].width, result.panels['A'].x, result.panels['B'].height), (400, 12, 300))
        api.save_user_config(api.UserConfigPatch(commandIcons={'file.save':'one'}))
        api.save_user_config(api.UserConfigPatch(commandIcons={'file.open':'two'}))
        api.save_user_config(api.UserConfigPatch(commandIcons={'file.save':None}))
        self.assertEqual(api.get_user_config().commandIcons,{'file.open':'two'})

    def test_PN054_icons_roundtrip_validation_and_delete(self):
        content = io.BytesIO(); Image.new('RGBA', (16, 16), 'orange').save(content, 'PNG')
        response = self.client.post('/api/assets/icons', files={'file': ('custom.png', content.getvalue())})
        self.assertEqual(response.status_code, 200, response.text)
        icon = response.json()['icon']
        api.save_user_config(UserConfig(commandIcons={'file.save': icon['url']}))
        self.assertEqual(api.get_user_config().commandIcons['file.save'], icon['url'])
        self.assertEqual(self.client.get(icon['url']).status_code, 200)
        self.assertEqual(len(self.client.get('/api/assets/icons').json()['icons']), 1)
        for filename, content in [('bad.png', b'wrong'), ('bad.svg', b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')]:
            self.assertEqual(self.client.post('/api/assets/icons', files={'file': (filename, content)}).status_code, 400)
        self.assertEqual(self.client.delete(icon['url']).status_code, 200)
        self.assertEqual(self.client.get(icon['url']).status_code, 404)
        self.assertNotIn('file.save', api.get_user_config().commandIcons)

    def test_PN057_local_api_boundary_and_handshake(self):
        unauth = TestClient(api.app, client=('127.0.0.1',50000), base_url='http://127.0.0.1:8000')
        for url, method in [('/api/config/user', 'get'), ('/api/projects/local', 'get'), ('/api/system/select-folder', 'get'), ('/api/nanocad/operations', 'post')]:
            with self.subTest(url=url): self.assertEqual(getattr(unauth, method)(url).status_code, 401)
        for origin in ['https://attacker.invalid', 'null', 'http://localhost:9999', 'http://127.0.0.1.attacker.invalid:8000']:
            response = unauth.post('/api/session', headers={'Origin': origin, 'X-Pile-Client': '1'})
            self.assertEqual(response.status_code, 403); self.assertNotIn('access-control-allow-origin', response.headers)
        self.assertEqual(unauth.post('/api/session').status_code, 403)
        remote = TestClient(api.app, client=('8.8.8.8',55000), base_url='http://localhost:8000')
        self.assertEqual(remote.post('/api/session', headers={'X-Pile-Client':'1'}).status_code,403)
        self.assertEqual(remote.get('/api/config/user', headers={'X-Pile-Token':SESSION_TOKEN}).status_code,403)
        response = unauth.post('/api/session', headers={'Origin': 'http://localhost:5173', 'X-Pile-Client': '1'})
        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(len(response.json()['token']), 32)
        self.assertEqual(unauth.get('/api/config/user', headers={'X-Pile-Token': response.json()['token']}).status_code, 200)
        self.assertEqual(unauth.get('/api/system/select-folder', headers={'Sec-Fetch-Site': 'same-site'}).status_code, 401, 'Ambient cookie cannot invoke a privileged GET')
        self.assertEqual(unauth.get('/api/config/user', headers={'Origin': 'http://localhost:9999'}).status_code, 403)
        self.assertEqual(self.client.get('/health', headers={'Host': 'evil.invalid'}).status_code, 400)
        self.assertEqual(self.client.get('/api/config/user', headers={'X-Pile-Token': 'wrong-token'}).status_code, 401)

    def test_PN059_static_paths_ranges_and_head(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('review_launcher', Path(__file__).resolve().parents[1]/'tools'/'exe_launcher.py')
        launcher = importlib.util.module_from_spec(spec); spec.loader.exec_module(launcher)
        (self.root/'index.html').write_text('0123456789')
        app = FastAPI(); app.add_middleware(LocalApiBoundary); launcher._mount_frontend(app, self.root)
        client = TestClient(app, client=('127.0.0.1',50000), base_url='http://127.0.0.1:8000')
        self.assertEqual(client.head('/').status_code, 200)
        self.assertEqual(client.get('/', headers={'Range': 'bytes=1-3'}).content, b'123')
        self.assertEqual(client.get('/', headers={'Range': 'bytes='+','.join(['0-1']*30)}).status_code, 416)
        with patch('starlette.staticfiles.os.path.realpath') as resolver:
            self.assertEqual(client.get('/%5c%5cnever-contact.invalid/share').status_code, 400)
            resolver.assert_not_called()

    def test_PN060_preparser_stream_and_declared_limits(self):
        calls = []
        async def downstream(scope, receive, send): calls.append(True)
        middleware = LocalApiBoundary(downstream)
        async def exercise(chunks, length=None):
            messages = []; source = iter(chunks)
            async def receive():
                body, more = next(source); return {'type':'http.request','body':body,'more_body':more}
            async def send(message): messages.append(message)
            headers = [(b'host',b'127.0.0.1:8000'), (b'x-pile-token',SESSION_TOKEN.encode())]
            if length: headers.append((b'content-length', str(length).encode()))
            with patch('app.http_boundary.MAX_BODY', 32):
                await middleware({'type':'http','method':'POST','path':'/api/import/csv','scheme':'http','headers':headers,'client':('127.0.0.1',50000)}, receive, send)
            return messages[0]['status']
        self.assertEqual(asyncio.run(exercise([], 33)), 413)
        self.assertEqual(asyncio.run(exercise([(b'x'*20,True),(b'y'*20,False)])), 413)
        self.assertEqual(calls, [])
        self.assertEqual(self.client.post('/api/import/csv', content='a=1&'*1101, headers={'Content-Type':'application/x-www-form-urlencoded'}).status_code, 415)
        fields = [('f'+str(i), (None,'x')) for i in range(1001)]
        self.assertEqual(self.client.post('/api/import/csv', files=fields).status_code, 400)
        boundary='bounded-part'
        body=f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="'+('x'*5000)+f'"\r\n\r\nX,Y\n1,2\r\n--{boundary}--\r\n'
        self.assertEqual(self.client.post('/api/import/csv',content=body.encode(),headers={'Content-Type':f'multipart/form-data; boundary={boundary}'}).status_code,400)

    def test_PN061_063_064_runtime_paths_and_names(self):
        self.assertEqual(api.AUTOSAVES_DIR.parent, self.root)
        self.assertEqual(api.APP_ICON_PATH.parent, self.root/'config')
        for value in ['CON', 'aux.txt', 'NUL', 'COM1', 'LPT1', 'COM¹', 'x\x01y', 'x'*500]:
            name = api._safe_file_name(value)
            self.assertLessEqual(len(name), 173)
            self.assertNotIn(name.split('.')[0].upper(), {'CON','AUX','NUL','COM1','LPT1','COM¹'})
            self.assertFalse(any(ord(c)<32 for c in name))
        # Hosted Windows may spell the same temp root with its 8.3 alias.
        with patch.dict(os.environ, {'PILE_NUMBERING_DATA_DIR': self.folder}): self.assertEqual(RuntimePaths.default().root, self.root.resolve())

    def test_PN063_launcher_patches_every_persistent_path(self):
        import importlib.util
        from types import SimpleNamespace
        script=Path(__file__).resolve().parents[1]/'tools'/'exe_launcher.py'
        spec=importlib.util.spec_from_file_location('review_paths_launcher',script)
        launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)
        target=SimpleNamespace()
        with patch.object(launcher,'APP_DIR',self.root),patch.object(launcher,'LOG_DIR',self.root/'logs'):
            launcher._patch_backend_runtime_paths(target)
        for field,path in RuntimePaths(self.root).globals().items(): self.assertEqual(getattr(target,field),path)
        for folder in ['projects','config','autosaves','logs','data/images']: self.assertTrue((self.root/folder).is_dir())

    def test_PN061_backup_restore_and_migration_conflicts(self):
        import importlib.util
        script=Path(__file__).resolve().parents[1]/'tools'/'10_data_backup.py'
        spec=importlib.util.spec_from_file_location('review_backup',script)
        backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)
        source=self.root/'source'; (source/'projects').mkdir(parents=True)
        (source/'projects'/'field.json').write_text('{"id":"original"}')
        archive=self.root/'data.zip'; self.assertEqual(backup.backup(source,archive),1)
        destination=self.root/'restored'; self.assertEqual(backup.restore(list(backup.source_files(source)),destination),1)
        self.assertEqual((destination/'projects'/'field.json').read_text(),'{"id":"original"}')
        with self.assertRaises(FileExistsError): backup.restore([('projects/field.json',b'other'),('config/new.json',b'new')],destination)
        self.assertFalse((destination/'config'/'new.json').exists())
        with self.assertRaises(ValueError): backup.restore([('projects/../../escape',b'bad')],destination)

    def test_PN065_066_067_and_TD_counter_policy(self):
        first = PileGroup(id='g1', name='first', order=1)
        later = PileGroup(id='g2', name='later', order=2)
        points = [PilePoint(id='a',x=0,y=0,number=99,groupId='g1'), PilePoint(id='b',x=1,y=0,number=100,groupId='g1'), PilePoint(id='c',x=2,y=0,groupId='g2')]
        request = NumberingRowsRequest(points=points, groups=[first,later], groupId='g2')
        result = apply_numbering_rows(request)
        self.assertEqual([p.number for p in result], [99,100,3])
        later.locked = True; points[2].number=999
        self.assertEqual(apply_numbering_rows(request)[2].number, 999)
        route_points = [PilePoint(id=id,x=x,y=0) for id,x in [('a',0),('b',0),('c',1000)]]
        settings=NumberingSettings(startPointId='b',endPointId='a')
        route=build_rows_order(route_points, settings)
        self.assertEqual([route[0].id,route[-1].id], ['b','a'])
        self.assertEqual(len(set(p.id for p in build_route_order(route_points, NumberingSettings(endPointId='a')))),3)
        route_points[1].manualNumber=True; route_points[1].number=10; route_points[1].x=500
        settings=NumberingSettings(startPointId='a', endPointId='c', vectorPath=[{'x':0,'y':0},{'x':1000,'y':0}])
        for apply in [apply_numbering_route, apply_numbering_vector]: self.assertEqual([p.number for p in apply(route_points,settings)], [1,10,11])
        old=PilePoint(id='old',sourceId='src',x=0,y=0)
        new=[PilePoint(id=id,sourceId='src',x=0,y=0) for id in ['new1','new2']]
        result=sync_points_with_source([old],new)
        self.assertEqual(len({p.id for p in result}),len(result))

    def test_PN029_030_live_geometry_and_ambiguity_preflight(self):
        item=entity('A'); doc=Document([item]); self.enterContext(patch.object(api,'_connect_nanocad',return_value=(None,doc,doc.ModelSpace)))
        scan=api.scan_modelstudio_objects('all')
        item.UnitPosition=(100,0,0)
        with self.assertRaises(HTTPException):
            api.export_modelstudio_objects(api.NanoCadModelStudioExportRequest(scope='all',scanId=scan['scanId'],matchMode='coordinates',numberParameter='NUMBER',points=[point('p',0)]))
        self.assertEqual(item.Element.Parameters.Item('NUMBER').Value,'old')
        item.UnitPosition=(0,0,0); other=entity('B'); doc.ModelSpace.items.append(other); doc.ModelSpace.Count=2; doc.lookup['B']=other
        for objects in [[item,other],[other,item]]:
            doc.ModelSpace.items=objects
            with self.assertRaises(HTTPException):
                api.export_modelstudio_objects(api.NanoCadModelStudioExportRequest(scope='all',matchMode='coordinates',numberParameter='NUMBER',points=[point('p',0)]))
        self.assertEqual(other.Element.Parameters.Item('NUMBER').Value,'old')

    def test_PN032_035_037_039_readback_and_final_number(self):
        class Attribute:
            TagString='NUMBER'
            TextString=property(lambda self:'old', lambda self,value:None)
        block=Mock(); block.GetAttributes.return_value=[Attribute()]
        self.assertFalse(api._set_block_attribute(block,'NUMBER','7'))
        self.assertTrue(api._cad_values_equal(' 7.0 ', '7'))
        self.assertFalse(api._cad_values_equal('old', '7'))
        self.assertIsNone(api._export_number_text(api.NanoCadExportPoint(x=0,y=0,sourceNumber='P-1')))
        record={'handle':'A','kind':'model_studio','objectName':'TechnicalType','name':'Human name','position':[0,0,0],'parameters':{'NUMBER':'old'}}
        channel=Mock(); channel.call.return_value={'object':copy.deepcopy(record)}
        item=sdk.SdkEntity(channel,copy.deepcopy(record))
        self.assertFalse(api._set_modelstudio_parameter(item,'NUMBER','7'))
        channel.call.assert_called_once()
        self.assertEqual(api._modelstudio_api_type(item),'TechnicalType')

    def test_PN030_ambiguity_after_first_candidate_is_claimed(self):
        records=[{'name':'Pile','insertion':xyz} for xyz in [(0,0,0),(0,1,0),(0,2,0)]]
        points=[api.NanoCadExportPoint(id=id,x=x,y=0,number=i+1) for i,(id,x) in enumerate([('p1',0),('p2',2),('p3',-2)])]
        for order in [points,list(reversed(points))]:
            with self.assertRaises(HTTPException): api._coordinate_export_plan(records,order,0,0,10)

    def test_PN031_033_036_fatal_partial_counts_and_shutdown(self):
        a,b=entity('A'),entity('B',10); doc=Document([a,b])
        self.enterContext(patch.object(api,'_connect_nanocad',return_value=(None,doc,doc.ModelSpace)))
        scan=api.scan_modelstudio_objects('all')
        def writer(item,name,value):
            if item.Handle=='B': raise sdk.SdkBridgeError('fatal transport')
            return True
        request=api.NanoCadModelStudioExportRequest(scope='all',scanId=scan['scanId'],matchMode='coordinates',numberParameter='NUMBER',points=[point('a',0),point('b',10)])
        with patch.object(api,'_set_modelstudio_parameter',side_effect=writer) as write:
            job=cad.start('modelstudio/export',api.export_modelstudio_objects,request)
            # Wait for the actual worker completion, including lock release.
            # A short wall-clock poll can leave a live job using expired mocks.
            self.assertTrue(cad._lock.acquire(timeout=30), 'CAD fixture worker did not finish')
            cad._lock.release()
        result=cad.status(job['id'])
        self.assertEqual(result['status'],'failed'); self.assertEqual(result['updated'],1); self.assertEqual(write.call_count,2)
        self.assertNotIn(scan['scanId'],api._MODELSTUDIO_SCAN_CACHE)
        self.assertTrue(cad.shutdown(self.root/'cad-shutdown.json',.2))
        self.assertEqual(json.loads((self.root/'cad-shutdown.json').read_text())['operations'][-1]['updated'],1)
        with self.assertRaises(HTTPException): cad.start('scan',lambda:None)

    def test_PN034_same_path_other_database_and_legacy_binding(self):
        doc=Document([entity('A')]); self.enterContext(patch.object(api,'_connect_nanocad',return_value=(None,doc,doc.ModelSpace)))
        scan=api.scan_modelstudio_objects('all'); doc.guid='22222222-2222-4222-8222-222222222222'
        with self.assertRaises(HTTPException): api._modelstudio_cached_scan(scan['scanId'],doc,'all')
        for guid in [None,Document.guid]:
            with self.assertRaises(HTTPException): api._verify_document_binding(doc,doc.FullName,guid)
        api._verify_document_binding(doc,doc.FullName,doc.guid)

    def test_PN038_cancel_marker_survives_until_ack(self):
        with sdk.request_directory(time.time()+2) as folder:
            (folder/'request.txt').write_text('request')
        self.assertTrue((folder/'request.txt.cancel').is_file())
        self.assertFalse(sdk.await_quiescence(.02))
        (folder/'request.txt.completed').write_text('0:0\n')
        self.assertTrue(sdk.await_quiescence(1))

    def test_PN038_synchronous_command_observes_cancel_marker(self):
        from types import SimpleNamespace
        module=self.root/'bridge.nrx';module.write_bytes(b'fixture')
        started=threading.Event(); observed=threading.Event()
        doc=SimpleNamespace(FullName='C:/model.dwg',GetVariable=lambda name:Document.guid)
        def send(command):
            match=re.search(r'\(command "PILESDK_RUN(?:_[0-9A-F]{12})?" "([^"]+)"\)',command)
            request=Path(match.group(1));started.set()
            until=time.monotonic()+30
            while not Path(str(request)+'.cancel').exists():
                if time.monotonic()>until: raise RuntimeError('Native model never saw cancellation')
                time.sleep(.01)
            observed.set()
            Path(str(request)+'.response.json').write_text(json.dumps({'protocol':1,'ok':False,'error':'cancelled'}))
            Path(str(request)+'.completed').write_text('0:0\n')
        doc.SendCommand=send
        with patch.object(sdk,'plugin_path',return_value=module):
            job=cad.start('fixture/sdk-cancel',lambda:sdk.SdkChannel(doc).call('scan',scope='all'))
            self.assertTrue(started.wait(30));cad.cancel(job['id'])
            self.assertTrue(cad._lock.acquire(timeout=30), 'Cancelled CAD fixture worker did not finish')
            cad._lock.release()
        self.assertTrue(observed.is_set())
        self.assertEqual(cad.status(job['id'])['status'],'cancelled')

    def test_PN051_point_write_rejects_unsafe_number_before_cad(self):
        for value in ['', '1.6', '1e3', '9007199254740993', '-9007199254740992']:
            request=api.NanoCadPointActionRequest(action='write',handle='A',documentPath='C:/fixture.dwg',value=value)
            with patch.object(api,'_connect_nanocad') as connect, self.assertRaises(HTTPException) as error:
                api.act_on_nanocad_point(request)
            self.assertEqual(error.exception.status_code,422); connect.assert_not_called()
        for value in ['9007199254740993','9007199254740992.0']:
            self.assertIsNone(api._parse_numeric_number(value))
        self.assertEqual(api._parse_numeric_number('-9007199254740991'),-9007199254740991)

    def test_PN064_short_lock_for_existing_long_component(self):
        from app.project_files import save_project_file
        path=self.root/('a'*245+'.json')
        if os.name=='nt': path=Path('\\\\?\\'+str(path))
        content='{"project":{"id":"owner"}}'
        path.write_text(content)
        save_project_file(path,content)
        self.assertEqual(path.read_text(),content)
        lock_files=list(self.root.glob('.pilenum-*.lock'))
        self.assertEqual(len(lock_files),1)
        self.assertLess(len(lock_files[0].name.encode('utf8')),100)

    def test_PN072_sdk_cache_two_processes_and_valid_loaded_module(self):
        import subprocess
        source=self.root/'bundle'/'cad_bridge'/'PileNumbering.Sdk26.nrx';source.parent.mkdir(parents=True)
        source.write_bytes(b'fixture NRX cache race\0'*200000)
        start=self.root/'go'
        script='''import sys,os,time,hashlib,json,shutil
from pathlib import Path
sys._MEIPASS=sys.argv[1]
from app.sdk_bridge import plugin_path
original=shutil.copyfile
def delayed(*args,**kwargs):
 result=original(*args,**kwargs); time.sleep(.2); return result
shutil.copyfile=delayed
Path(sys.argv[3]).write_text('ready')
while not Path(sys.argv[2]).exists(): time.sleep(.01)
module=plugin_path()
print(json.dumps({'path':str(module),'sha':hashlib.sha256(module.read_bytes()).hexdigest()}))
'''
        env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]/'backend'),'LOCALAPPDATA':str(self.root/'cache')}
        processes=[]
        try:
            for i in range(2):
                processes.append(subprocess.Popen([sys.executable,'-c',script,str(source.parents[1]),str(start),str(self.root/f'ready{i}')],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True))
            until=time.monotonic()+60
            while not all((self.root/f'ready{i}').exists() for i in range(2)):
                if time.monotonic()>until: self.fail('SDK cache child interpreters did not reach the barrier')
                time.sleep(.01)
            start.write_text('go')
            outputs=[]
            for process in processes:
                stdout,stderr=process.communicate(timeout=60)
                self.assertEqual(process.returncode,0,stderr);outputs.append(json.loads(stdout))
            self.assertEqual(outputs[0],outputs[1])
            import hashlib
            self.assertEqual(outputs[0]['sha'],hashlib.sha256(source.read_bytes()).hexdigest())
            with patch.object(sdk.sys,'_MEIPASS',str(source.parents[1]),create=True), patch.dict(os.environ,env), patch.object(Path,'replace',side_effect=AssertionError('Valid loaded cache must not be replaced')):
                self.assertEqual(str(sdk.plugin_path()),outputs[0]['path'])
        finally:
            for process in processes:
                if process.poll() is None: process.kill();process.wait(10)

    def test_PN036_point_write_invalidates_both_scans(self):
        item=entity('A'); doc=Document([item])
        self.enterContext(patch.object(api,'_connect_nanocad',return_value=(None,doc,doc.ModelSpace)))
        scan=api.scan_modelstudio_objects('all')
        api._BLOCK_SCAN_CACHE['fixture']={'record':'old'}
        result=api.act_on_nanocad_point(api.NanoCadPointActionRequest(action='write',handle='A',documentPath=doc.FullName,documentGuid=doc.guid,parameterName='NUMBER',value='123'))
        self.assertEqual(result['number'],123)
        self.assertFalse(api._MODELSTUDIO_SCAN_CACHE);self.assertFalse(api._BLOCK_SCAN_CACHE)
        with self.assertRaises(HTTPException): api._modelstudio_cached_scan(scan['scanId'],doc,'all')

    def test_PN039_sdk_technical_type_does_not_follow_display_name(self):
        item=sdk.SdkEntity(Mock(),{'kind':'model_studio','objectName':'TechnicalPile','name':'Pile model A','position':[0,0,0],'parameters':{}})
        self.assertEqual(api._modelstudio_api_type(item),'TechnicalPile')
        item.data['name']='Renamed product'
        self.assertEqual(item.DisplayName,'Renamed product')
        self.assertEqual(item.TechnicalType,'TechnicalPile')
        self.assertEqual(api._modelstudio_api_type(item),'TechnicalPile')


if __name__=='__main__': unittest.main()
