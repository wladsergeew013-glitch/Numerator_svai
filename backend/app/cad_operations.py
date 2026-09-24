"""Serialized CAD jobs. COM objects never leave the operation's worker thread."""
from contextvars import ContextVar
from functools import wraps
import inspect
import json
import logging
import sys
import threading
import time
from uuid import uuid4

from fastapi import HTTPException

_active = ContextVar('cad_operation', default=None)
_lock = threading.Lock()
_jobs_lock = threading.Lock()
_jobs = {}
log_event = None
MAX_LOG_ENTRIES = 2000


class CadCancelled(Exception):
    pass


def check_cancelled():
    job = _active.get()
    if job is not None and job['_cancel'].is_set():
        raise CadCancelled('Операция остановлена пользователем. Уже записанные в DWG значения могли остаться в открытом чертеже.')


def record(context, details, level=logging.INFO):
    """Keep a bounded, operation-specific copy; the full log remains on disk."""
    job = _active.get()
    if job is None:
        return
    text = json.dumps(details, ensure_ascii=False, default=str)
    entry = {'timestamp': time.time(), 'elapsedSeconds': round(time.monotonic() - job['_started'], 3),
             'event': context, 'level': logging.getLevelName(level),
             'details': text[:8000] + (' … [запись сокращена]' if len(text) > 8000 else '')}
    with _jobs_lock:
        entries = job.setdefault('_logs', [])
        if len(entries) >= MAX_LOG_ENTRIES:
            del entries[1]  # Preserve the start and the most recent events, including the result.
            job['_droppedLogs'] = job.get('_droppedLogs', 0) + 1
        entries.append(entry)


def emit(context, **details):
    job = _active.get()
    record(context, details)
    if log_event:
        log_event(context, extra={'operationId': job['id'] if job else None, **details}, level=logging.INFO)


def progress(phase, completed=0, total=None, **counts):
    job = _active.get()
    if not job:
        return
    check_cancelled()
    with _jobs_lock:
        job.update(phase=phase, completed=completed, total=total, **counts)
    now = time.monotonic()
    if phase != job.get('_loggedPhase') or now - job.get('_loggedAt', 0) >= 2 or completed == total:
        emit('cad_progress', phase=phase, completed=completed, total=total, **counts)
        job.update(_loggedAt=now, _loggedPhase=phase)


def serialized(func):
    @wraps(func)
    def wrapped(*args, **kwargs):
        if _active.get() is not None:
            return func(*args, **kwargs)
        if not _lock.acquire(blocking=False):
            raise HTTPException(409, 'Выполняется другая операция nanoCAD. Дождитесь завершения.')
        job = {'id': uuid4().hex, 'kind': func.__name__}
        try:
            return _execute(job, func, args, kwargs)
        finally:
            _lock.release()
    # FastAPI must see concrete request models rather than postponed annotations
    # evaluated in this wrapper module's globals.
    wrapped.__signature__ = inspect.signature(func, eval_str=True)
    return wrapped


def _execute(job, func, args, kwargs):
    token = _active.set(job)
    com = None
    started = time.monotonic()
    job['_started'] = started
    job.setdefault('startedAt', time.time())
    job.setdefault('_cancel', threading.Event())
    try:
        if sys.platform == 'win32':
            import pythoncom
            com = pythoncom
            com.CoInitialize()
        emit('cad_started', kind=job['kind'])
        progress('Подключение к nanoCAD')
        result = func(*args, **kwargs)
        check_cancelled()
        emit('cad_completed', kind=job['kind'], elapsedSeconds=round(time.monotonic() - started, 2),
             result={k: v for k, v in result.items() if k not in ('points', 'objects', 'blocks')} if isinstance(result, dict) else {})
        return result
    except CadCancelled:
        emit('cad_cancelled', kind=job['kind'], elapsedSeconds=round(time.monotonic() - started, 2),
             completed=job.get('completed'), total=job.get('total'), updated=job.get('updated'))
        raise
    except Exception as exc:
        emit('cad_failed', kind=job['kind'], error=str(exc), elapsedSeconds=round(time.monotonic() - started, 2),
             completed=job.get('completed'), total=job.get('total'))
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(503, 'Связь с nanoCAD прервана. Проверьте открытый чертёж. '
                            'При экспорте часть значений могла быть записана; подробности в logs/backend.log.') from exc
    finally:
        with _jobs_lock:
            job.update(elapsedSeconds=round(time.monotonic() - started, 3), finishedAt=time.time())
        if com:
            com.CoUninitialize()
        _active.reset(token)


