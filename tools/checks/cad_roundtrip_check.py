"""Explicitly write ONLY tests/out/cad-transfer-test.dwg, save/reopen, and verify."""
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from app import main as api, cad_operations as cad

target = Path(__file__).resolve().parents[2] / 'tests/out/cad-transfer-test.dwg'
connect = api._connect_nanocad


def guarded_connect():
    app, doc, ms = connect()
    if Path(str(doc.FullName)).resolve() != target.resolve():
        raise RuntimeError('Открыт другой документ. Тест остановлен до записи.')
    return app, doc, ms


@cad.serialized
def save_and_reopen():
    app, doc, _ = guarded_connect()
    doc.Regen(1)
    doc.Save()
    doc.Close(False)
    reopened = app.Documents.Open(str(target))
    if Path(str(reopened.FullName)).resolve() != target.resolve():
        raise RuntimeError('После открытия активен другой чертёж.')
    return {'reopened': str(reopened.FullName)}


with patch.object(api, '_connect_nanocad', side_effect=guarded_connect):
    scan = api.scan_nanocad_blocks('all')
    blocks = [b for b in scan['blocks'] if b['count'] == 5 and b['numberAttributeCandidates']]
    if len(blocks) != 1:
        raise RuntimeError('Не найдена ожидаемая группа из 5 тестовых блоков.')
    block = blocks[0]
    tag = block['numberAttributeCandidates'][0]
    imported = api.import_nanocad_blocks(api.NanoCadBlockImportRequest(scope='all', blockName=block['name'], numberAttribute=tag))
    if len(imported['points']) != 5:
        raise RuntimeError('Неверное число импортированных свай.')
    points = [{**p, 'number': 901 + i} for i, p in enumerate(imported['points'])]
    result = api.export_nanocad_blocks(api.NanoCadBlockExportRequest(scope='all', blockName=block['name'], numberAttribute=tag, points=points, tolerance=.01))
    if result['updated'] != 5:
        raise RuntimeError(f'Записано не 5 номеров: {result}')
    reopened = save_and_reopen()
    after = api.import_nanocad_blocks(api.NanoCadBlockImportRequest(scope='all', blockName=block['name'], numberAttribute=tag))
    values = sorted(p['number'] for p in after['points'])
    if values != [901, 902, 903, 904, 905]:
        raise RuntimeError(f'После повторного открытия неверные номера: {values}')
    try:
        automatic = api.scan_nanocad_blocks('auto')
        selection_status = automatic['scope']
    except Exception as exc:
        selection_status = str(exc)
    report = {'document': str(target), 'imported': 5, 'export': result, 'savedAndReopened': reopened,
              'numbersAfterReopen': values, 'automaticScope': selection_status}
    (target.parent / 'roundtrip-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True))
