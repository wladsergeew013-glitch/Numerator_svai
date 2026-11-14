"""Offline backup/restore and conflict-safe migration of PileNumbering data."""
import argparse
from pathlib import Path, PurePosixPath
import sys
import zipfile

PARTS = {'projects', 'config', 'autosaves', 'data', 'logs'}
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.project_files import project_file_lock


def source_files(root):
    root = root.resolve()
    for part in sorted(PARTS):
        folder = root / part
        if not folder.is_dir(): continue
        for path in sorted(folder.rglob('*')):
            if not path.is_file() or path.name.endswith(('.lock', '.tmp')): continue
            if not path.resolve().is_relative_to(root): raise ValueError('Data contains a link outside its root')
            yield path.relative_to(root).as_posix(), path.read_bytes()


def restore(files, destination):
    root = destination.resolve(); prepared = []
    for name, data in files:
        relative = PurePosixPath(name)
        if relative.is_absolute() or not relative.parts or relative.parts[0] not in PARTS or any(p in ('..', '.') or '\\' in p or ':' in p for p in relative.parts):
            raise ValueError('Unsafe archive entry: '+name)
        path = root.joinpath(*relative.parts)
        if not path.resolve().is_relative_to(root): raise ValueError('Destination link escapes its root')
        if path.exists() and path.read_bytes() != data: raise FileExistsError('Existing data differs: '+str(path))
        prepared.append((path, data))
    for path, data in prepared:
        path.parent.mkdir(parents=True, exist_ok=True)
        with project_file_lock(path):
            if path.exists():
                if path.read_bytes() != data: raise FileExistsError('Existing data changed: '+str(path))
                continue
            with path.open('xb') as stream: stream.write(data)
    return len(prepared)


def backup(root, archive):
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as output:
        count = 0
        for name, data in source_files(root): output.writestr(name, data); count += 1
    return count


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=['backup','restore','migrate'])
    parser.add_argument('source',type=Path);parser.add_argument('destination',type=Path)
    args=parser.parse_args()
    if args.operation=='backup': count=backup(args.source,args.destination)
    elif args.operation=='migrate':
        if args.source.resolve()==args.destination.resolve(): raise ValueError('Source and destination must differ')
        count=restore(list(source_files(args.source)),args.destination)
    else:
        with zipfile.ZipFile(args.source) as archive:
            if sum(info.file_size for info in archive.infolist()) > 4*1024**3: raise ValueError('Archive exceeds 4 GiB')
            count=restore([(info.filename,archive.read(info)) for info in archive.infolist() if not info.is_dir()],args.destination)
    print(f'{args.operation}: {count} files; existing different files are never overwritten')


if __name__=='__main__': main()
