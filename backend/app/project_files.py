"""Atomic project writes shared by the HTTP API and desktop file dialogs."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import tempfile
import time


class ProjectFileConflict(ValueError):
    pass


@contextmanager
def project_file_lock(path: Path, timeout: float = 30):
    # Keep the sidecar: unlinking it would let a new writer lock another inode
    # while an existing writer still holds the old one. OS locks die on exit.
    lock_path = path.resolve().with_name(f'.{path.name}.lock')
    with lock_path.open('a+b') as stream:
        if stream.tell() == 0:
            stream.write(b'\0')
            stream.flush()
        deadline = time.monotonic() + timeout
        while True:
            stream.seek(0)
            try:
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Файл занят сохранением в другом окне. Повторите сохранение.')
                time.sleep(0.01)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_UN)


def ensure_same_project(path: Path, content: str) -> None:
    if not path.exists():
        return
    try:
        existing_id = json.loads(path.read_text(encoding='utf-8-sig'))['project']['id']
        incoming_id = json.loads(content)['project']['id']
        if not isinstance(existing_id, str) or not existing_id or not isinstance(incoming_id, str):
            raise ValueError('Missing project identity')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ProjectFileConflict(f'Файл {path.name} уже существует. Не удалось проверить его владельца. Выберите другое имя файла.') from exc
    if existing_id != incoming_id:
        raise ProjectFileConflict(f'Файл {path.name} принадлежит другому проекту. Выберите другое имя файла.')


def atomic_write_project(path: Path, content: str) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def save_project_file(path: Path, content: str) -> None:
    with project_file_lock(path):
        ensure_same_project(path, content)
        atomic_write_project(path, content)
