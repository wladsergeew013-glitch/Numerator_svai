"""nanoCAD 26 object access through an in-process NRX SDK module.

COM is used only to address the already open document and queue a CAD command.
Object enumeration, Model Studio parameters and positions never use TeighaX.
"""
from __future__ import annotations

import hashlib
import json
import ntpath
import os
import re
from pathlib import Path
import shutil
import sys
import tempfile
import time
from types import SimpleNamespace
from uuid import UUID

from app import cad_operations as cad


class SdkBridgeError(RuntimeError):
    pass


def _lisp_string(value: str) -> str:
    if any(char in value for char in ('\x00', '\r', '\n')):
        raise SdkBridgeError('Некорректный путь SDK-модуля.')
    return '"' + value.replace('\\', '/').replace('"', '\\"') + '"'


def _sdk_command(module: Path, command_name: str, request: Path, capture_selection: bool) -> str:
    # Capture PICKFIRST before arxload, (command), or acedGetString can clear it.
    # Local bindings release the pickset and do not overwrite the user's symbols.
    snapshot = ''
    if capture_selection:
        snapshot = (
            f'(setq pn_file (open {_lisp_string(str(request) + ".selection")} "w")) '
            '(if pn_file (progn '
            '(write-line "PILESDK_SELECTION_1" pn_file) '
            '(write-line (itoa (if pn_selection (sslength pn_selection) 0)) pn_file) '
            '(setq pn_index 0) '
            '(if pn_selection (repeat (sslength pn_selection) '
            '(write-line (cdr (assoc 5 (entget (ssname pn_selection pn_index)))) pn_file) '
            '(setq pn_index (1+ pn_index)))) '
            '(close pn_file))) '
        )
    return (
        '((lambda (/ pn_selection pn_restored pn_file pn_index pn_count) '
        '(setq pn_selection (ssget "_I")) '
        '(setq pn_count (if pn_selection (sslength pn_selection) 0)) '
        + snapshot +
        f'(arxload {_lisp_string(str(module))} nil) '
        f'(command "{command_name}" {_lisp_string(str(request))}) '
        '(sssetfirst nil pn_selection) '
        '(setq pn_restored (ssget "_I")) '
        '(sssetfirst nil pn_selection) '
        f'(setq pn_file (open {_lisp_string(str(request) + ".completed")} "w")) '
        '(if pn_file (progn '
        '(write-line (strcat (itoa pn_count) ":" (itoa (if pn_restored (sslength pn_restored) 0))) pn_file) '
        '(close pn_file))) '
        '(princ)))\r'
    )


def plugin_path() -> Path:
    root = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[2]))
    source = root / 'cad_bridge' / 'PileNumbering.Sdk26.nrx'
    if not source.is_file():
        source = root / 'cad_bridge' / 'bin' / 'nanoCAD26' / 'PileNumbering.Sdk26.nrx'
    if not source.is_file():
        raise SdkBridgeError('В сборке отсутствует SDK-модуль nanoCAD 26. Пересоберите его через tools/09_build_sdk_bridge.ps1.')
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    cache = Path(os.environ.get('LOCALAPPDATA') or tempfile.gettempdir()) / 'PileNumbering' / 'sdk' / digest
    cache.mkdir(parents=True, exist_ok=True)
    # Distinct module names allow CAD to keep earlier SDK builds loaded safely.
    target = cache / f'PileNumbering.Sdk26.{digest[:12]}.nrx'
    if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        temporary = cache / (target.name + '.tmp')
        shutil.copyfile(source, temporary)
        temporary.replace(target)
    return target


def document_key(value: str) -> str:
    return value.replace('\\', '/').casefold()


