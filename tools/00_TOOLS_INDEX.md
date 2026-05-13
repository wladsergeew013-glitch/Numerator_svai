# Tools folder layout

Основные батники называются с числовым префиксом, чтобы порядок был виден в Проводнике:

- `01_run_dev.bat` — локальный запуск backend + frontend без Docker.
- `02_check_frontend_contract.bat` — быстрый статический контроль, что не потеряны ключевые UI-команды и якоря.
- `03_dump_project_code.bat` — собрать дампы кода в `tools/out`.
- `04_dump_project_tree.bat` — собрать дерево проекта в `tools/out/project_tree.txt`.
- `05_docker_build_run.bat` — собрать и запустить Docker compose. Требует запущенный Docker Desktop.
- `06_build_exe.bat` — собрать desktop EXE через PyInstaller + pywebview.
- `07_check_locked_state.bat` — полная контрактная проверка зафиксированного состояния.
- `08_create_desktop_shortcut.bat` — создать красивый ярлык на рабочем столе для `dist\PileNumbering.exe`.
- `90_cleanup_legacy_tools.bat` — один раз перенести старые неупорядоченные батники/мусорные файлы в `tools/legacy_*`.

Проверки лежат в `tools/checks`. Служебные логи и дампы — только в `tools/out`.

## EXE launcher

`tools/exe_launcher.py` — обязательный входной файл для `06_build_exe.bat`.

Он запускает FastAPI backend внутри процесса EXE, монтирует собранный `frontend/dist` как `frontend_dist`, открывает приложение в нативном WebView-окне и перенаправляет `projects`, `config`, `data/images` в папку рядом с `PileNumbering.exe`, чтобы сохранённые проекты и настройки не пропадали после перезапуска.

## Docker note

Docker-режим не нужен для обычной работы и не нужен для сборки EXE. Ошибка `Docker daemon is not running` означает только, что Docker Desktop закрыт или ещё не запустился. Для локальной работы используй `01_run_dev.bat`, для desktop-сборки — `06_build_exe.bat`.


## Desktop shortcut

`08_create_desktop_shortcut.bat` создаёт ярлык `Pile Numbering App` на рабочем столе. Если есть `tools/app_icon.ico`, ярлык использует его; иначе берёт иконку из EXE. Перед запуском нужно собрать EXE через `06_build_exe.bat`.

### v61 notes

`08_create_desktop_shortcut.bat` теперь создаёт главный ярлык прямо в `dist` рядом с `PileNumbering.exe` и дополнительно пытается создать ярлык на рабочем столе. Иконка копируется в `dist/PileNumbering.ico`.

Автосохранения настраиваются в UI: Настройки рабочего поля → Автосохр. Файлы пишутся через backend endpoint `/api/autosave/project` в выбранную папку или в `autosaves` рядом с приложением.
