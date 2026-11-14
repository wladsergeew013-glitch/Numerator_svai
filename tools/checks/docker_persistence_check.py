"""PN-061: disposable real container recreate check. No existing containers/data."""
import json
from pathlib import Path
import subprocess
import time
from urllib.request import Request, urlopen
from uuid import uuid4

image = 'pilenumbering-review:20261114'
owner = 'pile-review-' + uuid4().hex[:12]
volume = owner + '-data'
containers = []


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, encoding='utf-8').strip()


def start():
    name = owner + '-' + str(len(containers))
    docker('run', '-d', '--name', name, '--label', 'pile-review-owner='+owner,
           '-e', 'PILE_NUMBERING_DATA_DIR=/data', '-p', '127.0.0.1::8000',
           '-e', 'PILE_NUMBERING_TRUST_CONTAINER_PEERS=1',
           '--mount', 'type=volume,source='+volume+',target=/data', image)
    containers.append(name)
    binding = json.loads(docker('inspect', name))[0]['NetworkSettings']['Ports']['8000/tcp'][0]
    assert binding['HostIp'] == '127.0.0.1'
    port = binding['HostPort']
    base = 'http://127.0.0.1:'+port
    until = time.monotonic()+60
    while True:
        try:
            if json.load(urlopen(base+'/health', timeout=2))['status']=='ok': break
        except Exception:
            if time.monotonic()>until: raise
            time.sleep(.25)
    token = json.load(urlopen(Request(base+'/api/session', data=b'', headers={'X-Pile-Client':'1'}, method='POST')))['token']
    def api(path, payload=None, method=None):
        data=json.dumps(payload).encode() if payload is not None else None
        return json.load(urlopen(Request(base+path, data=data, method=method,
            headers={'X-Pile-Token':token,'Content-Type':'application/json'}),timeout=10))
    return name, api


def remove(name):
    info = json.loads(docker('inspect', name))[0]
    if info['Config']['Labels'].get('pile-review-owner') != owner: raise RuntimeError('Container ownership mismatch')
    docker('rm','-f',name)


try:
    docker('volume','create','--label','pile-review-owner='+owner,volume)
    first, api=start()
    project={'schemaVersion':1,'project':{'id':owner,'name':'Docker persistent review'},'points':[{'id':'p1','x':1,'y':2}]}
    saved=api('/api/projects/local/save',project)
    api('/api/config/user',{'nanoCadVersion':'26','autosaveSettings':{'enabled':True,'intervalMinutes':9}},'PATCH')
    autosaved=api('/api/autosave/project',{'project':project})
    recent=api('/api/projects/recent')
    assert saved['saved'] and autosaved['saved'] and recent['projects']
    remove(first)
    second, api=start()
    opened=api('/api/projects/local/'+saved['fileName'])
    config=api('/api/config/user')
    recent=api('/api/projects/recent')
    assert opened['project']['id']==owner and opened['points'][0]['x']==1
    assert config['nanoCadVersion']=='26' and config['autosaveSettings']['intervalMinutes']==9
    assert recent['projects']
    count=int(docker('exec',second,'python','-c',"from pathlib import Path; print(len(list(Path('/data/autosaves').glob('*.json'))))"))
    assert count>=1
    print(json.dumps({'project':'persisted','config':'persisted','recent':'persisted','autosave':'persisted','containerRecreated':True,'loopbackOnly':True,'userDataTouched':False}))
finally:
    existing=set(docker('ps','-aq','--filter','label=pile-review-owner='+owner).splitlines())
    for name in containers:
        ids=docker('ps','-aq','--filter','name=^/'+name+'$').splitlines()
        if any(i in existing for i in ids): remove(name)
    info=json.loads(docker('volume','inspect',volume))[0]
    if info.get('Labels',{}).get('pile-review-owner')==owner: docker('volume','rm',volume)