class SdkChannel:
    def __init__(self, document):
        self.document = document
        self.expected_document = str(getattr(document, 'FullName', '') or getattr(document, 'Name', '') or '')
        self.saved = ntpath.isabs(self.expected_document)
        self.guid = ''
        try:
            guid = UUID(str(document.GetVariable('FINGERPRINTGUID')).strip('{}'))
            self.guid = str(guid) if guid.int else ''
        except Exception:
            pass

    @property
    def document_key(self):
        if self.saved:
            return self.expected_document
        if not self.guid:
            self.call('identify')
        if not self.guid:
            raise SdkBridgeError('SDK не предоставил идентификатор несохранённого чертежа.')
        return f'unsaved:{self.guid}'

    def call(self, operation: str, **values) -> dict:
        if not self.expected_document:
            raise SdkBridgeError('Не удалось определить активный чертёж для SDK nanoCAD 26.')
        module = plugin_path()
        started = time.monotonic()
        # Expiry is checked inside CAD before every read and before any write.
        timeout = 120.0
        fields = {'protocol': '1', 'module': str(module), 'deadline': str(int((time.time() + timeout) * 1000)),
                  'document': self.expected_document, 'documentSaved': '1' if self.saved else '0',
                  'documentGuid': self.guid, 'operation': operation, **values}
        with tempfile.TemporaryDirectory(prefix='pilenum-sdk26-') as folder:
            request = Path(folder) / 'request.txt'
            response = Path(str(request) + '.response.json')
            completed = Path(str(request) + '.completed')
            request.write_text(''.join(f'{key}={str(value).encode("utf-8").hex()}\n' for key, value in fields.items()), encoding='ascii')
            suffix = module.stem.rsplit('.', 1)[-1]
            command_name = f'PILESDK_RUN_{suffix.upper()}' if re.fullmatch(r'[0-9a-fA-F]{12}', suffix) else 'PILESDK_RUN'
            capture_selection = operation == 'scan' and values.get('scope') == 'selection'
            command = _sdk_command(module, command_name, request, capture_selection)
            cad.emit('sdk_bridge_started', operation=operation, scope=values.get('scope'), document=self.expected_document, module=str(module))
            cad.progress('Чтение через SDK nanoCAD 26' if operation in ('scan', 'read', 'identify') else 'Запись через SDK nanoCAD 26')
            try:
                self.document.SendCommand(command)
                while True:
                    completion = None
                    if response.exists() and completed.exists():
                        completion = re.fullmatch(r'(\d+):(\d+)\r?\n', completed.read_text(encoding='ascii'))
                    if completion:
                        selected_before, selected_after = map(int, completion.groups())
                        break
                    cad.check_cancelled()
                    if time.monotonic() - started >= timeout:
                        raise SdkBridgeError('SDK-модуль nanoCAD 26 не завершил обмен. Завершите активную команду в CAD и проверьте загрузку модуля PileNumbering.Sdk26.nrx через APPLOAD. Операция автоматически не повторяется.')
                    time.sleep(0.05)
                payload = json.loads(response.read_text(encoding='utf-8'))
            except BaseException:
                Path(str(request) + '.cancel').write_text('cancelled', encoding='ascii')
                raise
        if payload.get('protocol') != 1:
            raise SdkBridgeError('Несовместимая версия SDK-модуля nanoCAD 26.')
        if not payload.get('ok'):
            raise SdkBridgeError('Ошибка SDK nanoCAD 26: ' + str(payload.get('error') or 'причина не указана'))
        if document_key(str(payload.get('document') or '')) != document_key(self.expected_document):
            raise SdkBridgeError('Активный чертёж изменился во время операции SDK. Повторите сканирование.')
        if payload.get('documentGuid'):
            returned_guid = str(UUID(str(payload['documentGuid']).strip('{}')))
            if self.guid and self.guid != returned_guid:
                raise SdkBridgeError('Активный чертёж изменился во время операции SDK. Повторите сканирование.')
            self.guid = returned_guid
        if not self.saved and not self.guid:
            raise SdkBridgeError('Не удалось проверить идентификатор несохранённого DWG.')
        if document_key(str(payload.get('module') or '')) != document_key(str(module)):
            raise SdkBridgeError('В CAD загружен другой SDK-модуль. Перезапустите nanoCAD перед повторным обменом.')
        if capture_selection:
            cad.emit('sdk_selection_snapshot', source=payload.get('selectionSource'),
                     capturedCount=payload.get('selectionSnapshotCount'), objects=len(payload.get('objects', [])),
                     selectedBeforeCommand=selected_before, selectedAfterCommand=selected_after,
                     selectionRestored=selected_before == selected_after)
        elif selected_before != selected_after:
            cad.emit('sdk_selection_restore_mismatch', operation=operation,
                     selectedBeforeCommand=selected_before, selectedAfterCommand=selected_after)
        cad.emit('sdk_bridge_completed', operation=operation, objects=len(payload.get('objects', [])),
                 elapsedSeconds=round(time.monotonic() - started, 3))
        return payload