def start(kind, func, *args):
    if not _lock.acquire(blocking=False):
        raise HTTPException(409, 'Выполняется другая операция nanoCAD. Дождитесь завершения.')
    job = {'id': uuid4().hex, 'kind': kind, 'status': 'running', 'phase': 'Подключение к nanoCAD',
           'completed': 0, 'total': None, 'startedAt': time.time(), '_cancel': threading.Event()}
    with _jobs_lock:
        # Keep a bounded history; never evict a running job.
        for key in list(_jobs):
            if len(_jobs) < 30:
                break
            if _jobs[key]['status'] != 'running':
                del _jobs[key]
        _jobs[job['id']] = job

    def worker():
        try:
            result = _execute(job, func, args, {})
            with _jobs_lock:
                job.update(status='completed', phase='Готово', result=result)
        except CadCancelled as exc:
            with _jobs_lock:
                job.update(status='cancelled', phase='Остановлено пользователем', error=str(exc))
        except HTTPException as exc:
            with _jobs_lock:
                job.update(status='failed', error=exc.detail)
        except Exception as exc:
            with _jobs_lock:
                job.update(status='failed', error=str(exc))
        finally:
            _lock.release()

    try:
        threading.Thread(target=worker, daemon=True, name=f'cad-{job["id"][:8]}').start()
    except Exception:
        _lock.release()
        raise
    return {'id': job['id']}


def status(job_id):
    with _jobs_lock:
        if job_id not in _jobs:
            raise HTTPException(404, 'Операция не найдена. Возможно, backend был перезапущен.')
        job = _jobs[job_id]
        snapshot = {k: v for k, v in job.items() if not k.startswith('_')}
        if 'elapsedSeconds' not in snapshot:
            snapshot['elapsedSeconds'] = round(max(0, time.monotonic() - job.get('_started', time.monotonic())), 3)
        return snapshot


def cancel(job_id):
    requested = False
    kind = None
    with _jobs_lock:
        if job_id not in _jobs:
            raise HTTPException(404, 'Операция не найдена.')
        job = _jobs[job_id]
        if job['status'] == 'running':
            requested = True
            kind = job['kind']
            job['_cancel'].set()
            job.update(cancelRequested=True, phase='Остановка запрошена…')
            entries = job.setdefault('_logs', [])
            if len(entries) >= MAX_LOG_ENTRIES:
                del entries[1]
                job['_droppedLogs'] = job.get('_droppedLogs', 0) + 1
            entries.append({'timestamp': time.time(), 'elapsedSeconds': round(time.monotonic() - job.get('_started', time.monotonic()), 3),
                            'event': 'cad_cancel_requested', 'level': 'INFO', 'details': '{}'})
        result = {'id': job_id, 'status': job['status'], 'cancelRequested': job.get('cancelRequested', False)}
    if requested and log_event:
        log_event('cad_cancel_requested', extra={'operationId': job_id, 'kind': kind}, level=logging.INFO)
    return result


def logs(job_id):
    with _jobs_lock:
        if job_id not in _jobs:
            raise HTTPException(404, 'Журнал операции недоступен: сервер перезапущен или операция вытеснена из истории. Полный журнал находится в logs/backend.log.')
        job = _jobs[job_id]
        return {'id': job_id, 'kind': job['kind'], 'entries': list(job.get('_logs', [])),
                'droppedEntries': job.get('_droppedLogs', 0)}


def entities(model_space):
    """Catch collection access failures too, unlike try/except inside a for loop."""
    total = int(model_space.Count)
    progress('Чтение объектов чертежа', 0, total)
    for index in range(total):
        check_cancelled()
        try:
            entity = model_space.Item(index)
        except Exception as exc:
            emit('cad_collection_error', entityIndex=index, error=str(exc))
            raise
        yield entity
        progress('Чтение объектов чертежа', index + 1, total)
