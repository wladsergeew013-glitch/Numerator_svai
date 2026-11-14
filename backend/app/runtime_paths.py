"""Persistent runtime locations, shared by source, container and frozen launchers."""
from dataclasses import dataclass
from pathlib import Path
import os
import sys


@dataclass(frozen=True)
class RuntimePaths:
    root: Path

    @classmethod
    def default(cls):
        root = os.environ.get('PILE_NUMBERING_DATA_DIR')
        return cls(Path(root).resolve() if root else (Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parents[2]))

    def globals(self):
        root = self.root
        return dict(ROOT_DIR=root, PROJECTS_DIR=root/'projects', CONFIG_DIR=root/'config',
                    AUTOSAVES_DIR=root/'autosaves', DATA_DIR=root/'data', LOGS_DIR=root/'logs',
                    IMAGES_DIR=root/'data'/'images', USER_CONFIG_PATH=root/'config'/'user_config.json',
                    APP_ICON_PATH=root/'config'/'app_icon.ico')
