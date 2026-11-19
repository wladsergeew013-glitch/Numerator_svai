from __future__ import annotations

import csv
import io
import math
from itertools import chain, islice
from typing import Iterable
from uuid import uuid4

from app.project_limits import MAX_PROJECT_JSON_BYTES, MAX_PROJECT_POINTS
from app.schemas import CsvImportResponse, PilePoint, PileProject, SyncState


X_ALIASES = {"x", "х", "coordx", "coordinatex", "xcoord", "x_coordinate"}
Y_ALIASES = {"y", "у", "coordy", "coordinatey", "ycoord", "y_coordinate"}
N_ALIASES = {"number", "num", "n", "номер", "no", "sourceNumber", "source_number"}
ID_ALIASES = {"sourceid", "source_id", "id", "guid", "uuid"}
NUMBER_GROUPING_SPACES = str.maketrans('', '', ' \u00a0\u202f')


def _norm(value: str | None) -> str:
    return (value or "").strip().replace(" ", "").replace("-", "_").lower()


def _find_column(fieldnames: Iterable[str], aliases: set[str]) -> str | None:
    for name in fieldnames:
        if _norm(name) in {_norm(a) for a in aliases}:
            return name
    return None


def _read_csv_text(content: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1251", "utf-8"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def _parse_float(value: str | None, row_number: int, col_name: str) -> float:
    if value is None:
        raise ValueError(f"Row {row_number}: missing {col_name}")
    cleaned = value.strip().translate(NUMBER_GROUPING_SPACES).replace(",", ".")
    if cleaned == "":
        raise ValueError(f"Row {row_number}: empty {col_name}")
    try:
        result = float(cleaned)
    except ValueError as exc:
        raise ValueError(f'Row {row_number}: invalid {col_name}') from exc
    if not math.isfinite(result):
        raise ValueError(f'Row {row_number}: {col_name} must be finite')
    return result


CSV_DELIMITERS = (';', ',', '\t')


def _csv_records(text: str, delimiter: str):
    reader = csv.reader(io.StringIO(text, newline=''), delimiter=delimiter, strict=True)
    for row in reader:
        if any(cell.strip() for cell in row):
            yield reader.line_num, row


def _is_number(value: str) -> bool:
    try:
        _parse_float(value, 0, 'coordinate')
        return True
    except ValueError:
        return False


def _csv_delimiter(text: str) -> str:
    best_score = -1
    selected = None
    for delimiter in CSV_DELIMITERS:
        try:
            sample = [row for _, row in islice(_csv_records(text, delimiter), 12)]
        except csv.Error:
            continue
        if not sample or len(sample[0]) < 2:
            continue
        first = sample[0]
        x_col, y_col = _find_column(first, X_ALIASES), _find_column(first, Y_ALIASES)
        has_header = x_col is not None and y_col is not None
        x_index, y_index = (first.index(x_col), first.index(y_col)) if has_header else (0, 1)
        numeric = sum(len(row) > max(x_index, y_index) and _is_number(row[x_index]) and _is_number(row[y_index])
                      for row in sample[int(has_header):])
        consistent = sum(len(row) == len(first) for row in sample)
        score = (1000 if has_header else 0) + numeric * 20 + consistent
        if score > best_score:
            best_score, selected = score, delimiter
    if selected is None:
        raise ValueError('CSV: cannot determine columns or delimiter')
    return selected


def import_points_from_csv(content: bytes) -> CsvImportResponse:
    """Read X/Y and optional source number/ID, preserving quoted field values."""
    text = _read_csv_text(content)
    delimiter = _csv_delimiter(text)
    records = _csv_records(text, delimiter)
    first_record = next(records)
    first = first_record[1]
    x_col, y_col = _find_column(first, X_ALIASES), _find_column(first, Y_ALIASES)
    has_header = x_col is not None and y_col is not None
    if has_header:
        x_index, y_index = first.index(x_col), first.index(y_col)
        n_col, id_col = _find_column(first, N_ALIASES), _find_column(first, ID_ALIASES)
        n_index = first.index(n_col) if n_col is not None else None
        id_index = first.index(id_col) if id_col is not None else None
    else:
        records = chain((first_record,), records)
        x_index, y_index, n_index, id_index = 0, 1, 2, None

    points: list[PilePoint] = []
    for row_number, row in records:
        if has_header and len(row) > len(first):
            raise ValueError(f'Row {row_number}: too many columns')
        def cell(index):
            return row[index] if index is not None and index < len(row) else None
        x = _parse_float(cell(x_index), row_number, x_col or 'x')
        y = _parse_float(cell(y_index), row_number, y_col or 'y')
        source_number = (cell(n_index) or '').strip() or None
        source_id = (cell(id_index) or '').strip() or source_number
        if len(points) >= MAX_PROJECT_POINTS:
            raise ValueError(f'CSV exceeds the limit of {MAX_PROJECT_POINTS} points')
        points.append(PilePoint(id=f'p-{uuid4().hex[:12]}', sourceId=source_id, x=x, y=y,
                                sourceNumber=source_number, syncState=SyncState.added))
    if not points:
        raise ValueError('CSV contains no points')
    result = CsvImportResponse(points=points)
    if len(result.model_dump_json().encode('utf-8')) > MAX_PROJECT_JSON_BYTES:
        raise ValueError('Данные импорта превышают 64 МБ в JSON. Разделите CSV на несколько файлов.')
    return result


def export_project_json(project: PileProject) -> dict:
    # Project JSON stores domain data only. UI workspace settings live in config/user_config.json
    # or in a separately exported .pilenum-ui.json file.
    return project.model_dump(mode="json", exclude={"gridSettings", "viewSettings"})


def import_project_json(payload: dict) -> PileProject:
    return PileProject.model_validate(payload)