class SdkParameter:
    def __init__(self, entity: SdkEntity, name: str):
        self.entity, self.Name = entity, name

    @property
    def Value(self):
        return self.entity.data['parameters'][self.Name]

    @Value.setter
    def Value(self, value):
        self.entity.write('parameter', self.Name, str(value))


class SdkParameters:
    def __init__(self, entity: SdkEntity):
        self.entity = entity

    @property
    def Count(self):
        return len(self.entity.data['parameters'])

    def Item(self, key):
        names = list(self.entity.data['parameters'])
        if isinstance(key, int):
            name = names[key]
        else:
            name = next((name for name in names if name.casefold() == str(key).casefold()), None)
            if name is None:
                raise KeyError(key)
        return SdkParameter(self.entity, name)

    def SetParameter(self, name, value, *_):
        parameter = self.Item(name)
        parameter.Value = value


class SdkAttribute:
    def __init__(self, entity: SdkEntity, name: str):
        self.entity, self.TagString = entity, name

    @property
    def TextString(self):
        return self.entity.data['attributes'][self.TagString]

    @TextString.setter
    def TextString(self, value):
        self.entity.write('attribute', self.TagString, str(value))

    def Update(self):
        pass  # The NRX command already updates the database and graphics.


class SdkEntity:
    def __init__(self, channel: SdkChannel, data: dict):
        self.channel, self.data = channel, data

    @property
    def Handle(self):
        return self.data['handle']

    @property
    def ObjectName(self):
        return 'AcDbBlockReference' if self.data['kind'] == 'block' else self.data['objectName']

    @property
    def Name(self):
        return self.data.get('name', self.ObjectName)

    EffectiveName = property(lambda self: self.Name)

    @property
    def UnitPosition(self):
        if self.data['kind'] != 'model_studio':
            raise AttributeError('UnitPosition')
        return self.data['position']

    @property
    def InsertionPoint(self):
        if self.data['kind'] != 'block':
            raise AttributeError('InsertionPoint')
        return self.data['position']

    @property
    def Element(self):
        if self.data['kind'] != 'model_studio':
            raise AttributeError('Element')
        return SimpleNamespace(Name=self.Name, Parameters=SdkParameters(self))

    def GetAttributes(self):
        return [SdkAttribute(self, name) for name in self.data.get('attributes', {})]

    def write(self, operation, name, value):
        updated = self.channel.call(operation, handle=self.Handle, name=name, value=value)['object']
        if updated.get('handle', '').upper() != self.Handle.upper():
            raise SdkBridgeError('SDK ответил данными другого объекта; запись не подтверждена.')
        self.data = updated

    def Update(self):
        pass  # Each write has already been committed and read back by the SDK.

    UpdateGraphics = Update


class SdkCollection:
    def __init__(self, channel: SdkChannel, scope: str):
        self.channel, self.scope, self._items = channel, scope, None

    def _load(self):
        if self._items is None:
            result = self.channel.call('scan', scope=self.scope)
            self._items = [SdkEntity(self.channel, item) for item in result['objects']]
        return self._items

    @property
    def Count(self):
        return len(self._load())

    def Item(self, index):
        return self._load()[index]


class SdkDocument:
    def __init__(self, document):
        self._document = document
        self._channel = SdkChannel(document)
        self.ModelSpace = SdkCollection(self._channel, 'all')
        self.PickfirstSelectionSet = SdkCollection(self._channel, 'selection')
        self.Utility = SdkUtility(self._channel)

    def __getattr__(self, name):
        return getattr(self._document, name)

    @property
    def FullName(self):
        return self._channel.document_key

    def HandleToObject(self, handle):
        return SdkEntity(self._channel, self._channel.call('read', handle=handle)['object'])


class SdkUtility:
    def __init__(self, channel):
        self.channel = channel

    def Prompt(self, _):
        pass  # The NRX selection command supplies the prompt inside CAD.

    def GetEntity(self):
        entity = SdkEntity(self.channel, self.channel.call('pick')['object'])
        return entity, entity.data.get('position')
