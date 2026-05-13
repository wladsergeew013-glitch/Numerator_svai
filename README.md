# Нумератор свайного поля

MVP-приложение для загрузки CSV с координатами свай, группировки точек и нумерации рядовым методом.

## Запуск через Docker

```bash
docker compose up --build
```

Открыть frontend:

```text
http://localhost:5173
```

Backend:

```text
http://localhost:8000/health
```

## Запуск без Docker

Backend:

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## Что уже есть

- импорт CSV с колонками `X,Y,Number`;
- внутренние `id` точек отдельно от номера сваи;
- рабочий формат `.pilenum.json`;
- CAD-поле на `react-konva`;
- zoom к курсору;
- pan средней/правой кнопкой мыши;
- сетка;
- диспетчер групп;
- выделение рамкой;
- назначение выделенных точек группе;
- нумерация группы методом рядов/столбцов;
- snapshot undo/redo на frontend.

## Важное

Backend намеренно не раздут:

```text
main.py
schemas.py
io_project.py
numbering_rows.py
numbering_route.py
numbering_vector.py
numbering_manual.py
clustering_auto.py
sync_import.py
```

Файлы `route/vector/manual/clustering/sync` пока заложены как понятные места для дальнейшей доработки, без лишних `services/routes/controllers/repositories`.


## Локальная папка проектов

Backend автоматически создаёт папку `projects/` в корне проекта.
Через кнопку `Проекты` на верхней панели можно:

- сохранить текущий `.pilenum.json` в `projects/`;
- увидеть список сохранённых проектов;
- быстро открыть проект из списка.

Обычные кнопки `Открыть` и `Скачать` также остаются: они работают через стандартный выбор файла браузера.

## Автоматическое сохранение настроек интерфейса

Настройки рабочего поля сохраняются автоматически в локальный конфиг браузера (`localStorage`): фон, сетка, оси, цвет текста нумерации, положение диспетчера групп, режим автоназначения и последнее имя проекта. При следующем запуске нового проекта эти настройки применяются автоматически.

Рабочий файл `.pilenum.json` всё равно хранит собственные настройки проекта, поэтому открытый проект переносит с собой фон, сетку и параметры отображения.
